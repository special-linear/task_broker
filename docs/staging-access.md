# Staging Access

Copy `wrangler.example.jsonc` to the ignored root file `wrangler.staging.local.jsonc` and fill in your account, Worker name, D1 database ID, owner email and trust settings. The staging scripts select that file automatically; `WRANGLER_CONFIG` or an explicit `--config` overrides it. Keep the public `wrangler.jsonc` generic.

For a shared staging hostname, create a self-hosted Access application with these public hostname/path entries, replacing `YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev`:

| Hostname                               | Protected path |
| -------------------------------------- | -------------- |
| YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev | /admin         |
| YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev | /admin/*       |
| YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev | /admin-api     |
| YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev | /admin-api/*   |

Use one **Allow** policy whose **Include ? Emails** selector contains only your initial administrator email. Use One-time PIN or a verified identity provider. Do not add Everyone, Bypass, or a hostname-wide rule. Leave `/api/v1/*` outside interactive Access for compute clients.

Copy the saved Application Audience tag into `ACCESS_AUDIENCE` in the private configuration. If the dashboard requires two applications, supply both audience tags separated by commas. Set `ACCESS_ISSUER` to `https://YOUR-TEAM.cloudflareaccess.com` and `OWNER_EMAILS` to the same owner email. The Worker retains its own JWT and administrator checks.

Keep administration closed until those values are configured. Verify unauthenticated requests to both protected paths and their descendants require login, while `/api/v1/claim` returns a JSON authentication error without redirecting to Access. See [installation.md](installation.md) for the complete deployment procedure.

Session cookies, CLI transcripts, and installation-specific dashboard notes belong under ignored `artifacts/private/`. Never paste credentials into a tracked document.
