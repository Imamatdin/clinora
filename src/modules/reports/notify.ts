import type { ApiConfig } from '../../server/notebook.js';
import { transaction } from '../../server/database.js';
import { renderNotice } from '../telegram/notify.js';
/** Transactional outbox: known successes are retained per recipient. Delivery is at least once:
 * an uncertain network outcome or a worker crash can produce a duplicate notice on retry. */
export async function dispatchReports(config:ApiConfig,clinicId?:string) {
  if(!config.telegram)return;
  const telegram=config.telegram;
  await transaction(config.pool,async tx=>{
    const notice=(await tx.query(`SELECT * FROM report_notices WHERE completed_at IS NULL AND next_attempt_at<=now()
      AND ($1::uuid IS NULL OR clinic_id=$1) ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,[clinicId??null])).rows[0];
    if(!notice)return;
    const recipients=(await tx.query(`SELECT DISTINCT l.telegram_user_id::text chat FROM telegram_links l
      JOIN accounts a ON a.id=l.account_id AND a.status='active'
      JOIN memberships m ON m.user_id=l.account_id AND m.clinic_id=l.clinic_id AND m.status='active'
      JOIN membership_roles r ON r.user_id=m.user_id AND r.clinic_id=m.clinic_id AND r.role='ceo'
      WHERE l.clinic_id=$1`,[notice.clinic_id])).rows;
    const delivered=new Set<string>(notice.delivered_chats);let failed=0;
    for(const row of recipients){
      if(delivered.has(row.chat))continue;
      try {
        const result=await telegram.api.call('sendMessage',{chat_id:row.chat,...renderNotice('day.closed',notice.totals,'uz-Cyrl',`${config.origin}/?report=${notice.business_day_id}`)});
        if(result.ok)delivered.add(row.chat);else failed++;
      }catch{failed++;}
      await tx.query('SELECT 1'); // Keep the short API timeout below the transaction idle timeout.
    }
    await tx.query(`UPDATE report_notices SET attempted_at=now(),attempts=attempts+1,delivered_chats=$2,sent=$3,failed=$4,
      completed_at=CASE WHEN $4=0 THEN now() ELSE NULL END,
      next_attempt_at=now()+make_interval(secs=>least(3600, power(2,least(attempts+1,12))::int)) WHERE id=$1`,[notice.id,[...delivered],delivered.size,failed]);
  });
}
export function startReportWorker(config:ApiConfig) {
  let running=false,stopped=false;
  const tick=async()=>{if(running||stopped||!config.telegram)return;running=true;try{await dispatchReports(config);}catch{/* Durable pending row is retried on the next tick. */}finally{running=false;}};
  const timer=setInterval(()=>void tick(),1000);timer.unref();
  return ()=>{stopped=true;clearInterval(timer);};
}
