import test from 'node:test';
import assert from 'node:assert/strict';
import { countBedDays } from '../src/modules/billing/index.js';

test('calendar bed days cover all flags, same-day stays, minimum and open admissions', () => {
  for (const countAdmissionDay of [false, true]) for (const countDischargeDay of [false, true]) {
    const rule = { countAdmissionDay, countDischargeDay, minimumDays: 1 };
    assert.equal(countBedDays({ admissionDate: '2026-11-01', dischargeDate: '2026-11-06', rule }),
      4 + Number(countAdmissionDay) + Number(countDischargeDay));
    assert.equal(countBedDays({ admissionDate: '2026-11-01', dischargeDate: '2026-11-01', rule }), 1);
    assert.equal(countBedDays({ admissionDate: '2026-11-01', asOfDate: '2026-11-06', rule }),
      5 + Number(countAdmissionDay));
  }
  const rule = { countAdmissionDay: true, countDischargeDay: false, minimumDays: 1 };
  assert.equal(countBedDays({ admissionDate: '2024-02-28', dischargeDate: '2024-03-01', rule }), 2);
  assert.equal(countBedDays({ admissionDate: '2025-12-31', dischargeDate: '2026-01-01', rule }), 1);
  assert.equal(countBedDays({ admissionDate: '2026-11-01', dischargeDate: '2026-11-02', rule: { ...rule, minimumDays: 5 } }), 5);
});

test('reject malformed or reversed dates and invalid bed-day rules', () => {
  const rule = { countAdmissionDay: true, countDischargeDay: true, minimumDays: 1 };
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '2026-1-01', '2026-11-01T00:00:00Z']) {
    assert.throws(() => countBedDays({ admissionDate: date, asOfDate: '2026-11-12', rule }));
  }
  assert.throws(() => countBedDays({ admissionDate: '2026-11-02', dischargeDate: '2026-11-01', rule }));
  assert.throws(() => countBedDays({ admissionDate: '2026-11-01', rule }));
  for (const minimumDays of [0, -1, 1.5, Infinity]) {
    assert.throws(() => countBedDays({ admissionDate: '2026-11-01', asOfDate: '2026-11-02', rule: { ...rule, minimumDays } }));
  }
});
