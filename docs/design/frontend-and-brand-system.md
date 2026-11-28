# Frontend, UI & Common Thread Brand System

Hirearchy shares a cohesive visual language—internally named **Common Thread**—across its public brand surfaces (`hirearchy.io` / `/`, `/products/software`), authenticated organization shell, evaluator workbench, and candidate workspace.

---

## 1. Visual Identity & Design Tokens

### 1.1 Marketing & Brand Surfaces (`apps/web/app/home.css`)

Scoped under `.ct-site` and `.ct-site-controls`:

- **Plum (Primary Dark):** `--ct-plum: #291e36`
- **Lilac (Soft Lavender Surface):** `--ct-lilac: #ebe5f2`
- **Mint (Software Product Family Accent):** `--ct-mint: #b0f0ce`
- **Coral (IT Accent):** `--ct-coral: #ff9b88`
- **Purple (Marketing Accent):** `--ct-purple: #bb98f4`
- **Ink / Muted:** `--ct-ink: #251a35`, `--ct-muted: #625871`

### 1.2 Software Application Surfaces (`apps/web/public/software-ui.css` — Common Thread 2.0)

Loaded globally via `apps/web/app/layout.tsx` under `.software-product` (and `html[data-theme='dark']` for dark mode):

- **Brand & Ink:** `--software-plum: #211426`, `--software-brand-plum: #291e36`, `--software-ink: #1c1521` (dark `#f4efe8`), `--software-muted: #65596e` (dark `#aca0b8`), `--software-mint: #8ee3b8`, `--software-mint-bright: #b0f0ce`, `--software-lilac: #ebe5f2` (dark `#271d33`).
- **5-Step Elevation Ladder (Light Warm Paper → Dark Plum Void):**
  1. Recessed / Sidebar: `--software-canvas-recessed` (`#ede6dc` / `#0f0a15`), `--software-sidebar-bg` (`#eee7de` / `#100b16`)
  2. Base Canvas: `--software-canvas` (`#f5efe6` / `#140f1a`)
  3. Subtle Strip: `--software-surface-subtle` (`#efe9e0` / `#17111f`)
  4. Primary Surface / Card: `--software-surface-1` / `--software-surface` (`#fcfaf7` / `#1c1524`), paired with `--software-surface-2` (`#f3edf6` / `#231a2e`)
  5. Elevated Popover / Modal: `--software-surface-elevated` (`#ffffff` / `#291f36`)
- **Optical Borders, Specular Edge & Glass Headers:** 1px luminance borders (`--software-border-subtle`, `--software-border`, `--software-border-strong`), inner top-edge rim highlights (`--software-highlight-edge`, `--software-highlight-edge-strong`), layered contact/ambient shadows (`--software-shadow-xs`, `--software-shadow-card`, `--software-shadow-elevated`), and translucent sticky headers (`--software-header-bg` + `--software-header-blur`).
- **Motion Physics & Duration Ladder:** `--motion-spring` (`linear(...)` with cubic-bezier fallback), `--motion-snappy`, `--motion-gentle`, `--motion-brand-sweep`; durations `--duration-instant` (`90ms`), `--duration-fast` (`140ms`), `--duration-standard` (`180ms`), `--duration-reveal` (`240ms`), `--duration-slow` (`360ms`). All transitions/animations collapse cleanly under `@media (prefers-reduced-motion: reduce)`.
- **Semantic Status Tokens:** `--software-status-{info,success,warning,danger}` paired with `-surface` and `-border` tokens in both light and dark modes.

### 1.3 Typography & Local Assets (`apps/web/public/`)

- **Primary UI Font:** Local variable **DM Sans** (`apps/web/public/fonts/dm-sans-latin.woff2`), loaded in `apps/web/app/layout.tsx` via `next/font/local` (`--font-dm-sans`). Zero external font CDN dependency at runtime.
- **Editorial Display Font:** Local variable **Newsreader** (`apps/web/public/fonts/newsreader-latin.woff2`, `--font-newsreader`) for `h1` editorial headings.
- **Monospace Code Font:** Local **JetBrains Mono** (`apps/web/public/fonts/jetbrains-mono-latin.woff2`, `--font-jetbrains-mono`) with `tabular-nums` enforced on metrics, timers, tables, and `<kbd>` keycaps.
- **Icons:**
  - Inline crisp React UI icons via `@tabler/icons-react`.
  - Curated 30-icon SVG sprite set in `apps/web/public/software/icons/*.svg` (with license & SHA256SUMS manifest).

### 1.4 AI Thinking & Streaming Primitives (`apps/web/app/_components/ai/`)

