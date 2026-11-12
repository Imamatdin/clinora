import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Note, PatientView, VisitView } from '../contracts/notebook.js';
import { sortVisits } from '../contracts/timeline.js';
import { ApiFailure, type Request } from './api.js';
import { errorText, t, type UiKey } from './i18n/index.js';

/** The task-002 clinical notebook, now the doctor's visit notes inside the clinic shell. */
export type NotebookClinic = { id: string; isOwner: boolean; clinicalAccess: boolean };
const empty: Note = { reported: '', observed: '', assessment: '', plan: '' };
const noteFrom = (v: VisitView): Note => Object.fromEntries(Object.keys(empty).map(k => [k, String(v.version?.fields.find(f => f.key === k)?.value ?? '')])) as Note;
const fieldLabel = (key: keyof Note) => t(`notebook.field.${key}` as UiKey);
function visitDate(v: VisitView) {
  const o = v.encounter.occurrence;
  if (o.precision === 'unknown') return t('notebook.dateUnknown', { reason: o.reason });
  if (o.precision === 'date') return t('notebook.dateOnly', { date: o.date, timezone: o.timezone });
  return `${new Intl.DateTimeFormat('uz-Cyrl', { dateStyle: 'medium', timeStyle: 'short', timeZone: o.timezone }).format(new Date(o.at))} · ${o.timezone}`;
}

