# Cloudflare Task Manager — Implementation Specification

Version: 1.0  
Prepared: 2026-09-04  
Audience: the coding agent implementing the system, its maintainer, and acceptance reviewers.

## 1. Assignment and priority

Build a task manager for computational experiments with **Cloudflare Workers, D1, and a browser application containing editable spreadsheet-like tables**. Python workers running on a laptop, Kaggle, Slurm, or under torchrun obtain leases, perform computation elsewhere, and submit results. People create, organize, inspect, and edit tasks in the browser and download results as tables.

The browser application is a principal deliverable. An API with a SQL console, a read-only dashboard, or a grid whose edits exist only in browser memory does not satisfy this specification.

The deployment should be inexpensive during long periods of inactivity and require no virtual machine, running container, operating-system administration, or separately hosted frontend.

This document is self-contained. It supersedes the Google Sheets / Apps Script architecture. Preserve the useful task, lease, profile, history, and Python-client behavior described here; do not retain spreadsheet synchronization, script locks, or cross-spreadsheet journals.

Interpret **MUST** as a release requirement, **SHOULD** as the preferred approach that needs a documented reason to change, and **MAY** as optional. Defaults in this document are implementation decisions for v1, not claims that the user previously chose every number. If a default proves infeasible, document the evidence and choose a compatible value; do not silently remove a required capability.

Implement the complete product through the milestones in section 20. Deliver a working vertical slice early, then finish the remaining requirements. Do not claim production readiness from a UI mockup, mocked database, or local SQLite tests alone.

### 1.1 Expected use

| Dimension | Baseline to support |
| --- | --- |
| Administrators | One person or a few trusted colleagues |
| Tasks | Up to 10,000 tasks in each pool, with several pools |
| Traffic | 10–60 worker API calls per minute during active experiments, including short concurrent bursts |
| Computation | Runs outside Cloudflare; individual tasks may take hours |
| Results | Usually small JSON objects, generally below 10 KiB per result |
| Browser work | Enter/paste/import tasks; edit parameters; inspect progress; search/filter; export results |
| Idle periods | Days, weeks, or months without computation or browser use |
| Installation | Browser-led deployment for end users; local command-line tools optional |
| Client | One dependency-free Python module plus short examples |

This traffic profile is a benchmark target, not a promise that every workload fits the free tier. Actual writes, scanned rows, CPU time, history volume, and batch sizes matter.

### 1.2 Required and deferred scope

Required in v1: browser editing; CSV/TSV paste and CSV import; custom input/result columns; families, pools, and profiles; atomic claims; renew/report/recover; idempotency; global success and profile-specific failure; configurable caps and filters; attempt history; resets; API-key administration; saved views; CSV and lossless JSON/NDJSON export; deployment and recovery instructions; meaningful concurrency and browser tests.

Deferred: spreadsheet formulas and recalculation; Google Sheets synchronization; collaborative cursors and character-by-character coediting; arbitrary SQL in the user UI; a scheduler that launches Slurm/Kaggle jobs; per-user billing; workflow DAGs; emails; server-push/WebSocket updates; mandatory Redis, Queues, Durable Objects, or R2; automated cold storage migration. Excel XLSX import/export is optional after CSV works fully.

Logical archival and indefinite retention of attempt history are required. Moving historical payloads to optional object storage is a later extension, with requirements in section 17. Do not silently delete history to remain within a free-plan limit.

## 2. Architecture and deployment boundary

Use one repository, one deployed Worker application with bundled static assets, and one authoritative D1 database per installation. Production and staging MUST use separate databases and credentials.

~~~mermaid
flowchart TD
    H["Human browser"] --> A["Cloudflare Access"]
    A --> W["Worker: static app and admin API"]
    P["Python compute workers"] --> W
    W --> D["D1: tasks, leases, configuration, history"]
    H --> F["Downloaded CSV and JSON files"]
~~~

Cloudflare supports deploying static HTML/CSS/JavaScript and Worker code together. Use this facility for the application and its API. [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)

### 2.1 Components

| Component | Responsibilities |
| --- | --- |
| Browser SPA | Editable tables, forms, saved views, task details, import/export flows, local edit state |
| Worker HTTP layer | Routing, request-size limits, authentication, validation, response envelopes |
| Domain services | Eligibility, lease rules, resets, configuration validation, result mapping |
| D1 repository | Prepared SQL, atomic batches, indexes, request receipts, history, optimistic concurrency |
| Python helper | Stable worker identity, task objects, retries, runtime measurement, typed errors |
| Deployment assets | Wrangler configuration, SQL migrations, build/deploy scripts, browser installation guide |

Use TypeScript for the Worker and browser. Prefer Vite for building static assets and Tabulator for the grid. Plain TypeScript modules are sufficient; a small frontend framework is acceptable if it simplifies the finished UI. Pin dependencies and commit the lockfile. Avoid introducing server-side rendering for this application.

