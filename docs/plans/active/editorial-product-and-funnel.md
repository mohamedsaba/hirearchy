# Editorial product UI and early-access funnel

Started: 2026-11-17. Source: latest merged product `5394d8b`; landing current working files preserved separately at `6ed099d`.

## Audit

- Product is a Next.js modular monolith. Shared product tokens live in `apps/web/public/software-ui.css`; route-local CSS covers the assessment builder, evaluator workbench and candidate workspace.
- Supported durable paths are R23 authoring, R26 candidate workspace and R27 evaluator evidence. Legacy evaluator/candidate paths also remain in source. Both must share the visual vocabulary; presentation must not enable gated execution or AI.
- Existing authoring already supports stack/work-kind selections; existing chronological source models and clarification workflows must remain authoritative.
- Marketing is a separate Next.js repository at `~/Hirearchy-landing`, with six editorial homepage chapters and a philosophy-only software page. Current uncommitted changes are preserved in the isolated landing worktree. Its contact endpoint supports bounded, same-origin, validated Resend delivery and explicit unavailable states.
- Neither project currently uses Tailwind or Framer Motion. Add only these requested presentation dependencies and Tailwind's PostCSS integration.

## Scope and decisions

1. Standardize deep plum, elevated plum, cream, mint and coral semantic tokens; retain accessible contrast, neutral AI language and explicit test outcomes.
2. Add custom Tailwind/Framer Motion controls, prominent candidate-facing AI policy, stack/work-kind pills, shared-element tabs and a chronological scrubber driven by existing sources. Preserve all authorization, lifecycle and capture boundaries.
3. Add an illustrative, no-auth marketing sandbox: configuration, workspace with explicit apply-fix/test progression, chronological source inspection, and line-anchored sample questions. Demo interactions stay in browser memory and never touch candidate APIs.
4. Add supplied pilot pricing and proposed Growth/Scale pricing. Label future paid features as planned early-access offerings rather than shipped capabilities. Do not implement billing, SSO or ATS integrations.
5. Route navbar, hero, demo and tier CTAs through one accessible waitlist dialog. Collect work email, role and optional stack; include source/tier context. Submit through a dedicated validated endpoint using existing mail configuration. Success requires provider acceptance; absent configuration must preserve input and offer direct contact. Optional scheduling appears only with a configured HTTPS booking URL. Do not manufacture instant product access or remaining-place counts.
6. Preserve the six-chapter homepage identity; embed tangible software proof and expose demo/pricing/early-access links. Document exactly what is required to deploy the funnel.

## Acceptance and verification

- [x] Product tokens, authoring and candidate workspace implemented, including durable routes.
- [x] Evaluator chronology remains ordered and inspectable; no candidate scores or AI judgment.
- [x] Three demo steps and policy/stack consistency covered by interaction tests; actual device QA remains open.
- [x] Follow-up question attaches to selected file/line; sample sent state explicitly says it is local.
- [x] Pricing/CTAs, native dialog, validation, pending/error/success and configured booking implemented and behavior tested.
- [ ] Product `npm run verify` and relevant integrations pass; landing verify passes.
- [ ] Desktop/mobile layout, focus, reduced motion, touch controls and overflow inspected. State browser-engine verification limits honestly.
- [ ] Final audit, changes, checks and deployment configuration recorded; move plan to completed when done.

## Workspace safety

Original product `.git` and the landing directory are read-only in this session. Implementation uses isolated worktrees backed by local bare clones under `Hirearchy/.worktrees/`. Original files and dirty changes remain untouched. Changes can be reviewed and integrated from these branches; no reset, stash, force push or destructive cleanup is permitted. The owner explicitly authorized publishing the landing changes through its GitHub repository to Cloudflare on 17 November 2026.

## Implementation result

Both phases are implemented. See `docs/verification/editorial-product-and-funnel.md` for the audit, behavior boundaries, checks and precise blockers. This plan remains active because full product verification and actual mobile browser acceptance cannot be completed in the restricted session. Original work is preserved; no production deployment was performed.

## Publishing follow-through

The owner confirmed Cloudflare automatically deploys the landing repository after a push. The signed-in GitHub web session can write `mohamedsaba/Hirearchy-landing`; the API integration has a different installation scope. The complete release is being staged on `codex/editorial-demo-funnel-20261117` before one production merge. Cloudflare dashboard sign-in and production mail configuration have not yet been verified.
