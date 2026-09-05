# Operations and recovery

## Routine operation

Use Settings for deployment/schema readiness, current task/attempt counts and database size. Use Activity for effective leases, warnings, paginated audit, frozen operation progress, resumption, cancellation and downloadable row errors. Disable a profile/family or archive a pool to stop new grants while existing work drains. Archive preserves tasks, results and history. Hard key revocation immediately makes its leases ineffective; ordinary rotation soft-revokes the old key and displays the replacement secret once.

All compute mutations have bounded retry and stable operation identities. After a timeout, retry the complete unchanged prepared request. Do not guess whether it committed or issue a fresh claim identity. Authentication errors require renewed credentials; resource exhaustion requires capacity/quota recovery. The Python helper exposes serializable pending operations and task handles. Handles contain lease tokens and must be stored privately.

## Consistent backup

1. Have a deployment owner close mutations using Settings ? maintenance. The barrier commits in D1; later normal mutations reject. Confirm readiness and the database epoch.
2. Export D1 using `wrangler d1 export DB --remote --env staging --output <private-backup.sql>` or the dashboard's native export/Time Travel workflow. Wrangler may print a temporary download URL; keep the CLI log private. A native SQL export contains key digests, lease tokens and receipts and must never enter a source repository or public release.
3. Record UTC time, Worker version, schema version, table counts and a SHA-256 hash. Store the backup in access-controlled storage. Validate a restore separately. A browser task export freezes membership but reads live values and is not a consistent installation backup.
4. Reopen source traffic after export completes. `scripts/backup-verification.mjs` performs this sequence and uses a finally block to restore the previous maintenance state.

## Restore and epoch fencing

Keep all external traffic closed throughout recovery. A restored database can contain old leases and keys, so code deployment alone is insufficient.

1. Restore the native SQL/Time Travel snapshot into an isolated installation and verify SQLite/D1 integrity, schema version, IDs, tasks, attempt sequences, input snapshots and results.
2. Generate a **new external `INSTANCE_EPOCH` Worker secret**. It is not read from the backup. Keep the restored database's maintenance flag set. Rotate `APP_SIGNING_SECRET` too when recovering from compromise; do not reuse exposed secrets.
3. Deploy with traffic still closed. A mismatch between the external epoch and the D1 active-epoch mirror rejects mutations. Sign in as a deployment owner and use **Activate recovery epoch** while in maintenance.
4. Review every restored compute key. Owners may hard-revoke restored keys during maintenance; creation and ordinary configuration edits remain blocked. Verify the Access owner/administrator allowlists independently of the database backup.
5. Verify counts/history and show that old requests and old task handles cannot regain authority. Reopen to a restricted test worker, issue a fresh key, claim and report a new task, and verify its result and export. Only then reopen normal traffic.

The isolated verification script restores a real native staging backup into a separate local D1 store and tests this sequence. It does not restore or overwrite the live staging database. A production Time Travel restore and traffic cutover remain an operator verification procedure.

## Portable migration and legacy data

Portable export omits live tokens, key digests, receipts and administrator identities; it preserves permanent identifiers, contracts, attempts, mapped/raw results and shared views. Finish schema migrations before portable export. Use maintenance for a consistent portable traversal. The browser verifies the manifest, row counts and per-chunk checksums before importing into an empty maintained installation. Imported configuration starts disabled; historical key references are hard-revoked placeholders. Re-select the same file to resume at the stored operation position. Review all configuration and issue new keys before enabling work.

Reviewed legacy import is distinct from Add, Update and Upsert. Disable the target pool first. Explicitly map original task IDs, typed inputs, historical counts, completion and raw result JSON. Preview conversion errors and duplicate/tombstoned IDs. Imported history is labeled as imported; missing original workers, timestamps or leases are never invented. Preserve an original source export before migration.

## Schema changes and retention

Presentation changes and optional fields use a lightweight atomic path. Incompatible changes create an immutable target contract and freeze a reviewed selection. Claims and payload edits stop for that pool while chunks migrate. Old definitions, values and conversion provenance remain. Correct rejected rows through the Columns workflow and resume. Activate only after all rows validate. Concurrent tasks or revisions invalidate an old preview.

Pruning is manual and bounded. Only expired receipts and transient import/export/bulk previews qualify. Receipt retention is at least 48 hours and conservatively follows the maximum historical configured lease lifetime plus 24 hours. Tasks, tombstones, attempts, results, input snapshots, schema versions and audit history are permanent. Storage warnings require capacity planning or a portable migration; never delete history to recover quota silently.

## Cost and Free limits

As checked on 2026-09-05, D1 Free includes 5 million rows read/day, 100,000 rows written/day, 500 MB per database and 5 GB total. Paid D1 allows 10 GB per database. Index writes count toward usage; freezing an export also writes its selection. Worker-first assets invoke the Worker, so browser assets count in measured traffic. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and [pricing](https://developers.cloudflare.com/d1/platform/pricing/).

The measured 10,000-task import/export plus compute workload used 6.85 million reads and 214,606 writes before the latest guard/count optimizations. It cannot fit one Free daily allowance. Smaller installations can pace imports and limit throughput; do not claim unrestricted 10,000-row daily operation on Free. The measured 6-hour Worker window had 4.295 ms p50 and 11.522 ms p99 CPU, so the 10 ms Free CPU budget also needs a confirmed Free-account test. Staging's account reports `standard`; OAuth cannot read its subscription, but Cloudflare subsequently enforced the D1 Free daily read limit. The first idle test failed for that reason and is retained as evidence. The repeat passed after midnight UTC. The later 1,000-task run used 177,036 reads and 29,346 writes, with 2.792 ms p50 and 14.154 ms p99 aggregate Worker CPU. No subscription was changed.

Workers Paid currently has a $5/month minimum even when idle. Included usage is 10 million requests and 30 million CPU-ms/month; D1 includes 25 billion reads, 50 million writes and 5 GB storage monthly. The measured one-time workload is within these included paid amounts, assuming no other account usage. Persistent storage can grow with permanent history. Read the current dashboard and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) before choosing [the optional paid configuration](../wrangler.paid.example.jsonc), which sets a 50 ms CPU cap and does not change the account subscription. D1 idle compute is zero, but a paid Workers subscription's minimum is not.
