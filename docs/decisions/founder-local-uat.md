# Decision: isolated Founder UAT profile

- Status: accepted for implementation by the founder's 2026-11-10 UAT directive; acceptance pending.
- Baseline: protected `main` at `c4936cd1f6a396854400e363f7dc9d629e6a8b58`.

The supported local test must be a real product journey, beginning with account creation rather than fixture credentials. The existing self-service onboarding and durable workflow are reused. This decision changes only the isolated local testing profile; it does not activate public signup or external candidate access.

## Account and mail boundary

Enable GoTrue signup with email confirmation retained in a dedicated loopback-only profile. Deliver account confirmation and password-recovery mail to a local SMTP capture service. Make the captured inbox discoverable through ordinary account screens. Do not send external messages, auto-confirm accounts, display developer credentials, or ask users to supply recovery JWTs.

Use the existing real GoTrue verification flow where it satisfies confirmation and recovery semantics. The earlier onboarding decision's PKCE design is not a reason to replace a correct existing flow. Keep fixed safe destinations and short-lived purpose-bound state. Preserve a pending reviewer invitation across normal registration and sign-in without accepting arbitrary redirects or treating an invitation as a user identity.

Recovery credentials remain confined to password update. A new normal sign-in is required before product operations. GoTrue live identity checks, proof v2, PostgreSQL live-session checks, replay protection, email matching, membership, organization scope, and per-session reviewer assignment remain mandatory.

## Runtime and data boundary

Bind the application, Auth service, mail capture, and database to loopback or a private local service network. Fail closed for non-loopback public entry configuration. Keep the public/staging/production defaults unchanged. This is a founder-controlled test environment, not a public or hostile-code security certification.

Use persistent storage for founder accounts and product state. Initial setup installs migrations and approved templates, with no user accounts, organizations, candidate activity, or review packets. Automation uses separate disposable state and creates all product entities through supported user interfaces. Restart and failure rehearsal may affect only owned test services; never stop unrelated services or reset founder data.

Evaluate the existing restricted executor against this local scope and the approved template. Enable real execution only if its authorization, isolation, bounded resources, immutable submission behavior, and evidence persistence are directly verified. Otherwise keep execution disabled and state the specific material limitation. Live paid AI remains disabled.

## Acceptance

The [Founder UAT plan](../plans/active/founder-uat.md) defines the required first-user, candidate, evaluator, denial, recovery, resilience, and UI checks. The [release readiness record](../release-readiness.md) alone records acceptance results, exact source and CI evidence, runtime reachability, and remaining limitations. Prior fixture-based acceptance is supporting technical evidence only.
