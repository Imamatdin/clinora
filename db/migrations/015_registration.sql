-- Task 007 (increment C4): registration search and duplicate overrides. Tables for patients, visits,
-- queues and charges come from 010_core_schema.sql; this file only adds what registration needs on top.

-- Script-insensitive name key. Uzbek Cyrillic, Uzbek Latin and Russian-style spellings of one name fold
-- to the same lowercase Latin skeleton, so "Ҳасанов", "Hasanov" and "Хасанов" match each other.
-- Rules, in order: lowercase; Cyrillic letters to Latin (ў->o, қ->q, ғ->g, ҳ->h, ц->s, ы->i, э->e,
-- ё/ю/я/ж/ч/ш/щ to digraphs, ъ/ь dropped); apostrophes and modifier letters dropped (oʻ->o, gʻ->g);
-- then kh->x, h->x, q->k, ye->e, ts->s, zh->j, dj->j (common transliteration variants); anything that is
-- not a letter or digit becomes one space. Recall over precision: this key is for search and duplicate
-- warnings only, never for identity.
CREATE FUNCTION registration_fold(input text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(
    replace(replace(replace(replace(replace(replace(replace(replace(
      regexp_replace(
        replace(replace(replace(replace(replace(replace(replace(
          translate(lower(coalesce(input, '')), 'абвгдезийклмнопрстуфхцыэўқғҳъь', 'abvgdeziyklmnoprstufxsieoqgh'),
          'ё', 'yo'), 'ж', 'j'), 'ч', 'ch'), 'ш', 'sh'), 'щ', 'sh'), 'ю', 'yu'), 'я', 'ya'),
        '[ʻʼ''`‘’ʹ]', '', 'g'),
      'kh', 'x'), 'h', 'x'), 'q', 'k'), 'ye', 'e'), 'ts', 's'), 'zh', 'j'), 'dj', 'j'), 'w', 'v'),
    '[^a-z0-9]+', ' ', 'g'))
$$;

-- A registrar who proceeds despite a duplicate warning records why. Kept out of audit_events because
-- the reason is free text that may name people; audit gets only the counts.
CREATE TABLE patient_duplicate_overrides (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), patient_id uuid NOT NULL,
  matched_patient_ids uuid[] NOT NULL CHECK (cardinality(matched_patient_ids) > 0),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  created_by uuid NOT NULL REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients(clinic_id, id)
);
CREATE TRIGGER patient_duplicate_overrides_append_only BEFORE UPDATE OR DELETE ON patient_duplicate_overrides
  FOR EACH ROW EXECUTE FUNCTION core_append_only();

-- Duplicate check on name + birth date uses the folded key.
CREATE INDEX patients_fold_name_birth ON patients(clinic_id, registration_fold(full_name), birth_date);
