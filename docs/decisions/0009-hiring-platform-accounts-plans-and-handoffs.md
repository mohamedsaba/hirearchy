# 0009 — Hiring Platform Accounts, Organization Plans, Unified Kimi AI & Managerial Handoffs

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

Earlier Hirearchy milestones established isolated workspace sessions, immutable chronological evidence reconstruction, evaluator observations, review packets, and an advisory AI review assistant (`0006`). Moving to the complete end-to-end hiring platform requires multi-company candidate accounts, organization-level commercial plan enforcement without a free plan, structured per-candidate filtering, AI-assisted problem creation backed by a reusable library, peer collaboration, and post-assessment managerial handoffs.

## Decisions

1. **Candidate Account Gate & Multi-Company Portal (`/candidate`, `/r26/candidate/[sessionId]`)**:
   - Candidates enter at `/candidate/login` and confirm the invited email before opening an assessment. The portable profile has a Hirearchy ID. Birth year is optional and private. Government identity verification requires a separate provider and custody decision.
   - The `/candidate` portal lists assessments across companies and their published outcomes. The invited verified account can resume the same assessment after completing its profile.
   - Hiring teams enter separately at `/r23/login`. Internal evaluator notes and AI Managerial Fit Reports are strictly withheld from candidate-facing responses and views.

2. **Commercial Organization Plans (No Free Tier)**:
   - `none`: Team onboarding allowed; assessment issuance and AI capabilities blocked (`402`).
   - `per_candidate`: Paid candidate slot ledger tracked per distinct normalized candidate email per organization (re-issuing to an already credited candidate does not consume another slot).
   - `pro`: Unlimited candidate invitations, AI Assessment Builder, Saved Problem Library, Candidate Workspace AI, peer second opinions, and managerial handoffs.
   - `ultra`: Includes `pro` plus Kimi K3.1 Pro deep AI Candidate Reviews (with chronological event timing deltas `Δ`) and automated Managerial Performance & Fit Reports upon acceptance.

3. **Workspace Roles (`cto`, `recruiter`, `reviewer`)**:
   - The workspace owner or CTO manages team invitations and views all candidates and handoffs. Founder UAT includes local plan and credit controls for test organizations.
   - `recruiter` manages org-wide candidates, problem authoring/library, issuance, and handoff visibility.
   - `reviewer` (Evaluator) builds/saves/reuses problems, issues assessments, collaborates via peer Second Opinions, and publishes human Accept/Reject decisions.

4. **Overhauled Assessment Builder**:
   - In Hiring Platform mode (`isHiringPlatformEnabled()`), manual ad-hoc raw code editing is replaced with three structured paths: **Platform Templates**, **Kimi K3.1 Pro AI Problem Generation** from curated hiring criteria (which appends the platform `Terms and Conditions` style probe per `0008` without truncating task text), and the **Saved Problem Library** (`assessment_library_entries`, storing validated, role-tagged definitions).
   - Standard R2.11 recruiter authoring keeps its mutable **Reusable Problem Library** (`reusable_problems`, `0007`) and `/problems` management pages intact when Hiring Platform mode is inactive.

5. **Unified NVIDIA NIM `moonshotai/kimi-k3.1-pro` Model**:
   - All live AI features — AI Candidate Review (including timing deltas `Δ` and footer stripping per `0008`), AI Assessment Builder, Candidate Workspace AI (`r212`), and Managerial Fit Reports — target NVIDIA NIM `moonshotai/kimi-k3.1-pro` and surface provider failures and plan requirements. Where a report can summarize existing evidence, the interface identifies the evidence summary and leaves coverage judgments open.

## Consequences

- Existing automated staging/lockdown tests keep their exact behavior because hiring platform routes, sidebar links, and database operations are cleanly gated by `isHiringPlatformEnabled()`.
- Database migration `0019_hiring_platform.sql` establishes additive RLS-protected tables while preserving immutable core evidence constraints and `0018_reusable_problems.sql`.
