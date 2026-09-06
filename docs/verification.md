# Verification and release status

The retained staging evidence covers schema version 3. It does not verify the new sorting changes, which require migration 0004. See [deployment evidence](evidence/deployment.json).

This is a **release candidate**, not a claim that every acceptance gate is signed off. The complete [62-ID map](acceptance.md) distinguishes automated coverage from procedures requiring an operator or browser accessibility review.

## Established evidence

- **Remote D1 and endpoints:** `docs/evidence/remote-smoke.json` records 20 distinct concurrent clients, five identical concurrent requests, body conflicts, mixed reports, lost-response replay, recovery, edit/claim and reset/report races, history and Access bypass probes. Fixtures were created through the protected administrator API. Local simulation is not offered as proof of remote concurrency.
- **Real deployed user journey:** `staging-journey.json` and `staging-journey.csv` record an Access-protected browser-created task, browser-downloaded Python module, public compute claim/report, visible result 49, and checked CSV content. The temporary key was hard-revoked and the demo archived.
- **10,000-task remote workload:** `performance-remote.json` verifies exact task IDs and decimal-string integers through a complete import/export, a 20-client burst, and 60 steady calls. Its raw timing/read/write measurements remain available, including extra progress reads used by the verifier.
- **Native backup and isolated restore:** `consistent-backup.json` records a maintenance-protected native D1 export; the original SHA-256 is retained privately. `isolated-restore.json` records integrity/foreign-key checks, new external epoch enforcement, restored key quarantine and fresh successful work in a separate local D1 instance. The live staging database was not restored or overwritten.
- **Injected remote failure:** `remote-rollback.json` proves that a real D1 failure after attempt insertion rolls back the receipt, attempt and lifetime counter, and that the unchanged request succeeds after removing the task-scoped trigger.
- **Query plans:** `sql-plans.json` records remote D1 plans for representative candidate, capacity, identity and pending-chunk queries. It is a sample of indexed access paths, not an EXPLAIN of every filter combination.
- **Earlier local baseline:** `local-checks.json` records 30 Worker/D1 tests, six Python tests and eight Chromium/Firefox tests passing before the sorting changes; `python-parallel.json` verifies four actual subprocesses completing distinct handles. New sorting coverage is described below.

Sanitized public evidence lives under `docs/evidence/`; its README describes the redactions. New raw results stay in ignored `artifacts/private/verification/`. Private SQL backups, session cookies, compute keys and CLI logs stay in ignored `artifacts/private/` and are excluded from the release.

## Sorting verification and local measurements

The implementation passed TypeScript/build and generated-OpenAPI checks, 41 Worker/D1 tests, seven Python client tests, 12 Chromium/Firefox tests and 12 publication/packaging tests. Source privacy checks and release packaging also passed. These are local checks; the staging gate below remains open.

`tests/sorting.test.ts` exercises stable promotion, ties across cursor pages, null/missing values, UTF-8 text, exact integers beyond int64, number/Boolean/datetime comparison, legacy views, frozen export ordinals with live values, top-k reference results at k=1/5/20, retry ages, allowlists, filters, caps, replay and concurrent claims. Index checks cover builds, rebuilds, failure/retry, deletion, maintenance after edits, label preservation and schema invalidation. The portable test restores definitions as unbuilt without creating executable indexes.

The actual fresh branch captured from a claim is inspected with `EXPLAIN`: unindexed selection includes `IfNotZero`, `Last`, `IdxLE`, `Delete` and `Sort`, demonstrating pruning by LIMIT. With the configured expression index, `EXPLAIN QUERY PLAN` selects `claim_sort_<generated ID>` without a temporary ORDER BY tree, and the `Sort` opcode disappears. The full retry order still spans profile state and task inputs.

`tests/browser/sorting.spec.ts` imports 10,000 tasks and checks virtualization, multi-column header history, local sorting without task-list requests, selection preservation, cancellation/resume, failure/retry, stale-response rejection, editor and failed-draft protection, polling restoration, matching CSV/JSON/NDJSON order, and administrator index actions. A separate case reads a legacy saved-view label and promotes its normalized field locally.

The [local sorting benchmark](evidence/sort-performance-local.json) compares equivalent two-integer-field pools at 1,000 and 10,000 tasks. Each mode makes five claims at each k=1/5/20, verifies every result against a full reference sort, reports the tasks, then runs ten concurrent claim/report pairs. No browser load test ran during this measurement. The table below shows k=5; reads and SQL time are averages per request, while latency columns are request percentiles.

|  Tasks | Claim mode        | p50 ms | p95 ms | Mean D1 SQL ms | Mean rows read |
| -----: | ----------------- | -----: | -----: | -------------: | -------------: |
|  1,000 | Default           |  41.09 |  70.13 |            6.0 |            344 |
|  1,000 | Custom, unindexed |  46.70 |  48.48 |            7.6 |          2,310 |
|  1,000 | Custom, indexed   |  39.67 |  57.56 |            4.2 |            344 |
| 10,000 | Default           |  38.34 |  41.29 |            3.4 |            344 |
| 10,000 | Custom, unindexed |  76.13 |  98.41 |           40.2 |         20,310 |
| 10,000 | Custom, indexed   |  39.23 |  43.21 |            4.0 |            344 |

