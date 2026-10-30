import type { AssessmentSelection } from '../assessments/assessment-options';

type WorkKind = AssessmentSelection['workKind'];

const sharedRequirements = `Ground the scenario in code the candidate can read in the
repository it ships with. Keep it solvable inside a small Python/pytest
repository with no running services and no network access, and require no new
dependency, configuration change, or runtime change.

Open with the observable symptom, the expected behavior, and the boundary of
the change, so a competent reader can tell in about a minute what is wrong and
what is being asked. State which existing behavior must be preserved and call
out the tradeoffs the requirements imply.

Include a natural but incomplete shallow fix that an attentive reader can reach
for, and a concrete consequence of leaving the problem unfixed. This is authoring
rationale, not a prescribed solution or an instruction to plant misleading clues.
Every required behavior and material tradeoff must be visible in the brief or
README; evaluator-only hypotheses must not add hidden requirements. Adapt names
and business context to the selected domain without changing this family.

Include deterministic checks for normal, boundary and failure cases against the
declared behavior. Include README.md in starterFiles with setup instructions and
candidate-visible requirements. Require a short README
section giving changed behavior, how it was verified, and limitations or
anything left unverified. State this handoff deliverable explicitly in the
candidate-visible brief or acceptance criteria as well as the README.

If the workspace terminal is disabled, the candidate cannot run the checks; the
handoff must name the unrun checks instead of reporting results that were never
observed.

Any approach that satisfies the criteria is acceptable. Do not require a
particular workflow, tool, or prompt. Never degrade the assistant or promise an
AI-proof task. Any AI-collaboration criterion may assess recorded interactions
and their relationship to changes and verification, but must not reward prompt
length or use frequency or infer understanding, dependence or code authorship.`;

const structureGuidance: Record<WorkKind, string> = {
  incident: `Scenario family: a small order-confirmation module. A confirmation
request retried after a timeout or an ambiguous response writes a second
confirmation, and downstream effects such as a notification or a ledger entry
run twice.

Expected behavior: a retried request carrying the same client-supplied key
resolves to the confirmation that already exists rather than creating a new one,
while a genuinely new request still creates its own confirmation.

Shallow fix: catching the duplicate insert in the request handler and returning
success, which leaves the duplicate reachable through any other caller and
leaves the caller without the id of the confirmation that already exists.

Verification: a test that repeats the same confirmation with the same key and
asserts one record and one set of downstream effects, plus a test that a
distinct request still succeeds so the fix cannot be satisfied by refusing every
repeat.

Consequences: the customer is told twice, inventory is committed twice, and the
ledger double-counts until someone reconciles by hand.

Reproducible evidence: the repository ships the retry path together with a
fixture or recorded example showing the second confirmation before the change.`,

  feature: `Scenario family: a small reservation module for bookable slots.
Reservations can be created against the same slot without limit, so a slot ends
up held past its capacity.

Expected behavior: at most the configured number of active reservations per
slot, and the request that would exceed it is refused with a stated reason
rather than silently trimmed or queued.

Shallow fix: checking capacity in the request handler before delegating, which
leaves the module unguarded for direct callers. For contained scope use sequential
calls and independent slots; do not introduce an unstated concurrency requirement.
For broader scope, define and disclose a deterministic interleaving model before
requiring it; do not claim distributed durability or production thread safety.

Verification: tests at exactly the capacity boundary and one past it, and a test
that exercises the module directly rather than only through the handler.

Consequences: the business sells inventory it does not have and pays for it in
refunds and cancellations.

Reproducible evidence: the module, its configuration, and a test or fixture
showing two callers holding the same slot before the change.`,

  integration: `Scenario family: a small client for an external service whose
payload shape has changed. A recorded or stubbed upstream response ships in the
repository, and the client drops or misreads fields it used to read.

Expected behavior: payloads in both the previously supported shape and the
current shape parse into the same internal record, fields with no counterpart are
surfaced rather than dropped, and a genuinely malformed payload is rejected
instead of being parsed into a partial record.

Shallow fix: loosening the parser to accept anything, or skipping fields it does
not recognize, which also accepts the malformed payload and quietly loses the
unmapped data.

Verification: tests over the recorded payloads for both shapes, a test that an
unmapped field is reported rather than discarded, and a test that a malformed
payload still fails.

Consequences: orders are created from incomplete data and are discovered late,
when someone reconciles records by hand.

Reproducible evidence: the recorded or stubbed upstream payloads in the
repository and the parsing code they fail against.`,

  'data-processing': `Scenario family: a small repeatable file import. Running the
same input twice duplicates rows, and rows that fail to parse are either
skipped in silence or abort the whole run.

Expected behavior: re-running the same import produces the same stored result,
and each rejected row is reported with its row number and the reason it failed,
with the partial-success rule stated explicitly.

Shallow fix: deduplicating on a value that is not stable across runs, or
swallowing bad rows so the run finishes, which turns silent data loss into a
passing run.

Verification: a test that imports the same input twice and compares stored
results, and tests asserting the exact rows and reasons reported for invalid
input.

Consequences: totals double on every re-run and dropped rows are never noticed,
because nothing downstream fails.

Reproducible evidence: a small input fixture embedded in the tests or README and
the import entry point that shows duplicated rows when run twice.`,
};

export const getAssessmentStructureGuidance = (
  workKind: AssessmentSelection['workKind'],
): string => `${structureGuidance[workKind]}\n\n${sharedRequirements}`;
