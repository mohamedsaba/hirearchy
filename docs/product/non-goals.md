# Scope boundaries & non-goals

The current platform focuses on end-to-end engineering evaluation inside one deployable Next.js + PostgreSQL modular monolith (`R2.3–R2.15`).

Out of scope for the current release baseline:

- **Enterprise HR suite expansion:** Full ATS integrations, multi-team analytics warehouses, billing, or arbitrary custom RBAC beyond `recruiter` and `reviewer` organization memberships.
- **Invasive candidate surveillance:** Webcam/biometric recording, keystroke biometrics, full-device spyware, or opaque proctoring heuristics.
- **Opaque automated hiring finality:** Even with the advisory **AI Candidate Review** panel ([ADR 0006](../decisions/0006-ai-assisted-candidate-review.md)), the platform never auto-rejects candidates behind the reviewer's back or injects automatic scores into immutable evidence (`r27`) or finalized human review packets (`r210`).
- **Microservice sprawl:** PostgreSQL, GoTrue auth, Mailpit (in local UAT), the restricted Python executor container (`packages/restricted-executor`), and the single Next.js web runtime compose cleanly without message brokers or microservice meshes.
