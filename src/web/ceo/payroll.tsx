import { useEffect,useState } from 'react';
import type { ModuleProps,WebModule } from '../modules.js';
import type { Download } from '../../modules/reports/exports.js';
import { Confirm,Dates,money,saveFile,t,Language,useReportLocale,type Key } from './shared.js';
type RuleRow={id:string;user_id:string;doctor_share_bp:number;basis:'paid'|'billed';discount_bearer:'clinic'|'doctor'|'proportional';categories:string[];effective_from:string;created_by_name:string};
type State={doctors:{id:string;display_name:string}[];history:RuleRow[];today:string;ceo:boolean};
type Earnings={from:string;to:string;period:{id:string;status:string}|null;lines:{charge_line_id:string;user_id:string;doctor:string;rule_id:string|null;status?:string;entitlement_uzs:string;from_receipts_uzs:string;clinic_funded_uzs:string}[]};
const kinds=['consultation','procedure','lab','diagnostic','bed','surgery','medicine','good','caretaker','other'];
export function Payroll({clinic,request,day,setDirty}:ModuleProps) {
  useReportLocale();
  const today=day?.today??new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Tashkent'}),[range,setRange]=useState({from:today.slice(0,8)+'01',to:today});
  const [state,setState]=useState<State|null>(null),[result,setResult]=useState<Earnings|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [doctor,setDoctor]=useState(''),[categories,setCategories]=useState(['consultation']),[effective,setEffective]=useState(new Date(Date.parse(today)+86400000).toISOString().slice(0,10));
  const [formKey,setFormKey]=useState(0);
  const base=`/api/clinics/${clinic.id}/payroll`;
  const loadRules=async()=>{const v=await request<State>(base+'/rules');setState(v);setDoctor(d=>d||v.doctors[0]?.id||'');};
  useEffect(()=>{let active=true;setBusy(true);void request<State>(base+'/rules').then(v=>{if(active){setState(v);setDoctor(v.doctors[0]?.id??'');}}).catch(()=>{if(active)setError(t('ceo.error'));}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;setDirty(false);};},[clinic.id]);
  const run=async(action:()=>Promise<void>,message=t('ceo.payrollError'))=>{setBusy(true);setError('');setNotice('');try{await action();}catch{setError(message);}finally{setBusy(false);}};
  const calculate=()=>run(async()=>{setResult(await request<Earnings>(base+'/earnings',range));});
  const rule=state?.history.find(r=>r.user_id===doctor&&r.effective_from<=today);
  const history=state?.history.filter(r=>r.user_id===doctor)??[];
  const saveRule=(event:React.FormEvent<HTMLFormElement>)=>{
    event.preventDefault();const data=new FormData(event.currentTarget),percent=String(data.get('share')),parts=percent.split('.');
    if(!/^\d{1,3}(\.\d{1,2})?$/.test(percent)){setError(t('ceo.ruleError'));return;}
    const shareBp=Number(parts[0])*100+Number((parts[1]??'').padEnd(2,'0'));
    void run(async()=>{await request(base+'/rules',{userId:doctor,shareBp,basis:data.get('basis'),discountBearer:data.get('bearer'),categories,effectiveFrom:effective});await loadRules();setDirty(false);setNotice(t('ceo.ruleSaved'));setResult(null);},t('ceo.ruleError'));
  };
  const groups=new Map<string,{name:string;earned:bigint;receipts:bigint;funded:bigint;lines:Earnings['lines']}>();
  for(const line of result?.lines??[]){const g=groups.get(line.user_id)??{name:line.doctor,earned:0n,receipts:0n,funded:0n,lines:[]};g.earned+=BigInt(line.entitlement_uzs);g.receipts+=BigInt(line.from_receipts_uzs);g.funded+=BigInt(line.clinic_funded_uzs);g.lines.push(line);groups.set(line.user_id,g);}
  return <section className="ceo-workspace"><header className="ceo-heading"><div><p className="ceo-eyebrow">{t('ceo.eyebrow')}</p><h2>{state?.ceo?t('ceo.payrollTitle'):t('ceo.myPay')}</h2><p>{t('ceo.payrollLead')}</p></div></header>
    <Language/><Dates {...range} onChange={(from,to)=>{setRange({from,to});setResult(null);}} onSubmit={()=>void calculate()} busy={busy}/>
    {busy&&<p role="status">{t('ceo.loading')}</p>}{error&&<p className="ceo-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {result&&<section className="ceo-pay-results"><span className="ceo-live">{result.period?t('ceo.final'):t('ceo.draft')}</span><p>{result.from} — {result.to}</p>
      {groups.size===0?<p className="ceo-empty">{t('ceo.empty')}</p>:[...groups].map(([id,g])=><details className="ceo-pay-doctor" key={id}><summary><span>{g.name}</span><strong>{g.lines.some(l=>l.status==='rule_missing')?t('ceo.ruleMissing'):money(g.earned)+' '+t('ceo.uzs')}</strong></summary><dl><div><dt>{t('ceo.receipts')}</dt><dd>{money(g.receipts)}</dd></div><div><dt>{t('ceo.funded')}</dt><dd>{money(g.funded)}</dd></div></dl><ul className="ceo-pay-lines">{g.lines.map(l=><li key={l.charge_line_id}><span>{l.charge_line_id}<small>{l.status==='rule_missing'?t('ceo.ruleMissing'):l.rule_id}</small></span><strong>{money(l.entitlement_uzs)}</strong></li>)}</ul></details>)}
      {state?.ceo&&<div className="ceo-actions">{!result.period&&<Confirm label={t('ceo.finalize')} text={t('ceo.finalConfirm')} busy={busy} onConfirm={()=>{const missing=[...groups.values()].filter(g=>g.lines.some(l=>l.status==='rule_missing')).map(g=>g.name);if(missing.length){setError(t('ceo.ruleMissing')+': '+missing.join(', '));return;}void run(async()=>{setResult(await request<Earnings>(base+'/finalize',{from:result.from,to:result.to}));});}}/>}
        {(['pdf','xlsx'] as const).map(format=><button key={format} disabled={busy} onClick={()=>void run(async()=>{saveFile(await request<Download>(base+'/export',{from:result.from,to:result.to,format}));})}>{format==='pdf'?t('ceo.pdf'):t('ceo.excel')}</button>)}
      </div>}
    </section>}
    <p className="ceo-footnote">{t('ceo.periodNote')}</p>
    {state&&<section className="ceo-rules"><h3>{t('ceo.rules')}</h3><label>{t('ceo.doctor')}<select aria-label={t('ceo.doctor')} value={doctor} disabled={busy} onChange={e=>{setDoctor(e.target.value);setFormKey(k=>k+1);setDirty(false);}}>{state.doctors.map(d=><option key={d.id} value={d.id}>{d.display_name}</option>)}</select></label>
      {rule?<div className="ceo-rule-current"><strong>{rule.doctor_share_bp/100}%</strong><span>{t(`ceo.${rule.basis}`)} · {t('ceo.bearer')}: {t(`ceo.${rule.discount_bearer}`)}<br/>{t('ceo.effective')}: {rule.effective_from}</span></div>:<p>{t('ceo.noRule')}</p>}
      {state.ceo&&<details className="ceo-more"><summary>{t('ceo.saveRule')}</summary><form key={formKey} onSubmit={saveRule} onChange={()=>setDirty(true)}><div className="ceo-rule-grid"><label>{t('ceo.share')}<input name="share" type="text" inputMode="decimal" pattern="[0-9]{1,3}([.][0-9]{1,2})?" defaultValue={rule?String(rule.doctor_share_bp/100):''} required/></label><label>{t('ceo.basis')}<select aria-label={t('ceo.basis')} name="basis" defaultValue={rule?.basis??'paid'}><option value="paid">{t('ceo.paid')}</option><option value="billed">{t('ceo.billed')}</option></select></label><label>{t('ceo.bearer')}<select aria-label={t('ceo.bearer')} name="bearer" defaultValue={rule?.discount_bearer??'proportional'}>{['clinic','doctor','proportional'].map(v=><option value={v} key={v}>{t(`ceo.${v}` as Key)}</option>)}</select></label><label>{t('ceo.effective')}<input type="date" required min={today} value={effective} onChange={e=>setEffective(e.target.value)}/></label></div>
        <fieldset><legend>{t('ceo.kinds')}</legend><div className="ceo-kind-grid">{kinds.map(k=><label key={k}><input type="checkbox" checked={categories.includes(k)} onChange={e=>setCategories(old=>e.target.checked?[...old,k]:old.filter(v=>v!==k))}/>{t(`ceo.${k}` as Key)}</label>)}</div></fieldset><p className="ceo-footnote">{t('ceo.ruleNote')}</p><button className="ceo-primary" disabled={busy||!doctor||!categories.length}>{t('ceo.saveRule')}</button></form></details>}
      <details className="ceo-more"><summary>{t('ceo.history')}</summary>{!history.length?<p>{t('ceo.empty')}</p>:<ol className="ceo-history">{history.map(r=><li key={r.id}><strong>{r.doctor_share_bp/100}% · {t(`ceo.${r.basis}`)}</strong><p>{r.effective_from} · {r.created_by_name}</p><p>{t('ceo.bearer')}: {t(`ceo.${r.discount_bearer}`)}</p><p>{r.categories.map(k=>t(`ceo.${k}` as Key)).join(' · ')}</p></li>)}</ol>}</details>
    </section>}
  </section>;
}
export const payrollModule:WebModule={id:'payroll',roles:['ceo','doctor'],label:'module.payroll',Screen:Payroll};
