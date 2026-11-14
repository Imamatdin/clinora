import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiFailure, type Request } from '../api.js';
import { errorText, t as coreT, useLocale, type UiKey } from '../i18n/index.js';
import type { ModuleProps, WebModule } from '../modules.js';
import { translator, type LabKey } from './i18n.js';
import { AbrField } from '../abr.js';
import { Icon, Seg } from '../shell.js';

type Order = { id: string; status: string; service: string; patientName: string; patientNo: number | null; orderedBy: string; orderedByRole: string | null; orderedAt: string; resultVersion: number | null;
  visitDate: string; late: boolean; pending: boolean };
type Value = { name: string; value: string; unit: string; reference: string };
type Detail = Order & { birthDate: string | null; visitOpen: boolean;
  versions: { version: number; enteredAt: string; enteredBy: string; values: Value[]; comment: string | null; afterConfirmation: boolean }[] };
type T = (key: LabKey, vars?: Record<string, string | number>) => string;
/** Task 025: who ordered the test and in what role. A non-doctor order was placed at registration, not by a doctor. */
export function orderedLabel(t: T, o: Pick<Order, 'orderedBy' | 'orderedByRole'>) {
  if (o.orderedByRole === 'doctor') return t('lab.orderedBy', { name: o.orderedBy });
  if (!o.orderedByRole) return t('lab.orderedByName', { name: o.orderedBy });
  return t('lab.orderedAtRegistration', { name: o.orderedBy, role: coreT(`role.${o.orderedByRole}` as UiKey) });
}
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

  if (openId) return <section className="dr screen">
    <div className="dr-head"><button className="quiet back" onClick={() => { setDirty(false); setOpenId(''); void load(); }}><Icon name="back" />{t('lab.back')}</button></div>
    <LabOrder key={openId} t={t} base={base} id={openId} request={request} setDirty={setDirty} />
  </section>;
  const shown = (data?.orders ?? []).filter(o => filter === 'all' || o.status === filter);
  const waiting = (data?.orders ?? []).filter(o => o.status === 'ordered').length;
  return <section className="dr screen">
    {error && <p role="alert" className="error">{error}</p>}
    {!data ? <p role="status">{t('lab.loading')}</p> : !data.day && !data.orders.length ? <p className="empty">{t('lab.noDay')}</p> : <>
      {!data.day && <p className="notice">{t('lab.noDay')}</p>}
      <div className="hero"><AbrField /><div className="hero-in">
        <p className="hero-label">{t('lab.filter.ordered')}</p><p className="hero-figure">{waiting}</p>
      </div></div>
      <div className="dr-actions">
        <Seg label={t('lab.filter')} value={filter} onChange={setFilter} options={FILTERS.map(f => [f, t(`lab.filter.${f}`)] as const)} />
        <button className="quiet" disabled={busy} onClick={() => { setBusy(true); load().catch(() => setError(errorText('SERVICE_UNAVAILABLE'))).finally(() => setBusy(false)); }}><Icon name="refresh" />{t('lab.refresh')}</button>
      </div>
      {!shown.length ? <p className="empty">{t('lab.empty')}</p> : <ul className="dr-orders rows">{shown.map(o => <li key={o.id}>
        <button className="row" aria-label={`${t('lab.open')}: ${o.service} · ${o.patientName}`} onClick={() => setOpenId(o.id)}>
          <span className="row-body"><strong className="row-title">{o.service}</strong>
            <span className="row-meta">{o.patientName}{o.patientNo ? ' · ' + t('lab.patientNo', { number: o.patientNo }) : ''}</span>
            <span className="row-meta">{orderedLabel(t, o)} · {time(o.orderedAt)}{o.resultVersion ? ' · ' + t('lab.resultSaved', { version: o.resultVersion }) : ''}</span></span>
          <span className="row-end lab-state"><span className={o.status === 'completed' ? 'tag ok' : 'tag'}>{t(`lab.status.${o.status}` as LabKey)}</span>
            {o.late && <span className="tag attn">{t('lab.late', { date: o.visitDate.split('-').reverse().join('.') })}</span>}{o.pending && <span className="tag attn">{t('lab.pendingTag')}</span>}</span>
          <span className="chev" aria-hidden="true" /></button>
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
  const confirmTest = () => { if (confirm(t('lab.confirmQuestion'))) void run(async () => {
    const r = await post<{ status: string; late?: boolean; postedTo?: string }>('/confirm', {}); await reload();
    setNotice(r.status === 'pending' ? t('lab.pending') : r.late && r.postedTo ? t('lab.confirmedLate', { date: r.postedTo.split('-').reverse().join('.') }) : t('lab.confirmed'));
  }); };
  const setCell = (i: number, k: keyof Value, value: string) => { setRows(old => old.map((r, j) => j === i ? { ...r, [k]: value } : r)); markDirty(true); };

  return <div className="dr-visit lab-order">
    <div className="hero"><AbrField /><div className="hero-in">
      <p className="hero-label"><span className={`dot ${order.status === 'completed' ? 'ok' : ''}`}>{t(`lab.status.${order.status}` as LabKey)}</span></p>
      <h2 className="lab-test">{order.service}</h2>
      <p className="name lab-patient">{order.patientName}</p>
      <p className="muted">{[order.patientNo && t('lab.patientNo', { number: order.patientNo }), t('lab.birthDate', { date: order.birthDate ? order.birthDate.split('-').reverse().join('.') : t('lab.unknown') }), orderedLabel(t, order)].filter(Boolean).join(' · ')}</p>
    </div></div>
    <div aria-live="polite" className="banners">{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}</div>
    <form className="dr-card" onSubmit={save}>
      <h3 className="section-label">{t('lab.results')}</h3>
      {rows.map((r, i) => <fieldset key={i} className="lab-row"><legend className="sr-only">{t('lab.row', { n: i + 1 })}</legend>
        {COLUMNS.map(k => <label key={k}>{t(COLUMN_KEY[k])}<input value={r[k]} required={k === 'name' || k === 'value'} disabled={busy}
          maxLength={k === 'value' ? 200 : k === 'name' || k === 'reference' ? 120 : 40} onChange={e => setCell(i, k, e.target.value)} /></label>)}
        {rows.length > 1 && <button type="button" className="quiet" disabled={busy} onClick={() => { setRows(old => old.filter((_, j) => j !== i)); markDirty(true); }}>{t('lab.removeRow')}</button>}
      </fieldset>)}
      <button type="button" className="lab-add" disabled={busy || rows.length >= 60} onClick={() => { setRows(old => [...old, blank()]); markDirty(true); }}><Icon name="plus" />{t('lab.addRow')}</button>
      <label>{t('lab.comment')}<textarea value={comment} rows={2} maxLength={2000} disabled={busy} onChange={e => { setComment(e.target.value); markDirty(true); }} /></label>
      <div className="dr-actions dr-save">
        <button className={dirty || !order.resultVersion ? 'primary big' : 'big'} disabled={busy || !dirty}>{t('lab.save')}</button>
        {order.status === 'ordered' && <button type="button" className={!dirty && order.resultVersion ? 'primary big' : 'big'} disabled={busy || dirty || !order.resultVersion || order.pending} onClick={confirmTest}>{t('lab.confirm')}</button>}
        <p role="status" className="fine">{busy ? t('lab.saving') : dirty ? t('lab.unsaved') : ''}</p>
      </div>
      {order.status === 'ordered' && !order.resultVersion && <p className="fine">{t('lab.needResult')}</p>}
      {order.status === 'ordered' && order.late && <p className="fine attn">{t('lab.late', { date: order.visitDate.split('-').reverse().join('.') })} · {t('lab.lateHint')}</p>}
      {order.pending && <p className="fine attn">{t('lab.pending')}</p>}
    </form>
    <details className="dr-card lab-history"><summary>{t('lab.history')}{order.versions.length > 0 && ` · ${order.versions.length}`}</summary>
      {!order.versions.length ? <p className="fine">{t('lab.noHistory')}</p> : <ul className="dr-history">{order.versions.map(v => <li key={v.version}>
        <span className="row-meta">{t('lab.version', { version: v.version, by: v.enteredBy, at: time(v.enteredAt) })}{v.afterConfirmation && <> · <span className="tag attn">{t('lab.afterConfirmation')}</span></>}</span>
        <span>{v.values.map(x => `${x.name}: ${x.value}${x.unit ? ' ' + x.unit : ''}`).join('; ')}</span>
      </li>)}</ul>}
    </details>
  </div>;
}

export const labModule: WebModule = { id: 'lab', roles: ['laboratory', 'ceo', 'administrator'], label: 'module.labOrders', Screen: LabHome };
