# Publication privacy audit

The pre-publication audit found personal deployment metadata in the tracked staging configuration, Access instructions, eight verification reports, and the existing release archive. No personal absolute machine paths were found in tracked text. No live credentials were found by pattern review or comparison against nine known local credential/secret values in the original reachable history and ZIP. Git contributor names and emails are permitted public attribution; the audit focuses on credentials, private deployment data and other sensitive content.

| Category                                                                        | Treatment                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner email, account and D1 IDs, Access issuer/AUD, personal hostname           | Real configuration preserved in ignored `wrangler.staging.local.jsonc`; public configuration and Access instructions use placeholders. These identifiers are not authentication secrets. |
| Raw reports, deployment/fixture IDs, screenshot, backups, CLI logs and sessions | Retained in ignored local directories. New verification runs write to `artifacts/private/verification/`. Reviewed, sanitized reports live in `docs/evidence/`.                           |
| Git author/committer/tagger identity and original committed files               | Contributor names and emails are allowed. Commit messages, tag annotations and historical files are scanned. Original private source history remains in a private Git bundle.           |
| Release ZIP                                                                     | Rebuilt from `release-files.json`, sanitized evidence and checked browser assets. Original ZIP retained only in the private audit backup.                                                |
| Local machine paths                                                             | Present in local tool state/logs; excluded along with caches, databases, editor state and source maps. Portable relative paths and runtime home-directory discovery remain in source.    |
| Dependency metadata, license authors, example identities and local test secrets | Retained intentionally. Example domains and loopback-only fixtures are not live credentials. Third-party attribution must remain intact.                                                 |

Original files and the old archive are in ignored `artifacts/private/publication-audit/originals/`. The private audit directory also contains deny lists used to compare public files against this installation's values without printing those values. Keep that directory private, including its Git bundle. Existing Wrangler credentials and cloudflared sessions remain in their external tool-managed stores.

The initial publication snapshot used `Task Broker Contributors <contributors@example.invalid>`; subsequent commits may use ordinary contributor identities without rewriting history. Publication regression tests cover permitted attribution, sensitive commit/tag messages, historical blobs, detached CI checkouts, forbidden paths, archive scanning and repackaging without Git.

Before publication run:

```text
npm run check:privacy -- --history
npm run test:publication
npm run release
python scripts/publication_audit.py --archive release/cloudflare-task-broker-0.1.0.zip
```

The audit checks source candidates, the current checkout and all reachable publication branches/tags when requested, commit messages, tag annotations and ZIP contents. Author, committer and tagger identity fields are excluded, including from local identity deny lists. This exception does not exempt deployment-owner emails or other sensitive values in messages, source files or archives. It reports filenames, line numbers and categories without echoing matched values. CI scans fetched history before packaging. It does not automatically upload raw browser failure artifacts.

`release-files.json` is an explicit reviewed source list. Add new public source files there deliberately; never add local configuration, raw logs or credentials. Packaging fails for ignored/forbidden files, unexpected build files, source maps, unreviewed binaries and detected private values. A downloaded source archive can be repackaged without Git using the same manifest. Run browser builds first so stale assets are removed.

Ignoring a file does not remove earlier committed copies. Before publication, inspect all branches and tags for private deployment data and credentials. A GitHub no-reply email is optional for contributor attribution. Do not push old private backup history or distribute the workspace's `.git` directory. Old local reflog entries and tool-internal refs remain private recovery state; the history check covers the current checkout, publication branches, remote tracking branches and tags. Ordinary branch pushes and the source ZIP do not include internal refs. Never use a mirror push from this working directory. If a real secret is ever published, revoke/rotate it before treating history cleanup as sufficient.

This is a local heuristic audit plus review, not a guarantee that arbitrary future data is safe. Review screenshots, exports, newly added payloads and release contents before sharing. The cleaned source is intended for publication; the complete working directory contains private material.
