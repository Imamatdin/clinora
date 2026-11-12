import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireRole, recordAudit, type ClinicContext } from '../../server/roles.js';
import { Key, once, fail, visitForCharge, addCharge } from '../pharmacy/actions.js';

export const SURGERY = ['ceo','administrator','doctor','inpatient'] as const;
export const SurgeryInput = z.object({ idempotencyKey: Key, visitId: z.uuid(), admissionId: z.uuid().optional(),
  surgeonId: z.uuid(), serviceId: z.uuid(), performedAt: z.iso.datetime({ offset: true }), documentId: z.uuid().optional() });
export async function recordSurgery(ctx: ClinicContext, raw: z.input<typeof SurgeryInput>) {
  ctx = await requireRole(ctx.tx,ctx.actorId,ctx.clinicId,SURGERY); const input = SurgeryInput.parse(raw);
  const visit = await visitForCharge(ctx,input.visitId);
  return once(ctx,'surgery.record',input,async () => {
    const at = new Date(input.performedAt);
    if (at > new Date()) return fail('INVALID_INPUT');
    await requireRole(ctx.tx,input.surgeonId,ctx.clinicId,['doctor']);
    if (!ctx.roles.some(r => ['ceo','administrator','inpatient'].includes(r)) && input.surgeonId !== ctx.actorId) return fail('FORBIDDEN');
    if (!(await ctx.tx.query("SELECT 1 FROM doctor_profiles WHERE clinic_id=$1 AND user_id=$2 AND is_active FOR SHARE", [ctx.clinicId,input.surgeonId])).rowCount) return fail('INVALID_INPUT');
    if (!(await ctx.tx.query("SELECT 1 FROM services WHERE clinic_id=$1 AND id=$2 AND kind='surgery' AND is_active FOR SHARE", [ctx.clinicId,input.serviceId])).rowCount) return fail('NOT_FOUND');
    if (input.admissionId && !(await ctx.tx.query("SELECT 1 FROM admissions WHERE clinic_id=$1 AND id=$2 AND visit_id=$3 AND status='admitted' FOR SHARE", [ctx.clinicId,input.admissionId,input.visitId])).rowCount) return fail('NOT_FOUND');
    if (input.documentId && !(await ctx.tx.query(`SELECT 1 FROM documents d JOIN encounters e ON e.clinic_id=d.clinic_id AND e.id=d.encounter_id
      WHERE d.clinic_id=$1 AND d.id=$2 AND e.visit_id=$3 AND e.patient_id=$4`, [ctx.clinicId,input.documentId,input.visitId,visit.patient_id])).rowCount) return fail('NOT_FOUND');
    const chargeLineId = await addCharge(ctx,input.visitId,input.serviceId,1,'surgery',at,input.surgeonId), id = randomUUID();
    await ctx.tx.query(`INSERT INTO surgeries(id,clinic_id,visit_id,admission_id,surgeon_user_id,service_id,performed_at,document_id,created_by,charge_line_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id,ctx.clinicId,input.visitId,input.admissionId ?? null,input.surgeonId,input.serviceId,at,input.documentId ?? null,ctx.actorId,chargeLineId]);
    await recordAudit(ctx.tx,ctx.actorId,ctx.clinicId,'surgery.recorded',id,{ chargeLineId }); return { id, chargeLineId };
  });
}
export async function surgeryOptions(ctx: ClinicContext) {
  ctx = await requireRole(ctx.tx,ctx.actorId,ctx.clinicId,SURGERY);
  const services = (await ctx.tx.query("SELECT id,name_uz_cyrl name FROM services WHERE clinic_id=$1 AND kind='surgery' AND is_active ORDER BY name_uz_cyrl", [ctx.clinicId])).rows;
  const surgeons = (await ctx.tx.query(`SELECT p.user_id id,a.display_name name FROM doctor_profiles p JOIN accounts a ON a.id=p.user_id
    JOIN memberships m ON m.clinic_id=p.clinic_id AND m.user_id=p.user_id WHERE p.clinic_id=$1 AND p.is_active AND m.status='active'
    AND EXISTS(SELECT 1 FROM membership_roles r WHERE r.clinic_id=p.clinic_id AND r.user_id=p.user_id AND r.role='doctor') ORDER BY a.display_name`, [ctx.clinicId])).rows;
  const visits = await visitOptions(ctx);
  const notes = (await ctx.tx.query(`SELECT d.id,e.visit_id,e.created_at FROM documents d
    JOIN encounters e ON e.clinic_id=d.clinic_id AND e.id=d.encounter_id
    WHERE d.clinic_id=$1 AND e.visit_id=ANY($2::uuid[]) ORDER BY e.created_at DESC`, [ctx.clinicId,visits.map(v=>v.id)])).rows;
  return { services, surgeons, visits, notes };
}
export async function visitOptions(ctx: ClinicContext) {
  ctx = await requireRole(ctx.tx,ctx.actorId,ctx.clinicId,[...SURGERY,'pharmacy']);
  const broad = ctx.roles.some(r => ['ceo','administrator','inpatient','pharmacy'].includes(r));
  return (await ctx.tx.query(`SELECT v.id,p.full_name name,p.patient_no,a.id admission_id FROM visits v
    JOIN patients p ON p.clinic_id=v.clinic_id AND p.id=v.patient_id JOIN business_days d ON d.clinic_id=v.clinic_id AND d.id=v.business_day_id
    LEFT JOIN admissions a ON a.clinic_id=v.clinic_id AND a.visit_id=v.id AND a.status='admitted'
    WHERE v.clinic_id=$1 AND v.status='open' AND d.status='open' AND ($2 OR EXISTS
      (SELECT 1 FROM patient_assignments x WHERE x.clinic_id=v.clinic_id AND x.patient_id=v.patient_id AND x.user_id=$3))
    ORDER BY v.created_at DESC LIMIT 200`, [ctx.clinicId,broad,ctx.actorId])).rows;
}
