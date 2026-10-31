-- Administrator-run API installation after the staging bootstrap and all
-- ordered migrations. This grants r23_gateway only the dispatcher entry point.
BEGIN;

DO $preflight$
DECLARE
  owner_role record;
  gateway_role record;
BEGIN
  SELECT oid, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb,
         rolcreaterole, rolreplication, rolinherit, rolconfig
    INTO owner_role
    FROM pg_catalog.pg_roles
    WHERE rolname = 'staging_verifier_owner';
  IF NOT FOUND
     OR owner_role.rolcanlogin OR owner_role.rolsuper OR owner_role.rolbypassrls
     OR owner_role.rolcreatedb OR owner_role.rolcreaterole
     OR owner_role.rolreplication OR owner_role.rolinherit
     OR owner_role.rolconfig IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setrole = owner_role.oid)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid = owner_role.oid OR member = owner_role.oid) THEN
    RAISE EXCEPTION 'staging_verifier_owner is missing or unsafe';
  END IF;

  SELECT oid, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb,
         rolcreaterole, rolreplication, rolinherit, rolconfig
    INTO gateway_role
    FROM pg_catalog.pg_roles
    WHERE rolname = 'r23_gateway';
  IF NOT FOUND
     OR NOT gateway_role.rolcanlogin OR gateway_role.rolsuper OR gateway_role.rolbypassrls
     OR gateway_role.rolcreatedb OR gateway_role.rolcreaterole
     OR gateway_role.rolreplication OR gateway_role.rolinherit
     OR gateway_role.rolconfig IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setrole = gateway_role.oid)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid = gateway_role.oid OR member = gateway_role.oid) THEN
    RAISE EXCEPTION 'r23_gateway is missing or unsafe';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_language WHERE lanname = 'plpython3u') THEN
    RAISE EXCEPTION 'plpython3u is not installed';
  END IF;
  IF pg_catalog.to_regclass('auth.sessions') IS NULL THEN
    RAISE EXCEPTION 'GoTrue auth.sessions must be installed before the staging API';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = pg_catalog.to_regclass('auth.sessions')
      AND attname = 'id' AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = pg_catalog.to_regclass('auth.sessions')
      AND attname = 'user_id' AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = pg_catalog.to_regclass('auth.sessions')
      AND attname = 'not_after' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'GoTrue auth.sessions is missing required identity or expiry columns';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace
    WHERE nspname = ANY (ARRAY[
      'r23', 'r24', 'r25', 'r26', 'r27', 'r28', 'r29',
      'r210', 'r211', 'r212', 'r213'
    ]::pg_catalog.name[])
  ) THEN
    RAISE EXCEPTION 'Disposable R23-R213 fixture schema exists; staging API installation is refused';
  END IF;
END
$preflight$;

CREATE SCHEMA IF NOT EXISTS staging AUTHORIZATION staging_verifier_owner;
DO $schema_owner$
BEGIN
  IF (
    SELECT r.rolname
    FROM pg_catalog.pg_namespace AS n
    JOIN pg_catalog.pg_roles AS r ON r.oid = n.nspowner
    WHERE n.nspname = 'staging'
  ) IS DISTINCT FROM 'staging_verifier_owner' THEN
    RAISE EXCEPTION 'staging schema must be owned by staging_verifier_owner';
  END IF;
END
$schema_owner$;

REVOKE ALL ON SCHEMA staging FROM PUBLIC, r23_gateway,
  app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
GRANT USAGE ON SCHEMA staging TO r23_gateway;
GRANT USAGE ON SCHEMA auth TO staging_verifier_owner;
GRANT SELECT (id, user_id, not_after) ON auth.sessions TO staging_verifier_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE staging_verifier_owner IN SCHEMA staging
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE staging_verifier_owner IN SCHEMA staging
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE staging_verifier_owner IN SCHEMA staging
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DO $auth_policy$
BEGIN
  IF (
    SELECT relrowsecurity
    FROM pg_catalog.pg_class
    WHERE oid = pg_catalog.to_regclass('auth.sessions')
  ) THEN
    EXECUTE 'DROP POLICY IF EXISTS staging_verifier_auth_sessions ON auth.sessions';
    EXECUTE 'CREATE POLICY staging_verifier_auth_sessions ON auth.sessions FOR SELECT TO staging_verifier_owner USING (true)';
  END IF;
END
$auth_policy$;

-- Owner policies and grants are installed together with their verified entry point.
DROP POLICY IF EXISTS staging_verifier_key_select ON hirearchy.staging_verification_keys;
CREATE POLICY staging_verifier_key_select
  ON hirearchy.staging_verification_keys
  FOR SELECT TO staging_verifier_owner
  USING (true);

DROP POLICY IF EXISTS staging_verifier_nonce_all ON hirearchy.staging_proof_nonces;
CREATE POLICY staging_verifier_nonce_all
  ON hirearchy.staging_proof_nonces
  FOR ALL TO staging_verifier_owner
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS staging_verifier_session_select ON hirearchy.staging_sessions;
CREATE POLICY staging_verifier_session_select
  ON hirearchy.staging_sessions
  FOR SELECT TO staging_verifier_owner
  USING (
    subject_id = NULLIF(pg_catalog.current_setting('staging.subject_id', true), '')::pg_catalog.uuid
    AND auth_session_id = NULLIF(pg_catalog.current_setting('staging.auth_session_id', true), '')::pg_catalog.uuid
    AND organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS staging_verifier_session_insert ON hirearchy.staging_sessions;
CREATE POLICY staging_verifier_session_insert
  ON hirearchy.staging_sessions
  FOR INSERT TO staging_verifier_owner
  WITH CHECK (
    subject_id = NULLIF(pg_catalog.current_setting('staging.subject_id', true), '')::pg_catalog.uuid
    AND auth_session_id = NULLIF(pg_catalog.current_setting('staging.auth_session_id', true), '')::pg_catalog.uuid
    AND organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS staging_verifier_session_revoke ON hirearchy.staging_sessions;
CREATE POLICY staging_verifier_session_revoke
  ON hirearchy.staging_sessions
  FOR UPDATE TO staging_verifier_owner
  USING (
    subject_id = NULLIF(pg_catalog.current_setting('staging.subject_id', true), '')::pg_catalog.uuid
    AND auth_session_id = NULLIF(pg_catalog.current_setting('staging.auth_session_id', true), '')::pg_catalog.uuid
    AND principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
    AND organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
  )
  WITH CHECK (
    subject_id = NULLIF(pg_catalog.current_setting('staging.subject_id', true), '')::pg_catalog.uuid
    AND auth_session_id = NULLIF(pg_catalog.current_setting('staging.auth_session_id', true), '')::pg_catalog.uuid
    AND principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
    AND organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
  );

ALTER TABLE hirearchy.application_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.application_principals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staging_verifier_principal_select ON hirearchy.application_principals;
CREATE POLICY staging_verifier_principal_select
  ON hirearchy.application_principals
  FOR SELECT TO staging_verifier_owner
  USING (
    auth_user_id = NULLIF(pg_catalog.current_setting('staging.subject_id', true), '')::pg_catalog.uuid
  );

ALTER TABLE hirearchy.organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.organization_memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staging_verifier_membership_select ON hirearchy.organization_memberships;
CREATE POLICY staging_verifier_membership_select
  ON hirearchy.organization_memberships
  FOR SELECT TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND (
      principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
      OR principal_id = NULLIF(pg_catalog.current_setting('staging.reviewer_principal_id', true), '')::pg_catalog.uuid
    )
  );

DROP POLICY IF EXISTS staging_verifier_assessment_definition_select ON hirearchy.assessment_definitions;
CREATE POLICY staging_verifier_assessment_definition_select
  ON hirearchy.assessment_definitions
  FOR SELECT TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
  );
