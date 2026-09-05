# Changelog

## 0.1.0 — release candidate

- Browser task grid and accessible forms; typed CSV/TSV import, reviewed operations, views, results and exports.
- Transactional claims, report/renew item decisions, recovery, receipts, input/state fencing, key states and immutable attempt history.
- Access-protected administration, worker-family keys, host/path validation and Cloudflare abuse throttling.
- Immutable schema contracts, resumable migrations, reviewed legacy history and portable installation migration.
- Dependency-free Python client with stable uncertain retries, serializable handles, Slurm identity and rank restrictions.
- D1 integration, browser, Python and deployed endpoint verification tools; generated OpenAPI; source-and-assets packaging.

Migration 0001 creates a closed installation. Migration 0002 adds explicit task attempt inheritance. Migration 0003 adds imported-history provenance, monotonic receipt-retention policy and supporting indexes. All three are additive. See the verification report for measured evidence and unmet release gates.
