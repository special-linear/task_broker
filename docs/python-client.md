# Python client

Copy `python/task_pool.py` into your program directory. Python 3.10+ uses only the standard library. The URL accepts either the broker origin or its `/api/v1` suffix. Use HTTPS except for loopback development. Explicit constructor arguments override environment values.

```python
from task_pool import TaskClient
client = TaskClient.from_env("family/profile", worker_id="stable-job-name")
tasks = client.claim(5, filter='n >= 32')
for task in tasks:
    try:
        task.complete({"diameter": int(task.data["n"]) ** 2})
    except Exception:
        # An uncertain completion must be retried or recovered; do not replace
        # it with a different outcome unless that change is deliberate.
        raise
```

`TaskClient.from_env(pool, **overrides)` reads `TASK_MANAGER_URL` and `TASK_MANAGER_KEY`. Stable worker identity matters for recovery. Slurm job/array identity is used without a changing process ID; a caller-supplied worker ID is strongest. Outside Slurm the default includes hostname and PID, so pass an explicit ID if a restarted process must recover leases. Nonzero torchrun ranks are blocked from mutations unless explicitly allowed. See `examples/` for rank-zero coordination and independent serialized handles in a process pool.

Task methods are `complete(result, runtime=None)`, `release(note=None, details=None)`, `fail(message, details=None)` and `renew(lease_seconds=7200)`. `recover()` returns this issuing key/worker/profile's active tasks, including original data and current expiry. There is no background heartbeat. Optional `poll()` backs off from 30 to 300 seconds and accepts a stop callback.

Runtime is measured with a monotonic clock from receipt/recovery, not wall-clock timestamps. An explicit completion runtime overrides that measurement. Recovery marks the runtime origin as recovered.

## Batched completion

`client.complete_many(completions)` accepts a finite iterable of `(task, result)` pairs or `(task, result, runtime)` triples. It creates the lease identities and item/request IDs for you and sends the results through the existing report API. No server upgrade is required.

```python
from task_pool import TaskClient

client = TaskClient.from_env("family/profile", worker_id="stable-job-name")
tasks = client.claim(20)
completions = [
    (task, {"diameter": int(task.data["n"]) ** 2})
    for task in tasks
]
outcomes = client.complete_many(completions)

for outcome in outcomes:
    if outcome["status"] == "rejected":
        print(outcome["task_id"], outcome["error"]["code"], outcome["error"]["message"])
    else:
        print(outcome["task_id"], outcome["status"])
```

All tasks must belong to that same `TaskClient` instance, including tasks reconstructed with its `task_from_handle()`. Duplicate task IDs or attempts are rejected before any request is sent. Resolve an individual task's pending operation before including it. An empty iterable returns `[]` without sending a request when there is no pending batch.

The client materializes and prepares the entire iterable before sending. It divides submissions into sequential requests with at most 20 items and at most 512 KiB each; a single item that cannot fit is rejected locally. The server's separate 16 KiB result limit and issued result contracts still apply. Each returned item corresponds to the input at the same position. `applied` and `already_applied` are successful outcomes. Per-item `rejected` outcomes are returned without raising, and later batches still run. Correct rejected results and submit those tasks again as a new operation. A request-level error stops subsequent batches; earlier acknowledged batches remain committed.

Without an explicit runtime, elapsed time is captured from each task's receipt/recovery when the collection is prepared. This includes time spent computing other tasks or buffering results before the call. To record only the computation time, measure it yourself and append `(task, result, elapsed_seconds)` instead. Explicit runtimes must be finite and nonnegative; `0` is valid and `None` uses the default measurement. `complete_many()` submits immediately; it does not add a background queue or heartbeat. Submit or renew before leases expire.

### Retrying and restoring completion batches

After a request error, `client.pending_completions` retains the prepared requests, the index of the first unacknowledged batch (`next_batch`), and earlier per-item outcomes (`results`). Call `client.retry_completions()` to resume, or call `complete_many()` again with the same tasks, results, runtime overrides, and order. A generator must be recreated or materialized if it has already been consumed. Retries skip acknowledged batches and preserve the remaining requests' exact bytes, IDs, timestamps, and measured runtimes.

Resolve the pending collection before submitting different completions. Individual `complete()`, `release()`, and `fail()` calls for tasks in unacknowledged batches are blocked until it is resolved; explicit renewals remain available. If another request error occurs while resuming, the collection remains available for a later retry. Authentication, validation, and quota errors are not automatically retried indefinitely.

For recovery after a process restart, save the whole collection after an error:

```python
import json
from task_pool import TaskError

try:
    outcomes = client.complete_many(completions)
except TaskError:
    if client.pending_completions is not None:
        # Contains lease credentials and results; use a private local file.
        with open("private-completions.json", "w", encoding="utf-8") as handle:
            json.dump(client.pending_completions.to_dict(), handle)
    raise
```

In the restarted process, recreate the client with the same broker URL, family key, worker ID, and profile route:

```python
import json
from task_pool import PendingCompletions, TaskClient

client = TaskClient.from_env("family/profile", worker_id="stable-job-name")
with open("private-completions.json", encoding="utf-8") as handle:
    pending = PendingCompletions.from_dict(json.load(handle))
outcomes = client.retry_completions(pending)
# Inspect every outcome as in the first example, then retire the saved file.
```

