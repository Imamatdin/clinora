import test from 'node:test';
import assert from 'node:assert/strict';
import { Registration, TelegramLink } from '../src/contracts/index.js';
import { DomainError, requireClinicalAccess } from '../src/modules/identity/access.js';
import { ids, membership, now, principal, scope } from './fixtures.js';

const denied = (p: unknown, m: unknown, s = scope, code = 'FORBIDDEN') => assert.throws(
  () => requireClinicalAccess(p, m, s, now), (e: unknown) => e instanceof DomainError && e.code === code
);
test('registration rejects self-granted doctor, clinic, verification and Telegram claims', () => {
  const base = { email: 'synthetic@example.test', displayName: 'Synthetic user' };
  assert.equal(Registration.safeParse(base).success, true);
  for (const extra of [{ role: 'doctor' }, { clinicId: ids.clinic }, { professionalVerification: 'verified' }, { telegramUserId: '123' }]) {
    assert.equal(Registration.safeParse({ ...base, ...extra }).success, false);
  }
});
test('only an active server-authorized clinician can access the permitted clinic', () => {
  assert.equal(requireClinicalAccess(principal, membership, scope, now).principal.userId, ids.user);
  denied(null, membership, scope, 'UNAUTHENTICATED');
  denied({ ...principal, expiresAt: now.toISOString() }, membership, scope, 'UNAUTHENTICATED');
  denied({ ...principal, accountStatus: 'blocked' }, membership, scope, 'UNAUTHENTICATED');
  denied(principal, null);
  denied(principal, { ...membership, userId: ids.otherUser });
  denied(principal, membership, { ...scope, clinicId: ids.otherClinic });
  denied(principal, { ...membership, role: 'administrator' });
  denied(principal, { ...membership, status: 'invited' });
  denied(principal, { ...membership, status: 'revoked' });
  denied(principal, { ...membership, grant: null });
  denied(principal, { ...membership, grant: { by: ids.admin, at: '2026-11-12T00:00:00Z' } });
});
test('patient restrictions and revocation take effect on the next policy invocation', () => {
  const assigned = { ...membership, patientScope: { kind: 'assigned', patientIds: [ids.patient] } };
  requireClinicalAccess(principal, assigned, scope, now);
  denied(principal, assigned, { ...scope, patientId: ids.otherPatient });
  denied(principal, { ...assigned, status: 'revoked' });
});
test('a valid Telegram identity link cannot substitute for a clinical membership', () => {
  const telegram = TelegramLink.parse({ userId: ids.user, telegramUserId: '1234567', linkedAt: now.toISOString(), status: 'active' });
  denied(principal, telegram);
});
