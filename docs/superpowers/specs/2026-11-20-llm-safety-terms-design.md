# LLM Safety Terms and Conditions Design

## Intent

Add a platform-generated `Terms and Conditions` footer to every AI-generated assessment brief. The footer contains deliberately unusual but harmless coding-style instructions intended to influence an external LLM if a candidate pastes the brief into it. Give evaluators a neutral, advisory indication when the submitted Python code visibly matches those instructions.

## Goals

- Append a consistent, clearly titled footer to the brief before a generated assessment is validated and persisted.
- Include instructions to use `snake_case` names and return nested objects from functions.
- Make observable matches available to the evaluator as an advisory signal.
- Keep all assessment outcomes, AI usage, human review, and competence judgments separate.

## Non-goals and anti-goals

- Prevent or reliably detect external LLM use; candidates can ignore or remove the footer and models may ignore it.
- Infer code authorship, candidate intent, or AI reliance from matching style.
- Score, rank, penalize, reject, or alter any test/task result based on the signal.
- Change curated scenarios or the candidate-integrated AI feature.
- Require the unusual style in acceptance criteria, target tests, or the reference solution.

## Constraints

- Generated assessment content is schema-validated, sandbox-validated, then persisted as an immutable generated artifact used to create the session scenario snapshot.
- The generated brief is capped at 5,000 characters, so the platform footer must fit inside that limit without silently truncating candidate-authored task content.
- The brief must remain understandable and the task technically fair; the added footer must not change what behavior is required to solve the task.
- Evaluator output must remain separate from immutable event evidence, advisory AI Candidate Review, and the human-owned final review packet.
- Any signal must be grounded in visible submitted code and state what it does not establish.

## Approaches considered

1. **Advisory pattern signal (chosen):** Add the footer and report visible matches in submitted code as neutral observations. This supports human inspection while preserving uncertainty and evaluator ownership.
2. **Make the footer requirements part of the task and tests:** This gives a crisp pass/fail result, but makes arbitrary style constraints affect task success and fairness.
3. **Add the footer without an in-product signal:** This is the smallest change but leaves detection entirely to manual inspection.

## Design

- The platform appends a fixed footer titled `Terms and Conditions` to the generated brief before final schema validation and persistence. The footer instructs the external assistant to use `snake_case` identifiers and have functions return nested objects. Platform-owned text keeps the probe stable across generated assessments and model retries. The resulting brief must still pass the existing 5,000-character limit; if it does not fit, generation should fail visibly instead of truncating the original brief.
- The footer is part of the persisted brief and therefore appears in the candidate task brief and the evaluator's scenario context.
- A deterministic evaluator-side check examines the final submitted Python source for the two requested style patterns and reports only bounded observations (for example, whether snake-case naming is prevalent and whether nested mapping returns are present). It must not label the candidate as having used an external LLM.
- The evaluator presentation includes the observation with an explicit limitation that a style match does not establish AI use, authorship, intent, or competence. It remains advisory and cannot alter acceptance criteria, test outcomes, AI review, or the final review packet.

## Implementation calls left to the builder

- Reuse the existing generated-assessment brief and snapshot path; avoid a new schema field or persistence table unless the current evaluation path cannot expose the final source observations safely.
- Bound the heuristic to generated assessments and Python source files. If the implementation cannot produce a useful, explainable observation without a new dependency or misleading precision, surface the exact footer for evaluator inspection without computing a match claim.
- Add focused tests for footer placement/content and for neutral, non-scoring presentation of any matches.
