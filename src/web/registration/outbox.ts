import type { Names } from './i18n.js';

export type Route = { queuePointId: string; serviceIds: string[] };
export type PersonInput = { fullName: string; birthDate: string; gender: string; phone: string | null; districtId: string | null; mahallaId: string | null; address: string | null; source: string | null; duplicateReason?: string };
export type OfflineEntry = {
  id: string; code: string; createdAt: string; businessDayId: string; points: Route[];
  labels: Names[]; patient?: PersonInput; patientId?: string; error?: string;
};
type State = { owner: string; counter: number; entries: OfflineEntry[] };
const DB = 'clinora-registration';
const channel = typeof window === 'undefined' || typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(DB);
const changed = () => window.dispatchEvent(new Event('registration-outbox'));
channel?.addEventListener('message', e => {
  changed();
  if (e.data === 'clear' || e.data === 'lock') window.dispatchEvent(new Event('registration-session-ended'));
  if (e.data?.identity !== undefined) window.dispatchEvent(new CustomEvent('registration-session-identity', { detail: e.data.identity }));
});

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('outbox');
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
/** A single IndexedDB transaction serializes counters, enqueue and user-switch cleanup across tabs. */
async function update<T>(work: (state: State | undefined) => { state?: State; result: T }): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('outbox', 'readwrite'), store = tx.objectStore('outbox');
      let result: T;
      const get = store.get('state');
      get.onsuccess = () => {
        try {
          const next = work(get.result); result = next.result;
          if (next.state) store.put(next.state, 'state'); else store.delete('state');
        } catch (e) { tx.abort(); reject(e); }
      };
      tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export async function clearOutbox(endSession = false) {
  await update(state => ({ state: { owner: '', counter: state?.counter ?? 0, entries: [] }, result: undefined })); changed(); channel?.postMessage(endSession ? 'clear' : 'change');
  if (endSession) window.dispatchEvent(new Event('registration-session-ended'));
}
/** An expired session hides queued records until PIN reauthentication; it is not device revocation. */
export function lockOutbox() {
  channel?.postMessage('lock'); window.dispatchEvent(new Event('registration-session-ended'));
}
/** Called for every successful /auth/me, including tabs that never open registration. */
export async function checkOutboxUser(user: { id: string; session: { via: string; deviceId?: string | null } }) {
  const prefix = user.session.via === 'device' && user.session.deviceId ? `${user.id}:${user.session.deviceId}:` : null;
  await update(state => ({ state: state && prefix && state.owner.startsWith(prefix) ? state : { owner: '', counter: state?.counter ?? 0, entries: [] }, result: undefined }));
  changed(); channel?.postMessage({ identity: `${user.id}:${user.session.deviceId ?? null}:` });
}
export async function openOutbox(owner: string) {
  return update(state => {
    const next = state?.owner === owner ? state : { owner, counter: state?.counter ?? 0, entries: [] };
    return { state: next, result: next.entries };
  });
}
export async function readOutbox(owner: string) {
  return update(state => ({ ...(state ? { state } : {}), result: state?.owner === owner ? state.entries : [] }));
}
export async function enqueue(owner: string, deviceId: string, entry: Omit<OfflineEntry, 'code' | 'createdAt'>) {
  const result = await update(state => {
    if (state?.owner !== owner) throw new Error('Offline identity changed');
    const existing = state.entries.find(e => e.id === entry.id);
    if (existing) return { state, result: existing };
    const code = `R${deviceId.replaceAll('-', '').slice(0, 8).toUpperCase()}-${String(state.counter + 1).padStart(2, '0')}`;
    const row = { ...entry, code, createdAt: new Date().toISOString() };
    return { state: { ...state, counter: state.counter + 1, entries: [...state.entries, row] }, result: row };
  });
  changed(); channel?.postMessage('change'); return result;
}
export async function changeEntry(owner: string, id: string, edit: (entry: OfflineEntry) => OfflineEntry | null) {
  await update(state => {
    if (state?.owner !== owner) return { ...(state ? { state } : {}), result: undefined };
    return { state: { ...state, entries: state.entries.flatMap(e => { if (e.id !== id) return [e]; const next = edit(e); return next ? [next] : []; }) }, result: undefined };
  });
  changed(); channel?.postMessage('change');
}
