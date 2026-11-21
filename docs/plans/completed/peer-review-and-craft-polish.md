# Team Peer Review, WCAG 2.2 Accessibility & Craft Polish

## Goal

Add a GitHub-PR-style team peer review workflow with real email notifications and direct review deep links, introduce subtle Common-Thread brand sound cues with a persistent mute control, and elevate end-to-end visual craft and WCAG 2.2 compliance across all hiring actors (Candidate, Recruiter, Evaluator, CTO / Owner).

## Key Changes

1. **Database & Staging RPCs (`0020_peer_review_verdicts.sql`, `install-api.sql`)**
   - Added `request_context jsonb NOT NULL DEFAULT '{}'` and `verdict text CHECK (verdict IN ('approve', 'comment', 'request_changes'))` to `hirearchy.hiring_second_opinions`.
   - Extended `staging.hiring_second_opinion_create`, `staging.hiring_second_opinion_respond`, `staging.hiring_review_context`, `staging.hiring_candidates_list`, and `staging.hiring_handoffs_list` with structured peer-review verdicts, requester context, and teammate email addresses.
   - Kept base migrations strictly schema/RLS-only; all runtime RPCs live under schema `staging`.

2. **Email Notifications & Deep-Link Auth Flow (`apps/web/src/hiring/mail.ts`, `founder-uat-mail.ts`, `staging/browser.ts`)**
   - Added zero-dependency RFC 5321/5322 SMTP delivery supporting custom SMTP (`HIREARCHY_SMTP_*`) and local Mailpit (`FOUNDER_UAT_MAILPIT_SMTP_PORT` / `MAILPIT_SMTP_PORT`), with Common-Thread HTML + plain-text templates for peer review requests and submitted verdicts.
   - Extended `/r23/mail` and `/api/founder-uat/mail/consume` to list and open peer-review notifications safely (same-origin validated).
   - Added safe post-login redirect (`next`) support across `/r27/organizations/[orgId]/sessions/[sessionId]` -> `/r23/login?next=...` -> `/r23/auth/callback` (verifying organization membership via `session.open` before selecting the organization and landing straight on the requested peer review).

3. **Evaluator, Candidates & Handoffs UI (`hiring-decision-panel.tsx`, `evaluator-review-workspace.tsx`, `candidates-client.tsx`, `handoff-dossier-client.tsx`)**
   - Surfaced an assigned peer-review spotlight card with shared requester notes, advisory AI summary (explicitly marked non-authoritative), quick evidence jump controls, and a 3-way verdict selector (**Approve**, **Comment**, **Flag concerns**) that notifies the requester without requiring final decision publication.
   - Added a **Peer reviews requested from you** queue at the top of Candidates and verdict badges on Candidates, Handoffs, and Review tabs.

4. **Subtle Brand Sound Design (`apps/web/src/ui/sound.ts`, `sound-toggle.tsx`)**
   - Synthesized restrained Web Audio API cues (`confirm`, `dispatch`, `submit`, `complete`, `error`) wired only to milestone actions (save checkpoint, verification finish, candidate submit, assessment issued, peer review sent/submitted, decision published, AI review ready), paired with a persistent `SoundToggle` beside `ThemeToggle`.

5. **WCAG 2.2 & Common-Thread Visual Polish**
   - Added `scroll-margin-top` (`2.4.11` Focus Not Obscured), high-contrast `:focus-visible` outlines (`2.4.13` Focus Appearance) in both Warm Ivory Light and Obsidian Plum Dark, skip-to-main-content links across workspace/review/auth shells, >= 24px interactive targets (`2.5.8`), and fixed dark-mode primary button / search input / plum-header toggle contrast bugs.

## Verification

- `npm run verify` (`format:check`, `lint`, `typecheck`, `test`, `test:executor`, `build`)
- `npm run test:postgres`
- `npm run test:staging`
- Live Playwright end-to-end visual inspection in Warm Ivory Light, Obsidian Plum Dark, desktop (1440px) and mobile (390px) viewports.
