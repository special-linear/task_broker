PRAGMA foreign_keys = ON;

CREATE TABLE installation (
 id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL DEFAULT 1,
 config_revision INTEGER NOT NULL DEFAULT 1, active_epoch TEXT NOT NULL DEFAULT '',
 setup_status TEXT NOT NULL DEFAULT 'closed' CHECK(setup_status IN ('closed','ready')),
 maintenance INTEGER NOT NULL DEFAULT 1 CHECK(maintenance IN (0,1)),
 defaults_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(defaults_json)),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
INSERT INTO installation(id,created_at,updated_at) VALUES(1,0,0);
CREATE TABLE administrators(subject TEXT PRIMARY KEY,email TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),created_at INTEGER NOT NULL);
CREATE TABLE families (
 id TEXT PRIMARY KEY,slug TEXT NOT NULL UNIQUE COLLATE NOCASE,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)),default_profile_id TEXT,
 policy_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(policy_json)),config_revision INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL,archived_at INTEGER
);
CREATE TABLE pools (
 id TEXT PRIMARY KEY,owner_family_id TEXT NOT NULL REFERENCES families(id),name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)),archived_at INTEGER,
 schema_version INTEGER NOT NULL DEFAULT 1,migration_status TEXT NOT NULL DEFAULT 'ready' CHECK(migration_status IN('ready','migrating')),
 active_cap INTEGER DEFAULT 100 CHECK(active_cap IS NULL OR active_cap>=0),total_attempt_cap INTEGER CHECK(total_attempt_cap IS NULL OR total_attempt_cap>=0),
 required_result INTEGER NOT NULL DEFAULT 0 CHECK(required_result IN(0,1)),config_revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL
);
CREATE TABLE pool_fields (
 id TEXT PRIMARY KEY,pool_id TEXT NOT NULL REFERENCES pools(id),kind TEXT NOT NULL CHECK(kind IN('input','result')),
 key TEXT NOT NULL COLLATE NOCASE,label TEXT NOT NULL,type TEXT NOT NULL CHECK(type IN('string','integer','number','boolean','datetime','json')),
 required INTEGER NOT NULL DEFAULT 0,nullable INTEGER NOT NULL DEFAULT 1,default_json TEXT CHECK(default_json IS NULL OR json_valid(default_json)),
 pointer TEXT,position INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,UNIQUE(pool_id,key)
);
CREATE TABLE schema_versions (
 pool_id TEXT NOT NULL REFERENCES pools(id),version INTEGER NOT NULL,fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
 provenance_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(provenance_json)),created_at INTEGER NOT NULL,PRIMARY KEY(pool_id,version)
);
CREATE TABLE profiles (
 id TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES families(id),pool_id TEXT NOT NULL REFERENCES pools(id),slug TEXT NOT NULL COLLATE NOCASE,
 name TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,policy_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(policy_json)),
 mandatory_filter TEXT NOT NULL DEFAULT '',projection_json TEXT CHECK(projection_json IS NULL OR json_valid(projection_json)),
 filter_allowlist_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(filter_allowlist_json)),config_revision INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL,UNIQUE(family_id,slug)
);
CREATE TABLE profile_aliases(route TEXT PRIMARY KEY COLLATE NOCASE,profile_id TEXT NOT NULL REFERENCES profiles(id),deprecated_at INTEGER);
CREATE TABLE api_keys (
 id TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES families(id),label TEXT NOT NULL,prefix TEXT NOT NULL,secret_digest TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','soft_revoked','hard_revoked')),issued_at INTEGER NOT NULL,revoked_at INTEGER,last_used_at INTEGER
);
CREATE TABLE tasks (
 task_uid TEXT PRIMARY KEY,pool_id TEXT NOT NULL REFERENCES pools(id),task_id TEXT NOT NULL,
 parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json)),tags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags_json)),
 input_revision INTEGER NOT NULL DEFAULT 1,input_hash TEXT NOT NULL,input_contract_revision INTEGER NOT NULL DEFAULT 1,
 edit_revision INTEGER NOT NULL DEFAULT 1,state_revision INTEGER NOT NULL DEFAULT 1,lease_generation INTEGER NOT NULL DEFAULT 0,
 attempt_sequence INTEGER NOT NULL DEFAULT 0,attempts_total INTEGER NOT NULL DEFAULT 0,lifetime_attempts INTEGER NOT NULL DEFAULT 0,
 enabled INTEGER NOT NULL DEFAULT 1,admin_note TEXT NOT NULL DEFAULT '',max_attempts INTEGER CHECK(max_attempts IS NULL OR max_attempts>=0),
 valid INTEGER NOT NULL DEFAULT 1,latest_attempt_id TEXT,completed_at INTEGER,result_attempt_id TEXT,
 result_summary_json TEXT CHECK(result_summary_json IS NULL OR json_valid(result_summary_json)),previous_result INTEGER NOT NULL DEFAULT 0,
 deleted_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(pool_id,task_id)
);
CREATE TABLE task_identifiers(pool_id TEXT NOT NULL REFERENCES pools(id),public_id TEXT NOT NULL,task_uid TEXT NOT NULL REFERENCES tasks(task_uid),active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(pool_id,public_id));
CREATE TABLE task_tags(task_uid TEXT NOT NULL REFERENCES tasks(task_uid),tag TEXT NOT NULL,display TEXT NOT NULL,PRIMARY KEY(task_uid,tag));
CREATE INDEX tags_lookup ON task_tags(tag,task_uid);
CREATE TABLE task_profile_state (
 task_uid TEXT NOT NULL REFERENCES tasks(task_uid),profile_id TEXT NOT NULL REFERENCES profiles(id),attempts INTEGER NOT NULL DEFAULT 0,
 lifetime_attempts INTEGER NOT NULL DEFAULT 0,last_grant_at INTEGER,permanent_failure INTEGER NOT NULL DEFAULT 0,
 failure_message TEXT,failure_details_json TEXT,reset_at INTEGER,PRIMARY KEY(task_uid,profile_id)
);
CREATE TABLE input_snapshots (
 id TEXT PRIMARY KEY,task_uid TEXT NOT NULL REFERENCES tasks(task_uid),input_revision INTEGER NOT NULL,input_hash TEXT NOT NULL,
 parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json)),tags_json TEXT NOT NULL CHECK(json_valid(tags_json)),schema_version INTEGER NOT NULL,
 UNIQUE(task_uid,input_revision,input_hash)
);
CREATE TABLE attempts (
 id TEXT PRIMARY KEY,task_uid TEXT NOT NULL REFERENCES tasks(task_uid),profile_id TEXT NOT NULL REFERENCES profiles(id),family_id TEXT NOT NULL REFERENCES families(id),
 pool_id TEXT NOT NULL REFERENCES pools(id),task_id TEXT NOT NULL,identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
 attempt_sequence INTEGER NOT NULL,lease_generation INTEGER NOT NULL,instance_epoch TEXT NOT NULL,worker_id TEXT NOT NULL,issuing_key_id TEXT NOT NULL REFERENCES api_keys(id),
 lease_token TEXT NOT NULL,issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,maximum_expires_at INTEGER NOT NULL,
 input_snapshot_id TEXT NOT NULL REFERENCES input_snapshots(id),input_revision INTEGER NOT NULL,input_hash TEXT NOT NULL,
 contract_json TEXT NOT NULL CHECK(json_valid(contract_json)),returned_data_json TEXT NOT NULL CHECK(json_valid(returned_data_json)),
 attempts INTEGER NOT NULL,attempts_total INTEGER NOT NULL,
 outcome TEXT CHECK(outcome IN('success','release','permanent_failure')),outcome_hash TEXT,
 message TEXT,details_json TEXT CHECK(details_json IS NULL OR json_valid(details_json)),
 mapped_json TEXT CHECK(mapped_json IS NULL OR json_valid(mapped_json)),finalized_at INTEGER,runtime_seconds REAL,server_elapsed_seconds REAL,
 runtime_origin TEXT,late INTEGER NOT NULL DEFAULT 0,revoked_at INTEGER,revoke_reason TEXT,
 UNIQUE(task_uid,attempt_sequence)
);
CREATE TABLE attempt_results(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),raw_json TEXT NOT NULL CHECK(json_valid(raw_json)));
CREATE TABLE lease_heads (
 task_uid TEXT PRIMARY KEY REFERENCES tasks(task_uid),attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
 pool_id TEXT NOT NULL,profile_id TEXT NOT NULL,family_id TEXT NOT NULL,worker_id TEXT NOT NULL,issuing_key_id TEXT NOT NULL,
 instance_epoch TEXT NOT NULL,lease_generation INTEGER NOT NULL,expires_at INTEGER NOT NULL
);
CREATE INDEX heads_pool ON lease_heads(pool_id,expires_at);
CREATE INDEX heads_profile ON lease_heads(profile_id,expires_at);
CREATE INDEX heads_worker ON lease_heads(profile_id,worker_id,expires_at);
CREATE INDEX heads_family ON lease_heads(family_id,expires_at);
CREATE INDEX heads_family_worker ON lease_heads(family_id,worker_id,expires_at);
CREATE INDEX heads_key ON lease_heads(issuing_key_id,expires_at);
CREATE INDEX tasks_schedule ON tasks(pool_id,deleted_at,completed_at,enabled,valid,task_id,task_uid);
CREATE INDEX profile_schedule ON task_profile_state(profile_id,permanent_failure,last_grant_at,task_uid);
CREATE INDEX attempts_history ON attempts(task_uid,issued_at DESC,id);
CREATE INDEX attempts_worker ON attempts(profile_id,worker_id,issuing_key_id,expires_at);
CREATE TABLE attempt_events(id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL REFERENCES attempts(id),kind TEXT NOT NULL,timestamp INTEGER NOT NULL,request_id TEXT,metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)));
CREATE INDEX attempt_event_history ON attempt_events(attempt_id,timestamp,id);
CREATE TABLE requests (
 uid TEXT PRIMARY KEY,actor TEXT NOT NULL,request_id TEXT NOT NULL,action TEXT NOT NULL,scope TEXT NOT NULL,
 fingerprint TEXT NOT NULL,original_route TEXT,request_created_at INTEGER NOT NULL,accepted_at INTEGER NOT NULL,retention_deadline INTEGER NOT NULL,instance_epoch TEXT NOT NULL,
 metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),complete INTEGER NOT NULL DEFAULT 0,
 guard_auth INTEGER NOT NULL DEFAULT 1 CONSTRAINT FORBIDDEN CHECK(guard_auth=1),
 guard_epoch INTEGER NOT NULL DEFAULT 1 CONSTRAINT INSTANCE_CHANGED CHECK(guard_epoch=1),
 guard_config INTEGER NOT NULL DEFAULT 1 CONSTRAINT CONFIG_CHANGED CHECK(guard_config=1),
 guard_maintenance INTEGER NOT NULL DEFAULT 1 CONSTRAINT MAINTENANCE CHECK(guard_maintenance=1),
 guard_fresh INTEGER NOT NULL DEFAULT 1 CONSTRAINT REQUEST_TOO_OLD CHECK(guard_fresh=1),
 UNIQUE(actor,request_id)
);
CREATE INDEX request_retention ON requests(retention_deadline);
CREATE TABLE request_items (
 request_uid TEXT NOT NULL REFERENCES requests(uid) ON DELETE CASCADE,ordinal INTEGER NOT NULL,item_id TEXT,
 task_uid TEXT,attempt_id TEXT,status TEXT NOT NULL DEFAULT 'pending',error_code TEXT,
 value_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(value_json)),response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
 PRIMARY KEY(request_uid,ordinal)
);
CREATE TABLE admin_operations (
 id TEXT PRIMARY KEY,actor TEXT NOT NULL,kind TEXT NOT NULL,pool_id TEXT,profile_id TEXT,status TEXT NOT NULL DEFAULT 'preview',
 action_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(action_json)),selection_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(selection_json)),
 created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,total INTEGER NOT NULL DEFAULT 0,processed INTEGER NOT NULL DEFAULT 0,
 summary_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(summary_json))
);
CREATE TABLE admin_operation_items (
 operation_id TEXT NOT NULL REFERENCES admin_operations(id),ordinal INTEGER NOT NULL,task_uid TEXT,expected_edit_revision INTEGER,
 expected_input_revision INTEGER,expected_state_revision INTEGER,expected_generation INTEGER,
 status TEXT NOT NULL DEFAULT 'pending',child_request_id TEXT,payload_json TEXT CHECK(payload_json IS NULL OR json_valid(payload_json)),
 outcome_json TEXT CHECK(outcome_json IS NULL OR json_valid(outcome_json)),PRIMARY KEY(operation_id,ordinal)
);
CREATE INDEX operation_items_tasks ON admin_operation_items(operation_id,task_uid);
CREATE TABLE saved_views(id TEXT PRIMARY KEY,pool_id TEXT NOT NULL REFERENCES pools(id),profile_id TEXT REFERENCES profiles(id),owner TEXT,shared INTEGER NOT NULL DEFAULT 0,name TEXT NOT NULL,presentation_json TEXT NOT NULL CHECK(json_valid(presentation_json)),revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE audit_events(id TEXT PRIMARY KEY,actor TEXT NOT NULL,email TEXT,operation_id TEXT,entity_type TEXT NOT NULL,entity_id TEXT,timestamp INTEGER NOT NULL,reason TEXT,diff_json TEXT NOT NULL CHECK(json_valid(diff_json)));
CREATE INDEX audit_history ON audit_events(entity_type,entity_id,timestamp DESC,id);
CREATE TABLE warnings(id TEXT PRIMARY KEY,severity TEXT NOT NULL,entity_id TEXT,message TEXT NOT NULL,first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL,occurrences INTEGER NOT NULL DEFAULT 1,resolved INTEGER NOT NULL DEFAULT 0);
