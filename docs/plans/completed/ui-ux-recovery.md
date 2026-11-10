# Founder UAT UI/UX recovery

- Date: 2026-11-10.
- Baseline: protected main at `a10c0ccd996e7e8440329987187a7cbf770bce97` (PR #20).
- Status: implementation and local acceptance complete; this checkpoint becomes effective only through the green protected merge of [PR #21](https://github.com/mohamedsaba/hirearchy/pull/21). Founder visual approval remains pending.
- Scope: restore real browser-delivered styling and polish the complete local owner, recruiter, candidate and evaluator experience. The founder explicitly selected UI/UX only; live AI, candidate execution, external email and public hosting remain disabled.

## Delivered

Sol owned the final design and implementation after the founder rejected the generic presentation. The existing wordmark, DM Sans, plum and restrained mint identity remain. Compact account pages, a coherent workspace rail, clear assessment authoring/invitations, a code-first candidate workspace and chronological evaluator evidence replace disconnected layouts. Safe brief formatting is shared by candidate and evaluator views.

The route-handler HTML shell now loads the same stylesheet and local font as Next pages under the existing restrictive security boundary. A real Chromium regression checks delivered CSS/fonts and computed styles on account GET/error/invalid-POST states; the existing required real-Docker workflow also checks authenticated product styling.

## Acceptance receipts

- Exact persistent origin: `http://127.0.0.1:3000/`.
- Full normal-account signup/mail/organization/assessment/candidate/evaluator journey passed. Candidate work, observations and final human review persist across reload and returning-user sign-in.
- Final persistent audit: 24 journey visits × 5 viewport sizes = 120 checks; 9 supplementary state visits × 5 = 45 checks. Zero Axe WCAG A/AA violations, document overflow or unexpected browser problems. Twenty additional core-screen captures passed.
- Required sizes: 1440×900, 1280×800, 768×1024, 390×844, 375×812. Sol and an independent reviewer inspected actual screenshots; material findings were corrected and recaptured.
- Committed Founder UAT positive/negative suite passed on the attested disposable profile. Its exit/signal handler restored the persistent profile without deleting volumes.
- Independent persistent CSS/readiness/provenance check passed. Independent staging integration, encrypted backup verification and recovery passed.
- Original founder identity records and all pre-restart identities remain. Protected credential/initialization hashes and persistent volume names are unchanged. The dirty primary checkout and unrelated resources remain untouched.
- Local full `npm run verify` passed; focused tests passed after final refinements. Exact final protected checks remain mandatory: `verify`, `postgres`, `real-docker`, `dependency-audit`. PR #21 is the live final gate receipt; failing intermediate runs do not count.

## Boundaries and evidence

No GoTrue, AMR, tenant, assignment, proof, candidate lifecycle or human-verdict boundary was relaxed. No scores, rankings, paid AI calls or fabricated execution results were added. Static validation does not claim executed tests. New unsaved drafts use the approved Reservation Moves template; existing drafts are preserved and custom authoring stays explicit.

The finding/resolution ledger and local screenshot manifest are in [the recovery audit](../../audits/founder-uat-ui-ux-recovery.md). Screenshots and private diagnostics remain local and ignored. [Release readiness](../../release-readiness.md) remains the authoritative release record. This is local founder review, not production or external-candidate approval.
