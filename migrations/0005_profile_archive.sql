ALTER TABLE profiles ADD COLUMN archived_at INTEGER;
UPDATE installation SET schema_version=5 WHERE id=1;
