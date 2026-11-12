import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ERROR_STATUS, Id, type ErrorCode } from '../contracts/index.js';
import { DomainError } from '../modules/identity/access.js';
import { renderApprovedPdf, type ApprovedRow } from '../modules/assistant/pdf.js';
import { assistantProviders } from '../modules/assistant/runtime.js';
import * as svc from '../modules/assistant/service.js';
import { transaction } from './database.js';
import type { ApiConfig } from './notebook.js';
import { actorFor } from './notebook.js';
import { same } from './security.js';

/**
 * Transport-level assistant routes (task 003C) that the JSON route registry (server/routes/assistant.ts)
 * cannot express: raw audio chunk upload, the PDF response, approval (needs the verified session as the
 * policy Principal), routes that start a background job after their transaction commits, and the
 * assistant bot's Telegram webhook. Same session, origin and CSRF rules as every other route.
 */
const providersOf = (_config?: unknown) => assistantProviders();
const fail = (code: ErrorCode): never => { throw new DomainError(code); };

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) fail('INVALID_INPUT'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function json(req: IncomingMessage, limit = 100000): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') fail('INVALID_INPUT');
  try { return JSON.parse((await readBody(req, limit)).toString('utf8')); } catch (e) { if (e instanceof DomainError) throw e; return fail('INVALID_INPUT'); }
}
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const r = schema.safeParse(value); return r.success ? r.data : fail('INVALID_INPUT'); };

type Ctx = { tx: Parameters<typeof svc.draftView>[0]; actor: svc.Actor; clinic: string };
type Out = { status?: number; body?: unknown; pdf?: Buffer; kick?: string | undefined };
type Route = { method: 'GET' | 'POST'; pattern: RegExp; raw?: boolean; handle: (c: Ctx, p: string[], body: unknown, config: ApiConfig) => Promise<Out> };
const U = '([0-9a-fA-F-]{36})', ENC = `patients/${U}/encounters/${U}`;
const kickIf = (c: { id: string; status: string }) => ['queued', 'processing'].includes(c.status) ? c.id : undefined;

const ROUTES: Route[] = [
  { method: 'POST', pattern: new RegExp(`^${ENC}/simulated-capture$`), handle: async (c, [pt, e], b, config) => {
    // Demo fallback only: available when the simulated speech adapter is active, labelled in the interface.
    if (!providersOf(config).stt.simulated) fail('INTEGRATION_UNAVAILABLE');
    const { clientKey } = parse(z.object({ clientKey: svc.CaptureInput.shape.clientKey }).strict(), b);
    const cap = await svc.createCapture(c.tx, c.actor, c.clinic, pt!, e!, { clientKey, mimeType: 'audio/webm' }, 'simulated');
    return { status: 201, body: cap, kick: kickIf(cap) };
  } },
  { method: 'POST', pattern: new RegExp(`^${ENC}/approve$`), handle: async (c, [pt, e], b) => ({ body: await svc.approve(c.tx, c.actor, c.clinic, pt!, e!, parse(svc.ApproveInput, b)) }) },
  { method: 'GET', pattern: new RegExp(`^${ENC}/approved\\.pdf$`), handle: async (c, [pt, e]) => ({ pdf: await renderApprovedPdf(await svc.approvedDocument(c.tx, c.actor, c.clinic, pt!, e!) as ApprovedRow) }) },
  { method: 'POST', pattern: new RegExp(`^captures/${U}/chunks/(\\d{1,3})$`), raw: true, handle: async (c, [id, seq], b) => {
    const { data, checksum } = b as { data: Buffer; checksum: string };
    return { body: await svc.putChunk(c.tx, c.actor, c.clinic, id!, Number(seq), checksum, data) };
  } },
  { method: 'POST', pattern: new RegExp(`^captures/${U}/finish$`), handle: async (c, [id], b) => {
    const cap = await svc.finishCapture(c.tx, c.actor, c.clinic, id!, parse(z.object({ chunkCount: z.number().int().min(1).max(400) }).strict(), b).chunkCount);
    return { status: 202, body: cap, kick: kickIf(cap) };
  } },
  { method: 'GET', pattern: new RegExp(`^captures/${U}$`), handle: async (c, [id]) => { const cap = await svc.captureStatus(c.tx, c.actor, c.clinic, id!); return { body: cap, kick: kickIf(cap) }; } },
  { method: 'POST', pattern: new RegExp(`^captures/${U}/retry$`), handle: async (c, [id]) => { const cap = await svc.retryCapture(c.tx, c.actor, c.clinic, id!); return { status: 202, body: cap, kick: kickIf(cap) }; } },
  { method: 'POST', pattern: new RegExp(`^captures/${U}/attach$`), handle: async (c, [id], b) => { const cap = await svc.attachCapture(c.tx, c.actor, c.clinic, id!, parse(svc.AttachInput, b)); return { body: cap, kick: kickIf(cap) }; } }
];

