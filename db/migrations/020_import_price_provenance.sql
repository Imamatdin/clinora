-- Task 019: 1C import provenance on price rows, so a re-import compares with the price last imported
-- from 1C for that service, not with a manual price set after it, and an identical file changes nothing.

ALTER TABLE service_prices ADD COLUMN import_batch_id uuid,
  ADD CONSTRAINT service_prices_import_batch_fk FOREIGN KEY (clinic_id, import_batch_id) REFERENCES import_batches(clinic_id, id);
CREATE INDEX service_prices_imported_idx ON service_prices(clinic_id, service_id, effective_from DESC) WHERE import_batch_id IS NOT NULL;

-- Hash of the committed staged rows (canonical JSON in sequence order). Together with the file hash it
-- identifies an identical import: the same spreadsheet mapped differently produces different rows.
ALTER TABLE import_batches ADD COLUMN rows_sha256 text CHECK (rows_sha256 IS NULL OR rows_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN duplicate_of uuid,
  ADD CONSTRAINT import_batches_duplicate_fk FOREIGN KEY (clinic_id, duplicate_of) REFERENCES import_batches(clinic_id, id);
CREATE INDEX import_batches_content_idx ON import_batches(clinic_id, content_sha256) WHERE status = 'committed';

-- Backfill: an import commit writes its price rows and finishes its batch in one transaction, so both carry
-- the same now(). Only rows set by the batch's committer at that instant are attributed; nothing else changes.
ALTER TABLE service_prices DISABLE TRIGGER service_prices_append_only;
UPDATE service_prices p SET import_batch_id = b.id
  FROM import_batches b
 WHERE b.clinic_id = p.clinic_id AND b.status = 'committed' AND b.finished_at = p.created_at AND b.finished_by = p.set_by
   AND p.import_batch_id IS NULL;
ALTER TABLE service_prices ENABLE TRIGGER service_prices_append_only;
