ALTER TABLE hirearchy.assessment_sessions
  ADD COLUMN scenario_id text NOT NULL DEFAULT 'scenario-002-booking-notification-retry' CHECK (btrim(scenario_id) <> ''),
  ADD COLUMN scenario_version text NOT NULL DEFAULT '1.0.0' CHECK (btrim(scenario_version) <> ''),
  ADD COLUMN scenario_title text NOT NULL DEFAULT 'Booking notification retry' CHECK (btrim(scenario_title) <> ''),
  ADD COLUMN status text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'ACTIVE', 'SUBMITTED')),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  ADD COLUMN closure_reason text CHECK (closure_reason IS NULL OR closure_reason IN ('candidate_submission', 'timeout')),
  ADD COLUMN review_process_status text CHECK (review_process_status IS NULL OR review_process_status IN ('not_started', 'waiting_for_response', 'next_step_recorded'));

ALTER TABLE hirearchy.assessment_sessions
  ADD CONSTRAINT assessment_sessions_lifecycle_check CHECK (
    (
      status = 'CREATED'
      AND activated_at IS NULL
      AND submitted_at IS NULL
      AND closure_reason IS NULL
      AND review_process_status IS NULL
    )
    OR (
      status = 'ACTIVE'
      AND activated_at IS NOT NULL
      AND submitted_at IS NULL
      AND closure_reason IS NULL
      AND review_process_status IS NULL
      AND activated_at >= created_at
    )
    OR (
      status = 'SUBMITTED'
      AND activated_at IS NOT NULL
      AND submitted_at IS NOT NULL
      AND closure_reason IS NOT NULL
      AND activated_at >= created_at
      AND submitted_at >= activated_at
    )
  );

DROP TRIGGER IF EXISTS sessions_owner_immutable ON hirearchy.assessment_sessions;
DROP TRIGGER IF EXISTS assessment_sessions_immutable_keys ON hirearchy.assessment_sessions;

CREATE TRIGGER assessment_sessions_immutable_keys
  BEFORE UPDATE OF id, organization_id, issuer_principal_id, scenario_id, scenario_version, scenario_title, created_at, duration_seconds
  ON hirearchy.assessment_sessions
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_immutable_columns(
    'id', 'organization_id', 'issuer_principal_id', 'scenario_id', 'scenario_version', 'scenario_title', 'created_at', 'duration_seconds'
  );

CREATE FUNCTION hirearchy.enforce_assessment_session_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, hirearchy, pg_temp
AS $function$
BEGIN
  IF OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION 'Immutable activated_at timestamp cannot be modified once set' USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'ACTIVE' AND NEW.status = 'CREATED' THEN
    RAISE EXCEPTION 'Assessment session status cannot regress from ACTIVE to CREATED' USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'SUBMITTED' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'Assessment session status cannot regress from SUBMITTED' USING ERRCODE = '23514';
    END IF;
    IF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
      RAISE EXCEPTION 'Immutable submitted_at timestamp cannot be modified once set' USING ERRCODE = '23514';
    END IF;
    IF NEW.closure_reason IS DISTINCT FROM OLD.closure_reason THEN
      RAISE EXCEPTION 'Immutable closure_reason cannot be modified once set' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER assessment_sessions_lifecycle_guard
  BEFORE UPDATE ON hirearchy.assessment_sessions
  FOR EACH ROW EXECUTE FUNCTION hirearchy.enforce_assessment_session_lifecycle();

CREATE INDEX assessment_sessions_org_created_id_idx
  ON hirearchy.assessment_sessions (organization_id, created_at DESC, id DESC);

CREATE INDEX assessment_sessions_org_issuer_created_id_idx
  ON hirearchy.assessment_sessions (organization_id, issuer_principal_id, created_at DESC, id DESC);

CREATE INDEX assessment_sessions_org_status_created_id_idx
  ON hirearchy.assessment_sessions (organization_id, status, created_at DESC, id DESC);

CREATE TABLE hirearchy.reviewer_assignments (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  organization_id uuid NOT NULL,
  session_id text NOT NULL,
  reviewer_principal_id uuid NOT NULL,
  assigned_by_principal_id uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  revoked_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (organization_id, id),
  CHECK (revoked_at IS NULL OR revoked_at >= assigned_at),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES hirearchy.assessment_sessions (organization_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, reviewer_principal_id)
    REFERENCES hirearchy.organization_memberships (organization_id, principal_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, assigned_by_principal_id)
    REFERENCES hirearchy.organization_memberships (organization_id, principal_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX reviewer_assignments_active_unique_idx
  ON hirearchy.reviewer_assignments (organization_id, session_id, reviewer_principal_id)
  WHERE revoked_at IS NULL;

CREATE INDEX reviewer_assignments_org_reviewer_session_idx
  ON hirearchy.reviewer_assignments (organization_id, reviewer_principal_id, session_id)
  WHERE revoked_at IS NULL;

CREATE TRIGGER reviewer_assignments_immutable_keys
  BEFORE UPDATE OF id, organization_id, session_id, reviewer_principal_id, assigned_by_principal_id, assigned_at
  ON hirearchy.reviewer_assignments
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_immutable_columns(
    'id', 'organization_id', 'session_id', 'reviewer_principal_id', 'assigned_by_principal_id', 'assigned_at'
  );

ALTER TABLE hirearchy.reviewer_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.reviewer_assignments FORCE ROW LEVEL SECURITY;

REVOKE ALL ON FUNCTION hirearchy.enforce_assessment_session_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION hirearchy.enforce_assessment_session_lifecycle() FROM app_evaluator, app_candidate_gateway, app_control_worker;

REVOKE ALL ON TABLE hirearchy.reviewer_assignments FROM PUBLIC;
REVOKE ALL ON TABLE hirearchy.reviewer_assignments FROM app_evaluator, app_candidate_gateway, app_control_worker;
