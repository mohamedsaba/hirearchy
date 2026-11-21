# Scope boundaries & non-goals

Hirearchy Software is an end-to-end engineering hiring and evaluation platform delivered inside one deployable Next.js + PostgreSQL modular monolith (`R2.3–R2.15` plus the Hiring Platform in [ADR 0009](../decisions/0009-hiring-platform-accounts-plans-and-handoffs.md)).

Out of scope:

- **Invasive candidate surveillance:** Webcam/biometric recording, keystroke biometrics, full-device spyware, or opaque proctoring heuristics.
- **Opaque automated hiring finality:** Even with the advisory **AI Candidate Review** panel ([ADR 0006](../decisions/0006-ai-assisted-candidate-review.md)) and neutral style observations ([ADR 0008](../decisions/0008-generated-assessment-llm-style-probe.md)), the platform never auto-rejects candidates behind the reviewer's back or injects automatic scores into immutable evidence (`r27`) or finalized human review packets (`r210`).
- **Generic multi-metric analytics bloat:** Evaluator and hiring-team views stay grounded in chronological work evidence, diffs, concrete requirements, and actionable handoffs rather than vanity HR dashboards.
- **Microservice sprawl:** PostgreSQL, GoTrue auth, Mailpit (in local UAT), the restricted Python executor container (`packages/restricted-executor`), and the single Next.js web runtime compose cleanly without message brokers or microservice meshes.
