# Evaluator experience

Slice 5.1 presents an evidence-first review rather than an analytics dashboard.

## Supported release review entry

The durable release path uses a normal GoTrue account, verified application session, active organization `reviewer` membership, and assignment to the submitted session. Recruiter membership does not grant evidence or review access. The organization owner invites the evaluator through the product; the evaluator signs in normally and follows assigned-session navigation. PostgreSQL enforces organization and assignment scope for evidence and human-review operations through the signed proof v2 boundary.

The global evaluator key described below belongs only to the retained legacy prototype. It must not be required or exposed in Founder UAT. [Release readiness](../release-readiness.md) records the current acceptance boundary.

## Legacy prototype review entry and discovery

`/evaluator` is the evaluator entry point. The existing single global
`HIREARCHY_EVALUATOR_KEY` produces the HTTP-only `hirearchy_evaluator` cookie; a
valid cookie is the complete current evaluator authorization scope. There is no
evaluator identity, organization, tenant, or session-specific grant.

After that same server-side authorization check, `GET /api/evaluator/sessions`
returns at most 50 reviewable submitted sessions in `submittedAt DESC, id DESC`
order. A queue item contains only session reference, scenario title, submission
time, assessment duration, and closure reason. It never returns candidate
tokens, raw evidence, diffs, events, AI content, or reconstruction payloads.
The queue includes only final `SUBMITTED` sessions with frozen submitted content,
submission timestamp, and closure reason. Direct authorized links to
`/evaluator/sessions/[sessionId]` remain valid.

The entry UI distinguishes an empty queue from invalid evaluator access and a
discovery service failure. Discovery is navigation only: it adds no assignment,
ranking, reviewer routing, notification, or evaluator verdict.

## Default hierarchy

1. Factual session context: assessment, scenario, submitted status, duration, submission time, and session reference.
2. **Overview:** immutable scenario context and material platform notices, including incomplete activity capture where present.
3. **Reconstruction:** the primary ordered evidence surface. It presents typed commands, edits, AI activity, capture gaps, submission, and recognized verification results in authoritative chronology order with source disclosure controls.
4. **Final submitted state:** the authoritative final diff against the scenario baseline, after the recorded work sequence.
5. **Source evidence:** the Engineer technical record retains complete chronology and raw-record inspection.

Telemetry counters, provider metadata, attempt identifiers, tree hashes, raw event IDs, and domain enum names are not default evaluator content. No activity-balance, cadence, AI-use, file-count, or test-count KPI is produced.

## Language rules

- Verification progression is factual and neutral: initial, later, and final recorded verification.
- Failing tests and non-zero commands do not receive candidate-quality styling.
- Reversion is described as “Changes reverted” and as a return to a previously recorded state; purpose is not inferred.
- Incomplete capture is a platform limitation, not candidate misconduct.
- Empty related-evidence areas establish only an empty relation, not global absence; useful activity may remain elsewhere in chronology.
- Truncated terminal streams visibly identify captured previews and omitted output, independently for standard output and standard error.
- Automated verification is not a hiring decision; scenario policy may require engineering review.

## State behavior

While reconstruction is pending, the page says “Preparing the session summary…” and leaves scenario context, linked evidence, and submitted changes available. On failure it says the summary is unavailable, confirms that recorded activity and submitted changes remain available, and offers `Try again`. Provider names, codes, stack traces, and attempt state are never exposed.

## Accessibility and responsive behavior

The evaluator route targets WCAG 2.2 AA. Its structure uses landmarks and ordered headings; controls are native links, buttons, and `details`/`summary` disclosures; live preparation state uses `role=status`; unavailable state uses `role=alert`; focus is visibly tokenized; and native disclosures expose their expanded state and support Enter/Space without custom keyboard code. The overview has its own heading, with scenario context and platform notices nested beneath it. The Engineer inspection controls remain native buttons in a named group; a selected chronology source remains the current view without moving keyboard focus.

Diff meaning is available through text, literal `+`/`-` prefixes, and screen-reader labels, not color alone. Code and diff surfaces scroll horizontally instead of forcing page overflow; paths, references, and ordinary metadata wrap. Layouts collapse from the Engineer two-column layout to a single reading column below `70rem`. At or above that breakpoint, the sticky inspection panel is bounded to the viewport and scrolls locally so expanded technical records remain reachable without obscuring focus. Motion is enabled only when the user has not requested reduced motion. E6 visual polish remains separate work.

## Validation status

Scenario-linked process evidence is an experimental decision-support mechanism whose incremental validity has not yet been established.

The mechanism organizes inspectable evidence; it is not a validated competency measure. Product research must separately establish whether it improves evaluator decisions beyond final-state review, and any such claim is outside Slice 5.1.

## Evaluator Briefing Foundation & Visual Experience v2

The [accepted final v2 specification](../product/evaluator-v2-design-specification.md) governs the experience; the [architecture audit](../audits/evaluator-v2-architecture-feasibility.md) governs the briefing foundation and role projections.

The production visual experience implements the complete Evaluator Experience v2 across four audience depth profiles:

- `GENERALIST_RECRUITER`: 10–20s executive summary, plain-English activity grouping, neutral verification progression, and no cryptographic hashes or raw event IDs.
- `TECHNICAL_RECRUITER`: Technical footprint, recorded tooling, chronological progression, and direct evidence disclosures.
- `ENGINEER`: Full technical workspace, authoritative diff viewer, raw command lines, execution logs, and cryptographic SHA-256 provenance.
- `ENGINEERING_MANAGER`: High-level synthesis, concise submission scope, platform limitation notices, and evaluation policy guidance.

