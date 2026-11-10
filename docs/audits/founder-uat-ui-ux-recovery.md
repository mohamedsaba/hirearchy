# Founder UAT UI/UX recovery audit

**Status:** Local visual, journey, CSS and staging verification passed. This checkpoint takes effect only after the final head of PR #21 passes all four required checks and merges through branch protection. Founder visual approval is still pending.

**Scope:** Local Software UI/UX at `http://127.0.0.1:3000/`. The founder selected UI/UX only. Sol owned the final design and implementation; Luna workers supplied independent visual, source and runtime checks. This is not public-release approval.

## Findings and resolution

| Priority | Finding                                                                                                              | Resolution                                                                                                                                                                                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0       | Account route-handler HTML bypassed the Next layout and rendered without authored styles.                            | Both HTML helpers use one shared document shell, same-origin stylesheet and local DM Sans. The browser guard checks actual CSS/font responses and computed styles, including invalid form responses. Raw-document CSP retains default denial and same-origin form/style/font restrictions. |
| P0       | The authenticated builder lacked the Software token scope despite receiving CSS.                                     | The builder has the shared Software scope and a focused Define → Validate → Issue layout.                                                                                                                                                                                                  |
| P1       | Account, organization and authoring pages felt like generic, disconnected form cards.                                | Compact account pages, a plum workspace rail, clear primary actions, structured assessment rows, team sections and task-specific candidate/evaluator layouts preserve the existing wordmark, typography and mint accent.                                                                   |
| P1       | Settings had CSP errors and a tablet-wide document; the members table broke names into fragments.                    | Removed inline styles, fixed the absolute hidden heading that escaped the scroll region, kept names readable and added a keyboard-focusable table region with an explicit scrolling hint.                                                                                                  |
| P1       | Candidate instructions and evaluator task context exposed raw Markdown.                                              | Both reuse the same safe React brief renderer and shared styles. It renders approved headings, lists, emphasis and code; raw HTML remains escaped and links/images remain text.                                                                                                            |
| P1       | Mobile authoring actions obscured content; issued invitation content reached 483 px inside a 375 px viewport.        | Actions stay in document flow; snapshot facts and invitation actions stack on narrow screens. Final overflow checks pass.                                                                                                                                                                  |
| P1       | Tablet evidence navigation clipped the final mode; narrow source columns hid long lines.                             | Tablet controls use three columns and panels stack; mobile uses two columns. Focusable code blocks retain horizontal scrolling and explain its keyboard use.                                                                                                                               |
| P1       | Validation notice contrast and scrolling integrity digests failed accessibility checks.                              | Confirmation uses the light success surface; digests wrap without requiring horizontal scrolling.                                                                                                                                                                                          |
| P1       | Missing candidate paths reached an unbranded framework 404.                                                          | A shared branded missing-page state gives a clear route home. The journey requires the rendered heading before auditing this state.                                                                                                                                                        |
| P2       | Duplicate inbox controls, prominent implementation IDs, raw timestamps and crowded mobile timers weakened hierarchy. | Simplified account navigation, retained references in disclosures, formatted session times with UTC stated, and gave the mobile timer its own readable row.                                                                                                                                |

No evaluator scores, rankings or automatic verdicts were introduced. Review progress remains separate from finalized human review packets. New unsaved drafts select the approved Reservation Moves template; existing drafts retain their template and content. Custom authoring remains an explicit choice. No AI-generation integration or paid calls were added.

## Browser and visual evidence

The five viewport sizes are 1440×900, 1280×800, 768×1024, 390×844 and 375×812. Screenshots come from the actual loopback application, not a mockup. Binaries remain ignored and local; none were uploaded.

The landing-first positive journey covers signup, captured-mail confirmation, organization creation, a separate evaluator account and invitation, draft/save/validate/issue, candidate consent/edit/autosave/resume/submit, evidence inspection, source observations, human-review finalization, returning-user login and persistence. The separate committed Founder UAT suite also covers wrong/unverified login, recovery-credential quarantine, tenant/assignment denial, invitation revocation and finalized-record protection. Its disposable runtime must attest its protected run ID before mutations.

The recorded persistent-origin audit includes 24 state visits / 120 viewport checks; the supplementary account/error/session-summary/evaluator-summary/source-observation audit includes 9 visits / 45 checks. Both require zero Axe WCAG A/AA violations, zero document overflow and no unexpected browser/asset errors. Readiness and stylesheet delivery alone are not visual acceptance.

Keyboard evidence includes native organization and logout forms, Space/Enter for candidate consent/activation, arrow-key evaluator tab navigation, Enter for the review packet, focusable scroll regions/code, and native reference disclosures. The evaluator uses a normal, separately authenticated assigned account. Execution and AI requests are asserted absent in the real candidate journey.

Representative local files use the `sol-final-*` prefix under `docs/design/screenshots/founder-uat/after/`. Independent visual review checked settings, builder, candidate consent/active/submitted work, evidence and finalized review at the required sizes, then rechecked the corrected tablet evidence, mobile invitations and candidate header. Sol separately inspected account errors, the session overview, editor and evidence layouts.

## Runtime and data preservation

The supported launcher rebuilt the production app and switched only the two owned UAT profiles, which share loopback ports. An exit/signal restoration handler was installed before the temporary handover. The final persistent instance is restored at the founder URL; automation containers are stopped and their volumes retained. No unrelated container or volume was removed.

Read-only identity digests confirm the original founder auth user, organization and membership remain. All identities captured before the restart remain; synthetic test records are additive. Protected runtime/initialization file hashes and persistent database/mail volume names match the pre-restart checkpoint. The dirty primary checkout remains untouched.

The independent CSS guard checks the restored persistent instance. Readiness must be HTTP 200 / `ready`, without the automation run ID; the build provenance stamp must match the clean worktree head.

## Engineering evidence and limits

The local full `npm run verify` passed formatting, lint, typechecking, 1,230 tests (13 intentionally skipped), 30 executor checks, 6 dispatch checks, 7 service checks and the production build. Focused brief/document/API tests passed after the final presentation refinements. Existing lint and dynamic-filesystem tracing warnings remain visible.

The real-Docker staging browser tests now follow the actual accessible workspace controls and explicit template selection. Authorization, cookie, CSRF, assignment, private evidence and disabled-capability assertions remain. The restart probe additionally recognizes the exact no-code `pg` unexpected socket-end error inside its existing bounded restart loop; connect plus `SELECT 1` is still required and other errors remain fatal.

All four required protected checks remain mandatory on the final PR head: `verify`, `postgres`, `real-docker`, `dependency-audit`. The final receipt is [PR #21](https://github.com/mohamedsaba/hirearchy/pull/21); failed intermediate runs are not acceptance evidence.

Live AI generation/assistance, candidate execution, external email delivery and public hosting remain unavailable. Static validation does not claim executed tests. Founder visual approval remains the final authority.

Independent verification also passed the full staging integration: normal-account and candidate/reviewer browser acceptance, encrypted backup verification and recovery. Final source captures passed 165 viewport checks (120 journey + 45 supplementary), plus 20 core-screen captures, with zero Axe violations, document overflow or unexpected browser problems.