DROP POLICY IF EXISTS staging_verifier_assessment_definition_insert ON hirearchy.assessment_definitions;
CREATE POLICY staging_verifier_assessment_definition_insert
  ON hirearchy.assessment_definitions
  FOR INSERT TO staging_verifier_owner
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND author_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
  );
DROP POLICY IF EXISTS staging_verifier_assessment_definition_update ON hirearchy.assessment_definitions;
CREATE POLICY staging_verifier_assessment_definition_update
  ON hirearchy.assessment_definitions
  FOR UPDATE TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
  )
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS staging_verifier_assessment_draft_select ON hirearchy.assessment_drafts;
CREATE POLICY staging_verifier_assessment_draft_select
  ON hirearchy.assessment_drafts
  FOR SELECT TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
  );
DROP POLICY IF EXISTS staging_verifier_assessment_draft_insert ON hirearchy.assessment_drafts;
CREATE POLICY staging_verifier_assessment_draft_insert
  ON hirearchy.assessment_drafts
  FOR INSERT TO staging_verifier_owner
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND author_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS staging_verifier_validated_version_select ON hirearchy.assessment_validated_versions;
CREATE POLICY staging_verifier_validated_version_select
  ON hirearchy.assessment_validated_versions
  FOR SELECT TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
  );
DROP POLICY IF EXISTS staging_verifier_validated_version_insert ON hirearchy.assessment_validated_versions;
CREATE POLICY staging_verifier_validated_version_insert
  ON hirearchy.assessment_validated_versions
  FOR INSERT TO staging_verifier_owner
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND author_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS staging_verifier_assessment_session_select ON hirearchy.assessment_sessions;
CREATE POLICY staging_verifier_assessment_session_select
  ON hirearchy.assessment_sessions
  FOR SELECT TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND (
      issuer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
      OR EXISTS (
        SELECT 1 FROM hirearchy.reviewer_assignments AS assignment
        WHERE assignment.organization_id = assessment_sessions.organization_id
          AND assignment.session_id = assessment_sessions.id
          AND assignment.reviewer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
          AND assignment.revoked_at IS NULL
      )
    )
  );
DROP POLICY IF EXISTS staging_verifier_assessment_session_insert ON hirearchy.assessment_sessions;
CREATE POLICY staging_verifier_assessment_session_insert
  ON hirearchy.assessment_sessions
  FOR INSERT TO staging_verifier_owner
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND issuer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS staging_verifier_reviewer_assignment_select ON hirearchy.reviewer_assignments;
CREATE POLICY staging_verifier_reviewer_assignment_select
  ON hirearchy.reviewer_assignments
  FOR SELECT TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND (
      reviewer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
      OR assigned_by_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
    )
  );
DROP POLICY IF EXISTS staging_verifier_reviewer_assignment_insert ON hirearchy.reviewer_assignments;
CREATE POLICY staging_verifier_reviewer_assignment_insert
  ON hirearchy.reviewer_assignments
  FOR INSERT TO staging_verifier_owner
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND assigned_by_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
    AND reviewer_principal_id = NULLIF(pg_catalog.current_setting('staging.reviewer_principal_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS staging_verifier_assessment_issuance_select ON hirearchy.assessment_issuances;
CREATE POLICY staging_verifier_assessment_issuance_select
  ON hirearchy.assessment_issuances
  FOR SELECT TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND (
      issuer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
      OR EXISTS (
        SELECT 1 FROM hirearchy.reviewer_assignments AS assignment
        WHERE assignment.organization_id = assessment_issuances.organization_id
          AND assignment.session_id = assessment_issuances.session_id
          AND assignment.reviewer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
          AND assignment.revoked_at IS NULL
      )
    )
  );
DROP POLICY IF EXISTS staging_verifier_assessment_issuance_insert ON hirearchy.assessment_issuances;
CREATE POLICY staging_verifier_assessment_issuance_insert
  ON hirearchy.assessment_issuances
  FOR INSERT TO staging_verifier_owner
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND issuer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS staging_verifier_event_select ON hirearchy.candidate_session_events;
CREATE POLICY staging_verifier_event_select
  ON hirearchy.candidate_session_events
  FOR SELECT TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND EXISTS (
      SELECT 1 FROM hirearchy.reviewer_assignments AS assignment
      WHERE assignment.organization_id = candidate_session_events.organization_id
        AND assignment.session_id = candidate_session_events.session_id
        AND assignment.reviewer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
        AND assignment.revoked_at IS NULL
    )
  );

DROP POLICY IF EXISTS staging_verifier_revision_select ON hirearchy.candidate_file_revisions;
CREATE POLICY staging_verifier_revision_select
  ON hirearchy.candidate_file_revisions
  FOR SELECT TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND EXISTS (
      SELECT 1 FROM hirearchy.reviewer_assignments AS assignment
      WHERE assignment.organization_id = candidate_file_revisions.organization_id
        AND assignment.session_id = candidate_file_revisions.session_id
        AND assignment.reviewer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
        AND assignment.revoked_at IS NULL
    )
  );

DROP POLICY IF EXISTS staging_verifier_submission_select ON hirearchy.candidate_session_submissions;
CREATE POLICY staging_verifier_submission_select
  ON hirearchy.candidate_session_submissions
  FOR SELECT TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND EXISTS (
      SELECT 1 FROM hirearchy.reviewer_assignments AS assignment
      WHERE assignment.organization_id = candidate_session_submissions.organization_id
        AND assignment.session_id = candidate_session_submissions.session_id
        AND assignment.reviewer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
        AND assignment.revoked_at IS NULL
    )
  );

DROP POLICY IF EXISTS staging_verifier_observation_select ON hirearchy.evaluator_observations;
CREATE POLICY staging_verifier_observation_select
  ON hirearchy.evaluator_observations
  FOR SELECT TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND EXISTS (
      SELECT 1 FROM hirearchy.reviewer_assignments AS assignment
      WHERE assignment.organization_id = evaluator_observations.organization_id
        AND assignment.session_id = evaluator_observations.session_id
        AND assignment.reviewer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
        AND assignment.revoked_at IS NULL
    )
    AND author_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS staging_verifier_observation_history_select ON hirearchy.evaluator_observation_history;
CREATE POLICY staging_verifier_observation_history_select
  ON hirearchy.evaluator_observation_history
  FOR SELECT TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND EXISTS (
      SELECT 1 FROM hirearchy.reviewer_assignments AS assignment
      WHERE assignment.organization_id = evaluator_observation_history.organization_id
        AND assignment.session_id = evaluator_observation_history.session_id
        AND assignment.reviewer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
        AND assignment.revoked_at IS NULL
    )
    AND author_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS staging_verifier_review_packet_select ON hirearchy.evaluator_review_packets;
CREATE POLICY staging_verifier_review_packet_select
  ON hirearchy.evaluator_review_packets
  FOR SELECT TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND EXISTS (
      SELECT 1 FROM hirearchy.reviewer_assignments AS assignment
      WHERE assignment.organization_id = evaluator_review_packets.organization_id
        AND assignment.session_id = evaluator_review_packets.session_id
        AND assignment.reviewer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
        AND assignment.revoked_at IS NULL
    )
    AND author_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS staging_verifier_review_packet_history_select ON hirearchy.evaluator_review_packet_history;
