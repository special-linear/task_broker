-- Additive: retain old definitions and label imported history without inventing attempts.
ALTER TABLE installation ADD COLUMN receipt_retention_ms INTEGER NOT NULL DEFAULT 172800000 CHECK(receipt_retention_ms>=172800000);
UPDATE installation SET receipt_retention_ms=max(172800000,86400000+1000*COALESCE((SELECT max(json_extract(policy_json,'$.max_lifetime_seconds')) FROM (SELECT policy_json FROM families UNION ALL SELECT policy_json FROM profiles UNION ALL SELECT defaults_json policy_json FROM installation)),86400));
CREATE TABLE legacy_imports (
 task_uid TEXT PRIMARY KEY REFERENCES tasks(task_uid),
 operation_id TEXT NOT NULL, imported_at INTEGER NOT NULL,
 source_json TEXT NOT NULL CHECK(json_valid(source_json)),
 raw_result_json TEXT CHECK(raw_result_json IS NULL OR json_valid(raw_result_json)),
 historical_attempts INTEGER NOT NULL DEFAULT 0 CHECK(historical_attempts>=0),
 imported_completed INTEGER NOT NULL DEFAULT 0 CHECK(imported_completed IN(0,1))
);
CREATE INDEX profile_scope ON profiles(pool_id,id);
CREATE INDEX attempts_sequence ON attempts(task_uid,attempt_sequence DESC);
CREATE INDEX operation_status ON admin_operation_items(operation_id,status,ordinal);
UPDATE installation SET schema_version=3 WHERE id=1;