export function Notebook({ clinic, request, dirty, setDirty, guard, visitExtra }: {
  clinic: NotebookClinic; request: Request; dirty: boolean; setDirty: (d: boolean) => void; guard: (action: () => void) => void;
  /** Task 003C: the doctor assistant panel for the open encounter. */
  visitExtra?: (patientId: string, encounterId: string, refresh: () => void) => ReactNode
}) {
  const [patients, setPatients] = useState<PatientView[]>([]), [search, setSearch] = useState('');
  const [patient, setPatient] = useState<PatientView | null>(null), [visits, setVisits] = useState<VisitView[]>([]), [visit, setVisit] = useState<VisitView | null>(null);
  const [note, setNote] = useState<Note>({ ...empty }), [template, setTemplate] = useState('general-note-v1');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [newPatient, setNewPatient] = useState(false), [newVisit, setNewVisit] = useState(false), [precision, setPrecision] = useState('date');
  const [reason, setReason] = useState('');
  const [conflict, setConflict] = useState(false), [latest, setLatest] = useState<VisitView | null>(null), [inviteLink, setInviteLink] = useState('');
  const base = `/api/clinics/${clinic.id}/patients`;
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) {
      setError(errorText(e instanceof ApiFailure ? e.code : 'SERVICE_UNAVAILABLE'));
      if (e instanceof ApiFailure && e.code === 'STALE_VERSION') setConflict(true);
    } finally { setBusy(false); }
  };
  useEffect(() => {
    setPatients([]); setPatient(null); setVisit(null); setVisits([]); setSearch(''); setInviteLink('');
    if (!clinic.clinicalAccess) return;
    let active = true;
    request<PatientView[]>(base).then(rows => { if (active) setPatients(rows); }).catch(e => { if (active) setError(errorText(e instanceof ApiFailure ? e.code : 'SERVICE_UNAVAILABLE')); });
    return () => { active = false; };
  }, [clinic.id, clinic.clinicalAccess]);
  function openPatient(p: PatientView) {
    guard(() => void run(async () => {
      const d = await request<{ patient: PatientView; visits: VisitView[] }>(`${base}/${p.id}`);
      setPatient(d.patient); setVisits(d.visits); setVisit(null); setDirty(false); setNewPatient(false); setNewVisit(false); setConflict(false); setLatest(null);
    }));
  }
  function openVisit(v: VisitView) {
    guard(() => { setVisit(v); setNote(noteFrom(v)); setReason(''); setTemplate(v.version?.templateId ?? 'general-note-v1'); setDirty(false); setConflict(false); setLatest(null); setNewVisit(false); setNotice(''); setError(''); });
  }
  async function save(e: FormEvent) {
    e.preventDefault(); if (!patient || !visit) return; const current = visit;
    await run(async () => {
      const result = await request<{ revision: number; version: NonNullable<VisitView['version']>; approval: import('../contracts/notebook.js').VisitApproval | null }>(`${base}/${patient.id}/encounters/${current.encounter.id}/draft`,
        { expectedRevision: current.revision, note, templateId: template, ...(reason.trim() ? { amendmentReason: reason.trim() } : {}) }, true);
      const saved = { ...current, ...result }; setVisit(saved); setVisits(old => old.map(v => v.encounter.id === saved.encounter.id ? saved : v));
      setDirty(false); setConflict(false); setLatest(null); setReason(''); setNotice(t('notebook.savedNotice', { revision: result.revision }));
    });
  }
  /** Reload the open visit after another panel (the assistant) approved it, so the timeline shows the approved version. */
  function refreshVisit(encounterId: string) {
    if (!patient) return;
    void request<{ visits: VisitView[] }>(`${base}/${patient.id}`).then(d => {
      setVisits(d.visits); const v = d.visits.find(x => x.encounter.id === encounterId);
      if (v) { setVisit(v); setNote(noteFrom(v)); setReason(''); setDirty(false); }
    }).catch(() => {});
  }
  const tagFor = (v: VisitView) => v.approval?.current ? t('notebook.approvedTag', { revision: v.approval.revision })
    : v.approval ? t('notebook.amendingTag', { revision: v.approval.revision }) : t('notebook.draftTag', { revision: v.revision });
  const assessment = (v: VisitView) => v.version?.fields.find(f => f.key === 'assessment')?.value;
  return <>
    <div className="banners" aria-live="polite">{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}</div>
    <div className="workspace"><aside className="patients">
      <div className="section-heading"><h2>{t('notebook.patients')}</h2>{clinic.clinicalAccess && <button className="small" disabled={busy} onClick={() => guard(() => { setDirty(false); setNewPatient(true); setPatient(null); setVisit(null); })}>{t('notebook.newPatient')}</button>}</div>
      {clinic.clinicalAccess ? <>
        <form className="search" onSubmit={e => { e.preventDefault(); void run(async () => setPatients(await request<PatientView[]>(`${base}?q=${encodeURIComponent(search)}`))); }}>
          <label>{t('notebook.search')}<input value={search} placeholder={t('notebook.searchPlaceholder')} onChange={e => setSearch(e.target.value)} maxLength={200} /></label>
          <button disabled={busy}>{t('notebook.searchButton')}</button>
        </form>
        <p className="fine">{t('notebook.searchHint')}</p>
        <nav aria-label={t('notebook.patients')}>{patients.map(p => <button className={`patient-row ${p.id === patient?.id ? 'selected' : ''}`} key={p.id} disabled={busy} onClick={() => openPatient(p)}><strong>{p.displayName}</strong><span>{p.mrn ?? t('notebook.noMrn')} · {p.dateOfBirth ?? t('notebook.noDob')}</span></button>)}</nav>
        {!patients.length && <p className="empty">{t('notebook.noPatients')}</p>}
      </> : <p className="empty">{t('notebook.noClinical')}</p>}
      {clinic.isOwner && <details className="owner"><summary>{t('notebook.invite')}</summary><p className="fine">{t('notebook.inviteNote')}</p>
        <form onSubmit={e => { e.preventDefault(); const email = new FormData(e.currentTarget).get('email'); void run(async () => { const r = await request<{ link: string }>(`/api/clinics/${clinic.id}/invitations`, { email }); setInviteLink(r.link); }); }}>
          <label>{t('notebook.inviteEmail')}<input name="email" type="email" required /></label><button disabled={busy}>{t('notebook.inviteCreate')}</button>
        </form>
        {inviteLink && <label>{t('notebook.inviteLink')}<textarea readOnly value={inviteLink} /><span className="fine">{t('notebook.inviteLinkNote')}</span></label>}
      </details>}
    </aside><main className="chart">
      {newPatient ? <section className="panel"><p className="eyebrow">{t('notebook.identityEyebrow')}</p><h1>{t('notebook.newPatientTitle')}</h1><p className="muted">{t('notebook.newPatientLead')}</p>
        <form onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void run(async () => { const p = await request<PatientView>(base, { displayName: f.get('displayName'), mrn: f.get('mrn') || null, dateOfBirth: f.get('dateOfBirth') || null }, true); setPatients(old => [p, ...old]); setPatient(p); setVisits([]); setVisit(null); setNewPatient(false); setNotice(t('notebook.patientCreated')); }); }}>
          <label>{t('notebook.patientName')}<input name="displayName" required maxLength={200} /></label>
          <div className="two"><label>{t('notebook.mrn')} <small>{t('notebook.optional')}</small><input name="mrn" maxLength={80} /></label><label>{t('notebook.dob')} <small>{t('notebook.optional')}</small><input name="dateOfBirth" type="date" /></label></div>
          <button disabled={busy} className="primary">{busy ? t('notebook.creating') : t('notebook.createPatient')}</button>
        </form></section> :
      patient ? <><section className="patient-header"><div><p className="eyebrow">{t('notebook.recordEyebrow')}</p><h1>{patient.displayName}</h1><p>{t('notebook.dobLine', { mrn: patient.mrn ?? t('notebook.noMrn'), dob: patient.dateOfBirth ?? t('notebook.unrecorded') })}</p></div><button disabled={busy} onClick={() => guard(() => { setDirty(false); setNewVisit(true); setVisit(null); setError(''); })}>{t('notebook.newEncounter')}</button></section>
        <div className="notebook"><section className="timeline" aria-label={t('notebook.history')}><h2>{t('notebook.history')}</h2><p className="fine">{t('notebook.historyNote')}</p>
          {visits.map(v => <button className={`visit-row ${v.encounter.id === visit?.encounter.id ? 'selected' : ''}`} disabled={busy} key={v.encounter.id} onClick={() => openVisit(v)}><strong>{visitDate(v)}</strong><span>{v.encounter.specialty} · {v.encounter.location.label}</span><span>{v.clinicianName}</span><span className="draft-tag">{tagFor(v)}</span>{assessment(v) && <span className="assessment-preview">{String(assessment(v))}</span>}</button>)}
          {!visits.length && <p className="empty">{t('notebook.noVisits')}</p>}</section>
        <section className="editor">{newVisit ? <><p className="eyebrow">{t('notebook.newConsultation')}</p><h2>{t('notebook.startEncounter')}</h2>
          <form onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); let o: unknown;
            if (precision === 'date') o = { precision, date: f.get('date'), timezone: f.get('timezone') };
            else if (precision === 'instant') { const at = String(f.get('instant')); if (!/([zZ]|[+-]\d\d:\d\d)$/.test(at)) { setError(t('notebook.instantOffset')); return; } o = { precision, at, timezone: f.get('timezone') }; }
            else o = { precision: 'unknown', reason: f.get('reason') };
            void run(async () => { const v = await request<VisitView>(`${base}/${patient.id}/encounters`, { occurrence: o, location: f.get('location'), specialty: f.get('specialty') }, true); setVisits(old => sortVisits([v, ...old])); setVisit(v); setNote({ ...empty }); setTemplate('general-note-v1'); setNewVisit(false); setDirty(false); setNotice(t('notebook.encounterCreated')); }); }}>
            <label>{t('notebook.precision')}<select value={precision} onChange={e => setPrecision(e.target.value)}><option value="date">{t('notebook.precisionDate')}</option><option value="instant">{t('notebook.precisionInstant')}</option><option value="unknown">{t('notebook.precisionUnknown')}</option></select></label>
            {precision === 'date' && <label>{t('notebook.visitDate')}<input type="date" name="date" required /></label>}
            {precision === 'instant' && <label>{t('notebook.visitInstant')}<input name="instant" placeholder="2026-11-11T10:30:00+05:00" required /></label>}
            {precision === 'unknown' ? <label>{t('notebook.unknownReason')}<input name="reason" required maxLength={200} /></label> : <label>{t('notebook.timezone')}<input name="timezone" defaultValue="Asia/Tashkent" required /></label>}
            <label>{t('notebook.location')}<input name="location" required maxLength={200} /></label>
            <label>{t('notebook.specialty')}<input name="specialty" defaultValue={t('notebook.specialtyDefault')} required maxLength={100} /></label>
            <button className="primary" disabled={busy}>{busy ? t('notebook.creating') : t('notebook.createEncounter')}</button>
          </form></> :
        visit ? <><div className="section-heading"><div><p className="eyebrow">{t('notebook.noteEyebrow')}</p><h2>{visitDate(visit)}</h2></div><span className="draft-tag">{visit.approval ? tagFor(visit) : t('notebook.unapproved')}</span></div>
          <p className="fine">{visit.encounter.location.label} · {visit.encounter.specialty} · {visit.clinicianName}</p>
          {visitExtra?.(patient.id, visit.encounter.id, () => refreshVisit(visit.encounter.id))}
          <form onSubmit={save}><label>{t('notebook.template')}<input value={template} required maxLength={100} disabled={busy} onChange={e => { setTemplate(e.target.value); setDirty(true); setNotice(''); }} /></label>
            {(Object.keys(empty) as (keyof Note)[]).map(key => <label key={key}>{fieldLabel(key)}<textarea id={`note-${key}`} aria-label={fieldLabel(key)} value={note[key]} maxLength={16000} rows={key === 'reported' ? 4 : 3} disabled={busy} placeholder={t('notebook.notRecorded')} onChange={e => { const value = e.target.value; setNote(old => ({ ...old, [key]: value })); setDirty(true); setNotice(''); }} /></label>)}
            {visit.approval && <label>{t('notebook.amendReason')}<input value={reason} maxLength={500} required={visit.approval.current} disabled={busy}
              onChange={e => { setReason(e.target.value); setDirty(true); setNotice(''); }} />{visit.approval.current && <span className="fine">{t('notebook.amendHint')}</span>}</label>}
            <div className="savebar"><p role="status">{busy ? t('notebook.saving') : dirty ? t('notebook.unsaved') : visit.revision ? t('notebook.savedRevision', { revision: visit.revision }) : t('notebook.emptyNote')}</p><button className="primary" disabled={busy || (!dirty && visit.revision > 0) || (!!visit.approval?.current && !reason.trim())}>{busy ? t('notebook.saving') : t('notebook.saveDraft')}</button></div>
          </form>
          {conflict && <div className="conflict"><h3>{t('notebook.conflictTitle')}</h3><p>{t('notebook.conflictLead')}</p>
            <button disabled={busy} onClick={() => void run(async () => { const d = await request<{ visits: VisitView[] }>(`${base}/${patient.id}`); const v = d.visits.find(x => x.encounter.id === visit.encounter.id); if (v) setLatest(v); })}>{t('notebook.loadLatest')}</button>
            {latest && <><h4>{t('notebook.latestRevision', { revision: latest.revision })}</h4><pre>{(Object.entries(noteFrom(latest)) as [keyof Note, string][]).map(([k, v]) => `${fieldLabel(k)}: ${v || t('notebook.notRecorded')}`).join('\n\n')}</pre>
              <button disabled={busy} onClick={() => { setVisit(latest); setConflict(false); setLatest(null); setError(''); setDirty(true); setNotice(t('notebook.keptNotice')); }}>{t('notebook.keepMine')}</button>
              <button disabled={busy} onClick={() => { if (confirm(t('notebook.discardConfirm'))) { setDirty(false); setVisit(latest); setNote(noteFrom(latest)); setTemplate(latest.version?.templateId ?? 'general-note-v1'); setConflict(false); setLatest(null); setError(''); } }}>{t('notebook.discardMine')}</button></>}
          </div>}
        </> : <div className="empty editor-empty"><h2>{t('notebook.openVisit')}</h2><p>{t('notebook.openVisitLead')}</p></div>}</section></div></> :
      <section className="empty welcome"><p className="eyebrow">{t('notebook.welcomeEyebrow')}</p><h1>{t('notebook.welcomeTitle')}</h1><p>{t('notebook.welcomeLead')}</p><p className="fine">{t('notebook.welcomeNote')}</p></section>}
    </main></div>
  </>;
}
