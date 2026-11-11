// Remote CI proof only. Temporarily execute the reviewed server module against
// current regressions, then restore the exact candidate before aggregate checks.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';

const run=promisify(execFile), file='src/server/notebook.ts';
const reviewed='b348991c87363eda79d30f983b7d46478dda9105';
if(!process.env.TEST_DATABASE_URL)throw new Error('Explicit dedicated PostgreSQL test configuration required');
const candidate=await readFile(file);
const {stdout:baseline}=await run('git',['show',`${reviewed}:${file}`]);
let output='',exitCode=0;
try {
  await writeFile(file,baseline);
  try {
    const result=await run(process.execPath,['--import','tsx','--test','tests/integration/replay-authorization.test.ts'],{maxBuffer:4*1024*1024});
    output=result.stdout+result.stderr;
  } catch(error) {
    exitCode=error.code;output=String(error.stdout??'')+String(error.stderr??'');
  }
} finally { await writeFile(file,candidate); }
await mkdir('work',{recursive:true});
await writeFile('work/task-002a-before.log',output);
assert.equal(exitCode,1,'reviewed code must fail the authorization regressions');
const failures=[...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
assert.deepEqual(failures.sort(),[
  'cached and fresh draft saves reject mismatched patient/encounter while both assignments remain active',
  'cached draft cannot be replayed through another permitted patient after original assignment revocation',
  'patient-create replay reauthorizes stored patient and never recreates a chart or restores revoked assignment'
].sort(),'only the three reviewed authorization failures are expected');
assert.deepEqual([...output.matchAll(/^\s+expected: (\d+)$/gm)].map(match=>Number(match[1])).sort(),[404,404,404]);
assert.deepEqual([...output.matchAll(/^\s+actual: (\d+)$/gm)].map(match=>Number(match[1])).sort(),[200,200,201],
  'the reviewed code must disclose successful cached responses where the regressions require 404');
assert.match(output,/# pass 2\b/,'stale authorized retries and concurrent creates must still work on the reviewed code');
await run('git',['diff','--exit-code','--',file]);
console.log('Reviewed behavior reproduced: 3 authorization regressions fail; 2 compatibility cases pass. Candidate source restored unchanged.');
