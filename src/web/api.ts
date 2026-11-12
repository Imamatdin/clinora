import { clearOutbox, checkOutboxUser, lockOutbox } from './registration/outbox.js';
export class ApiFailure extends Error { constructor(public code: string, public unlockAt?: string) { super(code); } }

export type Request = <T>(path: string, body?: unknown, idempotent?: boolean) => Promise<T>;

/**
 * JSON API client. Mutations carry the CSRF token. An idempotent mutation reuses its key while
 * the same path and payload are retried, so a repeated submit after a timeout records one result.
 */
export function createRequest(csrf: () => string): Request {
  let retry: { path: string; payload: string; key: string } | null = null;
  return async function request<T>(path: string, body?: unknown, idempotent = false): Promise<T> {
    const csrfToken = csrf(); // Capture before a concurrent shell lock clears the token.
    let key: string | undefined;
    if (idempotent) {
      const payload = JSON.stringify(body);
      if (!retry || retry.path !== path || retry.payload !== payload) retry = { path, payload, key: crypto.randomUUID() };
      key = retry.key;
    }
    const headers: Record<string, string> = {};
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = csrfToken; }
    if (key) headers['Idempotency-Key'] = key;
    let response: Response;
    try {
      response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    } catch { throw new ApiFailure('SERVICE_UNAVAILABLE'); }
    const value = await response.json().catch(() => null);
    if (response.status === 401) {
      // A long outage expires the server session even while the registrar is actively typing.
      // Only a confirmed missing/revoked enrollment destroys queued work; PIN login can recover it.
      try {
        const deviceResponse = await fetch('/api/device', { signal: AbortSignal.timeout(15000) });
        const device = deviceResponse.ok ? await deviceResponse.json() : null;
        if (device?.enrolled === false) await clearOutbox(true); else lockOutbox();
      } catch { lockOutbox(); }
    }
    if (!response.ok) throw new ApiFailure(value?.error?.code ?? 'SERVICE_UNAVAILABLE', value?.error?.unlockAt);
    if (path === '/api/auth/me') await checkOutboxUser(value);
    if (path === '/api/device' && value?.enrolled === false) await clearOutbox();
    if (idempotent) retry = null;
    return value as T;
  };
}
