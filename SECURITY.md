# Security

Administration requires a verified Cloudflare Access JWT and either a configured deployment-owner email or an active D1 administrator subject. Removing an administrator does not remove deployment owners. Edge Access policies must also permit each intended administrator. The Worker checks signatures with bounded JWKS caching, issuer, audience, expiry, subject and email. Untrusted identity headers cannot substitute for a JWT.

Host/path validation precedes assets and API routing. SPA fallback is limited to real administrator screens. Deployed configuration rejects local authentication. Administrator writes require exact Origin and `X-Task-Broker: 1`. Rendering uses text nodes and plain-text grid formatters; restrictive security headers apply to assets and API responses.

Compute keys contain a public UUID and 256 random secret bits. Only a SHA-256 digest of the high-entropy secret is stored. Key creation displays the secret once; receipts contain metadata only. Soft revocation drains eligible unexpired work; hard revocation denies all operations and replay. One actor cannot read another actor's receipt. Routine exports omit key digests, lease tokens, request receipts and administrator allowlists.

The external installation epoch fences restored database authority. Preserve it on upgrades; rotate it on restore. The separate cursor-signing secret is never derived from the public epoch. Signed cursors bind scope, sort/filter fingerprint, direction, ordering tuple, epoch and expiry.

Local development data, `.dev.vars`, environment files, native backups, test Access sessions, task handles, secrets and caches are ignored by Git and excluded from release archives. Never put Cloudflare account API tokens in the browser or Worker bindings. Keep observability sampling appropriate to the plan and avoid enabling request-header/body capture for compute routes in external logging systems.

For a public GitHub repository, enable private vulnerability reporting before publication. Report a suspected security issue through that private channel rather than publishing keys, live credentials or scientific payloads in an issue. No external notification service is configured by this project.
