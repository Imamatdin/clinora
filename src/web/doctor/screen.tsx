import { useEffect, useRef, useState, type FormEvent, type MutableRefObject } from 'react';
import { flushSync } from 'react-dom';
import { AbrField, Ticket as TicketToken } from '../abr.js';
import { Icon } from '../shell.js';
import { ApiFailure, type Request } from '../api.js';
import { errorText, useLocale } from '../i18n/index.js';
import type { ModuleProps, WebModule } from '../modules.js';
import { money, translator, type DoctorKey } from './i18n.js';
import { VISIT_PANELS } from './panels.js';

/** Task 007's queue API ticket (src/modules/registration: queue/mine, queue/call-next, queue/tickets/:id/status). */
type Ticket = { id: string; number: number; status: string; queuePointId: string; visitId: string; createdAt?: string; patient: { id: string; patientNo: number | null; fullName: string; birthDate?: string | null } };
type Rx = { medicine: string; dose: string; frequency: string; duration: string; notes: string };
type Note = { reported: string; observed: string; assessment: string; plan: string };
type Approval = { id: string; versionId: string; revision: number; approvedAt: string; current: boolean };
type Visit = {
  encounter: { id: string; patientId: string; visitId: string | null; specialty: string; location: string };
  visitOpen: boolean; ticket: { id: string; number: number; status: string } | null;
  revision: number; versionId: string | null; kind: string | null; amendmentReason: string | null;
  note: Note; prescription: Rx[]; otherFields: { key: string; value: unknown }[]; approval: Approval | null;
  charges: { id: string; service: string; kind: string; status: string; quantity: number; unitPriceUzs: string; resultVersion: number | null; mine: boolean }[];
};
type Card = {
  patient: { id: string; name: string; patientNo: number | null; birthDate: string | null };
  visits: { encounterId: string; at: string; specialty: string; doctor: string; approved: boolean; diagnosis: string | null }[];
  labs: { id: string; service: string; status: string; orderedAt: string; result: null | { version: number; values: { name: string; value: string; unit: string; reference: string }[]; comment: string | null } }[];
};
type CatalogItem = { id: string; name: string; kind: string; priceUzs: string };
type T = (key: DoctorKey, vars?: Record<string, string | number>) => string;
const NOTE_KEYS = ['reported', 'observed', 'assessment', 'plan'] as const;
const RX_KEYS = ['medicine', 'dose', 'frequency', 'duration', 'notes'] as const;
const emptyRx = (): Rx => ({ medicine: '', dose: '', frequency: '', duration: '', notes: '' });
const day = (iso: string) => iso.slice(0, 10).split('-').reverse().join('.');
function age(birthDate: string | null | undefined): number | null {
  if (!birthDate) return null;
  const [y, m, d] = birthDate.slice(0, 10).split('-').map(Number), now = new Date();
  return now.getFullYear() - y! - (now.getMonth() + 1 < m! || (now.getMonth() + 1 === m && now.getDate() < d!) ? 1 : 0);
}
const minutesSince = (iso: string | undefined) => iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)) : null;
const bedOnly = (bed: string | null) => bed?.split(' · ').pop() ?? '—';
/** The one signature motion (docs/DESIGN.md): when the person at the head of the queue changes, their row moves into the hero. */
function withMotion(change: () => void) {
  const start = (document as Document & { startViewTransition?: (fn: () => void) => unknown }).startViewTransition;
  if (start && !matchMedia('(prefers-reduced-motion: reduce)').matches) start.call(document, () => flushSync(change)); else change();
}

/** Idempotency keys stay the same while one action with the same payload is retried, and change after it succeeds. */
function useKeys() {
  const keys = useRef(new Map<string, string>());
  return {
    key: (scope: string) => { let k = keys.current.get(scope); if (!k) { k = crypto.randomUUID(); keys.current.set(scope, k); } return k; },
    done: (scope: string) => { keys.current.delete(scope); }
  };
}

