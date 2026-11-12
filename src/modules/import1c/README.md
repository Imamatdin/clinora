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

## `.dt` layout: what is confirmed and what is assumed

- Confirmed by the planner on the real files: `1CIBDmpF` + one version digit, raw deflate from byte 9.
- **Assumed, not yet verified on a real file:** the inflated stream is a sequence of top-level brace lists, one per
  metadata object; the first string is the object's full name (`Справочник.МУОЛАЖА`); each nested list is a record of
  `{field name, value}` pairs; references are UUIDs. Field names are matched through aliases (`dt.ts`, `ALIASES`).
  Parents are resolved by what the reference points at (БУЛИМ, МИХИЛАР, Туман), not by field name.
- Prices: the reader looks for a price field on the item (`Нархи`, `Нарх`, `Цена`, …) and for information registers
  whose name contains нарх/цен/price. Where Gʻofurov klinikasi actually stores prices is reported by the local run.
- Strings may be UTF-16LE or single-byte; both are handled.

## Privacy property

Objects outside the allowlist (БЕМОРЛАР, every Документ, РегистрНакопления, …) are skipped by the tokenizer without
decoding a value; they appear in the report by name only. Мумкун and Каровчи are read for structure only (field names,
record count). Tests plant marker text in patient, caretaker and document objects and assert it never appears.

## Local real-file run (Imamatdin)

```
mkdir -p data/private   # gitignored, as is *.dt
node --import tsx scripts/inspect-1c-dump.ts data/private/<file>.dt
```

Prints object names, record counts and field names of catalog objects, where prices were found, rejected-row
reasons, Мумкун/Каровчи structure and 5 sample services. If the layout is not recognized it prints a byte-pattern
probe instead (statistics and object names only). Paste the output into the handoff; it contains no patient data.
