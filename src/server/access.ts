import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import type pg from 'pg';
import { Id } from '../contracts/index.js';
import { DomainError } from '../modules/identity/access.js';
import { MANAGERS, ROLES } from '../modules/identity/roles.js';
import { createInvite, manageableMember } from '../modules/telegram/links.js';
import { credentialGate } from '../modules/staff/actions.js';
import { queueAccountNotice } from '../modules/identity/approval-pin.js';
import { verifyInitData, INIT_DATA_MAX_AGE_SECONDS } from '../modules/telegram/init-data.js';
import { handleUpdate, webhookSecretMatches } from '../modules/telegram/webhook.js';
import { receiveTelegramVoice } from '../modules/assistant/service.js';
import type { TelegramConfig } from '../modules/telegram/api.js';
import { activeDevice, checkPin, enrollDevice, EnrollInput, pickerStaff, PinInput, setOwnPin, UnlockInput, type ActiveDevice } from '../modules/devices/actions.js';
import { transaction, type Tx } from './database.js';
import { requireRole, recordAudit } from './roles.js';
import { digest, token } from './security.js';

/*
 * HTTP entry points for Telegram and shared-device access (task 004). Domain rules live in
 * src/modules/telegram and src/modules/devices; this file handles cookies, headers and sessions.
 */

export type SessionVia = 'password' | 'telegram' | 'device';
export type AccessConfig = { pool: pg.Pool; origin: string; secureCookies: boolean; telegram?: TelegramConfig | undefined };
type Result = { status?: number; body: unknown; cookie?: string | string[] };
type ReadBody = (req: IncomingMessage) => Promise<unknown>;

const fail = (code: ConstructorParameters<typeof DomainError>[0]): never => { throw new DomainError(code); };
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const r = schema.safeParse(value); return r.success ? r.data : fail('INVALID_INPUT'); };
export const SESSION_HOURS = 8;

/** Returns a cookie value only when exactly one cookie of that name is present. */
export function readCookie(req: IncomingMessage, name: string): string | null {
  const values = (req.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(name + '='));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : null;
}

/**
 * Session cookie attributes. Mini App sessions may run inside the web.telegram.org iframe, where a
 * SameSite=Strict cookie is never sent; they use SameSite=None; Secure; Partitioned (CHIPS) on HTTPS.
 * Mutations stay protected by the Origin check and the per-session CSRF token.
 */
