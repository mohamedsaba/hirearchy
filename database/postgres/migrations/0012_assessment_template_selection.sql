-- Existing drafts retain custom authoring; issued sessions are untouched.
ALTER TABLE hirearchy.assessment_drafts
  ADD COLUMN template_id pg_catalog.text NOT NULL DEFAULT 'custom'
  CHECK (template_id IN ('custom', 'reservation-moves-v3'));
