import { z } from 'zod';
import { Patient, Registration, Occurrence } from './index.js';
export const Password = z.string().min(12).max(128);
export const SignupInput = Registration.extend({ password: Password });
export const LoginInput = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128) }).strict();
export const PatientInput = Patient.pick({ displayName: true, dateOfBirth: true }).extend({ mrn: z.string().trim().min(1).max(80).nullable() }).strict();
export const EncounterInput = z.object({
  occurrence: Occurrence, location: z.string().trim().min(1).max(200), specialty: z.string().trim().min(1).max(100)
}).strict();
export const NoteInput = z.object({
  reported: z.string().max(16000), observed: z.string().max(16000), assessment: z.string().max(16000), plan: z.string().max(16000)
}).strict();
export const DraftInput = z.object({
  expectedRevision: z.number().int().min(0).max(1000000), note: NoteInput,
  templateId: z.string().trim().min(1).max(100)
}).strict();
export const InviteInput = z.object({ email: z.string().email().max(254) }).strict();
export const AcceptInviteInput = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type Note = z.infer<typeof NoteInput>;
export type PatientView = z.infer<typeof Patient> & { mrn: string | null };
export type VisitView = { encounter: import('./index.js').Encounter; clinicianName: string; documentId: string; revision: number; version: (import('./index.js').DocumentVersion & { templateId?: string }) | null };
