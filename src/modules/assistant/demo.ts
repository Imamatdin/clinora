import { randomUUID } from 'node:crypto';
import { DocumentVersion, Encounter } from '../../contracts/index.js';
import type { Tx } from '../../server/database.js';
import { today } from './service.js';

/**
 * Synthetic patient for the A1 doctor-assistant demo: one earlier visit with a saved note (hypertension,
 * penicillin allergy) and an empty visit dated today for the live recording. Fictional data only.
 */
export async function seedAssistantDemo(tx: Tx, clinicId: string, doctorId: string) {
  const patientId = randomUUID();
  await tx.query('INSERT INTO patients(id,clinic_id,display_name,mrn,date_of_birth,provenance) VALUES($1,$2,$3,$4,$5,$6)',
    [patientId, clinicId, 'Каримова Дилноза — синтетик бемор (демо)', 'SYN-A1-001', '1968-03-14', { source: 'manual', externalReference: null }]);
  await tx.query('INSERT INTO patient_assignments(clinic_id,patient_id,user_id) VALUES($1,$2,$3)', [clinicId, patientId, doctorId]);
  const visit = async (date: string, note: Record<string, string> | null) => {
    const id = randomUUID(), documentId = randomUUID(), stamp = new Date().toISOString();
    const encounter = Encounter.parse({ id, clinicId, patientId, clinicianId: doctorId, location: { id: null, label: 'Синтетик терапевт хонаси 3' }, specialty: 'Терапевт',
      occurrence: { precision: 'date', date, timezone: 'Asia/Tashkent' }, status: 'draft', createdAt: stamp, updatedAt: stamp, revision: 1, provenance: { source: 'manual', externalReference: null } });
    await tx.query('INSERT INTO encounters(id,clinic_id,patient_id,clinician_id,data) VALUES($1,$2,$3,$4,$5)', [id, clinicId, patientId, doctorId, encounter]);
    await tx.query('INSERT INTO documents(id,clinic_id,patient_id,encounter_id) VALUES($1,$2,$3,$4)', [documentId, clinicId, patientId, id]);
    if (note) {
      const category = { reported: 'reported', observed: 'observed', assessment: 'assessment', plan: 'clinician_instruction' } as const;
      const version = DocumentVersion.parse({ id: randomUUID(), documentId, encounterId: id, clinicId, patientId, revision: 1, parentVersionId: null, kind: 'clinician_edit', templateId: 'general-note-v1',
        fields: Object.entries(note).map(([key, value]) => ({ key, value, category: category[key as keyof typeof category], status: 'proposed', origin: 'clinician', revision: 1, evidence: [], editedBy: doctorId, unresolvedConflict: null })),
        createdBy: doctorId, createdAt: stamp, amendsApprovalId: null, amendmentReason: null });
      await tx.query('INSERT INTO document_versions(id,document_id,clinic_id,patient_id,revision,created_by,data) VALUES($1,$2,$3,$4,1,$5,$6)', [version.id, documentId, clinicId, patientId, doctorId, version]);
      await tx.query('UPDATE documents SET current_revision=1,current_version_id=$1 WHERE id=$2', [version.id, documentId]);
    }
  };
  await visit('2026-08-02', { reported: 'Бош оғриғи, босим кўтарилиши. Пенициллинга аллергия.', observed: 'АБ 150/95, пульс 84.', assessment: 'Артериал гипертензия (I10).', plan: 'Эналаприл 10 мг кунига 1 марта. Босимни кундалик ўлчаш.' });
  await visit(today(), null);
  return patientId;
}
