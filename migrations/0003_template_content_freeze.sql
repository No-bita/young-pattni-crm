-- Keeps the parts of a template that change what recipients get, and freezes them per campaign.
-- Additive only. Not stored: example values, approval sample media (header_handle), raw API responses.
ALTER TABLE templates ADD COLUMN footer_text TEXT;
ALTER TABLE templates ADD COLUMN content_json TEXT;        -- normalized: header{format,text}, body{text}, footer{text}, buttons[{type,text,url,phone_number}]

ALTER TABLE campaigns ADD COLUMN frozen_content_json TEXT; -- the content the user picked (set at create / template change)
ALTER TABLE campaigns ADD COLUMN content_checked_at TEXT;  -- when the template was last compared before launch/schedule/start
ALTER TABLE campaigns ADD COLUMN content_check_source TEXT CHECK (content_check_source IN ('meta', 'local_fallback'));
ALTER TABLE campaigns ADD COLUMN content_check_note TEXT;  -- why the local copy was used, if Meta could not be asked
ALTER TABLE campaigns ADD COLUMN send_deadline TEXT;       -- after this, queued recipients are not sent
ALTER TABLE campaign_recipients ADD COLUMN failure_code TEXT;   -- e.g. 'DEADLINE' when the sending window ended before this send
