import type { ApiConfig } from '../../server/notebook.js';
import { transaction } from '../../server/database.js';
import { notifyStaff } from '../telegram/notify.js';

/** Claim after commit, then attempt once. A failed/uncertain send is recorded, never blindly retried. */
export async function dispatchReports(config:ApiConfig,clinicId:string) {
  if(!config.telegram)return;
  const notice=await transaction(config.pool,async tx=>(await tx.query(`UPDATE report_notices SET attempted_at=now() WHERE id=(SELECT id FROM report_notices WHERE clinic_id=$1 AND attempted_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,[clinicId])).rows[0]);
  if(!notice)return;
  let sent=0,failed=1;
  try {
    const result=await notifyStaff(config.pool,config.telegram,`${config.origin}/?report=${notice.business_day_id}`,{clinicId,to:{role:'ceo'},template:'day.closed',params:notice.totals});
    sent=result.sent;failed=result.failed;
  } finally { await config.pool.query('UPDATE report_notices SET sent=$2,failed=$3 WHERE id=$1',[notice.id,sent,failed]); }
}
