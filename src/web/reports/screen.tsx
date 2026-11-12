import { useEffect,useState } from 'react';
import type { ModuleProps,WebModule } from '../modules.js';
import type { Report } from '../../modules/reports/actions.js';
import type { Download } from '../../modules/reports/exports.js';
import { ReportView } from '../ceo/dashboard.js';
import { t,saveFile,Language,useReportLocale } from '../ceo/shared.js';
export function CashReport({clinic,request,day,reportDayId}:ModuleProps) {
  useReportLocale();
  const [report,setReport]=useState<Report|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false);
  const [id,setId]=useState(()=>reportDayId??day?.day?.id??day?.openDay?.id??'');
  const [days,setDays]=useState<{id:string;business_date:string;status:string}[]>([]);
  useEffect(()=>{let active=true;void request<typeof days>(`/api/clinics/${clinic.id}/reports/days`).then(v=>{if(active){setDays(v);setId(old=>old||v[0]?.id||'');}}).catch(()=>{if(active)setError(true);});return()=>{active=false;};},[clinic.id,day?.day?.status]);
  useEffect(()=>{if(!id)return;let active=true;setBusy(true);setError(false);setReport(null);void request<Report>(`/api/clinics/${clinic.id}/reports/days/${id}`).then(v=>{if(active)setReport(v);}).catch(()=>{if(active)setError(true);}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[id,clinic.id,day?.day?.status]);
  const print=async(format:'pdf'|'thermal')=>{setBusy(true);setError(false);try{saveFile(await request<Download>(`/api/clinics/${clinic.id}/reports/days/${id}/print`,{format}));}catch{setError(true);}finally{setBusy(false);}};
  return <section className="ceo-workspace"><header className="ceo-heading"><div><h2>{t('ceo.cashTitle')}</h2><p>{t('ceo.cashLead')}</p></div></header><label>{t('ceo.day')}<select aria-label={t('ceo.day')} value={id} onChange={e=>setId(e.target.value)}>{days.map(d=><option key={d.id} value={d.id}>{d.business_date} · {d.status==='closed'?t('ceo.snapshot'):t('ceo.open')}</option>)}</select></label>
    <Language/>{busy&&<p role="status">{t('ceo.loading')}</p>}{error&&<p role="alert">{t('ceo.error')}</p>}{!id&&<p>{t('ceo.empty')}</p>}{report&&<><ReportView report={report}/><div className="ceo-actions"><button className="ceo-primary" disabled={busy} onClick={()=>void print('thermal')}>{t('ceo.thermal')}</button><button disabled={busy} onClick={()=>void print('pdf')}>{t('ceo.a4')}</button></div></>}
  </section>;
}
export const reportsModule:WebModule={id:'reports',roles:['ceo','cashier','administrator'],label:'module.reports',Screen:CashReport};
