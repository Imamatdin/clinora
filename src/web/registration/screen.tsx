import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ModuleProps, WebModule } from '../modules.js';
import { errorText } from '../i18n/index.js';
import { ApiFailure } from '../api.js';
import { enqueue, changeEntry, type OfflineEntry } from './outbox.js';
import { LocalTickets, OfflineStatus, useRegistrationOutbox } from './offline.js';
import { formatUzs, uzs } from '../../modules/billing/money.js';
import { pickName, translator, type Names } from './i18n.js';
import { useLocale } from '../i18n/locale.js';

type Service = { id: string; kind: string; names: Names; priceUzs: string | null };
type Point = { id: string; kind: 'doctor' | 'department' | 'service'; names: Names; waiting: number; services: Service[] };
type District = { id: string; names: Names; mahallas: { id: string; names: Names }[] };
export type Options = { day: { id: string; businessDate: string } | null; points: Point[]; districts: District[]; sources: string[] };
type Patient = { id: string; patientNo: number; fullName: string; birthDate: string | null; gender: 'male' | 'female' | null; phone: string | null; lastVisit?: string | null };
type Detail = Patient & { districtId: string | null; mahallaId: string | null; address: string | null; source: string | null; revision: number };
type Ticket = { id: string; queuePointId: string; number: number; names: Names };
type Visit = { visitId: string; patientNo: number; tickets: Ticket[] };
type Draft = { fullName: string; birthDate: string; gender: '' | 'male' | 'female'; phone: string; districtId: string; mahallaId: string; address: string; source: string };
type Step = 'find' | 'form' | 'route' | 'done';

const emptyDraft: Draft = { fullName: '', birthDate: '', gender: '', phone: '', districtId: '', mahallaId: '', address: '', source: '' };
const formatDate = (iso: string) => iso.split('-').reverse().join('.');
function age(birthDate: string | null): number | null {
  if (!birthDate) return null;
  const [y, m, d] = birthDate.split('-').map(Number), now = new Date();
  return now.getFullYear() - y! - (now.getMonth() + 1 < m! || (now.getMonth() + 1 === m && now.getDate() < d!) ? 1 : 0);
}
/** Phone digits as typed on the keypad; a 9-digit local number gets +998 on the server. */
const phoneDigits = (value: string) => value.replace(/[^\d+]/g, '').slice(0, 16);