CREATE POLICY staging_verifier_review_packet_history_select
  ON hirearchy.evaluator_review_packet_history
  FOR SELECT TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND EXISTS (
      SELECT 1 FROM hirearchy.reviewer_assignments AS assignment
      WHERE assignment.organization_id = evaluator_review_packet_history.organization_id
        AND assignment.session_id = evaluator_review_packet_history.session_id
        AND assignment.reviewer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
        AND assignment.revoked_at IS NULL
    )
    AND author_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
  );

GRANT USAGE ON SCHEMA hirearchy TO staging_verifier_owner;
GRANT SELECT ON hirearchy.application_principals,
  hirearchy.organization_memberships,
  hirearchy.staging_verification_keys TO staging_verifier_owner;
GRANT SELECT, INSERT, DELETE ON hirearchy.staging_proof_nonces TO staging_verifier_owner;
GRANT SELECT, INSERT, UPDATE (expires_at, revoked_at)
  ON hirearchy.staging_sessions TO staging_verifier_owner;
GRANT SELECT, INSERT, UPDATE (title, draft_version, updated_at)
  ON hirearchy.assessment_definitions TO staging_verifier_owner;
GRANT SELECT, INSERT ON hirearchy.assessment_drafts,
  hirearchy.assessment_validated_versions TO staging_verifier_owner;
GRANT SELECT, INSERT ON hirearchy.assessment_sessions,
  hirearchy.reviewer_assignments,
  hirearchy.assessment_issuances TO staging_verifier_owner;
GRANT SELECT ON hirearchy.candidate_session_events,
  hirearchy.candidate_session_submissions,
  hirearchy.candidate_file_revisions,
  hirearchy.evaluator_observations,
  hirearchy.evaluator_observation_history,
  hirearchy.evaluator_review_packets,
  hirearchy.evaluator_review_packet_history TO staging_verifier_owner;


CREATE OR REPLACE FUNCTION staging.dispatch(p_payload pg_catalog.bytea, p_signature pg_catalog.bytea)
RETURNS pg_catalog.jsonb
LANGUAGE plpython3u
SECURITY DEFINER
SET search_path = pg_catalog, staging
AS $python$
import json
import re
import uuid

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

MAX_PAYLOAD_BYTES = 1048576
MAX_SAFE_INTEGER = 9007199254740991
CLAIM_KEYS = {'v', 'iss', 'aud', 'kid', 'iat', 'exp', 'auth_exp', 'jti', 'sub', 'sid', 'op', 'args'}
DRAFT_REQUIRED = {
    'title', 'brief', 'expectedBehavior', 'acceptanceCriteria',
    'primaryFilePath', 'starterFiles', 'durationMinutes',
    'terminalEnabled', 'integratedAi', 'rubric'
}
DRAFT_OPTIONAL = {'templateId', 'definitionId', 'expectedVersion'}
VALIDATED_KEYS = {
    'contentDigest', 'scenarioId', 'scenarioVersion', 'scenarioTitle',
    'scenarioSnapshot', 'taskRubricSnapshot', 'durationSeconds',
    'terminalEnabled', 'integratedAi', 'validationReceipt'
}

def error(message, sqlstate):
    plpy.error(message, sqlstate=sqlstate)

def duplicate_checked_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate object key')
        result[key] = value
    return result

def reject_number(value):
    raise ValueError('non-integer number')

def validate_json_value(value):
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, str):
        for char in value:
            if 0xD800 <= ord(char) <= 0xDFFF:
                raise ValueError('invalid Unicode scalar')
        return
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise ValueError('unsafe integer')
        return
    if isinstance(value, list):
        for item in value:
            validate_json_value(item)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError('invalid object key')
            validate_json_value(key)
            validate_json_value(item)
        return
    raise ValueError('unsupported JSON value')

def strict_json_bytes(raw):
    parsed = json.loads(
        raw.decode('utf-8'),
        object_pairs_hook=duplicate_checked_object,
        parse_float=reject_number,
        parse_constant=reject_number,
    )
    validate_json_value(parsed)
    canonical = json.dumps(
        parsed, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False
    ).encode('utf-8')
    if canonical != raw:
        raise ValueError('non-canonical JSON')
    return parsed

def run(sql, types=None, values=None):
    if types is None:
        return plpy.execute(sql)
    return plpy.execute(plpy.prepare(sql, types), values)

def json_value(value):
    return json.loads(value) if isinstance(value, str) else value

def set_context(name, value):
    run(
        "SELECT pg_catalog.set_config($1, $2, true)",
        ['text', 'text'],
        [name, '' if value is None else str(value)],
    )

def set_scope(subject_id, auth_session_id, principal_id=None, organization_id=None,
              reviewer_principal_id=None, session_id=None):
    values = {
        'staging.subject_id': subject_id,
        'staging.auth_session_id': auth_session_id,
        'staging.principal_id': principal_id,
        'staging.organization_id': organization_id,
        'staging.reviewer_principal_id': reviewer_principal_id,
        'staging.session_id': session_id,
    }
    for name, value in values.items():
        set_context(name, value)

def exact_keys(value, required, optional=()):
    if not isinstance(value, dict):
        return False
    keys = set(value)
    return set(required).issubset(keys) and keys.issubset(set(required) | set(optional))

def is_uuid(value):
    if not isinstance(value, str) or not re.fullmatch(
        r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', value
    ):
        return False
    try:
        return str(uuid.UUID(value)) == value
    except ValueError:
        return False

def require_uuid(value, label):
    if not is_uuid(value):
        error('Staging request is invalid', '22023')
    return value

def require_args(args, required, optional=()):
    if not exact_keys(args, required, optional):
        error('Staging request is invalid', '22023')

def require_draft(content):
    if not exact_keys(content, DRAFT_REQUIRED, DRAFT_OPTIONAL):
        error('Staging assessment content is invalid', '22023')
    if not all(isinstance(content[key], str) for key in ('title', 'brief', 'primaryFilePath')):
        error('Staging assessment content is invalid', '22023')
    if not all(isinstance(content[key], list) for key in ('expectedBehavior', 'acceptanceCriteria', 'starterFiles', 'rubric')):
        error('Staging assessment content is invalid', '22023')
    if isinstance(content['durationMinutes'], bool) or not isinstance(content['durationMinutes'], int):
        error('Staging assessment content is invalid', '22023')
    if not isinstance(content['terminalEnabled'], bool) or not isinstance(content['integratedAi'], bool):
        error('Staging assessment content is invalid', '22023')
    if 'templateId' in content and content['templateId'] not in ('custom', 'reservation-moves-v3'):
        error('Staging assessment content is invalid', '22023')
    if 'definitionId' in content and not is_uuid(content['definitionId']):
        error('Staging assessment content is invalid', '22023')
    if 'expectedVersion' in content and (
        isinstance(content['expectedVersion'], bool)
        or not isinstance(content['expectedVersion'], int)
        or content['expectedVersion'] < 1
    ):
        error('Staging assessment content is invalid', '22023')
    for item in content['expectedBehavior'] + content['acceptanceCriteria']:
        if not isinstance(item, str):
            error('Staging assessment content is invalid', '22023')
    for item in content['starterFiles']:
        if not exact_keys(item, ('path', 'content')) or not all(
            isinstance(item[key], str) for key in ('path', 'content')
        ):
            error('Staging assessment content is invalid', '22023')
    for item in content['rubric']:
        if not exact_keys(item, ('id', 'label', 'description', 'weight', 'applicability')):
            error('Staging assessment content is invalid', '22023')
        if not all(isinstance(item[key], str) for key in ('id', 'label', 'description')):
            error('Staging assessment content is invalid', '22023')
        if isinstance(item['weight'], bool) or not isinstance(item['weight'], int):
            error('Staging assessment content is invalid', '22023')
        if not exact_keys(item['applicability'], ('kind', 'rule')) or not all(
            isinstance(item['applicability'][key], str) for key in ('kind', 'rule')
        ):
            error('Staging assessment content is invalid', '22023')

