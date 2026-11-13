import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ModuleProps, WebModule } from '../modules.js';
import { ApiFailure } from '../api.js';
import { errorText, fill } from '../i18n/index.js';
import { inpatient, type InpatientKey } from '../i18n/inpatient.uz-Cyrl.js';
import { inpatientUzLatn } from '../i18n/inpatient.uz-Latn.js';
import { inpatientRu } from '../i18n/inpatient.ru.js';
import type { WardView, InvoiceView } from '../../modules/inpatient/contracts.js';

import { useLocale } from '../i18n/locale.js';

function Screen({clinic,request,myId,setDirty}:ModuleProps) {
  const locale=useLocale();
  const dict={'uz-Cyrl':inpatient,'uz-Latn':inpatientUzLatn,ru:inpatientRu}[locale];
  const t=(key:InpatientKey,vars:Record<string,string>={})=>fill(dict[key],vars);
  const amount=(value:string)=>BigInt(value).toLocaleString('ru-RU');
  const [data,setData]=useState<WardView|null>(null),[selected,setSelected]=useState(''),[bill,setBill]=useState<InvoiceView|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[confirm,setConfirm]=useState(false),[mine,setMine]=useState(false);
  // Task 017: the admit form offers only beds of the chosen department (the server refuses others).
  const [admitDept,setAdmitDept]=useState('');
  const pending=useRef<{payload:string;key:string}|null>(null);
  const base=`/api/clinics/${clinic.id}/inpatient`;
  const canWrite=clinic.roles.some(r=>['ceo','administrator','inpatient'].includes(r));
  const manager=clinic.roles.some(r=>['ceo','administrator'].includes(r));
  async function refresh(){setData(await request<WardView>(base));}
  async function run(fn:()=>Promise<void>){setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError(errorText(e instanceof ApiFailure?e.code:'SERVICE_UNAVAILABLE'));}finally{setBusy(false);}}
  useEffect(()=>{setData(null);setSelected('');setBill(null);pending.current=null;void run(refresh);},[clinic.id]);
  async function mutate(path:string,value:Record<string,unknown>){
    const payload=JSON.stringify({path,value});if(pending.current?.payload!==payload)pending.current={payload,key:crypto.randomUUID()};
    const result=await request(`${base}${path}`,{...value,key:pending.current.key});pending.current=null;setDirty(false);return result;
  }
  function submit(e:FormEvent<HTMLFormElement>,path:string,build:(f:FormData)=>Record<string,unknown>){e.preventDefault();const form=e.currentTarget,value=build(new FormData(form));void run(async()=>{await mutate(path,value);form.reset();setAdmitDept("");const details=form.closest('details');if(details)details.open=false;await refresh();if(selected)setBill(await request(`${base}/${selected}/invoice`));setNotice(t('inpatient.saved'));});}
  const choose=(name:string,options:{id:string;name:string}[],required=true)=><label>{t(`inpatient.${name}` as InpatientKey)}<select name={name} required={required} aria-label={t(`inpatient.${name}` as InpatientKey)} defaultValue=""><option value="">{t(required?'inpatient.choose':'inpatient.noCharge')}</option>{options.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select></label>;
  const freeBeds=data?.beds.filter(b=>!b.admission_id).map(b=>({id:b.id,name:`${b.room} · ${b.label}`}))??[];
  const active=data?.admissions.find(a=>a.id===selected);
  const stays=data?.admissions.filter(a=>!mine||a.attending_user_id===myId)??[];
  return <div className="inpatient">
    <header><h2>{t('inpatient.title')}</h2></header>
    {error&&<p role="alert">{error}</p>}<p role="status">{busy?t('inpatient.saving'):notice}</p>
    <button disabled={busy} onClick={()=>void run(refresh)}>{t('inpatient.refresh')}</button>
    {!data?<p>{t('inpatient.loading')}</p>:<>
      {/* Task 023: stay days that could not be priced; they are not charged until a price covers them. */}
      {data.attention.length>0&&<section className="notice" aria-label={t('inpatient.attention')}><h3>{t('inpatient.attention')}</h3><ul>{data.attention.map(a=><li key={a.id}>{t('inpatient.attentionLine',{patient:a.patient,date:a.date,service:a.service})}</li>)}</ul></section>}
      <section aria-label={t('inpatient.room')} className="bed-map">{data.beds.map(b=><div key={b.id} data-occupied={!!b.admission_id}><strong>{b.room} · {b.label}</strong><p>{b.admission_id?`${t('inpatient.occupied')} · ${b.patient}`:t('inpatient.free')}</p></div>)}</section>
      {canWrite&&<details><summary>{t('inpatient.admit')}</summary><form onChange={()=>setDirty(true)} onSubmit={e=>submit(e,'/admit',f=>({visitId:f.get('visit'),departmentId:f.get('department'),doctorId:f.get('doctor'),bedId:f.get('bed'),expectedDischarge:f.get('expected')||null}))}><fieldset disabled={busy}>
        {choose('visit',data.visits.map(v=>({id:v.id,name:`${v.patient_no} · ${v.patient}`})))}
        <label>{t('inpatient.department')}<select name="department" required aria-label={t('inpatient.department')} value={admitDept} onChange={e=>setAdmitDept(e.target.value)}><option value="">{t('inpatient.choose')}</option>{data.departments.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
        {choose('doctor',data.doctors)}{choose('bed',data.beds.filter(b=>!b.admission_id&&(!admitDept||!b.department_id||b.department_id===admitDept)).map(b=>({id:b.id,name:`${b.room} · ${b.label}`})))}
        <label>{t('inpatient.expected')}<input name="expected" type="date" min={data.today}/></label><button>{t('inpatient.admit')}</button>
      </fieldset></form></details>}
      <label><input type="checkbox" checked={mine} onChange={e=>setMine(e.target.checked)}/>{t('inpatient.myPatients')}</label>
      <section className="stays">{stays.length===0?<p>{t('inpatient.empty')}</p>:stays.map(a=><button disabled={busy} key={a.id} aria-pressed={selected===a.id} onClick={()=>void run(async()=>{setSelected(a.id);setBill(null);setConfirm(false);setDirty(false);setBill(await request<InvoiceView>(`${base}/${a.id}/invoice`));})}>
        {a.patient} · {a.room} {a.bed} · {a.attending} · {t(a.status==='admitted'?'inpatient.admitted':'inpatient.discharged')}
      </button>)}</section>
      {active&&<section key={active.id} className="stay-detail"><h3>{active.patient}</h3>
        {bill&&<div><h4>{t('inpatient.invoice')}</h4>{bill.lines.map(l=><p key={l.id}>{l.name} · {l.quantity} × {amount(l.price)} = {amount(l.value)} {t('inpatient.uzs')}</p>)}
          {bill.needsAttention?.length?<div className="notice"><strong>{t('inpatient.attention')}</strong>{bill.needsAttention.map(n=><p key={n.kind+n.date+n.service}>{t('inpatient.attentionLine',{patient:bill.patient,date:n.date,service:n.service})}</p>)}</div>:null}
          <p className="fine">{t('inpatient.linesAsOf')}: {new Date(bill.linesAsOf).toLocaleString(locale)} · {t('inpatient.paymentsAsOf')}: {new Date(bill.paymentsAsOf).toLocaleString(locale)}</p>
          <dl>{(['value','discount','payable','paid','due'] as const).map(k=><div key={k}><dt>{t(`inpatient.${k}`)}</dt><dd data-testid={`inpatient-${k}`}>{BigInt(bill[k]).toLocaleString('ru-RU')} {t('inpatient.uzs')}</dd></div>)}</dl>
          <a className="invoice-pdf" href={`${base}/${selected}/invoice-pdf`} target="_blank" rel="noopener noreferrer">{t('inpatient.print')}</a>
        </div>}
        {canWrite&&active.status==='admitted'&&<>
          <details><summary>{t('inpatient.addService')}</summary><p>{t('inpatient.medicineHelp')}</p><form onChange={()=>setDirty(true)} onSubmit={e=>submit(e,`/${selected}/services`,f=>({serviceId:f.get('service'),quantity:Number(f.get('quantity')),
              ...f.get('approver')?{override:{reason:f.get('overrideReason'),approverId:f.get('approver'),pin:f.get('approverPin')}}:{}}))}><fieldset disabled={busy}>
            {choose('service',data.services.filter(s=>!['bed','caretaker'].includes(s.kind)).map(s=>({id:s.id,name:`${s.name} · ${s.price===null?'—':amount(s.price)}`})))}
            <label>{t('inpatient.quantity')}<input name="quantity" type="number" min="1" max="10000" required defaultValue="1"/></label>
            {data.approvers.length>0&&<details className="override"><summary>{t('inpatient.override')}</summary><p>{t('inpatient.overrideHelp')}</p>
              <label>{t('inpatient.approver')}<select name="approver" defaultValue=""><option value="">{t('inpatient.choose')}</option>{data.approvers.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
              <label>{t('inpatient.overrideReason')}<input name="overrideReason" maxLength={1000}/></label>
              <label>{t('inpatient.approverPin')}<input name="approverPin" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{4,6}"/></label>
            </details>}
            <button>{t('inpatient.addService')}</button>
          </fieldset></form></details>
          <details><summary>{t('inpatient.transfer')}</summary><form onChange={()=>setDirty(true)} onSubmit={e=>submit(e,`/${selected}/transfer`,f=>({bedId:f.get('bed')}))}><fieldset disabled={busy}>{choose('bed',freeBeds)}<button>{t('inpatient.transfer')}</button></fieldset></form></details>
          <details><summary>{t('inpatient.caretaker')}</summary><form onChange={()=>setDirty(true)} onSubmit={e=>submit(e,`/${selected}/caretakers`,f=>({fullName:f.get('name'),phone:f.get('phone')||null,dailyServiceId:f.get('dailyService')||null}))}><fieldset disabled={busy}>
            <label>{t('inpatient.name')}<input name="name" maxLength={200} required/></label><label>{t('inpatient.phone')}<input name="phone" type="tel" pattern="\+[1-9][0-9]{7,14}"/></label>
            {choose('dailyService',data.services.filter(s=>s.kind==='caretaker'),false)}<button>{t('inpatient.addCaretaker')}</button>
          </fieldset></form></details>
          {confirm?<div role="group" aria-label={t('inpatient.discharge')}><p>{t('inpatient.confirmDischarge')}</p><button disabled={busy} onClick={()=>void run(async()=>{setBill(await mutate(`/${selected}/discharge`,{}) as InvoiceView);setConfirm(false);await refresh();setNotice(t('inpatient.saved'));})}>{t('inpatient.confirm')}</button><button disabled={busy} onClick={()=>setConfirm(false)}>{t('inpatient.cancel')}</button></div>:<button disabled={busy} onClick={()=>setConfirm(true)}>{t('inpatient.discharge')}</button>}
        </>}
      </section>}
      {canWrite&&<details><summary>{t('inpatient.daily')}</summary><p>{t('inpatient.dailyHelp')}</p><form onSubmit={e=>submit(e,'/daily',f=>({through:f.get('through')}))}><fieldset disabled={busy}><label>{t('inpatient.through')}<input name="through" type="date" required max={new Date(Date.parse(`${data.today}T00:00:00Z`)-86400000).toISOString().slice(0,10)}/></label><button>{t('inpatient.daily')}</button></fieldset></form></details>}
      {manager&&<details><summary>{t('inpatient.rule')}</summary><form onSubmit={e=>submit(e,'/rule',f=>({rule:{countAdmissionDay:f.get('admissionDay')==='on',countDischargeDay:f.get('dischargeDay')==='on',minimumDays:Number(f.get('minimum'))}}))}><fieldset disabled={busy}>
        <label><input type="checkbox" name="admissionDay" defaultChecked={data.rule.countAdmissionDay}/>{t('inpatient.admissionDay')}</label>
        <label><input type="checkbox" name="dischargeDay" defaultChecked={data.rule.countDischargeDay}/>{t('inpatient.dischargeDay')}</label>
        <label>{t('inpatient.minimum')}<input type="number" name="minimum" min="1" max="365" required defaultValue={data.rule.minimumDays}/></label><button>{t('inpatient.saveRule')}</button>
      </fieldset></form></details>}
    </>}
  </div>;
}
export const inpatientModule:WebModule={id:'inpatient',roles:['ceo','administrator','inpatient','cashier','doctor'],label:'module.admissions',Screen};
