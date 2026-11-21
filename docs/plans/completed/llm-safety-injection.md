# LLM Safety Terms and Conditions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a platform-owned `Terms and Conditions` probe to generated assessment briefs and show evaluators a neutral report of matching patterns in submitted code.

**Architecture:** Append the fixed footer to each generated brief before final schema and sandbox validation, so the persisted artifact and candidate/evaluator views share the same text. Derive a presentation-only pattern observation from submitted code for generated assessments and render it in the existing R27 evaluator summary, separate from authoritative evidence, AI review, and the final review packet.

**Tech Stack:** Next.js, TypeScript, Zod, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-llm-safety-terms-design.md`

## Global Constraints

- Evidence precedes judgment; the signal describes visible source patterns only.
- Candidate AI use is neutral; never infer hidden mental state, code origin, or AI reliance.
- The evaluator owns the final review packet and hiring judgment.
- Keep the product a modular monolith and add no dependency.
- The generated brief remains at most 5,000 characters; do not silently truncate task-authored content.
- The probe does not change acceptance criteria, tests, task outcomes, scores, recommendations, or review-packet content.

## Review Focus

- A brief already at the 5,000-character limit cannot fit the footer: verify generation fails explicitly and preserves the original brief.
- Generator repair passes replace only starter or reference files: verify every persisted artifact keeps exactly one footer.
- A curated or legacy scenario may not include the probe: verify the evaluator signal is absent and does not imply no external AI use.
- Submitted code may contain one, both, or neither requested pattern: verify each is reported independently from final submitted Python source.
- Pattern matches can occur without external AI use: verify evaluator wording describes observations and limitations without an accusation or score.

---

### Task 1: Append the platform-owned footer to generated assessments

**Files:**

- Create: `apps/web/src/scenarios/generated-terms-and-conditions.ts` (pure shared footer constant)
- Modify: `apps/web/src/scenarios/generated-assessment.ts`
- Modify: `apps/web/app/api/evaluator/assessments/generate/route.ts`
- Modify: `apps/web/src/r27-evidence/ai-review.ts`
- Test: `apps/web/src/scenarios/generated-assessment.test.ts`
- Test: `tests/integration/generated-starter-repair.test.ts`
- Test: `tests/unit/r27-ai-review.test.tsx`
- Modify: `docs/scenarios/constitution.md`
- Create: `docs/decisions/0007-generated-assessment-llm-style-probe.md`

**Interfaces:**

- Produces: `GENERATED_TERMS_AND_CONDITIONS_FOOTER: string` in the pure shared module, and `appendGeneratedTermsAndConditions(assessment: GeneratedAssessment): GeneratedAssessment`, which appends one fixed footer and validates the resulting assessment against the existing schema.

- [x] **Step 1: Document the narrow scenario-probe exception**

Create ADR 0007 documenting that generated assessments may include this style probe despite the general ban on artificial traps, only because matching is a neutral observation and never changes task success or hiring outcomes. Update `docs/scenarios/constitution.md` to require evaluator-facing copy to state the limitation and prohibit hidden criteria, scores, or penalties. Keep the candidate-facing footer limited to the titled style instructions; do not disclose the probe's purpose there.

- [x] **Step 2: Write tests for the footer helper**

Add cases asserting that the footer is appended once, is titled `Terms and Conditions`, contains the `snake_case` and nested-object return instructions, leaves the original task text intact, is idempotent when generation repair reuses the assessment, and throws the existing schema validation error if the appended brief exceeds 5,000 characters. Add an integration regression asserting that generation returns a visible 422 draft validation failure before sandbox validation when the footer would exceed the limit.

- [x] **Step 3: Run the focused test and verify it fails**

Run: `npm test -- apps/web/src/scenarios/generated-assessment.test.ts tests/integration/generated-starter-repair.test.ts`
Expected: FAIL because `appendGeneratedTermsAndConditions` is not implemented.

- [x] **Step 4: Implement the footer helper and call it before sandbox validation**

Append the fixed platform-owned footer after the initial model draft parses and before the first `validateAndPersistGeneratedAssessment` call. Keep subsequent starter/reference repair objects based on that already-footed assessment. Re-validate the complete brief; never truncate it.

- [x] **Step 5: Run the focused test and verify it passes**

Run: `npm test -- apps/web/src/scenarios/generated-assessment.test.ts tests/integration/generated-starter-repair.test.ts`
Expected: PASS, including the length-boundary and idempotence cases.

- [x] **Step 6: Keep the probe out of the live AI Candidate Review prompt**

Remove the exact platform footer suffix from the scenario brief used in the live provider request. Remove exact copies from outbound candidate prompt excerpts before the 240-character limit. Preserve the recorded interactions, stored brief, and other review context. Inspect the serialized outbound request in the regression tests and run `npm test -- tests/unit/r27-ai-review.test.tsx`.

### Task 2: Show bounded pattern observations to evaluators

**Files:**

- Modify: `apps/web/src/r27-evidence/presentation.ts`
- Modify: `apps/web/app/evaluator/sessions/[sessionId]/evaluator-review-workspace.tsx`
- Test: `tests/unit/r27-evidence-presentation.test.ts`
- Test: `tests/unit/evaluator-review-workspace.test.tsx`

**Interfaces:**

- Consumes: `GENERATED_TERMS_AND_CONDITIONS_FOOTER` from `apps/web/src/scenarios/generated-terms-and-conditions.ts` and R27 submitted file comparisons from `buildR27Presentation`.
- Produces: `R27Presentation.termsPatternObservation: Readonly<{ snakeCaseIdentifierFound: boolean; nestedObjectReturnFound: boolean }> | null`, populated only when the scenario brief ends in the platform footer marker.

- [x] **Step 1: Write presentation tests for generated and non-generated scenarios**

Assert the observation is `null` for briefs without the footer, reports snake-case and nested-object return patterns independently for a generated task with matching additions, and does not report patterns found only in unchanged starter content or non-Python files.

- [x] **Step 2: Run the focused presentation test and verify it fails**

Run: `npm test -- tests/unit/r27-evidence-presentation.test.ts`
Expected: FAIL because the presentation has no `termsPatternObservation`.

- [x] **Step 3: Derive observations from submitted Python changes**

Implement bounded deterministic matching over added lines in submitted `.py` files only. Do not add a parser dependency. Keep the result `null` unless the scenario brief ends in `GENERATED_TERMS_AND_CONDITIONS_FOOTER` from the pure shared module; never treat a missing match as evidence that no external AI was used.

- [x] **Step 4: Render the advisory in the existing R27 task summary**

Show the two pattern observations in a compact section of `R27SummaryView`. Use neutral copy that says patterns were or were not observed in submitted changes and explicitly says the observation does not establish external AI use, authorship, intent, or competence. Do not add it to R27 immutable evidence, the AI review report, or R210 review-packet data.

- [x] **Step 5: Add evaluator presentation tests and run focused tests**

Assert that generated tasks render the neutral advisory, curated tasks render no probe section, and no score, verdict, or accusation copy appears. Run:

```powershell
npm test -- tests/unit/r27-evidence-presentation.test.ts tests/unit/evaluator-review-workspace.test.tsx
```

Expected: PASS for both test files.

### Task 3: Verify the complete slice

**Files:**

- Review: all files changed by Tasks 1–2.

- [x] **Step 1: Run the required repository verification gate**

Run: `npm run verify`
Result: `npm run verify` was run on the Windows checkout and stopped at Prettier with 687 warnings across the repository. The failure is consistent with the existing `core.autocrlf=true` checkout behavior reported by both task reports. Focused changed-file formatting and lint, typechecking, production build, and relevant focused tests passed as recorded in the task reports. Full-suite results match the clean baseline's 67 failing tests and three suite setup failures. Restricted executor acceptance tests could not start because the Docker Desktop Linux engine pipe was unavailable.

- [x] **Step 2: Review the branch diff and update the active plan**

Check that the change remains limited to generated briefs and the R27 evaluator presentation, the plan reflects any implementation adjustments, and no unrelated worktree files changed.

Result: the branch diff contains only the generated assessment footer, its removal from Hirearchy's live AI review provider prompt, the neutral R27 pattern advisory, related tests, and scoped decision/scenario documentation. One conservative false-negative case remains documented: ambiguous function pairing can suppress a nested-return observation. The observation is advisory and missing it does not establish absence of external AI use.

**Completion status:** Implemented and reviewed. Repository-wide verification remains limited by the Windows line-ending warnings, baseline test failures, and unavailable Docker engine described above.