def current_content(assessment_id):
    rows = run(
        """
        SELECT pg_catalog.jsonb_build_object(
          'draft', draft.staging_content
        ) AS content
        FROM hirearchy.assessment_drafts AS draft
        WHERE draft.definition_id = $1::pg_catalog.uuid
          AND draft.organization_id = NULLIF(
            pg_catalog.current_setting('staging.organization_id', true), ''
          )::pg_catalog.uuid
        ORDER BY draft.version DESC
        LIMIT 1
        """,
        ['uuid'],
        [assessment_id],
    )
    if not rows:
        return None
    value = rows[0]['content']
    value = json.loads(value) if isinstance(value, str) else value
    if not isinstance(value, dict) or not isinstance(value.get('draft'), dict):
        return None
    return value['draft']

def current_membership(organization_id, principal_id):
    rows = run(
        """
        SELECT role
        FROM hirearchy.organization_memberships
        WHERE organization_id = $1::pg_catalog.uuid
          AND principal_id = $2::pg_catalog.uuid
          AND status = 'active'
          AND revoked_at IS NULL
        """,
        ['uuid', 'uuid'],
        [organization_id, principal_id],
    )
    return rows[0]['role'] if rows else None

def require_membership(organization_id, principal_id, allowed):
    role = current_membership(organization_id, principal_id)
    if role not in allowed:
        error('Active organization membership required', '42501')
    return role

def require_open_session(auth_session_id, subject_id, principal_id, organization_id, auth_exp):
    rows = run(
        """
        SELECT 1
        FROM hirearchy.staging_sessions
        WHERE auth_session_id = $1::pg_catalog.uuid
          AND subject_id = $2::pg_catalog.uuid
          AND principal_id = $3::pg_catalog.uuid
          AND organization_id = $4::pg_catalog.uuid
          AND revoked_at IS NULL
        """,
        ['uuid', 'uuid', 'uuid', 'uuid'],
        [auth_session_id, subject_id, principal_id, organization_id],
    )
    if not rows:
        error('Staging session is unavailable', '28000')
    run(
        """
        UPDATE hirearchy.staging_sessions
        SET expires_at = pg_catalog.to_timestamp($5::pg_catalog.float8)
        WHERE auth_session_id = $1::pg_catalog.uuid
          AND subject_id = $2::pg_catalog.uuid
          AND principal_id = $3::pg_catalog.uuid
          AND organization_id = $4::pg_catalog.uuid
          AND revoked_at IS NULL
        """,
        ['uuid', 'uuid', 'uuid', 'uuid', 'int8'],
        [auth_session_id, subject_id, principal_id, organization_id, auth_exp],
    )

def validate_operation_args(operation, args):
    schemas = {
        'session.open': (('organizationId',), ()),
        'session.revoke': (('organizationId',), ()),
        'assessment.create': (('organizationId', 'content'), ('assessmentId',)),
        'assessment.get': (('organizationId', 'assessmentId'), ()),
        'assessment.validate': (('organizationId', 'assessmentId', 'content', 'validatedVersion'), ()),
        'assessment.issue': (('organizationId', 'assessmentId', 'reviewerPrincipalId'), ()),
        'evidence.read': (('organizationId', 'sessionId'), ()),
        'review.read': (('organizationId', 'sessionId'), ()),
    }
    if operation not in schemas:
        error('Staging operation is unavailable', '22023')
    required, optional = schemas[operation]
    require_args(args, required, optional)

