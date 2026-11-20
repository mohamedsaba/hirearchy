# Problems Management Design

## Intent

Recruiters should be able to save an authored engineering problem for reuse in later interviews, manage saved problems in one organization-scoped place, and start a new interview from a saved problem without coupling that interview to future edits of the saved problem.

## Goals

- Add a **Save for reuse** action to assessment authoring that stores the current problem content durably.
- Add an organization-scoped Problems page with a table, create entry point, and access to view, edit, and delete each saved problem.
- Let recruiters start authoring a new interview from a saved problem.
- Copy the selected problem's full authoring content into an independent assessment draft. Edits to that interview draft do not alter the saved problem; later edits to the saved problem do not alter the interview draft or any validated interview version.
- Preserve recruiter-only authoring access, organization boundaries, CSRF and origin checks, draft validation, and immutable validated versions.
- Keep the Next.js/PostgreSQL modular monolith and support both the authenticated application runtime and the Founder UAT/staging operation path.

## Non-goals

- Cross-organization or public problem sharing.
- Editing a saved problem in a way that mutates drafts or interview versions already created from it.
- Changing candidate workspace behavior, evidence capture, evaluation, AI review, or human review packets.
- Search, tagging, usage analytics, import/export, or problem version history beyond existing assessment draft and validated-version behavior.
- Changes to scenario design or the set of problem templates.

## Anti-goals

- A saved problem must not become evidence about a candidate or a hiring judgment.
- Reusing a problem must not make later library edits silently flow into a draft or issued interview.
- Problem management must not grant reviewers recruiter authoring powers.
- The page must remain a focused management table and detail editor, not an analytics dashboard.

## Constraints

- The authoritative guide requires evidence before judgment, recruiter/reviewer role separation, organization tenant isolation, a modular monolith, and an active implementation plan preserved under `docs/plans/` when complete.
- Assessment authoring currently stores drafts in PostgreSQL; validation creates immutable `assessment_validated_versions` snapshots. Issued candidate work is tied to those validated snapshots.
- Authenticated recruiter routes enforce verified organization sessions and CSRF/origin checks. Founder UAT/staging routes dispatch through a separate verified SQL operation layer.
- Problem library writes and reads are limited to active recruiters in the selected organization. Data must not be available to another organization.
- Persist the complete authoring unit: template identifier, title, brief, expected behavior, acceptance criteria, primary file path, starter files, duration, terminal and integrated AI settings, and rubric.
- Existing assessment validation remains authoritative after a saved problem is copied into a new interview draft.

## Approaches

1. **Organization problem library with independent copies (selected):** Store reusable problem content as organization-owned library records. Selecting a record for a new interview creates an independent assessment draft populated from that record. Library edits affect only future copies. This best fits the existing immutable validated-version boundary and the requested management CRUD surface.
2. **Shared mutable problem record:** Make interview drafts refer to a mutable shared problem record. This couples edits across interviews and requires additional synchronization and lifecycle rules. It does not match the requested independent editing behavior and is not selected.
3. **Reuse an assessment draft directly:** Treat an assessment definition/draft as both a problem-library entry and the new interview draft. This avoids a separate library concept but makes interview editing mutate the saved reusable source and muddles the draft's current single-active-builder behavior. It is not selected.

## Product behavior

### Saving a problem

- A recruiter authors or edits an assessment in the existing builder and chooses **Save for reuse**.
- The action stores the current full authoring content as a problem-library record in the recruiter's selected organization.
- Save feedback identifies success or a visible error. Saving is not a substitute for the existing Save Draft or Validate actions.
- The library record is mutable through the management experience; validated assessment versions remain immutable.

### Reusing a problem

- The existing **Create assessment** flow offers an option to start from a saved problem.
- The recruiter selects a library record. The application creates a new assessment definition/draft whose authoring content is copied from the selected problem.
- The resulting draft follows the normal edit, save, validate, and issue path. The library record and resulting draft have independent lifecycles after the copy.
- The candidate session is still issued only from a validated version, as it is today.

### Managing problems

- A recruiter can open an organization-scoped Problems page.
- The table lists saved problems and enough identifying metadata to select one; selecting a row opens its management detail page.
- The detail page displays the saved problem content and allows viewing and editing it.
- A recruiter can delete a saved library record. Deletion removes only the library record; independent assessment drafts and immutable validated versions created earlier remain intact.
- The Problems page exposes a clear create path back to authoring so a newly authored problem can be saved into the library.

### Access and consistency

- Only active recruiters in the selected organization can list, view, create, edit, delete, or reuse library records.
- Reject cross-organization identifiers and malformed content at the server boundary; reuse still passes through existing assessment draft validation before validation/issuance.
- Handle concurrent edits with an explicit conflict response rather than silently overwriting a newer library record.
- Keep API responses private and non-cacheable, following current assessment authoring endpoints.

## Design sketch

```text
Organization workspace
  ├─ Create assessment
  │    ├─ Start blank / existing template
  │    ├─ Start from saved problem ──> copy into new assessment draft
  │    └─ Save for reuse ────────────> organization problem library
  └─ Problems
       └─ table row ──> problem detail ──> view / edit / delete library record

Saved library record  ──copy──> assessment draft ──validate──> immutable version ──issue──> interview
        edits affect future copies only          later stages remain unchanged
```

## Implementation choices left to the builder

- Follow the existing route, styling, Postgres adapter, migration, and staging SQL patterns. Prefer focused library contracts and persistence methods rather than adding a general content-management framework.
- Use a separate organization-scoped library table or equivalent normalized durable record; do not overload candidate evidence tables or make a mutable validated version.
- Reuse should create a new assessment definition/draft instead of overwriting the currently open or latest draft.
- Apply the same role and tenant authorization constraints in normal and staging runtimes.
- Add a concise ADR for the distinction between mutable reusable problems and immutable validated interview versions.
- Add regression coverage for tenant isolation, role checks, save/edit/delete, copied reuse independence, and unchanged validated-version behavior, following repository conventions.

## Approval state

The user approved this design on 2026-11-20. [ADR 0007](../../decisions/0007-reusable-problem-library.md) records the independent-copy decision. The [completed implementation plan](../../plans/completed/problems-management.md) records delivery and pending verification.
