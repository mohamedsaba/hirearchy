# 0007 — Generated assessment coding-style probe

- **Status:** Accepted (2026-11-20)

## Context

The scenario constitution prohibits artificial traps. AI-generated assessments can include a visible, fixed `Terms and Conditions` footer to see whether submitted Python contains the requested naming and return patterns. Those patterns can occur naturally, and external assistants can ignore the instructions.

## Decision

Allow this footer as a narrow exception for AI-generated assessments. The platform appends the titled instructions to the task brief and validates the complete brief against the existing 5,000-character limit. The footer must fit without truncating the task text. The instructions are outside acceptance criteria, target tests, the reference solution, and the task rubric.

The live AI Candidate Review provider receives the task brief with the exact platform footer removed. The stored brief remains the source for candidate and evaluator presentation.

Treat a match as a neutral observation about visible submitted code. Evaluator-facing copy must state that the observation cannot establish external AI use, authorship, intent, or competence. The probe introduces no hidden criteria, scores, penalties, or changes to task success or hiring decisions.

## Rationale and consequences

A visible style convention can be inspected without changing what an engineering solution must accomplish. The observation belongs in evaluator presentation and stays outside immutable evidence, AI Candidate Review, and the human-authored review packet. Curated scenarios and previously stored briefs keep their existing content.
