import { useEffect,useState } from 'react';
import type { ModuleProps,WebModule } from '../modules.js';
import type { Report } from '../../modules/reports/actions.js';
import type { Download } from '../../modules/reports/exports.js';
import { ReportView } from '../ceo/dashboard.js';
import { t,saveFile,useReportLocale } from '../ceo/shared.js';
import { Icon } from '../shell.js';
export function CashReport({clinic,request,day,reportDayId}:ModuleProps) {
  useReportLocale();
  const [report,setReport]=useState<Report|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false);
  const [id,setId]=useState(()=>reportDayId??day?.day?.id??day?.openDay?.id??'');
  const [days,setDays]=useState<{id:string;business_date:string;status:string}[]>([]);
  useEffect(()=>{let active=true;void request<typeof days>(`/api/clinics/${clinic.id}/reports/days`).then(v=>{if(active){setDays(v);setId(old=>old||v[0]?.id||'');}}).catch(()=>{if(active)setError(true);});return()=>{active=false;};},[clinic.id,day?.day?.status]);
  useEffect(()=>{if(!id)return;let active=true;setBusy(true);setError(false);setReport(null);void request<Report>(`/api/clinics/${clinic.id}/reports/days/${id}`).then(v=>{if(active)setReport(v);}).catch(()=>{if(active)setError(true);}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[id,clinic.id,day?.day?.status]);
  const print=async(format:'pdf'|'thermal')=>{setBusy(true);setError(false);try{saveFile(await request<Download>(`/api/clinics/${clinic.id}/reports/days/${id}/print`,{format}));}catch{setError(true);}finally{setBusy(false);}};
  const dmy=(iso:string)=>iso.slice(0,10).split('-').reverse().join('.');
  return <section className="ceo-workspace screen"><h2 className="sr-only">{t('ceo.cashTitle')}</h2>
    <div className="report-head"><label>{t('ceo.day')}<select aria-label={t('ceo.day')} value={id} onChange={e=>setId(e.target.value)}>{days.map(d=><option key={d.id} value={d.id}>{dmy(d.business_date)} · {d.status==='closed'?t('ceo.snapshot'):t('ceo.open')}</option>)}</select></label>
      {report&&<div className="ceo-actions"><button disabled={busy} onClick={()=>void print('thermal')}><Icon name="print"/>{t('ceo.thermal')}</button><button disabled={busy} onClick={()=>void print('pdf')}><Icon name="export"/>{t('ceo.a4')}</button></div>}</div>
    {busy&&<p role="status" className="muted">{t('ceo.loading')}</p>}{error&&<p role="alert" className="error">{t('ceo.error')}</p>}{!id&&<p className="empty">{t('ceo.empty')}</p>}{report&&<ReportView report={report}/>}
  </section>;
}
export const reportsModule:WebModule={id:'reports',roles:['ceo','cashier','administrator'],label:'module.reports',Screen:CashReport};
