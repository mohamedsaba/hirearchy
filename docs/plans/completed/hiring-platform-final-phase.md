# Hiring Platform Final Phase — Completed Implementation

- **Branch:** `feat/hiring-platform`
- **Target migration:** `0018_hiring_platform.sql`

## Delivered Capabilities

1. **Candidate Account Gate & Multi-Company Portal**:
   - Dedicated `/candidate/login`, `/candidate/signup`, `/candidate` portal, and `/api/candidate-portal` API.
   - `/r26/candidate/[sessionId]` preserves `#token` fragments across login/profile/email-mismatch gates using `sessionStorage` and verifies verified email + profile completion before granting workspace entry.
2. **Organization Plans & Team Roles**:
   - Entitlement catalog (`apps/web/src/plans/entitlements.ts`) implementing `none`, `per_candidate`, `pro`, and `ultra` tiers with zero free tier.
   - Distinct candidate email credit accounting in Postgres (`organization_plans`, `organization_candidate_credits`).
   - `Team & Plan` settings support `cto`, `recruiter`, and `reviewer` invitations plus plan/credit management by CTO / Owner.
3. **Candidates Pipeline & Filtering**:
   - Per-candidate grouped view (`/r23/organizations/[organizationId]/candidates`) with KPI summary, curated dropdowns (Role, Stage, Experience Level, Location, Sort), and interactive Skill chips.
4. **Overhauled Assessment Builder & Saved Problem Library**:
   - Removed manual custom code authoring; implemented Platform Templates (`reservation-moves-v3`, `webhook-dedup-v1`, `cache-rate-limiter-v1`), Kimi K3.1 Pro AI Builder (`/hiring/builder/generate`), and reusable Saved Problem Library (`/hiring/library`, `/hiring/issue`).
5. **Evaluator Decision, Second Opinions & Managerial Handoffs**:
   - Peer Second Opinions (`hiring_second_opinions`) + Accept/Reject decision publishing (`hiring_decisions`) with separate candidate-visible feedback and internal team notes.
   - Managerial Handoffs hub (`/r23/organizations/[organizationId]/handoffs` and `[sessionId]`) with Ultra-tier Kimi K3.1 Pro Performance & Fit Reports.
6. **Unified Kimi K3.1 Pro Integration**:
   - `moonshotai/kimi-k3.1-pro` wired across AI Candidate Review (with chronological timing deltas `Δ`), AI Assessment Builder, Candidate Workspace AI, and Managerial Fit Reports.
