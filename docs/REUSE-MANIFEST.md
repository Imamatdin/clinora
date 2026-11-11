# Source provenance and reuse decisions

Assessed locally on 11 November 2026. **No upstream code has been copied into
`src/`** in increment 0. The new contracts/policy tests and status shell are original
foundation code. Reuse candidates below are deliberately not represented as active
features or inherited security controls. Source references remain under ignored
`work/`; no original archive, environment file, dump, credential or patient dataset
is included in the deliverable. No public redistribution license was found in the
documentation-app checkout; confirm rights before publishing reused code/assets.

## Inputs verified here

| Input | Identity | Local assessment location |
| --- | --- | --- |
| Documentation app | `https://github.com/Mashaaa2004/clinora-ai-doc-assist.git`, detached commit `f9ab0582ebecff663928469898dfd6166932107f`; fetched default HEAD is the same commit | `work/doc-assist/` |
| Small CRM | `https://github.com/Mashaaa2004/clinora.git`, commit `1a0a44e8d8ad6429fd5c25d5f25ad728e5641bfc` | `work/small-crm/` |
| Larger CRM archive | `CRM_исходный_код.zip`, SHA-256 `38677ddbcb0572dbba33dfd70a70f3ef4e1729a7c228f2cfa01cd9ea59c0ecf4` | Selected text/code from `Downloads/Telegram Desktop` into `work/crm/CRM/` |
| Developer archive | `Clinora_код_для_разработчиков.zip`, SHA-256 `1a353377a32bbeffbfa044b8d01f181e2e4cca554d12787bd32fcf7d7a52fe4b` | Selected text/code into `work/developer-pack/` |

Archive extraction excluded environment files, runtime-data/upload/backup/secret/
infra folders, Git metadata, dependencies and binary assets. Relative paths were
checked for traversal. The developer pack's README reports Dentora source provenance
to commit `44996579bb1b46f29d0d0a8370be2b241aa88b6e`; this is an archive-author
report, not an independently verified running-container identity. The universal
clinic tree and preliminary contracts were inspected but not installed or built.
The unrelated `.dt` database files also present in Downloads were not opened/imported.

## Decisions by capability

| Capability | Decision and reusable source paths | Reason / required adaptation |
| --- | --- | --- |
| Authentication | **Replace** small CRM `server.ts`; **repair/adapt candidate** larger CRM `backend/runtime/security.ts`, `auth-session-boundaries.test.ts` | Small CRM stores and compares plaintext passwords, accepts registration role and exposes patient routes without authorization middleware. Larger CRM has scrypt, hashed session tokens, secure cookies and revocation tests that pass, but is coupled to its Store/workspace roles. Do not copy its app/config or role grants wholesale. |
| Clinic permissions | **Replace shared access contract**, adapt tested denial cases from larger CRM security/workspace modules later | Documentation app `src/pages/Auth.tsx` sends doctor metadata, migrations assign doctor to non-patients. Larger CRM's branch/workspace mapping is not proof of this product's clinic/patient isolation. New explicit membership policy is original code. |
| Patient / encounter persistence | **Repair/adapt design**, defer code reuse: larger CRM `database/connection.ts`, `store.ts`, `schema.ts`; documentation `drizzle/schema.ts` | CRM actually supports both SQLite and PostgreSQL. Its SQL translation (`json_extract`, implicit inserts, LIKE) and generic records require review before typed clinical use. The supplied README's SQLite-only summary is incomplete relative to current archive code. Session tests used SQLite `:memory:`; PostgreSQL branch remains UNVERIFIED. Choose one fresh typed PostgreSQL history rather than importing generic dental records/two migration chains. |
| UI components | **Keep candidates**, defer copying: documentation `src/components/ui/button.tsx`, `dialog.tsx`, form primitives; CRM common workspace components | React primitives are potentially reusable; full dental workspace includes odontogram/finance/localization coupling and CRM uses React 19. No clinical form has been rebuilt here. Foundation uses a small React 18 status screen; retain useful primitives when real forms arrive. |
| Speech capture | **Keep pure helper candidate**, **repair hook boundary**: documentation `src/lib/audio-pcm.ts`, `src/hooks/useAishaStt.ts`, `supabase/functions/aisha-stt/index.ts` | Pure PCM helper is isolated. Hook resumes audio on gesture, but uses Supabase session/client, query-string token and provider websocket protocol. Adapt to authoritative clinic authorization, non-leaking session transport, interrupted capture, segment identity and correction preservation. No microphone/provider test yet. |
| Clinical extraction | **Keep safety/retrieval ideas**, repair implementation boundary: documentation `supabase/functions/_shared/clinical-grounding.ts` and `src/test/clinical-grounding.test.ts` | Separates reported/observed findings and verified reference passages. Prompt assertions and identifier regexes do not establish safe/redacted clinical behavior; need typed proposals, validated patient-scoped evidence and clinician evaluation. No model requests run. |
| Approval | **Keep audit/version intent**, replace persistence contract: documentation `drizzle/migrations/0002_verified_protocols_and_clinician_drafts.sql`, `0003_enforce_approved_document_audit.sql`, `0004_secure_clinical_workflow.sql`, `src/lib/clinical-source.ts` | Server draft/audit functions are useful reference. Browser fingerprint is only an edit signal. New foundation requires immutable version snapshots and exact clinic/patient/current-version approval; no upstream SQL executed. |
| Telegram linking | **Repair/adapt verifier candidate**, larger CRM `backend/runtime/security.ts` (`telegramIdentity`, `telegramWidgetIdentity`) and `app.ts` `/api/auth/telegram` | Signed initData age/hash verification is reusable after review. Actual route logs in as **patient**, not doctor. Explicit authenticated link and clinic grant are separate; no automatic name/phone match. No bot token or live flow used. |
| Integration adapters | **Keep delivery/reconciliation patterns**, defer endpoints: larger CRM `backend/runtime/integrations.ts`, `database/store.ts` queue methods | Actual code sends Bitrix lead metadata, treats Desk32 delivery as read-only, and is dental/CRM-workflow coupled. No verified clinical-document destination. Future adapter must accept approved snapshot, external ID, idempotency and uncertain-write reconciliation. No existing adapter is claimed as Clinora integration. |
| Preliminary clinical contracts | **Replace with expanded validated contracts**, developer pack `clinora_candidate_contracts/contracts.ts` | File explicitly says preliminary/unintegrated. Status-string release checks are not server access or approval enforcement. Specialty/template ideas retained for later tasks, insurance behavior is outside this assignment. |

## Isolated upstream dependency repair

Original documentation-app `npm ci --ignore-scripts --no-audit --no-fund
--fetch-retries=0 --fetch-timeout=20000` failed with ERESOLVE: its React Router 8
resolution requires React >=19.2.7 but the app uses React 18.3.1. Its lock also drifts
on Supabase, Recharts and newly added packages. In `work/doc-assist` only, pin
`react-router` and `react-router-dom` to **6.30.1**, matching the previously locked
API family, then run `npm install --ignore-scripts --no-audit --no-fund` to regenerate
the reference lock. No force/legacy-peer-deps flags were used. Other package
requirements were retained. No changes were made to a remote or production source.

This reference repair is not the new core's dependency set. The new core has no
router dependency in increment 0 and one minimal consistent lockfile. Reference
install/build/test outcomes and remaining failures are in the dated handoff.