function DoctorHome({ clinic, request, day: businessDay, setDirty }: ModuleProps) {
  const t = translator(useLocale());
  const [queue, setQueue] = useState<Ticket[] | null>(null), [open, setOpen] = useState<{ encounterId: string; patientId: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const keys = useKeys(), base = `/api/clinics/${clinic.id}/doctor`, queueBase = `/api/clinics/${clinic.id}/queue`;
  /** Set by the open visit: asks save, discard or stay before leaving with unsaved notes (task 019). */
  const leaveRef = useRef<LeaveGuard | null>(null);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(errorText(e instanceof ApiFailure ? e.code : 'SERVICE_UNAVAILABLE')); } finally { setBusy(false); }
  };
  const [ward, setWard] = useState<{ admissionId: string; name: string; patientNo: number | null; bed: string | null }[]>([]);
  // Task 017: admitted patients of this doctor (ward rounds) open the same visit screen, without a queue ticket.
  const head = (list: Ticket[] | null) => (list ?? []).find(x => x.status === 'called' || x.status === 'in_progress')?.id ?? (list ?? []).find(x => x.status === 'waiting')?.id ?? '';
  const showQueue = (next: Ticket[]) => { if (queue && head(queue) !== head(next)) withMotion(() => setQueue(next)); else setQueue(next); };
  const load = () => Promise.all([request<Ticket[]>(`${queueBase}/mine`).then(showQueue), request<typeof ward>(`${base}/inpatients`).then(setWard).catch(() => setWard([]))]).then(() => undefined);
  useEffect(() => { load().catch(() => setError(errorText('SERVICE_UNAVAILABLE'))); }, [clinic.id]);
  useEffect(() => {
    if (open) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load().catch(() => {}); }, 30000);
    return () => clearInterval(timer);
  }, [clinic.id, open]);
  const post = async <R,>(path: string, body: Record<string, unknown> = {}) => {
    const scope = path + JSON.stringify(body);
    const result = await request<R>(path, { ...body, idempotencyKey: keys.key(scope) });
    keys.done(scope); return result;
  };
  const callNext = () => run(async () => {
    const r = await post<{ ticket: Ticket | null; alreadyActive: boolean }>(`${queueBase}/call-next`);
    if (!r.ticket) setNotice(t(r.alreadyActive ? 'doctor.activeUnavailable' : 'doctor.noneWaiting'));
    await load();
  });
  const start = (ticket: Ticket) => run(async () => {
    const r = await post<{ encounterId: string; patientId: string }>(`${base}/tickets/${ticket.id}/start`);
    setOpen({ encounterId: r.encounterId, patientId: r.patientId }); await load();
  });
  const openStay = (admissionId: string) => run(async () => {
    const r = await post<{ encounterId: string; patientId: string }>(`${base}/admissions/${admissionId}/open`);
    setOpen({ encounterId: r.encounterId, patientId: r.patientId });
  });
  const requeue = (ticket: Ticket) => run(async () => { await post(`${queueBase}/tickets/${ticket.id}/status`, { status: 'waiting' }); await load(); });

  const banners = <div aria-live="polite">{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}</div>;

  if (open) return <section className="dr screen">
    <div className="dr-head"><button className="quiet back" disabled={busy} onClick={() => {
      const leave = () => { setDirty(false); setOpen(null); void load(); };
      if (leaveRef.current) leaveRef.current(leave); else leave();
    }}><Icon name="back" />{t('doctor.back')}</button></div>
    {banners}
    <VisitScreen key={open.encounterId} t={t} clinicId={clinic.id} base={base} request={request} encounterId={open.encounterId} patientId={open.patientId} setDirty={setDirty} leaveRef={leaveRef} />
  </section>;

  const tickets = queue ?? [], active = tickets.find(x => x.status === 'called' || x.status === 'in_progress');
  const waiting = tickets.filter(x => x.status === 'waiting'), done = tickets.filter(x => x.status === 'completed');
  const focus = active ?? waiting[0], rest = active ? waiting : waiting.slice(1);
  const meta = (x: Ticket, long = false) => { const a = age(x.patient.birthDate), m = x.status === 'waiting' ? minutesSince(x.createdAt) : null;
    const wait = m === null ? '' : m >= 60 ? t('doctor.hours', { h: Math.floor(m / 60), min: m % 60 }) : t('doctor.min', { min: m });
    return [a !== null ? t('doctor.age', { age: a }) : '', wait && (long ? t('doctor.waitingFor', { wait }) : wait)].filter(Boolean); };
  return <section className="dr screen">
    {banners}
    {!queue ? <p role="status">{t('doctor.loading')}</p> : !businessDay?.openDay && !tickets.length && !ward.length ? <p className="empty">{t('doctor.noDay')}</p> : <>
      <div className="hero dr-current" role="group" aria-label={t(active ? 'doctor.current' : 'doctor.next')}>
        <AbrField />
        {focus ? <div className="hero-in" style={{ viewTransitionName: `q-${focus.id}` }}>
          <p className="hero-label dr-lab"><TicketToken kind="big">{focus.number}</TicketToken><span>{active ? t(`doctor.status.${active.status}` as DoctorKey) : t('doctor.next')}</span></p>
          <h2 className="hero-name">{focus.patient.fullName}</h2>
          {meta(focus, true).length > 0 && <p className="muted">{meta(focus, true).join(' · ')}</p>}
          {active ? <div className="dr-actions">
            <button className="primary big" disabled={busy} onClick={() => void start(active)}>{active.status === 'in_progress' ? t('doctor.open') : t('doctor.start')}<Icon name="arrow" /></button>
            {active.status === 'called' && <button className="quiet" disabled={busy} onClick={() => void requeue(active)}>{t('doctor.requeue')}</button>}
          </div> : <button className="primary big" disabled={busy} onClick={() => void callNext()}>{t('doctor.callNext')}<Icon name="arrow" /></button>}
        </div> : <div className="hero-in"><h2 className="hero-name">{t(done.length ? 'doctor.wellDone' : 'doctor.queueEmpty')}</h2>
          {done.length > 0 && <p className="muted">{t('doctor.queueEmpty')}</p>}</div>}
      </div>
      {rest.length > 0 && <><h3 className="section-label">{t('doctor.waitingList')} · <b>{rest.length}</b></h3><ul className="rows dr-list">{rest.map(x =>
        <li key={x.id} style={{ viewTransitionName: `q-${x.id}` }}><div className="row"><TicketToken>{x.number}</TicketToken><span className="row-title row-body">{x.patient.fullName}</span><span className="row-end">{meta(x).join(' · ')}</span></div></li>)}</ul></>}
      {ward.length > 0 && <><h3 className="section-label">{t('doctor.inpatients')} · <b>{ward.length}</b></h3><ul className="rows dr-list">{ward.map(a =>
        <li key={a.admissionId}><button className="row" disabled={busy} aria-label={`${t('doctor.openNote')}: ${a.name}`} onClick={() => void openStay(a.admissionId)}>
          <TicketToken kind="wide">{bedOnly(a.bed)}</TicketToken><span className="row-title row-body">{a.name}</span><span className="chev" aria-hidden="true" /></button></li>)}</ul></>}
      {done.length > 0 && <><h3 className="section-label">{t('doctor.doneList')} · <b>{done.length}</b></h3><ul className="rows dr-list">{done.map(x =>
        <li key={x.id}><button className="row" disabled={busy} aria-label={`${t('doctor.open')}: ${x.patient.fullName}`} onClick={() => void start(x)}>
          <TicketToken kind="done">{x.number}</TicketToken><span className="row-title row-body">{x.patient.fullName}</span><span className="chev" aria-hidden="true" /></button></li>)}</ul></>}
    </>}
  </section>;
}

