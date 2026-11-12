import { z } from 'zod';

/**
 * General practitioner (терапевт) visit form, the one specialty form of slice A1.
 * Pure domain rules: which fields exist, what each may contain, which evidence categories are
 * allowed, and how a model proposal is validated before it can reach a draft.
 */
export const FORM_ID = 'gp-assistant-v1';

export const FIELD_KEYS = ['complaints', 'hpi', 'pastHistory', 'examination', 'diagnosis', 'plan', 'labOrders', 'followUp'] as const;
export type FieldKey = typeof FIELD_KEYS[number];
export const FieldKeySchema = z.enum(FIELD_KEYS);

/** Categories keep reported, observed, measured, historical and not-examined distinct. */
export const CATEGORIES = ['reported', 'history', 'observed', 'measured', 'not_examined', 'assessment', 'clinician_instruction'] as const;
export type Category = typeof CATEGORIES[number];

type FieldSpec = { kind: 'text' | 'diagnosis' | 'labs' | 'date'; categories: readonly Category[]; clinicianSpeech: boolean };
/** clinicianSpeech: the source must include words not attributed to the patient (doctor or unknown speaker). */
export const FIELDS: Record<FieldKey, FieldSpec> = {
  complaints: { kind: 'text', categories: ['reported'], clinicianSpeech: false },
  hpi: { kind: 'text', categories: ['reported'], clinicianSpeech: false },
  pastHistory: { kind: 'text', categories: ['history', 'reported'], clinicianSpeech: false },
  examination: { kind: 'text', categories: ['observed', 'measured', 'not_examined'], clinicianSpeech: true },
  diagnosis: { kind: 'diagnosis', categories: ['assessment'], clinicianSpeech: true },
  plan: { kind: 'text', categories: ['clinician_instruction'], clinicianSpeech: true },
  labOrders: { kind: 'labs', categories: ['clinician_instruction'], clinicianSpeech: true },
  followUp: { kind: 'date', categories: ['clinician_instruction'], clinicianSpeech: true }
};

/** Small synthetic lab list until the catalog (C3) lands. Codes are Clinora-internal placeholders. */
export const LABS = [
  { code: 'LAB-CBC', uzCyrl: 'Умумий қон таҳлили', uzLatn: 'Umumiy qon tahlili', ru: 'Общий анализ крови' },
  { code: 'LAB-UA', uzCyrl: 'Умумий сийдик таҳлили', uzLatn: 'Umumiy siydik tahlili', ru: 'Общий анализ мочи' },
  { code: 'LAB-GLU', uzCyrl: 'Қондаги глюкоза', uzLatn: 'Qondagi glyukoza', ru: 'Глюкоза крови' },
  { code: 'LAB-HBA1C', uzCyrl: 'Гликирланган гемоглобин (HbA1c)', uzLatn: 'Glikirlangan gemoglobin (HbA1c)', ru: 'Гликированный гемоглобин (HbA1c)' },
  { code: 'LAB-LIPID', uzCyrl: 'Липид спектри', uzLatn: 'Lipid spektri', ru: 'Липидный спектр' },
  { code: 'LAB-ALT-AST', uzCyrl: 'АЛТ, АСТ', uzLatn: 'ALT, AST', ru: 'АЛТ, АСТ' },
  { code: 'LAB-CREA', uzCyrl: 'Креатинин', uzLatn: 'Kreatinin', ru: 'Креатинин' },
  { code: 'LAB-TSH', uzCyrl: 'ТТГ (қалқонсимон без гормони)', uzLatn: 'TTG (qalqonsimon bez gormoni)', ru: 'ТТГ' },
  { code: 'LAB-CRP', uzCyrl: 'С-реактив оқсил', uzLatn: 'S-reaktiv oqsil', ru: 'С-реактивный белок' },
  { code: 'LAB-FERR', uzCyrl: 'Ферритин', uzLatn: 'Ferritin', ru: 'Ферритин' }
] as const;
export const LAB_CODES: ReadonlySet<string> = new Set(LABS.map(l => l.code));

export const Icd10 = z.string().regex(/^[A-TV-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/);
const Text = z.string().trim().min(1).max(4000);
const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(v + 'T00:00:00Z'); return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === v;
});
export const DiagnosisValue = z.object({ icd10: Icd10, text: Text }).strict();
export const LabsValue = z.array(z.string()).min(1).max(20).refine(v => new Set(v).size === v.length);

export type FieldValue = string | { icd10: string; text: string } | string[] | null;

