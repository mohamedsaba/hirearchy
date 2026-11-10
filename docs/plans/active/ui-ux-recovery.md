# Founder UAT UI and CSS recovery

- Status: founder rejected the visual result; readiness remains **INVALIDATED**. Sol now owns all UI/UX design and implementation directly.
- Baseline: `origin/main` at `a10c0ccd996e7e8440329987187a7cbf770bce97` (PR #20).
- Scope: diagnose the exact loopback application, restore styled HTML responses, complete the full route/state UI/UX and landing-first user-journey acceptance, add a browser-delivered CSS regression, and verify a production build and persistent runtime restart without changing founder data.
- Boundaries: keep GoTrue authentication, AMR checks, proof v2, tenant authorization, and evaluator assignment unchanged. Candidate execution and live AI stay disabled. Use only synthetic/disposable journey data. Keep screenshot binaries local.

## Final design direction

The application must feel like a deliberate engineering workbench, not a set of generic form cards. Keep the Hirearchy wordmark, DM Sans, plum identity and restrained mint accent. Use compact navigation, clear working areas, fine rules, readable code and a consistent hierarchy. Separate compact account pages from the wider organization workspace. Authoring, candidate work and evidence review each need layouts suited to their task.

The founder challenged the manual builder, then explicitly selected **Finish UI/UX only**. AI integration and paid calls are outside this phase. Make existing capabilities truthful and the supported authoring flow clear. New unsaved assessments start with the approved Reservation Moves template rather than a pre-filled fictional custom exercise; existing drafts keep their selected template and content. Custom authoring remains available as an explicit choice. This is a presentation/default-selection change, not a change to validation, issuance or evidence rules.

## Ownership

- Sol: all UI/UX decisions and implementation, integration, authoritative release record, acceptance and protected PR process.
- Worker A: read-only visual evidence and independent QA; no UI implementation.
- Worker B: read-only AI/runtime investigation and independent technical verification; changes require a scoped assignment from Sol.

The final tablet pass found Settings at 1118 px document width inside a 768 px viewport. The exact overflowing element still needs live inspection. This is an open P1 and all prior responsive-readiness claims remain provisional.

Worker A's audit must cover every major landing, account, recruiter, candidate, and evaluator route and important state, with actual screenshot inspection at 1440×900, 1280×800, 768×1024, 390×844, and 375×812. The full real journey starts at `/` and uses supported browser navigation, local captured mail, normal separate accounts, and synthetic/disposable data. Include responsive overflow, keyboard/focus, Axe, contrast, and browser console checks. Resolve every P0 and material P1; keep a concise finding/evidence/resolution ledger. This plan does not close when CSS alone passes.

## Evidence and work

| Check                   | Current evidence                                                                                                                                                                                                                                                                                                                                    | Status                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Exact entry URL         | Chromium at `http://127.0.0.1:3000/` follows the Founder UAT redirect to `/r23/login`; the regression covers this default-profile path.                                                                                                                                                                                                             | Verified                          |
| Next login CSS delivery | The post-build Chromium regression verifies delivered stylesheet responses and computed authored styles on the Next login, including house typography, surface, heading, fields, buttons, and links. It reports no failed CSS/font/JS requests or unhandled browser errors.                                                                         | Passed locally                    |
| Auth route-handler HTML | `htmlResponse()` now uses the shared document shell and same-origin `/software-ui.css`; the regression verifies browser CSS/font delivery, computed styles, one H1, GET/error states, and invalid POST documents.                                                                                                                                   | Passed locally                    |
| Root cause              | The raw account route handlers bypassed Next's root layout and its CSS imports. This was not a static asset failure, Tailwind issue, hydration issue, or CSS response blocked on `/r23/login`.                                                                                                                                                      | Confirmed                         |
| Persistent runtime      | After a clean `npm run build`, only `hirearchy-founder-uat-web-1` was restarted. It is healthy; `/software-ui.css` returned 200 `text/css` (12,069 bytes) and DM Sans returned 200 `font/woff2` (36,980 bytes). Postgres, GoTrue, and Mailpit remained healthy. Pre-journey identity digests are saved locally; post-journey comparison is pending. | Verified; data comparison pending |
| Security headers        | Raw handler CSP retains `default-src 'none'`, `form-action 'self'`, `base-uri 'none'`, and `frame-ancestors 'none'`; it adds only same-origin `style-src 'self'` and `font-src 'self'`. No inline styling allowance was added.                                                                                                                      | Passed locally                    |
| CI regression           | `test:staging:presentation` invokes the same browser-delivery check against its disposable staging app in an explicit `staging-authenticated` mode; this runs inside the existing required `real-docker` check. Latest CI result for this commit is pending.                                                                                        | Pending                           |

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

1. Complete A's full route/state visual audit and landing-first journey; link the evidence ledger and screenshots stay local.
2. Compare pre-journey founder identity digests after the additive synthetic journey and record preservation without exposing identifiers.
3. Read the new CI diagnostics, complete the existing four protected checks, and resolve any verified failure at its cause.
4. Update this evidence table from current integrated results; move this plan to `docs/plans/completed/` only when all listed UX and engineering gates are complete.
