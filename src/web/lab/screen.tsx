import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiFailure, type Request } from '../api.js';
import { errorText, useLocale } from '../i18n/index.js';
import type { ModuleProps, WebModule } from '../modules.js';
import { translator, type LabKey } from './i18n.js';

type Order = { id: string; status: string; service: string; patientName: string; patientNo: number | null; orderedBy: string; orderedAt: string; resultVersion: number | null };
type Value = { name: string; value: string; unit: string; reference: string };
type Detail = Order & { birthDate: string | null; visitOpen: boolean;
  versions: { version: number; enteredAt: string; enteredBy: string; values: Value[]; comment: string | null; afterConfirmation: boolean }[] };
type T = (key: LabKey, vars?: Record<string, string | number>) => string;
const FILTERS = ['ordered', 'completed', 'all'] as const;
const COLUMNS = ['name', 'value', 'unit', 'reference'] as const;
const COLUMN_KEY = { name: 'lab.param', value: 'lab.value', unit: 'lab.unit', reference: 'lab.reference' } as const;
const blank = (): Value => ({ name: '', value: '', unit: '', reference: '' });
const time = (iso: string) => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

function LabHome({ clinic, request, setDirty }: ModuleProps) {
  const t = translator(useLocale());
  const [data, setData] = useState<{ day: { date: string } | null; orders: Order[] } | null>(null), [filter, setFilter] = useState<typeof FILTERS[number]>('ordered');
  const [openId, setOpenId] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const base = `/api/clinics/${clinic.id}/lab/orders`;
  const load = () => request<{ day: { date: string } | null; orders: Order[] }>(base).then(setData);
  useEffect(() => { load().catch(() => setError(errorText('SERVICE_UNAVAILABLE'))); }, [clinic.id]);
  useEffect(() => {
    if (openId) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load().catch(() => {}); }, 30000);
    return () => clearInterval(timer);
  }, [clinic.id, openId]);

  if (openId) return <section className="dr">
    <div className="dr-head"><button className="quiet" onClick={() => { setDirty(false); setOpenId(''); void load(); }}>{t('lab.back')}</button></div>
    <LabOrder key={openId} t={t} base={base} id={openId} request={request} setDirty={setDirty} />
  </section>;
  const shown = (data?.orders ?? []).filter(o => filter === 'all' || o.status === filter);
  return <section className="dr">
    <div className="dr-head"><h2>{t('lab.title')}</h2></div>
    {error && <p role="alert" className="error">{error}</p>}
    {!data ? <p>{t('lab.loading')}</p> : !data.day ? <p className="empty">{t('lab.noDay')}</p> : <>
      <div className="dr-actions" role="group" aria-label={t('lab.filter')}>
        {FILTERS.map(f => <button key={f} className={f === filter ? 'primary' : ''} aria-pressed={f === filter} onClick={() => setFilter(f)}>{t(`lab.filter.${f}`)}</button>)}
        <button className="quiet" disabled={busy} onClick={() => { setBusy(true); load().catch(() => setError(errorText('SERVICE_UNAVAILABLE'))).finally(() => setBusy(false)); }}>{t('lab.refresh')}</button>
      </div>
      {!shown.length ? <p className="empty">{t('lab.empty')}</p> : <ul className="dr-orders">{shown.map(o => <li key={o.id} className="dr-card">
        <div><strong>{o.service}</strong> <span className={o.status === 'completed' ? 'tag ok' : 'tag'}>{t(`lab.status.${o.status}` as LabKey)}</span></div>
        <div>{o.patientName}{o.patientNo ? ' · ' + t('lab.patientNo', { number: o.patientNo }) : ''}</div>
        <div className="fine">{t('lab.orderedBy', { name: o.orderedBy })} · {time(o.orderedAt)}{o.resultVersion ? ' · ' + t('lab.resultSaved', { version: o.resultVersion }) : ''}</div>
        <button className="primary" onClick={() => setOpenId(o.id)}>{t('lab.open')}</button>
      </li>)}</ul>}
    </>}
  </section>;
}

