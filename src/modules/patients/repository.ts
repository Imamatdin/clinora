import type { Encounter, Patient, ResourceScope, Approval, DocumentVersion, IntegrationJob, Principal, Membership } from '../../contracts/index.js';

export type RequestScope = { clinicId: string; actorId: string; operation: string; key: string };

/** Interface only. Increment 1 must implement PostgreSQL transactions; no in-memory clinical store. */
export interface ClinicalTransaction {
  resolveSession(tokenDigest: string, now: Date): Promise<Principal | null>;
  membership(userId: string, clinicId: string): Promise<Membership | null>;
  findPatient(scope: ResourceScope): Promise<Patient | null>;
  insertPatient(patient: Patient): Promise<void>;
  insertEncounter(encounter: Encounter): Promise<void>;
  timeline(scope: ResourceScope): Promise<readonly Encounter[]>;
  appendDocument(version: DocumentVersion, expectedParentRevision: number | null): Promise<void>;
  approve(approval: Approval, expectedCurrentVersionId: string): Promise<void>;
  enqueueIntegration(job: IntegrationJob): Promise<void>;
  /** Unique key scope = clinic + actor + operation + key. Different payload = conflict. */
  reserveRequest(scope: RequestScope & { payloadHash: string }): Promise<
    { kind: 'new' } | { kind: 'replay'; response: unknown }
  >;
  completeRequest(scope: RequestScope, response: unknown): Promise<void>;
}
export interface ClinicalRepository {
  // Session/membership rechecks and all writes must share this transaction boundary.
  transaction<T>(work: (transaction: ClinicalTransaction) => Promise<T>): Promise<T>;
}
