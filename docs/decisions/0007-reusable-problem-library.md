# 0007 — Reusable problem library

**Status** Accepted (2026-11-20)

## Context

Recruiters need to save a complete engineering problem and use it to start another assessment. A saved problem may change as recruiters refine it. Each assessment still needs its own editable draft and an immutable validated version that determines the candidate’s task.

## Decision

Store mutable reusable problems in the selected organization’s PostgreSQL library. Only active recruiters in that organization can list, view, create, edit, delete, or reuse its records.

Each record stores the template identifier, title, brief, expected behavior, acceptance criteria, primary file path, starter files, duration, terminal and integrated AI settings, and rubric. **Save for reuse** captures the current authoring content from the assessment builder. Recruiters can view, edit, and delete saved entries on the organization’s **Problems** pages. Updates and deletions use the library record’s version to detect concurrent changes.

**Start from saved problem** copies the selected entry’s full authoring content into a new assessment definition and draft. The builder opens that draft by its new definition ID. The library record and draft have independent lifecycles after the copy. The existing assessment validation flow creates an immutable version, and candidate sessions can only be issued from a validated version.

The authenticated application and the Founder UAT/staging dispatch path enforce the same role and organization boundaries within the Next.js and PostgreSQL modular monolith.

## Rationale

Independent copies let recruiters tailor an interview and maintain the team’s source problem on separate schedules. The existing validation and issuance flow provides a stable record of the task each candidate received.

## Consequences

- Library edits apply to future copies. Existing drafts, validated versions, and issued sessions retain their own content after a library edit or deletion.
- Recruiters can save an assessment’s current authoring content for reuse and complete draft validation separately.
- The library is an authoring surface. Candidate evidence and human review packets continue to come from the issued session and its recorded activity.