- `CommonThreadSpark`: Geometric three-node weave starburst (`compact` 16px or 28px) with calm completion settle (`active` → `completing` mint check → `idle`).
- `HirearchyAiThinking`: Indeterminate thinking indicator supporting `studio` (assessment generation), `inline` (assistant chat), and `advisory` (evaluator synthesis with explicit `Advisory only` badge per `ADR 0006`) variants, optional visual elapsed timer, and `active` / `completing` / `error` states.
- `AiStreamingBubble`: Assistant chat bubble combining `thinking`, capped `<= 900ms` word-snapped progressive reveal (`animateReveal`, instant when `prefers-reduced-motion` matches), optional context disclosure, and neutral error reporting.
- `AiReasoningDisclosure`: CSS grid `0fr -> 1fr` collapsible trace disclosure for recorded candidate AI context (`Recorded`) or advisory synthesis traces (`Advisory synthesis`), with optional settled duration pill.

### 1.5 Loading Choreography & Micro-Interaction Kit (`apps/web/app/_components/`)

- `RouteProgressBar`: Mounted globally in `apps/web/app/layout.tsx`; 2.5px top-edge mint transition bar with a 140ms visibility delay so fast prefetched routes never flash.
- `BrandToastViewport` & `emitToast`: Global toast region (`max 3`, hover-pause auto-dismiss, polite `aria-live`) replacing scattered inline alert banners for transient confirmations.
- `CopyActionButton`: Tactile copy trigger with spring `IconCopy` → `IconCheck` morph, `aria-live="polite"` announcement, and optional `emitToast` confirmation.
- `SkeletonBlock`, `SkeletonText`, `WorkspaceSkeletonShell`, & `EvaluatorWorkbenchSkeleton`: GPU-composited staggered shimmer primitives powering layout-matched `loading.tsx` skeletons across workspace, candidate, evaluator, demo, and dossier routes.
- `SmoothDisclosure`, `KbdHint`, & `useSlidingIndicator` (`apps/web/src/ui/use-sliding-indicator.ts`): Shared `0fr -> 1fr` accordion primitive, JetBrains Mono shortcut badges, and sliding tab indicator hook.

---

## 2. Core Product UI Surfaces

### 2.1 Sign in, account recovery, and workspace

The hiring team enters at `/r23/login` and candidates enter at `/candidate/login`. Each screen uses the plum canvas and a focused form, with the candidate’s invitation journey shown alongside. Authenticated workspaces preserve the same masthead and connected navigation in warm light and plum dark, including on narrow screens. Theme choice persists across screens. The entry animation respects reduced motion.

### 2.2 Assessment authoring

The builder gives the problem, candidate preview, and invitation separate stages. On desktop, a sticky rail shows those steps and gives drafts their own controls. The problem stage leads with templates, AI generation, and saved problems. Preview groups template settings, the brief, repository files, and the rubric. After issuance, a confirmation replaces the form and groups the recipient, expiry, and sharing actions. The preview editor has a desktop file tree, a narrow-screen file selector, open tabs, language highlighting, and wrap and copy controls.

The candidate directory is the team landing page. Ready submissions lead each candidate's assessment list, with a shortcut to the review stage alongside search and filters. The desktop workspace navigation keeps organization and account details separate from page links. It uses a labeled, expandable rail at intermediate widths. Candidates, Builder, and Handoffs display layout-matched placeholders inside the authenticated shell as the page data loads. The candidate portal uses the Software masthead and highlights published feedback within each assessment. Evaluator review gives the code room beside a compact file list and distinguishes missing test evidence from known runner availability. The reviewer can expand second opinions to inspect the conversation. The handoff gives the recipient and interview stage their own column on wide screens.

New assessments get their own browser draft. The builder can reopen earlier drafts and groups saved versions of a platform problem under one heading. A candidate directory stage filter shows the matching assessments first, with other assessments available on demand. The publish summary reuses the candidate portal's outcome view. Workspace owners and CTOs manage team members, invitations and the workspace name in Organization. Every team member has a personal account page for their display name, photo and sign-in details. Upgrade compares plans and candidate-slot add-ons. Owners and CTOs on Ultra access the comparison from Manage plan in Organization. Local plan and slot changes show a preview before confirmation.

### 2.3 Candidate workspace

The readiness screen shows the issued time limit and workspace capabilities, with the consent checkbox beside the activation action. The portal opens submitted files in a separate read-only view. In the IDE, the toolbar shows the clock and available actions. The task introduction leads into the checklist, which is also available in a compact editor reference. The assistant opens on demand. Narrow screens use a native file selector above the editor and separate views for the task, editor, and available tools. Save, submission, and read-only states are visible in the workspace.

### 2.4 Evaluator review

The desktop review opens with the task brief, acceptance criteria, recorded activity, and a submission rail. Code and tests give the source list one compact rail, with file evidence opening beside the code. Opening or closing file evidence keeps the active file and restores the disclosure trigger's focus on close. The Decision tab pairs the human-owned decision form with the candidate portal preview and a visible publish bar. Private notes and the AI advisory stay outside the candidate preview.

Review interactions use the shared Software plum, warm paper, lilac, and mint tokens. A 150 ms control transition and 230 ms disclosure transition signal selection and expansion. Reduced motion disables those transitions while keeping focus and selection visible.
