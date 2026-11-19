# 0007 — Hiring Platform Accounts, Organization Plans, Unified Kimi AI & Managerial Handoffs

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

Earlier Hirearchy milestones established isolated workspace sessions, immutable chronological evidence reconstruction, evaluator observations, review packets, and an advisory AI review assistant (`0006`). Moving to the complete end-to-end hiring platform requires multi-company candidate accounts, organization-level commercial plan enforcement without a free plan, structured per-candidate filtering, AI-assisted problem creation backed by a reusable library, peer collaboration, and post-assessment managerial handoffs.

## Decisions

1. **Candidate Account Gate & Multi-Company Portal (`/candidate`, `/r26/candidate/[sessionId]`)**:
   - Candidates must authenticate with a verified email and complete a portable identity profile (name, birth year/age, location, seniority, skills, and masked ID verification document) before launching an assessment workspace.
   - Fragment tokens (`#token=...`) are preserved in `sessionStorage` across auth and profile gates, and the dedicated `/candidate` portal lists assessments across all issuing companies, including published outcomes.
   - Internal evaluator notes and AI Managerial Fit Reports are strictly withheld from candidate-facing responses and views.

2. **Commercial Organization Plans (No Free Tier)**:
   - `none`: Team onboarding allowed; assessment issuance and AI capabilities blocked (`402`).
   - `per_candidate`: Paid candidate slot ledger tracked per distinct normalized candidate email per organization (re-issuing to an already credited candidate does not consume another slot).
   - `pro`: Unlimited candidate invitations, AI Assessment Builder, Saved Problem Library, Candidate Workspace AI, peer second opinions, and managerial handoffs.
   - `ultra`: Includes `pro` plus Kimi K3.1 Pro deep AI Candidate Reviews (with chronological event timing deltas `Δ`) and automated Managerial Performance & Fit Reports upon acceptance.

3. **Workspace Roles (`cto`, `recruiter`, `reviewer`)**:
   - `cto` / workspace owner manages plan tiers, credits, team invitations, and views all candidates and handoffs.
   - `recruiter` manages org-wide candidates, problem authoring/library, issuance, and handoff visibility.
   - `reviewer` (Evaluator) builds/saves/reuses problems, issues assessments, collaborates via peer Second Opinions, and publishes human Accept/Reject decisions.

4. **Overhauled Assessment Builder**:
   - Manual ad-hoc raw code editing is replaced with three structured paths: **Platform Templates**, **Kimi K3.1 Pro AI Problem Generation** from curated hiring criteria, and the **Saved Problem Library**.

5. **Unified NVIDIA NIM `moonshotai/kimi-k3.1-pro` Model**:
   - All live AI features — AI Candidate Review (including timing deltas `Δ`), AI Assessment Builder, Candidate Workspace AI (`r212`), and Managerial Fit Reports — target NVIDIA NIM `moonshotai/kimi-k3.1-pro` and surface explicit errors or upgrade gates rather than fabricating live outputs when disabled or unconfigured.

## Consequences

- Existing automated staging/lockdown tests keep their exact behavior because hiring platform routes, sidebar links, and database operations are cleanly gated by `isHiringPlatformEnabled()`.
- Database migration `0018_hiring_platform.sql` establishes additive RLS-protected tables while preserving immutable core evidence constraints.
