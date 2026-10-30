-- Migration 0010: Candidate Execution Requests and Immutable Evidence
-- Minimal additive migration for R2.13 candidate execution requests and evidence.

-- 1. Safely update candidate_session_events check constraint to allow execution lifecycle event types.
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
      'AI_REQUEST_FAILED',
      'EXECUTION_REQUESTED',
      'EXECUTION_COMPLETED',
      'EXECUTION_FAILED'
    )
  );

-- 2. Create table hirearchy.candidate_execution_operations.
CREATE TABLE hirearchy.candidate_execution_operations (
  organization_id pg_catalog.uuid NOT NULL,
  session_id pg_catalog.text NOT NULL,
  operation_id pg_catalog.text NOT NULL PRIMARY KEY CHECK (operation_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  request_id pg_catalog.text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  sequence_start pg_catalog.int8 NOT NULL CHECK (sequence_start > 0),
  sequence_completed pg_catalog.int8 CHECK (sequence_completed IS NULL OR sequence_completed >= sequence_start),
  workspace_digest pg_catalog.text NOT NULL CHECK (workspace_digest ~ '^[0-9a-f]{64}$'),
  workspace_version pg_catalog.int8 NOT NULL CHECK (workspace_version >= 0),
  recipe_id pg_catalog.text NOT NULL CHECK (recipe_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  recipe_version pg_catalog.text NOT NULL CHECK (recipe_version ~ '^[A-Za-z0-9._-]{1,32}$'),
  recipe_digest pg_catalog.text NOT NULL CHECK (recipe_digest ~ '^[0-9a-f]{64}$'),
  generation pg_catalog.int4 NOT NULL DEFAULT 1 CHECK (generation > 0),
  fence pg_catalog.int8 NOT NULL CHECK (fence > 0),
  status pg_catalog.text NOT NULL CHECK (status IN ('ADMITTED', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'UNKNOWN')),
  exit_code pg_catalog.int4,
  stdout pg_catalog.text,
  stderr pg_catalog.text,
  stdout_digest pg_catalog.text CHECK (stdout_digest IS NULL OR stdout_digest ~ '^[0-9a-f]{64}$'),
  stderr_digest pg_catalog.text CHECK (stderr_digest IS NULL OR stderr_digest ~ '^[0-9a-f]{64}$'),
  truncated_stdout boolean NOT NULL DEFAULT false,
  truncated_stderr boolean NOT NULL DEFAULT false,
  duration_ms pg_catalog.int4 CHECK (duration_ms IS NULL OR duration_ms >= 0),
  failure_reason pg_catalog.text,
  error_message pg_catalog.text,
  cleanup_status pg_catalog.text NOT NULL DEFAULT 'CLEAN' CHECK (cleanup_status IN ('CLEAN', 'RESOURCE_LEAK', 'UNKNOWN')),
  is_unknown boolean NOT NULL DEFAULT false,
  provenance pg_catalog.text NOT NULL DEFAULT 'synthetic-execution-adapter',
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  completed_at pg_catalog.timestamptz,
  UNIQUE (session_id, request_id),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES hirearchy.assessment_sessions (organization_id, id)
    ON DELETE RESTRICT,
  CHECK (
    (status = 'ADMITTED' AND completed_at IS NULL AND sequence_completed IS NULL AND exit_code IS NULL AND failure_reason IS NULL)
    OR
    (status = 'COMPLETED' AND completed_at IS NOT NULL AND sequence_completed IS NOT NULL AND exit_code IS NOT NULL AND failure_reason IS NULL)
    OR
    (status IN ('FAILED', 'TIMED_OUT', 'UNKNOWN') AND completed_at IS NOT NULL AND sequence_completed IS NOT NULL AND failure_reason IS NOT NULL)
  )
);

CREATE INDEX candidate_execution_operations_session_seq_idx
  ON hirearchy.candidate_execution_operations (organization_id, session_id, sequence_start);

CREATE INDEX candidate_execution_operations_session_req_idx
  ON hirearchy.candidate_execution_operations (session_id, request_id);

-- 3. Triggers for immutability, finality, and append-only semantics.
CREATE TRIGGER candidate_execution_operations_immutable_keys
  BEFORE UPDATE OF organization_id, session_id, operation_id, request_id, sequence_start, workspace_digest, workspace_version, recipe_id, recipe_version, recipe_digest, generation, fence, provenance, created_at
  ON hirearchy.candidate_execution_operations
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_immutable_columns(
    'organization_id', 'session_id', 'operation_id', 'request_id', 'sequence_start', 'workspace_digest', 'workspace_version', 'recipe_id', 'recipe_version', 'recipe_digest', 'generation', 'fence', 'provenance', 'created_at'
  );

CREATE FUNCTION hirearchy.r213_reject_final_execution_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF OLD.status IN ('COMPLETED', 'FAILED', 'TIMED_OUT', 'UNKNOWN') THEN
    RAISE EXCEPTION 'Completed or final execution operations are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER candidate_execution_operations_finality_guard
  BEFORE UPDATE ON hirearchy.candidate_execution_operations
  FOR EACH ROW EXECUTE FUNCTION hirearchy.r213_reject_final_execution_mutation();

CREATE FUNCTION hirearchy.r213_reject_execution_deletion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Candidate execution operations are append-only and cannot be deleted' USING ERRCODE = '23514';
END
$function$;

CREATE TRIGGER candidate_execution_operations_no_delete
  BEFORE DELETE ON hirearchy.candidate_execution_operations
  FOR EACH ROW EXECUTE FUNCTION hirearchy.r213_reject_execution_deletion();

-- 4. Enable and FORCE Row Level Security on candidate_execution_operations.
ALTER TABLE hirearchy.candidate_execution_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.candidate_execution_operations FORCE ROW LEVEL SECURITY;

-- 5. Revoke direct access from PUBLIC and untrusted application logins.
REVOKE ALL ON TABLE hirearchy.candidate_execution_operations
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;

REVOKE ALL ON FUNCTION hirearchy.r213_reject_final_execution_mutation()
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;

REVOKE ALL ON FUNCTION hirearchy.r213_reject_execution_deletion()
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;

-- 6. Row Level Security policies.
CREATE POLICY r213_migrator_execution_select
  ON hirearchy.candidate_execution_operations
  FOR SELECT TO hirearchy_migrator
  USING (
    (
      session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
      AND EXISTS (
        SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
        WHERE envelope.session_id = candidate_execution_operations.session_id
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
         AND assignment.session_id = candidate_execution_operations.session_id
         AND assignment.revoked_at IS NULL
        JOIN hirearchy.assessment_sessions AS session
          ON session.organization_id = assignment.organization_id
         AND session.id = assignment.session_id
         AND session.status = 'SUBMITTED'
        WHERE membership.organization_id = candidate_execution_operations.organization_id
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

CREATE POLICY r213_migrator_execution_insert
  ON hirearchy.candidate_execution_operations
  FOR INSERT TO hirearchy_migrator
  WITH CHECK (
    (
      session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
      AND EXISTS (
        SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
        WHERE envelope.session_id = candidate_execution_operations.session_id
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

CREATE POLICY r213_migrator_execution_update
  ON hirearchy.candidate_execution_operations
  FOR UPDATE TO hirearchy_migrator
  USING (
    (
      session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
      AND EXISTS (
        SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
        WHERE envelope.session_id = candidate_execution_operations.session_id
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
        WHERE envelope.session_id = candidate_execution_operations.session_id
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

-- app_evaluator & app_control_worker permissions
GRANT USAGE ON SCHEMA hirearchy TO app_evaluator, app_control_worker;
GRANT SELECT ON TABLE hirearchy.candidate_execution_operations TO app_evaluator;

CREATE POLICY r213_evaluator_execution_select
  ON hirearchy.candidate_execution_operations
  FOR SELECT TO app_evaluator
  USING (
    EXISTS (
      SELECT 1
      FROM hirearchy.reviewer_assignments AS assignment
      JOIN hirearchy.organization_memberships AS membership
        ON membership.organization_id = assignment.organization_id
       AND membership.principal_id = assignment.reviewer_principal_id
      JOIN hirearchy.assessment_sessions AS session
        ON session.organization_id = assignment.organization_id
       AND session.id = assignment.session_id
       AND session.status = 'SUBMITTED'
      WHERE assignment.organization_id = candidate_execution_operations.organization_id
        AND assignment.session_id = candidate_execution_operations.session_id
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

-- app_control_worker: SELECT only
GRANT SELECT ON TABLE hirearchy.candidate_execution_operations TO app_control_worker;

CREATE POLICY r213_control_worker_execution_select
  ON hirearchy.candidate_execution_operations
  FOR SELECT TO app_control_worker
  USING (true);

-- r23_session_owner: SELECT for reviewer evidence presentation if role exists
DO $session_owner_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r23_session_owner') THEN
    EXECUTE 'GRANT SELECT ON TABLE hirearchy.candidate_execution_operations TO r23_session_owner';
    EXECUTE $policy$
      CREATE POLICY r213_session_owner_execution_select
        ON hirearchy.candidate_execution_operations
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
             AND assignment.session_id = candidate_execution_operations.session_id
             AND assignment.revoked_at IS NULL
            JOIN hirearchy.assessment_sessions AS session
              ON session.organization_id = assignment.organization_id
             AND session.id = assignment.session_id
             AND session.status = 'SUBMITTED'
            WHERE membership.organization_id = candidate_execution_operations.organization_id
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
