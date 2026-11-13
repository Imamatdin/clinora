import { z } from 'zod';

export const DateInput = z.iso.date();
export const RuleInput = z.object({countAdmissionDay:z.boolean(), countDischargeDay:z.boolean(), minimumDays:z.number().int().min(1).max(365)}).strict();
const Key = { key:z.uuid() };
export const AdmitInput = z.object({...Key, visitId:z.uuid(), departmentId:z.uuid(), doctorId:z.uuid(), bedId:z.uuid(), expectedDischarge:DateInput.nullable()}).strict();
export const TransferInput = z.object({...Key, bedId:z.uuid()}).strict();
/** `override`: out-of-stock dispense approved by a CEO/administrator PIN on the same shared PC. */
export const OverrideInput = z.object({reason:z.string().trim().min(1).max(1000), approverId:z.uuid(), pin:z.string().regex(/^[0-9]{4,6}$/)}).strict();
export const ServiceInput = z.object({...Key, serviceId:z.uuid(), quantity:z.number().int().min(1).max(10000), override:OverrideInput.optional()}).strict();
export const CaretakerInput = z.object({...Key, fullName:z.string().trim().min(1).max(200), phone:z.string().regex(/^\+[1-9][0-9]{7,14}$/).nullable(), dailyServiceId:z.uuid().nullable()}).strict();
export const DailyInput = z.object({...Key, through:DateInput}).strict();
export const KeyInput = z.object(Key).strict();
export const ChangeRuleInput = z.object({...Key, rule:RuleInput}).strict();
/** After discharge, `lines` are frozen as of `linesAsOf`; paid and due are computed as of `paymentsAsOf`. */
export type InvoiceView = {clinic:string; patient:string; patientNo:number; admissionId:string; visitId:string; issuedAt:string; linesAsOf:string; paymentsAsOf:string;
  lines:{id:string; name:string; quantity:number; price:string; value:string; source:string}[];
  value:string; discount:string; payable:string; paid:string; due:string;
  /** Task 023: stay days that could not be priced at discharge (not charged; they stay flagged for the administrator). */
  needsAttention?:{kind:'bed'|'caretaker'; date:string; service:string}[]};
export type AttentionView = {id:string; admission_id:string; kind:'bed'|'caretaker'; date:string; service:string; patient:string};
export type WardView = {
  attention:AttentionView[];
  today:string; rule:z.infer<typeof RuleInput>; effectiveRule:z.infer<typeof RuleInput>;
  beds:{id:string; room:string; label:string; department_id:string|null; admission_id:string|null; patient:string|null}[];
  visits:{id:string; patient:string; patient_no:number}[];
  departments:{id:string; name:string}[]; doctors:{id:string; name:string}[];
  services:{id:string; name:string; kind:string; price:string|null}[];
  approvers:{id:string; name:string}[];
  admissions:{id:string; visit_id:string; patient:string; room:string|null; bed:string|null; status:string; admitted_at:string; expected_discharge:string|null; attending:string; attending_user_id:string}[];
};
