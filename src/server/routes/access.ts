import { unlockLogin } from '../../modules/login/actions.js';
import { EmptyInput } from '../../contracts/clinic.js';
import { MANAGERS, ROLES } from '../../modules/identity/roles.js';
import { listDevices, myAccess, revokeDevice, staffAccess, unlockPin } from '../../modules/devices/actions.js';
import { manageableMember, unlink } from '../../modules/telegram/links.js';
import { clearApprovalLock } from '../../modules/identity/approval-pin.js';
import { registerRoutes } from './registry.js';
import { parse, uuid } from './types.js';

/**
 * Task 004 routes: Telegram links, shared devices, PINs. Invite creation and device enrolment live in
 * server/access.ts because they need the bot name or must set cookies and end the current session.
 */
registerRoutes('access', [
  { method: 'POST', pattern: new RegExp(`^staff/${uuid}/login-unlock$`), roles: MANAGERS,
    handle: async (ctx, [user], body) => { parse(EmptyInput, await body()); return { body: await unlockLogin(ctx, user!) }; } },
  { method: 'GET', pattern: /^staff\/access$/, roles: MANAGERS, handle: async ctx => ({ body: await staffAccess(ctx) }) },
  { method: 'POST', pattern: new RegExp(`^staff/${uuid}/telegram-unlink$`), roles: MANAGERS,
    handle: async (ctx, [user], body) => { parse(EmptyInput, await body()); await manageableMember(ctx, user!); return { body: await unlink(ctx, user!) }; } },
  { method: 'POST', pattern: new RegExp(`^staff/${uuid}/pin-unlock$`), roles: MANAGERS,
    handle: async (ctx, [user], body) => { parse(EmptyInput, await body()); return { body: await unlockPin(ctx, user!) }; } },
  // Task 022: a CEO or another administrator clears an approver's approval-PIN lock (audited).
  { method: 'POST', pattern: new RegExp(`^staff/${uuid}/approval-unlock$`), roles: MANAGERS,
    handle: async (ctx, [user], body) => { parse(EmptyInput, await body()); return { body: await clearApprovalLock(ctx, user!) }; } },
  { method: 'GET', pattern: /^devices$/, roles: MANAGERS, handle: async ctx => ({ body: await listDevices(ctx) }) },
  { method: 'POST', pattern: new RegExp(`^devices/${uuid}/revoke$`), roles: MANAGERS,
    handle: async (ctx, [device], body) => { parse(EmptyInput, await body()); return { body: await revokeDevice(ctx, device!) }; } },
  { method: 'GET', pattern: /^access\/me$/, roles: ROLES, handle: async ctx => ({ body: await myAccess(ctx) }) },
  { method: 'POST', pattern: /^access\/me\/telegram-unlink$/, roles: ROLES,
    handle: async (ctx, _p, body) => { parse(EmptyInput, await body()); return { body: await unlink(ctx, ctx.actorId) }; } }
]);
