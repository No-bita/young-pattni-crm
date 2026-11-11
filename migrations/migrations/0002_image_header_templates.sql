-- Image-header template support. Additive only: no existing column, row or behaviour is removed.

-- Template shape as reported by Meta. NULL header_format = synced before this migration
-- (those rows keep the previous rule: usable only when has_header_media = 0, until the next sync).
ALTER TABLE templates ADD COLUMN header_format TEXT;            -- NONE | TEXT | IMAGE | VIDEO | DOCUMENT | LOCATION | GIF | ...
ALTER TABLE templates ADD COLUMN header_param_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE templates ADD COLUMN header_text TEXT;              -- TEXT headers only, for the preview
ALTER TABLE templates ADD COLUMN buttons_json TEXT;             -- sanitized summary: [{"type":"QUICK_REPLY","text":"..."}]
ALTER TABLE templates ADD COLUMN unsupported_reason TEXT;       -- NULL = this app can send it

-- One uploaded image per row. Bytes are NOT stored: the file goes straight to Meta through the
-- sender's phone number, and only Meta's media id is kept (never a download URL).
CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  sender_id TEXT NOT NULL REFERENCES senders(id),  -- the number it was uploaded through; only that number sends it
  kind TEXT NOT NULL CHECK (kind IN ('image')),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png')),
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  original_name TEXT,
  meta_media_id TEXT NOT NULL,             -- server-side only; never accepted from the browser
  uploaded_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,                -- uploaded_at + 30 days (Meta's documented media id lifetime)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_media_assets_account ON media_assets(account_id, created_at DESC);

-- The campaign's chosen image, and the content frozen at launch/schedule time.
ALTER TABLE campaigns ADD COLUMN media_asset_id TEXT REFERENCES media_assets(id);
ALTER TABLE campaigns ADD COLUMN frozen_header_format TEXT;
ALTER TABLE campaigns ADD COLUMN frozen_body_text TEXT;
ALTER TABLE campaigns ADD COLUMN frozen_body_param_count INTEGER;

-- Send history: which image a message carried.
ALTER TABLE messages ADD COLUMN media_asset_id TEXT REFERENCES media_assets(id);