def dispatch(operation, args, subject_id, auth_session_id, principal_id, auth_exp, proof_exp):
    if operation in ('session.open', 'session.revoke'):
        organization_id = require_uuid(args.get('organizationId'), 'organization ID')
    else:
        organization_id = require_uuid(args.get('organizationId'), 'organization ID')
    set_scope(
        subject_id, auth_session_id, principal_id, organization_id,
        args.get('reviewerPrincipalId'), args.get('sessionId'),
    )
    role = require_membership(
        organization_id, principal_id, ('recruiter', 'reviewer')
    )

    if operation == 'session.open':
        rows = run(
            """
            INSERT INTO hirearchy.staging_sessions (
              auth_session_id, subject_id, organization_id, principal_id, expires_at
            ) VALUES (
              $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.uuid,
              $4::pg_catalog.uuid, pg_catalog.to_timestamp($5::pg_catalog.float8)
            )
            ON CONFLICT (auth_session_id, organization_id) DO UPDATE
              SET expires_at = EXCLUDED.expires_at
              WHERE hirearchy.staging_sessions.subject_id = EXCLUDED.subject_id
                AND hirearchy.staging_sessions.principal_id = EXCLUDED.principal_id
                AND hirearchy.staging_sessions.revoked_at IS NULL
            RETURNING auth_session_id::pg_catalog.text
            """,
            ['uuid', 'uuid', 'uuid', 'uuid', 'int8'],
            [auth_session_id, subject_id, organization_id, principal_id, auth_exp],
        )
        if not rows:
            error('Staging session is unavailable', '28000')
        return {'opened': True, 'organizationId': organization_id}

    require_open_session(auth_session_id, subject_id, principal_id, organization_id, auth_exp)

    if operation == 'session.revoke':
        rows = run(
            """
            UPDATE hirearchy.staging_sessions
            SET revoked_at = COALESCE(revoked_at, pg_catalog.clock_timestamp())
            WHERE auth_session_id = $1::pg_catalog.uuid
              AND subject_id = $2::pg_catalog.uuid
              AND principal_id = $3::pg_catalog.uuid
              AND organization_id = $4::pg_catalog.uuid
            RETURNING revoked_at IS NOT NULL AS revoked
            """,
            ['uuid', 'uuid', 'uuid', 'uuid'],
            [auth_session_id, subject_id, principal_id, organization_id],
        )
        if not rows:
            error('Staging session is unavailable', '28000')
        return {'revoked': True, 'organizationId': organization_id}

    if operation == 'assessment.create':
        if role != 'recruiter':
            error('Recruiter membership required', '42501')
        content = args['content']
        require_draft(content)
        requested_id = args.get('assessmentId') or content.get('definitionId')
        assessment_id = require_uuid(requested_id, 'assessment ID') if requested_id else run(
            'SELECT pg_catalog.gen_random_uuid()::pg_catalog.text AS id'
        )[0]['id']
        if content.get('definitionId') not in (None, assessment_id):
            error('Staging request is invalid', '22023')
        template_id = content.get('templateId', 'custom')
        definition_rows = run(
            """
            SELECT id::pg_catalog.text AS id, draft_version, author_principal_id::pg_catalog.text AS author_principal_id
            FROM hirearchy.assessment_definitions
            WHERE id = $1::pg_catalog.uuid AND organization_id = $2::pg_catalog.uuid
            FOR UPDATE
            """,
            ['uuid', 'uuid'],
            [assessment_id, organization_id],
        )
        if definition_rows:
            current_version = definition_rows[0]['draft_version']
            expected = content.get('expectedVersion')
            if expected is None or expected != current_version:
                error('Assessment draft changed concurrently', '23505')
            next_version = current_version + 1
            run(
                """
                UPDATE hirearchy.assessment_definitions
                SET title = $3, draft_version = $4::pg_catalog.int8,
                    updated_at = pg_catalog.clock_timestamp()
                WHERE id = $1::pg_catalog.uuid AND organization_id = $2::pg_catalog.uuid
                """,
                ['uuid', 'uuid', 'text', 'int8'],
                [assessment_id, organization_id, content['title'], next_version],
            )
        else:
            if content.get('expectedVersion') is not None:
                error('Assessment draft changed concurrently', '23505')
            next_version = 1
            run(
                """
                INSERT INTO hirearchy.assessment_definitions (
                  id, organization_id, author_principal_id, title, draft_version
                ) VALUES (
                  $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.uuid,
                  $4, 1
                )
                """,
                ['uuid', 'uuid', 'uuid', 'text'],
                [assessment_id, organization_id, principal_id, content['title']],
            )
        run(
            """
            INSERT INTO hirearchy.assessment_drafts (
              definition_id, organization_id, author_principal_id, version,
              title, brief, expected_behavior, acceptance_criteria,
              primary_file_path, starter_files, duration_minutes,
              terminal_enabled, integrated_ai, rubric, template_id, updated_at,
              staging_content
            ) VALUES (
              $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.uuid,
              $4::pg_catalog.int8, $5, $6, $7::pg_catalog.jsonb, $8::pg_catalog.jsonb,
              $9, $10::pg_catalog.jsonb, $11::pg_catalog.int4, $12::pg_catalog.bool,
              $13::pg_catalog.bool, $14::pg_catalog.jsonb, $15, pg_catalog.clock_timestamp(),
              $16::pg_catalog.jsonb
            )
            """,
            ['uuid', 'uuid', 'uuid', 'int8', 'text', 'text', 'text', 'text', 'text', 'text', 'int4', 'bool', 'bool', 'text', 'text', 'text'],
            [
                assessment_id, organization_id, principal_id, next_version,
                content['title'], content['brief'],
                json.dumps(content['expectedBehavior'], ensure_ascii=False),
                json.dumps(content['acceptanceCriteria'], ensure_ascii=False),
                content['primaryFilePath'], json.dumps(content['starterFiles'], ensure_ascii=False),
                content['durationMinutes'], content['terminalEnabled'], content['integratedAi'],
                json.dumps(content['rubric'], ensure_ascii=False), template_id,
                json.dumps(content, ensure_ascii=False),
            ],
        )
        return {'assessmentId': assessment_id}

    if operation == 'assessment.get':
        if role not in ('recruiter', 'reviewer'):
            error('Recruiter or reviewer membership required', '42501')
        assessment_id = require_uuid(args.get('assessmentId'), 'assessment ID')
        content = current_content(assessment_id)
        if content is None:
            error('Assessment is unavailable', '42501')
        return {'assessmentId': assessment_id, 'content': content}

    if operation == 'assessment.validate':
        if role != 'recruiter':
            error('Recruiter membership required', '42501')
        assessment_id = require_uuid(args.get('assessmentId'), 'assessment ID')
        content = args['content']
        require_draft(content)
        metadata = args['validatedVersion']
        if not exact_keys(metadata, VALIDATED_KEYS):
            error('Validated assessment metadata is invalid', '22023')
        if not re.fullmatch(r'[0-9a-f]{64}', metadata.get('contentDigest', '')):
            error('Validated assessment metadata is invalid', '22023')
        if not all(isinstance(metadata.get(name), str) and metadata[name] for name in ('scenarioId', 'scenarioVersion', 'scenarioTitle')):
            error('Validated assessment metadata is invalid', '22023')
        if not isinstance(metadata.get('scenarioSnapshot'), dict) or not isinstance(metadata.get('taskRubricSnapshot'), dict):
            error('Validated assessment metadata is invalid', '22023')
        if isinstance(metadata.get('durationSeconds'), bool) or metadata.get('durationSeconds') not in (1800, 2700, 3600, 5400):
            error('Validated assessment metadata is invalid', '22023')
        if metadata.get('terminalEnabled') is not content.get('terminalEnabled') or metadata.get('integratedAi') is not content.get('integratedAi'):
            error('Validated assessment metadata is invalid', '22023')
        receipt = metadata.get('validationReceipt')
        if (
            not exact_keys(receipt, ('validatedAt', 'checks', 'executionValidationAvailable'))
            or not isinstance(receipt.get('validatedAt'), str)
            or not isinstance(receipt.get('checks'), list)
            or not all(isinstance(item, str) for item in receipt['checks'])
            or receipt.get('executionValidationAvailable') is not False
        ):
            error('Validated assessment metadata is invalid', '22023')
        def_rows = run(
            """
            SELECT draft_version
            FROM hirearchy.assessment_definitions
            WHERE id = $1::pg_catalog.uuid AND organization_id = $2::pg_catalog.uuid
            FOR UPDATE
            """,
            ['uuid', 'uuid'],
            [assessment_id, organization_id],
        )
        stored_content = current_content(assessment_id)
        if not def_rows or stored_content is None:
            error('Assessment is unavailable', '42501')
        if json.dumps(stored_content, ensure_ascii=False, sort_keys=True, separators=(',', ':')) != json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(',', ':')):
            error('Assessment draft changed before validation', '23505')
        if metadata['durationSeconds'] != content['durationMinutes'] * 60 or metadata['scenarioTitle'] != content['title'].strip():
            error('Validated assessment metadata is invalid', '22023')
        expected_template = content.get('templateId', 'custom')
        if (
            metadata['scenarioId'] != ('reservation-moves' if expected_template == 'reservation-moves-v3' else 'authored-assessment')
            or metadata['scenarioVersion'] != ('v3' if expected_template == 'reservation-moves-v3' else '1.0.0')
        ):
            error('Validated assessment metadata is invalid', '22023')
        receipt = dict(receipt)
        receipt['draftVersion'] = def_rows[0]['draft_version']
        version_rows = run(
            """
            SELECT COALESCE(pg_catalog.max(version_number), 0) + 1 AS version_number
            FROM hirearchy.assessment_validated_versions
            WHERE definition_id = $1::pg_catalog.uuid
            """,
            ['uuid'],
            [assessment_id],
        )
        version_number = version_rows[0]['version_number']
        rows = run(
            """
            INSERT INTO hirearchy.assessment_validated_versions (
              definition_id, organization_id, author_principal_id, version_number,
              content_digest, scenario_id, scenario_version, scenario_title,
              scenario_snapshot, task_rubric_snapshot, duration_seconds,
              terminal_enabled, integrated_ai, validation_receipt
            ) VALUES (
              $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.uuid,
              $4::pg_catalog.int4, $5, $6, $7, $8, $9,
              $10::pg_catalog.jsonb, $11::pg_catalog.int4, $12::pg_catalog.bool,
              $13::pg_catalog.bool, $14::pg_catalog.jsonb
            ) RETURNING id::pg_catalog.text AS id
            """,
            ['uuid', 'uuid', 'uuid', 'int4', 'text', 'text', 'text', 'text', 'text', 'text', 'int4', 'bool', 'bool', 'text'],
            [
                assessment_id, organization_id, principal_id, version_number,
                metadata['contentDigest'], metadata['scenarioId'], metadata['scenarioVersion'],
                metadata['scenarioTitle'], json.dumps(metadata['scenarioSnapshot'], ensure_ascii=False),
                json.dumps(metadata['taskRubricSnapshot'], ensure_ascii=False), metadata['durationSeconds'],
                metadata['terminalEnabled'], metadata['integratedAi'], json.dumps(receipt, ensure_ascii=False),
            ],
        )
        return {
            'assessmentId': assessment_id,
            'validation': {
                'valid': True,
                'issues': [],
                'executionValidationAvailable': False,
                'executionValidationNotice': 'Static scenario structure validated. Live code execution and sandbox container test verification are unavailable in this lane.',
            },
            'validatedVersionId': rows[0]['id'],
            'versionNumber': version_number,
            'contentDigest': metadata['contentDigest'],
        }

    if operation == 'assessment.issue':
        if role != 'recruiter':
            error('Recruiter membership required', '42501')
        assessment_id = require_uuid(args.get('assessmentId'), 'assessment ID')
        reviewer_id = require_uuid(args.get('reviewerPrincipalId'), 'reviewer principal ID')
        target_role = current_membership(organization_id, reviewer_id)
        if target_role != 'reviewer':
            error('Active reviewer membership required', '42501')
        def_rows = run(
            """
            SELECT draft_version
            FROM hirearchy.assessment_definitions
            WHERE id = $1::pg_catalog.uuid AND organization_id = $2::pg_catalog.uuid
            FOR UPDATE
            """,
            ['uuid', 'uuid'],
            [assessment_id, organization_id],
        )
        if not def_rows:
            error('Assessment is unavailable', '42501')
        version_rows = run(
            """
            SELECT id::pg_catalog.text AS version_id, version_number, author_principal_id::pg_catalog.text AS author_id,
                   content_digest, scenario_id, scenario_version, scenario_title,
                   scenario_snapshot, task_rubric_snapshot, duration_seconds,
                   terminal_enabled, integrated_ai, validation_receipt
            FROM hirearchy.assessment_validated_versions
            WHERE definition_id = $1::pg_catalog.uuid
              AND organization_id = $2::pg_catalog.uuid
              AND validation_receipt ->> 'draftVersion' = $3::pg_catalog.text
            ORDER BY version_number DESC
            LIMIT 1
            """,
            ['uuid', 'uuid', 'text'],
            [assessment_id, organization_id, str(def_rows[0]['draft_version'])],
        )
        if not version_rows:
            error('Current assessment version must be validated before issue', '42501')
        version = version_rows[0]
        if version['terminal_enabled'] is not True:
            error('Staging issuance requires the validated terminal contract', '42501')
        version['task_rubric_snapshot'] = json_value(version['task_rubric_snapshot'])
        version_id = version['version_id']
        idempotency_key = 'staging-assessment:' + assessment_id + ':' + version_id
        request_hash = run(
            "SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to($1, 'UTF8')), 'hex') AS value",
            ['text'],
            [organization_id + ':' + assessment_id + ':' + version_id + ':' + reviewer_id],
        )[0]['value']
        snapshot_value = version['scenario_snapshot']
        payload_hash = run(
            "SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to($1, 'UTF8')), 'hex') AS value",
            ['text'],
            [snapshot_value + ':' + str(version['task_rubric_snapshot']) + ':' + str(version['duration_seconds'])],
        )[0]['value']
        existing = run(
            """
            SELECT session_id, request_hash, payload_hash
            FROM hirearchy.assessment_issuances
            WHERE organization_id = $1::pg_catalog.uuid AND idempotency_key = $2
            """,
            ['uuid', 'text'],
            [organization_id, idempotency_key],
        )
        if existing:
            if existing[0]['request_hash'] != request_hash or existing[0]['payload_hash'] != payload_hash:
                error('Assessment was already issued with different parameters', '23505')
            session_id = existing[0]['session_id']
        else:
            session_id = run("SELECT 'sess_' || pg_catalog.gen_random_uuid()::pg_catalog.text AS id")[0]['id']
            run(
                """
                INSERT INTO hirearchy.assessment_sessions (
                  id, organization_id, issuer_principal_id, scenario_id,
                  scenario_version, scenario_title, scenario_snapshot,
                  task_rubric_snapshot, duration_seconds, terminal_enabled,
                  ai_capability_snapshot, status, created_at
                ) VALUES (
                  $1, $2::pg_catalog.uuid, $3::pg_catalog.uuid, $4, $5, $6, $7,
                  $8::pg_catalog.jsonb, $9::pg_catalog.int4, false,
                  '{"enabled": false, "integratedAi": false, "reason": "staging_lockdown"}'::pg_catalog.jsonb,
                  'CREATED', pg_catalog.clock_timestamp()
                )
                """,
                ['text', 'uuid', 'uuid', 'text', 'text', 'text', 'text', 'text', 'int4'],
                [
                    session_id, organization_id, principal_id,
                    version['scenario_id'], version['scenario_version'], version['scenario_title'],
                    snapshot_value, json.dumps(version['task_rubric_snapshot'], ensure_ascii=False),
                    version['duration_seconds'],
                ],
            )
            run(
                """
                INSERT INTO hirearchy.reviewer_assignments (
                  id, organization_id, session_id, reviewer_principal_id, assigned_by_principal_id
                ) VALUES (
                  'rva_' || pg_catalog.gen_random_uuid()::pg_catalog.text,
                  $1::pg_catalog.uuid, $2, $3::pg_catalog.uuid, $4::pg_catalog.uuid
                )
                """,
                ['uuid', 'text', 'uuid', 'uuid'],
                [organization_id, session_id, reviewer_id, principal_id],
            )
            run(
                """
                INSERT INTO hirearchy.assessment_issuances (
                  organization_id, idempotency_key, session_id, issuer_principal_id,
                  request_hash, payload_hash, assessment_id, validated_version_id
                ) VALUES (
                  $1::pg_catalog.uuid, $2, $3, $4::pg_catalog.uuid,
                  $5, $6, $7::pg_catalog.uuid, $8::pg_catalog.uuid
                )
                """,
                ['uuid', 'text', 'text', 'uuid', 'text', 'text', 'uuid', 'uuid'],
                [organization_id, idempotency_key, session_id, principal_id,
                 request_hash, payload_hash, assessment_id, version_id],
            )
        return {
            'assessmentId': assessment_id,
            'sessionId': session_id,
            'organizationId': organization_id,
            'reviewerPrincipalId': reviewer_id,
            'status': 'CREATED',
            'terminalEnabled': False,
            'integratedAi': False,
            'candidateTokenIssued': False,
        }

    if operation in ('evidence.read', 'review.read'):
        if role != 'reviewer':
            error('Reviewer membership required', '42501')
        session_id = args.get('sessionId')
        if not isinstance(session_id, str) or not re.fullmatch(r'sess_[0-9a-f-]{36}', session_id):
            error('Staging request is invalid', '22023')
        assigned = run(
            """
            SELECT session.id, session.scenario_id, session.scenario_version,
                   session.scenario_title, session.status,
                   session.terminal_enabled, session.ai_capability_snapshot,
                   session.created_at
            FROM hirearchy.assessment_sessions AS session
            JOIN hirearchy.reviewer_assignments AS assignment
              ON assignment.organization_id = session.organization_id
             AND assignment.session_id = session.id
            WHERE session.organization_id = $1::pg_catalog.uuid
              AND session.id = $2
              AND assignment.reviewer_principal_id = $3::pg_catalog.uuid
              AND assignment.revoked_at IS NULL
            """,
            ['uuid', 'text', 'uuid'],
            [organization_id, session_id, principal_id],
        )
        if not assigned:
            error('Assigned reviewer access required', '42501')
        session = assigned[0]
        if operation == 'evidence.read':
            if session['status'] != 'SUBMITTED':
                return {
                    'session': {
                        'id': session['id'], 'organizationId': organization_id,
                        'scenarioId': session['scenario_id'], 'scenarioVersion': session['scenario_version'],
                        'scenarioTitle': session['scenario_title'], 'status': session['status'],
                        'terminalEnabled': session['terminal_enabled'],
                        'aiCapabilitySnapshot': json_value(session['ai_capability_snapshot']),
                    },
                    'events': [], 'fileRevisions': [], 'submissions': [],
                    'observations': [], 'observationHistory': [],
                    'captureLimitation': 'Evidence is unavailable until the candidate session is SUBMITTED. Candidate execution is disabled in this staging lane.',
                }
            event_rows = run(
                """
                SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                  'sequence', sequence, 'eventType', event_type,
                  'happenedAt', pg_catalog.to_char(happened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                  'payload', payload
                ) ORDER BY sequence), '[]'::pg_catalog.jsonb) AS items
                FROM hirearchy.candidate_session_events
                WHERE organization_id = $1::pg_catalog.uuid AND session_id = $2
                """,
                ['uuid', 'text'], [organization_id, session_id],
            )[0]['items']
            revision_rows = run(
                """
                SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                  'path', file_path, 'version', version, 'content', content,
                  'contentDigest', content_digest, 'acceptedAt',
                  pg_catalog.to_char(accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                  'eventSequence', event_sequence
                ) ORDER BY file_path, version), '[]'::pg_catalog.jsonb) AS items
                FROM hirearchy.candidate_file_revisions
                WHERE organization_id = $1::pg_catalog.uuid AND session_id = $2
                """,
                ['uuid', 'text'], [organization_id, session_id],
            )[0]['items']
            submission_rows = run(
                """
                SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                  'submittedAt', pg_catalog.to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                  'closureReason', closure_reason, 'workspaceDigest', workspace_digest,
                  'manifestDigest', manifest_digest, 'manifest', manifest
                )), '[]'::pg_catalog.jsonb) AS items
                FROM hirearchy.candidate_session_submissions
                WHERE organization_id = $1::pg_catalog.uuid AND session_id = $2
                """,
                ['uuid', 'text'], [organization_id, session_id],
            )[0]['items']
            observation_rows = run(
                """
                SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                  'id', id::pg_catalog.text, 'sourceType', evidence_source_type,
                  'eventSequence', event_sequence, 'filePath', file_path,
                  'fileVersion', file_version, 'evidenceDigest', evidence_digest,
                  'body', body, 'version', version,
                  'createdAt', pg_catalog.to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                  'updatedAt', pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                ) ORDER BY created_at, id), '[]'::pg_catalog.jsonb) AS items
                FROM hirearchy.evaluator_observations
                WHERE organization_id = $1::pg_catalog.uuid AND session_id = $2
                  AND author_principal_id = $3::pg_catalog.uuid
                """,
                ['uuid', 'text', 'uuid'], [organization_id, session_id, principal_id],
            )[0]['items']
            history_rows = run(
                """
                SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                  'historyId', history_id::pg_catalog.text, 'observationId', observation_id::pg_catalog.text,
                  'version', version, 'body', body, 'validFrom', valid_from,
                  'validUntil', valid_until, 'recordedAt', recorded_at
                ) ORDER BY recorded_at, history_id), '[]'::pg_catalog.jsonb) AS items
                FROM hirearchy.evaluator_observation_history
                WHERE organization_id = $1::pg_catalog.uuid AND session_id = $2
                  AND author_principal_id = $3::pg_catalog.uuid
                """,
                ['uuid', 'text', 'uuid'], [organization_id, session_id, principal_id],
            )[0]['items']
            def decode_json(value):
                return json.loads(value) if isinstance(value, str) else value
            return {
                'session': {
                    'id': session['id'], 'organizationId': organization_id,
                    'scenarioId': session['scenario_id'], 'scenarioVersion': session['scenario_version'],
                    'scenarioTitle': session['scenario_title'], 'status': session['status'],
                    'terminalEnabled': session['terminal_enabled'],
                    'aiCapabilitySnapshot': decode_json(session['ai_capability_snapshot']),
                },
                'events': decode_json(event_rows),
                'fileRevisions': decode_json(revision_rows),
                'submissions': decode_json(submission_rows),
                'observations': decode_json(observation_rows),
                'observationHistory': decode_json(history_rows),
                'captureLimitation': 'Candidate execution is disabled in this staging lane; no new candidate work is being captured.',
            }

        if session['status'] != 'SUBMITTED':
            return {
                'sessionId': session_id,
                'status': session['status'],
                'packets': [],
                'history': [],
                'availability': 'Review packets are unavailable until the candidate session is SUBMITTED.',
            }
        packet_rows = run(
            """
            SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'id', id::pg_catalog.text, 'status', status, 'summary', summary,
              'strengths', strengths, 'concerns', concerns,
              'unresolvedQuestions', unresolved_questions,
              'referencedObservationIds', referenced_observation_ids,
              'referencedEvidence', referenced_evidence, 'version', version,
              'finalizedAt', finalized_at, 'finalDigest', final_digest,
              'createdAt', created_at, 'updatedAt', updated_at
            ) ORDER BY created_at), '[]'::pg_catalog.jsonb) AS items
            FROM hirearchy.evaluator_review_packets
            WHERE organization_id = $1::pg_catalog.uuid AND session_id = $2
              AND author_principal_id = $3::pg_catalog.uuid
            """,
            ['uuid', 'text', 'uuid'], [organization_id, session_id, principal_id],
        )[0]['items']
        packet_history = run(
            """
            SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'historyId', history_id::pg_catalog.text, 'packetId', packet_id::pg_catalog.text,
              'status', status, 'version', version, 'summary', summary,
              'strengths', strengths, 'concerns', concerns,
              'unresolvedQuestions', unresolved_questions,
              'referencedObservationIds', referenced_observation_ids,
              'referencedEvidence', referenced_evidence, 'validFrom', valid_from,
              'validUntil', valid_until, 'recordedAt', recorded_at
            ) ORDER BY recorded_at, history_id), '[]'::pg_catalog.jsonb) AS items
            FROM hirearchy.evaluator_review_packet_history
            WHERE organization_id = $1::pg_catalog.uuid AND session_id = $2
              AND author_principal_id = $3::pg_catalog.uuid
            """,
            ['uuid', 'text', 'uuid'], [organization_id, session_id, principal_id],
        )[0]['items']
        return {
            'sessionId': session_id,
            'packets': json.loads(packet_rows) if isinstance(packet_rows, str) else packet_rows,
            'history': json.loads(packet_history) if isinstance(packet_history, str) else packet_history,
        }

    error('Staging operation is unavailable', '22023')

