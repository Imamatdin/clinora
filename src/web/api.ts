export class ApiFailure extends Error { constructor(public code: string) { super(code); } }

export type Request = <T>(path: string, body?: unknown, idempotent?: boolean) => Promise<T>;

/**
 * JSON API client. Mutations carry the CSRF token. An idempotent mutation reuses its key while
 * the same path and payload are retried, so a repeated submit after a timeout records one result.
 */
export function createRequest(csrf: () => string): Request {
  let retry: { path: string; payload: string; key: string } | null = null;
  return async function request<T>(path: string, body?: unknown, idempotent = false): Promise<T> {
    let key: string | undefined;
    if (idempotent) {
      const payload = JSON.stringify(body);
      if (!retry || retry.path !== path || retry.payload !== payload) retry = { path, payload, key: crypto.randomUUID() };
      key = retry.key;
    }
    const headers: Record<string, string> = {};
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = csrf(); }
    if (key) headers['Idempotency-Key'] = key;
    let response: Response;
    try {
      response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    } catch { throw new ApiFailure('SERVICE_UNAVAILABLE'); }
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new ApiFailure(value?.error?.code ?? 'SERVICE_UNAVAILABLE');
    if (idempotent) retry = null;
    return value as T;
  };
}
