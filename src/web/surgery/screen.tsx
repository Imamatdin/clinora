import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ModuleProps, WebModule } from '../modules.js';
import type { Choice } from '../pharmacy/screen.js';
import { translator } from '../pharmacy/i18n.js';
import { useLocale } from '../i18n/locale.js';
import { errorText } from '../i18n/index.js';
import { ApiFailure } from '../api.js';
type Options={services:Choice[];surgeons:Choice[];visits:Choice[];notes:{id:string;visit_id:string;created_at:string}[]};
/** Now as a datetime-local value in the browser's own time zone (what the input shows). */
const localNow=()=>{const d=new Date();d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16);};
function Surgery({clinic,request,setDirty,myId}:ModuleProps) {
  const locale=useLocale(),t=translator(locale),[options,setOptions]=useState<Options|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [visit,setVisit]=useState('');
  const key=useRef(crypto.randomUUID()),base=`/api/clinics/${clinic.id}/surgery`;
  useEffect(()=>{request<Options>(base+'/options').then(o=>{setOptions(o);setVisit(o.visits[0]?.id??'');}).catch(()=>setError(errorText('SERVICE_UNAVAILABLE')));},[clinic.id]);
  async function submit(e:FormEvent<HTMLFormElement>) {
    e.preventDefault();const form=e.currentTarget,f=new FormData(form),visitId=String(f.get('visit')),admissionId=options?.visits.find(v=>v.id===visitId)?.admission_id;
    setBusy(true);setError('');setNotice('');
    try {await request(base,{idempotencyKey:key.current,visitId,admissionId:admissionId??undefined,serviceId:f.get('service'),surgeonId:f.get('surgeon'),performedAt:new Date(String(f.get('time'))).toISOString(),documentId:String(f.get('note'))||undefined,backdateReason:String(f.get('reason')??'').trim()||undefined});key.current=crypto.randomUUID();form.reset();setVisit(options?.visits[0]?.id??'');setDirty(false);setNotice(t('pharmacy.saved'));}
    catch(e){setError(errorText(e instanceof ApiFailure?e.code:'SERVICE_UNAVAILABLE'));}finally{setBusy(false);}
  }
  return <section className="pharmacy screen">
    <div className="banners" aria-live="polite">{error&&<p role="alert" className="error">{error}</p>}{notice&&<p role="status" className="notice">{notice}</p>}</div>
    {!options?<p role="status">{t('pharmacy.loading')}</p>:!options.services.length||!options.visits.length||!options.surgeons.length?<p className="empty">{t('pharmacy.empty')}</p>:<form className="pharmacy-form" onSubmit={submit} onChange={()=>{key.current=crypto.randomUUID();setDirty(true);}}><fieldset disabled={busy}>
      {(['visit','surgeon','service'] as const).map((name)=><label key={name}>{t(name==='visit'?'pharmacy.visit':`surgery.${name}`)}<select aria-label={t(name==='visit'?'pharmacy.visit':`surgery.${name}`)} name={name} required defaultValue={name==='surgeon'&&options.surgeons.some(v=>v.id===myId)?myId:undefined} onChange={name==='visit'?e=>setVisit(e.target.value):undefined}>{options[name==='visit'?'visits':name==='surgeon'?'surgeons':'services'].map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>)}
      <label>{t('surgery.time')}<input name="time" type="datetime-local" required max={localNow()} defaultValue={localNow()} /></label>
      <label>{t('surgery.note')}<select aria-label={t('surgery.note')} name="note" key={visit}><option value="">—</option>{options.notes.filter(n=>n.visit_id===visit).map(n=><option key={n.id} value={n.id}>{new Date(n.created_at).toLocaleString(locale)}</option>)}</select></label>
      <label>{t('surgery.backdateReason')}<input name="reason" maxLength={500} /></label>
      <button className="primary big" disabled={busy}>{t('surgery.save')}</button>
    </fieldset></form>}
  </section>;
}
export const surgeryModule:WebModule={id:'surgery',roles:['ceo','administrator','doctor','inpatient'],label:'surgery.title',Screen:Surgery};
