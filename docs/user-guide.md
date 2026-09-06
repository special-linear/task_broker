# Browser manual

**Start here** explains setup, downloads the Python client, and creates disposable demo work. **Tasks** is the primary workspace. **Pools & profiles** controls schemas and worker eligibility. **API keys** issues and rotates family credentials. **Activity** exposes leases, warnings, operations and audit history. **Settings** holds global defaults, administrator membership, diagnostics, maintenance and portable migration.

## Tasks and conflicts

Create tasks with the accessible form or import a table. Task IDs are generated when blank; supplied IDs are unique within a pool and remain reserved by history. Duplicate clones inputs and task metadata into new identities. Delete is a tombstone, not history erasure; restore reuses the original identity.

Double-click an ordinary grid cell to edit it. Enter/Tab commits and saves; Escape cancels the active editor. Ordinary cells save immediately. Paste/import and reviewed bulk actions require explicit Save/Apply. Select loaded rows with the selection column; an operation can alternatively freeze **all matching rows**, including other pages. Page sizes are 50, 100, 250 and **All rows**.

An attempted value stays local if the network fails. A conflict displays the current server row alongside the attempted change. Retry unchanged uncertain operations to reuse their original request identity. Applying a draft against a newer revision is an explicit conflict-resolution action. Input edits on a leased task require **Revoke and edit**. Input edits on completed work require **Reset and edit**. Notes and enabled flags can change without a worker renewal causing an unrelated input conflict.

Leases belong to a physical task, so profiles sharing a pool cannot run the same physical task simultaneously. Success closes it globally. Permanent failure closes only the issuing profile. Release consumes and retains that attempt. A full reset clears current counters and result presentation while retaining lifetime sequences, identifiers and immutable history. A profile reset cannot erase a global success.

Live refresh is off by default. When enabled, it polls every ten seconds only while the page is visible, attended, has pending/running work, and has no obstructing modal/editor. It stops after 15 minutes without user activity. Manual Refresh resumes attendance. No scheduled scan is needed for lease expiry or after inactivity.

## Sorting and All rows

The initial order is Task ID ascending. Click B, then A to sort by **A, B, Task ID**; click C afterward for **C, A, B, Task ID**. Clicking a secondary column promotes it with its existing direction. Clicking the primary column toggles its direction. Headers show direction and priority. Use the sort chips to remove fields or **Reset sorting** to return to Task ID. Up to eight fields are allowed, including Task ID; adding a ninth explains which action is needed. Internal task UUID breaks final ties.

Sorting applies to every matching task, across page boundaries. Missing values and nulls come first in either direction. Text uses case-sensitive binary order, numbers and Booleans use numeric order, and decimal-string integers remain exact. Datetimes use the existing normalized ISO representation. JSON columns cannot be sorted directly. Importing or pasting does not store a permanent spreadsheet row position; recreate that ordering with its columns.

**All rows** loads matching tasks in sequential pages of at most 250 and progressively fills the virtualized grid. The progress indicator distinguishes complete and incomplete loads. **Cancel loading** keeps the loaded prefix; **Retry loading** resumes it after cancellation or failure. **Refresh / resume** starts a new traversal. Changing pool, filter, profile or sort cancels obsolete requests. Once complete, header sorting works locally without another download. Sorting an incomplete load starts over with the new server order.

All mode suspends live polling and restores your prior polling setting when you return to a numbered page size. Editors and unsaved drafts defer refresh and reordering until saved or discarded. The loaded rows are a live traversal, not a database snapshot: concurrent edits can move tasks across page boundaries. Refresh again when you need a newer complete view.

## Typed columns and filters

Input columns support string, integer, number, Boolean, ISO datetime and JSON. Result columns map scalar or JSON values from the returned result using JSON Pointer, such as `/metrics/diameter`; escape `~` as `~0` and `/` as `~1`. Results are checked against the contract issued with the attempt, even if later configuration changes.

Missing fields and explicit `null` are distinct. Empty strings are legitimate strings and count as blank in filters. Boolean false and numeric zero are not blank. Integers beyond ±9,007,199,254,740,991 must be decimal strings in JSON; filtering and sorting compare them exactly. Use string columns for codes whose leading zeros matter. Unsafe unquoted integer literals are rejected before JavaScript can round them.

The builder and expression editor use the same grammar:

