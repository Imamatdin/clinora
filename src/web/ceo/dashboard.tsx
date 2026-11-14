import { useEffect,useRef,useState } from 'react';
import type { Report,Detail,Group } from '../../modules/reports/actions.js';
import type { Download } from '../../modules/reports/exports.js';
import type { ModuleProps,WebModule } from '../modules.js';
import { Dates,money,metric,saveBlob,saveFile,t,Confirm,useReportLocale,type Key } from './shared.js';
import { AbrField } from '../abr.js';
import { Icon,Seg } from '../shell.js';

const shortDate=(iso:string)=>iso.slice(0,10).split('-').reverse().join('.');
function Ledger({title,lines,onBack}:{title:string;lines:Detail[];onBack:()=>void}) {
  const heading=useRef<HTMLHeadingElement>(null);useEffect(()=>heading.current?.focus(),[]);
  return <section className="ceo-ledger"><button className="quiet back" onClick={onBack}><Icon name="back"/>{t('ceo.back')}</button><h2 ref={heading} tabIndex={-1} className="hero-name">{title}</h2><p className="muted">{lines.reduce((n,l)=>n+(l.rest??1),0)} {t('ceo.lines')}</p>
    {!lines.length?<p className="ceo-empty empty">{t('ceo.empty')}</p>:<ol className="rows">{lines.map((l,i)=><li key={`${l.id}:${i}`}><div className="row">{l.rest?<div className="row-body"><strong className="row-title">{t('ceo.others')}</strong><small className="row-meta">{l.rest} {t('ceo.lines')}</small></div>:<div className="row-body"><strong className="row-title">{l.label}</strong><small className="row-meta">{shortDate(l.date)}</small></div>}<b className="row-end num">{money(l.amount)}</b></div></li>)}</ol>}
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
  const id=`ceo-${kind}`,top=filtered[0]?BigInt(filtered[0].amount):0n;
  const share=(row:Group)=>({width:`${top>0n?Math.max(2,Number(BigInt(row.amount)*100n/top)):0}%`});
  return <section className="ceo-breakdown" aria-labelledby={`${id}-title`}><h3 id={`${id}-title`} className="section-label">{title}</h3>
    {departments.length>0&&<div className="ceo-chips" role="group" aria-label={t('ceo.departmentFilter')}>
      {[['',t('ceo.all')] as const,...departments.map(([key,name])=>[key,name] as const)].map(([key,label])=><button key={key||'all'} type="button" aria-pressed={department===key} onClick={()=>{setDepartment(key);setAll(false);}}>{label}</button>)}
    </div>}
    {!filtered.length?<p className="ceo-empty">{t('ceo.empty')}</p>:<ul className="ceo-rows">{shown.map(row=>{
      const name=rowName(kind,row),open=expanded.includes(row.id),facts=`${id}-${row.id}`;
      if(!row.patientLines)return <li key={row.id} className="ceo-row"><button className="ceo-row-main" onClick={()=>onSelect(name,row.lines)}><span>{name}</span><b>{money(row.amount)}</b><span className="chev" aria-hidden="true"/></button><i className="ceo-share" style={share(row)} aria-hidden="true"/></li>;
      return <li key={row.id} className="ceo-row" data-open={open}>
        <div className="ceo-row-head"><button className="ceo-row-main" aria-expanded={open} aria-controls={facts} onClick={()=>setExpanded(e=>open?e.filter(x=>x!==row.id):[...e,row.id])}>
          <span>{name}</span><b>{money(row.amount)}</b></button>
          <button className="ceo-row-open icon-button" onClick={()=>onSelect(name,row.lines)}><span className="chev" aria-hidden="true"/><span className="sr-only">{t('ceo.openRecords')}: {name}</span></button></div><i className="ceo-share" style={share(row)} aria-hidden="true"/>
        {open&&<div className="ceo-performance-facts" id={facts}>{[[t('ceo.patients'),row.patientLines],[t('ceo.value'),row.valueLines!],[t('ceo.discounts'),row.discountLines!],[t('ceo.outstanding'),row.outstandingLines!]].map(([label,lines])=><button key={String(label)} onClick={()=>onSelect(`${name} · ${label}`,lines as Detail[])}><span>{String(label)}</span><b>{money((lines as Detail[]).reduce((n,l)=>n+BigInt(l.amount),0n))}</b></button>)}</div>}
      </li>;})}</ul>}
    {filtered.length>TOP&&<button type="button" className="ceo-all" aria-expanded={all} onClick={()=>setAll(a=>!a)}>{all?t('ceo.showTop'):allLabel}</button>}
  </section>;
}
/** Money received per day for the 14 days up to the end of the range, drawn as warp threads; the last day is the solid one. */
function Trend({days,to}:{days:{date:string;collected:string}[];to:string}) {
  const byDate=new Map(days.map(d=>[d.date,BigInt(d.collected)])),slots:{date:string;value:bigint}[]=[];
  const end=new Date(`${to}T00:00:00Z`);
  for(let i=13;i>=0;i--){const d=new Date(end);d.setUTCDate(end.getUTCDate()-i);const iso=d.toISOString().slice(0,10);slots.push({date:iso,value:byDate.get(iso)??0n});}
  const max=slots.reduce((m,s)=>s.value>m?s.value:m,0n);
  return <figure className="ceo-trend"><figcaption className="sr-only">{t('ceo.trend')}: {slots.map(s=>`${shortDate(s.date)} ${money(s.value)}`).join(', ')}</figcaption>
    <div className="ceo-trend-bars" aria-hidden="true">{slots.map((s,i)=><i key={s.date} className={i===13?'now':''} title={`${shortDate(s.date)} · ${money(s.value)}`} style={{height:`${max>0n?Math.max(3,Number(s.value*100n/max)):3}%`}}/>)}</div>
    <div className="ceo-trend-axis" aria-hidden="true"><span>{shortDate(slots[0]!.date).slice(0,5)}</span><span>{shortDate(to).slice(0,5)}</span></div></figure>;
}
export function ReportView({report}:{report:Report}) {
  const [selection,setSelection]=useState<{title:string;lines:Detail[]}|null>(null);
  const open=(title:string,lines:Detail[])=>setSelection({title,lines});
  useEffect(()=>setSelection(null),[report]);
  const back=useRef<HTMLDivElement>(null);
  if(selection)return <Ledger {...selection} onBack={()=>{setSelection(null);requestAnimationFrame(()=>back.current?.focus());}} />;
  if(!('patients' in report.totals))return <section className="ceo-report"><p className="hero-label">{metric('collected')}</p><p className="hero-figure">{money(report.totals.collected!)}<small>{t('ceo.uzs')}</small></p>
    {(report.cashShifts??[]).map(s=><section key={s.id} className="ceo-shift"><h3 className="section-label">{s.cashier} · {shortDate(s.date)}</h3><dl className="cashier-totals"><div><dt>{t('ceo.opening')}</dt><dd>{money(s.opening)}</dd></div><div><dt>{t('ceo.expected')}</dt><dd>{money(s.expected)}</dd></div><div><dt>{t('ceo.counted')}</dt><dd>{s.counted===null?'—':money(s.counted)}</dd></div><div><dt>{t('ceo.difference')}</dt><dd>{s.difference===null?'—':money(s.difference)}</dd></div></dl></section>)}</section>;
  const collected=BigInt(report.totals.collected!),owed=BigInt(report.totals.outstanding!);
  const openShifts=(report.cashShifts??[]).filter(s=>s.counted===null);
  const attention=owed>0n||!!report.needsReview?.length||openShifts.length>0;
  const methods=(['cash','card','transfer'] as const).map(k=>({k,amount:BigInt(report.totals[k]!)}));
  return <div ref={back} tabIndex={-1} className="ceo-report">
    <div className="hero"><AbrField/><div className="hero-in ceo-hero">
      <div className="ceo-kpis">
        <button className="ceo-kpi ceo-kpi-0" onClick={()=>open(metric('collected'),report.details.collected!)}><span className="hero-label">{metric('collected')}</span><strong className="hero-figure">{money(report.totals.collected!)}<small>{t('ceo.uzs')}</small></strong></button>
        <div className="ceo-kpi-row">{(['patients','outstanding','discounts'] as const).map((k,i)=><button key={k} className={`ceo-kpi ceo-kpi-${i+1}`} onClick={()=>open(metric(k),report.details[k]!)}><span>{metric(k)}</span><strong className={k==='outstanding'&&owed>0n?'attn':''}>{money(report.totals[k]!)}</strong></button>)}</div>
      </div>
      {report.trend&&<Trend days={report.trend} to={report.to}/>}
    </div></div>
    <p className="ceo-status"><span className={`ceo-live dot ${report.snapshot?'':'ok'}`}>{report.snapshot?t('ceo.snapshot'):t('ceo.live')}</span><span className="muted">{report.from===report.to?shortDate(report.to):`${shortDate(report.from)} – ${shortDate(report.to)}`}</span></p>
    {attention&&<section className="ceo-attention" aria-labelledby="ceo-attention-title"><h3 id="ceo-attention-title" className="section-label attn">{t('ceo.attention')}</h3><ul className="rows">
      {owed>0n&&<li><button className="row" onClick={()=>open(metric('outstanding'),report.details.outstanding!)}><span className="row-title row-body">{t('ceo.attn.owed')}</span><b className="row-end num attn">{money(report.totals.outstanding!)}</b><span className="chev" aria-hidden="true"/></button></li>}
      {openShifts.map(s=><li key={s.id}><div className="row"><span className="row-title row-body">{t('ceo.attn.shift')}</span><span className="row-end attn">{s.cashier}</span></div></li>)}
      {!!report.needsReview?.length&&<li><div className="row" role="alert"><span className="row-title row-body">{t('ceo.needsReview')}</span><span className="row-end attn">{report.needsReview.map(v=>v.label).join(', ')}</span></div></li>}
    </ul></section>}
    <section className="ceo-methods" aria-labelledby="ceo-methods-title"><h3 id="ceo-methods-title" className="section-label">{t('ceo.methods')}</h3>
      <div className="ceo-mix" aria-hidden="true">{methods.map(m=><i key={m.k} className={`mix-${m.k}`} style={{flexGrow:collected>0n?Number(m.amount*1000n/collected):0}}/>)}</div>
      <div className="ceo-mix-legend">{methods.map(m=><button key={m.k} className={`mix-${m.k}`} onClick={()=>open(metric(m.k),report.details[m.k]!)}><span>{metric(m.k)}</span><b className="num">{money(report.totals[m.k]!)}</b></button>)}</div>
    </section>
    <div className="ceo-groups"><Breakdown kind="doctors" title={t('ceo.doctors')} rows={report.doctors} onSelect={open}/><Breakdown kind="departments" title={t('ceo.departments')} rows={report.departments} onSelect={open}/><Breakdown kind="sources" title={t('ceo.sources')} rows={report.sources} onSelect={open}/></div>
    <details className="ceo-more-metrics"><summary>{t('ceo.more')}</summary>
      <div className="ceo-secondary">{['net','value','refunds','cashOuts','new','returning','outpatient','inpatient','lab','ward'].map(k=><button key={k} onClick={()=>open(metric(k),report.details[k]!)}><span>{metric(k)}</span><b className="num">{money(report.totals[k]!)}</b></button>)}</div>
      <p className="ceo-footnote fine">{t('ceo.scope')}</p><p className="ceo-footnote fine">{t('ceo.updated')} · {new Date(report.generatedAt).toLocaleString('ru-RU',{timeZone:'Asia/Tashkent'})}</p>
    </details>
  </div>;
}
type RangeKey='today'|'week'|'month'|'custom';
const shift=(iso:string,days:number)=>{const d=new Date(`${iso}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
export function Dashboard({clinic,request,day}:ModuleProps) {
  useReportLocale();
  const today=day?.today??new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Tashkent'}),[range,setRange]=useState({from:today,to:today}),[applied,setApplied]=useState(range);
  const [mode,setMode]=useState<RangeKey>('today');
  const [report,setReport]=useState<Report|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false),[notice,setNotice]=useState('');
  const sequence=useRef(0);
  const load=async(p=applied)=>{const seq=++sequence.current;setBusy(true);setError(false);try{const r=await request<Report>(`/api/clinics/${clinic.id}/reports/dashboard`,p);if(sequence.current===seq)setReport(r);}catch{if(sequence.current===seq)setError(true);}finally{if(sequence.current===seq)setBusy(false);}};
  useEffect(()=>{void load(applied);const timer=setInterval(()=>{if(document.visibilityState==='visible')void load(applied);},30000);return()=>{sequence.current++;clearInterval(timer);};},[clinic.id,applied]);
  const exportFile=async(format:'pdf'|'xlsx')=>{setBusy(true);setError(false);try{saveFile(await request<Download>(`/api/clinics/${clinic.id}/reports/export`,{...applied,format}));setNotice(t('ceo.downloaded'));}catch{setError(true);}finally{setBusy(false);}};
  const choose=(next:RangeKey)=>{setMode(next);if(next==='custom')return;const r={from:next==='today'?today:shift(today,next==='week'?-6:-29),to:today};setRange(r);setReport(null);setApplied(r);};
  return <section className="ceo-workspace screen" aria-busy={busy}>
    <div className="ceo-top"><Seg label={t('ceo.range')} value={mode} onChange={choose} disabled={busy} options={[['today',t('ceo.range.today')],['week',t('ceo.range.week')],['month',t('ceo.range.month')],['custom',t('ceo.range.custom')]]}/></div>
    {mode==='custom'&&<div className="ceo-filters"><Dates {...range} onChange={(from,to)=>setRange({from,to})} busy={busy} onSubmit={()=>{setReport(null);setApplied({...range});}}/></div>}
    {busy&&!report&&<p role="status" className="muted">{t('ceo.loading')}</p>}{error&&<p role="alert" className="ceo-error">{t('ceo.error')} <button disabled={busy} onClick={()=>void load()}>{t('ceo.retry')}</button></p>}{notice&&<p role="status" className="notice">{notice}</p>}
    {!error&&report&&<ReportView report={report}/>}
    <div className="ceo-more actions"><button className="quiet" disabled={busy||!report} onClick={()=>void exportFile('pdf')}><Icon name="export"/>{t('ceo.pdf')}</button><button className="quiet" disabled={busy||!report} onClick={()=>void exportFile('xlsx')}><Icon name="export"/>{t('ceo.excel')}</button></div>
  </section>;
}
export function ExportPanel({clinic,request}:ModuleProps) {
  useReportLocale();
  const [busy,setBusy]=useState(false),[error,setError]=useState(false),[done,setDone]=useState(false);
  const run=async()=>{setBusy(true);setError(false);setDone(false);try{saveBlob(await request<Blob>(`/api/clinics/${clinic.id}/reports/full-export`,{},false,10*60_000),'clinora-clinic.zip');setDone(true);}catch{setError(true);}finally{setBusy(false);}};
  return <section className="ceo-workspace screen"><h2 className="hero-name">{t('ceo.exportTitle')}</h2><p className="muted">{t('ceo.exportLead')}</p><Confirm label={t('ceo.full')} text={t('ceo.fullConfirm')} busy={busy} onConfirm={()=>void run()}/>{error&&<p role="alert">{t('ceo.error')}</p>}{done&&<p role="status">{t('ceo.downloaded')}</p>}</section>;
}
export const dashboardModule:WebModule={id:'dashboard',roles:['ceo'],label:'module.dashboard',Screen:Dashboard};
export const exportModule:WebModule={id:'exports',roles:['ceo'],label:'module.export',Screen:ExportPanel};
