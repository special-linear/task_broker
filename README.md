# Cloudflare Task Broker

A browser task workspace, transactional D1 lease broker, and dependency-free Python client. Computation runs on your machines. The Worker stores typed tasks, leases, results, immutable attempts, reviewed operations, and shared views.

**Release candidate.** See [verification evidence and remaining gates](docs/verification.md) before treating this build as production ready. The installation guide starts with staging on Cloudflare's Free plans and a free `workers.dev` address; the application does not select a paid subscription.

The authoritative requirements are in [the implementation specification](Cloudflare_Task_Manager_Implementation_Specification.md). Endpoint contracts are generated from the shared route registry into [OpenAPI 3.1](openapi.json).

## Install on Cloudflare

Follow the **[step-by-step installation guide](docs/installation.md)** while using this button:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fspecial-linear%2Ftask_broker)

You need Cloudflare and GitHub accounts, an email address for administrator login, and Python 3.10+ to try the demo. A custom domain and a local repository checkout are optional.

The procedure is:

1. Connect GitHub and let Cloudflare create the Worker and its D1 database.
2. Copy the existing database ID into a **build variable** and find the Worker's address.
3. Configure Cloudflare Access for the administrator paths, then enter the **runtime variables and secrets**.
4. Use **Deployments → Version History → ⋯ → Promote version** to activate the saved settings.
5. Save the guide's deployment command, **Retry build**, and run the browser's disposable Python demo.

**If connecting GitHub skips the application settings form, continue with [step 2](docs/installation.md#2-connect-future-builds-to-the-existing-database).** A successful first build creates the resources; configuration and database migrations still need to be completed. There is no need to delete the Worker or restart the wizard.

Your database ID, addresses, Access settings, and secrets stay in Cloudflare. The guide's deploy command generates a temporary configuration during each build, so **the source repository stays reusable across installations**.

## Use the application

Read the [browser installation guide](docs/installation.md), then open **Start here**. Create a family/pool, define input and result columns, add or import tasks, and issue a family key. The disposable demo downloads the Python module and supplies a command that uses the real public compute API.

The browser and its assets live under `/admin/`; administration uses `/admin-api/v1/`; Python uses `/api/v1/`. Production uses separate administrator and broker hosts. The staging setup in the installation guide uses one `workers.dev` host with Access on administration only.

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

## Operate and upgrade

For an existing installation, follow [upgrades](docs/installation.md#upgrades). Preserve the database and both application secrets during ordinary releases. The guide also covers [custom-domain production](docs/installation.md#custom-domain-production) and the separate [local CLI workflow](docs/installation.md#optional-local-cli-workflow).

Downloadable releases are on [GitHub Releases](https://github.com/special-linear/task_broker/releases). To generate a Deploy button for a fork, run `node scripts/deploy-link.mjs https://github.com/OWNER/REPOSITORY` and paste the first output line into its README.

- [Browser manual](docs/user-guide.md): editing, filters, import/export, views, operations.
- [Architecture and invariants](docs/architecture.md): transactions, fencing, revision checks, budgets.
- [Operations and recovery](docs/operations.md): upgrades, maintenance, backups, epoch rotation.
- [Security](SECURITY.md): trust boundaries and secret handling.
- [Publication privacy](docs/publication-privacy.md): audit findings, private files, history and release checks.
- [Verification matrix](docs/acceptance.md): every specification acceptance ID.
- [Changelog](CHANGELOG.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

`npm run release` creates a source-and-assets ZIP with SHA-256 checksums under `release/`. The package omits local data, credentials, browser sessions, dependency caches, and account-specific staging configuration.
