import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiFailure, type Request } from '../api.js';
import { errorText, useLocale } from '../i18n/index.js';
import { labKey, translator, type AKey, type ALocale } from './i18n.js';
import './assistant.css';

type FieldView = { key: string; fieldRevision: number; value: unknown; category: string | null; status: string; origin: string | null; evidence: string[];
  held: { proposalId: string; value: unknown; category: string; evidence: string[] } | null };
type Segment = { id: string; speaker: 'doctor' | 'patient' | 'unknown'; text: string };
type Capture = { id: string; status: string; stage: string | null; errorCode: string | null; createdAt: string; durationS?: number | null };
type Draft = { draft: { revision: number; status: string }; documentRevision: number; approval: { approvedBy: string; approvedAt: string; revision: number } | null;
  fields: FieldView[]; segments: Segment[]; captures: Capture[]; transcripts: { simulated: boolean }[];
  providers: { stt: { name: string; simulated: boolean }; extractor: { name: string; simulated: boolean } } };
type Lab = { code: string; uzCyrl: string; uzLatn: string; ru: string };
type Config = { labs: Lab[]; stt: { simulated: boolean; name: string }; extractor: { simulated: boolean; name: string }; telegram: { available: boolean; linked: boolean } };

const CATEGORY_OPTIONS: Record<string, string[]> = {
  complaints: ['reported'], hpi: ['reported'], pastHistory: ['history', 'reported'], examination: ['observed', 'measured', 'not_examined'],
  diagnosis: ['assessment'], plan: ['clinician_instruction'], labOrders: ['clinician_instruction'], followUp: ['clinician_instruction']
};
const newKey = () => crypto.randomUUID().replaceAll('-', '');
async function sha256(data: ArrayBuffer) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(b => b.toString(16).padStart(2, '0')).join(''); }
const pickMime = () => ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'].find(m => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m));
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

type Phase = { kind: 'idle' } | { kind: 'requesting' } | { kind: 'recording'; seconds: number } | { kind: 'uploading'; done: number; total: number }
  | { kind: 'processing'; captureId: string; stage: string | null } | { kind: 'failed'; captureId: string | null; message: string };

