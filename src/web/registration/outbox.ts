import type { Names } from './i18n.js';

export type Route = { queuePointId: string; serviceIds: string[] };
export type PersonInput = { fullName: string; birthDate: string; gender: string; phone: string | null; districtId: string | null; mahallaId: string | null; address: string | null; source: string | null; duplicateReason?: string };
export type OfflineEntry = {
  id: string; code: string; createdAt: string; businessDayId: string; points: Route[];
  labels: Names[]; patient?: PersonInput; patientId?: string; error?: string;
};
/**
 * Queued registrations per owner (`user:device:clinic`). Patients already hold provisional tickets
 * for these, so a user switch, sign-out, session expiry or lost role never deletes them: they stay
 * locked to the person who created them and sync when that person signs in again. Only device
 * revocation (`wipeOutbox`) deletes them. `name` is the staff member's display name for banners.
 */
type Bucket = { name: string; entries: OfflineEntry[]; blocked?: 'FORBIDDEN' };
type State = { counter: number; owners: Record<string, Bucket> };
type Legacy = { owner: string; counter: number; entries: OfflineEntry[] };
export type Waiting = { owner: string; userId: string; deviceId: string; clinicId: string; name: string; count: number; blocked: boolean };
const DB = 'clinora-registration';
const channel = typeof window === 'undefined' || typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(DB);
const changed = () => window.dispatchEvent(new Event('registration-outbox'));
channel?.addEventListener('message', e => {
  changed();
  if (e.data === 'clear' || e.data === 'lock') window.dispatchEvent(new Event('registration-session-ended'));
  if (e.data?.identity !== undefined) window.dispatchEvent(new CustomEvent('registration-session-identity', { detail: e.data.identity }));
});
const names = new Map<string, string>(); // userId -> display name, from /auth/me in this tab

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('outbox');
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
/** Task 016 stored one owner; keep its entries (they may hold patients' tickets) under that owner. */
function normalize(raw: State | Legacy | undefined): State {
  if (!raw) return { counter: 0, owners: {} };
  if ('owners' in raw) return raw;
  return { counter: raw.counter ?? 0, owners: raw.owner && raw.entries?.length ? { [raw.owner]: { name: '', entries: raw.entries } } : {} };
}
/** A single IndexedDB transaction serializes counters, enqueue and edits across tabs. */
async function update<T>(work: (state: State) => { state?: State; result: T }): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('outbox', 'readwrite'), store = tx.objectStore('outbox');
      let result: T;
      const get = store.get('state');
      get.onsuccess = () => {
        try {
          const next = work(normalize(get.result)); result = next.result;
          if (next.state) store.put(next.state, 'state');
        } catch (e) { tx.abort(); reject(e); }
      };
      tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
const prune = (owners: Record<string, Bucket>) => Object.fromEntries(Object.entries(owners).filter(([, b]) => b.entries.length));
const announce = (message: unknown = 'change') => { changed(); channel?.postMessage(message); };

/** Device revocation only: the one path that deletes queued registrations (task 020). */
export async function wipeOutbox(endSession = false) {
  const had = await update(state => Object.keys(state.owners).length ? { state: { counter: state.counter, owners: {} }, result: true } : { result: false });
  if (had || endSession) announce(endSession ? 'clear' : 'change');
  if (endSession) window.dispatchEvent(new Event('registration-session-ended'));
}
/** Switch user, sign-out and expired sessions hide queued records; they stay for their owner's next sign-in. */
export function lockOutbox() {
  announce('lock'); window.dispatchEvent(new Event('registration-session-ended'));
}
/** Called for every successful /auth/me, including tabs that never open registration. Never deletes. */
export async function checkOutboxUser(user: { id: string; name?: string; session: { via: string; deviceId?: string | null } }) {
  if (user.name) {
    names.set(user.id, user.name);
    await update(state => {
      const mine = Object.entries(state.owners).filter(([owner, b]) => owner.startsWith(`${user.id}:`) && b.name !== user.name);
      if (!mine.length) return { result: undefined };
      return { state: { ...state, owners: { ...state.owners, ...Object.fromEntries(mine.map(([o, b]) => [o, { ...b, name: user.name! }])) } }, result: undefined };
    });
  }
  announce({ identity: `${user.id}:${user.session.deviceId ?? null}:` });
}
export async function openOutbox(owner: string) {
  return update(state => {
    const bucket = state.owners[owner];
    const name = names.get(owner.split(':')[0]!) ?? bucket?.name ?? '';
    if (bucket && bucket.name === name) return { result: bucket.entries };
    return { state: { ...state, owners: { ...state.owners, [owner]: { ...bucket, name, entries: bucket?.entries ?? [] } } }, result: bucket?.entries ?? [] };
  });
}
export async function readOutbox(owner: string) {
  return update(state => ({ result: state.owners[owner]?.entries ?? [] }));
}
/** Lost role or FORBIDDEN on replay: keep the entries, flag them for an administrator. */
export async function setOwnerBlocked(owner: string, blocked: boolean) {
  const did = await update(state => {
    const bucket = state.owners[owner];
    if (!bucket || !!bucket.blocked === blocked) return { result: false };
    const { blocked: _old, ...rest } = bucket;
    return { state: { ...state, owners: { ...state.owners, [owner]: blocked ? { ...rest, blocked: 'FORBIDDEN' as const } : rest } }, result: true };
  });
  if (did) announce();
}
/** Counts and staff names only (no patient fields), for banners and the revoke confirmation. */
export async function waitingOutbox(): Promise<Waiting[]> {
  return update(state => ({ result: Object.entries(state.owners).filter(([, b]) => b.entries.length).map(([owner, b]) => {
    const [userId = '', deviceId = '', clinicId = ''] = owner.split(':');
    return { owner, userId, deviceId, clinicId, name: b.name, count: b.entries.length, blocked: b.blocked === 'FORBIDDEN' };
  }) }));
}
export async function enqueue(owner: string, deviceId: string, entry: Omit<OfflineEntry, 'code' | 'createdAt'>) {
  const result = await update(state => {
    const bucket = state.owners[owner];
    if (!bucket) throw new Error('Offline identity changed');
    const existing = bucket.entries.find(e => e.id === entry.id);
    if (existing) return { result: existing };
    // One counter per device, so provisional codes stay unique across the people using it.
    const code = `R${deviceId.replaceAll('-', '').slice(0, 8).toUpperCase()}-${String(state.counter + 1).padStart(2, '0')}`;
    const row = { ...entry, code, createdAt: new Date().toISOString() };
    return { state: { counter: state.counter + 1, owners: { ...state.owners, [owner]: { ...bucket, entries: [...bucket.entries, row] } } }, result: row };
  });
  announce(); return result;
}
export async function changeEntry(owner: string, id: string, edit: (entry: OfflineEntry) => OfflineEntry | null) {
  await update(state => {
    const bucket = state.owners[owner];
    if (!bucket) return { result: undefined };
    const entries = bucket.entries.flatMap(e => { if (e.id !== id) return [e]; const next = edit(e); return next ? [next] : []; });
    // Keep the open owner's (possibly empty) bucket; drop other empty buckets.
    return { state: { ...state, owners: { ...prune(state.owners), [owner]: { ...bucket, entries } } }, result: undefined };
  });
  announce();
}
