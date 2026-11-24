-- Named imports retain metadata and outcomes, not the uploaded file.
CREATE TABLE contact_imports (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  filename TEXT,
  request_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('importing','completed','partial','failed')),
  source_rows INTEGER NOT NULL,
  duplicates INTEGER NOT NULL DEFAULT 0,
  invalid_json TEXT NOT NULL DEFAULT '[]',
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, request_key)
);
CREATE INDEX idx_contact_imports_account ON contact_imports(account_id, created_at DESC);
CREATE TABLE contact_import_members (
  import_id TEXT NOT NULL REFERENCES contact_imports(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  outcome TEXT NOT NULL CHECK(outcome IN ('created','updated','unchanged')),
  source_row INTEGER NOT NULL,
  PRIMARY KEY(import_id, contact_id)
);
CREATE INDEX idx_import_members_contact ON contact_import_members(account_id,contact_id,import_id);
