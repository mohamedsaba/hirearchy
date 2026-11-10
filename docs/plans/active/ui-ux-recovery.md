# Founder UAT UI and CSS recovery

- Status: in progress; readiness is **INVALIDATED** pending current browser evidence.
- Baseline: `origin/main` at `a10c0ccd996e7e8440329987187a7cbf770bce97` (PR #20).
- Scope: diagnose the exact loopback application, restore styled HTML responses, complete the full route/state UI/UX and landing-first user-journey acceptance, add a browser-delivered CSS regression, and verify a production build and persistent runtime restart without changing founder data.
- Boundaries: keep GoTrue authentication, AMR checks, proof v2, tenant authorization, and evaluator assignment unchanged. Candidate execution and live AI stay disabled. Use only synthetic/disposable journey data. Keep screenshot binaries local.

## Ownership

- Worker A: presentation wrapper for HTML response routes and page/component/style corrections; no authentication or authorization changes.
- Worker B: runtime and packaging diagnosis, browser-delivered CSS regression, restart/build evidence, and this plan.
- Parent: integrated review, authoritative `docs/release-readiness.md`, acceptance decision, and protected PR process.

Worker A's audit must cover every major landing, account, recruiter, candidate, and evaluator route and important state, with actual screenshot inspection at 1440×900, 1280×800, 768×1024, 390×844, and 375×812. The full real journey starts at `/` and uses supported browser navigation, local captured mail, normal separate accounts, and synthetic/disposable data. Include responsive overflow, keyboard/focus, Axe, contrast, and browser console checks. Resolve every P0 and material P1; keep a concise finding/evidence/resolution ledger. This plan does not close when CSS alone passes.

## Evidence and work

| Check                   | Current evidence                                                                                                                                                                                                                                                                          | Status                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Exact entry URL         | `GET /` on `127.0.0.1:3000` redirects to `/r23/login`.                                                                                                                                                                                                                                    | Verified                      |
| Next login CSS delivery | Chromium requested two `/_next/static/chunks/*.css` assets; both returned `200 text/css` (775 and 42 parsed rules). No failed CSS/JS requests or console errors. Computed heading uses DM Sans at 44px; login input and button have authored background, border, dimensions, and spacing. | Verified                      |
| Auth route-handler HTML | `GET /r23/signup`, `/r23/verify-email`, `/r23/recover`, and `/r23/reset-password` returned zero stylesheets/assets; computed body was Times New Roman with a transparent background, heading was default black 32px, and links were default blue and underlined.                          | P0 reproduced; repair pending |
| Root cause              | These routes use `htmlResponse()` in `apps/web/src/staging/browser.ts` and bypass the Next root layout and its CSS imports. The issue is not static asset delivery, Tailwind, hydration, or a CSS response blocked on `/r23/login`.                                                       | Confirmed                     |
| Persistent runtime      | Existing `hirearchy-founder-uat-web-1` serves Next.js 16.4.3 from the isolated UAT worktree with a read-only source bind mount. Existing Postgres, GoTrue, and Mailpit containers remain healthy. No service was restarted or data changed during diagnosis.                              | Verified                      |
| Security headers        | Handler responses set `default-src 'none'` and currently omit `style-src` and `font-src`. Any styling repair must preserve the CSP boundary without `unsafe-inline` or unrelated auth changes.                                                                                            | Constraint recorded           |

The `docs/release-readiness.md` record is parent-owned and currently marks acceptance invalidated. Earlier UAT results remain historical only; they do not satisfy this plan.

Baseline screenshots were captured from the actual loopback application in Chromium with blank forms and no account data. They remain local-only under the ignored `.data/ui-ux-recovery/` directory: `baseline-login.png` and `baseline-signup.png`.

## Acceptance checks

- Browser GETs for the Next login and handler-rendered account states load authored CSS without browser console or network errors.
- Browser-computed font, page surface, heading, fields, buttons, and links demonstrate authored styling on handler GET and invalid POST responses; the check must not pass merely because a stylesheet exists in source.
- Same-origin CSS and font policy remains compatible with the handler CSP; no broad CSP weakening or auth behavior change.
- Worker A records the all-major-route/state visual audit, five required viewports, full recruiter → candidate → evaluator browser journey, Axe/keyboard evidence, and P0/material P1 closure.
- The UI work survives a clean production build, web-service restart, and reload at the exact founder URL.
- Verify the persistent database/account state remains intact; use only invalid requests or the designated automation profile for test mutations.
- All four protected GitHub checks pass on the accepted integrated source: `verify`, `dependency-audit`, `postgres`, `real-docker`.
- Parent records final readiness only after integrated UX, responsive, accessibility, user-journey, security, runtime, and CI evidence passes and unresolved P0/material P1 findings are zero.

## Next steps

1. Complete A's presentation-shell repair and full route/state audit; inspect its exact diff/CSP behavior and link its evidence ledger here.
2. Add a Playwright regression for styled computed values and actual delivered CSS across login plus handler GET and invalid POST states.
3. Run the focused browser regression, then coordinate the clean production build and persistent web restart serially.
4. Update this evidence table from current integrated results; move this plan to `docs/plans/completed/` only when all listed UX and engineering gates are complete.