### UI Data Flow & Epistemic Boundaries

```
AUTHORITATIVE EVIDENCE -> DETERMINISTIC RECONSTRUCTION -> SEMANTIC BRIEFING -> SERVER-FIRST ROLE PROJECTION -> FINAL UI
```

The route server component projects the requested role (`?depth=...`, with
legacy `?role=...` accepted by the page). The UI receives that projection plus
the existing authorized review presentation and evidence input needed to render
literal submitted diffs and source records. Those inputs are not a second
interpretation path: the UI does not parse raw diff, command, output, prompt,
or response text to decide role behavior or candidate meaning. It consumes
explicit projection capabilities and typed presentation data only.

### Role-depth contract

Depth is a default presentation preference, never authorization. On the legacy
prototype, its evaluator cookie authorizes the same submitted evidence independently
of `depth` or `role`; a switch neither mutates a session nor persists role state.
On the durable release path, normal identity, membership, organization, and
session-assignment checks remain mandatory regardless of presentation depth.

| Flag                     | Presentation meaning                                                                                 | Consumer                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `structuredEvidence`     | Render typed command, file, and AI source records after a source disclosure opens.                   | `RecordedActivity` / `EvidenceItemCard`                |
| `directEvidenceLinks`    | Render per-statement source-disclosure affordances. When absent, factual chronology remains visible. | `RecordedActivity`                                     |
| `technicalRecord`        | Render complete chronology and raw-record inspection.                                                | `EngineerEvidenceWorkspace` (reuses `TechnicalRecord`) |
| `scenarioReference`      | Render authored invariants, verification areas, and warnings.                                        | `TaskBrief`                                            |
| `technicalFootprint`     | Render relevant recorded paths and technical AI/activity metadata.                                   | `RecordedActivity`                                     |
| `verificationChronology` | Render typed later-edit and later-capture-gap context beside its recorded verification run.          | `RecordedActivity`                                     |
| `conciseSubmissionScope` | Keep the authoritative submitted diff behind a native disclosure.                                    | `SubmittedWork`                                        |
| `evidenceLimitations`    | Render material platform notices in overview; capture gaps always remain in chronology.              | `PlatformNotice`                                       |
| `artifactAvailability`   | Render artifact-status presentation.                                                                 | `ArtifactAvailabilityCard`                             |
| `reviewGuidance`         | Render authored, non-verdict review policy.                                                          | `ReviewGuidance`                                       |
| `aiSummary`              | Render typed AI capability/activity summary.                                                         | `CompactAiSummary`                                     |
| `aiConfiguredModel`      | Render configured/reported AI model identifiers.                                                     | AI presentation components                             |
| `aiTokenTelemetry`       | Render recorded AI token telemetry.                                                                  | `EvidenceItemCard`                                     |

`GENERALIST_RECRUITER` uses concise submission scope and limitation notices but
no direct source controls or structured source records. `TECHNICAL_RECRUITER`
uses structured source records, direct evidence, technical footprint, scenario
reference, and verification context. `ENGINEER` additionally receives the
technical record, artifact provenance, and token telemetry. `ENGINEERING_MANAGER`
retains concise scope, limitation and artifact context, and direct source
references without structured raw records. All views retain the same factual
ordering, submitted state, source references, and human decision boundary.

### Engineer evidence workspace

When `technicalRecord` is enabled, `EngineerEvidenceWorkspace` presents the
existing `RecordedActivity` chronology as the primary context with a desktop
inspection region. Selecting an existing `EvidenceCatalogEntry` reference is
ephemeral client state only (`selectedEvidenceRef` and inspection view); it
does not alter chronology, evidence, role projection, or authorization. The
inspection region reuses `EvidenceItemCard` for typed command, workspace, and
AI records, and visibly retains evidence reference, record kind, and role.

The initial inspection view reuses `SubmittedWork` and its authoritative
literal diff. A source selection replaces that view with one selected typed
record; the Technical record action reuses `TechnicalRecord`. No browser fetch,
API route, duplicate evidence model, semantic string interpretation, score, or
verdict is introduced. At narrow widths this structure remains a single column;
E5 owns further accessibility and responsive hardening, while E6 owns visual
polish.

Key architectural components:

1. `EvaluatorHeader`: Hirearchy Software branding, session reference, scenario title, submitted status badge, deterministic elapsed duration, and `RoleLensSwitcher`.
2. `RoleLensSwitcher`: Accessible server-rendered role-depth navigation (`<nav aria-label="Evaluator perspective">`) with native links and query-param preservation (`?depth=...`).
3. `PlatformNotice`: Non-alarmist callouts for platform-owned limitations (such as `workspace_capture_gap`).
4. `TaskBrief`: Immutable scenario brief, system invariants, and verification targets, with graceful fallback for legacy sessions lacking evaluation context.
5. `RecordedActivity`: The primary factual chronology, with inline typed verification results and evidence disclosures.
6. `SubmittedWork`: Authoritative diff viewer with line modification statistics and anchor navigation.
7. `ReviewGuidance`: Evaluation policy constraints that retain human evaluator
   ownership without offering a non-functional routing action.
8. `ArtifactAvailabilityCard`: Clean integrity indicators for recruiters and EM; cryptographic SHA-256 and generator versions for engineers.
9. `EngineerEvidenceWorkspace`: Engineer-only client presentation boundary for
   ephemeral evidence selection and reuse of existing factual renderers.

Scenario semantics enrich presentation only. They do not change evidence truth.
Evaluator briefings are decision-support artifacts, not candidate-quality judgments.
