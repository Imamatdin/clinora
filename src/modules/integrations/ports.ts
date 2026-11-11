import type { IntegrationJob } from '../../contracts/index.js';
import { DomainError } from '../identity/access.js';

export interface IntegrationAdapter {
  readonly destination: string;
  sendApproved(job: IntegrationJob, approvedPayload: Readonly<Uint8Array>): Promise<
    { status: 'succeeded'; externalId: string } | { status: 'failed' | 'uncertain'; errorCode: string }
  >;
  reconcile(job: IntegrationJob): Promise<{ status: 'succeeded'; externalId: string } | { status: 'uncertain' }>;
}
export function requireSafeDispatch(job: IntegrationJob): void {
  if (job.status === 'unavailable') throw new DomainError('INTEGRATION_UNAVAILABLE');
  // Retry/reconciliation scheduling is deliberately not implemented here.
  if (job.status !== 'pending') throw new DomainError('INVALID_TRANSITION');
}
