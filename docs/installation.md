# Install on Cloudflare

This guide sets up one Worker and one D1 database, with administrator login through Cloudflare Access and Python clients connecting from your machines. It uses Cloudflare's Free plans and a shared `workers.dev` address for **staging**. [Custom-domain production](#custom-domain-production) is a separate option.

Keep this guide open beside the dashboard. Complete steps 1–8 in order. If GitHub connection has already created your Worker, start at **step 2**. The repository remains generic: all installation-specific settings go into Cloudflare, not into tracked files.

## Before you start

Have a Cloudflare account, a GitHub account with access to the complete [source repository](https://github.com/special-linear/task_broker), and an email address you can use for administrator login. Python 3.10+ is needed for the final demo. Deployment itself does not require a local checkout or a local Wrangler installation.

Generate two different values on your own computer. With Node.js installed, run these commands separately in a terminal:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomUUID())"
```

The first output is your `APP_SIGNING_SECRET` (64 hexadecimal characters representing 32 random bytes). The second is your `INSTANCE_EPOCH` (a UUID). If you already saved these for this installation, keep the existing values.

<details>
<summary>Windows PowerShell alternative, without installing Node.js</summary>

Run this to generate the signing secret:

```powershell
$signingBytes = New-Object byte[] 32
$signingRandom = [Security.Cryptography.RandomNumberGenerator]::Create()
$signingRandom.GetBytes($signingBytes)
([BitConverter]::ToString($signingBytes)).Replace('-', '').ToLowerInvariant()
$signingRandom.Dispose()
```

Then generate the epoch:

```powershell
[guid]::NewGuid().ToString()
```

</details>

Save both in a password manager, labelled with this installation and environment. Cloudflare will hide their values after you save them as secrets. Preserve both during ordinary upgrades. `INSTANCE_EPOCH` identifies the recovery generation and can be public; it is **not** a substitute for the signing secret. After a database restore, use a fresh epoch and follow the [recovery procedure](operations.md).

## 1. Create the Worker and database

Open [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fspecial-linear%2Ftask_broker) and connect GitHub. The button can present an application setup form, or GitHub authorization can lead into the regular repository import flow. Both paths can create the same resources.

If importing manually, use **Workers & Pages → Create → Import a repository** and select the complete source tree. For this procedure, keep the project/Worker name **`task-broker`**, matching the repository configuration.

Use these initial build settings when offered:

| Setting                                    | Value                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| Build command                              | `npm run build`                                                               |
| Deploy command, for this first upload only | `npx wrangler deploy`                                                         |
| Root directory / Path                      | `/`                                                                           |
| Production branch                          | `main`                                                                        |
| Build variable `NODE_VERSION`              | `24`                                                                          |
| Builds for non-production branches         | Off                                                                           |
| Non-production branch deploy command       | Leave `npx wrangler versions upload` in the field, even with those builds off |
| Protect with Cloudflare Access             | Off here; step 4 protects only the administrator paths                        |
| API token                                  | Create a build token, for example `task-broker-builds`                        |

Cloudflare installs dependencies from the lockfile automatically. If the template form offers D1 settings, choose **Create new**, name it `task-broker`, leave the location hint **Automatic**, and leave read replication off. If it offers the two secrets, enter the values you just generated. Other application values are completed in steps 3–5; example addresses are temporary placeholders.

Let the first build finish. It should upload the Worker and provision a D1 database bound as **`DB`**. A green build at this stage does **not** mean the application is ready: this initial command has not applied the database migrations. A “No targets deployed” message is expected while no Worker URL or custom domain is enabled.

**If the application settings form never appeared, continue below.** Do not create a second Worker or restart the wizard. Cloudflare's [Deploy button documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/) describes the provisioning flow; this guide completes configuration in the dashboard regardless of which form appeared.

## 2. Connect future builds to the existing database

Open **Workers & Pages → task-broker → Bindings**. Find **DB**, open the linked D1 database, and copy its **Database ID**. You can also find it under **Storage & databases → D1 → task-broker**.

Now return to the Worker and open **Settings → Builds → Build variables and secrets**. Add:

| Name             | Value                           |
| ---------------- | ------------------------------- |
| `D1_DATABASE_ID` | The database ID you just copied |
| `NODE_VERSION`   | `24`, if not already present    |

Save. The ID tells the deployment command in step 7 which **existing database** to migrate and bind. It is not a password. It belongs in build settings, not in the runtime variables table and not in the public `wrangler.jsonc`.

If there is no `DB` binding, first check whether D1 already contains the database. Bind that database as `DB`; create a new database only if none was provisioned for this installation. Use a separate database for each installation/environment.

## 3. Find your address

Open the Worker's **Domains** tab. Under **Worker URL**, enable the primary URL labelled **Production** and leave **Preview** off. Some dashboard layouts put this under **Settings → Domains & Routes**.

Copy the actual hostname shown there. For example:

```text
task-broker.YOUR-SUBDOMAIN.workers.dev
```

You will use it twice in step 5:

| Variable          | Example value                                    |
| ----------------- | ------------------------------------------------ |
| `ADMIN_ORIGIN`    | `https://task-broker.YOUR-SUBDOMAIN.workers.dev` |
| `BROKER_HOSTNAME` | `task-broker.YOUR-SUBDOMAIN.workers.dev`         |

