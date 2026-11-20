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

### 1.2 Software Application Surfaces (`apps/web/public/software-ui.css`)

Loaded globally via `apps/web/app/layout.tsx` under `.software-product`:

- **Canvas (Warm Paper):** `--software-canvas: #f5efe6`
- **Elevated Surface:** `--software-surface: #ffffff`, `--software-surface-subtle: #f3ede6`, `--software-surface-note: #eee7f4`
- **Ink & Plum:** `--software-plum: #211426`, `--software-ink: #291d2c`, `--software-muted: #635661`
- **Brand Accent:** `--software-mint: #8ee3b8`, `--software-lilac: #ebe5f2`
- **Hairline Borders:** `--software-border: #ded4cc`, `--software-border-subtle: #eae1d9`, `--software-border-strong: #8b7c99`
- **Semantic Status Tokens:**
  - Success: `#166534` on `#ecfdf3` (border `#bbf7d0`)
  - Warning: `#74520a` on `#fff7df` (border `#e2c66f`)
  - Danger: `#b42318` on `#fef2f2` (border `#fecaca`)

### 1.3 Typography & Local Assets (`apps/web/public/`)

- **Primary UI Font:** Local variable **DM Sans** (`apps/web/public/fonts/dm-sans-latin.woff2`), loaded in `apps/web/app/layout.tsx` via `next/font/local` (`--font-dm-sans`). Zero external font CDN dependency at runtime.
- **Monospace Code Font:** `'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace`.
- **Icons:**
  - Inline crisp React UI icons via `@tabler/icons-react`.
  - Curated 30-icon SVG sprite set in `apps/web/public/software/icons/*.svg` (with license & SHA256SUMS manifest).

---

## 2. Core Product UI Surfaces

### 2.1 Sign in, account recovery, and workspace

The hiring team enters at `/r23/login` and candidates enter at `/candidate/login`. Each screen uses the plum canvas and a focused form, with the candidate’s invitation journey shown alongside. Authenticated workspaces preserve the same masthead and connected navigation in warm light and plum dark, including on narrow screens. Theme choice persists across screens. The entry animation respects reduced motion.

### 2.2 Assessment authoring

The builder gives the problem, candidate preview, and invitation separate stages. The problem stage lists templates, AI generation, and saved problems. The preview groups the formatted brief, repository files, and rubric. Its editor has a desktop file tree, a narrow-screen file selector, open tabs, language highlighting, and wrap and copy controls. Long paths remain readable and the code area supports keyboard scrolling.

The candidate directory places filters beside results on wide screens and above them on small screens. The candidate portal uses the Software masthead and highlights published feedback within each assessment. The reviewer can expand second opinions to inspect the conversation. The handoff gives the recipient and interview stage their own column on wide screens.

### 2.3 Candidate workspace

The brief shows the issued time limit before activation. Consent remains with the activation action. In the IDE, the toolbar shows the clock and available actions, and the sidebar holds the task and file tree. Narrow screens use a native file selector above the editor. Save, submission and read-only states are visible in the workspace.

### 2.4 Evaluator review

The summary opens with the recorded timeline. Reviewers can open the original event, submitted files, diffs, and other source evidence. The evidence inspector opens as a focused dialog on small screens. The Review tab puts the human review packet first. The optional AI Candidate Review opens from a separate disclosure with its provider, rating, rationale and recommendation identified as advisory.
