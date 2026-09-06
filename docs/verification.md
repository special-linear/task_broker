# Verification and release status

The verified staging deployment uses schema version 3. See [deployment evidence](evidence/deployment.json).

This is a **release candidate**, not a claim that every acceptance gate is signed off. The complete [62-ID map](acceptance.md) distinguishes automated coverage from procedures requiring an operator or browser accessibility review.

## Established evidence

- **Remote D1 and endpoints:** `docs/evidence/remote-smoke.json` records 20 distinct concurrent clients, five identical concurrent requests, body conflicts, mixed reports, lost-response replay, recovery, edit/claim and reset/report races, history and Access bypass probes. Fixtures were created through the protected administrator API. Local simulation is not offered as proof of remote concurrency.
- **Real deployed user journey:** `staging-journey.json` and `staging-journey.csv` record an Access-protected browser-created task, browser-downloaded Python module, public compute claim/report, visible result 49, and checked CSV content. The temporary key was hard-revoked and the demo archived.
- **10,000-task remote workload:** `performance-remote.json` verifies exact task IDs and decimal-string integers through a complete import/export, a 20-client burst, and 60 steady calls. Its raw timing/read/write measurements remain available, including extra progress reads used by the verifier.
- **Native backup and isolated restore:** `consistent-backup.json` records a maintenance-protected native D1 export; the original SHA-256 is retained privately. `isolated-restore.json` records integrity/foreign-key checks, new external epoch enforcement, restored key quarantine and fresh successful work in a separate local D1 instance. The live staging database was not restored or overwritten.
- **Injected remote failure:** `remote-rollback.json` proves that a real D1 failure after attempt insertion rolls back the receipt, attempt and lifetime counter, and that the unchanged request succeeds after removing the task-scoped trigger.
- **Query plans:** `sql-plans.json` records remote D1 plans for representative candidate, capacity, identity and pending-chunk queries. It is a sample of indexed access paths, not an EXPLAIN of every filter combination.
- **Local suites:** `npm test` covers transaction faults, lease/report/renew/recovery semantics, revisions, historical data, schemas, filters and deployed-mode JWT validation. Python unittest covers identity, rank restrictions, stable uncertain requests and bounded failure handling. The final recorded local run has 30 Worker/D1 tests, six Python tests and eight Chromium/Firefox tests passing. `local-checks.json` records the commands and scope; `python-parallel.json` verifies four actual subprocesses completing distinct handles.

Sanitized public evidence lives under `docs/evidence/`; its README describes the redactions. New raw results stay in ignored `artifacts/private/verification/`. Private SQL backups, session cookies, compute keys and CLI logs stay in ignored `artifacts/private/` and are excluded from the release.

## Measured remote workload

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
