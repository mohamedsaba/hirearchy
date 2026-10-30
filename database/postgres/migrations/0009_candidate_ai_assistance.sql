-- Migration 0009: Candidate AI Assistance and Immutable Evidence
-- Minimal additive migration for R2.12 isolated candidate AI assistance.

-- 1. Safely update candidate_session_events check constraint to allow AI lifecycle event types.
ALTER TABLE hirearchy.candidate_session_events
  DROP CONSTRAINT IF EXISTS candidate_session_events_event_type_check;

ALTER TABLE hirearchy.candidate_session_events
  ADD CONSTRAINT candidate_session_events_event_type_check CHECK (
    event_type IN (
      'SESSION_ACTIVATED',
      'WORKSPACE_CHANGED',
      'SESSION_SUBMITTED',
      'AI_REQUEST_STARTED',
      'AI_RESPONSE_COMPLETED',
      'AI_REQUEST_FAILED'
    )
  );

-- 2. Create table hirearchy.candidate_ai_interactions.
CREATE TABLE hirearchy.candidate_ai_interactions (
  organization_id pg_catalog.uuid NOT NULL,
  session_id pg_catalog.text NOT NULL,
  interaction_id pg_catalog.text NOT NULL PRIMARY KEY CHECK (interaction_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  request_id pg_catalog.text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  sequence_start pg_catalog.int8 NOT NULL CHECK (sequence_start > 0),
  sequence_completed pg_catalog.int8 CHECK (sequence_completed IS NULL OR sequence_completed >= sequence_start),
  candidate_prompt pg_catalog.text NOT NULL CHECK (pg_catalog.char_length(candidate_prompt) <= 4000),
  assistant_response pg_catalog.text,
  status pg_catalog.text NOT NULL CHECK (status IN ('ADMITTED', 'COMPLETED', 'FAILED')),
  failure_reason pg_catalog.text,
  error_message pg_catalog.text,
  provider_id pg_catalog.text NOT NULL DEFAULT 'synthetic-test-provider',
  model_id pg_catalog.text NOT NULL DEFAULT 'synthetic-model-r212',
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  completed_at pg_catalog.timestamptz,
  UNIQUE (session_id, request_id),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES hirearchy.assessment_sessions (organization_id, id)
    ON DELETE RESTRICT,
  CHECK (
    (status = 'ADMITTED' AND completed_at IS NULL AND assistant_response IS NULL AND failure_reason IS NULL AND sequence_completed IS NULL)
    OR
    (status = 'COMPLETED' AND completed_at IS NOT NULL AND assistant_response IS NOT NULL AND failure_reason IS NULL AND sequence_completed IS NOT NULL)
    OR
    (status = 'FAILED' AND completed_at IS NOT NULL AND failure_reason IS NOT NULL AND sequence_completed IS NOT NULL)
  )
);

CREATE INDEX candidate_ai_interactions_session_seq_idx
  ON hirearchy.candidate_ai_interactions (organization_id, session_id, sequence_start);

CREATE INDEX candidate_ai_interactions_session_req_idx
  ON hirearchy.candidate_ai_interactions (session_id, request_id);

-- 3. Triggers for immutability and finality on candidate_ai_interactions.
CREATE TRIGGER candidate_ai_interactions_immutable_keys
  BEFORE UPDATE OF organization_id, session_id, interaction_id, request_id, sequence_start, candidate_prompt, created_at, provider_id, model_id
  ON hirearchy.candidate_ai_interactions
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_immutable_columns(
    'organization_id', 'session_id', 'interaction_id', 'request_id', 'sequence_start', 'candidate_prompt', 'created_at', 'provider_id', 'model_id'
  );

CREATE FUNCTION hirearchy.r212_reject_completed_ai_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF OLD.status IN ('COMPLETED', 'FAILED') THEN
    RAISE EXCEPTION 'Completed or failed AI interactions are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER candidate_ai_interactions_finality_guard
  BEFORE UPDATE ON hirearchy.candidate_ai_interactions
  FOR EACH ROW EXECUTE FUNCTION hirearchy.r212_reject_completed_ai_mutation();

CREATE FUNCTION hirearchy.r212_reject_ai_deletion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Candidate AI interactions are append-only and cannot be deleted' USING ERRCODE = '23514';
END
$function$;

CREATE TRIGGER candidate_ai_interactions_no_delete
  BEFORE DELETE ON hirearchy.candidate_ai_interactions
  FOR EACH ROW EXECUTE FUNCTION hirearchy.r212_reject_ai_deletion();

-- 4. Enable and FORCE Row Level Security on candidate_ai_interactions.
ALTER TABLE hirearchy.candidate_ai_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.candidate_ai_interactions FORCE ROW LEVEL SECURITY;

-- 5. Revoke direct access from PUBLIC and untrusted/restricted application logins.
REVOKE ALL ON TABLE hirearchy.candidate_ai_interactions
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;

REVOKE ALL ON FUNCTION hirearchy.r212_reject_completed_ai_mutation()
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;

REVOKE ALL ON FUNCTION hirearchy.r212_reject_ai_deletion()
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;

-- 6. Row Level Security policies.
-- hirearchy_migrator: permitted through security definer context when scoped.
CREATE POLICY r212_migrator_ai_interactions_select
  ON hirearchy.candidate_ai_interactions
  FOR SELECT TO hirearchy_migrator
  USING (
    (
      session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
      AND EXISTS (
        SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
        WHERE envelope.session_id = candidate_ai_interactions.session_id
          AND envelope.candidate_token_hash = NULLIF(
            pg_catalog.current_setting('r26.token_hash', true), ''
          )
      )
    )
    OR
    (
      organization_id = NULLIF(pg_catalog.current_setting('r27.organization_id', true), '')::pg_catalog.uuid
      AND session_id = NULLIF(pg_catalog.current_setting('r27.session_id', true), '')
      AND EXISTS (
        SELECT 1
        FROM hirearchy.organization_memberships AS membership
        JOIN hirearchy.reviewer_assignments AS assignment
          ON assignment.organization_id = membership.organization_id
         AND assignment.reviewer_principal_id = membership.principal_id
         AND assignment.session_id = candidate_ai_interactions.session_id
         AND assignment.revoked_at IS NULL
        JOIN hirearchy.assessment_sessions AS session
          ON session.organization_id = assignment.organization_id
         AND session.id = assignment.session_id
         AND session.status = 'SUBMITTED'
        WHERE membership.organization_id = candidate_ai_interactions.organization_id
          AND membership.principal_id = NULLIF(
            pg_catalog.current_setting('r27.principal_id', true), ''
          )::pg_catalog.uuid
          AND membership.role = 'reviewer'
          AND membership.status = 'active'
          AND membership.revoked_at IS NULL
      )
    )
    OR
    (
      pg_catalog.current_setting('r26.session_id', true) IS NULL
      AND pg_catalog.current_setting('r27.session_id', true) IS NULL
    )
  );

CREATE POLICY r212_migrator_ai_interactions_insert
  ON hirearchy.candidate_ai_interactions
  FOR INSERT TO hirearchy_migrator
  WITH CHECK (
    (
      session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
      AND EXISTS (
        SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
        WHERE envelope.session_id = candidate_ai_interactions.session_id
          AND envelope.candidate_token_hash = NULLIF(
            pg_catalog.current_setting('r26.token_hash', true), ''
          )
      )
    )
    OR
    (
      pg_catalog.current_setting('r26.session_id', true) IS NULL
    )
  );

CREATE POLICY r212_migrator_ai_interactions_update
  ON hirearchy.candidate_ai_interactions
  FOR UPDATE TO hirearchy_migrator
  USING (
    (
      session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
      AND EXISTS (
        SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
        WHERE envelope.session_id = candidate_ai_interactions.session_id
          AND envelope.candidate_token_hash = NULLIF(
            pg_catalog.current_setting('r26.token_hash', true), ''
          )
      )
    )
    OR
    (
      pg_catalog.current_setting('r26.session_id', true) IS NULL
    )
  )
  WITH CHECK (
    (
      session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
      AND EXISTS (
        SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
        WHERE envelope.session_id = candidate_ai_interactions.session_id
          AND envelope.candidate_token_hash = NULLIF(
            pg_catalog.current_setting('r26.token_hash', true), ''
          )
      )
    )
    OR
    (
      pg_catalog.current_setting('r26.session_id', true) IS NULL
    )
  );

-- app_evaluator & app_control_worker schema usage and table SELECT grants
GRANT USAGE ON SCHEMA hirearchy TO app_evaluator, app_control_worker;
GRANT SELECT ON TABLE hirearchy.candidate_ai_interactions TO app_evaluator;

CREATE POLICY r212_evaluator_ai_interactions_select
  ON hirearchy.candidate_ai_interactions
  FOR SELECT TO app_evaluator
  USING (
    EXISTS (
      SELECT 1
      FROM hirearchy.reviewer_assignments AS assignment
      JOIN hirearchy.organization_memberships AS membership
        ON membership.organization_id = assignment.organization_id
       AND membership.principal_id = assignment.reviewer_principal_id
      WHERE assignment.organization_id = candidate_ai_interactions.organization_id
        AND assignment.session_id = candidate_ai_interactions.session_id
        AND assignment.reviewer_principal_id = COALESCE(
          NULLIF(pg_catalog.current_setting('r27.principal_id', true), ''),
          NULLIF(pg_catalog.current_setting('hirearchy.evaluator_principal_id', true), '')
        )::pg_catalog.uuid
        AND assignment.revoked_at IS NULL
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
  );

-- app_control_worker: SELECT only.
GRANT SELECT ON TABLE hirearchy.candidate_ai_interactions TO app_control_worker;

CREATE POLICY r212_control_worker_ai_interactions_select
  ON hirearchy.candidate_ai_interactions
  FOR SELECT TO app_control_worker
  USING (true);

-- r23_session_owner: SELECT for reviewer evidence presentation if role exists.
DO $session_owner_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r23_session_owner') THEN
    EXECUTE 'GRANT SELECT ON TABLE hirearchy.candidate_ai_interactions TO r23_session_owner';
    EXECUTE $policy$
      CREATE POLICY r212_session_owner_ai_interactions_select
        ON hirearchy.candidate_ai_interactions
        FOR SELECT TO r23_session_owner
        USING (
          organization_id = NULLIF(
            pg_catalog.current_setting('r27.organization_id', true), ''
          )::pg_catalog.uuid
          AND session_id = NULLIF(
            pg_catalog.current_setting('r27.session_id', true), ''
          )
          AND EXISTS (
            SELECT 1
            FROM hirearchy.organization_memberships AS membership
            JOIN hirearchy.reviewer_assignments AS assignment
              ON assignment.organization_id = membership.organization_id
             AND assignment.reviewer_principal_id = membership.principal_id
             AND assignment.session_id = candidate_ai_interactions.session_id
             AND assignment.revoked_at IS NULL
            JOIN hirearchy.assessment_sessions AS session
              ON session.organization_id = assignment.organization_id
             AND session.id = assignment.session_id
             AND session.status = 'SUBMITTED'
            WHERE membership.organization_id = candidate_ai_interactions.organization_id
              AND membership.principal_id = NULLIF(
                pg_catalog.current_setting('r27.principal_id', true), ''
              )::pg_catalog.uuid
              AND membership.role = 'reviewer'
              AND membership.status = 'active'
              AND membership.revoked_at IS NULL
          )
        )
    $policy$;
  END IF;
END
$session_owner_grants$;
