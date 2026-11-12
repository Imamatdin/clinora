import test from 'node:test';
import assert from 'node:assert/strict';
import { registerRoutes } from '../src/server/routes/registry.js';
import { CLINIC_ROUTES } from '../src/server/clinic-routes.js';
import { MODULES, PLANNED, plannedFor, modulesFor, type WebModule } from '../src/web/modules.js';
import { ROLES } from '../src/modules/identity/roles.js';

test('route registry keeps the task-003A routes and rejects a second claim on a route', () => {
  assert.ok(CLINIC_ROUTES.some(r => r.method === 'GET' && r.pattern.source === '^business-days\\/current$'));
  assert.ok(CLINIC_ROUTES.every(r => r.roles.length > 0));
  const dup = CLINIC_ROUTES[0]!;
  assert.throws(() => registerRoutes('other-feature', [{ ...dup }]), /registered by core and other-feature/);
  assert.throws(() => registerRoutes('x', [{ ...dup, pattern: /^unique-test$/, roles: [] }]), /no roles/);
});

test('web module registry: placeholders cover every role and a registered module replaces its placeholder', () => {
  assert.deepEqual(Object.keys(PLANNED).sort(), [...ROLES].sort());
  assert.equal(new Set(MODULES.map(m => m.id)).size, MODULES.length);
  const fake: WebModule = { id: 'registration', roles: ['registrar'], label: 'module.registration', Screen: () => null };
  assert.deepEqual(modulesFor('registrar', [fake]).map(m => m.id), ['registration']);
  assert.ok(!plannedFor('registrar', [fake]).includes('module.registration'));
  assert.ok(plannedFor('registrar', []).includes('module.registration'));
});

test('each role lands on its own main screen (the first registered module for that role)', () => {
  const landing = Object.fromEntries(ROLES.map(r => [r, modulesFor(r)[0]?.id ?? null]));
  assert.deepEqual(landing, { ceo: 'cashier', administrator: 'cashier', registrar: 'registration', doctor: 'doctor',
    laboratory: 'lab', cashier: 'cashier', inpatient: 'inpatient', pharmacy: 'pharmacy' });
});