if p_payload is None or p_signature is None:
    error('Staging proof is invalid', '28000')
raw_payload = bytes(p_payload)
signature = bytes(p_signature)
if len(raw_payload) < 1 or len(raw_payload) > MAX_PAYLOAD_BYTES or len(signature) != 64:
    error('Staging proof is invalid', '28000')
role = run('SELECT session_user::pg_catalog.text AS login_role, current_user::pg_catalog.text AS function_role')[0]
if role['login_role'] != 'r23_gateway' or role['function_role'] != 'staging_verifier_owner':
    error('Staging dispatch is unavailable', '42501')
try:
    proof = strict_json_bytes(raw_payload)
except (UnicodeDecodeError, ValueError, TypeError, RecursionError):
    error('Staging proof is invalid', '28000')
if not exact_keys(proof, CLAIM_KEYS) or proof.get('v') != 1 or isinstance(proof.get('v'), bool):
    error('Staging proof is invalid', '28000')
for name, maximum in (('iss', 256), ('aud', 256), ('kid', 128), ('op', 128)):
    value = proof.get(name)
    if not isinstance(value, str) or not value or len(value) > maximum:
        error('Staging proof is invalid', '28000')
if not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', proof['kid']):
    error('Staging proof is invalid', '28000')
if not re.fullmatch(r'[a-z][a-z0-9_.-]{0,127}', proof['op']):
    error('Staging proof is invalid', '28000')