If resuming fails again, save the updated `client.pending_completions` before exiting. Progress is kept in memory until you explicitly save it. Task handles alone do not contain the collection's progress. An `UncertainOperation.operation` describes only the interrupted HTTP request; use `retry_completions()` for this workflow so later batches and earlier outcomes are included. The lower-level `client.report(items)` and `client.retry(pending_operation)` remain available for callers managing their own raw batches.

## Validation errors

When `complete()`, `release()`, `fail()` or `renew()` raises `ValidationError`, its message identifies the invalid field or result column. For example, `Diameter must be text.` means the issued result contract expects a string, while `runtime_seconds: ... expected number ...` identifies malformed runtime metadata. Inspect `error.code` and `str(error)` when catching the exception. Older server versions return only `Correct the malformed item fields.`; deploy the updated Worker to obtain specific messages for new requests.

Result values must match the column types captured when the task was claimed. The example above sends an integer diameter; a text column expects a string such as `{"diameter": "49"}`. A rejected item does not complete the task, so you can correct the value and call `complete()` again on the same task while its lease remains authorized. The client uses a new request identity. Changing a column definition does not change an existing attempt's result contract. An `UncertainOperation` requires the separate retry/recovery procedure below.

The result column's JSON Pointer must also match the returned shape. Use `/diameter` for `complete({"diameter": 49})`. A blank pointer selects the whole result, so an integer column with a blank pointer expects `complete(49)`. Supplying the object in that case raises `Diameter requires an integer.` even though its `diameter` property is an integer. The editor defaults new result columns to their matching property; update existing unintended blank mappings explicitly for future claims.

## Ordered claims

```python
tasks = client.claim(5, filter='n >= 32', sort=[("category", "asc"), ("n", "desc")])
```

`sort` accepts up to eight distinct scalar field keys or labels, in priority order. Directions are `asc` and `desc`. The client serializes this as `sorts: [{"field": "category", "direction": "asc"}, ...]`. The server resolves labels to keys, rejects unknown/duplicate fields and nested JSON, and enforces the profile's worker filter/sort allowlist. Null/missing values come first in either direction; text is case-sensitive and decimal-string integers compare exactly.

Tasks with zero attempts since the requesting profile's last full reset are granted first, ordered by the requested fields, then Task ID and internal UUID. This includes both untouched and fully reset tasks; lifetime history does not lower their priority. Retries follow oldest last grant first, then requested fields, Task ID and UUID. Sorting therefore affects retry order only when last-grant times tie. Soft resets retain attempt counters and retry priority. Filters, capacities, attempt limits and lease fencing continue to apply. Omitting `sort` uses Task ID and UUID within the same fresh/retry groups.

The administrator table's sorting controls its display and exports; workers must send their own claim sort. For ascending `n`, then ascending `m`, use `client.claim(5, sort=[("n", "asc"), ("m", "asc")])`. A new claim after full reset considers the reset tasks in that order alongside untouched tasks. Replaying an earlier request still returns its original grants, and resetting tasks does not revoke leases on other tasks already claimed.

Administrators can build indexes for recurring orders under **Pools & profiles → Claim sort indexes**. Send the same ordinary sort list whether an index exists or not. Without a matching index SQLite can scan all eligible candidates while retaining only the best requested few; an index can avoid that sort and much of the scan. Retry age spans another table, so a single index cannot cover every retry ordering.

Sorting is part of the claim request identity. An uncertain retry preserves the same tasks and order. Resolve an uncertain claim before changing its sort; reusing the same request ID with changed sorting produces an idempotency conflict.

## Uncertain responses

Every mutation has a UUID, creation timestamp and item IDs. Prepared bytes include the measured runtime. A retry after a timeout or lost response resends those same bytes, within a 15-second call timeout and 60-second retry budget. Changed content gets a new identity. Authentication, validation and quota errors are not retried in an unbounded loop. Busy responses and Retry-After are bounded.

```python
import json
from task_pool import UncertainOperation

try:
    task.complete({"diameter": 49})
except UncertainOperation as uncertain:
    # Protect this file: a handle contains a task lease credential.
    with open("private-pending.json", "w", encoding="utf-8") as handle:
        json.dump(task.to_handle(), handle)
    raise

# After a process restart, with the same key/worker/profile:
with open("private-pending.json", encoding="utf-8") as handle:
    restored = client.task_from_handle(json.load(handle))
restored.complete({"diameter": 49})  # unchanged pending request and runtime
```

`PendingOperation.to_dict()/from_dict()` and `client.retry(pending)` also expose explicit operation metadata. Task handles omit the family key but retain scoped lease credentials and pending mutations. Treat them as private. Never print them into shared logs or include them in portable scientific exports.

Late success may be accepted after expiry only while the latest attempt, generation, input hash/revision, installation epoch and key permission still authorize it. Once another attempt or reset fences the old one, its result cannot become current. An identical terminal outcome is acknowledged without another state transition; a conflicting outcome is rejected.