function LabOrder({ t, base, id, request, setDirty }: { t: T; base: string; id: string; request: Request; setDirty: (d: boolean) => void }) {
  const [order, setOrder] = useState<Detail | null>(null), [rows, setRows] = useState<Value[]>([blank()]), [comment, setComment] = useState('');
  const [dirty, setLocalDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const keys = useRef(new Map<string, string>());
  const markDirty = (d: boolean) => { setLocalDirty(d); setDirty(d); };
  async function reload() {
    const d = await request<Detail>(`${base}/${id}`); setOrder(d);
    const latest = d.versions[0];
    setRows(latest ? latest.values.map(v => ({ ...v })) : [blank()]); setComment(latest?.comment ?? ''); markDirty(false);
  }
  useEffect(() => { reload().catch(e => setError(errorText(e instanceof ApiFailure ? e.code : 'SERVICE_UNAVAILABLE'))); }, [id]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(errorText(e instanceof ApiFailure ? e.code : 'SERVICE_UNAVAILABLE')); } finally { setBusy(false); }
  };
  const post = async <R,>(path: string, body: Record<string, unknown>) => {
    const scope = path + JSON.stringify(body);
    let k = keys.current.get(scope); if (!k) { k = crypto.randomUUID(); keys.current.set(scope, k); }
    const r = await request<R>(`${base}/${id}${path}`, { ...body, idempotencyKey: k }); keys.current.delete(scope); return r;
  };
  if (!order) return error ? <p role="alert" className="error">{error}</p> : <p>{t('lab.loading')}</p>;
  const save = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    const values = rows.filter(r => r.name.trim() || r.value.trim());
    const r = await post<{ version: number }>('/results', { expectedVersion: order.resultVersion ?? 0, values, comment });
    await reload(); setNotice(t('lab.saved', { version: r.version }));
  }); };
  const confirmTest = () => { if (confirm(t('lab.confirmQuestion'))) void run(async () => { await post('/confirm', {}); await reload(); setNotice(t('lab.confirmed')); }); };
  const setCell = (i: number, k: keyof Value, value: string) => { setRows(old => old.map((r, j) => j === i ? { ...r, [k]: value } : r)); markDirty(true); };

  return <div className="dr-main">
    <div aria-live="polite">{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}</div>
    <article className="dr-card">
      <h3>{order.service} <span className={order.status === 'completed' ? 'tag ok' : 'tag'}>{t(`lab.status.${order.status}` as LabKey)}</span></h3>
      <p>{order.patientName}{order.patientNo ? ' · ' + t('lab.patientNo', { number: order.patientNo }) : ''}</p>
      <p className="fine">{t('lab.birthDate', { date: order.birthDate ? order.birthDate.split('-').reverse().join('.') : t('lab.unknown') })} · {t('lab.orderedBy', { name: order.orderedBy })}</p>
    </article>
    <form className="dr-card" onSubmit={save}>
      <h3>{t('lab.results')}</h3>
      {rows.map((r, i) => <fieldset key={i} className="dr-rx-line"><legend>{t('lab.row', { n: i + 1 })}</legend>
        {COLUMNS.map(k => <label key={k}>{t(COLUMN_KEY[k])}<input value={r[k]} required={k === 'name' || k === 'value'} disabled={busy}
          maxLength={k === 'value' ? 200 : k === 'name' || k === 'reference' ? 120 : 40} onChange={e => setCell(i, k, e.target.value)} /></label>)}
        {rows.length > 1 && <button type="button" className="quiet" disabled={busy} onClick={() => { setRows(old => old.filter((_, j) => j !== i)); markDirty(true); }}>{t('lab.removeRow')}</button>}
      </fieldset>)}
      <button type="button" disabled={busy || rows.length >= 60} onClick={() => { setRows(old => [...old, blank()]); markDirty(true); }}>{t('lab.addRow')}</button>
      <label>{t('lab.comment')}<textarea value={comment} rows={2} maxLength={2000} disabled={busy} onChange={e => { setComment(e.target.value); markDirty(true); }} /></label>
      <div className="dr-actions">
        <p role="status" className="fine">{busy ? t('lab.saving') : dirty ? t('lab.unsaved') : ''}</p>
        <button className="primary" disabled={busy || !dirty}>{t('lab.save')}</button>
        {order.status === 'ordered' && <button type="button" className="primary big" disabled={busy || dirty || !order.resultVersion || !order.visitOpen} onClick={confirmTest}>{t('lab.confirm')}</button>}
      </div>
      {order.status === 'ordered' && !order.resultVersion && <p className="fine">{t('lab.needResult')}</p>}
      {order.status === 'ordered' && !order.visitOpen && <p className="fine">{t('lab.visitClosed')}</p>}
    </form>
    <section className="dr-card">
      <h3>{t('lab.history')}</h3>
      {!order.versions.length ? <p className="fine">{t('lab.noHistory')}</p> : <ul className="dr-history">{order.versions.map(v => <li key={v.version}>
        <span>{t('lab.version', { version: v.version, by: v.enteredBy, at: time(v.enteredAt) })}</span>
        {v.afterConfirmation && <span className="tag">{t('lab.afterConfirmation')}</span>}
        <span>{v.values.map(x => `${x.name}: ${x.value}${x.unit ? ' ' + x.unit : ''}`).join('; ')}</span>
      </li>)}</ul>}
    </section>
  </div>;
}

export const labModule: WebModule = { id: 'lab', roles: ['laboratory', 'ceo', 'administrator'], label: 'module.labOrders', Screen: LabHome };
