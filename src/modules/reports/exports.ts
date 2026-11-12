import PDFDocument from 'pdfkit';
import { zipSync, strToU8 } from 'fflate';
import { join } from 'node:path';
import { requireRole, recordAudit, type ClinicContext } from '../../server/roles.js';
import type { Report } from './actions.js';

export type Download = {name:string;mime:string;base64:string};
export const csv = (rows:unknown[][]) => '\ufeff'+rows.map(r=>r.map(v=>{
  const raw=typeof v==='object'?JSON.stringify(v):String(v??'');
  // Spreadsheet programs must never interpret exported patient/staff input as a formula.
  return '"'+(/^[=+@\-\t\r]/.test(raw)?"'"+raw:raw).replaceAll('"','""')+'"';
}).join(',')).join('\r\n');
const xml=(v:unknown)=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
/** Minimal standards-based XLSX. All values are explicit strings so UZS never loses precision. */
export function xlsx(rows:unknown[][]):Buffer {
  const files:Record<string,Uint8Array>={}; const put=(p:string,s:string)=>files[p]=strToU8(s);
  put('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  put('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  put('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Clinora" sheetId="1" r:id="rId1"/></sheets></workbook>');
  put('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  put('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="20" width="28" customWidth="1"/></cols><sheetData>'+rows.map((r,i)=>`<row r="${i+1}">`+r.map(v=>`<c t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`).join('')+'</row>').join('')+'</sheetData></worksheet>');
  return Buffer.from(zipSync(files));
}
export async function pdf(title:string,rows:unknown[][],thermal=false):Promise<Buffer> {
  const doc=new PDFDocument({size:thermal?[226.77,841.89]:'A4',margin:thermal?14:42,bufferPages:true});
  doc.registerFont('body',join(process.cwd(),'assets/fonts/DejaVuSans.ttf'));
  const chunks:Buffer[]=[]; const done=new Promise<Buffer>((resolve,reject)=>{doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  doc.font('body').fillColor('#392c3e').fontSize(thermal?13:20).text(title).moveDown();
  for(const row of rows)doc.fontSize(thermal?9:10).fillColor('#252229').text(row.map(v=>String(v??'')).join('  ·  '),{paragraphGap:7});
  doc.end();return done;
}
export const download=(name:string,mime:string,data:Buffer):Download=>({name,mime,base64:data.toString('base64')});
export const LABELS:Record<string,string>={patients:'Беморлар',new:'Янги беморлар',returning:'Қайта келганлар',outpatient:'Амбулатор',inpatient:'Стационар',value:'Хизматлар қиймати',discounts:'Чегирмалар',outstanding:'Қолдиқ қарз',collected:'Тушум',cash:'Нақд',card:'Карта',transfer:'Ўтказма',refunds:'Қайтарилган',cashOuts:'Касса харажатлари',net:'Соф тушум',lab:'Лаборатория тушуми',ward:'Стационар тушуми'};
export async function reportExport(c:ClinicContext,report:Report,format:'pdf'|'xlsx'|'thermal',cashPrint=false) {
  await requireRole(c.tx,c.actorId,c.clinicId,cashPrint?['ceo','administrator','cashier']:['ceo']);
  const rows:unknown[][]=[[report.clinic,report.from,report.to],...Object.entries(report.totals).map(([k,v])=>[LABELS[k],v]),[],['Шифокор','Тушум, сўм'],...report.doctors.map(d=>[d.name,d.amount]),[],['Бўлим','Тушум, сўм'],...report.departments.map(d=>[d.name,d.amount])];
  for(const s of report.cashShifts??[])rows.push([],['Кассир',s.cashier,s.date],['Смена',s.id],['Бошланғич нақд',s.opening],['Кутилаётган нақд',s.expected],['Саналган нақд',s.counted??'Қайд этилмаган'],['Фарқ',s.difference??'Қайд этилмаган']);
  if(format!=='thermal')for(const [key,lines]of Object.entries(report.details))rows.push([],[LABELS[key],'Сана','Манба','Миқдор'],...lines.map(l=>[l.id,l.date,l.label,l.amount]));
  await recordAudit(c.tx,c.actorId,c.clinicId,'reports.exported',c.clinicId,{format,from:report.from,to:report.to});
  return format==='xlsx'?download('clinora-report.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xlsx(rows)):download('clinora-report.pdf','application/pdf',await pdf('Касса ва клиника ҳисоботи',rows,format==='thermal'));
}
export async function fullExport(c:ClinicContext) {
  await requireRole(c.tx,c.actorId,c.clinicId,['ceo']);
  // Explicit clinical/operational allowlist. Authentication tokens, passwords, invite codes,
  // provider credentials and replay caches never belong in a portable clinic archive.
  const tables=['patients','patient_assignments','patient_duplicate_overrides','encounters','documents','document_versions','note_approvals','assistant_transcripts','assistant_segments','assistant_drafts','assistant_extraction_runs','assistant_proposals','assistant_field_versions','assistant_approvals','visits','business_days','departments','services','service_groups','service_prices','doctor_profiles','catalog_doctors','doctor_services','queue_points','queue_tickets','charge_lines','discounts','payments','payment_allocations','cashier_allocation_adjustments','receipts','cash_desks','cash_shifts','expense_types','cash_outs','admissions','rooms','room_types','beds','bed_assignments','bed_day_charges','caretakers','caretaker_day_charges','lab_results','surgeries','stock_movements','pharmacy_settings','doctor_split_rules','payroll_periods','payroll_lines','clinic_settings','districts','mahallas','membership_roles','audit_events'];
  // A single statement keeps all exported tables in the same snapshot.
  const sql:string[]=[];
  // Cast bigint columns before JSON encoding (including nested record fields via row projection).
  const projections=await c.tx.query(`SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=ANY($1::text[]) ORDER BY ordinal_position`,[tables]);
  for(let i=0;i<tables.length;i++){
    const cols=projections.rows.filter(r=>r.table_name===tables[i]).map(r=>`"${r.column_name}"${r.data_type==='bigint'?'::text':''}`);
    sql[i]=`coalesce((SELECT jsonb_agg(t) FROM (SELECT ${cols.join(',')} FROM ${tables[i]} WHERE clinic_id=$1) t),'[]') t${i}`;
  }
  const all=(await c.tx.query('SELECT '+sql.join(','),[c.clinicId])).rows[0];
  const files:Record<string,Uint8Array>={};
  for(let i=0;i<tables.length;i++){
    const rows=all[`t${i}`] as Record<string,unknown>[]; const cols=projections.rows.filter(r=>r.table_name===tables[i]).map(r=>r.column_name as string);
    files[`${tables[i]}.csv`]=strToU8(csv([cols,...rows.map(r=>cols.map(k=>r[k]))]));
  }
  const staff=(await c.tx.query(`SELECT a.id,a.display_name,a.login,a.phone,m.status FROM accounts a JOIN memberships m ON m.user_id=a.id WHERE m.clinic_id=$1`,[c.clinicId])).rows;
  files['staff.csv']=strToU8(csv([['id','display_name','login','phone','status'],...staff.map(a=>[a.id,a.display_name,a.login,a.phone,a.status])]));
  files['README.txt']=strToU8('Clinora clinic data export. UTF-8 CSV; integer UZS. Authentication secrets excluded. Sensitive clinical data: store with restricted access.');
  await recordAudit(c.tx,c.actorId,c.clinicId,'reports.full_export',c.clinicId,{tables:tables.length+1});
  return download('clinora-clinic.zip','application/zip',Buffer.from(zipSync(files)));
}