export function Registration({ clinic, request, setDirty, myId, offlineDeviceId }: ModuleProps) {
  const locale = useLocale(), t = translator(locale);
  const base = `/api/clinics/${clinic.id}/registration`;
  const owner = offlineDeviceId ? `${myId}:${offlineDeviceId}:${clinic.id}` : null;
  const outbox = useRegistrationOutbox(owner, base, request);
  const [local, setLocal] = useState<OfflineEntry | null>(null), [printed, setPrinted] = useState<OfflineEntry | null>(null);
  const [options, setOptions] = useState<Options | null>(null);
  const [step, setStep] = useState<Step>('find');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [query, setQuery] = useState(''), [results, setResults] = useState<Patient[] | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft), [editing, setEditing] = useState<Detail | null>(null);
  const [matches, setMatches] = useState<Patient[]>([]), [reason, setReason] = useState('');
  const [patient, setPatient] = useState<Patient | null>(null);
  const [chosen, setChosen] = useState<Record<string, string[]>>({}), [admit, setAdmit] = useState(false);
  const [visit, setVisit] = useState<Visit | null>(null);
  const patientKey = useRef(crypto.randomUUID()), visitKey = useRef<{ signature: string; key: string } | null>(null);
  const locked = useRef(false);

  async function loadOptions() {
    try { setOptions(await request<Options>(`${base}/options`)); outbox.setOffline(!navigator.onLine); }
    catch (e) { if (e instanceof ApiFailure && e.code === 'SERVICE_UNAVAILABLE') outbox.setOffline(true); throw e; }
  }
  async function run(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) {
      if (e instanceof ApiFailure && e.code === 'SERVICE_UNAVAILABLE') outbox.setOffline(true);
      setError(errorText(e instanceof ApiFailure ? e.code : 'SERVICE_UNAVAILABLE'));
    }
    finally { setBusy(false); locked.current = false; }
  }
  useEffect(() => { void run(loadOptions); }, [clinic.id]);
  useEffect(() => { if (printed) { const timer = requestAnimationFrame(() => window.print()); return () => cancelAnimationFrame(timer); } }, [printed?.id]);

  function reset() {
    setLocal(null); setPrinted(null);
    setStep('find'); setQuery(''); setResults(null); setDraft(emptyDraft); setEditing(null); setMatches([]); setReason('');
    setPatient(null); setChosen({}); setAdmit(false); setVisit(null); setDirty(false); patientKey.current = crypto.randomUUID(); visitKey.current = null;
    if (navigator.onLine) void run(loadOptions);
  }
  const edit = (patch: Partial<Draft>) => { setDraft(d => ({ ...d, ...patch })); setMatches([]); patientKey.current = crypto.randomUUID(); setDirty(true); };

  function choosePatient(p: Patient) {
    setPatient(p); setStep('route'); setMatches([]); setResults(null);
    setChosen({}); setAdmit(false);
  }
  async function find(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    await run(async () => setResults(await request<Patient[]>(`${base}/search`, { query: query.trim() })));
  }
  function payload() {
    return { fullName: draft.fullName.trim(), birthDate: draft.birthDate, gender: draft.gender, phone: draft.phone ? draft.phone : null,
      districtId: draft.districtId || null, mahallaId: draft.mahallaId || null, address: draft.address.trim() || null, source: draft.source || null };
  }
  async function save(e: FormEvent, anyway = false) {
    e.preventDefault();
    await run(async () => {
      const body = payload();
      const saveLocal = async () => {
        if (!owner || !offlineDeviceId || !options?.day || editing) throw new ApiFailure('SERVICE_UNAVAILABLE');
        const row = await enqueue(owner, offlineDeviceId, { id: patientKey.current, businessDayId: options.day.id, patient: { ...body, ...(anyway ? { duplicateReason: reason.trim() } : {}) }, points: [], labels: [] });
        setLocal(row); setDirty(false);
        choosePatient({ ...body, id: row.id, patientNo: 0, gender: body.gender as 'male' | 'female' });
      };
      if (outbox.offline && !editing) { await saveLocal(); return; }
      try {
      if (editing) {
        const saved = await request<Patient>(`${base}/patients/${editing.id}`, { ...body, expectedRevision: editing.revision, idempotencyKey: patientKey.current });
        setNotice(t('registration.saved')); setEditing(null); setDirty(false); patientKey.current = crypto.randomUUID();
        setPatient(saved); setStep('route'); return;
      }
      if (!anyway) {
        const found = await request<Patient[]>(`${base}/duplicates`, { fullName: body.fullName, birthDate: body.birthDate || null, phone: body.phone });
        if (found.length) { setMatches(found); return; }
      }
      const created = await request<Patient>(`${base}/patients`, { ...body, ...(anyway ? { duplicateReason: reason.trim() } : {}), idempotencyKey: patientKey.current });
      patientKey.current = crypto.randomUUID(); setDirty(false); setDraft(emptyDraft); setReason('');
      choosePatient(created);
      } catch (e) {
        if (e instanceof ApiFailure && e.code === 'SERVICE_UNAVAILABLE') { outbox.setOffline(true); await saveLocal(); } else throw e;
      }
    });
  }
  async function startEdit() {
    if (!patient) return;
    await run(async () => {
      const { patient: p } = await request<{ patient: Detail }>(`${base}/patients/${patient.id}`);
      setEditing(p); setMatches([]);
      setDraft({ fullName: p.fullName, birthDate: p.birthDate ?? '', gender: p.gender ?? '', phone: p.phone ?? '', districtId: p.districtId ?? '',
        mahallaId: p.mahallaId ?? '', address: p.address ?? '', source: p.source ?? '' });
      patientKey.current = crypto.randomUUID(); setStep('form');
    });
  }

  function togglePoint(point: Point) {
    setChosen(old => {
      const next = { ...old };
      if (next[point.id]) delete next[point.id];
      else {
        // Task 017: a new patient gets the doctor's full consultation, a returning patient the cheaper repeat visit.
        const priced = point.services.filter(s => s.kind === 'consultation' && s.priceUzs !== null).sort((x, y) => Number(BigInt(x.priceUzs!) - BigInt(y.priceUzs!)));
        const first = point.kind === 'doctor' ? (patient?.lastVisit ? priced[0] : priced[priced.length - 1]) : undefined;
        next[point.id] = first ? [first.id] : [];
      }
      return next;
    });
    setDirty(true);
  }
  function toggleService(pointId: string, serviceId: string) {
    setChosen(old => ({ ...old, [pointId]: old[pointId]!.includes(serviceId) ? old[pointId]!.filter(s => s !== serviceId) : [...old[pointId]!, serviceId] }));
  }
  const total = options ? Object.entries(chosen).reduce((sum, [pointId, ids]) => sum + ids.reduce((s, id) => {
    const price = options.points.find(p => p.id === pointId)?.services.find(x => x.id === id)?.priceUzs;
    return s + (price ? BigInt(price) : 0n);
  }, 0n), 0n) : 0n;

  const ticketUrl = (visitId: string) => `${base}/visits/${visitId}/tickets`;
  async function printTickets() {
    if (!patient || !Object.keys(chosen).length) { setError(t('registration.choosePoint')); return; }
    const points = Object.entries(chosen).map(([queuePointId, serviceIds]) => ({ queuePointId, serviceIds }));
    const signature = JSON.stringify({ patientId: patient.id, points, admit });
    if (local || outbox.offline) {
      await run(async () => {
        if (!owner || !offlineDeviceId || !options?.day) throw new ApiFailure('SERVICE_UNAVAILABLE');
        const labels = points.map(p => options.points.find(q => q.id === p.queuePointId)!.names);
        let row: OfflineEntry;
        if (local) {
          const { error: _error, ...rest } = local;
          row = { ...rest, ...(local.error ? { id: crypto.randomUUID() } : {}), points, labels };
          await changeEntry(owner, local.id, () => row);
        } else row = await enqueue(owner, offlineDeviceId, { id: visitKey.current?.key ?? crypto.randomUUID(), businessDayId: options.day.id, patientId: patient.id, points, labels });
        setLocal(row); setPrinted(row); setStep('done'); setDirty(false);
        await outbox.refresh(); if (!outbox.offline) await outbox.sync();
      }); return;
    }
    if (visitKey.current?.signature !== signature) visitKey.current = { signature, key: crypto.randomUUID() };
    // Open the print window inside the click so pop-up blockers allow it; it loads the tickets once they exist.
    const printWindow = window.open('about:blank', '_blank');
    await run(async () => {
      try {
        const created = await request<Visit>(`${base}/visits`, { patientId: patient.id, points, type: admit ? 'inpatient' : 'outpatient', idempotencyKey: visitKey.current!.key });
        visitKey.current = null; setVisit(created); setStep('done'); setDirty(false);
        if (printWindow) printWindow.location.href = ticketUrl(created.visitId); else setNotice(t('registration.popupBlocked'));
      } catch (e) {
        printWindow?.close();
        if (e instanceof ApiFailure && e.code === 'SERVICE_UNAVAILABLE' && owner && offlineDeviceId && options?.day) {
          outbox.setOffline(true);
          const row = await enqueue(owner, offlineDeviceId, { id: visitKey.current!.key, businessDayId: options.day.id, patientId: patient.id, points, labels: points.map(p => options.points.find(q => q.id === p.queuePointId)!.names) });
          setLocal(row); setPrinted(row); setStep('done'); setDirty(false);
        } else throw e;
      }
    });
  }

  const card = (p: Patient) => <span className="registration-card-body">
    <strong>{p.fullName}</strong>
    <span>{p.patientNo ? t('registration.patientNo', { no: p.patientNo }) : local?.code}{p.birthDate && ` · ${formatDate(p.birthDate)} · ${t('registration.age', { age: age(p.birthDate) ?? '' })}`}</span>
    {p.phone && <span>{p.phone}</span>}
    {p.lastVisit && <span className="muted">{t('registration.lastVisit', { date: formatDate(p.lastVisit) })}</span>}
  </span>;
  const district = options?.districts.find(d => d.id === draft.districtId);
  const select = (label: Parameters<typeof t>[0], value: string, onChange: (v: string) => void, items: { id: string; label: string }[], name: string) =>
    <label>{t(label)}<select name={name} aria-label={t(label)} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{t('registration.none')}</option>{items.map(i => <option key={i.id} value={i.id}>{i.label}</option>)}</select></label>;

  return <section className="registration" aria-busy={busy}>
    <div className="registration-head">
      <h2>{t('registration.title')}</h2>
    </div>
    {outbox.offline && <p className="registration-banner" role="status">{t(owner ? 'registration.offline.banner' : 'registration.offline.enroll')}</p>}
    {owner && <OfflineStatus {...outbox} owner={owner} base={base} request={request} locale={locale} t={t} onRoute={async row => {
      await loadOptions(); setLocal(row);
      choosePatient({ id: row.patientId ?? row.id, patientNo: 0, fullName: row.patient?.fullName ?? row.code, birthDate: row.patient?.birthDate ?? null, gender: null, phone: null });
    }} onResume={row => {
      setLocal(row); choosePatient({ id: row.id, patientNo: 0, fullName: row.patient!.fullName, birthDate: row.patient!.birthDate, gender: null, phone: row.patient!.phone });
    }} />}
    <div aria-live="polite">
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="notice">{notice}</p>}
      {busy && <p role="status">{t('registration.loading')}</p>}
    </div>
    {options && !options.day && <p className="registration-banner" role="note">{t('registration.noDay')}</p>}

    {step === 'find' && <>
      <form className="registration-search" onSubmit={find} role="search">
        <label>{t('registration.search')}<input type="search" value={query} autoFocus maxLength={100} onChange={e => setQuery(e.target.value)} /></label>
        <button type="submit" disabled={busy || outbox.offline || !query.trim()}>{t('registration.find')}</button>
      </form>
      {results && !results.length && <p className="empty">{t('registration.notFound')}</p>}
      {results && results.length > 0 && <ul className="registration-results">{results.map(p =>
        <li key={p.id}><button type="button" className="registration-card" onClick={() => choosePatient(p)}>{card(p)}</button></li>)}</ul>}
      <button type="button" className="primary" onClick={() => { setDraft(emptyDraft); setEditing(null); setStep('form'); }}>{t('registration.new')}</button>
    </>}

    {step === 'form' && <form className="registration-form" onSubmit={e => save(e)}>
      <fieldset disabled={busy}>
        <label>{t('registration.fullName')}<input name="fullName" required maxLength={200} autoComplete="off" value={draft.fullName} onChange={e => edit({ fullName: e.target.value })} /></label>
        <label>{t('registration.birthDate')}<input name="birthDate" type="date" required min="1900-01-01" max={new Date().toISOString().slice(0, 10)} value={draft.birthDate} onChange={e => edit({ birthDate: e.target.value })} /></label>
        <fieldset className="registration-gender"><legend>{t('registration.gender')}</legend>
          {(['male', 'female'] as const).map(g => <label key={g} className="choice"><input type="radio" name="gender" required value={g} checked={draft.gender === g} onChange={() => edit({ gender: g })} />{t(`registration.${g}`)}</label>)}
        </fieldset>
        <label>{t('registration.phone')}<input name="phone" type="tel" inputMode="tel" autoComplete="off" value={draft.phone} onChange={e => edit({ phone: phoneDigits(e.target.value) })} /></label>
        <div className="registration-keypad" role="group" aria-label={t('registration.keypad')}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '+', '0'].map(d => <button key={d} type="button" onClick={() => edit({ phone: phoneDigits(draft.phone + d) })}>{d}</button>)}
          <button type="button" aria-label={t('registration.backspace')} onClick={() => edit({ phone: draft.phone.slice(0, -1) })}>⌫</button>
          <button type="button" className="wide" onClick={() => edit({ phone: '' })}>{t('registration.clearPhone')}</button>
        </div>
        {select('registration.district', draft.districtId, v => edit({ districtId: v, mahallaId: '' }), (options?.districts ?? []).map(d => ({ id: d.id, label: pickName(d.names, locale) })), 'district')}
        {select('registration.mahalla', draft.mahallaId, v => edit({ mahallaId: v }), (district?.mahallas ?? []).map(m => ({ id: m.id, label: pickName(m.names, locale) })), 'mahalla')}
        <label>{t('registration.address')}<input name="address" maxLength={500} value={draft.address} onChange={e => edit({ address: e.target.value })} /></label>
        {select('registration.source', draft.source, v => edit({ source: v }), (options?.sources ?? []).map(s => ({ id: s, label: t(`registration.source.${s}` as Parameters<typeof t>[0]) })), 'source')}
      </fieldset>
      {matches.length > 0 && <div className="registration-duplicates" role="alertdialog" aria-labelledby="registration-duplicate-title">
        <h3 id="registration-duplicate-title">{t('registration.duplicateTitle')}</h3>
        <p>{t('registration.duplicateLead')}</p>
        <ul className="registration-results">{matches.map(p => <li key={p.id}>
          <div className="registration-card">{card(p)}</div>
          <button type="button" onClick={() => { setDirty(false); choosePatient(p); }}>{t('registration.useExisting')}</button></li>)}</ul>
        <label>{t('registration.duplicateReason')}<input value={reason} maxLength={500} onChange={e => setReason(e.target.value)} /></label>
        <button type="button" disabled={busy || !reason.trim()} onClick={e => save(e, true)}>{t('registration.registerAnyway')}</button>
      </div>}
      {!matches.length && <button type="submit" className="primary" disabled={busy}>{t('registration.save')}</button>}
      <button type="button" onClick={() => { setDirty(false); setMatches([]); if (editing && patient) { setEditing(null); setStep('route'); } else setStep('find'); }}>{t('registration.back')}</button>
    </form>}

    {step === 'route' && patient && options && <div className="registration-route">
      <div className="registration-card selected">{card(patient)}</div>
      <details className="registration-more"><summary>{t('registration.more')}</summary>
        <button type="button" onClick={startEdit} disabled={busy || outbox.offline || !!local}>{t('registration.edit')}</button>
        <button type="button" onClick={reset}>{t('registration.back')}</button>
      </details>
      <div className="registration-choose">
      <h3>{t('registration.whoSees')}</h3>
      <ul className="registration-points">{options.points.map(point => {
        const on = !!chosen[point.id];
        return <li key={point.id} className={on ? 'on' : ''}>
          <label className="registration-point"><input type="checkbox" checked={on} onChange={() => togglePoint(point)} />
            <span><strong>{pickName(point.names, locale)}</strong><span className="muted">{t('registration.waiting', { count: point.waiting })}</span></span></label>
          {on && (point.services.length ? <ul className="registration-services">{point.services.map(s => <li key={s.id}>
            <label className="choice"><input type="checkbox" disabled={s.priceUzs === null} checked={chosen[point.id]!.includes(s.id)} onChange={() => toggleService(point.id, s.id)} />
              <span>{pickName(s.names, locale)}</span><span className="price">{s.priceUzs === null ? t('registration.noPrice') : formatUzs(uzs(s.priceUzs))}</span></label></li>)}</ul>
            : <p className="muted">{t('registration.noServices')}</p>)}
        </li>;
      })}</ul>
      </div>
      <div className="registration-summary">
      {!outbox.offline && <label className="registration-admit"><input type="checkbox" checked={admit} onChange={e => { setAdmit(e.target.checked); setDirty(true); }} />{t('registration.admit')}</label>}
      <p className="registration-total">{t('registration.total', { amount: formatUzs(uzs(total)) })}</p>
      <button type="button" className="primary" disabled={busy || !options.day || !Object.keys(chosen).length} onClick={printTickets}>{t('registration.print')}</button>
      </div>
    </div>}

    {step === 'done' && printed && <div className="registration-done"><h3>{t('registration.offline.saved')}</h3><p>{printed.code}</p><p>{t('registration.offline.provisional')}</p>
      <LocalTickets entry={printed} locale={locale} clinicName={clinic.name} t={t} /><button onClick={() => window.print()}>{t('registration.print')}</button>
      <button className="primary" onClick={reset}>{t('registration.nextPatient')}</button></div>}
    {step === 'done' && visit && <div className="registration-done">
      <h3>{t('registration.done')}</h3>
      <ul className="registration-tickets">{visit.tickets.map(ticket => <li key={ticket.id}>
        {t('registration.ticket', { point: pickName(ticket.names, locale), number: ticket.number })}</li>)}</ul>
      <a className="button" href={ticketUrl(visit.visitId)} target="_blank" rel="noopener">{t('registration.printAgain')}</a>
      <button type="button" className="primary" onClick={reset}>{t('registration.nextPatient')}</button>
    </div>}
  </section>;
}

export const registrationModule: WebModule = { id: 'registration', roles: ['registrar', 'administrator'], label: 'module.registration', Screen: Registration };