const CLINIC_PATH = /^\/api\/clinics\/([0-9a-fA-F-]{36})\/assistant\/(.+)$/;
/** True only for the routes this handler owns; other assistant routes go through the clinic route registry. */
export function isAssistantPath(path: string, method = 'GET'): boolean {
  if (path === '/api/assistant/telegram/webhook') return method === 'POST';
  const m = CLINIC_PATH.exec(path);
  return !!m && ROUTES.some(r => r.method === method && r.pattern.test(m[2]!));
}

/** Handles assistant paths and writes the response. Returns false when the path is not an assistant route. */
export async function handleAssistant(req: IncomingMessage, res: ServerResponse, config: ApiConfig, requestId: string): Promise<boolean> {
  const path = new URL(req.url ?? '/', config.origin).pathname, method = req.method ?? 'GET';
  if (!isAssistantPath(path, method)) return false;
  const send = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const failWith = (code: ErrorCode) => send(ERROR_STATUS[code], { error: { code, message: code, requestId } });
  try {
    const providers = providersOf(config);
    if (path === '/api/assistant/telegram/webhook') {
      if (!providers.webhookSecret) { failWith('NOT_FOUND'); return true; }
      if (!same(String(req.headers['x-telegram-bot-api-secret-token'] ?? ''), providers.webhookSecret)) { failWith('UNAUTHENTICATED'); return true; }
      await svc.handleUpdate({ pool: config.pool, providers, origin: config.origin }, await json(req, 64 * 1024));
      send(200, { ok: true }); return true;
    }
    const [, clinic, rest] = CLINIC_PATH.exec(path)!;
    if (!Id.safeParse(clinic).success) fail('NOT_FOUND');
    const candidates = ROUTES.filter(r => r.pattern.test(rest!));
    const route = candidates.find(r => r.method === method);
    if (!route) fail('NOT_FOUND');
    const params = route!.pattern.exec(rest!)!.slice(1);
    if (params.some(p => p.length === 36 && !Id.safeParse(p).success)) fail('NOT_FOUND');
    const mutation = method !== 'GET';
    if (mutation && req.headers.origin !== config.origin) fail('FORBIDDEN');
    // Reject anonymous callers before reading any audio body.
    if (!/clinora_session=[a-f0-9]{64}/.test(req.headers.cookie ?? '')) fail('UNAUTHENTICATED');
    let body: unknown;
    if (route!.raw) {
      const type = req.headers['content-type']?.split(';')[0]?.trim() ?? '';
      const checksum = String(req.headers['x-chunk-sha256'] ?? '');
      if (!/^(audio\/[a-z0-9.+-]+|application\/octet-stream)$/.test(type) || !/^[a-f0-9]{64}$/.test(checksum)) fail('INVALID_INPUT');
      const data = await readBody(req, svc.LIMITS.chunkBytes);
      if (!data.length) fail('INVALID_INPUT');
      body = { data, checksum };
    } else if (mutation) body = await json(req);
    const out = await transaction(config.pool, async tx => {
      const actor = await actorFor(tx, req);
      if (mutation && !same(String(req.headers['x-csrf-token'] ?? ''), actor.csrf)) fail('FORBIDDEN');
      if (actor.mustChangePassword) fail('PASSWORD_CHANGE_REQUIRED');
      return route!.handle({ tx, actor: { userId: actor.userId, sessionId: actor.sessionId, expiresAt: actor.principal.expiresAt }, clinic: clinic! }, params, body, config);
    });
    if (out.kick) svc.kick({ pool: config.pool, providers, origin: config.origin }, out.kick);
    if (out.pdf) {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="clinora-visit-note.pdf"', 'Content-Length': out.pdf.length });
      res.end(out.pdf);
    } else send(out.status ?? 200, out.body);
  } catch (error) {
    if (error instanceof DomainError) failWith(error.code);
    else if (error && typeof error === 'object' && 'code' in error && error.code === '23505') failWith('IDEMPOTENCY_CONFLICT');
    else failWith('SERVICE_UNAVAILABLE'); // Never expose SQL, provider errors or clinical values.
  }
  return true;
}

/** Hourly audio purge, unref'd so it never keeps the process alive. */
export function startAssistantHousekeeping(config: ApiConfig) {
  const timer = setInterval(() => { void svc.purgeAudio(config.pool).catch(() => {}); }, 3600_000);
  timer.unref();
}
