import PDFDocument from 'pdfkit';
import { join } from 'node:path';
import type { InvoiceView } from './contracts.js';
import { inpatient as labels } from '../../web/i18n/inpatient.uz-Cyrl.js';

export function renderInvoice(invoice:InvoiceView):Promise<Buffer> {
  const doc=new PDFDocument({size:'A4',margin:45,info:{Title:'Clinora inpatient invoice'}});
  const chunks:Buffer[]=[];
  const result=new Promise<Buffer>((resolve,reject)=>{doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  doc.font(join(process.cwd(),'assets/fonts/DejaVuSans.ttf')).fontSize(16).text(invoice.clinic).text(labels['inpatient.invoice']);
  doc.moveDown().fontSize(11).text(`${invoice.patient} · № ${invoice.patientNo}`).text(invoice.issuedAt).text(invoice.admissionId).moveDown();
  for(const l of invoice.lines) {
    if(doc.y>730)doc.addPage();
    doc.text(`${l.name} · ${l.quantity} × ${l.price} = ${l.value} ${labels['inpatient.uzs']}`,{paragraphGap:6});
  }
  doc.moveDown();
  for(const k of ['value','discount','payable','paid','due'] as const)doc.text(`${labels[`inpatient.${k}`]}: ${invoice[k]} ${labels['inpatient.uzs']}`);
  doc.end();return result;
}