/** Assistant panel for the encounter the doctor has open. Every decision is checked again on the server. */
export function AssistantPanel({ clinicId, patientId, encounterId, request, onApproved }: { clinicId: string; patientId: string; encounterId: string; request: Request;
  /** Task 010: lets the host reload its view of the note after an approval. */ onApproved?: () => void }) {
  const locale: ALocale = useLocale();
  const t = translator(locale);
  const root = `/api/clinics/${clinicId}/assistant`, base = `${root}/patients/${patientId}/encounters/${encounterId}`;
  const [config, setConfig] = useState<Config | null>(null), [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState<Capture[]>([]), [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [consent, setConsent] = useState(false);
  const [editing, setEditing] = useState<string | null>(null), [sourceOf, setSourceOf] = useState<string | null>(null);
  const recorder = useRef<{ rec: MediaRecorder; stream: MediaStream; timer: number } | null>(null);
  const alive = useRef(true);
  // Raw audio uploads bypass the JSON client, so the panel fetches the session's CSRF token itself.
  const csrf = useRef('');

  const show = (e: unknown) => { setError(e instanceof ApiFailure ? (e.code === 'STALE_VERSION' ? t('stale') : errorText(e.code)) : errorText('SERVICE_UNAVAILABLE')); };
  const refresh = useCallback(async () => {
    const [d, p] = await Promise.all([request<Draft>(base), request<Capture[]>(`${root}/captures/pending`)]);
    if (alive.current) { setDraft(d); setPending(p); }
  }, [base, root, request]);
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await work(); } catch (e) { show(e); if (e instanceof ApiFailure && e.code === 'STALE_VERSION') await refresh().catch(() => {}); } finally { setBusy(false); } };

  useEffect(() => {
    alive.current = true; setDraft(null); setPhase({ kind: 'idle' }); setEditing(null); setError(''); setNotice('');
    Promise.all([request<Config>(`${root}/config`).then(setConfig), refresh()]).catch(show);
    return () => { alive.current = false; stopTracks(); };
  }, [base]);

  function stopTracks() { const r = recorder.current; if (r) { window.clearInterval(r.timer); r.stream.getTracks().forEach(tr => tr.stop()); recorder.current = null; } }

  async function poll(captureId: string) {
    for (let i = 0; i < 120 && alive.current; i++) {
      const c = await request<Capture>(`${root}/captures/${captureId}`);
      if (c.status === 'done') { await refresh(); setPhase({ kind: 'idle' }); if (c.errorCode === 'EXTRACTION_FAILED') setError(t('extractionFailed')); else setNotice(t('doneNotice')); return; }
      if (c.status === 'failed' || c.status === 'discarded') { await refresh(); setPhase({ kind: 'failed', captureId, message: t('failed', { code: c.errorCode ?? '' }) }); return; }
      setPhase({ kind: 'processing', captureId, stage: c.stage });
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  async function upload(captureId: string, seq: number, blob: Blob) {
    const data = await blob.arrayBuffer(), sum = await sha256(data);
    if (!csrf.current) csrf.current = (await request<{ csrf: string }>('/api/auth/me')).csrf;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(`${root}/captures/${captureId}/chunks/${seq}`, { method: 'POST', body: data, signal: AbortSignal.timeout(30000),
          headers: { 'Content-Type': blob.type.split(';')[0] || 'application/octet-stream', 'X-Chunk-Sha256': sum, 'X-CSRF-Token': csrf.current } });
        if (r.ok) return;
        if (r.status < 500) throw new ApiFailure((await r.json().catch(() => null))?.error?.code ?? 'INVALID_INPUT');
      } catch (e) { if (e instanceof ApiFailure) throw e; }
      await new Promise(res => setTimeout(res, 800 * (attempt + 1)));
    }
    throw new ApiFailure('SERVICE_UNAVAILABLE');
  }

  async function startRecording() {
    setError(''); setNotice('');
    const mime = pickMime();
    if (!navigator.mediaDevices?.getUserMedia || !mime) { setError(t('micUnsupported')); return; }
    setPhase({ kind: 'requesting' });
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { setPhase({ kind: 'idle' }); setError(t('micDenied')); return; }
    let capture: Capture;
    try { capture = await request<Capture>(`${base}/captures`, { clientKey: newKey(), mimeType: mime }); }
    catch (e) { stream.getTracks().forEach(tr => tr.stop()); setPhase({ kind: 'idle' }); show(e); return; }
    const rec = new MediaRecorder(stream, { mimeType: mime });
    // Chunks upload in order while recording; the server acknowledges each one durably.
    let seq = 0, done = 0, chain: Promise<void> = Promise.resolve(), broken = false;
    rec.ondataavailable = ev => {
      if (!ev.data.size) return;
      const n = seq++;
      chain = chain.then(() => broken ? undefined : upload(capture.id, n, ev.data).then(() => { done++; }, () => { broken = true; }));
    };
    rec.onstop = () => void (async () => {
      stopTracks(); setPhase({ kind: 'uploading', done, total: seq });
      await chain;
      if (broken || done !== seq) { setPhase({ kind: 'failed', captureId: capture.id, message: t('uploadFailed') }); return; }
      try { await request(`${root}/captures/${capture.id}/finish`, { chunkCount: seq }); setPhase({ kind: 'processing', captureId: capture.id, stage: 'transcribing' }); await poll(capture.id); }
      catch (e) { setPhase({ kind: 'failed', captureId: capture.id, message: t('uploadFailed') }); show(e); }
    })();
    const started = Date.now();
    const timer = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      setPhase({ kind: 'recording', seconds });
      if (seconds >= 15 * 60 && rec.state === 'recording') rec.stop();
    }, 500);
    recorder.current = { rec, stream, timer };
    stream.getAudioTracks()[0]?.addEventListener('ended', () => { if (rec.state === 'recording') rec.stop(); });
    rec.start(5000);
    setPhase({ kind: 'recording', seconds: 0 });
  }
  const stopRecording = () => { const r = recorder.current; if (r && r.rec.state === 'recording') r.rec.stop(); };

  async function fieldAction(f: FieldView, body: Record<string, unknown>) {
    await run(async () => { await request(`${base}/fields/${f.key}`, { expectedFieldRevision: f.fieldRevision, ...body }); setEditing(null); await refresh(); });
  }
  async function approve() {
    if (!draft || !confirm(t('approveConfirm'))) return;
    await run(async () => {
      try {
        await request(`${base}/approve`, { expectedDraftRevision: draft.draft.revision, expectedDocumentRevision: draft.documentRevision,
          fieldRevisions: Object.fromEntries(draft.fields.map(f => [f.key, f.fieldRevision])) }, true);
      } catch (e) {
        // Task 019: the draft or the visit note (e.g. a manual save in the doctor workspace) changed; nothing was approved.
        if (e instanceof ApiFailure && e.code === 'STALE_VERSION') { await refresh().catch(() => {}); onApproved?.(); setError(t('staleApproval')); return; }
        throw e;
      }
      await refresh(); onApproved?.();
    });
  }

  const labs = config?.labs ?? [];
  const valueText = (key: string, value: unknown, category: string | null) => {
    if (category === 'not_examined') return t('category.not_examined');
    if (value === null || value === undefined) return t('notRecorded');
    if (key === 'labOrders' && Array.isArray(value)) return value.map(code => labs.find(l => l.code === code)?.[labKey(locale)] ?? code).join('; ');
    if (key === 'diagnosis' && typeof value === 'object') { const d = value as { icd10: string; text: string }; return `${d.icd10} — ${d.text}`; }
    return String(value);
  };
  const segmentsFor = (ids: string[]) => (draft?.segments ?? []).filter(s => ids.includes(s.id));
  const simulated = !!(config && (config.stt.simulated || config.extractor.simulated)) || !!draft?.transcripts.some(x => x.simulated);
  const unavailable = config && (config.stt.name === 'unavailable' || config.extractor.name === 'unavailable');
  const open = draft?.draft.status === 'open';
  const unresolved = draft?.fields.filter(f => f.status === 'proposed').length ?? 0;
  const recording = phase.kind === 'recording' || phase.kind === 'requesting';
  const working = phase.kind === 'uploading' || phase.kind === 'processing' || recording;

  return <section className="assistant panel" aria-labelledby="assistant-title" lang={locale}>
    <div className="section-heading"><div><h2 id="assistant-title">{t('title')}</h2><p className="fine">{t('lead')}</p></div></div>
    {simulated && <p className="simulated" role="note">{t('simulatedBanner')}</p>}
    {unavailable && <p className="notice" role="note">{t('unavailableBanner')}</p>}
    <div className="banners" aria-live="polite">{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}</div>
    {!draft ? <p role="status">{t('loading')}</p> : <>
      {open && <div className="capture">
        {phase.kind === 'recording' ? <><p className="rec-indicator" role="status"><span className="rec-dot" aria-hidden="true" />{t('recording', { time: clock(phase.seconds) })}</p>
          <button type="button" className="primary big danger" onClick={stopRecording}>{t('stop')}</button></> :
        phase.kind === 'requesting' ? <p role="status">{t('requesting')}</p> :
        phase.kind === 'uploading' ? <p role="status">{t('uploading', { done: phase.done, total: phase.total })}</p> :
        phase.kind === 'processing' ? <p role="status" className="processing">{phase.stage === 'drafting' ? t('drafting') : t('transcribing')}</p> :
        <>
          <label className="check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />{t('consent')}</label>
          <button type="button" className="primary big" disabled={!consent || busy} onClick={() => void startRecording()}>{t('start')}</button>
          {config?.stt.simulated && <button type="button" disabled={busy} onClick={() => void run(async () => { const c = await request<Capture>(`${base}/simulated-capture`, { clientKey: newKey() }); setPhase({ kind: 'processing', captureId: c.id, stage: 'transcribing' }); await poll(c.id); })}>{t('demoRun')}</button>}
        </>}
        {phase.kind === 'failed' && <div className="conflict"><p>{phase.message}</p>{phase.captureId && <>
          <button type="button" disabled={busy} onClick={() => void run(async () => { await request(`${root}/captures/${phase.captureId}/retry`, {}); setPhase({ kind: 'processing', captureId: phase.captureId!, stage: 'transcribing' }); await poll(phase.captureId!); })}>{t('retry')}</button>
          <button type="button" disabled={busy} onClick={() => void run(async () => { await request(`${root}/captures/${phase.captureId}/discard`, {}); setPhase({ kind: 'idle' }); await refresh(); })}>{t('discard')}</button></>}</div>}
      </div>}
      {open && pending.length > 0 && <div className="pending-voice"><h3>{t('telegramPending')}</h3><p className="fine">{t('telegramPendingLead')}</p>
        {pending.map(c => <div key={c.id} className="voice-row"><span>{t('voiceItem', { time: new Date(c.createdAt).toLocaleTimeString(locale === 'ru' ? 'ru' : 'uz', { hour: '2-digit', minute: '2-digit' }), seconds: c.durationS ?? 0 })}</span>
          <button type="button" disabled={busy || working} onClick={() => { if (confirm(t('attachConfirm'))) void run(async () => { await request(`${root}/captures/${c.id}/attach`, { patientId, encounterId }); setPhase({ kind: 'processing', captureId: c.id, stage: 'transcribing' }); await poll(c.id); }); }}>{t('attach')}</button></div>)}</div>}

      <ol className="gp-fields">{draft.fields.map(f => {
        const label = t(`field.${f.key}` as AKey);
        return <li key={f.key} className={`gp-field status-${f.status}`}>
          <div className="gp-field-head"><strong>{label}</strong><span className="chip">{t(`status.${f.status}` as AKey)}</span>{f.category && <span className="chip quiet">{t(`category.${f.category}` as AKey)}</span>}</div>
          {editing === f.key ? <FieldEditor field={f} labs={labs} locale={locale} t={t} busy={busy} onCancel={() => setEditing(null)} onSave={(value, category) => void fieldAction(f, { action: 'edit', value, category })} /> : <>
            <p className={f.value === null && f.category !== 'not_examined' ? 'muted' : 'gp-value'}>{valueText(f.key, f.value, f.category)}</p>
            {f.evidence.length > 0 && <button type="button" className="link" aria-expanded={sourceOf === f.key} onClick={() => setSourceOf(sourceOf === f.key ? null : f.key)}>{sourceOf === f.key ? t('hideSource') : t('source')}</button>}
            {sourceOf === f.key && <blockquote className="source">{segmentsFor(f.evidence).map(s => <p key={s.id}><small>{t(`speaker_${s.speaker}` as AKey)}</small> {s.text}</p>)}</blockquote>}
            {f.held && open && <div className="held"><p className="fine">{t('heldTitle')}</p><p>{valueText(f.key, f.held.value, f.held.category)}</p>
              <button type="button" disabled={busy} onClick={() => void fieldAction(f, { action: 'accept', proposalId: f.held!.proposalId })}>{t('acceptHeld')}</button></div>}
            {open && <div className="gp-actions">
              {f.status === 'proposed' && <button type="button" className="primary" disabled={busy} onClick={() => void fieldAction(f, { action: 'accept', proposalId: null })}>{t('accept')}</button>}
              <button type="button" disabled={busy} onClick={() => setEditing(f.key)}>{t('edit')}</button>
              {f.status !== 'empty' && f.status !== 'cleared' && <button type="button" disabled={busy} onClick={() => void fieldAction(f, { action: 'clear' })}>{t('clear')}</button>}
            </div>}
          </>}
        </li>;
      })}</ol>

      {draft.approval ? <div className="approved" role="status"><p>{t('approved', { by: draft.approval.approvedBy, at: new Date(draft.approval.approvedAt).toLocaleString(locale === 'ru' ? 'ru' : 'uz'), revision: draft.approval.revision })}</p>
        <a className="button" href={`${base}/approved.pdf`} target="_blank" rel="noopener">{t('openPdf')}</a></div> :
        <div className="savebar"><p role="status">{unresolved ? t('unresolved', { count: unresolved }) : t('ready')}</p>
          <button type="button" className="primary big" disabled={busy || working || unresolved > 0} onClick={() => void approve()}>{t('approve')}</button></div>}

      {draft.segments.length > 0 && <details className="transcript"><summary>{t('transcript', { count: draft.segments.length })}</summary>
        {draft.segments.map(s => <p key={s.id}><small>{t(`speaker_${s.speaker}` as AKey)}</small> {s.text}</p>)}</details>}

      {/* Linking is task 004's staff Telegram invite ("PIN and Telegram" or the administrator); one link serves sign-in and voice notes. */}
      <details className="telegram-link"><summary>{t('telegramLink')}</summary>
        <p className="fine">{!config?.telegram.available ? t('telegramUnavailable') : config.telegram.linked ? t('telegramLinkedNote') : t('telegramInviteHint')}</p>
      </details>
    </>}
  </section>;
}