Tabulator supplies cell editing and clipboard facilities, but application code still has to implement validation, persistence, import semantics, and conflict handling. [Tabulator editing](https://www.tabulator.info/docs/6.x/edit/), [Tabulator clipboard](https://www.tabulator.info/docs/6.x/clipboard/)

Prefer direct D1 prepared statements for the broker. A query builder is acceptable only if the generated transaction and query behavior remains inspectable. A database abstraction MUST NOT pretend that D1 supports an arbitrary interactive transaction callback.

### 2.2 Hostnames and routes

The recommended production configuration uses two subdomains of one domain:

| Host and path | Behavior |
| --- | --- |
| `tasks.example.com/` and SPA routes | Browser application, protected by Access |
| `tasks.example.com/admin-api/v1/*` | Human administration API, protected by Access and Worker-side identity verification |
| `broker.example.com/api/v1/*` | Compute API, authenticated with task-family keys |
| `broker.example.com/healthz` | Minimal liveness response; no data, names, or configuration |

Both hostnames route to the same Worker. The browser uses relative URLs on the admin origin. Keep compute authentication independent of interactive Access login.

The Worker MUST validate host and path together. Requests to admin paths through the broker hostname are rejected; they must never inherit compute-key privileges. Likewise, unknown hostnames cannot provide a shortcut to administration. Disable public workers.dev and preview URLs for production, or demonstrably apply the same protection there.

Static assets contain no task data or secrets. Dynamic API responses and downloads use private, nonshared caching; default to `Cache-Control: no-store`. API failures MUST return JSON, never the SPA HTML fallback. Deep links to legitimate SPA screens MUST work after refresh.

The recommended deployment assumes an existing domain configured on Cloudflare. Domain registration, if needed, is a separate expense. A domain-free installation is optional and must document a verified authentication arrangement; do not make the browser public to avoid configuring Access.

### 2.3 State authority

D1 is the only authoritative source of tasks, leases, completion, configuration, and history. The browser caches a view and unsaved edits. Worker memory MAY cache immutable assets and verified authentication keys, but MUST NOT serve as a lock, a lease ledger, or the sole record of any write.

All correctness-critical SQL uses the D1 primary in v1. Do not enable read-replica access in the broker. If read replicas are later introduced for dashboards, carry D1 session bookmarks for read-after-write consistency and keep authorization/capacity decisions on the primary. A session is a consistency mechanism, not a transaction. [D1 database and session APIs](https://developers.cloudflare.com/d1/worker-api/d1-database/)

No external network call belongs inside the logical task transaction. No successful response is sent before its state and receipt have committed. No durable state change may depend on `waitUntil()` completing.

## 3. Browser product requirements

### 3.1 Main workspace

The initial empty installation shows a concise Start Here screen with actions to create a family/pool, import tasks, and run a disposable demonstration. After setup, the normal landing screen is the last-opened task table, with a family/pool navigator and status counts.

Required screens:

1. **Tasks:** editable table and pool navigation.
2. **Task details:** complete input, current state, result, and paginated attempt history.
3. **Pools and profiles:** normal forms plus an editable configuration table.
4. **Keys:** issue, rotate, soft-revoke, and hard-revoke keys.
5. **Activity:** leases, failures, warnings, and administrative audit events.
6. **Settings:** defaults, administrators, versions, deployment checks, and export/backup guidance.

Technical IDs, JSON, and detailed policy overrides belong in a details panel or advanced controls. Common operations MUST be possible without writing JSON, SQL, or code.

### 3.2 Task grid

The grid MUST support:

- Viewing input fields as individual columns, followed by mapped result columns and selected status metadata.
- Inline editors for strings, multiline text, integers, numbers, booleans, datetimes, and tags.
- A modal JSON editor for nested objects or arrays, with validation.
- Adding one row, inserting several blank draft rows, duplicating selected tasks with new IDs, and importing tasks.
- Keyboard navigation with Tab/Shift-Tab and Enter, cancelling an edit with Escape, and predictable copy/paste.
- Rectangular multi-cell paste from Google Sheets/Excel and TSV text, with a preview for larger pastes.
- Row selection, visible selected-row count, and bulk operations.
- Server-side filtering and sorting, resizable/reorderable columns, and column visibility.
- Named saved views: filter, sort, column order/width/visibility, page size, and selected profile context.
- A visible saved/saving/error indicator, manual refresh, and optional live refresh.
- Opening a task without losing the current filter, scroll position, selection, or unfinished edits.
- Clear empty, loading, offline, unauthorized, expired-login, and error states.

Saved views are stored in D1 and survive another browser/computer. Personal views are owned by the Access subject ID; shared views may be edited by any full administrator. A saved view is presentation only and never changes eligibility or grants API-key access.

The default table should show public task ID, enabled, inputs, status, attempts, lease expiry, and configured results. Columns for tokens, hashes, raw internal JSON, and database IDs MUST NOT dominate the table. Raw lease tokens are not ordinary admin table fields.

At least 10,000 tasks MUST be comfortably navigable. Default to 100 rows per server page, with 50/100/250 choices. Virtualize rendering within the loaded page. Do not load every raw result or every attempt to display a table page. Row counts may be fetched separately and marked with their refresh time.

### 3.3 Adding and organizing tasks

The Create Pool flow asks for a name, family, and input columns; users may instead infer columns from pasted data or CSV headers. The first pool automatically gets a default profile. Additional profiles are optional advanced configuration.

Task fields can be added and reordered through the browser. Common examples:

| Input | Type |
| --- | --- |
| `n`, `m`, `d` | Integer |
| `memory_gb`, `time_limit` | Number |
| `description`, `model` | String |
| `parameters` | JSON object |

Each field has a stable key, display label, type, nullable/required setting, optional default, and column order. Result fields additionally have a mapping from the result JSON. Labels may contain spaces; machine keys are stable. A display-label change does not rename JSON keys in previously issued payloads.

Pools have name, description, family organization, and an archived flag. An archived pool remains viewable and exportable, stops new claims, and drains existing leases. Hide/expand controls in the navigator affect presentation only. Use an explicit disable/archive action to stop work.

The browser MUST allow new tasks to be added while workers are running. Users should not have to stop an entire pool to edit a different, unleased task.

### 3.4 Saving and conflicting edits

Ordinary cell edits save after the editor is committed. Bulk paste and multi-row forms stage changes and show an explicit Save action. In both cases:

1. Track local edited values separately from the last server values.
2. Send only intended fields and the task's expected `edit_revision`.
3. The server validates the patch and atomically checks the revision and current lease state.
4. Show the authoritative returned values after success.
5. On failure, preserve the attempted input, identify the affected cell/row, and allow correction or retry.
6. On a revision conflict, show the current server value beside the attempted value. Offer Reload/discard and a reviewed retry against the current revision; no silent last-write-wins behavior.

An expired login or dropped network connection must never make a local edit look saved. A refresh or background poll must not overwrite an active editor. Warn on navigation with unsaved edits. Do not require persistent browser storage of task data; any optional draft persistence must exclude credentials and be clear to the user.

Runtime activity has a separate `state_revision`. Heartbeats and completion do not by themselves invalidate a harmless edit to an administrator note. Input edits still check the actual current lease/completion state at commit, even when `edit_revision` matches.

### 3.5 Which changes are allowed

| Change | Required behavior |
| --- | --- |
| Edit inputs/tags of an unleased, incomplete task | Save atomically; increment input/edit revisions and invalidate an outstanding expired lease |
| Edit inputs of an actively leased task | Ordinary edit returns `TASK_LEASED`; offer explicit Revoke and edit with preview |
| Edit inputs of a completed task | Require explicit Reset and edit; preserve the historical result and old payload in history |
| Edit admin-only note or toggle enabled | Allowed during a lease; disabling stops new claims but permits the current report |
| Edit task ID | Allowed only before the first-ever lease; preserve the old ID as a tombstone if it was already committed |
| Edit status, attempt count, token, timestamps, or worker result directly | Not allowed; use named actions such as Reset or Revoke |
| Delete a task | Soft-delete/tombstone; stop claims; explicitly revoke any current lease after preview |
| Rename/reorder/hide a display column | Presentation update; no worker payload change |
| Change field type/key or requiredness | Schema validation/migration, with impact preview; no implicit destructive conversion |

Never implement Revoke and edit as separate browser calls with a race between them. The server action combines the checked revocation, fencing increment, and edit in one transaction.

Result columns are read-only. A human correction may later be implemented as an audited result override; it is not part of v1's ordinary cell editing.

### 3.6 Bulk actions and selection

Required actions: enable, disable, set tags, edit a chosen input field, duplicate, soft-delete, revoke lease, soft reset, and full reset. Preview destructive or lease-invalidating actions with affected IDs/counts and scope. A normal single-cell save does not need a confirmation dialog.

Distinguish **selected loaded rows** from **all rows matching the filter**. Export may use either. Mutating all matching rows requires server-side selection materialization at preview time: store IDs and expected revisions with an expiring operation record. Do not silently include tasks added after preview.

Large operations are resumable chunks with independent atomic commits and per-row outcomes. Show completed, skipped/conflicting, and unprocessed counts. A cancelled operation stops future chunks; it does not imply rollback of already committed chunks. Retry uses the same chunk operation ID.

### 3.7 Imports and paste

Support UTF-8 CSV with quoted delimiters, embedded newlines, and optional BOM; support TSV clipboard input. Use a real parser, not `split(',')`.

The import flow MUST show file headers, representative rows, detected types, column mapping, invalid values, duplicate IDs, and the number of new/updated/skipped tasks before saving. Type inference is a proposal; administrators can override it. Preserve leading zeros when a column is designated as text. Empty values, booleans, dates, and large integer strings must have documented conversion rules.

Modes:

- **Add:** supplied existing/tombstoned IDs are errors; missing IDs receive UUIDs.
- **Update by ID:** only named existing IDs are patched, with revision/lease checks; absent columns do not erase existing values.
- **Upsert:** explicit selection; combines the above rules and never overwrites a leased or completed payload silently.

Treat formulas as text. Importing CSV does not execute or preserve spreadsheet formulas as live computations. To import values from Sheets, export evaluated values.

Handle 10,000 rows by client parsing and bounded server chunks. Chunk receipts and generated IDs are stored before acknowledging, so a lost response cannot duplicate inserted rows. Provide a downloadable error CSV with original row number, task ID, column, and explanation. A user can export successful imports immediately and see the same data in a second browser session.

### 3.8 Exports

Required buttons: Export current view, Export all tasks in pool, Export selected tasks, and Export attempt history. Export all means all matching server rows, not merely the current page.

CSV includes task IDs, selected inputs, mapped results, useful state/timing fields, and explicit headings. JSON/NDJSON preserves nested data and all types representable in the API. Every export records pool/profile context, timestamp, schema version, and selection/filter in a manifest or JSON envelope where applicable.

Offer spreadsheet-safe CSV by default: quote correctly and neutralize formula-like text cells beginning with dangerous spreadsheet prefixes, including after leading whitespace/control characters. Apply this to text fields, not negative numeric values. Explain that safe CSV changes such text; lossless JSON is the exact-data export. A deliberate raw CSV option may be provided with a brief explanation.

A download MUST indicate if it is a live traversal. For normal CSV export, freeze the selected task IDs at start, read rows in stable ID order in chunks, and document that values can change during export. Do not claim transactionally consistent values across independent paginated queries. A consistent full database backup is a separate operation in section 17.

The browser may assemble a download from bounded API pages. This avoids a server invocation formatting tens of megabytes under the free CPU limit. Include row count/checksum in the manifest and report interruptions. Browser memory use must remain bounded enough for the baseline dataset; use chunked Blob parts or a supported streaming download where available.

### 3.9 Refresh and accessibility

After a successful edit, refresh relevant rows/counts without losing focus. Live refresh is off by default and, when enabled, defaults to 10 seconds. Pause when the tab is hidden, a conflicting editor is open, or the administrator has been inactive for 15 minutes. Show the last update time and a Resume/Refresh control. Use a longer interval or stop when no work remains; do not generate unattended queries indefinitely.

Support current desktop Chrome/Edge and Firefox, keyboard-only common workflows, clear focus indicators, readable error text, and status indicators that do not rely on color alone. A usable details/form layout on narrow screens is required; the full grid may scroll horizontally. Any grid accessibility limitations must be documented and covered by an accessible task form.

## 4. Domain model

### 4.1 Names and identity

| Entity | Meaning |
| --- | --- |
| Installation | One isolated deployment and D1 database |
| Family | API-key namespace, defaults, and optional family-wide concurrency limits |
| Pool | A physical collection of tasks sharing input/result schema and global completion |
| Profile | A family-owned route to a pool with distribution/filter policy |
| Task | One stable public task ID within a pool, arbitrary typed inputs, and current state |
| Attempt | One issuance of a lease with a frozen input snapshot and outcome |
| Request receipt | Durable idempotency data for a mutating request |
| Saved view | Browser presentation preferences, not broker policy |

Give entities opaque internal UUIDs. Public family slugs are ASCII and case-insensitive, normalized to lowercase. A pool path is `family` or `family/profile-slug`; a bare family resolves to its configured default profile. Both paths must resolve to the same immutable profile ID and share idempotency/lease state.

Display names may use Unicode and spaces. Slugs cannot contain `/`; renaming a display name never changes a worker route. Changing a route is an explicit admin operation with an optional deprecated alias. Alias resolution produces one canonical profile ID, not a duplicate profile.

Several profiles, including profiles from different families, MAY expose one physical pool. Tasks share global success, lease exclusion, IDs, and physical caps. A profile owns its attempt counters, exhaustion, and permanent failure state. Each family key authorizes that family's enabled profiles, never arbitrary profiles in another family.

The wizard and ordinary UI should make the common one-family/one-pool/one-profile case simple.

### 4.2 Task payload and schema

Store dynamic inputs as validated JSON plus field metadata; do not create a SQL column or new SQL table for each input column or pool. Index common scheduling fields separately and add reviewed expression indexes for frequently queried input fields as needed.

Each pool's input definition includes field ID, immutable machine key, display label, scalar/JSON type, nullable/required setting, default, and order. Reject duplicate or ambiguous case-insensitive keys/labels used by the filter resolver. Reserve system-field names such as `task_id`, `status`, `attempts`, `tags`, and `enabled`.

Supported types: string, integer, finite number, boolean, UTC datetime string, and JSON object/array. Datetimes are RFC 3339 in the API. Integers outside JavaScript's exact safe range MUST be represented as strings; never silently round research parameters or results. Reject NaN and infinities. Stored JSON is normalized consistently, with documented handling of missing versus null.

Tags are stored as a normalized set, exposed as a comma-separated editor and as an API string array. Trim entries, ignore empties, deduplicate, and match case-insensitively using one documented normalization routine. Commas inside individual tags are unsupported in v1. Tags participate in the leased input snapshot.

Default values apply at task creation or a reviewed migration, not retroactively every time a task is read. Formula execution is out of scope.

### 4.3 Task identity and revisions

A task has an internal globally unique `task_uid` and a public string `task_id`, unique within its pool. Public task IDs are case-sensitive and matched verbatim, unlike normalized family/profile slugs. Preserve supplied IDs; generate UUIDs on creation where absent. Public IDs are immutable after the first-ever lease, including after a full reset. Deleted or renamed historical IDs cannot be reused in that pool.

Maintain separate monotonic values:

- `edit_revision`: administrator-editable values changed.
- `input_revision`: worker input/schema meaning changed.
- `state_revision`: lease/result/runtime state changed.
- `lease_generation`: fencing value; increases whenever a new lease is granted or an old one is administratively invalidated.
- `attempt_sequence`: lifetime issuance sequence; never reset.

Full reset may zero current-policy attempt counters but never these lifetime identity/fencing values. Store `input_hash` over canonical normalized parameters and tags, including fields hidden from a particular profile. Compute hashes at validated input writes; use the stored revision/hash in claim SQL. Schema changes that alter input meaning must update the input contract revision and invalidate affected snapshots through a controlled migration.

### 4.4 Configuration and inheritance

Effective distribution settings inherit from global defaults to family defaults to profile overrides. Pool schema and physical caps are authoritative independently of that chain. A per-task maximum-attempt override replaces a profile attempt limit for that task, while the physical total cap still applies.

Explicit `null` means unlimited for optional caps; omitted means inherit. Zero means no capacity, not unlimited. Durations must be positive. UI controls must distinguish these values.

Both forms and configuration tables are first-class browser interfaces. They use the same endpoints and D1 records. The browser holds unsaved drafts; Save validates and commits a dependency group atomically with a revision check. Include impact preview for schema and destructive policy changes. No partly edited configuration becomes live.

A dependency group includes a physical pool and profiles whose shared contract changes. Family-wide edits include all affected family references. Independent valid groups may be applied while invalid groups remain pending, with explicit per-group feedback. Bulk changes must identify their group boundaries; do not pretend several committed groups form one global transaction.

An incompatible schema change across many tasks is a resumable migration, not a giant cell edit. Drain or explicitly revoke affected leases, block new claims and payload edits for that pool, retain the prior schema/conversion provenance, and migrate in bounded chunks. The browser shows migration progress and read-only task details with the relevant schema version. Activate the new shared contract only after all affected rows validate. A crash leaves the pool visibly migrating and resumable; it must not expose half-converted tasks to claims. Adding an optional input column or changing a display label should not require this heavy workflow.

Existing leases retain their issued contract: maximum lifetime, result mapping, required-result policy, input snapshot, and response projection. Raising/lowering caps changes future grants. Reducing a cap below current usage drains naturally; it does not revoke leases implicitly.

## 5. Eligibility, attempts, and scheduling

### 5.1 Eligibility

A task is claimable through a profile only if:

1. The family, profile, and pool permit new work; the task is enabled and not deleted.
2. It is not globally completed.
3. No effective active lease exists across any profile of the pool.
4. The current profile has no permanent failure and its attempt limit is not reached.
5. The task's physical total-attempt cap is not reached.
6. Its payload conforms to the active input contract.
7. The profile's mandatory filter and the worker's requested filter both pass.
8. Every applicable concurrency limit has remaining capacity.

An effective active lease is unresolved, belongs to the task's current generation and installation epoch, has not been revoked, and has `expires_at > database_now`. Exactly at expiry it is no longer active. Soft-revoked keys' existing leases remain active until expiry/report/revocation; hard-revoked keys' leases are ineffective.

Eligibility MUST use timestamps directly. No cron job is required to make expired work available or to free capacity.

### 5.2 Counters and status

Maintain `attempts` for the current profile and `attempts_total` across the physical task since their applicable full resets. New grants increment both exactly once. Request replays, renewals, and repeated identical reports do not increment them. Keep unreset lifetime sequence/counters separately for identity and audit.

Global status is derived with precedence: deleted, completed, active lease, disabled/archived, physical exhaustion, pending. Profile status additionally accounts for its disablement, permanent failure, and attempt exhaustion. The UI must show a shared active lease even if another profile issued it. Preserve failure/exhaustion reasons as separate data even when a higher-priority display status applies.

`status`/`attempts` in profile filters refer to the chosen profile; `status_total`/`attempts_total` refer to global state. The unfiltered physical task table defaults to global summaries and labels the distinction when a profile context is selected.

### 5.3 Ordering and caps

Default ordering: zero attempts through the current profile since its last full reset first; then oldest profile grant time; then public task ID and internal UID for deterministic ties. Full resets restore fresh scheduling in their scope while retaining lifetime counters and history; soft resets preserve retry priority. Workers may request a validated scalar-field sort within these groups: fresh tasks use the requested fields before ID ties, and retries use oldest profile grant time before the requested fields and ID ties. Table sorting does not configure worker claims. Release makes a task eligible immediately, with its recent grant time naturally placing it behind older work under the default order.

Support caps for:

- Tasks per claim request.
- Active leases per worker within a profile.
- Active leases across a profile.
- Active leases across the physical pool.
- Optional active leases per worker across a family.
- Optional active leases across a family.

Family usage is counted by the family/profile that issued each lease. Physical usage includes every family/profile using the pool. Every grant in a batch counts against all relevant caps.

Return the largest allowed batch up to the requested count, available matching tasks, response-size bound, and remaining capacities. Return an array of limiting reasons and granted/requested counts, including a legitimate empty result. Lack of eligible tasks is not a transport error. Exact global queue counts on every claim are unnecessary and may be expensive.

## 6. Lease and completion semantics

### 6.1 Guarantees

Provide at-least-once execution with fenced authoritative completion. An expired worker may still compute while a replacement computes the same task. The server cannot stop the old process. It MUST reject results from superseded/revoked generations.

At most one effective active lease exists for a physical task, regardless of aliases or profiles. Exactly one accepted success is authoritative within a task generation. Workers need idempotent external side effects if their computations affect systems beyond this manager.

### 6.2 Issuance and renewal

A claim requests a lease duration or uses the profile default. The server caps it by policy and records grant time, expiry, and immutable maximum expiry. Renewal is allowed only while the lease is active, with a currently active key and matching task/worker/profile/epoch/token. New expiry is `min(now + requested_duration, maximum_expires_at)` and must not shorten the current expiry. If it cannot extend, return the current expiry plus a reason.

Record the effective lease contract at issuance. Later policy edits do not silently change an existing attempt's maximum lifetime or result contract. Disabling a pool/profile drains existing work: reporting and policy-permitted renewal remain allowed. Soft key revocation is stricter: no new claims or renewals, and reports only before the existing expiry.

### 6.3 Outcomes

| Outcome | Effect |
| --- | --- |
| `success` | Store raw JSON and mapped results; close the task globally |
| `release` | Close this attempt without success; remove its effective lease; eligible again if other rules permit |
| `permanent_failure` | Close this attempt; set failure for this profile only; require a nonblank message |

Release may include a note/details and does not undo the attempt increment. There is no separate retryable-failure state in v1. Failed computations that should be retried use release.

Record server elapsed time from issuance to accepted report and worker-reported runtime separately. Client runtime starts on receipt unless explicitly supplied; it is not a trusted scheduling value. Server elapsed may exceed the nominal lease duration for an accepted late report.

### 6.4 Late results and stale state

An expired attempt may report only when it is still the task's latest attempt, its generation/epoch/input revision/hash remain valid, no reset or revocation invalidated it, and the issuing key remains active. A soft-revoked key cannot report after expiry. Hard revocation prevents all further operations with the key.

If a newer lease exists, return `STALE_LEASE` even if the newer lease has also expired. An old worker never regains authority. If inputs changed, return `INPUT_CHANGED`; do not write the old result into the new task. A released or permanently failed attempt cannot later change its outcome to success.

Late acceptance does not reactivate capacity or extend a lease. Do not discard the most recent expired attempt merely because a cleanup threshold elapsed; its pointer and fencing evidence are needed for late-result rules.

### 6.5 Repeated reports and batches

The same request ID and body replays its stored outcome. A new request ID submitting the same normalized outcome/result for an already finalized lease returns `already_applied`, without changing time/counters/history. A conflicting second outcome/result returns `RESULT_CONFLICT`; the first accepted outcome remains authoritative. The lease-level fingerprint includes outcome and normalized result/message/details; runtime is retained from the first accepted finalization. The request-level fingerprint still covers the complete request body.

An authorized receipt replay acknowledges the historical operation; it never reapplies it after an administrative reset. Likewise, replaying a claim returns the original grant but does not make a revoked or expired token active again. Distinguish that replay behavior from a previously unaccepted stale report trying to change current state.

Multi-item reports apply valid items even if other items are malformed or stale. Preserve request order in item responses and use a stable `item_id`. Duplicate task/lease entries within one batch are validation errors for those entries. Expected item failures become stored outcomes, not SQL exceptions that undo unrelated valid items. An unexpected database error rolls back the database batch; the client can safely retry the whole request.

### 6.6 Recover and worker identity

`recover()` returns effective active leases for the authenticated issuing key, worker ID, and canonical profile, with the original payload, token, contract, and current expiry. It does not issue new attempts or return expired leases. Restrict recovery to the issuing key by default; key rotation does not automatically transfer lease ownership.

Worker IDs are cooperative identity labels, not authentication. A family key is the credential. If several processes deliberately share a worker ID, their capacity usage is aggregated.

## 7. Reset, deletion, and history

### 7.1 Reset actions

Offer profile-scoped and all-profile resets, with soft/full modes and mandatory impact preview.

| Action | Clears | Retains |
| --- | --- | --- |
| Profile soft reset | That profile's permanent-failure flag | Counters, global success, displayed results, all history |
| Profile full reset | That profile's failure and current attempt counter | Physical counter/global success/results, all history |
| All-profile soft reset | Global completion and profile failure flags | Current counters, old displayed result labeled as previous, all history |
| All-profile full reset | Global completion, current counters, profile failures, current displayed results | IDs, lifetime sequences, monotonic revisions, all history |

A profile reset cannot reopen a globally completed task; the UI must explain that an all-profile reset is needed. A soft reset does not override exhausted attempt caps. Preview whether the task will actually become eligible.

Any reset that invalidates an outstanding attempt increments the task's fencing generation and records why. If an active lease exists, require the explicit revoke option; reject the action otherwise. Because the physical task has one shared lease, preview its issuing profile even when the user selected a different profile for reset.

### 7.2 Soft deletion and audit

Deletion means a tombstone and hidden-by-default task. Restore may reopen the same task identity through a reviewed action; creating a new task with the tombstoned ID is prohibited. Pool/family removal follows the same principle once referenced by history. Prefer disable/archive to deletion.

Audit each administrative mutation with actor subject/email snapshot, timestamp, affected IDs, operation ID, reason where required, and a concise before/after diff. Redact secrets and credentials. Large operations may record a parent event plus item outcomes rather than huge duplicate JSON blobs.

Attempt history retains the exact normalized full input, returned profile projection or enough immutable data to reconstruct it, input hash, task/profile/family identity snapshots, effective contract, worker/key label, all grant/renewal/finalization times, result/failure details, and runtime values. History is paginated and exportable. Human edits do not rewrite historical snapshots.

## 8. Filtering and result projection

### 8.1 Filter contract

Support both a browser filter builder and an advanced text expression using the same server-side parser and evaluator semantics. The browser may preview parsing errors; the server is authoritative.

~~~text
has:gpu AND attempts < 10 AND memory_gb >= 30

(has:gpu OR has:cpu)
AND model IN ("a100", "h100")
AND description CONTAINS "unitriangular"
AND notes IS NOT BLANK
~~~

Required operators: AND, OR, NOT, parentheses; =, !=, <, <=, >, >=; IN and NOT IN; CONTAINS and STARTS_WITH; IS BLANK and IS NOT BLANK; `has:tag` and `has_not:tag`. Boolean precedence is NOT, then AND, then OR. Comparison chains such as `1 < x < 3` are rejected; require `x > 1 AND x < 3`.

Fields resolve case-insensitively against stable keys and unambiguous labels. Backticks quote names containing spaces/punctuation. String literals use JSON-style double quotes and escapes. Support finite numeric literals, true/false, and explicit `datetime("2026-09-04T12:00:00Z")` literals; do not guess a string's type from its appearance.

For blank tests, missing, null, and an empty string are blank; whitespace-only strings are nonblank unless normalized by the field's configured input rule. Ordinary comparisons involving blank evaluate false, including != and NOT IN. Logical NOT then negates that Boolean result; thus `NOT (x = 3)` can include a blank x, whereas `x != 3` does not. Document and test this distinction. Require explicit blank tests when necessary.

Other string comparisons are case-sensitive. Tags alone use normalized case-insensitive matching. Do not inherit SQLite LIKE's default case behavior accidentally. Implement CONTAINS/STARTS_WITH with bound literals and appropriate functions, not user-controlled wildcard patterns. Incompatible operand types, unknown/ambiguous fields, and disallowed fields are request errors; never silently ignore part of a filter.

Use a tokenizer, AST, validation phase, and parameterized SQL compiler. No JavaScript eval, Function construction, raw SQL filters, or direct identifier interpolation. User field names resolve to trusted metadata and generated SQL expressions. Parameters bind values; sort directions and system-column expressions come from an allowlist.

Compile blank/type semantics deliberately, including SQL NULL and Boolean normalization. Test the server's SQL output against table-driven truth cases. JSON object/array fields support blank tests in v1; deeper filtering requires explicit typed fields or a later documented extension.

Each profile has a mandatory filter and a request-filter field allowlist. Always combine mandatory and request filters using AND. A response-excluded input is not automatically filterable: access to it through filtering must be explicitly allowed. Admin filters have full authorized pool visibility; compute requests do not.

Default parser bounds: 4 KiB expression, 100 AST nodes, nesting depth 10, 50 literals in an IN list. The compiler must also remain below D1's parameter and statement-size limits, counting all non-filter parameters. Return `FILTER_TOO_COMPLEX` with actionable detail when exceeded.

### 8.2 Projection and result columns

For each profile, define which input fields are returned. Store the full input snapshot and its hash even when the worker sees a reduced projection. Exclusion changes do not rewrite old claim receipts.

Pool-level result fields map a stable output key to a path in the worker's raw JSON. Use **JSON Pointer** strings for exact nested lookup, for example `/diameter` and `/metrics/runtime`. Specify missing-path behavior as null; reject type mismatches for configured typed fields before accepting success. Preserve raw JSON whether or not all fields are mapped.

Capture the result-map version and definitions in the issued contract. Ordinary label/display changes are allowed during active work. Incompatible schema changes must drain or explicitly revoke affected attempts through a reviewed migration. Do not interpret a late result using a newly incompatible mapping.

An optional required-result flag rejects null, an empty string, and empty objects/arrays as successful results. Numeric zero and boolean false are valid. A failed report validation leaves a valid lease available for a corrected report.

## 9. D1 storage design

### 9.1 Logical tables

The implementation MUST provide the following logical records. Physical names/layout may be refined, but all constraints, history, and transactional invariants must be preserved. Put migrations under version control and include an entity diagram in the implementation repository.

| Table | Principal fields and constraints |
| --- | --- |
| `installation` | Singleton ID, schema/config version, active epoch mirror, setup/maintenance status, global defaults JSON, created/updated times |
| `administrators` | Stable Access subject, normalized email, active flag; owner bootstrap identities remain deployment configuration |
| `families` | ID, unique normalized slug, name, description, enabled, default profile ID, policy JSON, config revision |
| `pools` | ID, owner family ID for browser organization, name, description, enabled, archived_at, schema/migration status, physical caps, required-result policy, config revision |
| `pool_fields` | Field ID, pool ID, kind=input/result, unique machine key, label, type, required/default, mapping pointer, order, active flag |
| `profiles` | ID, family ID, pool ID, unique slug within family, enabled, policy overrides, mandatory filter AST/text, projection, allowlist, config revision |
| `profile_aliases` | Family/path mapping to canonical profile; unique normalized route; optional deprecation metadata |
| `tasks` | Internal UID, pool ID, current public ID, parameters JSON, input contract revision/hash, tags representation, enabled, admin note, max-attempt override, validity, all revisions, lifetime sequence, current total attempts, latest attempt pointer, completed-at/result pointer, result summary JSON, tombstone, timestamps |
| `task_identifiers` | Unique (pool ID, public ID), owning task UID, active/tombstoned flag; prevents historical reuse |
| `task_tags` | Unique (task UID, normalized tag), optional original display text |
| `task_profile_state` | Unique (task UID, profile ID), current attempts, lifetime attempts, last grant time, permanent failure/message/details, reset metadata |
| `attempts` | Attempt ID, task/profile/family IDs, task name snapshots, attempt sequence/generation/epoch, worker/issuing-key ID, lease token, issued/expiry/max-expiry, contract snapshot, full/returned payload snapshot, input revision/hash, outcome, result hash/raw JSON/mapped values, elapsed/runtime, final timestamps |
| `attempt_events` | Event ID, attempt ID, kind, timestamp, request ID, concise metadata; immutable renewal/revocation/late-report evidence |
| `api_keys` | Public key ID, family ID, label, nonsecret prefix, digest of random secret, status, issued/revoked times, optionally throttled last-used time |
| `requests` | Actor identity and request ID unique together, action, canonical scope, request fingerprint, original request time, accepted-at, retention deadline, immutable receipt metadata |
| `request_items` | Request ID, ordinal/item ID, selected task/attempt identity, fixed response snapshot or immutable response ingredients, applied/error outcome; unique per request item |
| `admin_operations` | Parent operation ID, actor, kind, frozen selection/expected revisions or links to items, progress, expiry, summary |
| `admin_operation_items` | Parent/ordinal/task IDs, expected revisions, status, child request ID; resumable bulk operations |
| `saved_views` | View ID, pool/profile context, owner or shared flag, name, presentation/filter JSON, revision |
| `audit_events` | Event ID, actor, operation ID, entity references, timestamp, redacted before/after summary |
| `warnings` | Deduplication key, severity, affected entity, first/last seen, occurrences, resolved state |

A separate current-leases table is optional. Prefer a single authoritative current attempt pointer plus attempts rather than duplicating lease authority in several places. If a materialized current-leases table is used, every mutation must update it in the same database transaction and tests must verify consistency.

Use foreign keys, CHECK constraints, unique constraints, and NOT NULL where appropriate. Do not cascade-delete attempt history when a task/pool is removed. Validate JSON on write. Do not rely on SQLite's loose column typing to validate inputs.

### 9.2 Indexes and access patterns

Required indexed access patterns include:

- Tasks by pool and public ID, plus the identifier tombstone uniqueness constraint.
- Pending/enabled tasks in a pool and deterministic task ordering.
- Latest effective leases by profile, pool, family, worker, and expiry, using a small current-state relation or selective joins to latest pointers.
- Task/profile counters and last-grant ordering.
- Attempts by task and issuance time; by profile/worker/issuing key and expiry.
- Tags by normalized tag and task, and by task.
- Requests by actor/request ID and retention deadline.
- Audit/history pages by entity, timestamp, and stable ID.

Do not make every cap count scan the entire attempt history. Prefer a current-state relation or latest-attempt join whose cost depends on current tasks/leases. Exact physical index definitions must follow measured EXPLAIN QUERY PLAN results; include those results for baseline queries.

Add JSON expression indexes only for selected frequently filtered fields. The browser may request an index through an advanced schema workflow, with validation and a bounded migration. Never create an index on each new filter expression automatically.

Avoid multiplying rows by joining every matching tag/profile. Use EXISTS or deduplicated subqueries. Pagination must append a stable unique tie-breaker. A signed opaque cursor binds pool, profile, filter fingerprint, sort order, direction, and last key tuple. Null ordering and numeric/text comparison are explicit. Under live edits, page membership may change; do not promise a frozen table snapshot.

### 9.3 Representation and size

Store time consistently as integer UTC milliseconds and serialize RFC 3339 UTC strings at the API boundary. The database transaction's recorded time determines expiry and capacity, not client timestamps.

Lease tokens use cryptographically secure randomness generated in the Worker. They may be stored in protected D1 attempt/receipt data to support recovery, but are omitted from ordinary logs and table responses. API-key secrets are different: only their digests are stored.

Avoid excessive payload duplication: an immutable payload snapshot may be referenced by attempts/receipts when it preserves exact replay semantics. Never reconstruct an old response using current mutable task values. Separate large payload/result JSON from narrow list projections where that materially reduces query work.

## 10. Atomic operations and idempotency

### 10.1 D1 transaction rule

D1's documented `batch()` executes prepared statements sequentially as a transaction and rolls back the sequence on a statement failure. Use it, or a single SQL statement, for each atomic transition. [D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)

The implementation must prepare the complete batch before calling it. It cannot fetch a batch result, run JavaScript based on that result, and insert more statements into the same transaction. Data dependencies inside the batch must be expressed in SQL through subqueries, CTEs, request-item staging, or carefully tested triggers.

Do not implement correctness using an in-memory mutex, an expiring D1 lock row, KV, an Access session, a separate SELECT followed by an unconditional UPDATE, or assumed support for PostgreSQL `SELECT FOR UPDATE SKIP LOCKED`. Do not hold manual BEGIN/COMMIT across separate Worker binding calls. Short D1 serialization is expected; keep network work and full-table parsing outside it.

The first engineering milestone MUST prove the chosen SQL approach against actual remote D1. Record its statement count and bound-parameter count. A locally available SQLite feature is not automatically a verified D1 feature.

### 10.2 Reference claim algorithm

The following is the required transaction structure, not permission to omit its guards:

1. Authenticate the key; validate request shape; normalize the requested profile and filter. Resolve a previous receipt early if one exists.
2. Compile a parameterized eligibility/order query and prepare up to K random attempt IDs/tokens outside D1. Pass seed data as bounded JSON where useful. Read configuration for compilation, retaining all relevant revision IDs.
3. Start one D1 batch by **strictly inserting** the unique request receipt/context, with database time and request fingerprint. A duplicate insertion must abort the new batch; it must not allow the remaining statements to create fresh leases.
4. Recheck key status, the runtime epoch against the installation's active epoch mirror, configuration revisions, and active entities inside the batch. Reject/retry compilation on stale configuration. Checks may use constraint-backed assertions or conditional staging, but failure must stop dependent writes. Database time recorded in this transaction is the linearization time for expiry and capacity decisions throughout this batch.
5. Compute effective active counts and remaining capacities from current authoritative rows inside the transaction. Apply mandatory/request filters and deterministic ordering, then stage only the eligible bounded selection in request items. Bind each selected task to a distinct pre-generated attempt ID/token. Apply response-size reduction here too.
6. Close superseded expired attempts as needed without removing their history; increment task generation and sequence; create attempts with full frozen snapshots and contract; update current pointers and per-profile/global counters for exactly the staged selection.
7. Persist the immutable claim response ingredients, including initial expiry, returned payload/projection, limits, counts, and ordered task list. Replayed claims must not pick up a later renewal, changed projection, or edited task.
8. Complete the receipt and commit. Build the HTTP response only from committed immutable receipt data.

A zero-task claim is also receipted. Repeating it returns zero even if new tasks arrive; the next intentional poll uses a new request ID.

If two requests with the same actor/request ID race, the losing strict insert causes rollback. Read the existing receipt and compare its fingerprint; replay it if equal, otherwise return `IDEMPOTENCY_CONFLICT`. An `INSERT OR IGNORE` followed by unguarded updates is forbidden.

Authorization/configuration pre-reads are advisory for compilation. The commit checks prevent a revoked key or stale policy from granting new work. All branches that change counters/history/leases must be conditional on the same accepted task selection. Do not silently call the claim endpoint repeatedly to fill a batch after its receipt has committed.

The agent may use another D1-native design if it proves the same properties, preserves the API, and explains its invariants in the repository. Adding Durable Objects or a second authoritative database requires a documented architectural decision; it is not the default fallback.

### 10.3 Report, renew, and browser edit transactions

Use the same receipt-first pattern for reports and renewals. Stage expected per-item errors rather than aborting the entire report on a normal stale item. For each accepted item, atomically change current task/profile state, finalize/update the attempt, append its event, and record the returned item outcome.

For browser edits, the transaction checks expected edit/input/config revisions and current lease/completion state, writes new normalized inputs/hash/tags, increments the required revisions/generation, and appends audit/receipt records. Checking the lease only before preparing the batch is insufficient: a worker could claim between that check and the edit.

For reset/revoke actions, validate the preview's relevant generation and revisions at commit. If they changed, return a conflict and require a refreshed preview. Do not revoke a newly issued lease that was absent from the reviewed selection.

### 10.4 Request identity and replay window

Every mutating request includes a UUID `request_id` and stable `request_created_at`. Actor scope is the API-key ID for compute requests and verified Access subject for admin requests. A request ID is unique across actions for the actor, not merely within one endpoint.

Normalize and hash the operation, canonical entity IDs, worker ID, and complete semantic body. Exclude Authorization secrets. Do not generate a new timestamp, request ID, or item ID during retries. An alias and its canonical route must resolve consistently; stored receipts retain enough original route information to allow an unchanged replay after route edits.

Retain receipts for at least the greater of 48 hours or the installation's maximum configured lease lifetime plus 24 hours, and never shorten an existing receipt's deadline. Existing receipts are looked up before rejecting an old request timestamp. A previously unseen request older than 24 hours or more than five minutes in the future is rejected; an expired receipt must not be presented as an indefinite replay guarantee. Client automatic retries end well within this window.

Report finalization also has lease-level deduplication through normalized outcome/result fingerprints, which survives receipt pruning. An HTTP timeout after commit is not evidence of rollback. Retry with the same IDs, or recover active leases; never automatically invent a replacement claim ID to hide an uncertain result.

Key creation has a documented exception: store only a redacted receipt, because the newly generated secret is shown once. A replay returns key metadata plus `secret_available: false`. If the first response was lost, the administrator can revoke that key and create another; raw secrets are never recovered from D1.

### 10.5 Failure and retry behavior

Transient D1/network/overload errors use a bounded retry policy. An outer retry after uncertain execution is protected by receipts, not by an assumption that a write failed. Log correlation IDs and normalized error codes without payloads/tokens.

Return a retry hint for busy/overload and rate-limit responses. Distinguish transient overload from daily free-quota exhaustion: repeatedly retrying the latter will not restore service immediately. Generic infrastructure HTML/errors may bypass the application; the Python client must preserve useful status/text snippets and apply bounded retries safely.

## 11. Compute HTTP API

### 11.1 Common contract

Base URL is `https://broker.example.com/api/v1`. Use HTTPS and `Authorization: Bearer <family-key>`; secrets never appear in query strings. JSON requests use UTF-8 and `Content-Type: application/json`.

Required endpoints:

| Method/path | Purpose |
| --- | --- |
| POST `/claim` | Obtain up to K leased tasks |
| POST `/report` | Report success, release, or permanent failure for one or more items |
| POST `/renew` | Renew one or more active leases |
| POST `/recover` | Read current active leases for this key/worker/profile |

Recover is logically read-only and does not need a mutating receipt. Keep it POST so filters/worker identifiers need not appear in logs of query strings. No endpoint accepts client-supplied SQL or authoritative counters/timestamps.

Successful envelope:

~~~json
{
  "ok": true,
  "api_version": "1",
  "request_id": "2d9e8f53-7306-4f71-8469-7519e3c85534",
  "data": {}
}
~~~

Error envelope:

~~~json
{
  "ok": false,
  "api_version": "1",
  "request_id": "2d9e8f53-7306-4f71-8469-7519e3c85534",
  "error": {
    "code": "STALE_LEASE",
    "message": "A newer attempt has been issued for this task.",
    "retryable": false,
    "details": {"task_id": "u4-m30"}
  }
}
~~~

Use actual HTTP statuses: 400 malformed request, 401 authentication failure, 403 forbidden/revoked scope, 404 unknown authorized entity, 409 conflict/stale generation, 410 too-old unseen request, 413 size limit, 422 schema/filter/value failure, 429 rate limiting, 503 temporary unavailable or quota exhaustion. A quota error must provide its distinct application code and an honest retry hint. A batch of valid and invalid report items returns 200 with per-item status/error; it is a successfully processed report envelope.

Reject unknown mutation fields to expose client mistakes. Version API contracts explicitly. Document which optional response fields clients may ignore.

### 11.2 Claim

~~~json
{
  "request_id": "2d9e8f53-7306-4f71-8469-7519e3c85534",
  "request_created_at": "2026-09-04T12:00:00Z",
  "pool": "diameters/gpu",
  "worker_id": "slurm:cluster-a:job-123:array-4",
  "count": 8,
  "lease_seconds": 7200,
  "filter": "has:ready AND memory_gb >= 30"
}
~~~

Example response data:

~~~json
{
  "canonical_profile_id": "f34fd2c6-ab3d-4275-86e4-3067422d247c",
  "requested_count": 8,
  "granted_count": 1,
  "limiting_reasons": ["ELIGIBLE_TASKS"],
  "tasks": [
    {
      "task_id": "u4-m30",
      "attempt_id": "13ed6727-ddd3-457e-b3e2-07bdb204144f",
      "lease_token": "example-opaque-token",
      "lease_generation": 7,
      "instance_epoch": "example-installation-epoch",
      "issued_at": "2026-09-04T12:00:00Z",
      "expires_at": "2026-09-04T14:00:00Z",
      "maximum_expires_at": "2026-09-05T12:00:00Z",
      "input_revision": 3,
      "attempts": 1,
      "attempts_total": 2,
      "tags": ["ready", "gpu"],
      "data": {"n": 4, "m": 30, "memory_gb": 40}
    }
  ]
}
~~~

The metadata values above are illustrative, not a fixture to hardcode. Count must be a positive integer. An excessive count is capped and reported as `REQUEST_CAP`; malformed/nonpositive count is an error. Valid limiting reasons include REQUEST_CAP, WORKER_PROFILE_CAP, PROFILE_CAP, POOL_CAP, WORKER_FAMILY_CAP, FAMILY_CAP, ELIGIBLE_TASKS, RESPONSE_SIZE, and DRAINING. Include only reasons that affected this request, without leaking another family's private configuration.

An empty claim returns `tasks: []`, `granted_count: 0`, and a suggested `retry_after_seconds`. If the pool/profile is disabled/draining, return an empty claim with DRAINING; a revoked key receives an authorization error.

### 11.3 Report

~~~json
{
  "request_id": "72508c09-5fce-48a7-a0c7-7426386e0975",
  "request_created_at": "2026-09-04T12:10:00Z",
  "pool": "diameters/gpu",
  "worker_id": "slurm:cluster-a:job-123:array-4",
  "items": [
    {
      "item_id": "item-1",
      "task_id": "u4-m30",
      "attempt_id": "13ed6727-ddd3-457e-b3e2-07bdb204144f",
      "lease_token": "example-opaque-token",
      "lease_generation": 7,
      "instance_epoch": "example-installation-epoch",
      "outcome": "success",
      "result": {"diameter": 45, "metrics": {"runtime": 589.2}},
      "runtime_seconds": 589.2
    }
  ]
}
~~~

Release uses `outcome: "release"` and optional `message`/`details`. Permanent failure uses `outcome: "permanent_failure"`, a required nonblank `message`, and optional `details`. Runtime must be finite and nonnegative when present. Result JSON may be any supported JSON value subject to the issued result contract.

Response data contains an `items` array in the same order, each with item ID, task/attempt ID, `status: "applied" | "already_applied" | "rejected"`, and either authoritative outcome/completion time or a structured error. Include whether an accepted report was late. The server does not accept a report merely because the task's public ID exists.

### 11.4 Renew and recover

Renew uses the same request/worker/profile envelope and an items array containing attempt identity, token, generation, epoch, and `lease_seconds`. Return each item's current/new expiry and maximum expiry, or its individual error. An expired lease cannot be renewed, even if a late result could still be accepted.

Recover takes `pool`, `worker_id`, and an optional cursor. Paginate if necessary; return task DTOs equivalent to claims, but with current lease expiry and explicit `recovered: true`. It is authenticated with the same issuing key. Changing a worker ID must not silently adopt another worker's tasks.

### 11.5 Error code families

At minimum document: BAD_REQUEST, UNAUTHENTICATED, FORBIDDEN, KEY_REVOKED, UNKNOWN_POOL, INVALID_FILTER, FILTER_TOO_COMPLEX, UNKNOWN_FIELD, INVALID_VALUE, PAYLOAD_TOO_LARGE, IDEMPOTENCY_CONFLICT, REQUEST_TOO_OLD, CONFIG_CHANGED, TASK_LEASED, TASK_COMPLETED, EDIT_CONFLICT, INPUT_CHANGED, STALE_LEASE, LEASE_EXPIRED, RESULT_CONFLICT, INVALID_RESULT, INSTANCE_CHANGED, BUSY, RATE_LIMITED, QUOTA_EXCEEDED, and INTERNAL_ERROR.

All expected failures need actionable text. Do not expose raw SQL, stack traces, token values, or internal database identifiers where they are unnecessary.

## 12. Administration API

The browser requires a documented API, not privileged direct D1 queries. Keep the API usable by a future alternative browser client. Use the same response/error conventions as the compute API.

Minimum resources/actions under `/admin-api/v1`:

| Resource | Required operations |
| --- | --- |
| `/me`, `/bootstrap`, `/settings` | Identity, setup readiness, allowed administrator setup, validated settings updates |
| `/families`, `/pools`, `/profiles` | List/detail/create/update/disable/archive; revision checks |
| `/pools/{id}/fields` | Schema definitions, result mapping, validate/preview/apply changes |
| `/pools/{id}/tasks` | Paginated list with filter/sort/field selection; create |
| `/tasks/{uid}` | Detail and conditional patch |
| `/tasks/{uid}/attempts` | Paginated immutable history |
| `/tasks/bulk/preview`, `/operations/{id}/apply` | Frozen selection, reviewed action, resumable commits |
| `/imports/preview`, `/imports/{id}/chunks` | Mapped import preview and idempotent chunk application |
| `/exports` and export-page endpoints | Frozen selection, bounded typed pages, downloadable metadata |
| `/leases` | Filtered current leases and reviewed revocation |
| `/keys` and key actions | Metadata, one-time issue, rotation, soft/hard revocation |
| `/views` | Personal/shared saved views |
| `/audit`, `/warnings` | Paginated activity and warning resolution |
| `/diagnostics` | Versions, schema health, counts, sampled usage, deployment status |

Freeze exact endpoint schemas in an OpenAPI document during implementation. The resource grouping above is normative; harmless naming refinements are allowed if the UI/client/docs remain consistent.

Example conditional edit body:

~~~json
{
  "request_id": "c4aff77d-1e1f-46ee-b24a-5ab893e56ff7",
  "request_created_at": "2026-09-04T12:05:00Z",
  "expected_edit_revision": 12,
  "expected_input_revision": 3,
  "patch": {
    "data": {"m": 32},
    "tags": ["ready", "gpu"],
    "admin_note": "Repeat with the revised modulus."
  }
}
~~~

`patch.data` patches named input keys; it does not replace the entire object. Use an explicit unset list for removing nullable fields. Do not overload null to mean both deletion and a null value. Unknown/system fields are rejected. A successful edit returns the complete authoritative row projection and new revisions. A conflict returns the current relevant values/revisions so the browser can resolve it.

List endpoints support bounded page size, field selection, a canonical profile context, and opaque cursor. They must never send full attempt history implicitly. CSV/JSON exports obey the same authorization rules as the grid.

## 13. Python helper

Deliver one `task_pool.py` requiring only the Python standard library. Support Python 3.10+ or a clearly documented later minimum justified by the target environments. No Cloudflare SDK, Google credentials, requests, pandas, or database library is required by the helper.

The public interface should preserve familiar usage:

~~~python
from task_pool import TaskClient

client = TaskClient.from_env("diameters/gpu")

for task in client.claim(8, filter="has:ready", lease_seconds=7200):
    result = run_computation(task.data)
    task.complete(result)
~~~

Also support:

~~~python
task.release(note="Temporary memory shortage")
task.fail("Unsupported parameter combination", details={"reason": "unsupported"})
task.renew(lease_seconds=1800)
active_tasks = client.recover()
~~~

`from_env()` reads `TASK_MANAGER_URL`, `TASK_MANAGER_KEY`, and optional `TASK_MANAGER_WORKER_ID`. Direct constructor arguments override environment values. The base URL convention must be unambiguous; examples use the broker origin and the helper appends `/api/v1` exactly once.

Task objects expose `task_id`, `data`, tags, attempt/lease metadata, and complete/fail/release/renew methods. `complete(result, runtime=None)` measures elapsed monotonic time since receipt unless overridden. For recovered tasks, automatic runtime starts at recovery and is marked accordingly; do not pretend it measures the full original computation. Allow explicit runtime for resumed tasks.

Generate a request ID and request timestamp once per logical operation and preserve them across network retries. Use bounded exponential backoff with jitter and Retry-After where supplied. Retry transport failures and configured transient statuses; do not retry permanent authentication, filter, conflict, or validation errors automatically. Do not retry forever on quota exhaustion. Expose typed exceptions with code, status, retryability, and safe detail.

Default network timeout: 15 seconds per request. Default retry budget: 60 seconds total; configurable. Retain pending report identity on the Task object after a timeout so an unchanged explicit retry reuses it. A changed result must never reuse an earlier request ID. For process-level recovery, offer explicit request-ID override/operation receipt metadata and clear guidance about uncertain claims.

No automatic background heartbeats are required. Document renewing before expiry and choosing a lease that matches the computation. Optional explicit batch report/renew methods should reuse the same server contracts and per-item outcomes. Task methods may send one-item batches.

Worker identity resolution:

1. Explicit argument or environment override.
2. Under Slurm, a stable combination of cluster, array-job/array-task identity where applicable, otherwise job ID; omit PID so restarts within the job can recover.
3. Outside Slurm, hostname/process identity as a convenience. Explain that recovery after restart needs an explicitly stable ID.

Reject mutating task operations from nonzero torchrun RANK by default; provide a deliberate override. Rank zero coordinates the lease and passes inputs/results to other ranks. Include a minimal Slurm array example and a torchrun example.

Parallel Python examples MUST pass the task object or its explicit serializable handle into the function that calls complete; never yield only a parameter and then refer to an undefined `task`. Do not initialize hidden HTTP threads/sockets that prevent use in subprocess workers. If objects are not picklable, provide a simple handle reconstruction pattern.

Sample worker exception handling must distinguish known permanent failures from transient errors. Do not catch every unexpected exception and permanently fail a task by default. An empty claim returns an empty list; optional polling uses a new logical request ID per poll and increasing delay, and can stop cleanly.

## 14. Authentication and application security

### 14.1 Humans

Use Cloudflare Access with an email allowlist and an identity provider or supported email login. The Worker MUST validate the signed Access JWT, including signature, issuer, audience, expiry, and required subject/email claims. Do not trust an email header merely because it has a Cloudflare-looking name. Access documentation explicitly requires origin-side token validation to prevent bypass. [Access application setup and token validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)

Use a maintained JWT implementation compatible with Workers Web Crypto. Cache signing keys safely with a bounded lifetime and handle key rotation. Validate application identity at every admin API request. A failed or unavailable identity check fails closed.

There is one full-administrator role in v1. Configure one or more bootstrap/owner identities through deployment configuration. A signed Access identity matching this owner configuration retains emergency admin access even if the database allowlist is damaged. Ordinary administrators are stored in D1. The UI cannot remove deployment-level owner access or change the Access trust configuration.

The application cannot override an Access edge policy that denies a request. Document that recovery from an Access-policy mistake is performed by the Cloudflare account owner in Cloudflare's dashboard.

For browser mutations, check an exact allowed Origin and require JSON plus an application-specific request header or validated CSRF token. Do not enable wildcard credentialed CORS. Escape text and render JSON as text, never as trusted HTML. Limit upload sizes and restrict result links to safe schemes. Use a restrictive Content Security Policy compatible with the bundled grid library.

### 14.2 Compute credentials

Each family supports multiple labeled keys for overlap during rotation. Generate at least 256 bits of random secret with Web Crypto. A key may contain a public identifier plus the secret for efficient lookup. Store only a cryptographic digest of the high-entropy secret and nonsecret metadata; do not store the plaintext or a recoverable encrypted copy of the API key.

Use constant-time digest comparison where applicable. Rate-limit obvious authentication abuse with Cloudflare facilities or bounded mechanisms; an in-memory counter is not a global rate limiter. Do not put Cloudflare account API tokens into this application or its browser.

Key states:

- **Active:** claim, renew, recover, and eligible reports.
- **Soft-revoked:** no claim or renewal; recover/report only existing unexpired leases issued to this key.
- **Hard-revoked:** no operations; previously issued leases are ineffective and cannot report, including via a stored success/claim receipt.

Replaying a mutation still requires present authorization. An active key must not replay another key's receipt. A soft-revoked key must not retrieve an old claim response as a way to obtain newly usable work. A duplicate valid report may return its existing acknowledgement while its applicable report permission remains valid.

Show a new key once with Copy and environment-variable snippet controls. Never include it in analytics, audit logs, exceptions, URLs, downloaded views, or persistent browser storage. If its first response is lost, explain the redacted-receipt behavior from section 10.

### 14.3 Installation epoch and recovery fencing

Configure an `INSTANCE_EPOCH` outside D1 as a random installation/recovery generation. Include it in each attempt and receipt's effective identity. Ordinary deployments preserve it. A database restore or clone MUST rotate it before compute traffic is reopened.

Mirror the activated epoch in the installation row. Every normal mutation transaction checks that it matches the Worker's runtime epoch; attempts and replayed receipts must match it too. An owner-only bootstrap/recovery action activates a fresh epoch while traffic remains closed. This rejects both old lease credentials and in-flight requests from an old Worker configuration after activation. It prevents a restored old database from making a previously invalidated worker result valid again. After restore, old leases are shown as invalidated; resume through fresh claims. Keys may need rotation as described in the recovery runbook because a backup may predate revocation.

A local development authentication stub may exist only in local bindings/configuration. Production startup rejects a dev-auth flag, missing Access trust settings, missing owner identity, or missing epoch. A publicly deployed blank database must never be claimable by the first anonymous visitor.

## 15. Initial defaults and validation bounds

Keep defaults in one typed, tested configuration module and display effective values in the UI. These are application defaults; they do not supersede provider limits.

| Setting | v1 default / bound |
| --- | --- |
| Default lease duration | 7,200 seconds |
| Maximum total renewable lease lifetime | 86,400 seconds (24 hours), configurable |
| Tasks per claim | Default request 1; profile cap 20; global v1 hard cap 20 |
| Report/renew items | At most 20 per HTTP request |
| Worker/profile active cap | 20 |
| Profile active cap | 100 |
| Physical pool active cap | 100 |
| Optional family and worker/family caps | Unlimited unless configured |
| Profile maximum attempts | 10 |
| Task-row attempt override | Inherit unless explicitly supplied |
| Physical total-attempt cap | Unlimited unless configured |
| Required nonblank success result | Off by default; configurable per pool |
| Default ordering | Never attempted, then oldest grant, then stable ID |
| Admin page size | 100; maximum 250 |
| Task input JSON | At most 32 KiB per task in v1 |
| Raw result/failure details | At most 16 KiB per item in v1 |
| Compute HTTP body | At most 512 KiB |
| Admin mutation chunk | At most 100 rows AND 512 KiB; reduce adaptively by measured CPU/query budget |
| Claim response | At most 1 MiB, with explicit RESPONSE_SIZE limiting reason |
| JSON nesting | Maximum 20; reject pathological objects/arrays |
| Public task ID / machine key | At most 128 characters; reject controls and empty IDs |
| New mutation freshness | 24 hours past / five minutes future; look up existing receipts first |
| Receipt retention | At least max(48 hours, maximum lease lifetime + 24 hours) |
| Import/bulk preview retention | 24 hours, refreshable through a deliberate user action |
| Live refresh | Off; if enabled, 10 seconds while visible and attended |
| Client timeout / retry budget | 15 seconds per call / 60 seconds total |
| Optional empty-pool polling | Start at 30 seconds; back off to 300 seconds; stop when requested |

A cap of 20 tasks in one call must not require 20 separate transactions. Profile/family caps must be validated coherently but may intentionally be lower than the request cap. Lower grant counts are normal.

If an administrator raises maximum lifetime, future receipt retention must rise accordingly. Validate that the chosen retention cannot expire a receipt earlier than its existing deadline. Defaults may be tuned after the required load test; document the observed reason and maintain API compatibility.

## 16. Performance, costs, and idle behavior

### 16.1 Provider facts to verify at implementation time

As checked on 2026-09-04:

| Item | Published allowance/behavior |
| --- | --- |
| Workers Free | 100,000 requests/day; 10 ms CPU per invocation |
| Workers Paid | Minimum account charge of USD 5/month, including during idle months |
| D1 Free read/write allowance | 5 million rows read/day and 100,000 rows written/day |
| D1 Free storage | 500 MB per database; 5 GB total across the account |
| D1 Paid database size ceiling | 10 GB per database |
| D1 binding queries per invocation | 50 Free / 1,000 Paid |
| D1 bound parameters per statement | 100 |
| D1 row/string size | 2 MB |
| D1 SQL duration limit | 30 seconds |

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

D1 has no idle compute charge when queries are not running, but storage beyond paid-plan inclusions can still cost money. A single D1 database serializes queries; its throughput depends on query duration. The implementation must achieve short database work, not promise unlimited write concurrency. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 concurrency limits](https://developers.cloudflare.com/d1/platform/limits/#concurrency-and-throughput)

Direct static-asset requests are free under the documented Static Assets model. Requests that execute Worker code are accounted for as Worker requests; use the actual routing configuration when measuring. [Static Assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)

Do not advertise “free at the expected scale” until measuring the deployed workload, including authentication, bookkeeping, and browser use. For example, 60 API requests/minute continuously is 86,400/day before browser traffic. One API operation can update many rows and indexes. A full 10,000-row scan at that rate would scan 864 million rows/day. These calculations show why request counts alone are insufficient.

### 16.2 Required engineering measures

- Use indexed, bounded SQL and narrow projections; never fetch all task JSON into the Worker to choose a task.
- Compute caps and select tasks transactionally with set-based SQL where practical.
- Keep the entire invocation, including authentication/configuration/cleanup, below its provider query budget. Do not assume `batch()` permits unlimited statements for one billed query.
- Use bound JSON arrays plus `json_each` or another verified technique to avoid hundreds of placeholders and per-row round trips.
- Keep CPU-heavy CSV parsing in the browser; validate bounded chunks on the server.
- Measure Worker CPU separately from wall time and D1 SQL duration. The free CPU limit is much smaller than a network request's timeout.
- Avoid rewriting an API key's last-used timestamp on every call. Throttle optional metadata updates.
- Use an indexed current-state summary for active counts if needed; prove its transactional maintenance.
- Log sampled timing/query metadata instead of writing an additional detailed metrics row for every request.
- Keep result blobs and historical payloads out of normal grid polling.

No always-on process, keep-warm ping, default cron, WebSocket, or recurring scan is required. A closed browser and stopped compute workers should generate no application traffic. Maintenance can run in bounded chunks from an admin action or a rate-limited opportunistic admin visit. Cleanup must not affect expiry correctness or delete permanent history.

If the verified feature set cannot reliably fit the free CPU or query limits, state this clearly and supply the USD 5/month deployment profile as an explicit choice. Do not solve it by disabling validation, removing receipts, or weakening concurrency rules. Do not silently change the user's subscription or assume paid accounts can always downgrade without reducing storage.

### 16.3 Performance acceptance targets

Use 10,000 tasks/pool and realistic payloads, with another profile sharing the pool and at least one second family. Run from a region representative of the user's workers. Record actual end-to-end, Worker CPU, D1 duration, rows read/written, and error distributions.

Initial engineering targets, not provider guarantees:

- First task-table page usable within two seconds on a normal desktop connection after authentication.
- Typical inline save visibly acknowledged within one second at steady load.
- Claim/report p95 below one second and p99 below three seconds at 60 calls/minute with representative batches, excluding clearly reported external network outages.
- Twenty simultaneous claim calls never duplicate an active task or violate caps; record burst latency separately.
- First call after at least 30 minutes without requests completes correctly without a keep-warm service; measure its latency rather than promising zero cold-start delay.
- A 10,000-row import/export completes with progress, bounded memory, and no silent truncation.

If targets are missed, report the measured bottleneck and correct query/index/batch design first. Do not repeatedly broaden testing after a concrete gate is satisfied; focus on remaining failures.

## 17. Retention, export, backup, and migration

### 17.1 Retention policy

Keep task IDs/tombstones, accepted results, and full attempt/audit history indefinitely by default. Receipt/import-preview cleanup is separate and bounded by their documented retention. Logical archival keeps a pool organized and stops new work; it does not reduce database storage.

Expose approximate storage usage, history growth, and configured limits in the admin diagnostics screen. Prefer existing D1 metadata and manual diagnostics to a recurring full-storage scan. Warn with headroom before the applicable database ceiling, so the owner can export, move to a suitable plan, or enable an archival extension.

Illustrative capacity: 10,000 results of 10 KiB are about 98 MiB before inputs, attempt snapshots, indexes, and receipts. Several complete runs can therefore reach the single-database free limit even when active traffic is modest. This is an estimate to explain the constraint, not a storage forecast.

### 17.2 Portable data exports

Provide a complete logical export with families/pools/profiles, schema, tasks, results, IDs, saved shared views where relevant, attempt history, and audit records. Include a manifest with application/schema versions, timestamp, counts, checksums, and explicitly omitted security fields. Exported data must be usable without this app.

Routine portable exports omit API-key digests, lease tokens, and live request authentication material. They preserve scientific inputs/results and history, and import into a new installation with disabled pools and no inherited live credentials/leases. Label synthetic historical imports clearly; do not fabricate original worker identities or times.

### 17.3 Backups and restore

A native database backup is different from a task CSV or live traversal export. Document the supported D1 export and Time Travel recovery procedures and perform a restore drill into an isolated environment. Never rely on the alpha-only D1 `dump()` binding for modern databases.

D1 Time Travel currently retains seven days on Free and 30 days on Paid. It is not an indefinite archive, nor protection against every account/deletion scenario. [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

For a consistent logical application backup, put the installation in maintenance mode, block task/configuration/key/history mutations including report/renew/admin edits/cleanup, allow in-flight transactions to finish, then export. Maintenance checks occur in mutation transactions so a stale precheck cannot commit afterward. Preserve an owner-only maintenance-control path to end the mode and allow read-only export; export orchestration must not modify the business data being backed up. Large exports do not need a long SQL transaction if that data is deliberately stable. Explain the interruption to active workers before maintenance.

Recovery runbook MUST cover: keeping traffic closed, restoring data, checking schema/version compatibility, rotating INSTANCE_EPOCH outside D1, invalidating old leases/receipts, reviewing keys that might have been revoked after the backup, validating counts/checksums, testing a disposable task, and reopening traffic. Code rollback and database rollback are separate actions.

The full native-backup operation may require the owner's Cloudflare dashboard/CLI access. Routine task viewing, editing, data export, and project organization must remain available in the application without that access. [D1 import/export procedures](https://developers.cloudflare.com/d1/best-practices/import-export-data/)

### 17.4 Optional R2 archival extension

Do not make R2 a dependency of the initial deployment. If added later, it stores old immutable attempt payload/result bodies; D1 retains searchable metadata, hashes, task IDs, and archive references. The browser must still open/download archived attempts.

Because D1 and R2 do not share a transaction, archive by writing a deterministic object, verifying checksum/readability, committing the D1 reference, then clearing only eligible duplicate payload data. Operations must resume safely after interruption and never delete the sole verified copy. Keep late-result and receipt dependencies online until safe. Storage charges and any maintenance schedule are explicit owner choices.

### 17.5 Moving from Google Sheets

Provide a browser import guide for CSV exported from existing task tabs. Let the user map task IDs, inputs, tags, results, completion, and historical attempt counts in a dedicated reviewed migration mode. Normal task import cannot directly forge runtime state.

Do not import old Apps Script keys, locks, lease tokens, request IDs, or active leases as authoritative Cloudflare state. Drain/stop old workers, export and verify the source, import with pools initially disabled, issue new family keys, run a demo, and switch the Python URL/key. Avoid simultaneously dispatching the same work through old and new brokers.

Preserve supplied IDs and numeric/text precision. Imported completed results may be marked completed after explicit mapping/confirmation, with provenance “imported”; do not invent missing payload snapshots or attempt records. Export the imported pool and compare counts/values before enabling claims.

## 18. Installation, updates, and operations

### 18.1 End-user setup

The normal path MUST be documented for an owner who prefers browser setup and does not want Node.js or Wrangler installed locally:

1. Create/use Cloudflare and GitHub accounts and a domain configured on Cloudflare.
2. Deploy a released repository/template through the supplied Deploy to Cloudflare button or an equivalent documented browser flow.
3. Provision/bind the D1 database and apply versioned migrations through the build/deploy configuration.
4. Configure the admin/broker hostnames, Access application, allowed owner identity, Access issuer/audience, and INSTANCE_EPOCH.
5. Verify alternate hostnames cannot bypass authentication; keep initial data empty and setup closed until checks pass.
6. Open Start Here as the verified owner; create the first family/pool and input columns or import a small CSV.
7. Generate a family key once, copy the Python module and environment snippet, and run the disposable end-to-end demo.
8. Add real tasks and enable the pool.

Cloudflare's Deploy button supports repository cloning/building and D1 resource provisioning; its documentation also describes running migrations in the deploy script using the binding name. Access/domain configuration still needs an explicit installation guide. [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/)

Provide a local developer/maintainer path as well: install pinned dependencies, start local Worker/D1, apply local migrations, run tests, deploy to staging, run remote checks, and publish a version. Local tooling is optional for end users, not for the implementation agent.

Required configuration includes admin origin, broker hostname, Access issuer/team domain, application audience, owner identities, INSTANCE_EPOCH, a separately generated APP_SIGNING_SECRET for cursors/short-lived application tokens, and the D1 binding. The public epoch is not a signing secret. Secrets and local development values are excluded from Git; include a commented example file with nonfunctional placeholders. Use the tested fixed Workers compatibility date in the repository rather than changing it on every build automatically.

Do not expose a public “execute migrations” or “run SQL” endpoint. Application schema migrations are deployment operations, while adding normal task columns updates validated field metadata.

### 18.2 Disposable demo

From the browser, create a clearly marked temporary pool/profile/key and one task. Exercise the actual public compute endpoint: authentication, claim, report, and result display. Either run the supplied tiny Python command or invoke the same HTTP contract server-side from an authorized demo action; do not fake broker success by writing D1 rows directly.

Show each step and failure clearly. Clean up/revoke temporary credentials and archive/remove temporary data through the same safe semantics, leaving a compact test audit record. No real task is modified. Re-running the demo is safe.

### 18.3 Updates

Deliver versioned releases, release notes, and migrations. Users should be able to update their deployed repository from release files through a browser and redeploy; no required clasp, server SSH, or manual editing of bundled minified files.

Before an update, show application/schema versions and backup guidance. Prefer additive migrations compatible with the previous Worker during the deployment transition. A migration that requires maintenance must declare it explicitly and block writes coherently. Never apply a destructive migration just because the browser opened.

Preserve database identity, routes, public task IDs, keys, settings, results, and history across normal updates. Version the Python API and maintain compatibility within v1. Document recovery from a failed build, migration, and Worker rollout separately.

### 18.4 Routine operations

The browser must provide deployment/version checks, pool/profile configuration, active leases, key rotation, reset/revoke actions, warnings, history, export, and storage diagnostics. No email notification service is required.

The owner should not have to start a database, restart a sleeping server, or reinitialize anything after months of inactivity. Persist all required state in D1. Explain any provider account/plan constraints in the manual without pretending the application controls provider policy.

## 19. Deliverables and repository

Deliver the complete source repository and a downloadable release package. Required contents:

| Path / artifact | Contents |
| --- | --- |
| `src/worker/` | Router, auth, domain services, D1 repository, filter compiler, API handlers |
| `src/web/` | Real browser application, editable grid, forms, task details, import/export, saved views |
| `src/shared/` | API types, schemas, supported limits, shared safe normalization |
| `migrations/` | Ordered SQL migrations and initial schema |
| `python/task_pool.py` | Dependency-free client |
| `examples/` | Minimal worker, parallel task-object handling, Slurm, torchrun, sample CSV |
| `tests/` | Domain/filter tests, D1 transaction tests, browser flows, Python client tests |
| `scripts/` | Development, build, deployment, remote smoke/load checks, backup/restore guidance/helpers |
| `wrangler.jsonc` or equivalent | Static assets, D1 binding, compatibility date, environment configuration |
| `package.json`, lockfile | Pinned build/runtime dependencies and consistent scripts |
| `openapi.yaml` or equivalent | Compute and admin API contracts |
| `README.md` | Browser installation and first-task quick start, Deploy button, limitations |
| `docs/` | Architecture/invariants, UI manual, filters, Python/API, operations, costs, migrations/recovery |
| `CHANGELOG.md` | Versioned behavior and migration notes |
| `docs/verification.md` | Actual local/remote/browser results, benchmark measurements, unresolved limitations |

Do not deliver only a generated Worker bundle. Source should remain readable and organized. Include third-party license notices. Release packaging may include prebuilt assets but must retain a reproducible build.

The README's first successful user journey must be: deploy and log in, create/import tasks in the browser, run a short Python worker, see updated results in the browser, download CSV. Advanced family/profile features come afterward.

## 20. Implementation plan and gates

### Phase 1 — D1 concurrency proof and working browser slice

Create the repository, migrations, local runtime, authentication skeleton, and remote staging deployment. Implement one family/pool/profile; a real editable task grid; add/edit/import a small CSV; claim; success report; refreshed result; and CSV export. Prove claim atomicity and duplicate request handling against remote D1 immediately.

Gate: two real concurrent clients cannot acquire the same task, a lost response can be replayed without another attempt, an inline browser edit survives reload/another session, and a Python result appears in the table. Do not postpone the browser until the broker is “finished.”

### Phase 2 — Full lease and data semantics

Implement renew/recover/release/permanent failure, late-result rules, fencing, input snapshots, per-profile state, cross-profile global completion, all caps, reset/tombstones, request retention, and audit. Add typed inputs, result mappings, and full filter grammar with SQL semantics tests.

Gate: concurrent caps, profile overlap, edit-vs-claim, report-vs-reset, stale generations, soft/hard revocation, and partial-report tests pass on actual D1 behavior.

### Phase 3 — Complete browser workflows

Finish column/schema editing, saved views, selection, bulk actions with preview/resume, 10,000-row import/export, task details/history, lease views, key management, config forms/table, warnings, accessibility, and login/offline/conflict feedback.

Gate: an administrator can operate the system for a realistic experiment entirely in the browser plus the tiny Python worker. No routine operation requires the SQL console.

### Phase 4 — Deployment and operations

Complete the Deploy template, browser install instructions, default validation, disposable demo, version/migration flow, portable export, backup/restore drill, epoch fencing, and Sheets migration guide. Verify a fresh installation in a separate test account/environment where available.

Gate: installation steps are reproducible and specific; secrets are never committed; backup restore cannot accept an old lease; data/IDs survive a normal upgrade.

### Phase 5 — Performance and release

Load realistic 10,000-row pools and representative history. Run steady/burst/idle tests and browser imports/exports. Inspect SQL plans and row/CPU budgets; adjust indexes and bounded batch sizes. Produce the verification report, changelog, and release archive.

Gate: the acceptance matrix is satisfied or an explicit, evidence-backed limitation is reported. Passing local tests is not a substitute for remote concurrency or browser validation. Do not claim a free deployment profile unless its resource measurements support it.

## 21. Acceptance matrix

Each ID below must be linked to a test or documented verification procedure in the repository. Tests should assert externally meaningful behavior and invariants, not mirror internal helper implementations.

| ID | Scenario | Required result |
| --- | --- | --- |
| UI-01 | Create a pool and type tasks in the browser | Typed inputs persist and are claimable |
| UI-02 | Edit a cell and reload/open another session | Authoritative edited value is visible |
| UI-03 | Two browsers edit the same revision | One succeeds; the other gets a usable conflict with attempted input preserved |
| UI-04 | Network loss or login expiry during save | No false saved state; safe retry after recovery |
| UI-05 | Worker claims while an input edit is submitted | Either claim sees committed edited inputs or edit is rejected; no mixed snapshot |
| UI-06 | Edit leased/completed input | Named revoke/reset-and-edit action required and atomic |
| UI-07 | Runtime renews while admin edits a note | Note can save without an unrelated runtime revision conflict |
| UI-08 | Paste quoted/multiline/Unicode/large-integer data | Preview and type rules preserve intended values or explain errors |
| UI-09 | Import 10,000 rows with a lost chunk response | Progress resumes; no duplicate tasks; row errors downloadable |
| UI-10 | Export a filtered pool larger than one page | All selected matching rows included, correct headings/types, traversal consistency disclosed |
| UI-11 | CSV contains formula-like text | Default export opens without executing those values; lossless JSON retains exact text |
| UI-12 | Save/reopen a view from another browser | Filter/sort/columns/page size/profile context restored |
| UI-13 | Live refresh during editing/hidden tab/inactivity | No editor overwrite; polling pauses as specified |
| UI-14 | Keyboard-only create/edit/filter/export | Usable focus and error feedback; details form accessible |
| UI-15 | Bulk preview then concurrent task changes | Conflicting rows skipped/rejected explicitly; new matches not silently included |
| DB-01 | Twenty simultaneous distinct claims | No duplicate effective leases and no exceeded caps |
| DB-02 | Simultaneous identical request IDs | Same task set/tokens; counters/history increment once |
| DB-03 | Same request ID, different body | IDEMPOTENCY_CONFLICT and no new mutation |
| DB-04 | Zero-task claim replay after inserting work | Same empty response; fresh ID can claim new work |
| DB-05 | Failure between batch statements | Entire atomic transition rolls back, including receipt/counters/history |
| DB-06 | Lost HTTP response after commit | Unchanged retry returns original result |
| DB-07 | Same pool via default alias and explicit path | Shared profile/capacity/attempt/idempotency semantics |
| DB-08 | Two profiles/families share a pool | One physical lease; family and physical caps each correct |
| DB-09 | Cap below active count after a policy change | Existing work drains; no over-cap new grants |
| DB-10 | Lease expires without scheduled maintenance | Capacity/task eligible by timestamp; active count correct |
| DB-11 | First request after long inactivity | State preserved; eligible task claimed without initialization job |
| LEASE-01 | Success through one profile | Globally completed through every profile |
| LEASE-02 | Permanent failure through one profile | Only that profile closes; message required |
| LEASE-03 | Release | Attempt retained; task immediately eligible subject to policies |
| LEASE-04 | Renewal before/at/after expiry | Active renewal capped; at/after expiry rejected |
| LEASE-05 | Late success before any replacement | Accepted if all generation/key/input checks pass |
| LEASE-06 | Old report after newer lease or reset | Rejected even if replacement also expired |
| LEASE-07 | Changed input followed by old report | Old result never becomes current |
| LEASE-08 | Duplicate identical/conflicting outcome | Identical acknowledged without changes; conflicting rejected |
| LEASE-09 | Mixed valid/stale/malformed report batch | Valid items applied, individual errors persisted, response order preserved |
| LEASE-10 | Recover active leases | Same issuing key/worker/profile only; original data and current expiry |
| LEASE-11 | Full reset after previous attempts | Current counters reset as specified; IDs/sequences/fences/history retained |
| LEASE-12 | Profile reset on globally completed task | Global success retained and limitation explained |
| FILTER-01 | Blanks, NOT, inequality, membership | Documented Boolean semantics, independent of SQL NULL surprises |
| FILTER-02 | Case-sensitive text/case-insensitive tags | Correct exact matching; no accidental LIKE wildcard behavior |
| FILTER-03 | Unknown/disallowed fields and injection strings | Clear errors or literal matching; no SQL/code execution |
| FILTER-04 | Mandatory filter plus OR-heavy worker filter | Mandatory restriction always enforced |
| FILTER-05 | Unreturned field filtering | Allowed only by explicit profile filter allowlist |
| AUTH-01 | Anonymous/forged/expired/wrong-audience Access identity | Admin data and mutations denied |
| AUTH-02 | Admin API through broker/alternate hostname | Denied; static fallback cannot bypass authorization |
| AUTH-03 | Family key requests another family | Denied, including receipt/recover access |
| AUTH-04 | Soft-revoked key | No claim/renew; only permitted existing unexpired reports/recovery |
| AUTH-05 | Hard-revoked key | No new operations or receipt replay; stale leases ineffective |
| AUTH-06 | Key creation lost response/log inspection | Metadata-only replay; no raw key in D1/logs/audit/browser persistence |
| AUTH-07 | Cross-origin mutation and hostile cell HTML | Rejected/escaped; no CSRF or stored-script execution |
| OPS-01 | Fresh browser-led installation | Working protected app, D1, demo, Python claim/report, CSV |
| OPS-02 | Normal code/schema upgrade | Routes, keys, task IDs/results/history preserved |
| OPS-03 | Restore an old backup, then old worker reports | New INSTANCE_EPOCH rejects old authority |
| OPS-04 | Prune transient records | Retention respected; permanent task/attempt history intact |
| OPS-05 | Archive a pool | Still viewable/exportable; no new claims; existing work drains |
| OPS-06 | Import legacy Sheets data | IDs/types/results preserved; no old credentials/leases activated |
| PERF-01 | Baseline traffic plus browser activity | Recorded latency/CPU/read/write budgets; no full-pool JSON selection |
| PERF-02 | Free-plan/resource exhaustion | Useful failure and bounded retry; no weakened correctness |
| PY-01 | Standard-library-only installation | Minimal example runs in supported Python |
| PY-02 | Slurm restart and torchrun ranks | Stable requested identity; nonzero-rank mutation blocked by default |
| PY-03 | Parallel task handler | Correct task is completed; no undefined variable or accidental shared handle |
| PY-04 | Uncertain mutation retries | Stable request/item identity; no duplicate claim due to helper retry |

Use meaningful representative payloads: small scalar fields, a 10 KiB nested result, blank/false/zero values, Unicode, long descriptions, many tags, and strings containing spreadsheet formulas or SQL-looking text. Include a second administrator session and multiple independent compute clients. A local fake in-memory server may test the Python retry wrapper, but cannot establish D1 concurrency correctness.

## 22. Final handoff requirements for the coding agent

Before declaring the implementation complete:

1. Confirm every required browser workflow is backed by durable D1 data and real server validation.
2. Link each acceptance ID to evidence; distinguish automated tests, manual browser checks, and remote load results.
3. Supply the working release, source, Python module, OpenAPI contract, quick start, operations manual, and migration/recovery instructions.
4. Report measured performance and expected costs for the tested workload, including the per-database storage limit and paid-plan idle minimum.
5. List any unavailable credentials/platform access that prevented a required remote check. Do not label an untested deployment production-ready.
6. Demonstrate the complete user journey: browser input → Python claim → computation → report → browser result → CSV/JSON download.

The final product must make routine task work feel like editing and browsing tables, while the Worker and D1 enforce task ownership, retries, and history reliably underneath.
