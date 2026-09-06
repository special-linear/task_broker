CREATE TABLE claim_sort_indexes (
 id TEXT PRIMARY KEY,
 pool_id TEXT NOT NULL REFERENCES pools(id),
 name TEXT NOT NULL,
 sorts_json TEXT NOT NULL CHECK(json_valid(sorts_json)),
 dependencies_json TEXT NOT NULL CHECK(json_valid(dependencies_json)),
 revision INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'unbuilt' CHECK(status IN('unbuilt','ready','invalid')),
 index_name TEXT NOT NULL UNIQUE,
 created_at INTEGER NOT NULL,
 built_at INTEGER,
 UNIQUE(pool_id,name)
);
CREATE INDEX claim_sort_pool ON claim_sort_indexes(pool_id,id);
UPDATE installation SET schema_version=4 WHERE id=1;
