import { z } from 'zod';
import { FIELD_KEYS, FORM_ID, LABS } from '../../modules/assistant/form.js';
import { assistantProviders } from '../../modules/assistant/runtime.js';
import * as svc from '../../modules/assistant/service.js';
import { registerRoutes } from './registry.js';
import { parse, uuid } from './types.js';
import type { ClinicContext } from '../roles.js';

/**
 * Task 003C routes that are plain JSON in and out. Doctor role checked by requireRole before the body
 * is read; the service rechecks clinical access and patient scope. Routes that upload audio, return a
 * PDF, start background jobs or need the session as a policy Principal live in server/assistant.ts.
 */
const DOCTOR = ['doctor'] as const;
const ENC = `assistant/patients/${uuid}/encounters/${uuid}`;
const me = (ctx: ClinicContext): svc.Actor => ({ userId: ctx.actorId });
const Empty = z.object({}).strict();

registerRoutes('assistant', [
  { method: 'GET', pattern: /^assistant\/config$/, roles: DOCTOR, handle: async ctx => {
    await svc.doctorAccess(ctx.tx, me(ctx), ctx.clinicId, null);
    const p = assistantProviders();
    return { body: { formId: FORM_ID, labs: LABS, stt: { name: p.stt.name, simulated: p.stt.simulated },
      extractor: { name: p.extractor.name, simulated: p.extractor.simulated }, telegram: { available: !!p.telegram, linked: await svc.telegramLinked(ctx.tx, me(ctx)) } } };
  } },
  { method: 'GET', pattern: new RegExp(`^${ENC}$`), roles: DOCTOR,
    handle: async (ctx, [patient, encounter]) => ({ body: await svc.draftView(ctx.tx, me(ctx), ctx.clinicId, patient!, encounter!, assistantProviders()) }) },
  { method: 'POST', pattern: new RegExp(`^${ENC}/captures$`), roles: DOCTOR,
    handle: async (ctx, [patient, encounter], body) => ({ status: 201, body: await svc.createCapture(ctx.tx, me(ctx), ctx.clinicId, patient!, encounter!, parse(svc.CaptureInput, await body()), 'browser') }) },
  // One route per form field: the router only accepts UUID captures, so the field key is part of the pattern.
  ...FIELD_KEYS.map(key => ({ method: 'POST' as const, pattern: new RegExp(`^${ENC}/fields/${key}$`), roles: DOCTOR,
    handle: async (ctx: ClinicContext, [patient, encounter]: string[], body: () => Promise<unknown>) =>
      ({ body: await svc.fieldAction(ctx.tx, me(ctx), ctx.clinicId, patient!, encounter!, key, parse(svc.FieldActionInput, await body())) }) })),
  { method: 'GET', pattern: /^assistant\/captures\/pending$/, roles: DOCTOR, handle: async ctx => ({ body: await svc.pendingTelegram(ctx.tx, me(ctx), ctx.clinicId) }) },
  { method: 'POST', pattern: new RegExp(`^assistant/captures/${uuid}/discard$`), roles: DOCTOR,
    handle: async (ctx, [id], body) => { parse(Empty, await body()); return { body: await svc.discardCapture(ctx.tx, me(ctx), ctx.clinicId, id!) }; } }
]);
