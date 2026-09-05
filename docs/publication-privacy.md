# Publication privacy audit

The pre-publication audit found personal deployment metadata in the tracked staging configuration, Access instructions, eight verification reports, and the existing release archive. The sole local Git commit also contained the developer's personal name and email. No personal absolute machine paths were found in tracked text. No live credentials were found by pattern review or comparison against nine known local credential/secret values in the original reachable history and ZIP.

| Category                                                                        | Treatment                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner email, account and D1 IDs, Access issuer/AUD, personal hostname           | Real configuration preserved in ignored `wrangler.staging.local.jsonc`; public configuration and Access instructions use placeholders. These identifiers are not authentication secrets. |
| Raw reports, deployment/fixture IDs, screenshot, backups, CLI logs and sessions | Retained in ignored local directories. New verification runs write to `artifacts/private/verification/`. Reviewed, sanitized reports live in `docs/evidence/`.                           |
| Git author/committer identity and original committed files                      | Original single-commit history preserved in a private Git bundle; publication history must contain only sanitized source and the chosen publication identity.                            |
| Release ZIP                                                                     | Rebuilt from `release-files.json`, sanitized evidence and checked browser assets. Original ZIP retained only in the private audit backup.                                                |
| Local machine paths                                                             | Present in local tool state/logs; excluded along with caches, databases, editor state and source maps. Portable relative paths and runtime home-directory discovery remain in source.    |
| Dependency metadata, license authors, example identities and local test secrets | Retained intentionally. Example domains and loopback-only fixtures are not live credentials. Third-party attribution must remain intact.                                                 |

Original files and the old archive are in ignored `artifacts/private/publication-audit/originals/`. The private audit directory also contains deny lists used to compare public files against this installation's values without printing those values. Keep that directory private, including its Git bundle. Existing Wrangler credentials and cloudflared sessions remain in their external tool-managed stores.

The publication snapshot uses `Task Broker Contributors <contributors@example.invalid>`. Nine publication regression tests pass, covering credential and identity detection, historical blobs/tag metadata, forbidden paths, archive scanning and repackaging without Git. TypeScript checks, browser build and the staging deployment dry run also pass. No remote deployment or credential rotation was needed for this cleanup.

Before publication run:

```text
npm run check:privacy -- --history
npm run test:publication
npm run release
python scripts/publication_audit.py --archive release/cloudflare-task-broker-0.1.0.zip
```

The audit checks source candidates, all reachable local branches/tags when requested, commit/tag identities and messages, and ZIP contents. It reports filenames, line numbers and categories without echoing matched values. CI scans fetched history before packaging. It does not automatically upload raw browser failure artifacts.

`release-files.json` is an explicit reviewed source list. Add new public source files there deliberately; never add local configuration, raw logs or credentials. Packaging fails for ignored/forbidden files, unexpected build files, source maps, unreviewed binaries and detected private values. A downloaded source archive can be repackaged without Git using the same manifest. Run browser builds first so stale assets are removed.

Ignoring a file does not remove earlier committed copies. Before the first push, inspect all branches and tags, and configure the desired future Git author identity (for example a GitHub no-reply email). Do not push old private backup history or distribute the workspace's `.git` directory. Old local reflog entries and tool-internal refs remain private recovery state; the history check covers publication branches, remote tracking branches and tags. Ordinary branch pushes and the source ZIP do not include internal refs. Never use a mirror push from this working directory. If a real secret is ever published, revoke/rotate it before treating history cleanup as sufficient.

This is a local heuristic audit plus review, not a guarantee that arbitrary future data is safe. Review screenshots, exports, newly added payloads, author identities and release contents before sharing. The cleaned source is intended for publication; the complete working directory contains private material.
