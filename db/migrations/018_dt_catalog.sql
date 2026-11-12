-- Task 018: reference data only. Flags describe 1C doctors and grant no permissions.
ALTER TABLE services ADD COLUMN mxik_code text;
ALTER TABLE services ADD COLUMN reference_range text;
ALTER TABLE catalog_doctors ADD COLUMN source_role_flags jsonb;
