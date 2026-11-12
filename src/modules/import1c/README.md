# Catalog import: 1C `.dt`, `.xlsx`, `.csv` (task 005, C3)

## Flow

1. The administrator picks a file in the catalog screen. **It is parsed in the browser** (`src/web/catalog/files.ts`) with the
   same reader the tests use. Only catalog rows (`ImportRow`, `model.ts`) are sent. The raw dump, which holds БЕМОРЛАР, never
   leaves the administrator's computer.
   Why not upload the dump: Cloud Run requests stop at 15 s (app) / 30 s (platform), instances have 512 MiB and can be two,
   and storing the dump server-side would store patient records.
2. `POST catalog/imports` creates a batch; `POST catalog/imports/:id/rows` uploads pages (< 80 kB, position-addressed, so a
   retried page overwrites itself); `GET catalog/imports/:id` previews; `POST .../commit` applies in one transaction;
   `POST .../discard` drops it. Administrator role only. The server re-validates every row (zod) and decides matching,
   prices and rejections (`plan.ts`). Preview and commit run the same `buildPlan`, so they cannot drift.

## Matching and prices

- Rows match existing rows by `code_1c`, or (spreadsheets without codes) by folded name. `.dt` codes are namespaced by
  1C object (`МУОЛАЖА/10902002002000003`) because several 1C catalogs become `services`.
- Import never deletes, deactivates or clears; an empty source field keeps the stored value. An existing service keeps
  its kind (kind is frozen by trigger).
- A price on the item row is "the price now": if it differs from the price in force at commit time a new
  `service_prices` row is added (`effective_from = commit time`). A dated price register row keeps its date (a date is
  midnight in the clinic's time zone); the same date with a different price is rejected (`PRICE_CONFLICT`).
- Re-importing the same file plans zero writes (tested).

## Verified `.dt` format (task 018)

The reader ports `scripts/reference/dt_reference.py`: format-3 raw deflate, binary bracket tags,
`Params/DBNames` UUID-to-table/field mapping, Config catalog names/attribute names, then schema-ordered
DataBase lists (including subtables). Version fields are omitted; NULL flags consume no value.
Physical table/field numbers are resolved through metadata, rather than assumed.

Inflated bytes are capped at 64 MiB (the two real files are 4–5 MiB). Binary scalar payloads stay byte
spans until a permitted catalog field is selected. This bounds browser memory without creating a decoded
copy of all patient records. Unsupported tags fail with their offset and byte; malformed nesting, lengths,
schema/list alignment, row flags and truncation stop the import without partial rows.

Services use НАРХИ and БУЛИМ; lab items use Цена and Норма, with lab folders as service groups.
МИХИЛАР is a tax classifier, never a service group. МИХИ supplies `services.mxik_code`, shown in
all three catalog locales. Reference ranges and non-authorizing source doctor flags are retained.
Room types also produce bed services with their daily prices. Excel/CSV parsing and the staged
preview/commit workflow retain task 005's matching, validation and price-history rules.

## Privacy

БЕМОРЛАР, Каровчи and every non-allowlisted table are skipped before any row value is decoded.
Doctor ПАРОЛ/Телефон fields and unapproved attributes remain raw spans, never output. Tests intercept
text decoding itself, in addition to checking the returned rows and browser upload requests.

## Local real-file check

```
node --import tsx scripts/inspect-1c-dump.ts data/private/<file>.dt
```

Only catalog counts/field names and sample service prices are printed. Do not commit dumps, extracted
records, or CI logs. The planner still independently accepts real-file counts for the candidate commit.
The real mahallas have no resolvable district; they remain visible to preview but the existing
`NO_DISTRICT` rule rejects creating them until a district is supplied. No district is guessed.