Replace `YOUR-SUBDOMAIN` with what Cloudflare shows. `ADMIN_ORIGIN` includes `https://`; `BROKER_HOSTNAME` does not. Neither value includes a path or trailing slash. The browser will later open `/admin/` at this address.

The dashboard's **Production** label means the Worker's primary URL. For this shared-host setup, the application's `ENVIRONMENT` must still be **`staging`**.

## 4. Configure administrator login

Open **Zero Trust** from Cloudflare's main sidebar. If this is your first use, create a Zero Trust organization, choose a team name, and select the Free plan. Cloudflare may request billing details during enrollment; see its [account setup instructions](https://developers.cloudflare.com/cloudflare-one/setup/).

### Find the issuer

In **Zero Trust → Settings**, find **Team name / Team domain**. Copy your actual team domain and prefix it with `https://`:

```text
https://YOUR-TEAM.cloudflareaccess.com
```

This is `ACCESS_ISSUER`, with no trailing slash. It comes from your Zero Trust organization, not from your GitHub name or Worker URL. Cloudflare documents it in [team domain settings](https://developers.cloudflare.com/cloudflare-one/faq/getting-started-faq/#what-is-a-team-domainteam-name).

### Create the Access application and copy its audience

1. Go to **Access controls → Applications → Create new application → Self-hosted and private**. Some layouts use **Add an application → Self-hosted**.
2. Name it, for example, `Task Broker admin`. Add these four public hostname/path entries, using the actual Worker hostname from step 3. Use custom hostname input if the selector does not list your `workers.dev` hostname.

   | Hostname                                 | Path           |
   | ---------------------------------------- | -------------- |
   | `task-broker.YOUR-SUBDOMAIN.workers.dev` | `/admin`       |
   | `task-broker.YOUR-SUBDOMAIN.workers.dev` | `/admin/*`     |
   | `task-broker.YOUR-SUBDOMAIN.workers.dev` | `/admin-api`   |
   | `task-broker.YOUR-SUBDOMAIN.workers.dev` | `/admin-api/*` |

3. Add an **Allow** policy with **Include → Emails → your exact administrator email**. Enable One-time PIN or a verified identity provider for login, and save the application.
4. Open the saved application's **Configure → Additional settings** and copy the **Application Audience (AUD) Tag**. This is `ACCESS_AUDIENCE`; it is not the application name, application ID, or an API token.

If the dashboard requires separate applications for the two path groups, give both the same email policy and put both AUD tags in `ACCESS_AUDIENCE`, separated by a comma.

Leave `/api/v1/*` outside interactive Access: Python authenticates there with a family API key. The Worker's **Enable Access** shortcut protects the whole hostname and would also intercept Python requests. Use the path-specific application above. See Cloudflare's [self-hosted application setup](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) and [AUD tag location](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

## 5. Enter runtime variables and secrets

Return to **Workers & Pages → task-broker → Settings → Runtime variables and secrets**. The section may be labelled **Variables and secrets**. This is separate from **Builds → Build variables and secrets** used in step 2.

Replace the example values and add any missing rows:

| Name                 | Type   | Value to enter                                                               |
| -------------------- | ------ | ---------------------------------------------------------------------------- |
| `ADMIN_ORIGIN`       | Text   | Your full HTTPS origin from step 3                                           |
| `BROKER_HOSTNAME`    | Text   | Your hostname from step 3, without `https://`                                |
| `ACCESS_ISSUER`      | Text   | Your Zero Trust team URL from step 4                                         |
| `ACCESS_AUDIENCE`    | Text   | The Access application's AUD tag from step 4                                 |
| `OWNER_EMAILS`       | Text   | The exact email allowed by the Access policy; comma-separate multiple owners |
| `ENVIRONMENT`        | Text   | `staging`                                                                    |
| `LOG_QUERY_METRICS`  | Text   | `false`                                                                      |
| `APP_SIGNING_SECRET` | Secret | The signing secret generated before step 1                                   |
| `INSTANCE_EPOCH`     | Secret | The different UUID generated before step 1                                   |

**The two secrets may not appear at all.** Click **+ Add variable**, choose type **Secret**, and type each name yourself. If you already entered them in the initial form, keep those values. The masked/example fields in a template are not proof that Cloudflare generated secrets for you. See [adding Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/#via-the-dashboard).

Save the changes. Never set `DEV_AUTH` on a deployed Worker.

## 6. Activate the saved settings

Saving can create a new **version** without making it the **active deployment**. Activate the complete configuration before running the next build:

1. Open **Deployments → Version History**.
2. Find the **newest row**, for example “Add secret: INSTANCE_EPOCH”. It should include the earlier saved variable and secret changes.
3. Open that row's **⋯** menu and choose **Promote version**. There may be no button labelled “Deploy”.
4. Confirm promotion, assigning this version 100% of traffic if asked.
5. Check that **Active deployment** now shows that version's ID.

You do not need to promote every intermediate row. If your dashboard already activated the latest version, the matching version IDs confirm that this step is complete. A zero request count does not mean the version is inactive.

## 7. Save the final deployment command and run it

Open **Settings → Builds**. Keep `npm run build` as the build command and `/` as the root directory. Leave non-production builds off and retain `npx wrangler versions upload` in their command field.

Replace the **Deploy command** with this entire **single line**. Copy it exactly; it reads the database ID from the build variable you already saved. This command runs in Cloudflare's build environment, not in your local PowerShell window.

```sh
node -e "let f=require('fs'),c=require('jsonc-parser').parse(f.readFileSync('wrangler.jsonc','utf8')),d=(process.env.D1_DATABASE_ID||'').trim();if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(d))throw Error('Invalid D1_DATABASE_ID');c.d1_databases[0].database_id=d;delete c.env;delete c.vars;c.keep_vars=c.workers_dev=true;c.preview_urls=false;f.writeFileSync('wrangler.ci.local.jsonc',JSON.stringify(c))" && WRANGLER_CONFIG=wrangler.ci.local.jsonc npm run deploy
```

This generates an ignored, temporary `wrangler.ci.local.jsonc` containing the existing D1 ID. It removes the template's placeholder variables and named environments, preserves the active runtime variables and secrets, enables the primary `workers.dev` URL, and keeps preview URLs disabled. `npm run deploy` then applies D1 migrations before deploying the Worker. Nothing installation-specific is committed to Git. See Wrangler's [configuration and variable preservation rules](https://developers.cloudflare.com/workers/wrangler/configuration/).

Do not replace the whole line with bare `npm run deploy`: that would use the repository's generic configuration. Do not append `--env staging`: the runtime value `ENVIRONMENT=staging` in this workflow does not select the separate Wrangler environment of the same name.

Check the selected **Build token** has **Account → D1 → Edit** for this account, in addition to its Worker deployment permissions. Database migrations need that permission. For a user API token, edit it under **My Profile → API Tokens** and ensure the build uses that token.

Click **Save**, reopen the build settings, and verify the new command was retained. Then go to **Deployments → Go to build history → latest build → Retry build**. A retry uses the newly saved build settings, as described in [Cloudflare build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

Wait for successful database migrations and Worker deployment in the log. On later builds, “no migrations to apply” is normal. Saving a command alone does not run it.

## 8. Sign in and complete a real task

Open `https://task-broker.YOUR-SUBDOMAIN.workers.dev/admin/`, substituting your hostname. The dashboard's **Visit** button may open `/`; use `/admin/` for the application.

1. In a private browser window, confirm `/admin/` and `/admin-api/v1/me` require Access login. Sign in with the allowed owner email.
2. On the welcome screen, choose **Initialize installation** when offered.
3. Open **Start here → Create disposable demo**, download `task_pool.py`, and run the supplied command with Python 3.10+ from the folder containing that file. No third-party Python packages are required.
4. Verify the task completes with result `diameter: 49`, and download its CSV.
5. Choose **Revoke key and archive demo** to clean up the temporary credentials and pool.

The Python demo also checks that compute requests reach the API without being intercepted by an Access login page. For a direct unauthenticated check, this must return a JSON authentication error (HTTP 401), not an HTML login page or redirect:

```sh
curl -i -X POST https://task-broker.YOUR-SUBDOMAIN.workers.dev/api/v1/claim -H "Content-Type: application/json" --data "{}"
```

On Windows PowerShell use `curl.exe`. A successful `/healthz` response checks only that the Worker is running; it does not verify database migrations, login, or task execution.

You can now create real work using the [browser manual](user-guide.md) and [Python client guide](python-client.md). This remains a release candidate; consult [verification evidence and remaining gates](verification.md) before production use.

## Troubleshooting

| What you see                                       | What to do                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub connection skipped the application settings | Continue at step 2 with the Worker already created.                                                                                                                                                                                                                                                                                                      |
| No `APP_SIGNING_SECRET` or `INSTANCE_EPOCH` row    | Add each manually with **+ Add variable → Secret** in runtime settings.                                                                                                                                                                                                                                                                                  |
| No “Deploy” action for the saved settings          | Use the newest version's **⋯ → Promote version**; compare its ID with **Active deployment**.                                                                                                                                                                                                                                                             |
| “Invalid request body” when saving build settings  | The dashboard rejected the form before running any command. Use the compact, single-line command in step 7; retain the non-production command field. A longer form of this command failed to save during setup, but the precise validation cause was not established. If it persists, reload the page, re-enter only the deploy command, and save again. |
| Build logs say `Invalid D1_DATABASE_ID`            | Check `D1_DATABASE_ID` under **Builds**, using the existing database's full ID. A runtime variable is not available to the build script.                                                                                                                                                                                                                 |
| D1 permission error during migration               | Check the selected build token's **D1 → Edit** permission and account scope.                                                                                                                                                                                                                                                                             |
| “No such table” after a green initial build        | Run step 7's deployment command against the existing database to apply migrations.                                                                                                                                                                                                                                                                       |
| Placeholder addresses return after a rebuild       | Confirm the saved deploy command is the full step 7 command and that correct runtime settings were promoted before that build.                                                                                                                                                                                                                           |
| “No targets deployed” or no usable URL             | Enable the primary Worker URL in **Domains**, and use step 7's command to preserve it on later builds.                                                                                                                                                                                                                                                   |
| Application configuration error                    | Check all nine runtime entries in step 5 and activate the newest version. Inspect **Observability → Logs** for the specific error.                                                                                                                                                                                                                       |
| Access rejects login                               | Check the exact policy email, identity provider, four hostname/path entries, issuer, and AUD tag.                                                                                                                                                                                                                                                        |
| Python receives HTML or an Access redirect         | Remove hostname-wide interactive Access protection; protect only the four administrator paths from step 4.                                                                                                                                                                                                                                               |

## Upgrades

Back up the database and review the release and migration notes before updating the connected source. Keep the same Worker, D1 database, build variables, deployment command, runtime settings, and application secrets.

To deploy repository changes:

1. Check **Settings → Builds** for the connected repository and production branch (usually `main`).
2. Commit and push your changes to that branch, or merge a pull request into it. Local edits and local commits alone are not visible to Cloudflare. If Cloudflare is connected to your fork, first sync or merge the upstream changes into that fork's deployment branch.
3. Cloudflare automatically starts a new build using the pushed commit. Open **Deployments → Go to build history**, confirm the expected commit is being built, and wait for successful deployment. See [production branch builds](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/).

Use **Retry build** to rerun a selected build after a temporary failure or a change to its Cloudflare build settings. A retry is tied to that build's source revision; it is not a way to publish local edits or sync a fork with upstream. Retry the build for the commit you intend to deploy. Cloudflare documents [retries for a commit](https://developers.cloudflare.com/changelog/post/2025-03-17-rerun-build/) and [using current build settings on retry](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

The final deployment command applies outstanding migrations and keeps the active runtime settings. If changing those settings, save and **Promote version** before the build. Run a disposable task after each upgrade. Ordinary upgrades must not recreate D1, reset tasks, or regenerate either application secret.

For database restores, maintenance, signing-secret compromise, and epoch rotation, follow [operations and recovery](operations.md). Restoring a database is a separate procedure from upgrading code.

## Custom-domain production

For a separate production installation, use its own Worker, database, and secrets. Use two domains you control, attached to that Worker through **Domains → Add Domain**: one for administration and one for compute. Cloudflare describes domain attachment in [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

Set `ENVIRONMENT=production`, `ADMIN_ORIGIN=https://tasks.example.com`, and `BROKER_HOSTNAME=broker.example.com`, substituting your actual domains. Configure Access for the administrator domain and update its issuer/audience settings. Compute remains outside interactive Access.

In the step 7 command, replace `c.keep_vars=c.workers_dev=true` with `c.keep_vars=true;c.workers_dev=false`. This preserves dashboard variables while disabling the `workers.dev` URL; keep `preview_urls` false. If you chose a Worker name other than `task-broker`, the generated configuration must also set `c.name` to that name. Keep those deployment-specific changes in the Cloudflare build command. Promote the settings, rebuild, and repeat step 8 using the custom domains.

## Optional local CLI workflow

This is an alternative for maintainers using a local checkout, not an additional step for the dashboard procedure. Copy [wrangler.example.jsonc](../wrangler.example.jsonc) to the ignored root file `wrangler.staging.local.jsonc`. Fill in its `env.staging` account, Worker name, database ID, hostname, owner, and Access values. See [the staging Access template](staging-access.md). Keep the tracked `wrangler.jsonc` generic.

With Node.js 24+ installed, run `npm ci`, authenticate with `npx wrangler login`, and add each secret through the private configuration:

```sh
npm run build
npm run check:deployment -- --env staging
node scripts/wrangler.mjs secret put APP_SIGNING_SECRET --env staging
node scripts/wrangler.mjs secret put INSTANCE_EPOCH --env staging
npm run deploy:staging
```

Enter the saved secrets at the prompts. The scripts select `wrangler.staging.local.jsonc` automatically; `WRANGLER_CONFIG` can select another private file. Here `--env staging` does select the named Wrangler environment. Keep private operator notes, session tokens, and deployment transcripts outside tracked source.
