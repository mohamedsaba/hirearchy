# MVP non-goals

The product presents observable engineering evidence for a human evaluator. It does not replace that evaluator or turn task activity into an automatic hiring judgment.

The current MVP does not include:

- candidate scores, ranks, competence percentages, automatic competence labels, pass/reject decisions, or AI verdicts;
- ATS integrations, recruiter analytics, billing, an analytics warehouse, or broad enterprise administration and RBAC;
- a scenario marketplace, automatic scenario generation, multiple technology stacks, or broad assessment customization;
- webcam or biometric collection, full-device monitoring, or complex anti-cheat systems;
- autonomous AI coding agents, live AI assistance in the durable internal demo, or external-candidate code execution before its separate security and operations gate;
- candidate invitation email in the internal demo. The proposed owner-copied reviewer invitation is separate from GoTrue account confirmation and password-recovery mail, which require configured SMTP for any self-service signup/recovery flow;
- microservices, Kubernetes, or complex event-streaming infrastructure.

Basic recruiter/reviewer membership, first-team onboarding, and reviewer invitations are narrow product needs, not enterprise administration. First-team onboarding is proposed but not yet implemented; the current internal staging environment still requires administrator provisioning. See the [proposed onboarding decision](../decisions/mvp-first-team-onboarding.md) and [release readiness](../release-readiness.md).

These boundaries are not implied roadmap commitments. Any expansion requires a validated requirement and an explicit product decision. External execution, email delivery, live AI, and public activation remain separate gates.
