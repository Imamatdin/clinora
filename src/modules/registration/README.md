# Registration, visits and queues (task 007, C4)

Server actions in `actions.ts` (zod in, typed out, roles rechecked, idempotency key, audit in the same
transaction); routes in `src/server/routes/registration.ts`; screen in `src/web/registration/`.

| Action | Route (under `/api/clinics/:clinicId/`) | Roles |
| --- | --- | --- |
| `options` | `GET registration/options` | registrar, administrator, ceo |
| `search` | `POST registration/search` `{query}` | same |
| `duplicates` | `POST registration/duplicates` `{fullName, birthDate?, phone?}` | same |
| `registerPatient` | `POST registration/patients` | same |
| `patient` / `updatePatient` | `GET`/`POST registration/patients/:id` | same |
| `createVisit` | `POST registration/visits` `{patientId, points:[{queuePointId, serviceIds}]}` | same |
| `ticketsHtml` | `GET registration/visits/:id/tickets` (HTML, 80 mm) | same |
| `myQueue` | `GET queue/mine` | doctor |
| `callNext` | `POST queue/call-next` `{queuePointId?}` | doctor (own point), administrator, ceo |
| `setTicketStatus` | `POST queue/tickets/:id/status` `{status}` | same |

Rules worth knowing before reuse (offline sync in task 016, doctor screen in C6):

- A visit needs the clinic's open business day; tickets of a closed day are invisible to the queue API and cannot change.
- Queue numbers come from `nextQueueNumber` inside the visit transaction; points are locked in id order to avoid deadlocks.
- Routing to a doctor point inserts `patient_assignments`; that row is what gives the doctor access (task-002 check). Lab and department points do not grant patient access.
- Charge lines are `ordered`, `source='registration'`, priced by `priceAt(now())`; an unpriced service rejects the whole visit.
- Duplicate warning: same phone, or same folded name + birth date. Proceeding needs `duplicateReason`, stored in `patient_duplicate_overrides` (free text never goes to audit).
- Name search folds Cyrillic and Latin spellings with `registration_fold()` (migration 015): every query word must occur in the folded name. It treats x/h/kh, q/k, oʻ/o, gʻ/g, ye/e, ts/s as equal. No trigram index yet; a sequential scan is fine for one clinic's patient count and should be revisited past ~200k patients.
- Tickets show clinic name, queue point, number, patient number, date and time; never the patient name or services.
