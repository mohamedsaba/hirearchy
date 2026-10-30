CREATE TABLE hirearchy.candidate_token_storage_meta (
  slot integer PRIMARY KEY CHECK (slot = 1),
  version integer NOT NULL,
  database_id text NOT NULL,
  key_check text NOT NULL
);

ALTER TABLE hirearchy.assessment_sessions
  ADD COLUMN IF NOT EXISTS scenario_snapshot text,
  ADD COLUMN IF NOT EXISTS terminal_enabled boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS task_rubric_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS ai_capability_snapshot jsonb;

DROP TRIGGER IF EXISTS assessment_sessions_immutable_keys ON hirearchy.assessment_sessions;
CREATE TRIGGER assessment_sessions_immutable_keys
  BEFORE UPDATE OF id, organization_id, issuer_principal_id, scenario_id, scenario_version, scenario_title, created_at, duration_seconds, scenario_snapshot, terminal_enabled, task_rubric_snapshot, ai_capability_snapshot
  ON hirearchy.assessment_sessions
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_immutable_columns(
    'id', 'organization_id', 'issuer_principal_id', 'scenario_id', 'scenario_version', 'scenario_title', 'created_at', 'duration_seconds', 'scenario_snapshot', 'terminal_enabled', 'task_rubric_snapshot', 'ai_capability_snapshot'
  );

CREATE TABLE hirearchy.candidate_token_envelopes (
  organization_id uuid NOT NULL,
  session_id text PRIMARY KEY,
  candidate_token_hash text NOT NULL UNIQUE,
  candidate_token_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES hirearchy.assessment_sessions (organization_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX candidate_token_envelopes_org_session_idx
  ON hirearchy.candidate_token_envelopes (organization_id, session_id);

CREATE TRIGGER candidate_token_envelopes_immutable_keys
  BEFORE UPDATE OF organization_id, session_id, candidate_token_hash, candidate_token_ciphertext, created_at
  ON hirearchy.candidate_token_envelopes
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_immutable_columns(
    'organization_id', 'session_id', 'candidate_token_hash', 'candidate_token_ciphertext', 'created_at'
  );

CREATE TABLE hirearchy.assessment_issuances (
  organization_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  session_id text NOT NULL,
  issuer_principal_id uuid NOT NULL,
  request_hash text NOT NULL,
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES hirearchy.assessment_sessions (organization_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, issuer_principal_id)
    REFERENCES hirearchy.organization_memberships (organization_id, principal_id)
    ON DELETE RESTRICT
);

CREATE INDEX assessment_issuances_org_session_idx
  ON hirearchy.assessment_issuances (organization_id, session_id);

CREATE TRIGGER assessment_issuances_immutable_keys
  BEFORE UPDATE OF organization_id, idempotency_key, session_id, issuer_principal_id, request_hash, payload_hash, created_at
  ON hirearchy.assessment_issuances
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_immutable_columns(
    'organization_id', 'idempotency_key', 'session_id', 'issuer_principal_id', 'request_hash', 'payload_hash', 'created_at'
  );

ALTER TABLE hirearchy.candidate_token_storage_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.candidate_token_storage_meta FORCE ROW LEVEL SECURITY;

ALTER TABLE hirearchy.candidate_token_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.candidate_token_envelopes FORCE ROW LEVEL SECURITY;

ALTER TABLE hirearchy.assessment_issuances ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.assessment_issuances FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE hirearchy.candidate_token_storage_meta FROM PUBLIC;
REVOKE ALL ON TABLE hirearchy.candidate_token_storage_meta FROM app_evaluator, app_candidate_gateway, app_control_worker;

REVOKE ALL ON TABLE hirearchy.candidate_token_envelopes FROM PUBLIC;
REVOKE ALL ON TABLE hirearchy.candidate_token_envelopes FROM app_evaluator, app_candidate_gateway, app_control_worker;

REVOKE ALL ON TABLE hirearchy.assessment_issuances FROM PUBLIC;
REVOKE ALL ON TABLE hirearchy.assessment_issuances FROM app_evaluator, app_candidate_gateway, app_control_worker;