function FieldEditor({ field, labs, locale, t, busy, onCancel, onSave }: { field: FieldView; labs: Lab[]; locale: ALocale; t: ReturnType<typeof translator>; busy: boolean;
  onCancel: () => void; onSave: (value: unknown, category: string) => void }) {
  const options = CATEGORY_OPTIONS[field.key] ?? ['reported'];
  const [category, setCategory] = useState(field.category && options.includes(field.category) ? field.category : options[0]!);
  const initial = field.value;
  const [text, setText] = useState(typeof initial === 'string' ? initial : '');
  const diag = (initial && typeof initial === 'object' && !Array.isArray(initial) ? initial : { icd10: '', text: '' }) as { icd10: string; text: string };
  const [icd, setIcd] = useState(diag.icd10), [diagText, setDiagText] = useState(diag.text);
  const [codes, setCodes] = useState<string[]>(Array.isArray(initial) ? initial as string[] : []);
  const value = () => category === 'not_examined' ? null : field.key === 'diagnosis' ? { icd10: icd.trim().toUpperCase(), text: diagText.trim() }
    : field.key === 'labOrders' ? (codes.length ? codes : null) : (text.trim() || null);
  return <form className="field-editor" onSubmit={e => { e.preventDefault(); onSave(value(), category); }}>
    {options.length > 1 && <label>{t('category')}<select value={category} onChange={e => setCategory(e.target.value)}>{options.map(o => <option key={o} value={o}>{t(`category.${o}` as AKey)}</option>)}</select></label>}
    {category === 'not_examined' ? null : field.key === 'diagnosis' ? <div className="two">
      <label>{t('icd10')}<input value={icd} onChange={e => setIcd(e.target.value)} maxLength={8} required pattern="[A-TV-Za-tv-z][0-9]{2}(\.[0-9A-Za-z]{1,4})?" /></label>
      <label>{t('diagnosisText')}<input value={diagText} onChange={e => setDiagText(e.target.value)} maxLength={4000} required /></label></div>
    : field.key === 'labOrders' ? <fieldset className="labs">{labs.map(l => <label key={l.code} className="check"><input type="checkbox" checked={codes.includes(l.code)}
        onChange={e => setCodes(old => e.target.checked ? [...old, l.code] : old.filter(c => c !== l.code))} />{l[labKey(locale)]}</label>)}</fieldset>
    : field.key === 'followUp' ? <input type="date" aria-label={t('field.followUp')} value={text} onChange={e => setText(e.target.value)} />
    : <textarea aria-label={t(`field.${field.key}` as AKey)} value={text} onChange={e => setText(e.target.value)} rows={3} maxLength={4000} />}
    <div className="gp-actions"><button className="primary" disabled={busy}>{t('save')}</button><button type="button" onClick={onCancel}>{t('cancel')}</button></div>
  </form>;
}
