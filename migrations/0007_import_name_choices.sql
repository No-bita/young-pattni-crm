-- Keep each resolved number/name and its original source rows with the batch.
ALTER TABLE contact_imports ADD COLUMN name_choices_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE contact_imports ADD COLUMN sheet_name TEXT;