/** Validate a value for a field as typed by the doctor or proposed by the model. null means empty. */
export function parseValue(key: FieldKey, value: unknown, category: Category): { ok: true; value: FieldValue } | { ok: false; reason: string } {
  const spec = FIELDS[key];
  if (!spec.categories.includes(category)) return { ok: false, reason: 'invalid_category' };
  if (category === 'not_examined') return value === null || value === '' ? { ok: true, value: null } : { ok: false, reason: 'invalid_value' };
  if (value === null) return { ok: true, value: null };
  const parsed = spec.kind === 'text' ? Text.safeParse(value) : spec.kind === 'diagnosis' ? DiagnosisValue.safeParse(value)
    : spec.kind === 'date' ? CalendarDate.safeParse(value) : LabsValue.safeParse(value);
  if (!parsed.success) return { ok: false, reason: 'invalid_value' };
  if (spec.kind === 'labs' && (parsed.data as string[]).some(code => !LAB_CODES.has(code))) return { ok: false, reason: 'unknown_lab' };
  return { ok: true, value: parsed.data as FieldValue };
}

export type SegmentRef = { id: string; text: string; speaker: 'doctor' | 'patient' | 'unknown' };
export type ValidProposal = { field: FieldKey; value: FieldValue; category: Category; evidence: string[] };
export type RejectedProposal = { field: string; value: unknown; category: unknown; evidence: string[]; reason: string };

const RawOutput = z.object({ proposals: z.array(z.unknown()).max(64) });
const RawProposal = z.object({ field: z.string().max(50), value: z.unknown(), category: z.string().max(40), evidence: z.array(z.string().max(64)).max(50) });

// Words that assert a normal finding. A normal finding may only be proposed when the cited words say so.
const NORMAL = /(норм|normal|без особенност|патологи(ясиз|и нет)|patologiyasiz|ўзгаришсиз|o.zgarishsiz|без изменени|соғлом|sog.lom|яхши|yaxshi)/iu;

/**
 * Server-side validation of an extractor result. Nothing the model returns reaches a draft unless it
 * names a form field, has a valid typed value, an allowed category, and cites only segments of this
 * encounter's transcripts. An empty or unknown value is never turned into "normal"; it stays empty.
 */
export function validateProposals(raw: unknown, segments: ReadonlyMap<string, SegmentRef>): { accepted: ValidProposal[]; rejected: RejectedProposal[]; malformed: boolean } {
  const output = RawOutput.safeParse(raw);
  if (!output.success) return { accepted: [], rejected: [], malformed: true };
  const accepted: ValidProposal[] = [], rejected: RejectedProposal[] = [], seen = new Set<string>();
  for (const item of output.data.proposals) {
    const p = RawProposal.safeParse(item);
    if (!p.success) { rejected.push({ field: '', value: null, category: null, evidence: [], reason: 'malformed_proposal' }); continue; }
    const { field, value, category } = p.data, evidence = [...new Set(p.data.evidence)];
    const reject = (reason: string) => rejected.push({ field, value, category, evidence, reason });
    const key = FieldKeySchema.safeParse(field);
    if (!key.success) { reject('unknown_field'); continue; }
    if (seen.has(field)) { reject('duplicate_field'); continue; }
    if (!(CATEGORIES as readonly string[]).includes(category)) { reject('invalid_category'); continue; }
    if (!evidence.length) { reject('missing_evidence'); continue; }
    // A citation of any segment outside this encounter's transcripts (another encounter, another patient,
    // or an invented id) rejects the whole proposal.
    if (evidence.some(id => !segments.has(id))) { reject('foreign_evidence'); continue; }
    const typed = parseValue(key.data, value, category as Category);
    if (!typed.ok) { reject(typed.reason); continue; }
    if (typed.value === null && category !== 'not_examined') { reject('empty_value'); continue; }
    const cited = evidence.map(id => segments.get(id)!);
    if (FIELDS[key.data].clinicianSpeech && cited.every(s => s.speaker === 'patient')) { reject('patient_only_evidence'); continue; }
    const words = typeof typed.value === 'string' ? typed.value : typed.value && !Array.isArray(typed.value) ? typed.value.text : '';
    if (NORMAL.test(words) && !cited.some(s => NORMAL.test(s.text))) { reject('unsupported_normal'); continue; }
    seen.add(field);
    accepted.push({ field: key.data, value: typed.value, category: category as Category, evidence });
  }
  return { accepted, rejected, malformed: false };
}

/** Human-readable value for documents and the PDF. Lab codes resolve to names in the chosen language. */
export function displayValue(key: FieldKey, value: FieldValue, lang: 'uzCyrl' | 'uzLatn' | 'ru' = 'uzCyrl'): string {
  if (value === null) return '';
  if (key === 'labOrders' && Array.isArray(value)) return value.map(code => LABS.find(l => l.code === code)?.[lang] ?? code).join('; ');
  if (typeof value === 'object' && !Array.isArray(value)) return `${value.icd10} — ${value.text}`;
  return String(value);
}