function PatientCard({ t, card }: { t: T; card: Card }) {
  const p = card.patient;
  return <aside className="dr-card dr-patient">
    <h3>{p.name}</h3>
    <p className="fine">{p.patientNo ? t('doctor.patientNo', { number: p.patientNo }) + ' · ' : ''}{t('doctor.birthDate', { date: p.birthDate ? day(p.birthDate) : t('doctor.unknown') })}</p>
    <h4>{t('doctor.labResults')}</h4>
    {!card.labs.length ? <p className="fine">{t('doctor.noLabs')}</p> : <ul className="dr-labs">{card.labs.map(l => <li key={l.id}>
      <strong>{l.service}</strong> <span className="fine">{day(l.orderedAt)}</span>
      {!l.result ? <p className="fine">{t('doctor.awaitingResult')}</p> : <><table><tbody>{l.result.values.map((v, i) =>
        <tr key={i}><td>{v.name}</td><td><strong>{v.value}</strong> {v.unit}</td><td className="fine">{v.reference}</td></tr>)}</tbody></table>
        {l.result.comment && <p className="fine">{l.result.comment}</p>}</>}
    </li>)}</ul>}
    <h4>{t('doctor.history')}</h4>
    {!card.visits.length ? <p className="fine">{t('doctor.noHistory')}</p> : <ul className="dr-history">{card.visits.map(v => <li key={v.encounterId}>
      <span>{day(v.at)} · {v.specialty} · {v.doctor}</span>
      <span className={v.approved ? 'tag ok' : 'tag'}>{v.approved ? t('doctor.approvedShort') : t('doctor.draftShort')}</span>
      <span>{v.diagnosis ?? t('doctor.noDiagnosis')}</span>
    </li>)}</ul>}
  </aside>;
}

