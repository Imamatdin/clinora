import { useEffect,useRef,useState } from 'react';
import type { Report,Detail,Group } from '../../modules/reports/actions.js';
import type { Download } from '../../modules/reports/exports.js';
import type { ModuleProps,WebModule } from '../modules.js';
import { Dates,money,metric,saveBlob,saveFile,t,Confirm,useReportLocale,type Key } from './shared.js';

function Ledger({title,lines,onBack}:{title:string;lines:Detail[];onBack:()=>void}) {
  const heading=useRef<HTMLHeadingElement>(null);useEffect(()=>heading.current?.focus(),[]);
  return <section className="ceo-ledger"><button onClick={onBack}>{t('ceo.back')}</button><h2 ref={heading} tabIndex={-1}>{title}</h2><p>{lines.reduce((n,l)=>n+(l.rest??1),0)} {t('ceo.lines')}</p>
    {!lines.length?<p className="ceo-empty">{t('ceo.empty')}</p>:<ol>{lines.map((l,i)=><li key={`${l.id}:${i}`}>{l.rest?<div><strong>{t('ceo.others')}</strong><small>{l.rest} {t('ceo.lines')}</small></div>:<div><strong>{l.label}</strong><small>{l.date} · {l.id}</small></div>}<b>{money(l.amount)}</b></li>)}</ol>}
  </section>;
}
type Kind='doctors'|'departments'|'sources';
const SOURCES=['walk_in','referral','advertisement','social','returning','other'];
/** Display name of a breakdown row: the "—" group and source codes are translated, never shown raw (task 025). */
export function rowName(kind:Kind,row:Pick<Group,'id'|'name'>) {
  if(kind==='sources')return row.id==='—'?t('ceo.source.none'):t(`ceo.source.${SOURCES.includes(row.id)?row.id:'other'}` as Key);
  if(row.id==='—')return t(kind==='doctors'?'ceo.noDoctor':'ceo.noDepartment');
  return row.name;
}
const TOP=3;
const byAmount=(a:Group,b:Group)=>{const x=BigInt(a.amount),y=BigInt(b.amount);return x===y?0:x>y?-1:1;};
/**
 * One row per doctor, department or source, largest amount first. The top three show by default and
 * "All N" opens the rest; doctors can be narrowed by department. A doctor or department row expands in
 * place to its patients, service value, discounts and debt; the arrow opens the row's ledger (task 025).
 */
