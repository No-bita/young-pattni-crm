-- Springboard v1 initial schema.
-- Every table that holds customer data carries account_id, and every query filters by it.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  login TEXT NOT NULL UNIQUE,              -- stored lowercased
  password_hash TEXT NOT NULL,             -- pbkdf2:<iterations>:<saltHex>:<hashHex>
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,             -- SHA-256 of the cookie value; raw token is never stored
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_account ON sessions(account_id);

-- A WhatsApp number an account sends from. Exactly one may be active per account.
CREATE TABLE senders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  token_ref TEXT NOT NULL,                 -- token lives in the Worker secret WA_TOKEN_<token_ref>
  phone_number_id TEXT NOT NULL UNIQUE,    -- a Meta phone number id belongs to one account only
  waba_id TEXT NOT NULL,
  display_number TEXT,
  verified_name TEXT,
  status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive', 'active', 'retired')),
  tested_at TEXT,
  test_error TEXT,
  activated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX unq_one_active_sender ON senders(account_id) WHERE status = 'active';
CREATE INDEX idx_senders_account ON senders(account_id);

-- Templates synced from Meta, per sender (templates belong to the sender's WABA).
CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  sender_id TEXT NOT NULL REFERENCES senders(id),
  waba_id TEXT NOT NULL,
  meta_template_id TEXT,
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL,                    -- as reported by Meta: APPROVED, PENDING, REJECTED, PAUSED, ...
  body_text TEXT,
  body_param_count INTEGER NOT NULL DEFAULT 0,
  has_header_media INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL,
  UNIQUE (sender_id, name, language)
);
CREATE INDEX idx_templates_account ON templates(account_id);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  phone_e164 TEXT NOT NULL,                -- digits only, with country code, no '+' (e.g. 919876543210)
  name TEXT NOT NULL DEFAULT '',
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK (suppressed IN (0, 1)),
  suppressed_at TEXT,
  suppressed_source TEXT,                  -- 'meta_stop' | 'admin'
  last_inbound_at TEXT,                    -- drives the 24-hour reply window
  last_message_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (account_id, phone_e164)
);
CREATE INDEX idx_contacts_account_created ON contacts(account_id, created_at DESC);
CREATE INDEX idx_contacts_account_last_msg ON contacts(account_id, last_message_at DESC);

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  template_name TEXT NOT NULL,
  template_language TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '[]',  -- one entry per body variable: {"type":"contact_name","fallback":"..."} | {"type":"text","value":"..."}
  audience_json TEXT,                      -- the confirmed audience: JSON array of contact ids. NULL = not chosen yet
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'completed', 'cancelled')),
  sender_id TEXT REFERENCES senders(id),   -- set at launch; the number this campaign used
  confirmed_count INTEGER,
  scheduled_at TEXT,
  launched_at TEXT,
  completed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_campaigns_account ON campaigns(account_id, created_at DESC);
CREATE INDEX idx_campaigns_due ON campaigns(status, scheduled_at);

-- The stored audience. Rows are created when the audience is saved; launch reads only these rows.
CREATE TABLE campaign_recipients (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped_suppressed', 'cancelled')),
  message_id TEXT,
  error TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (campaign_id, contact_id)
);
CREATE INDEX idx_recipients_campaign ON campaign_recipients(account_id, campaign_id, status);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  sender_id TEXT NOT NULL REFERENCES senders(id),  -- which number sent or received it
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  kind TEXT NOT NULL CHECK (kind IN ('template', 'text', 'inbound')),
  body TEXT,
  template_name TEXT,
  campaign_id TEXT REFERENCES campaigns(id),
  wamid TEXT,                              -- Meta message id
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'delivered', 'read', 'failed', 'received')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX unq_messages_sender_wamid ON messages(sender_id, wamid) WHERE wamid IS NOT NULL;
CREATE INDEX idx_messages_contact ON messages(account_id, contact_id, created_at);
CREATE INDEX idx_messages_sender ON messages(account_id, sender_id, created_at DESC);