type LeaveGuard = (leave: () => void) => void;
function VisitScreen({ t, clinicId, base, request, encounterId, patientId, setDirty, leaveRef }: { t: T; clinicId: string; base: string; request: Request; encounterId: string; patientId: string;
  setDirty: (d: boolean) => void; leaveRef: MutableRefObject<LeaveGuard | null> }) {
  const [visit, setVisit] = useState<Visit | null>(null), [card, setCard] = useState<Card | null>(null), [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [note, setNote] = useState<Note>({ reported: '', observed: '', assessment: '', plan: '' }), [rx, setRx] = useState<Rx[]>([]), [reason, setReason] = useState('');
  const [dirty, setLocalDirty] = useState(false), [service, setService] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const keys = useKeys(), enc = `${base}/encounters/${encounterId}`;
  const markDirty = (d: boolean) => { setLocalDirty(d); setDirty(d); };
  const [leaving, setLeaving] = useState<(() => void) | null>(null), form = useRef<HTMLFormElement>(null);
  // Back goes through this guard: unsaved notes ask save, discard or stay; nothing unsaved leaves at once.
  leaveRef.current = leave => { if (dirty) setLeaving(() => leave); else leave(); };
  useEffect(() => () => { leaveRef.current = null; }, []);
  async function reload(resetEditor = true) {
    const [v, c] = await Promise.all([request<Visit>(enc), request<Card>(`${base}/patients/${patientId}`)]);
    setVisit(v); setCard(c);
    if (resetEditor) { setNote(v.note); setRx(v.prescription); setReason(''); markDirty(false); }
  }
  useEffect(() => {
    reload().catch(e => setError(errorText(e instanceof ApiFailure ? e.code : 'SERVICE_UNAVAILABLE')));
    request<CatalogItem[]>(`${base}/catalog`).then(items => { setCatalog(items); setService(items[0]?.id ?? ''); }).catch(() => {});
  }, [encounterId]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(errorText(e instanceof ApiFailure ? e.code : 'SERVICE_UNAVAILABLE')); } finally { setBusy(false); }
  };
  const post = async <R,>(path: string, body: Record<string, unknown>) => {
    const scope = path + JSON.stringify(body);
    const result = await request<R>(`${enc}${path}`, { ...body, idempotencyKey: keys.key(scope) });
    keys.done(scope); return result;
  };
  if (!visit || !card) return error ? <p role="alert" className="error">{error}</p> : <p>{t('doctor.loading')}</p>;

  const approvedNow = !!visit.approval?.current, amending = !!visit.approval && !approvedNow;
  const saveNote = async (): Promise<boolean> => { let saved = false; await run(async () => {
    const prescription = rx.filter(l => RX_KEYS.some(k => l[k].trim()));
    const r = await post<{ revision: number }>('/note', { expectedRevision: visit.revision, note, prescription, ...(reason.trim() ? { amendmentReason: reason.trim() } : {}) });
    await reload(); setNotice(t('doctor.saved', { revision: r.revision })); saved = true;
  }); return saved; };
  const save = (e: FormEvent) => { e.preventDefault(); void saveNote(); };
  const stay = () => { setLeaving(null); requestAnimationFrame(() => document.getElementById('dr-note-reported')?.focus()); };
  const saveAndLeave = async () => {
    const leave = leaving; setLeaving(null);
    if (!form.current?.reportValidity()) return; // Incomplete prescription lines: stay, the browser points at the field.
    if (await saveNote()) leave?.();
  };
  const approve = () => { if (confirm(t('doctor.approveConfirm'))) void run(async () => {
    const r = await post<{ revision: number }>('/approve', { expectedRevision: visit.revision });
    await reload(); setNotice(t('doctor.approvedNotice', { revision: r.revision }));
  }); };
  const cancelOrder = (lineId: string) => { const reason = prompt(t('doctor.cancelReason'))?.trim(); if (reason) void run(async () => {
    await request(`/api/clinics/${clinicId}/charges/${lineId}/cancel`, { idempotencyKey: crypto.randomUUID(), reason }); await reload(false); }); };
  const order = () => void run(async () => { await post('/orders', { items: [{ serviceId: service, quantity: 1 }] }); await reload(false); setNotice(t('doctor.ordered')); });
  const complete = () => { if (visit.ticket && confirm(t('doctor.completeConfirm'))) void run(async () => {
    const scope = `complete:${visit.ticket!.id}`;
    await request(`${base}/tickets/${visit.ticket!.id}/complete`, { idempotencyKey: keys.key(scope) }); keys.done(scope);
    await reload(false); setNotice(t('doctor.completed'));
  }); };
  const setLine = (i: number, k: keyof Rx, value: string) => { setRx(old => old.map((l, j) => j === i ? { ...l, [k]: value } : l)); markDirty(true); };

  return <div className="dr-visit">
    {leaving && <div className="modal-backdrop"><section role="alertdialog" aria-modal="true" aria-labelledby="dr-leave-title" aria-describedby="dr-leave-lead" className="modal" onKeyDown={e => {
      const buttons = e.currentTarget.querySelectorAll('button');
      if (e.key === 'Escape') stay();
      if (e.key === 'Tab' && ((e.shiftKey && document.activeElement === buttons[0]) || (!e.shiftKey && document.activeElement === buttons[buttons.length - 1]))) { e.preventDefault(); (e.shiftKey ? buttons[buttons.length - 1] : buttons[0])?.focus(); }
    }}><h2 id="dr-leave-title">{t('doctor.leaveTitle')}</h2><p id="dr-leave-lead">{t('doctor.leaveLead')}</p>
      <button className="primary" disabled={busy || (approvedNow && !reason.trim())} onClick={() => void saveAndLeave()}>{t('doctor.leaveSave')}</button>
      <button onClick={() => { const leave = leaving; setLeaving(null); markDirty(false); leave(); }}>{t('doctor.leaveDiscard')}</button>
      <button autoFocus onClick={stay}>{t('doctor.leaveStay')}</button></section></div>}
    <div aria-live="polite">{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}</div>
    <PatientCard t={t} card={card} />
    <div className="dr-main">
      <section className="dr-card">
        <div className="dr-head"><h3>{t('doctor.note')}</h3>
          <span className={approvedNow ? 'tag ok' : 'tag'}>{approvedNow ? t('doctor.approvedTag', { revision: visit.approval!.revision })
            : amending ? t('doctor.amendingTag', { revision: visit.approval!.revision }) : t('doctor.draftTag')}</span></div>
        <p className="fine">{visit.encounter.specialty} · {visit.encounter.location}</p>
        <form ref={form} onSubmit={save}>
          {NOTE_KEYS.map(k => <label key={k}>{t(`doctor.field.${k}` as DoctorKey)}
            <textarea id={`dr-note-${k}`} value={note[k]} rows={k === 'reported' ? 3 : 2} maxLength={16000} disabled={busy} placeholder={t('doctor.notRecorded')}
              onChange={e => { const value = e.target.value; setNote(old => ({ ...old, [k]: value })); markDirty(true); }} /></label>)}
          <fieldset className="dr-rx"><legend>{t('doctor.prescription')}</legend>
            {!rx.length && <p className="fine">{t('doctor.rx.none')}</p>}
            {rx.map((line, i) => <fieldset key={i} className="dr-rx-line"><legend>{t('doctor.rx.line', { n: i + 1 })}</legend>
              {RX_KEYS.map(k => <label key={k}>{t(`doctor.rx.${k}` as DoctorKey)}<input value={line[k]} maxLength={k === 'notes' ? 500 : k === 'medicine' ? 200 : 100}
                required={k !== 'notes'} disabled={busy} onChange={e => setLine(i, k, e.target.value)} /></label>)}
              <button type="button" className="quiet" disabled={busy} onClick={() => { setRx(old => old.filter((_, j) => j !== i)); markDirty(true); }}>{t('doctor.rx.remove')}</button>
            </fieldset>)}
            <button type="button" disabled={busy || rx.length >= 30} onClick={() => { setRx(old => [...old, emptyRx()]); markDirty(true); }}>{t('doctor.rx.add')}</button>
          </fieldset>
          {(approvedNow || amending) && <label>{t('doctor.amendReason')}<input value={reason} maxLength={500} required={approvedNow} disabled={busy}
            placeholder={amending ? visit.amendmentReason ?? '' : ''} onChange={e => { setReason(e.target.value); markDirty(true); }} />
            {approvedNow && <span className="fine">{t('doctor.amendHint')}</span>}</label>}
          {visit.otherFields.length > 0 && <details><summary>{t('doctor.otherFields')}</summary><dl>{visit.otherFields.map(f =>
            <div key={f.key}><dt>{f.key}</dt><dd>{f.value === null ? t('doctor.notRecorded') : String(f.value)}</dd></div>)}</dl></details>}
          <div className="dr-actions">
            <p role="status" className="fine">{busy ? t('doctor.saving') : dirty ? t('doctor.unsaved') : visit.revision ? t('doctor.saved', { revision: visit.revision }) : t('doctor.emptyNote')}</p>
            <button className="primary" disabled={busy || !dirty || (approvedNow && !reason.trim())}>{t('doctor.save')}</button>
            {!approvedNow && <button type="button" className="primary big" disabled={busy || dirty || !visit.revision} onClick={approve}>{t('doctor.approve')}</button>}
          </div>
          {dirty && !approvedNow && <p className="fine">{t('doctor.saveFirst')}</p>}
        </form>
        {visit.approval && <p><a className="button" href={`${enc}/prescription.pdf`} target="_blank" rel="noopener">{t('doctor.pdf')}</a> <span className="fine">{t('doctor.pdfHint')}</span></p>}
      </section>
      {VISIT_PANELS.map(({ id, Panel }) => <Panel key={id} clinicId={clinicId} patientId={visit.encounter.patientId} encounterId={encounterId} request={request}
        onChanged={() => { reload().catch(() => {}); }} />)}
      <section className="dr-card">
        <h3>{t('doctor.orders')}</h3>
        {!visit.visitOpen ? <p className="fine">{t('doctor.visitClosed')}</p> : !catalog.length ? <p className="fine">{t('doctor.noCatalog')}</p> :
          <div className="dr-actions"><label>{t('doctor.service')}<select aria-label={t('doctor.service')} value={service} disabled={busy} onChange={e => setService(e.target.value)}>
            {catalog.map(s => <option key={s.id} value={s.id}>{s.name} · {t('doctor.price', { amount: money(s.priceUzs) })}</option>)}</select></label>
            <button disabled={busy || !service} onClick={order}>{t('doctor.order')}</button></div>}
        <h4>{t('doctor.charges')}</h4>
        {!visit.charges.length ? <p className="fine">{t('doctor.noCharges')}</p> : <ul className="dr-list">{visit.charges.map(l => <li key={l.id}>
          <span>{l.service}</span><span className="fine">{t('doctor.price', { amount: money(l.unitPriceUzs) })}</span>
          <span className={l.status === 'completed' ? 'tag ok' : 'tag'}>{t(`doctor.charge.${l.status}` as DoctorKey)}</span>
          {l.resultVersion && <span className="tag ok">{t('doctor.resultReady', { version: l.resultVersion })}</span>}
          {/* Task 023: a doctor can cancel an order they placed that was not performed (an unpaid line; the server checks). */}
          {l.mine && l.status === 'ordered' && visit.visitOpen && <button disabled={busy} onClick={() => cancelOrder(l.id)}>{t('doctor.cancelOrder')}</button>}</li>)}</ul>}
        {visit.ticket && visit.ticket.status !== 'completed' && <button className="primary big" disabled={busy} onClick={complete}>{t('doctor.complete')}</button>}
      </section>
    </div>
  </div>;
}

export const doctorModule: WebModule = { id: 'doctor', roles: ['doctor'], label: 'module.myQueue', Screen: DoctorHome };