export function sessionCookie(raw: string, via: SessionVia, secure: boolean): string {
  const site = via === 'telegram' ? (secure ? 'SameSite=None; Secure; Partitioned' : 'SameSite=Lax') : `SameSite=Strict${secure ? '; Secure' : ''}`;
  return `clinora_session=${raw}; HttpOnly; Path=/; ${site}; Max-Age=${SESSION_HOURS * 3600}`;
}
export const clearSessionCookie = (secure: boolean) => `clinora_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
const deviceCookie = (raw: string, secure: boolean) => `clinora_device=${raw}; HttpOnly; Path=/api; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`;

export async function createSession(tx: Tx | pg.Pool, userId: string, via: SessionVia, deviceId: string | null = null): Promise<string> {
  const raw = token();
  await tx.query(`INSERT INTO sessions(id,token_hash,user_id,expires_at,via,device_id) VALUES($1,$2,$3,now()+make_interval(hours => $4),$5,$6)`,
    [randomUUID(), digest(raw), userId, SESSION_HOURS, via, deviceId]);
  return raw;
}

export const deviceFromRequest = (tx: Tx | pg.Pool, req: IncomingMessage): Promise<ActiveDevice | null> =>
  activeDevice(tx as Tx, readCookie(req, 'clinora_device'));

/** Telegram webhook: runs before the Origin check (Telegram sends none) and needs no session. */
export async function webhookRoute(req: IncomingMessage, config: AccessConfig, path: string, method: string, readBody: ReadBody): Promise<Result | null> {
  if (path !== '/api/telegram/webhook') return null;
  if (!config.telegram) return fail('NOT_FOUND');
  if (method !== 'POST') return fail('NOT_FOUND');
  // Checked before the body is read: an unauthenticated caller causes no work at all.
  if (!webhookSecretMatches(req.headers['x-telegram-bot-api-secret-token'], config.telegram.webhookSecret)) return fail('UNAUTHENTICATED');
  let body: unknown;
  try { body = await readBody(req); } catch { return { body: { ok: true } }; }
  // One webhook for the clinic bot: sign-in links here, voice notes to the doctor assistant inbox (task 015).
  await handleUpdate(config.pool, config.telegram, `${config.origin}/`, body, receiveTelegramVoice);
  return { body: { ok: true } };
}

/** Sign-in routes that do not need an existing session. Origin was already checked for mutations. */
export async function publicAccessRoute(req: IncomingMessage, config: AccessConfig, path: string, method: string, readBody: ReadBody): Promise<Result | null> {
  if (path === '/api/telegram/session' && method === 'POST') {
    if (!config.telegram) return fail('INTEGRATION_UNAVAILABLE');
    const { initData } = parse(z.object({ initData: z.string().min(1).max(8192) }).strict(), await readBody(req));
    const verified = verifyInitData(initData, config.telegram.botToken, Math.floor(Date.now() / 1000));
    if (!verified.ok) return fail('UNAUTHENTICATED');
    const raw = await transaction(config.pool, async tx => {
      await tx.query('DELETE FROM telegram_init_data_uses WHERE expires_at < now()');
      const fresh = (await tx.query(`INSERT INTO telegram_init_data_uses(hash,expires_at) VALUES($1, to_timestamp($2) + make_interval(secs => $3))
        ON CONFLICT DO NOTHING RETURNING hash`, [verified.value.fingerprint, verified.value.authDate, INIT_DATA_MAX_AGE_SECONDS + 120])).rows[0];
      if (!fresh) return fail('UNAUTHENTICATED'); // Replayed init data.
      // Linked, account active, and at least one active membership holding a role. Otherwise: ask the administrator.
      const account = (await tx.query(`SELECT l.account_id FROM telegram_links l JOIN accounts a ON a.id=l.account_id AND a.status='active'
        WHERE l.telegram_user_id=$1 AND EXISTS(SELECT 1 FROM memberships m JOIN membership_roles r ON r.clinic_id=m.clinic_id AND r.user_id=m.user_id
          WHERE m.user_id=l.account_id AND m.status='active')`, [verified.value.telegramUserId])).rows[0];
      if (!account) return fail('FORBIDDEN');
      const session = await createSession(tx, account.account_id, 'telegram');
      await recordAudit(tx, account.account_id, null, 'session.telegram', account.account_id);
      return session;
    });
    return { body: { ok: true }, cookie: sessionCookie(raw, 'telegram', config.secureCookies) };
  }
  if (path === '/api/device' && method === 'GET') {
    return transaction(config.pool, async tx => {
      const device = await deviceFromRequest(tx, req);
      if (!device) return { body: { enrolled: false } };
      return { body: { enrolled: true, clinicName: device.clinicName, label: device.label, staff: await pickerStaff(tx, device) } };
    });
  }
  if (path === '/api/device/unlock' && method === 'POST') {
    const input = parse(UnlockInput, await readBody(req));
    // The outcome is committed before it is reported, so wrong attempts always count.
    const outcome = await transaction(config.pool, async tx => {
      const device = await deviceFromRequest(tx, req);
      if (!device) return { result: 'no_device' as const };
      const result = await checkPin(tx, device, input.userId, input.pin);
      if (result !== 'ok') return { result };
      const raw = await createSession(tx, input.userId, 'device', device.id);
      await recordAudit(tx, input.userId, device.clinicId, 'session.device', device.id);
      return { result, raw };
    });
    if (outcome.result === 'ok' && 'raw' in outcome) return { body: { ok: true }, cookie: sessionCookie(outcome.raw, 'device', config.secureCookies) };
    if (outcome.result === 'locked') return fail('RATE_LIMITED');
    if (outcome.result === 'no_device') return fail('FORBIDDEN');
    return fail('UNAUTHENTICATED');
  }
  return null;
}

/** Signed-in routes added by task 004 that need the session itself (not only a clinic context). */
export async function sessionAccessRoute(tx: Tx, req: IncomingMessage, config: AccessConfig, actor: { userId: string; sessionId: string; via: SessionVia },
  path: string, method: string, readBody: ReadBody): Promise<Result | null> {
  if (path === '/api/auth/pin' && method === 'POST') {
    // On a shared PC anyone at the keyboard could change it; set it from your own phone or signed-in computer.
    if (actor.via === 'device') return fail('FORBIDDEN');
    const input = parse(PinInput, await readBody(req));
    return { body: await setOwnPin(tx, actor.userId, input.pin) };
  }
  if (path === '/api/auth/notices/seen' && method === 'POST') {
    // Task 022: the person dismisses notices about their own account; nobody else's.
    const input = parse(z.object({ ids: z.array(Id).min(1).max(50) }).strict(), await readBody(req));
    await tx.query('UPDATE account_notices SET seen_at=now() WHERE account_id=$1 AND id=ANY($2::uuid[]) AND seen_at IS NULL', [actor.userId, input.ids]);
    return { body: { ok: true } };
  }
  // Telegram invites: for a staff member (manager) or for oneself (any member with a role, e.g. the owner).
  const invite = /^\/api\/clinics\/([^/]+)\/(?:staff\/([^/]+)|access\/me)\/telegram-invite$/.exec(path);
  if (invite && method === 'POST') {
    const [, clinicId, target] = invite;
    if (!Id.safeParse(clinicId).success || (target !== undefined && !Id.safeParse(target).success)) return fail('NOT_FOUND');
    const ctx = await requireRole(tx, actor.userId, clinicId!, target === undefined ? ROLES : MANAGERS);
    parse(z.object({}).strict(), await readBody(req));
    if (!config.telegram) return fail('INTEGRATION_UNAVAILABLE');
    if (target !== undefined) {
      await manageableMember(ctx, target);
      // Task 022: an administrator's invite for a doctor needs a CEO's confirmation; the person is told either way.
      const pending = await credentialGate(ctx, target, 'telegram');
      if (pending) return { status: 202, body: pending };
    }
    const created = await createInvite(ctx, target ?? actor.userId);
    if (target !== undefined) await queueAccountNotice(tx, { accountId: target, clinicId: clinicId!, kind: 'telegram_invite', actorId: actor.userId });
    return { status: 201, body: { link: `https://t.me/${config.telegram.botUsername}?start=${created.token}`, expiresAt: created.expiresAt } };
  }
  const enroll = /^\/api\/clinics\/([^/]+)\/devices\/enroll$/.exec(path);
  if (enroll && method === 'POST') {
    const clinicId = enroll[1]!; if (!Id.safeParse(clinicId).success) return fail('NOT_FOUND');
    const ctx = await requireRole(tx, actor.userId, clinicId, MANAGERS);
    const input = parse(EnrollInput, await readBody(req));
    const { device, rawToken } = await enrollDevice(ctx, input.label);
    // The enrolling manager is signed out here, so the shared PC starts at the lock screen.
    await tx.query('DELETE FROM sessions WHERE id=$1', [actor.sessionId]);
    return { status: 201, body: { device }, cookie: [deviceCookie(rawToken, config.secureCookies), clearSessionCookie(config.secureCookies)] };
  }
  return null;
}
