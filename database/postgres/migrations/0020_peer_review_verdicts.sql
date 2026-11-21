-- Migration 0020: Peer Review Context Snapshot & GitHub-PR-Style Review Verdicts

ALTER TABLE hirearchy.hiring_second_opinions
  ADD COLUMN IF NOT EXISTS request_context pg_catalog.jsonb NOT NULL DEFAULT '{}'::pg_catalog.jsonb
    CHECK (pg_catalog.jsonb_typeof(request_context) = 'object');

ALTER TABLE hirearchy.hiring_second_opinions
  ADD COLUMN IF NOT EXISTS verdict pg_catalog.text
    CHECK (verdict IS NULL OR verdict IN ('approve', 'comment', 'request_changes'));