```text
n >= 32 AND n IN (32, 64, 128)
label CONTAINS "exact_%"
NOT (label IS BLANK) AND has:gpu
(n < 10 OR n > 100) AND enabled = true
```

Operators: `=`, `!=`, `<`, `<=`, `>`, `>=`, `IN`, `NOT IN`, `CONTAINS`, `STARTS_WITH`, `IS BLANK`, `IS NOT BLANK`, `AND`, `OR`, `NOT`, parentheses and `has:tag`/`has_not:tag`. Quote strings with JSON double quotes. Names are resolved against declared keys/labels; string values are case-sensitive. Tags are trimmed, NFC-normalized, case-folded and deduplicated. Blank comparisons follow explicit Boolean rules: ordinary comparisons against blank are false; negation applies to that Boolean, independent of SQLite NULL behavior. `%` and `_` in string functions are literal characters.

A profile's mandatory filter is always ANDed with the worker filter. Worker-requested filtering and sorting require each field in **Allowed worker filter/sort fields**, including fields omitted from the returned projection. Unknown/disallowed names and excessive complexity produce errors rather than broadening the selection.

In **Pools & profiles**, open a pool's **Claim sort indexes** panel to configure up to four recurring orders. Save a definition, then explicitly **Build index**; workers continue to send ordinary sort lists. Scalar inputs and direct task columns can be indexed. Computed/profile-dependent or result sorts remain available without an index. Indexes update automatically with task changes. Incompatible changes to referenced fields remove the old index and require rebuilding; label-only changes preserve it. Failed builds leave a retryable definition, and claims continue through the normal unindexed path. Delete definitions you no longer need.

## Import and reviewed operations

CSV/TSV parsing runs in a browser worker. Review column mappings and typed conversion errors. **Add** creates new IDs; **Update** requires existing IDs; **Upsert** is an explicit combination. Files may contain up to 10,000 rows per operation. Application chunks start at 50 rows and remain below 100 rows and 512 KiB. A preview freezes IDs and revisions in D1. Concurrent edits or replacement leases reject the affected rows at application time. New filter matches are not silently added.

Cancellation stops future chunks; successful chunks remain committed. Each uncertain chunk retry retains its full prepared body and receipt identity. Preview lifetime is 24 hours and can be deliberately extended. Download rejected-row errors and correct them explicitly.

Schema changes that add optional fields or alter presentation use a lightweight path. Incompatible changes close that pool to claims and payload edits. The migration saves old contracts and input snapshots and advances in bounded chunks. Invalid conversions remain visible; correct them with typed controls and resume from **Columns**. Activation happens only after every selected row validates. Closing the browser does not reopen a partly migrated pool.

## Views and downloads

Save personal or shared views with filter, the complete sort list, column order/width/visibility, page size (including All) and profile context. They live in D1 and can be reopened in another authenticated browser. Existing single-sort views still open.

Task exports use the complete table sort for every scope: matching rows, the whole pool or selected rows. Each export freezes task IDs and their sorted ordinals, then reuses that order across all pages and CSV/JSON/NDJSON formats. Attempt history follows that frozen task order, then attempt sequence. Values remain live during download; the manifest states this explicitly. CSV protects formula-like text with a leading apostrophe. JSON/NDJSON retain exact strings, raw results, typed values, metadata and checksums. Attempt-history exports include original inputs, contracts, mappings and timings. Routine exports omit compute secrets and lease credentials.

For a portable installation migration, enter maintenance on an empty destination, import a checksummed portable NDJSON file, and review the disabled pools/profiles. Claim sort index definitions are restored as unbuilt; build the ones you need on the destination. No source credentials or active leases are inherited. The browser supports files up to 128 MiB; larger datasets need a maintainer-controlled chunk workflow or native D1 backup/restore.

## Legacy Sheets migration

Stop or drain the old workers and export each Sheets task tab as CSV. Create a **disabled** destination pool with reviewed field types. In **Reviewed legacy migration**, map task IDs, inputs, tags, the raw JSON result, the completed flag, and historical attempt counts. Completion is explicit. Original worker names, lease tokens, credentials, request IDs and missing timestamps are never invented or activated. Imported history is labeled imported and has its own import time/provenance. Compare exported counts and values, issue new family keys, run the demo, then enable the new pool. Do not dispatch the same scientific work from both systems during the switch.
