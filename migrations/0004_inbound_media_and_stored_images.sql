-- Incoming photos/voice notes kept privately in R2, and header images kept so they can be re-uploaded
-- to Meta. Additive only. Retention: nothing is deleted automatically (owner decision, 12 Nov 2026).

-- One row per incoming image or audio message. Meta's media id is server-side only.
CREATE TABLE inbound_media (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  sender_id TEXT NOT NULL REFERENCES senders(id),     -- the number that received it (its token downloads it)
  kind TEXT NOT NULL CHECK (kind IN ('image', 'audio')),
  voice INTEGER NOT NULL DEFAULT 0 CHECK (voice IN (0, 1)), -- 1 = recorded in WhatsApp as a voice note
  meta_media_id TEXT NOT NULL,
  declared_mime_type TEXT,
  declared_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'downloading', 'stored', 'failed', 'unavailable')),
  attempts INTEGER NOT NULL DEFAULT 0,
  stored_mime_type TEXT,
  byte_size INTEGER,
  sha256 TEXT,                 -- hex SHA-256 of the stored bytes
  sha256_matches_meta INTEGER, -- 1/0 when Meta's value could be compared, NULL if not
  r2_key TEXT,
  error TEXT,
  received_at TEXT NOT NULL,
  stored_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (message_id)
);
CREATE INDEX idx_inbound_media_account ON inbound_media(account_id, received_at DESC);

-- Header images: the original file kept privately so the CRM can upload it again to Meta.
ALTER TABLE media_assets ADD COLUMN r2_key TEXT;  -- NULL = uploaded before storage existed (Meta-only, 30-day rules)

-- Every Meta upload of an asset, per number. Media ids are tied to the number that uploaded them.
CREATE TABLE media_meta_uploads (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  asset_id TEXT NOT NULL REFERENCES media_assets(id),
  sender_id TEXT NOT NULL REFERENCES senders(id),
  meta_media_id TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  expires_at TEXT NOT NULL      -- uploaded_at + 30 days (Meta's documented lifetime)
);
CREATE INDEX idx_meta_uploads_asset ON media_meta_uploads(account_id, asset_id, sender_id, expires_at DESC);

-- Existing assets become their first upload record.
INSERT INTO media_meta_uploads (id, account_id, asset_id, sender_id, meta_media_id, uploaded_at, expires_at)
  SELECT 'mmu_' || lower(hex(randomblob(16))), account_id, id, sender_id, meta_media_id, uploaded_at, expires_at FROM media_assets;

-- The Meta upload a launched campaign sends with (chosen or re-uploaded at start).
ALTER TABLE campaigns ADD COLUMN meta_upload_id TEXT REFERENCES media_meta_uploads(id);
