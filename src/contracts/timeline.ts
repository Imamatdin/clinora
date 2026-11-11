import type { VisitView } from './notebook.js';

export function sortVisits(visits: readonly VisitView[]): VisitView[] {
  const key=(v:VisitView)=>{
    const o=v.encounter.occurrence;
    return o.precision==='instant'?new Date(o.at).toISOString():o.precision==='date'?o.date:'';
  };
  return [...visits].sort((a,b)=>key(b).localeCompare(key(a))||b.encounter.createdAt.localeCompare(a.encounter.createdAt)||a.encounter.id.localeCompare(b.encounter.id));
}