function Breakdown({kind,title,rows,onSelect}:{kind:Kind;title:string;rows:Group[];onSelect:(title:string,lines:Detail[])=>void}) {
  const [all,setAll]=useState(false),[department,setDepartment]=useState(''),[expanded,setExpanded]=useState<string[]>([]);
  const departments=kind==='doctors'?[...new Map(rows.filter(r=>r.departmentId).map(r=>[r.departmentId!,r.department!])).entries()].sort((a,b)=>a[1].localeCompare(b[1])):[];
  const filtered=[...rows].filter(r=>!department||r.departmentId===department).sort(byAmount),shown=all?filtered:filtered.slice(0,TOP);
  const allLabel=t(kind==='doctors'?'ceo.allDoctors':kind==='departments'?'ceo.allDepartments':'ceo.allSources').replace('{count}',String(filtered.length));
  const id=`ceo-${kind}`;
  return <section className="ceo-breakdown" aria-labelledby={`${id}-title`}><h3 id={`${id}-title`}>{title}</h3>
    {departments.length>0&&<div className="ceo-chips" role="group" aria-label={t('ceo.departmentFilter')}>
      {[['',t('ceo.all')] as const,...departments.map(([key,name])=>[key,`#${name}`] as const)].map(([key,label])=><button key={key||'all'} type="button" aria-pressed={department===key} onClick={()=>{setDepartment(key);setAll(false);}}>{label}</button>)}
    </div>}
    {!filtered.length?<p className="ceo-empty">{t('ceo.empty')}</p>:<ul className="ceo-rows">{shown.map(row=>{
      const name=rowName(kind,row),open=expanded.includes(row.id),facts=`${id}-${row.id}`;
      if(!row.patientLines)return <li key={row.id} className="ceo-row"><button className="ceo-row-main" onClick={()=>onSelect(name,row.lines)}><span>{name}</span><b>{money(row.amount)}</b><span aria-hidden="true">↗</span></button></li>;
      return <li key={row.id} className="ceo-row" data-open={open}>
        <div className="ceo-row-head"><button className="ceo-row-main" aria-expanded={open} aria-controls={facts} onClick={()=>setExpanded(e=>open?e.filter(x=>x!==row.id):[...e,row.id])}>
          <span>{name}</span><b>{money(row.amount)}</b><span className="ceo-chevron" aria-hidden="true">▾</span></button>
          <button className="ceo-row-open" onClick={()=>onSelect(name,row.lines)}><span aria-hidden="true">↗</span><span className="sr-only">{t('ceo.openRecords')}: {name}</span></button></div>
        {open&&<div className="ceo-performance-facts" id={facts}>{[[t('ceo.patients'),row.patientLines],[t('ceo.value'),row.valueLines!],[t('ceo.discounts'),row.discountLines!],[t('ceo.outstanding'),row.outstandingLines!]].map(([label,lines])=><button key={String(label)} onClick={()=>onSelect(`${name} · ${label}`,lines as Detail[])}><span>{String(label)}</span><b>{money((lines as Detail[]).reduce((n,l)=>n+BigInt(l.amount),0n))}</b></button>)}</div>}
      </li>;})}</ul>}
    {filtered.length>TOP&&<button type="button" className="ceo-all" aria-expanded={all} onClick={()=>setAll(a=>!a)}>{all?t('ceo.showTop'):allLabel}</button>}
  </section>;
}
export function ReportView({report}:{report:Report}) {
  const [selection,setSelection]=useState<{title:string;lines:Detail[]}|null>(null);
  const open=(title:string,lines:Detail[])=>setSelection({title,lines});
  useEffect(()=>setSelection(null),[report]);
  const back=useRef<HTMLDivElement>(null);
  if(selection)return <Ledger {...selection} onBack={()=>{setSelection(null);requestAnimationFrame(()=>back.current?.focus());}} />;
  if(!('patients' in report.totals))return <section className="ceo-report"><p>{metric('collected')}: <strong>{money(report.totals.collected!)} {t('ceo.uzs')}</strong></p>
    {(report.cashShifts??[]).map(s=><section key={s.id}><h3>{s.cashier} · {s.date}</h3><p>{t('ceo.opening')}: {money(s.opening)}</p><p>{t('ceo.expected')}: {money(s.expected)}</p><p>{t('ceo.counted')}: {s.counted===null?'—':money(s.counted)}</p><p>{t('ceo.difference')}: {s.difference===null?'—':money(s.difference)}</p></section>)}</section>;
  return <div ref={back} tabIndex={-1} className="ceo-report">
    <div className="ceo-status"><span className="ceo-live">{report.snapshot?t('ceo.snapshot'):t('ceo.live')}</span><span>{report.from} — {report.to}</span></div>
    {!!report.needsReview?.length&&<p role="alert">{t('ceo.needsReview')}: {report.needsReview.map(v=>v.label).join(', ')}</p>}
    <div className="ceo-kpis">{['collected','patients','outstanding','discounts'].map((k,i)=><button key={k} className={`ceo-kpi ceo-kpi-${i}`} onClick={()=>open(metric(k),report.details[k]!)}><span>{metric(k)}</span><strong>{money(report.totals[k]!)}</strong><small>{k==='patients'?t('ceo.people'):t('ceo.uzs')} <span aria-hidden="true">↗</span></small></button>)}</div>
    <div className="ceo-middle"><section className="ceo-breakdown ceo-methods"><h3>{t('ceo.methods')}</h3>{['cash','card','transfer'].map(k=><button key={k} onClick={()=>open(metric(k),report.details[k]!)}><span>{metric(k)}</span><b>{money(report.totals[k]!)}</b><meter aria-label={metric(k)} min={0} max={100} value={BigInt(report.totals.collected!)>0n?Number(BigInt(report.totals[k]!)*100n/BigInt(report.totals.collected!)):0} /></button>)}</section>
      <div className="ceo-secondary">{['net','value','refunds','cashOuts','new','returning','outpatient','inpatient','lab','ward'].map(k=><button key={k} onClick={()=>open(metric(k),report.details[k]!)}><span>{metric(k)}</span><b>{money(report.totals[k]!)}</b></button>)}</div></div>
    <div className="ceo-groups"><Breakdown kind="doctors" title={t('ceo.doctors')} rows={report.doctors} onSelect={open}/><Breakdown kind="departments" title={t('ceo.departments')} rows={report.departments} onSelect={open}/><Breakdown kind="sources" title={t('ceo.sources')} rows={report.sources} onSelect={open}/></div>
    <p className="ceo-footnote">{t('ceo.scope')}</p><p className="ceo-footnote">{t('ceo.updated')} · {new Date(report.generatedAt).toLocaleString('ru-RU',{timeZone:'Asia/Tashkent'})}</p>
  </div>;
}
export function Dashboard({clinic,request,day}:ModuleProps) {
  useReportLocale();
  const today=day?.today??new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Tashkent'}),[range,setRange]=useState({from:today,to:today}),[applied,setApplied]=useState(range);
  const [report,setReport]=useState<Report|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false),[notice,setNotice]=useState('');
  const sequence=useRef(0);
  const load=async(p=applied)=>{const seq=++sequence.current;setBusy(true);setError(false);try{const r=await request<Report>(`/api/clinics/${clinic.id}/reports/dashboard`,p);if(sequence.current===seq)setReport(r);}catch{if(sequence.current===seq)setError(true);}finally{if(sequence.current===seq)setBusy(false);}};
  useEffect(()=>{void load(applied);const timer=setInterval(()=>{if(document.visibilityState==='visible')void load(applied);},30000);return()=>{sequence.current++;clearInterval(timer);};},[clinic.id,applied]);
  const exportFile=async(format:'pdf'|'xlsx')=>{setBusy(true);setError(false);try{saveFile(await request<Download>(`/api/clinics/${clinic.id}/reports/export`,{...applied,format}));setNotice(t('ceo.downloaded'));}catch{setError(true);}finally{setBusy(false);}};
  return <section className="ceo-workspace" aria-busy={busy}><header className="ceo-heading"><div><p className="ceo-eyebrow">{t('ceo.eyebrow')}</p><h2>{t('ceo.title')}</h2><p>{t('ceo.lead')}</p></div><button disabled={busy} onClick={()=>{setRange({from:today,to:today});setApplied({from:today,to:today});}}>{t('ceo.today')}</button></header>
    <details className="ceo-filters"><summary><span>{applied.from} — {applied.to}</span><b>{t('ceo.filters')}</b></summary><Dates {...range} onChange={(from,to)=>setRange({from,to})} busy={busy} onSubmit={()=>{setReport(null);setApplied({...range});}}/></details>
    {busy&&<p role="status">{t('ceo.loading')}</p>}{error&&<p role="alert" className="ceo-error">{t('ceo.error')} <button disabled={busy} onClick={()=>void load()}>{t('ceo.retry')}</button></p>}{notice&&<p role="status">{notice}</p>}
    {!error&&report&&<ReportView report={report}/>}
    <details className="ceo-more"><summary>{t('ceo.more')}</summary><div><button disabled={busy||!report} onClick={()=>void exportFile('pdf')}>{t('ceo.pdf')}</button><button disabled={busy||!report} onClick={()=>void exportFile('xlsx')}>{t('ceo.excel')}</button></div></details>
  </section>;
}
export function ExportPanel({clinic,request}:ModuleProps) {
  useReportLocale();
  const [busy,setBusy]=useState(false),[error,setError]=useState(false),[done,setDone]=useState(false);
  const run=async()=>{setBusy(true);setError(false);setDone(false);try{saveBlob(await request<Blob>(`/api/clinics/${clinic.id}/reports/full-export`,{},false,10*60_000),'clinora-clinic.zip');setDone(true);}catch{setError(true);}finally{setBusy(false);}};
  return <section className="ceo-workspace"><header className="ceo-heading"><div><p className="ceo-eyebrow">{t('ceo.eyebrow')}</p><h2>{t('ceo.exportTitle')}</h2><p>{t('ceo.exportLead')}</p></div></header><p>{t('ceo.full')}</p><Confirm label={t('ceo.full')} text={t('ceo.fullConfirm')} busy={busy} onConfirm={()=>void run()}/>{error&&<p role="alert">{t('ceo.error')}</p>}{done&&<p role="status">{t('ceo.downloaded')}</p>}</section>;
}
export const dashboardModule:WebModule={id:'dashboard',roles:['ceo'],label:'module.dashboard',Screen:Dashboard};
export const exportModule:WebModule={id:'exports',roles:['ceo'],label:'module.export',Screen:ExportPanel};