for name in ('iat', 'exp', 'auth_exp'):
    if isinstance(proof.get(name), bool) or not isinstance(proof.get(name), int):
        error('Staging proof is invalid', '28000')
if not is_uuid(proof.get('jti')) or not is_uuid(proof.get('sub')) or not is_uuid(proof.get('sid')):
    error('Staging proof is invalid', '28000')
if not isinstance(proof.get('args'), dict):
    error('Staging proof is invalid', '28000')
time_row = run(
    "SELECT pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.clock_timestamp()))::pg_catalog.int8 AS now_epoch"
)[0]
now_epoch = time_row['now_epoch']
if (
    proof['iat'] > now_epoch + 5
    or proof['iat'] < now_epoch - 65
    or proof['exp'] <= now_epoch
    or proof['exp'] <= proof['iat']
    or proof['exp'] > proof['iat'] + 60
    or proof['exp'] > now_epoch + 65
    or proof['auth_exp'] <= now_epoch
    or proof['exp'] > proof['auth_exp']
):
    error('Staging proof is invalid', '28000')
key_rows = run(
    """
    SELECT issuer, audience, public_key,
               pg_catalog.floor(pg_catalog.date_part('epoch', valid_from))::pg_catalog.int8 AS valid_from_epoch,
               pg_catalog.floor(pg_catalog.date_part('epoch', valid_until))::pg_catalog.int8 AS valid_until_epoch,
           (revoked_at IS NOT NULL) AS revoked
    FROM hirearchy.staging_verification_keys
    WHERE key_id = $1
    """,
    ['text'],
    [proof['kid']],
)
if not key_rows:
    error('Staging proof is invalid', '28000')
