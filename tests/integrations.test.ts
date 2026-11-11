import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IntegrationJob } from '../src/contracts/index.js';
import { requireSafeDispatch } from '../src/modules/integrations/ports.js';
import { approval, now, scope, version } from './fixtures.js';

test('uncertain writes cannot be blindly dispatched again and success needs acknowledgement', () => {
  const job = IntegrationJob.parse({ id: randomUUID(), ...scope, documentId: version.documentId, versionId: version.id,
    approvalId: approval.id, idempotencyKey: randomUUID(), destination: 'not-configured',
    status: 'pending', externalId: null, attempts: 0, lastErrorCode: null, updatedAt: now.toISOString() });
  requireSafeDispatch(job);
  for (const status of ['sending', 'uncertain', 'succeeded', 'failed', 'unavailable'] as const) {
    assert.throws(() => requireSafeDispatch({ ...job, status }));
  }
  assert.equal(IntegrationJob.safeParse({ ...job, status: 'succeeded' }).success, false);
});
