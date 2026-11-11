# MVP non-goals

The product presents observable engineering evidence for a human evaluator. It does not replace that evaluator or turn task activity into an automatic hiring judgment.

The current MVP does not include:

- candidate scores, ranks, competence percentages, automatic competence labels, pass/reject decisions, or AI verdicts;
- ATS integrations, recruiter analytics, billing, an analytics warehouse, or broad enterprise administration and RBAC;
- a scenario marketplace, automated scenario publishing, multiple technology stacks, or broad assessment customization. The [local Founder UAT](../decisions/founder-local-uat.md) permits recruiter-requested drafts for human review;
- webcam or biometric collection, full-device monitoring, or complex anti-cheat systems;
- autonomous AI coding agents, live AI assistance in the durable internal demo, or external-candidate code execution before its separate security and operations gate;
- candidate invitation email in the internal demo. Owner-copied reviewer invitations are separate from GoTrue account confirmation and password-recovery mail. The isolated [Founder UAT profile](../decisions/founder-local-uat.md) may capture account mail locally; external delivery remains gated;
- microservices, Kubernetes, or complex event-streaming infrastructure.

Basic recruiter/reviewer membership, first-team onboarding, and reviewer invitations are narrow product needs, not enterprise administration. The onboarding backend and UI shipped in PRs #9 and #13, with signup gated by deployment profile. Independent signup, local verification, and the complete end-user journey remain subject to Founder UAT acceptance. See the [onboarding design](../decisions/mvp-first-team-onboarding.md) and [release readiness](../release-readiness.md).

These boundaries are not implied roadmap commitments. Any expansion requires a validated requirement and an explicit product decision. External execution, email delivery, live AI, and public activation remain separate gates.
