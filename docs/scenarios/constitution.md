# Scenario constitution

Scenarios are the core product. They must produce meaningful engineering behavior worth observing, not proxy tests disguised as real work.

## Design standard

A scenario must be easy to understand and potentially difficult to solve. Within roughly 60–90 seconds, a competent candidate should be able to explain what is broken, what should happen, and what they are being asked to investigate or fix. Root cause, edge cases, and implementation may remain unknown.

Difficulty should come from root-cause depth, competing hypotheses, consequence radius, and verification difficulty. It must not come from repository size, bad naming, obscure syntax, undocumented setup, misleading wording, trivia, or hidden puzzles.

Strong scenarios provide:

- a realistic system and obvious user or system symptom;
- clearly stated expected behavior;
- multiple plausible hypotheses and legitimate investigation paths;
- at least one natural decision fork and one organic but incomplete shallow solution;
- meaningful verification opportunities and natural AI interaction;
- observable differences between shallow and deeper work histories.

## Fairness constraints

- Do not create artificial traps or variables that exist only to mislead.
- Do not require a preferred workflow or single valid solution.
- Let incorrect paths emerge naturally from the system.
- Supply the tools, setup documentation, and initial evidence needed to begin.
- Do not reward familiarity with obscure APIs over engineering investigation.
- Allow candidates to surprise the author with valid approaches.

A scenario succeeds when it is comprehensible, realistic, fair, and produces distinguishable work histories—not when every candidate follows the author's expected path.

## Generated assessment style probe

AI-generated assessments include one visible, platform-owned `Terms and Conditions` footer with coding-style instructions. [ADR 0007](../decisions/0007-generated-assessment-llm-style-probe.md) permits this narrow exception to the artificial-trap rule because a style match is a neutral observation. The probe cannot create hidden criteria, scores, penalties, or changes to task success or hiring decisions. Evaluator-facing copy must explain that a style match cannot establish external AI use, authorship, intent, or competence.
