import type { ComponentType } from 'react';
import type { Request } from '../api.js';

/** What a panel inside the doctor's visit screen receives. The server authorizes every call it makes. */
export type VisitPanelProps = { clinicId: string; patientId: string; encounterId: string; request: Request; onChanged: () => void };
export type VisitPanel = { id: string; Panel: ComponentType<VisitPanelProps> };

/**
 * Panels mounted in the visit screen under the note. Each feature registers one line from the app entry
 * (src/web/main.tsx), e.g. task 003C's doctor assistant. `onChanged` lets a panel ask the visit screen to
 * reload the note, for example after an assistant approval.
 */
export const VISIT_PANELS: VisitPanel[] = [];
export function registerVisitPanel(panel: VisitPanel) {
  if (VISIT_PANELS.some(p => p.id === panel.id)) throw new Error(`Visit panel ${panel.id} registered twice`);
  VISIT_PANELS.push(panel);
}
