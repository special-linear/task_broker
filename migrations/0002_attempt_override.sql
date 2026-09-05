-- Distinguish inherited task attempt limits from an explicit unlimited value.
ALTER TABLE tasks ADD COLUMN max_attempts_set INTEGER NOT NULL DEFAULT 0 CHECK(max_attempts_set IN(0,1));
UPDATE tasks SET max_attempts_set=1 WHERE max_attempts IS NOT NULL;
UPDATE installation SET schema_version=2 WHERE id=1;