All k=5 cases reported 150 writes per request. At 10,000 tasks, concurrent claim/report p95 latencies were 875/219 ms unindexed and 495/185 ms indexed. Index builds took 63 ms wall / 21 ms SQL at 1,000 tasks and 129 ms wall / 52 ms SQL at 10,000 tasks. The local database also contained earlier fixtures: partial-index creation can scan tasks in other pools, so build reads and total database size are not measurements of an isolated single pool. The JSON retains p50/p95/p99, SQL durations, reads/writes, build costs and separate concurrent claim/report summaries. Five samples per k are useful for comparison, not reliable tail-latency estimates or remote service guarantees.

To reproduce, build the app, apply all local migrations, run the local worker, then run `node scripts/sort-performance.mjs`. It uses disposable pools, revokes its keys and disables/archives its pools afterward. `SORT_BENCH_SIZES=1000` narrows the fixture size. With an explicit `TEST_ORIGIN` pointing at the configured staging administrator origin and a current Access session, the same script runs against staging. Records go to ignored `artifacts/verification/`; review them before publishing evidence.

**Staging gate:** the configured Access session was expired during this implementation. No staging migration or deployment was performed. Before production rollout, apply/build on staging, run ordered-claim concurrency and performance checks there, and inspect representative fresh/retry query plans on remote D1. The local results above do not close that gate.

## Measured remote workload (prior version)

The 10,000-task import/export and compute test used 812 measured requests. Wall latency: p50 371.36 ms, p95 632.08 ms, p99 852.18 ms. Claims: p50 391.53 ms, p95 640.70 ms, p99 751.85 ms. Reports: p50 362.21 ms, p95 447.63 ms, p99 633.21 ms. The burst p99 was 645.39 ms. These are observations from one staging location and run, not service-level guarantees.

That run recorded 6,845,116 D1 rows read, 214,606 written, and at most 26 statements per invocation. The implementation subsequently combined receipt guards and removed repeated full-operation processed counts; those improvements require a new comparison before attributing a measured saving. Every statement has a 100-parameter bound; each mutation batch has a 40-statement ceiling and the request wrapper reserves a query below Free's 50-query ceiling.

A separate Cloudflare analytics query over a six-hour window reported 832 Worker requests, zero errors, p50 CPU 4.295 ms and p99 CPU 11.522 ms. This aggregate window includes application/asset traffic; it is not per-route CPU. Staging reports the standard usage model; the provider subsequently confirmed D1 Free enforcement by rejecting recovery after the daily read allowance was exceeded. OAuth subscription inspection returned 403. No subscription was changed. See [operational cost limits](operations.md#cost-and-free-limits).

The subsequent 1,000-task run completed 182 requests with 177,036 rows read and 29,346 written. Wall latency was p50 351.33 ms, p95 562.49 ms and p99 588.79 ms. Claims reached p99 629.07 ms; reports p99 372.60 ms. Maximum invocation count was 24 statements with 19 parameters in any one statement. Database size at completion was 40,538,112 bytes. See `performance-remote-optimized-1000.json`. This smaller workload fits the D1 Free daily allowances; it is not a like-for-like comparison with 10,000 tasks.

Cloudflare analytics covering that final workload plus nearby browser activity recorded 226 requests, zero platform errors, p50 CPU 2.792 ms and p99 CPU 14.154 ms (`cloudflare-usage-final-build.json`). The p99 exceeds the nominal Free CPU budget even though this run completed. No paid plan was selected. The optional 50 ms paid configuration is supplied for an explicit future subscription decision.

## Gates that must remain explicit

1. **Public repository installation:** the source repository is configured as `https://github.com/special-linear/task_broker`, and the README contains its Deploy to Cloudflare button. A fresh browser-only installation through the published template and an actual GitHub Release are not yet verified.
2. **Confirmed Free enforcement:** the large run exceeds Free daily read/write allowances and the CPU p99 exceeds its nominal 10 ms allowance. Cloudflare later rejected reads with an explicit D1 Free daily-limit error. The full workload cannot fit a Free day; clear quota handling and recovery after midnight UTC are verified. Do not label this volume Free-certified. No paid subscription was requested or selected.
3. **Operational cutover:** the isolated native restore is verified. A real production custom-domain deployment, Access policy for production, Time Travel restore and external traffic cutover remain deployment-specific procedures.
4. **Complete matrix:** automated coverage is substantial but not exhaustive. Shared views and attended polling are verified in both browsers, including controlled 15-minute inactivity. A full screen-reader/keyboard review, production traffic cutover, and exhaustive deployment-specific policy combinations remain operator procedures. Do not turn a documented procedure into a passing result.
5. **Idle and browser scaling:** the scripts emit `idle-30min.json` and `browser-scale.json` only after successful checks. Both artifacts are present and passing. Browser scaling passed for 10,000 rows with a deliberately lost committed chunk response and complete safe CSV download. The 30-minute idle observation recovered the prior lease and granted new work after the daily quota reset. Passive tail server timestamps also show a request-free gap exceeding 30 minutes. These observations do not claim zero account-wide D1 usage.

Run the complete local checks and review these gates before publishing a production-ready release. The downloadable candidate includes reproducible assets, source, Python, the generated API contract, manuals, licenses and evidence; credentials and native data backups are excluded.
