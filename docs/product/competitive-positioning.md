# Hirearchy Software: positioning and market notes

**Status:** Working hypothesis for founder-led discovery; not validated by buyer interviews. **Sources checked:** Official product and pricing pages on 2026-11-09.

## Positioning

Hirearchy is an engineering work-sample prototype for teams that want a reviewer to inspect how a candidate's submitted work developed. A candidate works on a bounded task; the application retains saved revisions and activity; an assigned evaluator reviews the chronological evidence and writes a human-owned review. Hirearchy does not assign a candidate score or hiring outcome.

The distinction to test is the combination of saved-work evidence, source-linked observations, and a human review record. Activity recording, code playback, AI support, coding tasks, and automated assessment are already offered in various combinations by established products; those are not Hirearchy's claimed invention.

## Initial customer hypothesis

- **Team:** Product engineering group with recurring backend or platform hiring and a small number of senior reviewers.
- **Buyer:** Engineering manager, director, or technical founder who owns assessment quality and reviewer time.
- **Champion/operator:** Staff engineer or technical recruiter who prepares the task and coordinates reviewers.
- **Problem to validate:** Reviewers lack enough shared, inspectable context to discuss a candidate's work without reconstructing it themselves.
- **Initial use case:** A supervised, role-relevant work sample using the approved Reservation Moves v3 scenario.

This is a discovery hypothesis. We have no customer interviews, active pilots, usage results, testimonials, conversion data, or validated willingness to pay to report.

## Competitive context

Published prices below are public US self-service list prices checked on 2026-11-09. They use different attempt, credit, and interview meters and are not directly comparable. Prices and plans can change.

| Product         | Publicly described model                                                                                       | Published starting price checked 2026-11-09                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HackerRank      | Assessments, pair-programming interviews, AI interviewer and agentic IDE features                              | Starter: $79/month billed annually ($948/year) for 60 candidate attempts; Pro: $419/month billed annually ($5,028/year) for 360 attempts; enterprise is custom.                                               |
| CodeSignal Hire | Assessments, live interviews, agentic assessments and AI interviewers, using shared credits                    | Build: $79/month billed annually with 60 annual credits, or $99/month with 5 monthly credits; Grow: $479/month billed annually with 420 annual credits, or $599/month with 35 monthly credits; Pro is custom. |
| CoderPad        | Live coding interviews and asynchronous Screen tests, with playback and optional AI tools                      | Starter: $80/month equivalent billed annually for 60 interviews/year, or $120/month for 5/month; Team: $400/month equivalent billed annually for 360/year, or $500/month for 30/month.                        |
| TestGorilla     | Skills assessments, question library, AI interviews and job simulations on higher tiers                        | Assessments Free includes 10 monthly credits; Core starts at $215/month per account billed annually; Plus starts at $520/month billed annually.                                                               |
| Karat           | Live technical interviews led by trained Interview Engineers; separate from a self-service work-sample product | Public candidate material describes the live interview service; no comparable self-service list price is cited here.                                                                                          |

### Defensible difference to investigate

Hirearchy's product thesis is that an evaluator should be able to move from a saved revision or timeline event to a human-written observation and review without receiving a machine-generated competence verdict. Buyers may value this evidence-first review model, or may prefer the breadth, integrations, automation, AI, or live interviewing already available elsewhere. Discovery must establish which workflow matters and whether the evidence record is useful enough to adopt.

Avoid claims that competitors lack playback, lack evidence, rely only on scores, use unreliable cheating detection, or produce unfair decisions. Their published capabilities vary by product and tier. Do not claim Hirearchy is faster, more predictive, more accurate, compliant, unbiased, or more secure without independent evidence.

## Verified product boundaries for buyer conversations

- **Demonstrable now:** A local synthetic recruiter-to-candidate-to-reviewer journey in the authenticated staging profile, when its disposable integration environment is running. Reservation Moves v3 is the approved scenario.
- **Evidence:** The application can retain submitted work, saved revisions, task events, and a human review record. The evaluator owns interpretation.
- **Not enabled in the current demo:** Live candidate code execution, AI assistance/provider calls, transactional email, public signup, and external candidate activation.
- **Preview boundary:** The public product preview exposes marketing pages and early-access intake only; it is not the authenticated demo or a hosted pilot.
- **Operational boundary:** Local/CI rehearsal is not a public deployment, production security certification, privacy approval, or customer result.

## Pilot and price hypothesis

For discovery only, test a fixed-scope, supervised 30-day pilot: one team, one approved scenario, up to 10 synthetic-to-start candidate sessions, and onboarding for one recruiter plus two evaluators. An initial **US$250 total** is a hypothesis to ask about, not an offer or validated price. Hosting, support, privacy operations, accessibility, and candidate assistance costs have not been measured. Do not quote or charge this amount until the founder approves a hosted workflow, legal/privacy materials, support ownership, and a cost model.

## Official source pages

- [HackerRank Work pricing](https://www.hackerrank.com/work/pricing)
- [CodeSignal Hire pricing](https://codesignal.com/pricing/)
- [CoderPad pricing](https://coderpad.io/pricing/)
- [CoderPad Screen code playback](https://coderpad.io/resources/docs/screen/candidate-reports/code-playback/)
- [TestGorilla pricing](https://www.testgorilla.com/pricing/)
- [Karat candidate interview experience](https://karat.com/candidate-experience/)
