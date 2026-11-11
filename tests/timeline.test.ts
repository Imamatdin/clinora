import test from 'node:test';
import assert from 'node:assert/strict';
import type { Encounter } from '../src/contracts/index.js';
import type { VisitView } from '../src/contracts/notebook.js';
import { sortVisits } from '../src/contracts/timeline.js';
import { version,scope,ids } from './fixtures.js';

test('timeline uses elapsed time across offsets, preserves date-only precision and places unknown dates last',()=>{
  const visit=(id:string,occurrence:Encounter['occurrence']):VisitView=>({
    encounter:{id,...scope,clinicianId:ids.user,location:{id:null,label:'Synthetic room'},specialty:'General medicine',occurrence,
      status:'draft',createdAt:'2026-11-11T00:00:00Z',updatedAt:'2026-11-11T00:00:00Z',revision:1,provenance:{source:'manual',externalReference:null}},
    clinicianName:'Synthetic',documentId:version.documentId,version:null,revision:0
  });
  const a=visit('earlier',{precision:'instant',at:'2026-11-11T10:00:00+05:00',timezone:'Asia/Tashkent'});
  const b=visit('later',{precision:'instant',at:'2026-11-11T06:00:00Z',timezone:'UTC'});
  const date=visit('date',{precision:'date',date:'2020-02-29',timezone:'Asia/Tashkent'});
  const unknown=visit('unknown',{precision:'unknown',reason:'Undated source'});
  const input=[unknown,a,date,b];assert.deepEqual(sortVisits(input).map(v=>v.encounter.id),['later','earlier','date','unknown']);
  assert.equal(input[0],unknown);assert.deepEqual(date.encounter.occurrence,{precision:'date',date:'2020-02-29',timezone:'Asia/Tashkent'});
});
