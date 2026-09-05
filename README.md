# Cloudflare Task Broker

A browser task workspace, transactional D1 lease broker, and dependency-free Python client. Computation runs on your machines. The Worker stores typed tasks, leases, results, immutable attempts, reviewed operations, and shared views.

**Release candidate.** See [verification evidence and remaining gates](docs/verification.md) before treating this build as production ready. Free staging is the default; no paid subscription is selected by the application.

The authoritative requirements are in [the implementation specification](Cloudflare_Task_Manager_Implementation_Specification.md). Endpoint contracts are generated from the shared route registry into [OpenAPI 3.1](openapi.json).

## Use the application

Read the [browser installation guide](docs/installation.md), then open **Start here**. Create a family/pool, define input and result columns, add or import tasks, and issue a family key. The disposable demo downloads the Python module and supplies a command that uses the real public compute API.

The browser and its assets live under `/admin/`; administration uses `/admin-api/v1/`; Python uses `/api/v1/`. Production uses separate administrator and broker hosts. The configured staging deployment uses one workers.dev host with these separate paths and Access on administration only.

```python
from task_pool import TaskClient

client = TaskClient.from_env("experiments")
for task in client.claim(5):
    task.complete({"diameter": int(task.data["n"]) ** 2})
```

Set `TASK_MANAGER_URL` to the broker origin and `TASK_MANAGER_KEY` to a newly issued family key. Put [task_pool.py](python/task_pool.py) beside your program or on `PYTHONPATH`. Python 3.10+ needs no third-party packages. See [the client guide](docs/python-client.md) for recovery, retries, Slurm, and torchrun.

## Develop locally

Use Node.js 24+, npm, and Python 3.10+. On Windows use `npm.cmd` if PowerShell blocks `npm.ps1`.

```text
npm ci
npm run db:local
npm run dev
```

Open `http://127.0.0.1:8787/admin/`. The local owner stub is restricted to loopback and rejected in deployed environments. Persistent local D1 data lives in `.wrangler/`, independently of the browser session.

```text
npm run build
npm test
npm run test:python
npx playwright install chromium firefox
npm run test:browser
npm run api:generate -- --check
```

Browser tests use the running local Worker. Set `PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright` before installing browsers, or use the helper in the [development guide](docs/development.md).

## Deploy and operate

Copy [the example configuration](wrangler.example.jsonc) to the ignored `wrangler.staging.local.jsonc` for a new installation. Supply your own account, hosts, Access trust settings, and D1 binding there. Deployment and verification scripts select it automatically; `WRANGLER_CONFIG` can select another file. Keep the tracked `wrangler.jsonc` generic. `INSTANCE_EPOCH` and `APP_SIGNING_SECRET` are separate Worker secrets. Preserve them during ordinary upgrades.

```text
npm run build
npm run check:deployment -- --env staging
npm run deploy:staging
```

The public deployment button belongs to **this source repository**, as do downloadable releases. Once its GitHub URL is chosen, `node scripts/deploy-link.mjs https://github.com/OWNER/REPOSITORY` prints the deploy and release URLs. A separate template repository is unnecessary.

- [Browser manual](docs/user-guide.md): editing, filters, import/export, views, operations.
- [Architecture and invariants](docs/architecture.md): transactions, fencing, revision checks, budgets.
- [Operations and recovery](docs/operations.md): upgrades, maintenance, backups, epoch rotation.
- [Security](SECURITY.md): trust boundaries and secret handling.
- [Publication privacy](docs/publication-privacy.md): audit findings, private files, history and release checks.
- [Verification matrix](docs/acceptance.md): every specification acceptance ID.
- [Changelog](CHANGELOG.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

`npm run release` creates a source-and-assets ZIP with SHA-256 checksums under `release/`. The package omits local data, credentials, browser sessions, dependency caches, and account-specific staging configuration.
