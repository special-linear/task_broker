# Changelog

## Unreleased

- Family/pool/profile context, complete copyable worker routes and a family default selector in configuration screens; choose the initial profile suffix during pool creation.
- Reviewed deletion of unused configuration, with transactional dependency checks and retained audit history; archive/restore for families, pools and profiles, with archived items hidden by default.
- Stable multi-column table sorting, saved-view compatibility and cancellable All rows loading with local reordering after completion.
- Exports freeze the complete table order across pages and formats, including ordered attempt history.
- Optional ordered claims in the HTTP API and Python client preserve fresh/retry priorities, capacity limits and idempotent replay.
- Administrator-configured claim sort expression indexes with build/rebuild/delete actions, schema invalidation and portable restoration as unbuilt definitions.

Migration 0004 adds claim sort index metadata; migration 0005 adds profile archiving. Apply both before running this version; existing data and default claim order are preserved. Remote D1 verification remains required before production deployment.

## 0.1.0 — release candidate

- Browser task grid and accessible forms; typed CSV/TSV import, reviewed operations, views, results and exports.
- Transactional claims, report/renew item decisions, recovery, receipts, input/state fencing, key states and immutable attempt history.
- Access-protected administration, worker-family keys, host/path validation and Cloudflare abuse throttling.
- Immutable schema contracts, resumable migrations, reviewed legacy history and portable installation migration.
- Dependency-free Python client with stable uncertain retries, serializable handles, Slurm identity and rank restrictions.
- D1 integration, browser, Python and deployed endpoint verification tools; generated OpenAPI; source-and-assets packaging.

Migration 0001 creates a closed installation. Migration 0002 adds explicit task attempt inheritance. Migration 0003 adds imported-history provenance, monotonic receipt-retention policy and supporting indexes. All three are additive. See the verification report for measured evidence and unmet release gates.
