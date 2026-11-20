ALTER TABLE templates ADD COLUMN default_media_asset_id TEXT REFERENCES media_assets(id);
