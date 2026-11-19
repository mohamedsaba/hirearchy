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

### 2.1 Auth, Email Verification & Organization Shell (`/r23/*`)

- **Seamless Account Flow:** Signup (`/r23/signup`) and login (`/r23/login`) redirect directly into email OTP verification (`/r23/verify-email`) without redundant interstitial buttons. In Founder UAT, confirmation emails are captured cleanly in loopback Mailpit and surfaced smoothly.
- **Header (`apps/web/app/evaluator/software-product-header.tsx` & `.css`):** Unified single-row top navigation pairing the `Hirearchy` wordmark, `Software` mint capsule, scoped navigation (`Sessions`, `Assessments`, `Team`, `Evidence review`), and account controls.

### 2.2 Candidate IDE Workspace (`/r26/candidate/[sessionId]`)

Implemented in `apps/web/app/r26/candidate/[sessionId]/candidate-client.tsx` and `candidate-workspace.css`:

- **Clean Cognitive Separation:** Pre-start view presents task framing, time limit, and affirmative privacy consent (`Activate assessment`) BEFORE entering the IDE so the workspace itself remains distraction-free.
- **IDE Chrome:**
  - **Left Explorer:** Hierarchical folder/file tree (`FolderOpen` / `Folder` / `FileCode` icons) + task brief drawer toggle.
  - **Top Editor Tab Bar:** Open file tabs (`aria-label="Open file tabs"`), responsive `<select aria-label="Workspace file" className="r26-file-switcher">` file switcher, save state indicator, and primary **Save work** / **Submit assessment** actions.
  - **Editor Canvas:** `@uiw/react-codemirror` with Python & JavaScript language modes, warm gutters (`#faf8f5`), active-line highlight, and generous reading line height (`1.65`).
  - **Toggleable Bottom Drawers:** Terminal Execution Console (with stdout/stderr tabs & exit code badges) and AI Coding Assistant panel.
  - **Bottom Status Bar:** Active file path, save indicator dot, compact capabilities popover, and calm countdown **Assessment timer** (`role="progressbar"`).

### 2.3 Evaluator Review Workbench (`/r27/organizations/[organizationId]/sessions/[sessionId]`)

Implemented across `apps/web/app/evaluator/sessions/[sessionId]/`:

- **Three Focused Modes (`Summary`, `Evidence`, `Review`)** inside `evaluator-review-workspace.tsx` + `task-review.css`:
  - **Platform AI Candidate Review (`ai-review-panel.tsx`):** Prominent advisory card in `Summary` and `Review` letting evaluators select **NVIDIA NIM** (`Kimi K2 / 3.1`, `Nemotron Super 120B`, `Qwen 3 235B`, or custom model slug), **OpenRouter**, or **Instant Preview**, generating:
    - Circular `0–100` AI Rating Ring
    - `Should Accept` / `Should Reject` Verdict Badge & Confidence tag
    - Executive Rationale (`Why`)
    - Diff & Chronology Metrics Strip
    - Two-column **Observed Strengths** & **Weaknesses & Verification Risks** cards.
  - **Unified GitHub-Style Code Diff & Syntax Viewer (`code-diff-viewer.tsx`):** Line-numbered additions/deletions/hunks (`+X / -Y` pills) comparing starter baseline against frozen submission and intermediate `R28` file revisions.
  - **Anchored Observations (`R29`) & Human Review Packet (`R210`)** in `evidence-workbench.tsx`.