key = key_rows[0]
if (
    key['revoked']
    or key['issuer'] != proof['iss']
    or key['audience'] != proof['aud']
    or key['valid_from_epoch'] > proof['iat']
    or key['valid_until_epoch'] <= proof['exp']
    or key['valid_from_epoch'] > now_epoch
    or key['valid_until_epoch'] <= now_epoch
):
    error('Staging proof is invalid', '28000')
try:
    Ed25519PublicKey.from_public_bytes(bytes(key['public_key'])).verify(signature, raw_payload)
except (InvalidSignature, ValueError, TypeError):
    error('Staging proof is invalid', '28000')

auth_rows = run(
    """
        SELECT user_id::pg_catalog.text AS subject_id,
               CASE WHEN not_after IS NULL THEN NULL::pg_catalog.int8
                    ELSE pg_catalog.floor(pg_catalog.date_part('epoch', not_after))::pg_catalog.int8 END AS not_after_epoch,
               not_after IS NULL AS no_scheduled_expiry
    FROM auth.sessions
    WHERE id = $1::pg_catalog.uuid
      AND user_id = $2::pg_catalog.uuid
          AND (not_after IS NULL OR not_after > pg_catalog.clock_timestamp())
    LIMIT 1
    """,
    ['uuid', 'uuid'],
    [proof['sid'], proof['sub']],
)
if not auth_rows:
    error('Authentication session is unavailable', '28000')
effective_auth_exp = proof['auth_exp'] if auth_rows[0]['no_scheduled_expiry'] else min(proof['auth_exp'], auth_rows[0]['not_after_epoch'])

set_scope(proof['sub'], proof['sid'])
principal_rows = run(
    """
    SELECT id::pg_catalog.text AS id
    FROM hirearchy.application_principals
    WHERE auth_user_id = $1::pg_catalog.uuid
    """,
    ['uuid'],
    [proof['sub']],
)
if len(principal_rows) != 1:
    error('Application principal is unavailable', '42501')
principal_id = principal_rows[0]['id']
validate_operation_args(proof['op'], proof['args'])
args = proof['args']
organization_id = require_uuid(args.get('organizationId'), 'organization ID')
set_scope(proof['sub'], proof['sid'], principal_id, organization_id,
          args.get('reviewerPrincipalId'), args.get('sessionId'))
active_role = require_membership(
    organization_id, principal_id, ('recruiter', 'reviewer')
)
if proof['op'] == 'session.open':
    result = dispatch(proof['op'], args, proof['sub'], proof['sid'], principal_id, effective_auth_exp, proof['exp'])
else:
    require_open_session(proof['sid'], proof['sub'], principal_id, organization_id, effective_auth_exp)
    result = dispatch(proof['op'], args, proof['sub'], proof['sid'], principal_id, effective_auth_exp, proof['exp'])

run(
    "DELETE FROM hirearchy.staging_proof_nonces WHERE expires_at <= pg_catalog.clock_timestamp()"
)
nonce_rows = run(
    """
    INSERT INTO hirearchy.staging_proof_nonces (key_id, nonce, expires_at)
        VALUES ($1, $2::pg_catalog.uuid, pg_catalog.to_timestamp($3::pg_catalog.float8))
    ON CONFLICT (key_id, nonce) DO NOTHING
    RETURNING 1
    """,
    ['text', 'uuid', 'int8'],
    [proof['kid'], proof['jti'], proof['exp']],
)
if not nonce_rows:
    error('Staging proof was already used', '42501')
return json.dumps(result, ensure_ascii=False, separators=(',', ':'), allow_nan=False)

$python$;

ALTER FUNCTION staging.dispatch(pg_catalog.bytea, pg_catalog.bytea)
  OWNER TO staging_verifier_owner;
REVOKE ALL ON FUNCTION staging.dispatch(pg_catalog.bytea, pg_catalog.bytea)
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker,
       hirearchy_migrator;
REVOKE ALL ON ALL TABLES IN SCHEMA staging
  FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway,
       app_control_worker, hirearchy_migrator;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA staging
  FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway,
       app_control_worker, hirearchy_migrator;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA staging
  FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway,
       app_control_worker, hirearchy_migrator;
GRANT EXECUTE ON FUNCTION staging.dispatch(pg_catalog.bytea, pg_catalog.bytea)
  TO r23_gateway;

-- The staging login has one callable database surface and no direct product
-- table, sequence, schema, or other function privileges.
REVOKE ALL ON SCHEMA hirearchy FROM r23_gateway;
REVOKE ALL ON ALL TABLES IN SCHEMA hirearchy FROM r23_gateway;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA hirearchy FROM r23_gateway;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hirearchy FROM r23_gateway;

COMMIT;
