# Email registration without a local mail server

## Delivery status

The email registration backend is an independent, opt-in component of Financial Horizon. It is **not** a YFC SSO service, and does not connect to YFC's database. Existing financial records remain in browser IndexedDB; logging in does not synchronize them.

Production registration must remain **DISABLED** until an external outbound SMTP account, verified sender domain, Cloudflare Turnstile keys, reverse-proxy IP handling, security review, and restore test all pass. Never silently turn on the UI or server by changing a feature flag alone.

## No self-hosted mail daemon

Use an authenticated external TLS SMTP **relay**. Example: Resend's free SMTP service (availability and limits can change):

1. Set up an independently administered Resend project/account; verify the sending domain or dedicated subdomain in the provider console.
2. Add the exact SPF, DKIM, and if recommended DMARC records shown by the provider in DNS. Do not overwrite existing mail MX/SPF records blindly.
3. Create a **restricted independent** sending API key; do not reuse YFC credentials.
4. Use the secure external connection, not a local sendmail daemon:
   - SMTP host: \`smtp.resend.com\`
   - Port: \`465\` (implicit TLS), or \`587\` (mandatory STARTTLS)
   - Username: \`resend\`
   - Password: Resend's separate sending key - a **secret stored only in the root-protected environment on VPS**.
5. Select a sender address belonging to the verified sending domain, for example \`no-reply@fin-horizon.mikemoore.top\` only after the domain is verified. The string is illustrative; the real domain might be a dedicated mail subdomain.
6. Send and receive one actual verification email and one password-reset email to a controlled test inbox; verify SPF/DKIM, DMARC alignment and delivery status.

No card, premium plan or paid API is necessary for the app's code. The external provider must remain within the explicitly free plan; monitor quotas to avoid missing account-recovery messages.

## Cloudflare Turnstile

Create a production widget restricted to \`fin-horizon.mikemoore.top\`. Store **site key** and **secret** separately; the secret must never be included in JS or public GitHub.

Server-side Siteverify is mandatory for registration, email resend and password-reset request; action and hostname must match. Cloudflare tokens expire after five minutes and can be redeemed only once.

**Never use Cloudflare's dummy always-pass sitekey/secret on production.** This backend rejects known dummy test keys in production. Use separate keys for isolated staging tests.

Required Caddy **account-page only** CSP adjustment when enabling Turnstile:
- \`script-src 'self' https://challenges.cloudflare.com\`
- \`frame-src https://challenges.cloudflare.com\`
- \`connect-src 'self' https://challenges.cloudflare.com\`

Leave existing strict CSP for all other app pages. Do not weaken global \`frame-ancestors\`, \`form-action\`, or \`object-src\`.

## Configuration

\`deploy/.env.example\` contains names and examples **but no real credentials**. For the backend choose a root-protected path such as \`/etc/financial-horizon/email-auth.env\`, never the public \`/srv/www\` directory.

- \`FH_EMAIL_AUTH_ENABLED=false\` by default; requires all mandatory settings when true.
- \`FH_PUBLIC_URL=https://fin-horizon.mikemoore.top\` exact origin.
- \`FH_AUTH_DATABASE_PATH=/var/lib/financial-horizon/auth.sqlite3\`; parent directory private, e.g. owned by a dedicated unprivileged service identity with mode 0700.
- \`FH_AUTH_RATE_SECRET\`: independent, randomly generated and non-placeholder, at least 32 characters, not the YFC secret.
- \`FH_TURNSTILE_SITE_KEY\`, \`FH_TURNSTILE_SECRET_KEY\`.
- \`FH_SMTP_HOST\`, \`FH_SMTP_PORT\` (465 or 587), \`FH_SMTP_FROM_EMAIL\`, \`FH_SMTP_USERNAME\`, \`FH_SMTP_PASSWORD\`.

Never print environment values in logs, shells, Issue/PR text, or ChatGPT. Configuration must be independently validated on staging before enabling any public route.

## API and browser flow

The frontend \`account.html\` is a responsive adaptation of the approved design A. Register: email + Turnstile -> one-time verification link -> user sets own Argon2id-hashed password -> authenticated secure HttpOnly cookie. This prevents an attacker from preselecting a password for someone else's mailbox.

Password reset requires a fresh Turnstile challenge, an emailed single-use link (1 hour), and revokes all earlier sessions. Verification links last 24 hours. Multiple attempts and per-email quotas are persisted in SQLite. Email responses are generic to limit account enumeration. Email delivery is deferred after the HTTP response and may be retried via the resend flow if SMTP temporarily fails.

No tokens are returned in API responses. Login and verification sessions are site-local and independent of YFC, and there is no automatic OAuth account linking.

## Production safeguards before launch

- The API process listens only on **127.0.0.1**, under its own unprivileged Unix service account.
- Route **only** \`/api/auth/email/*\` from Caddy to backend; no public direct socket, no permissive CORS, no exposing \`/docs\`.
- Use exact Host/Origin matching, Secure+HttpOnly+SameSite cookies, no-store headers.
- **Reverse proxy warning**: all requests may arrive to the backend from 127.0.0.1. Correct client IP attribution and protection from spoofed forwarding headers must be explicitly verified using Cloudflare source allowlisting or equivalent trusted chain. Do **not** rely on a user-supplied \`X-Forwarded-For\`. Cloudflare edge rate limiting and WAF protection should supplement per-email and global server limits.
- Backup auth SQLite, WAL files and cryptographic recovery material privately, with a restore drill. A mail-delivery failure must not prevent retry after a generic response.
- Security acceptance includes email enumeration timing, brute-force prevention, password reset, token replay, cross-user access, spoofed headers, Turnstile bypass, SMTP outage, compromised session, and rollback.
- Maintain ability to operate as anonymous PWA with local data when the auth service is down. No forced cloud migration.

## Important limitation

This backend stores **accounts and sessions only**, not a synchronized financial ledger. Cross-device financial data still requires issue #7 and separate E2EE sync / migration work. OAuth via Telegram, Google, Yandex ID and VK ID is the later work in issue #9, not part of this email-first phase.
