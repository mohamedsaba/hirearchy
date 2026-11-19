# Hirearchy Software

**Hirearchy Software** is an engineering-evaluation platform where candidates solve realistic debugging and engineering problems inside an authentic browser IDE while teams inspect chronological work evidence, unified code diffs, and an advisory **AI Candidate Review**.

Start with **[docs/README.md](docs/README.md)** for the complete agent and developer onboarding map.

---

## Core Product Journey

1. **Recruiter & Evaluator Onboarding (`/r23/*`)**: Sign up -> verify email OTP -> bootstrap organization -> author or customize an assessment -> assign reviewers -> issue candidate invitation links.
2. **Candidate IDE Workspace (`/r26/candidate/[sessionId]`)**: Review brief & data-capture notice -> enter a distraction-free IDE with folder tree explorer, tabbed CodeMirror editor, save checkpoints, toggleable sandboxed test runner (`packages/restricted-executor`), toggleable AI coding assistant, status bar, and countdown timer pill -> submit final work.
3. **Evaluator Evidence Workbench & AI Review (`/r27/organizations/[organizationId]/sessions/[sessionId]`)**:
   - **Platform AI Candidate Review**: One-click AI analysis backed by **NVIDIA NIM** (including Kimi K2 / 3.1, Nemotron Super 120B, Qwen 3 235B, or custom model slugs), **OpenRouter**, or offline **Evidence-Grounded Preview**—delivering a `0–100` score, `Should Accept` / `Should Reject` recommendation, `"Why"` rationale, and Strengths vs. Weaknesses.
   - **Chronological Evidence & Diffs**: GitHub-style unified diffs, intermediate save revisions (`R28`), execution runs (`R213`), anchored observations (`R29`), and human-finalized review packets (`R210`).

---

## Quickstart & Development Checks

Requirements: **Node.js >= 22**, **npm >= 10**.

```bash
# Install dependencies
npm install

# Run standard Next.js development server (workspace root)
npm run dev

# Full quality gate (Prettier, ESLint, Next/TSC typegen, Vitest, Restricted Executor, Production Build)
npm run verify
```

### Environment Configuration (`.env`)

Copy `.env.example` to `.env` and configure active keys when testing AI features:

- `NVIDIA_API_KEY`: Enables NVIDIA NIM models (`moonshotai/kimi-k2-instruct`, `nvidia/nemotron-3-super-120b-a12b`, etc.) for Candidate AI and Evaluator AI Review.
- `OPENROUTER_KEY`: Enables OpenRouter models (`google/gemini-2.5-flash`, `anthropic/claude-3.7-sonnet`, etc.).
- When API keys are absent or placeholders, the Evaluator AI Review gracefully runs in **Evidence-Grounded Preview** mode directly from captured diffs and timeline events.

### Persistent Founder UAT Runtime (PostgreSQL + GoTrue + Mailpit)

```bash
bash scripts/founder-uat-start.sh --keep-db
bash scripts/founder-uat-stop.sh
```

---

## Documentation Map

- **[Master Documentation Hub](docs/README.md)**
- **[System & Backend Architecture](docs/architecture/system-overview.md)** & **[Architecture Summary](ARCHITECTURE.md)**
- **[Frontend, UI & Common Thread Brand System](docs/design/frontend-and-brand-system.md)**
- **[Product Principles & ADRs](docs/decisions/README.md)** ([ADR 0006 — AI Candidate Review](docs/decisions/0006-ai-assisted-candidate-review.md))
- **[Scenario Design Constitution](docs/scenarios/constitution.md)**
- **[Agent Guide](AGENTS.md)**
