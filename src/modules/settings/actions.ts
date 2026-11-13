import { z } from 'zod';
import { recordAudit, type ClinicContext } from '../../server/roles.js';

/*
 * Task 022 clinic access settings (CEO only):
 * - assignmentDays: how long a doctor keeps a routed patient after the visit closes (default 30; admitted patients
 *   keep access for the whole stay; re-routing grants it again). Enforced in SQL by patient_access_active().
 * - telegramVoice: whether doctors may send visit audio as Telegram voice notes (default off; in-app recording stays on).
 */
export const AccessSettingsInput = z.object({ assignmentDays: z.number().int().min(0).max(3650), telegramVoice: z.boolean() }).strict();
export type AccessSettings = z.infer<typeof AccessSettingsInput>;

export async function accessSettings(ctx: ClinicContext): Promise<AccessSettings> {
  const r = (await ctx.tx.query('SELECT assignment_days, telegram_voice FROM clinic_settings WHERE clinic_id=$1', [ctx.clinicId])).rows[0];
  return { assignmentDays: r?.assignment_days ?? 30, telegramVoice: r?.telegram_voice ?? false };
}
export async function updateAccessSettings(ctx: ClinicContext, input: AccessSettings): Promise<AccessSettings> {
  const before = await accessSettings(ctx);
  await ctx.tx.query(`INSERT INTO clinic_settings(clinic_id,assignment_days,telegram_voice,updated_by) VALUES($1,$2,$3,$4)
    ON CONFLICT (clinic_id) DO UPDATE SET assignment_days=EXCLUDED.assignment_days, telegram_voice=EXCLUDED.telegram_voice, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [ctx.clinicId, input.assignmentDays, input.telegramVoice, ctx.actorId]);
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'settings.access_changed', ctx.clinicId, { before, after: input });
  return input;
}
