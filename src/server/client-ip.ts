import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

// Client address for rate limiting and logs.
// trustedHops = number of proxies in front of this process that APPEND to X-Forwarded-For.
// 0 (default): ignore the header entirely and use the TCP peer.
// 1 (Cloud Run): Google's front end appends the address it saw, so the LAST entry is the real
// client. Everything to its left was supplied by the caller and can be forged; it is never read.
export function clientIp(req: IncomingMessage, trustedHops = 0): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  if (trustedHops < 1) return peer;
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header ?? '';
  const entries = raw.split(',').map(v => v.trim()).filter(Boolean);
  const candidate = entries[entries.length - trustedHops];
  return candidate && isIP(candidate) ? candidate : peer;
}

export function parseTrustedHops(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  const hops = Number(value);
  if (!Number.isInteger(hops) || hops < 0 || hops > 3) throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 3');
  return hops;
}
