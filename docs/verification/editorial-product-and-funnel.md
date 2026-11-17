# Editorial product and early-access upgrade

Implementation date: 17 November 2026.
Status: both phases implemented; local browser/device acceptance and the unrestricted product verification gate remain open. No production deployment was performed.

## Source and workspace audit

| Project   | Starting source                                                                                                              | Implementation checkout                                       | Branch                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------- |
| Product   | Latest merged `5394d8b` (PR #21); the primary checkout was 126 commits behind this source                                    | `/home/mohamedsaba/Hirearchy/.worktrees/editorial-product-ui` | `codex/editorial-product-ui-20261117`  |
| Marketing | Current `~/Hirearchy-landing` files, including the pre-existing uncommitted work; preserved at `6ed099d` before this upgrade | `/home/mohamedsaba/Hirearchy/.worktrees/editorial-landing`    | `codex/editorial-demo-funnel-20261117` |

The original product Git metadata and landing directory were read-only in this session. Separate bare clones back these isolated worktrees. Neither original working copy was overwritten, cleaned, reset, stashed or switched. The landing preservation commit is a baseline, not work attributed to this upgrade.

The product is a Next.js modular monolith. R23 authoring, R26 candidate work and R27 assigned-review evidence are the supported durable journey. Legacy evaluator and candidate surfaces remain present. Shared styles in `apps/web/public/software-ui.css` also serve the raw authentication and organization documents; root-layout CSS alone would not cover them.

## Phase 1 — product

- Canonical plum `#211426`, elevated plum `#2B1B32`, slate `#2D1D35` / `#3A2644`, cream `#F5EFE6`, mint `#8EE3B8` and coral `#E85D56` tokens. Semantic action/foreground, text, border, status and code tokens replace mixed light surfaces and literal legacy colors. Cream borders use 12% opacity; surfaces use rounded corners and restrained ambient shading.
- Custom Tailwind and Framer Motion controls, with no component library. Preflight is disabled to preserve existing layout contracts; scoped editorial resets support the new controls. Spring motion respects the user's motion preference.
- A prominent AI-policy switch in both builders. Candidate-facing rules are explicit; the deployment's disabled AI setting remains disabled. Existing scope and stack restrictions are retained. Scenario-type pills and template stack/context chips use existing supported data.
- Shared-element stage/review tabs and a chronology scrubber using existing evidence sources and their authoritative ordering. Source jump points open the existing inspector; no scoring, inferred intent or new evidence is generated.
- Submitted-file line selection feeds a targeted follow-up into the existing private observation workflow. The saved body includes the exact submitted file and line; the existing file/version/digest anchor, CSRF and reviewer authorization remain in force. This is a private question for a candidate conversation, not an automated outbound message.
- Dark candidate workspace surfaces, editor, file tree and terminal; factual command/test outcomes keep their meaning. The legacy editor defaults to dark and retains an explicit local light preference. Available assistants show the neutral transparency badge. No disabled AI or execution capability is enabled.

Two build defects encountered in the touched authoring journey were fixed at their source: browser presentation no longer re-exports server validation and `node:crypto`, and the recovery route exposes a required `Request` parameter to Next's route checker. Validation functions and their assertions are unchanged; the tests import them from the server validation module.

## Phase 2 — marketing

The homepage retains its editorial chapters and navigation, with a real interactive demo inside its Software chapter. `/products/software` now contains a product-led hero, the same walkthrough, an exact comparison table, pricing and early access.

1. **Tailor the Task:** Node.js/Python, incident focus and AI policy update the brief and repository view. Both incident focuses investigate the same sample service's concurrency and recovery behavior.
2. **Real Workspace:** clickable source files, explicit sample AI conversation, staged terminal output, failure reproduction, a visible atomic-lock change, and a rerun showing passing sample checks. Output is clearly illustrative; no code is executed and no live AI request is sent.
3. **3-Minute Chronology:** keyboard/touch/native-range source selection, inspectable recorded moments, sample AI content only when policy permits it, and a line-anchored sample follow-up. Its confirmation explicitly says nothing was sent to a candidate.

All requested prices are present. Growth has monthly/per-candidate controls. Growth and Scale are labeled planned offerings: billing, SSO and ATS integrations have not been implemented or represented as shipped. No remaining-place count or customer claim was invented.

Navbar, homepage hero, demo and pricing calls to action open one native modal. It collects email, role and optional stack, with source/plan context. The server bounds actual request bytes, checks same-origin requests, validates fields and honeypot, and submits through the existing configured mail provider. Confirmation requires a nonempty provider acceptance ID. Missing configuration, failure and timeouts preserve the visitor's details and offer direct email. No automatic product access or cohort-place guarantee is issued.

The optional booking URL appears only when configured as HTTPS; otherwise a setup-chat email link is used. Privacy information covers these new fields and destinations.

## Verification

| Check                                        | Result                                                                                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product formatting, lint and typecheck       | Passed; existing lint warnings remain                                                                                                                                                                                                |
| Product full `npm run verify`                | Not green: tests reached **1,163 passed, 42 failed, 42 skipped**, across 160 files. Failures involve unavailable Docker access and operator CLI subprocess output; executor/build stages cannot be treated as passed by this command |
| Unchanged-baseline control                   | The untouched `5394d8b` worktree reproduces all four operator CLI failures and a representative Docker integration failure (five failures in the two probed files)                                                                   |
| Product focused interaction/validation tests | 65 passed across builder, candidate shell/interactions, evaluator workbench and new editorial controls before the final style pass; the final complete suite includes the same tests                                                 |
| Product production compilation               | Final normal Webpack build passed after fixing the client/server import boundary and route signature (no temporary compiler setting needed)                                                                                          |
| Marketing API/contact tests                  | 7 passed, including provider rejection/missing-ID/network-error behavior, validation, source/plan retention and policy-consistent mock data                                                                                          |
| Marketing UI tests                           | 5 passed, covering configuration, FAIL → apply fix → PASS, stack reset, line anchoring and waitlist error/success                                                                                                                    |
| Marketing formatting, lint and typecheck     | Passed                                                                                                                                                                                                                               |
| Marketing production compilation             | Final Webpack production build passed; default Turbopack build did not complete within the restricted session's 120-second limit                                                                                                     |
| Dependency lockfiles                         | Normal offline `npm ci --dry-run` succeeds for both projects                                                                                                                                                                         |
| Live preview / browser                       | Local listening sockets are denied (`EPERM`). The browser also rejects local-file preview URLs. No alternate browser or policy workaround was used                                                                                   |
| Mobile Safari / Chrome                       | Responsive layouts, native controls, 16px mobile form inputs, local code/table scrolling, reduced-motion handling and touch targets are implemented. Actual viewport, visual, focus-trap and device testing are **not verified**     |

UI tests use Framer Motion's JavaScript renderer because the virtual DOM's partial Web Animations implementation does not implement browser cancellation semantics. This does not substitute for browser animation checks. No exception handler or test assertion was weakened.

## Deployment and remaining acceptance

Configure `RESEND_API_KEY`, `CONTACT_FROM` (a verified sender) and `CONTACT_EMAIL` on the marketing host. Optionally configure `FOUNDING_SETUP_BOOKING_URL`. No secrets are included in source. The waitlist intentionally returns an unavailable state until mail delivery is configured.

Before publishing, run the normal verification and relevant integrations in an environment with Docker and the existing product services, run both production builds, and verify desktop plus 320/390/430px mobile layouts in Safari and Chrome. Check: all three demo tabs, both stacks and policies, failure/fix/rerun, timeline touch/keyboard navigation, selected code-line question, each tier's modal context, invalid/pending/error/accepted states, Escape/focus return and the configured scheduling link. Send a controlled test lead only after the owner has configured and verified the receiving mailbox.

No deployment credentials or mail settings were fabricated. This source handoff does not claim that `hirearchy.io` has changed in production.

## Final handoff

Both final `npm run build -- --webpack` commands exited 0. No temporary Next configuration remains. All changes are local; the marketing mail provider and booking destination still require the host configuration above. The final source and this verification record are retained in each implementation branch; the plan stays active for the blocked acceptance checks.
