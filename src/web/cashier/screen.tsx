import { useEffect, useRef, useState } from 'react';
import type { ModuleProps, WebModule } from '../modules.js';
import { CashierPrint } from './print.js';
import { t, errorText } from '../i18n/index.js';
import { formatUzs, uzs } from '../../modules/billing/index.js';
type Row=Record<string,any>;
const money=(n:string)=>formatUzs(uzs(n));
export function Cashier({clinic,request}:ModuleProps){
 const base=`/api/clinics/${clinic.id}/cashier`;
 const [data,setData]=useState<Row>({desks:[],expenses:[],shifts:[],approvers:[]}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 const [desk,setDesk]=useState(''),[opening,setOpening]=useState('0'),[shift,setShift]=useState(''),[query,setQuery]=useState(''),[matches,setMatches]=useState<Row[]>([]),[visit,setVisit]=useState(''),[bill,setBill]=useState<Row|null>(null);
 const [amount,setAmount]=useState(''),[method,setMethod]=useState('cash'),[confirm,setConfirm]=useState(false),[reason,setReason]=useState(''),[approver,setApprover]=useState(''),[pin,setPin]=useState(''),[kind,setKind]=useState('fixed'),[lineId,setLineId]=useState(''),[payment,setPayment]=useState(''),[expense,setExpense]=useState(''),[counted,setCounted]=useState('0'),[printable,setPrintable]=useState<Row|null>(null);
 const paymentKey=useRef<{signature:string;key:string}|null>(null);const locked=useRef(false);
 async function load(){const d=await request<Row>(base);setData(d);setDesk(x=>x||d.desks[0]?.id||'');setShift(x=>x||d.shifts.find((s:Row)=>s.status==='open')?.id||'');setApprover(x=>x||d.approvers[0]?.id||'');setExpense(x=>x||d.expenses[0]?.id||'');}
 async function run(fn:()=>Promise<void>){if(locked.current)return;locked.current=true;setBusy(true);setError('');setSaved(false);try{await fn();setSaved(true);}catch(e){setError(errorText((e as {code:string}).code));}finally{setBusy(false);locked.current=false;}}
 useEffect(()=>{void run(load);},[clinic.id]);
 async function refresh(){if(visit)setBill(await request<Row>(`${base}/visits/${visit}`));await load();}
 async function sensitive(operation:string,payload:Row){let approvalId: string|undefined;
 if(!clinic.roles.some((r:string)=>r==='ceo'||r==='administrator')){const approved=await request<{approvalId:string}>(base+'/approvals',{approverId:approver,pin,visitId:visit,operation,payload});approvalId=approved.approvalId;setPin('');}
 const result=await request<Row>(`${base}/visits/${visit}/${operation}`,{...payload,...(approvalId?{approvalId}:{})});if(operation==='refund')setPrintable(result.snapshot);await refresh();}
 function keyFor(payload:Row){const signature=JSON.stringify(payload);if(paymentKey.current?.signature!==signature)paymentKey.current={signature,key:crypto.randomUUID()};return paymentKey.current.key;}
 const select=(label:Parameters<typeof t>[0],value:string,set:(s:string)=>void,rows:Row[],name:(r:Row)=>string)=><label>{t(label)}<select aria-label={t(label)} value={value} onChange={e=>set(e.target.value)}><option value="">—</option>{rows.map(r=><option key={r.id} value={r.id}>{name(r)}</option>)}</select></label>;
 const field=(label:Parameters<typeof t>[0],value:string,set:(s:string)=>void,numeric=false)=><label>{t(label)}<input value={value} inputMode={numeric?'numeric':undefined} onChange={e=>set(e.target.value)} /></label>;
 return <section className="cashier"><h2>{t('cashier.title')}</h2>{error&&<p role="alert">{error}</p>}{busy&&<p role="status">{t('cashier.loading')}</p>}{saved&&<p role="status">{t('cashier.saved')}</p>}
 <fieldset disabled={busy}>
 {!data.shifts.some((s:Row)=>s.status==='open')?<div>{select('cashier.desk',desk,setDesk,data.desks,r=>r.name)}{field('cashier.opening',opening,setOpening,true)}<button onClick={()=>void run(async()=>{const s=await request<Row>(base+'/shifts',{deskId:desk,opening});setShift(s.id);await load();})}>{t('cashier.open')}</button></div>:select('cashier.shift',shift,setShift,data.shifts.filter((s:Row)=>s.status==='open'),r=>data.desks.find((d:Row)=>d.id===r.cash_desk_id)?.name??r.id)}
 <form onSubmit={e=>{e.preventDefault();void run(async()=>{setMatches(await request<Row[]>(base+'/search',{query}));});}}>{field('cashier.search',query,setQuery)}<button>{t('cashier.find')}</button></form>
 {matches.map(p=><button key={p.id} onClick={()=>void run(async()=>{setVisit(p.id);setBill(await request<Row>(`${base}/visits/${p.id}`));setAmount('');})}>{p.patient_no} · {p.full_name}</button>)}
 {bill&&<><h3>{bill.patient.full_name}</h3>{[...new Set<string>(bill.lines.map((l:Row)=>l.doctor||l.department||t('cashier.visit')))].map(group=><section key={group}><h4>{group}</h4>{bill.lines.filter((l:Row)=>(l.doctor||l.department||t('cashier.visit'))===group).map((l:Row)=><p key={l.id}>{l.name} × {l.quantity} · {money(bill.invoice.lines.find((n:Row)=>n.id===l.id).payable)}</p>)}</section>)}
 <dl>{(['value','discount','paid','due'] as const).map(k=><div key={k}><dt>{t(`cashier.${k}`)}</dt><dd>{money(bill.invoice[k])}</dd></div>)}</dl>
 {field('cashier.amount',amount,setAmount,true)}<div className="keypad">{'1234567890'.split('').map(n=><button key={n} onClick={()=>setAmount(v=>(v+n).replace(/^0+(?=\d)/,''))}>{n}</button>)}<button aria-label={t('cashier.backspace')} onClick={()=>setAmount(v=>v.slice(0,-1))}>⌫</button></div>
 {select('cashier.method',method,setMethod,['cash','card','transfer'].map(id=>({id})),r=>t(`cashier.${r.id}` as 'cashier.cash'))}
 <button className="primary" disabled={!shift||!/^\d+$/.test(amount)||BigInt(amount||'0')===0n} onClick={()=>setConfirm(true)}>{t('cashier.take')}</button>
 {confirm&&<section role="dialog" aria-modal="true" aria-label={t('cashier.take')}><p>{t('cashier.confirm',{name:bill.patient.full_name,amount:money(amount),method:t(`cashier.${method}` as 'cashier.cash')})}</p><button onClick={()=>void run(async()=>{const payload={shiftId:shift,amount,method};const result=await request<Row>(`${base}/visits/${visit}/payments`,{...payload,key:keyFor(payload)});paymentKey.current=null;setPrintable(result.snapshot);setConfirm(false);await refresh();})}>{t('cashier.yes')}</button><button onClick={()=>setConfirm(false)}>{t('cashier.cancel')}</button></section>}
 <details><summary>{t('cashier.more')}</summary>
 {bill.receipts?.map((r:Row)=><button key={r.id} onClick={()=>void run(async()=>{const result=await request<Row>(`${base}/receipts/${r.id}/print`,{});setPrintable(result.snapshot);})}>{t('cashier.print')} · № {r.receipt_no}</button>)}
 {field('cashier.reason',reason,setReason)}{select('cashier.approver',approver,setApprover,data.approvers,r=>r.display_name)}<label>{t('cashier.pin')}<input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={e=>setPin(e.target.value)}/></label>
 {select('cashier.kind',kind,setKind,[{id:'fixed'},{id:'percent'}],r=>t(`cashier.${r.id}` as 'cashier.fixed'))}
 {select('cashier.target',lineId,setLineId,bill.lines,r=>r.name)}<button onClick={()=>void run(()=>sensitive('discount',{kind,amount,reason,...(lineId?{lineId}:{})}))}>{t('cashier.apply')}</button>
 {bill.discounts.map((d:Row)=><button key={d.id} onClick={()=>void run(()=>sensitive('void',{discountId:d.id,reason}))}>{t('cashier.void')} · {d.reason}</button>)}
 {select('cashier.payment',payment,setPayment,bill.payments.filter((p:Row)=>p.kind==='payment'),r=>`${money(r.amount_uzs)} · ${r.method}`)}
 <button onClick={()=>{if(window.confirm(t('cashier.refundConfirm',{amount:money(amount||'0')})))void run(async()=>{const p={shiftId:shift,paymentId:payment,amount,reason};await sensitive('refund',{...p,key:keyFor(p)});paymentKey.current=null;});}}>{t('cashier.refund')}</button>
 </details></>}
 <details><summary>{t('cashier.out')}</summary>{select('cashier.expense',expense,setExpense,data.expenses,r=>r.name_uz_cyrl)}{field('cashier.note',reason,setReason)}{field('cashier.amount',amount,setAmount,true)}<button onClick={()=>{if(window.confirm(t('cashier.outConfirm',{amount:money(amount||'0')})))void run(async()=>{const r=await request<Row>(`${base}/shifts/${shift}/cash-out`,{expenseId:expense,amount,note:reason});setPrintable(r);});}}>{t('cashier.out')}</button></details>
 {field('cashier.counted',counted,setCounted,true)}<button disabled={!shift} onClick={()=>{if(window.confirm(t('cashier.closeConfirm',{amount:money(counted)})))void run(async()=>{setPrintable(await request<Row>(`${base}/shifts/${shift}/close`,{counted}));setShift('');await load();});}}>{t('cashier.close')}</button>
 {data.shifts.filter((s:Row)=>s.status==='closed').map((s:Row)=><button key={s.id} onClick={()=>setPrintable(s.close_report)}>{t('cashier.report')} · {new Date(s.opened_at).toLocaleDateString()}</button>)}
 </fieldset>
 {printable&&<><button onClick={()=>window.print()}>{t('cashier.print')}</button><CashierPrint value={printable}/></>}
 </section>;
}
export const cashierModule:WebModule={id:'cashier',label:'module.payments',roles:['cashier','ceo','administrator'],Screen:Cashier};
