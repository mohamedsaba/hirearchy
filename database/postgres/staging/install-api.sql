-- Administrator-run API installation after the staging bootstrap and all
-- ordered migrations. This grants r23_gateway only the dispatcher entry point.
BEGIN;

DO $preflight$
DECLARE
  owner_role record;
  gateway_role record;
  candidate_gateway_role record;
BEGIN
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

  SELECT oid, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb,
         rolcreaterole, rolreplication, rolinherit, rolconfig
    INTO candidate_gateway_role
    FROM pg_catalog.pg_roles
    WHERE rolname = 'app_candidate_gateway';
  IF NOT FOUND
     OR NOT candidate_gateway_role.rolcanlogin
     OR candidate_gateway_role.rolsuper OR candidate_gateway_role.rolbypassrls
     OR candidate_gateway_role.rolcreatedb OR candidate_gateway_role.rolcreaterole
     OR candidate_gateway_role.rolreplication OR candidate_gateway_role.rolinherit
     OR candidate_gateway_role.rolconfig IS DISTINCT FROM
       ARRAY['search_path=pg_catalog']::pg_catalog.text[]
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_db_role_setting
       WHERE setrole = candidate_gateway_role.oid
         AND (setdatabase <> 0 OR setconfig IS DISTINCT FROM
           ARRAY['search_path=pg_catalog']::pg_catalog.text[])
     )
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid = candidate_gateway_role.oid OR member = candidate_gateway_role.oid) THEN
    RAISE EXCEPTION 'app_candidate_gateway is missing or unsafe';
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


  IF pg_catalog.to_regclass('hirearchy.durable_candidate_installation') IS NULL
     OR pg_catalog.to_regprocedure('hirearchy.r26_candidate_lifecycle_ready()') IS NULL
     OR pg_catalog.to_regprocedure('hirearchy.r26_candidate_command_unchecked(text,text,text,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('hirearchy.r26_candidate_command(text,text,text,jsonb)') IS NULL
     OR NOT pg_catalog.has_function_privilege(
       'app_candidate_gateway',
       'hirearchy.r26_candidate_lifecycle_ready()',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'app_candidate_gateway',
       'hirearchy.r26_candidate_command(text,text,text,jsonb)',
       'EXECUTE'
     )
     OR NOT EXISTS (
       SELECT 1 FROM hirearchy.schema_migrations
       WHERE version = '0016' AND applied_by = 'hirearchy_migrator'
     ) THEN
    RAISE EXCEPTION 'Durable candidate lifecycle migration must be applied before staging installation';
  END IF;
  IF pg_catalog.has_table_privilege(
       'app_candidate_gateway',
       'hirearchy.durable_candidate_installation',
       'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'app_candidate_gateway',
       'hirearchy.durable_candidate_installation',
       'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'app_candidate_gateway',
       'hirearchy.durable_candidate_installation',
       'DELETE'
     )
     OR pg_catalog.has_function_privilege(
       'app_candidate_gateway',
       'hirearchy.r26_candidate_command_unchecked(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.jsonb)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Candidate runtime has an unsafe lifecycle bypass';
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
GRANT SELECT (id, email, email_confirmed_at) ON auth.users TO staging_verifier_owner;
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
  IF (
    SELECT relrowsecurity
    FROM pg_catalog.pg_class
    WHERE oid = pg_catalog.to_regclass('auth.users')
  ) THEN
    EXECUTE 'DROP POLICY IF EXISTS staging_verifier_auth_users ON auth.users';
    EXECUTE 'CREATE POLICY staging_verifier_auth_users ON auth.users FOR SELECT TO staging_verifier_owner USING (true)';
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
    AND principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
    AND (
      organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
      OR NULLIF(pg_catalog.current_setting('staging.organization_id', true), '') IS NULL
    )
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
DROP POLICY IF EXISTS staging_verifier_principal_insert ON hirearchy.application_principals;
DROP POLICY IF EXISTS staging_verifier_principal_update ON hirearchy.application_principals;
CREATE POLICY staging_verifier_principal_select
  ON hirearchy.application_principals
  FOR SELECT TO staging_verifier_owner
  USING (
    auth_user_id = NULLIF(pg_catalog.current_setting('staging.subject_id', true), '')::pg_catalog.uuid
  );

ALTER TABLE hirearchy.organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.organization_memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staging_verifier_membership_select ON hirearchy.organization_memberships;
DROP POLICY IF EXISTS staging_verifier_membership_insert ON hirearchy.organization_memberships;
DROP POLICY IF EXISTS staging_verifier_membership_update_status ON hirearchy.organization_memberships;
CREATE POLICY staging_verifier_membership_select
  ON hirearchy.organization_memberships
  FOR SELECT TO staging_verifier_owner
  USING (
    (
      organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
      AND (
        principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
        OR principal_id = NULLIF(pg_catalog.current_setting('staging.reviewer_principal_id', true), '')::pg_catalog.uuid
        OR (
          NULLIF(pg_catalog.current_setting('staging.list_organization_reviewers', true), '') = 'true'
          AND role = 'reviewer'
          AND status = 'active'
          AND revoked_at IS NULL
        )
      )
    )
    OR (
      NULLIF(pg_catalog.current_setting('staging.organization_id', true), '') IS NULL
      AND principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
    )
  );

DROP POLICY IF EXISTS staging_verifier_organizations_select ON hirearchy.organizations;
DROP POLICY IF EXISTS staging_verifier_organizations_insert ON hirearchy.organizations;
DROP POLICY IF EXISTS staging_verifier_organizations_update ON hirearchy.organizations;
DROP POLICY IF EXISTS staging_verifier_invitations_all ON hirearchy.organization_invitations;
DROP POLICY IF EXISTS staging_verifier_receipts_all ON hirearchy.onboarding_request_receipts;

-- SELECT ... FOR SHARE needs UPDATE privilege; limit it to the caller's active
-- membership or the exact active reviewer selected by a validated issue request.
DROP POLICY IF EXISTS staging_verifier_membership_lock ON hirearchy.organization_memberships;
CREATE POLICY staging_verifier_membership_lock
  ON hirearchy.organization_memberships
  FOR UPDATE TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND status = 'active'
    AND revoked_at IS NULL
    AND (
      principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
      OR (
        principal_id = NULLIF(pg_catalog.current_setting('staging.reviewer_principal_id', true), '')::pg_catalog.uuid
        AND role = 'reviewer'
      )
    )
  )
  WITH CHECK (false);

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
    OR NULLIF(pg_catalog.current_setting('staging.organization_id', true), '') IS NULL
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
-- SELECT ... FOR SHARE needs UPDATE privilege; USING scopes locks and WITH CHECK rejects writes.
DROP POLICY IF EXISTS staging_verifier_assessment_session_lock ON hirearchy.assessment_sessions;
CREATE POLICY staging_verifier_assessment_session_lock
  ON hirearchy.assessment_sessions
  FOR UPDATE TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND id = NULLIF(pg_catalog.current_setting('staging.session_id', true), '')
    AND status = 'SUBMITTED'
    AND EXISTS (
      SELECT 1 FROM hirearchy.reviewer_assignments AS assignment
      WHERE assignment.organization_id = assessment_sessions.organization_id
        AND assignment.session_id = assessment_sessions.id
        AND assignment.reviewer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
        AND assignment.revoked_at IS NULL
    )
  )
  WITH CHECK (false);
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
DROP POLICY IF EXISTS staging_verifier_reviewer_assignment_lock ON hirearchy.reviewer_assignments;
CREATE POLICY staging_verifier_reviewer_assignment_lock
  ON hirearchy.reviewer_assignments
  FOR UPDATE TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND session_id = NULLIF(pg_catalog.current_setting('staging.session_id', true), '')
    AND reviewer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
    AND revoked_at IS NULL
    AND EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions AS session
      WHERE session.organization_id = reviewer_assignments.organization_id
        AND session.id = reviewer_assignments.session_id
        AND session.status = 'SUBMITTED'
    )
  )
  WITH CHECK (false);
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

DROP POLICY IF EXISTS staging_verifier_candidate_invitation_select ON hirearchy.candidate_token_envelopes;
CREATE POLICY staging_verifier_candidate_invitation_select
  ON hirearchy.candidate_token_envelopes
  FOR SELECT TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions AS session
      WHERE session.organization_id = candidate_token_envelopes.organization_id
        AND session.id = candidate_token_envelopes.session_id
        AND session.issuer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
    )
  );
DROP POLICY IF EXISTS staging_verifier_candidate_invitation_insert ON hirearchy.candidate_token_envelopes;
CREATE POLICY staging_verifier_candidate_invitation_insert
  ON hirearchy.candidate_token_envelopes
  FOR INSERT TO staging_verifier_owner
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND expires_at > pg_catalog.clock_timestamp()
    AND revoked_at IS NULL
    AND EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions AS session
      WHERE session.organization_id = candidate_token_envelopes.organization_id
        AND session.id = candidate_token_envelopes.session_id
        AND session.issuer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
        AND session.status = 'CREATED'
        AND session.activated_at IS NULL
    )
  );
DROP POLICY IF EXISTS staging_verifier_candidate_invitation_update ON hirearchy.candidate_token_envelopes;
CREATE POLICY staging_verifier_candidate_invitation_update
  ON hirearchy.candidate_token_envelopes
  FOR UPDATE TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions AS session
      WHERE session.organization_id = candidate_token_envelopes.organization_id
        AND session.id = candidate_token_envelopes.session_id
        AND session.issuer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
    )
  )
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND expires_at IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions AS session
      WHERE session.organization_id = candidate_token_envelopes.organization_id
        AND session.id = candidate_token_envelopes.session_id
        AND session.issuer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
    )
  );

DROP POLICY IF EXISTS staging_verifier_candidate_invitation_request_select ON hirearchy.candidate_invitation_requests;
CREATE POLICY staging_verifier_candidate_invitation_request_select
  ON hirearchy.candidate_invitation_requests
  FOR SELECT TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND issuer_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
  );
DROP POLICY IF EXISTS staging_verifier_candidate_invitation_request_insert ON hirearchy.candidate_invitation_requests;
CREATE POLICY staging_verifier_candidate_invitation_request_insert
  ON hirearchy.candidate_invitation_requests
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

DROP POLICY IF EXISTS staging_verifier_observation_write ON hirearchy.evaluator_observations;
CREATE POLICY staging_verifier_observation_write
  ON hirearchy.evaluator_observations
  FOR INSERT TO staging_verifier_owner
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND session_id = NULLIF(pg_catalog.current_setting('staging.session_id', true), '')
    AND author_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
    AND EXISTS (
      SELECT 1 FROM hirearchy.organization_memberships AS membership
      WHERE membership.organization_id = evaluator_observations.organization_id
        AND membership.principal_id = evaluator_observations.author_principal_id
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM hirearchy.reviewer_assignments AS assignment
      WHERE assignment.organization_id = evaluator_observations.organization_id
        AND assignment.session_id = evaluator_observations.session_id
        AND assignment.reviewer_principal_id = evaluator_observations.author_principal_id
        AND assignment.revoked_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions AS session
      WHERE session.organization_id = evaluator_observations.organization_id
        AND session.id = evaluator_observations.session_id
        AND session.status = 'SUBMITTED'
    )
  );
DROP POLICY IF EXISTS staging_verifier_observation_update ON hirearchy.evaluator_observations;
CREATE POLICY staging_verifier_observation_update
  ON hirearchy.evaluator_observations
  FOR UPDATE TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND session_id = NULLIF(pg_catalog.current_setting('staging.session_id', true), '')
    AND author_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
    AND EXISTS (
      SELECT 1 FROM hirearchy.organization_memberships AS membership
      WHERE membership.organization_id = evaluator_observations.organization_id
        AND membership.principal_id = evaluator_observations.author_principal_id
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM hirearchy.reviewer_assignments AS assignment
      WHERE assignment.organization_id = evaluator_observations.organization_id
        AND assignment.session_id = evaluator_observations.session_id
        AND assignment.reviewer_principal_id = evaluator_observations.author_principal_id
        AND assignment.revoked_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions AS session
      WHERE session.organization_id = evaluator_observations.organization_id
        AND session.id = evaluator_observations.session_id
        AND session.status = 'SUBMITTED'
    )
  )
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND session_id = NULLIF(pg_catalog.current_setting('staging.session_id', true), '')
    AND author_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS staging_verifier_observation_history_write ON hirearchy.evaluator_observation_history;
CREATE POLICY staging_verifier_observation_history_write
  ON hirearchy.evaluator_observation_history
  FOR INSERT TO staging_verifier_owner
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND session_id = NULLIF(pg_catalog.current_setting('staging.session_id', true), '')
    AND author_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
    AND EXISTS (
      SELECT 1 FROM hirearchy.organization_memberships AS membership
      WHERE membership.organization_id = evaluator_observation_history.organization_id
        AND membership.principal_id = evaluator_observation_history.author_principal_id
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM hirearchy.reviewer_assignments AS assignment
      WHERE assignment.organization_id = evaluator_observation_history.organization_id
        AND assignment.session_id = evaluator_observation_history.session_id
        AND assignment.reviewer_principal_id = evaluator_observation_history.author_principal_id
        AND assignment.revoked_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions AS session
      WHERE session.organization_id = evaluator_observation_history.organization_id
        AND session.id = evaluator_observation_history.session_id
        AND session.status = 'SUBMITTED'
    )
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

DROP POLICY IF EXISTS staging_verifier_review_packet_write ON hirearchy.evaluator_review_packets;
CREATE POLICY staging_verifier_review_packet_write
  ON hirearchy.evaluator_review_packets
  FOR INSERT TO staging_verifier_owner
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND session_id = NULLIF(pg_catalog.current_setting('staging.session_id', true), '')
    AND author_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
    AND EXISTS (
      SELECT 1 FROM hirearchy.organization_memberships AS membership
      WHERE membership.organization_id = evaluator_review_packets.organization_id
        AND membership.principal_id = evaluator_review_packets.author_principal_id
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM hirearchy.reviewer_assignments AS assignment
      WHERE assignment.organization_id = evaluator_review_packets.organization_id
        AND assignment.session_id = evaluator_review_packets.session_id
        AND assignment.reviewer_principal_id = evaluator_review_packets.author_principal_id
        AND assignment.revoked_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions AS session
      WHERE session.organization_id = evaluator_review_packets.organization_id
        AND session.id = evaluator_review_packets.session_id
        AND session.status = 'SUBMITTED'
    )
  );
DROP POLICY IF EXISTS staging_verifier_review_packet_update ON hirearchy.evaluator_review_packets;
CREATE POLICY staging_verifier_review_packet_update
  ON hirearchy.evaluator_review_packets
  FOR UPDATE TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND session_id = NULLIF(pg_catalog.current_setting('staging.session_id', true), '')
    AND author_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
    AND EXISTS (
      SELECT 1 FROM hirearchy.organization_memberships AS membership
      WHERE membership.organization_id = evaluator_review_packets.organization_id
        AND membership.principal_id = evaluator_review_packets.author_principal_id
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM hirearchy.reviewer_assignments AS assignment
      WHERE assignment.organization_id = evaluator_review_packets.organization_id
        AND assignment.session_id = evaluator_review_packets.session_id
        AND assignment.reviewer_principal_id = evaluator_review_packets.author_principal_id
        AND assignment.revoked_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions AS session
      WHERE session.organization_id = evaluator_review_packets.organization_id
        AND session.id = evaluator_review_packets.session_id
        AND session.status = 'SUBMITTED'
    )
  )
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND session_id = NULLIF(pg_catalog.current_setting('staging.session_id', true), '')
    AND author_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS staging_verifier_review_packet_history_write ON hirearchy.evaluator_review_packet_history;
CREATE POLICY staging_verifier_review_packet_history_write
  ON hirearchy.evaluator_review_packet_history
  FOR INSERT TO staging_verifier_owner
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
    AND session_id = NULLIF(pg_catalog.current_setting('staging.session_id', true), '')
    AND author_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
    AND EXISTS (
      SELECT 1 FROM hirearchy.organization_memberships AS membership
      WHERE membership.organization_id = evaluator_review_packet_history.organization_id
        AND membership.principal_id = evaluator_review_packet_history.author_principal_id
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM hirearchy.reviewer_assignments AS assignment
      WHERE assignment.organization_id = evaluator_review_packet_history.organization_id
        AND assignment.session_id = evaluator_review_packet_history.session_id
        AND assignment.reviewer_principal_id = evaluator_review_packet_history.author_principal_id
        AND assignment.revoked_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions AS session
      WHERE session.organization_id = evaluator_review_packet_history.organization_id
        AND session.id = evaluator_review_packet_history.session_id
        AND session.status = 'SUBMITTED'
    )
  );

GRANT USAGE ON SCHEMA hirearchy TO staging_verifier_owner;
GRANT SELECT ON hirearchy.application_principals,
  hirearchy.organization_memberships,
  hirearchy.staging_verification_keys TO staging_verifier_owner;
GRANT UPDATE (organization_id) ON hirearchy.organization_memberships TO staging_verifier_owner;
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
GRANT UPDATE (id) ON hirearchy.assessment_sessions TO staging_verifier_owner;
GRANT UPDATE (id) ON hirearchy.reviewer_assignments TO staging_verifier_owner;
REVOKE ALL ON hirearchy.candidate_token_envelopes,
  hirearchy.candidate_invitation_requests,
  hirearchy.candidate_data_consents,
  hirearchy.durable_candidate_installation
  FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway,
       app_control_worker, staging_verifier_owner;
GRANT SELECT, INSERT ON hirearchy.candidate_token_envelopes
  TO staging_verifier_owner;
GRANT UPDATE (revoked_at) ON hirearchy.candidate_token_envelopes
  TO staging_verifier_owner;
GRANT SELECT, INSERT ON hirearchy.candidate_invitation_requests
  TO staging_verifier_owner;
GRANT SELECT ON hirearchy.candidate_session_events,
  hirearchy.candidate_session_submissions,
  hirearchy.candidate_file_revisions TO staging_verifier_owner;
REVOKE ALL ON hirearchy.evaluator_observations,
  hirearchy.evaluator_observation_history,
  hirearchy.evaluator_review_packets,
  hirearchy.evaluator_review_packet_history
  FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway,
       app_control_worker, staging_verifier_owner;
GRANT SELECT, INSERT ON hirearchy.evaluator_observations,
  hirearchy.evaluator_observation_history,
  hirearchy.evaluator_review_packets,
  hirearchy.evaluator_review_packet_history TO staging_verifier_owner;
GRANT UPDATE (body, version, updated_at)
  ON hirearchy.evaluator_observations TO staging_verifier_owner;
GRANT UPDATE (
  status, summary, strengths, concerns, unresolved_questions,
  referenced_observation_ids, referenced_evidence, version,
  finalized_at, final_digest, updated_at
) ON hirearchy.evaluator_review_packets TO staging_verifier_owner;

REVOKE ALL ON hirearchy.organization_invitations,
  hirearchy.onboarding_request_receipts,
  hirearchy.durable_onboarding_installation
  FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway,
       app_control_worker, staging_verifier_owner;

CREATE OR REPLACE FUNCTION staging.onboarding_get_status(
  p_subject_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_active_count pg_catalog.int4 := 0;
BEGIN
  IF p_subject_id IS NULL THEN
    RAISE EXCEPTION 'Subject ID is required' USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_principal_id
  FROM hirearchy.application_principals
  WHERE auth_user_id = p_subject_id;

  IF v_principal_id IS NOT NULL THEN
    SELECT count(*)::pg_catalog.int4 INTO v_active_count
    FROM hirearchy.organization_memberships
    WHERE principal_id = v_principal_id
      AND status = 'active'
      AND revoked_at IS NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', CASE WHEN v_active_count = 0 THEN 'needs_team' ELSE 'has_active_membership' END,
    'hasCompletedOnboarding', (v_active_count > 0),
    'isVerified', true,
    'principalId', v_principal_id::pg_catalog.text,
    'activeOrganizationCount', v_active_count,
    'capabilities', pg_catalog.jsonb_build_object(
      'selfServiceOnboardingEnabled', true,
      'emailDeliveryEnabled', false
    )
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.onboarding_bootstrap_organization(
  p_subject_id pg_catalog.uuid,
  p_email pg_catalog.text,
  p_display_name pg_catalog.text,
  p_idempotency_key pg_catalog.text,
  p_request_digest pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_confirmed boolean;
  v_display_name pg_catalog.text;
  v_receipt record;
  v_principal_id pg_catalog.uuid;
  v_org_id pg_catalog.uuid;
  v_response pg_catalog.jsonb;
BEGIN
  IF p_subject_id IS NULL THEN
    RAISE EXCEPTION 'Subject ID is required' USING ERRCODE = '22023';
  END IF;

  SELECT (email_confirmed_at IS NOT NULL) INTO v_confirmed
  FROM auth.users
  WHERE id = p_subject_id;

  IF NOT FOUND OR NOT v_confirmed THEN
    RAISE EXCEPTION 'Email confirmation is required' USING ERRCODE = '42501';
  END IF;

  IF p_display_name IS NULL THEN
    RAISE EXCEPTION 'Organization display name is invalid' USING ERRCODE = '22023';
  END IF;
  v_display_name := trim(p_display_name);
  IF length(v_display_name) < 1 OR length(v_display_name) > 120 OR v_display_name ~ '[\x00-\x1f\x7f-\x9f]' THEN
    RAISE EXCEPTION 'Organization display name is invalid' USING ERRCODE = '22023';
  END IF;

  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9._~-]{1,128}$' THEN
    RAISE EXCEPTION 'Idempotency key is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT request_digest, response_payload INTO v_receipt
  FROM hirearchy.onboarding_request_receipts
  WHERE subject_id = p_subject_id
    AND operation = 'organization.bootstrap'
    AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_receipt.request_digest <> p_request_digest THEN
      RAISE EXCEPTION 'Idempotency key already exists with different request parameters' USING ERRCODE = '22023';
    END IF;
    RETURN v_receipt.response_payload;
  END IF;

  SELECT id INTO v_principal_id
  FROM hirearchy.application_principals
  WHERE auth_user_id = p_subject_id;

  IF v_principal_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM hirearchy.organization_memberships
      WHERE principal_id = v_principal_id
        AND status = 'active'
        AND revoked_at IS NULL
    ) THEN
      RAISE EXCEPTION 'User already has an active organization membership' USING ERRCODE = '42501';
    END IF;
  ELSE
    v_principal_id := pg_catalog.gen_random_uuid();
    INSERT INTO hirearchy.application_principals (id, auth_user_id, display_name)
    VALUES (v_principal_id, p_subject_id, NULL);
  END IF;

  v_org_id := pg_catalog.gen_random_uuid();
  INSERT INTO hirearchy.organizations (id, owner_principal_id, display_name)
  VALUES (v_org_id, v_principal_id, v_display_name);

  INSERT INTO hirearchy.organization_memberships (
    organization_id, principal_id, role, status, joined_at, version
  ) VALUES (
    v_org_id, v_principal_id, 'recruiter', 'active',
    pg_catalog.clock_timestamp(), 1
  );

  v_response := pg_catalog.jsonb_build_object(
    'organizationId', v_org_id::pg_catalog.text,
    'displayName', v_display_name,
    'role', 'recruiter',
    'isOwner', true,
    'emailDeliveryEnabled', false
  );

  INSERT INTO hirearchy.onboarding_request_receipts (
    subject_id, operation, idempotency_key, request_digest, response_payload
  ) VALUES (
    p_subject_id, 'organization.bootstrap', p_idempotency_key, p_request_digest, v_response
  );

  RETURN v_response;
END
$function$;

CREATE OR REPLACE FUNCTION staging.onboarding_create_invitation(
  p_subject_id pg_catalog.uuid,
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_target_email pg_catalog.text,
  p_expires_at_str pg_catalog.text,
  p_idempotency_key pg_catalog.text,
  p_request_digest pg_catalog.text,
  p_token_hash pg_catalog.text,
  p_token_ciphertext pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_owner_id pg_catalog.uuid;
  v_receipt record;
  v_expires_at pg_catalog.timestamptz;
  v_formatted_expiry pg_catalog.text;
  v_invitation_id pg_catalog.uuid;
  v_canonical_email pg_catalog.text;
  v_response pg_catalog.jsonb;
BEGIN
  IF p_organization_id IS NULL OR p_caller_principal_id IS NULL THEN
    RAISE EXCEPTION 'Staging request is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT owner_principal_id INTO v_owner_id
  FROM hirearchy.organizations
  WHERE id = p_organization_id;

  IF NOT FOUND OR v_owner_id <> p_caller_principal_id THEN
    RAISE EXCEPTION 'Invitation creation requires owner permission' USING ERRCODE = '42501';
  END IF;

  IF p_target_email IS NULL THEN
    RAISE EXCEPTION 'Target email address is invalid' USING ERRCODE = '22023';
  END IF;
  v_canonical_email := lower(trim(p_target_email));
  IF length(v_canonical_email) > 255 OR v_canonical_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Target email address is invalid' USING ERRCODE = '22023';
  END IF;

  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9._~-]{1,128}$' THEN
    RAISE EXCEPTION 'Idempotency key is invalid' USING ERRCODE = '22023';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invitation token hash is invalid' USING ERRCODE = '22023';
  END IF;

  IF p_token_ciphertext IS NULL OR length(p_token_ciphertext) < 1 OR length(p_token_ciphertext) > 4096 THEN
    RAISE EXCEPTION 'Invitation ciphertext is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT request_digest, response_payload INTO v_receipt
  FROM hirearchy.onboarding_request_receipts
  WHERE subject_id = p_subject_id
    AND operation = 'organization.invitation.create'
    AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_receipt.request_digest <> p_request_digest THEN
      RAISE EXCEPTION 'Idempotency key already exists with different request parameters' USING ERRCODE = '22023';
    END IF;
    RETURN v_receipt.response_payload;
  END IF;

  BEGIN
    v_expires_at := p_expires_at_str::pg_catalog.timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invitation expiry must be in the future and at most 30 days' USING ERRCODE = '22023';
  END;

  IF v_expires_at <= pg_catalog.clock_timestamp() OR v_expires_at > pg_catalog.clock_timestamp() + INTERVAL '30 days' THEN
    RAISE EXCEPTION 'Invitation expiry must be in the future and at most 30 days' USING ERRCODE = '22023';
  END IF;

  v_formatted_expiry := pg_catalog.to_char(v_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  v_invitation_id := pg_catalog.gen_random_uuid();

  INSERT INTO hirearchy.organization_invitations (
    id, organization_id, inviter_principal_id, target_email, role,
    token_hash, token_ciphertext, expires_at
  ) VALUES (
    v_invitation_id, p_organization_id, p_caller_principal_id, v_canonical_email,
    'reviewer', p_token_hash, p_token_ciphertext, v_expires_at
  );

  v_response := pg_catalog.jsonb_build_object(
    'invitationId', v_invitation_id::pg_catalog.text,
    'organizationId', p_organization_id::pg_catalog.text,
    'targetEmail', v_canonical_email,
    'role', 'reviewer',
    'expiresAt', v_formatted_expiry,
    'emailDeliveryEnabled', false
  );

  INSERT INTO hirearchy.onboarding_request_receipts (
    subject_id, operation, idempotency_key, request_digest, response_payload
  ) VALUES (
    p_subject_id, 'organization.invitation.create', p_idempotency_key, p_request_digest, v_response
  );

  RETURN v_response;
END
$function$;

CREATE OR REPLACE FUNCTION staging.onboarding_list_invitations(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_owner_id pg_catalog.uuid;
  v_is_owner boolean;
  v_invitations pg_catalog.jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM hirearchy.organization_memberships
    WHERE organization_id = p_organization_id
      AND principal_id = p_caller_principal_id
      AND status = 'active'
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Organization access denied' USING ERRCODE = '42501';
  END IF;

  SELECT owner_principal_id INTO v_owner_id
  FROM hirearchy.organizations
  WHERE id = p_organization_id;

  v_is_owner := (v_owner_id = p_caller_principal_id);

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', id::pg_catalog.text,
        'targetEmail', target_email,
        'role', role,
        'status', CASE
          WHEN revoked_at IS NOT NULL THEN 'revoked'
          WHEN accepted_at IS NOT NULL THEN 'accepted'
          WHEN expires_at <= pg_catalog.clock_timestamp() THEN 'expired'
          ELSE 'active'
        END,
        'expiresAt', pg_catalog.to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'createdAt', pg_catalog.to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'acceptedAt', CASE WHEN accepted_at IS NULL THEN NULL
                           ELSE pg_catalog.to_char(accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
        'tokenCiphertext', CASE WHEN v_is_owner THEN token_ciphertext ELSE NULL END
      ) ORDER BY created_at DESC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_invitations
  FROM hirearchy.organization_invitations
  WHERE organization_id = p_organization_id;

  RETURN pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id::pg_catalog.text,
    'invitations', v_invitations
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.onboarding_revoke_invitation(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_invitation_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_owner_id pg_catalog.uuid;
BEGIN
  SELECT owner_principal_id INTO v_owner_id
  FROM hirearchy.organizations
  WHERE id = p_organization_id;

  IF NOT FOUND OR v_owner_id <> p_caller_principal_id THEN
    RAISE EXCEPTION 'Invitation revocation requires owner permission' USING ERRCODE = '42501';
  END IF;

  UPDATE hirearchy.organization_invitations
  SET revoked_at = pg_catalog.clock_timestamp()
  WHERE organization_id = p_organization_id
    AND id = p_invitation_id
    AND revoked_at IS NULL;

  RETURN pg_catalog.jsonb_build_object(
    'invitationId', p_invitation_id::pg_catalog.text,
    'status', 'revoked'
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.onboarding_accept_invitation(
  p_subject_id pg_catalog.uuid,
  p_email pg_catalog.text,
  p_token_hash pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_confirmed boolean;
  v_inv record;
  v_principal_id pg_catalog.uuid;
BEGIN
  IF p_subject_id IS NULL THEN
    RAISE EXCEPTION 'Subject ID is required' USING ERRCODE = '22023';
  END IF;

  SELECT (email_confirmed_at IS NOT NULL) INTO v_confirmed
  FROM auth.users
  WHERE id = p_subject_id;

  IF NOT FOUND OR NOT v_confirmed THEN
    RAISE EXCEPTION 'Email confirmation is required' USING ERRCODE = '42501';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invitation token hash is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT id, organization_id, target_email, role,
         (revoked_at IS NOT NULL) AS is_revoked,
         (expires_at <= pg_catalog.clock_timestamp()) AS is_expired,
         (accepted_at IS NOT NULL) AS is_accepted,
         accepted_by_principal_id
  INTO v_inv
  FROM hirearchy.organization_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.is_revoked THEN
    RAISE EXCEPTION 'Invitation has been revoked' USING ERRCODE = '42501';
  END IF;
  IF v_inv.is_expired THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '42501';
  END IF;
  IF lower(trim(p_email)) <> lower(trim(v_inv.target_email)) THEN
    RAISE EXCEPTION 'Invitation is bound to a different email address' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_principal_id
  FROM hirearchy.application_principals
  WHERE auth_user_id = p_subject_id;

  IF v_inv.is_accepted THEN
    IF v_principal_id IS NOT NULL AND v_inv.accepted_by_principal_id = v_principal_id THEN
      IF EXISTS (
        SELECT 1 FROM hirearchy.organization_memberships
        WHERE organization_id = v_inv.organization_id
          AND principal_id = v_principal_id
          AND status = 'active'
          AND revoked_at IS NULL
      ) THEN
        RETURN pg_catalog.jsonb_build_object(
          'organizationId', v_inv.organization_id::pg_catalog.text,
          'role', 'reviewer',
          'status', 'accepted'
        );
      END IF;
    END IF;
    RAISE EXCEPTION 'Invitation has already been accepted' USING ERRCODE = '42501';
  END IF;

  IF v_principal_id IS NULL THEN
    v_principal_id := pg_catalog.gen_random_uuid();
    INSERT INTO hirearchy.application_principals (id, auth_user_id, display_name)
    VALUES (v_principal_id, p_subject_id, NULL);
  END IF;

  IF EXISTS (
    SELECT 1 FROM hirearchy.organization_memberships
    WHERE organization_id = v_inv.organization_id
      AND principal_id = v_principal_id
  ) THEN
    RAISE EXCEPTION 'User already has a membership in this organization' USING ERRCODE = '42501';
  END IF;

  INSERT INTO hirearchy.organization_memberships (
    organization_id, principal_id, role, status, joined_at, version
  ) VALUES (
    v_inv.organization_id, v_principal_id, 'reviewer', 'active',
    pg_catalog.clock_timestamp(), 1
  );

  UPDATE hirearchy.organization_invitations
  SET accepted_at = pg_catalog.clock_timestamp(),
      accepted_by_principal_id = v_principal_id
  WHERE id = v_inv.id;

  RETURN pg_catalog.jsonb_build_object(
    'organizationId', v_inv.organization_id::pg_catalog.text,
    'role', 'reviewer',
    'status', 'accepted'
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.onboarding_list_members(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_members pg_catalog.jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM hirearchy.organization_memberships
    WHERE organization_id = p_organization_id
      AND principal_id = p_caller_principal_id
      AND status = 'active'
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Organization access denied' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'principalId', m.principal_id::pg_catalog.text,
        'displayName', p.display_name,
        'email', u.email,
        'role', m.role,
        'status', m.status,
        'joinedAt', pg_catalog.to_char(m.joined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'isOwner', (o.owner_principal_id = m.principal_id)
      ) ORDER BY (o.owner_principal_id = m.principal_id) DESC, m.joined_at ASC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_members
  FROM hirearchy.organization_memberships m
  JOIN hirearchy.application_principals p ON p.id = m.principal_id
  LEFT JOIN auth.users u ON u.id = p.auth_user_id
  JOIN hirearchy.organizations o ON o.id = m.organization_id
  WHERE m.organization_id = p_organization_id;

  RETURN pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id::pg_catalog.text,
    'members', v_members
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.onboarding_remove_member(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_target_principal_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_owner_id pg_catalog.uuid;
BEGIN
  SELECT owner_principal_id INTO v_owner_id
  FROM hirearchy.organizations
  WHERE id = p_organization_id;

  IF NOT FOUND OR v_owner_id <> p_caller_principal_id THEN
    RAISE EXCEPTION 'Member removal requires owner permission' USING ERRCODE = '42501';
  END IF;

  IF p_target_principal_id = p_caller_principal_id OR p_target_principal_id = v_owner_id THEN
    RAISE EXCEPTION 'Cannot remove or demote the organization owner' USING ERRCODE = '42501';
  END IF;

  UPDATE hirearchy.organization_memberships
  SET status = 'revoked', revoked_at = pg_catalog.clock_timestamp()
  WHERE organization_id = p_organization_id
    AND principal_id = p_target_principal_id
    AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active membership not found for target principal' USING ERRCODE = '22023';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id::pg_catalog.text,
    'principalId', p_target_principal_id::pg_catalog.text,
    'status', 'revoked'
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.onboarding_update_organization(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_display_name pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_owner_id pg_catalog.uuid;
  v_display_name pg_catalog.text;
BEGIN
  SELECT owner_principal_id INTO v_owner_id
  FROM hirearchy.organizations
  WHERE id = p_organization_id;

  IF NOT FOUND OR v_owner_id <> p_caller_principal_id THEN
    RAISE EXCEPTION 'Organization update requires owner permission' USING ERRCODE = '42501';
  END IF;

  IF p_display_name IS NULL THEN
    RAISE EXCEPTION 'Organization display name is invalid' USING ERRCODE = '22023';
  END IF;
  v_display_name := trim(p_display_name);
  IF length(v_display_name) < 1 OR length(v_display_name) > 120 OR v_display_name ~ '[\x00-\x1f\x7f-\x9f]' THEN
    RAISE EXCEPTION 'Organization display name is invalid' USING ERRCODE = '22023';
  END IF;

  UPDATE hirearchy.organizations
  SET display_name = v_display_name
  WHERE id = p_organization_id;

  RETURN pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id::pg_catalog.text,
    'displayName', v_display_name
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.onboarding_get_profile(
  p_principal_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_profile pg_catalog.jsonb;
BEGIN
  SELECT pg_catalog.jsonb_build_object(
    'principalId', p.id::pg_catalog.text,
    'displayName', p.display_name,
    'email', u.email
  ) INTO v_profile
  FROM hirearchy.application_principals p
  JOIN auth.users u ON u.id = p.auth_user_id
  WHERE p.id = p_principal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account profile unavailable' USING ERRCODE = '22023';
  END IF;

  RETURN v_profile;
END
$function$;

CREATE OR REPLACE FUNCTION staging.onboarding_update_profile(
  p_principal_id pg_catalog.uuid,
  p_display_name pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_display_name pg_catalog.text;
BEGIN
  IF p_display_name IS NULL THEN
    RAISE EXCEPTION 'Profile display name is invalid' USING ERRCODE = '22023';
  END IF;
  v_display_name := trim(p_display_name);
  IF length(v_display_name) < 1 OR length(v_display_name) > 120 OR v_display_name ~ '[\x00-\x1f\x7f-\x9f]' THEN
    RAISE EXCEPTION 'Profile display name is invalid' USING ERRCODE = '22023';
  END IF;

  UPDATE hirearchy.application_principals
  SET display_name = v_display_name
  WHERE id = p_principal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account profile unavailable' USING ERRCODE = '22023';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'principalId', p_principal_id::pg_catalog.text,
    'displayName', v_display_name
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.onboarding_list_user_memberships(
  p_principal_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_items pg_catalog.jsonb;
BEGIN
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'organizationId', m.organization_id::pg_catalog.text,
    'role', m.role,
    'version', m.version,
    'displayName', o.display_name,
    'isOwner', (o.owner_principal_id = m.principal_id)
  ) ORDER BY m.organization_id), '[]'::pg_catalog.jsonb)
  INTO v_items
  FROM hirearchy.organization_memberships AS m
  LEFT JOIN hirearchy.organizations AS o ON o.id = m.organization_id
  WHERE m.principal_id = p_principal_id
    AND m.status = 'active'
    AND m.revoked_at IS NULL;

  RETURN v_items;
END
$function$;

CREATE OR REPLACE FUNCTION staging.onboarding_get_organization_metadata(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_meta pg_catalog.jsonb;
BEGIN
  SELECT pg_catalog.jsonb_build_object(
    'displayName', display_name,
    'isOwner', (owner_principal_id = p_caller_principal_id)
  ) INTO v_meta
  FROM hirearchy.organizations
  WHERE id = p_organization_id;

  RETURN v_meta;
END
$function$;

GRANT EXECUTE ON FUNCTION staging.onboarding_get_status(pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.onboarding_bootstrap_organization(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.onboarding_create_invitation(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.onboarding_list_invitations(pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.onboarding_revoke_invitation(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.onboarding_accept_invitation(pg_catalog.uuid, pg_catalog.text, pg_catalog.text) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.onboarding_list_members(pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.onboarding_remove_member(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.onboarding_update_organization(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.onboarding_get_profile(pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.onboarding_update_profile(pg_catalog.uuid, pg_catalog.text) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.onboarding_list_user_memberships(pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.onboarding_get_organization_metadata(pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;

REVOKE ALL ON FUNCTION staging.onboarding_get_status(pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.onboarding_bootstrap_organization(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.onboarding_create_invitation(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.onboarding_list_invitations(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.onboarding_revoke_invitation(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.onboarding_accept_invitation(pg_catalog.uuid, pg_catalog.text, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.onboarding_list_members(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.onboarding_remove_member(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.onboarding_update_organization(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.onboarding_get_profile(pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.onboarding_update_profile(pg_catalog.uuid, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.onboarding_list_user_memberships(pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.onboarding_get_organization_metadata(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;


CREATE OR REPLACE FUNCTION staging.dispatch(p_payload pg_catalog.bytea, p_signature pg_catalog.bytea)
RETURNS pg_catalog.jsonb
LANGUAGE plpython3u
SECURITY DEFINER
SET search_path = pg_catalog, staging
AS $python$
import hashlib
import json
import re
import uuid

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

def sha256_hex(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()

MAX_PAYLOAD_BYTES = 1048576
MAX_SAFE_INTEGER = 9007199254740991
CLAIM_KEYS = {'v', 'isRecovery', 'iss', 'aud', 'kid', 'iat', 'exp', 'auth_exp', 'jti', 'sub', 'sid', 'op', 'args'}
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

def safe_json_value(value):
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except ValueError:
        return value

def set_context(name, value):
    run(
        "SELECT pg_catalog.set_config($1, $2, true)",
        ['text', 'text'],
        [name, '' if value is None else str(value)],
    )

def set_scope(subject_id, auth_session_id, principal_id=None, organization_id=None,
              reviewer_principal_id=None, session_id=None, list_organization_reviewers=None,
              list_organization_members=None):
    values = {
        'staging.subject_id': subject_id,
        'staging.auth_session_id': auth_session_id,
        'staging.principal_id': principal_id,
        'staging.organization_id': organization_id,
        'staging.reviewer_principal_id': reviewer_principal_id,
        'staging.session_id': session_id,
        'staging.list_organization_reviewers': list_organization_reviewers,
        'staging.list_organization_members': list_organization_members,
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
        FOR SHARE
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
        'membership.list': ((), ()),
        'organization.context': (('organizationId',), ()),
        'session.open': (('organizationId',), ()),
        'session.revoke': (('organizationId',), ()),
        'assessment.create': (('organizationId', 'content'), ('assessmentId',)),
        'assessment.get': (('organizationId', 'assessmentId'), ()),
        'assessment.validate': (('organizationId', 'assessmentId', 'content', 'validatedVersion'), ()),
        'assessment.issue': (('organizationId', 'assessmentId', 'reviewerPrincipalId'), ()),
        'candidate.invitation.create': (('organizationId', 'sessionId', 'expiresAt', 'idempotencyKey', 'candidateTokenHash', 'candidateTokenCiphertext'), ()),
        'candidate.invitation.get': (('organizationId', 'sessionId'), ()),
        'candidate.invitation.revoke': (('organizationId', 'sessionId'), ()),
        'evidence.read': (('organizationId', 'sessionId'), ()),
        'review.read': (('organizationId', 'sessionId'), ()),
        'evidence.observation.create': (('organizationId', 'sessionId', 'input'), ()),
        'evidence.observation.update': (('organizationId', 'sessionId', 'observationId', 'input'), ()),
        'review.packet.save': (('organizationId', 'sessionId', 'input'), ()),
        'review.packet.finalize': (('organizationId', 'sessionId', 'input'), ()),
        'onboarding.status': ((), ()),
        'organization.bootstrap': (('displayName', 'idempotencyKey'), ()),
        'organization.invitation.accept': (('invitationTokenHash',), ()),
        'organization.invitation.create': (('organizationId', 'targetEmail', 'expiresAt', 'idempotencyKey', 'invitationTokenHash', 'invitationTokenCiphertext'), ()),
        'organization.invitation.list': (('organizationId',), ()),
        'organization.invitation.revoke': (('organizationId', 'invitationId'), ()),
        'organization.update': (('organizationId', 'displayName'), ()),
        'organization.members.list': (('organizationId',), ()),
        'organization.member.remove': (('organizationId', 'targetPrincipalId'), ()),
        'account.profile.get': ((), ()),
        'account.profile.update': (('displayName',), ()),
    }
    if operation not in schemas:
        error('Staging operation is unavailable', '22023')
    required, optional = schemas[operation]
    require_args(args, required, optional)

def candidate_invitation_view(session_id, replayed=None):
    rows = run(
        """
        SELECT CASE
                 WHEN envelope.revoked_at IS NOT NULL THEN 'revoked'
                 WHEN envelope.expires_at IS NULL THEN 'unmanaged'
                 WHEN envelope.expires_at <= pg_catalog.clock_timestamp() THEN 'expired'
                 ELSE 'active'
               END AS status,
               CASE WHEN envelope.expires_at IS NULL THEN NULL
                    ELSE pg_catalog.to_char(
                      envelope.expires_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                    ) END AS expires_at,
               CASE WHEN envelope.revoked_at IS NULL
                          AND envelope.expires_at > pg_catalog.clock_timestamp()
                    THEN envelope.candidate_token_ciphertext
                    ELSE NULL END AS candidate_token_ciphertext
        FROM hirearchy.candidate_token_envelopes AS envelope
        WHERE envelope.session_id = $1
        """,
        ['text'],
        [session_id],
    )
    if not rows:
        return {
            'sessionId': session_id,
            'status': 'not_created',
            'expiresAt': None,
            'candidateTokenCiphertext': None,
            'replayed': replayed,
        }
    return {
        'sessionId': session_id,
        'status': rows[0]['status'],
        'expiresAt': rows[0]['expires_at'],
        'candidateTokenCiphertext': rows[0]['candidate_token_ciphertext'],
        'replayed': replayed,
    }

def validate_review_references(organization_id, session_id, principal_id,
                              observation_ids, evidence_references):
    if not isinstance(observation_ids, list) or not isinstance(evidence_references, list):
        error('Review packet references are invalid', 'R2101')
    for observation_id in observation_ids:
        if not is_uuid(observation_id):
            error('Invalid observation reference', 'R2102')
        rows = run(
            """
            SELECT 1 FROM hirearchy.evaluator_observations
            WHERE id = $1::pg_catalog.uuid
              AND organization_id = $2::pg_catalog.uuid
              AND session_id = $3
              AND author_principal_id = $4::pg_catalog.uuid
            """,
            ['uuid', 'uuid', 'text', 'uuid'],
            [observation_id, organization_id, session_id, principal_id],
        )
        if not rows:
            error('Invalid observation reference', 'R2102')

    for reference in evidence_references:
        if not exact_keys(
            reference,
            ('evidenceSourceType', 'eventSequence', 'filePath', 'fileVersion', 'evidenceDigest'),
            ('label',),
        ):
            error('Invalid evidence reference', 'R2102')
        source_type = reference.get('evidenceSourceType')
        sequence = reference.get('eventSequence')
        evidence_digest = reference.get('evidenceDigest')
        if (
            source_type not in ('timeline_event', 'file_revision')
            or not isinstance(sequence, str)
            or not re.fullmatch(r'[1-9][0-9]{0,18}', sequence)
            or int(sequence) > 9223372036854775807
            or not isinstance(evidence_digest, str)
            or not re.fullmatch(r'[0-9a-f]{64}', evidence_digest)
        ):
            error('Invalid evidence reference', 'R2102')
        if source_type == 'timeline_event':
            if reference.get('filePath') is not None or reference.get('fileVersion') is not None:
                error('Invalid timeline event reference', 'R2102')
            rows = run(
                """
                SELECT payload FROM hirearchy.candidate_session_events
                WHERE organization_id = $1::pg_catalog.uuid
                  AND session_id = $2
                  AND sequence = $3::pg_catalog.int8
                """,
                ['uuid', 'text', 'int8'],
                [organization_id, session_id, sequence],
            )
            if not rows:
                error('Referenced timeline event not found', 'R2102')
            payload = json_value(rows[0]['payload'])
            payload_digest = run(
                """SELECT pg_catalog.encode(
                     pg_catalog.sha256(pg_catalog.convert_to($1::pg_catalog.jsonb::pg_catalog.text, 'UTF8')),
                     'hex'
                   ) AS value""",
                ['text'],
                [json.dumps(payload, ensure_ascii=False)],
            )[0]['value']
            if evidence_digest not in (
                payload.get('digest'), payload.get('scenarioDigest'),
                payload.get('workspaceDigest'), payload.get('manifestDigest'),
                payload_digest,
            ):
                error('Timeline event evidence digest mismatch', 'R2102')
        else:
            file_path = reference.get('filePath')
            file_version = reference.get('fileVersion')
            if (
                not isinstance(file_path, str) or not file_path.strip()
                or not isinstance(file_version, str)
                or not re.fullmatch(r'[1-9][0-9]{0,18}', file_version)
                or int(file_version) > 9223372036854775807
            ):
                error('Invalid file revision reference', 'R2102')
            rows = run(
                """
                SELECT content_digest FROM hirearchy.candidate_file_revisions
                WHERE organization_id = $1::pg_catalog.uuid
                  AND session_id = $2
                  AND event_sequence = $3::pg_catalog.int8
                  AND file_path = $4
                  AND version = $5::pg_catalog.int8
                """,
                ['uuid', 'text', 'int8', 'text', 'int8'],
                [organization_id, session_id, sequence, file_path, file_version],
            )
            if not rows or rows[0]['content_digest'] != evidence_digest:
                error('File revision evidence digest mismatch', 'R2102')

def staging_review_packet(packet_id):
    rows = run(
        """
        SELECT pg_catalog.jsonb_build_object(
          'id', packet.id::pg_catalog.text,
          'organizationId', packet.organization_id::pg_catalog.text,
          'sessionId', packet.session_id,
          'authorPrincipalId', packet.author_principal_id::pg_catalog.text,
          'status', packet.status,
          'summary', packet.summary,
          'strengths', packet.strengths,
          'concerns', packet.concerns,
          'unresolvedQuestions', packet.unresolved_questions,
          'referencedObservationIds', packet.referenced_observation_ids,
          'referencedEvidence', packet.referenced_evidence,
          'version', packet.version,
          'createdAt', pg_catalog.to_char(packet.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'updatedAt', pg_catalog.to_char(packet.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'finalizedAt', CASE WHEN packet.finalized_at IS NULL THEN NULL ELSE pg_catalog.to_char(packet.finalized_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
          'finalDigest', packet.final_digest,
          'history', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'historyId', history.history_id::pg_catalog.text,
              'packetId', history.packet_id::pg_catalog.text,
              'organizationId', history.organization_id::pg_catalog.text,
              'sessionId', history.session_id,
              'authorPrincipalId', history.author_principal_id::pg_catalog.text,
              'status', history.status,
              'version', history.version,
              'summary', history.summary,
              'strengths', history.strengths,
              'concerns', history.concerns,
              'unresolvedQuestions', history.unresolved_questions,
              'referencedObservationIds', history.referenced_observation_ids,
              'referencedEvidence', history.referenced_evidence,
              'finalizedAt', CASE WHEN history.finalized_at IS NULL THEN NULL ELSE pg_catalog.to_char(history.finalized_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
              'finalDigest', history.final_digest,
              'validFrom', pg_catalog.to_char(history.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
              'validUntil', pg_catalog.to_char(history.valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
              'recordedAt', pg_catalog.to_char(history.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            ) ORDER BY history.version)
            FROM hirearchy.evaluator_review_packet_history AS history
            WHERE history.packet_id = packet.id
          ), '[]'::pg_catalog.jsonb)
        ) AS packet
        FROM hirearchy.evaluator_review_packets AS packet
        WHERE packet.id = $1::pg_catalog.uuid
        """,
        ['uuid'],
        [packet_id],
    )
    return json_value(rows[0]['packet']) if rows else None

def dispatch(operation, args, subject_id, auth_session_id, principal_id, auth_exp, proof_exp):
    if operation == 'membership.list':
        set_scope(subject_id, auth_session_id, principal_id)
        revoked_rows = run(
            """
            SELECT 1
            FROM hirearchy.staging_sessions
            WHERE auth_session_id = $1::pg_catalog.uuid
              AND subject_id = $2::pg_catalog.uuid
              AND principal_id = $3::pg_catalog.uuid
              AND (revoked_at IS NOT NULL OR expires_at <= pg_catalog.clock_timestamp())
            LIMIT 1
            """,
            ['uuid', 'uuid', 'uuid'],
            [auth_session_id, subject_id, principal_id],
        )
        if revoked_rows:
            error('Staging session is unavailable', '28000')
        rows = run(
            "SELECT staging.onboarding_list_user_memberships($1::pg_catalog.uuid) AS items",
            ['uuid'],
            [principal_id],
        )
        return {
            'principalId': principal_id,
            'memberships': safe_json_value(rows[0]['items']),
        }

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

    if operation in ('candidate.invitation.create', 'candidate.invitation.get', 'candidate.invitation.revoke'):
        if role != 'recruiter':
            error('Recruiter membership required', '42501')
        session_id = args.get('sessionId')
        if not isinstance(session_id, str) or not re.fullmatch(r'sess_[A-Za-z0-9_-]{1,128}', session_id):
            error('Staging request is invalid', '22023')

        run(
            "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
            ['text'],
            ['r26-candidate:' + session_id],
        )
        session_rows = run(
            """
            SELECT session.status, session.activated_at
            FROM hirearchy.assessment_sessions AS session
            WHERE session.organization_id = $1::pg_catalog.uuid
              AND session.id = $2
              AND session.issuer_principal_id = $3::pg_catalog.uuid
            """,
            ['uuid', 'text', 'uuid'],
            [organization_id, session_id, principal_id],
        )
        if not session_rows:
            error('Recruiter-issued assessment is unavailable', '42501')

        if operation == 'candidate.invitation.get':
            run(
                """
                SELECT envelope.session_id
                FROM hirearchy.candidate_token_envelopes AS envelope
                WHERE envelope.organization_id = $1::pg_catalog.uuid
                  AND envelope.session_id = $2
                FOR UPDATE
                """,
                ['uuid', 'text'],
                [organization_id, session_id],
            )
            return candidate_invitation_view(session_id)

        if operation == 'candidate.invitation.revoke':
            envelope_rows = run(
                """
                SELECT expires_at, revoked_at
                FROM hirearchy.candidate_token_envelopes AS envelope
                WHERE envelope.organization_id = $1::pg_catalog.uuid
                  AND envelope.session_id = $2
                FOR UPDATE
                """,
                ['uuid', 'text'],
                [organization_id, session_id],
            )
            if not envelope_rows:
                return {'sessionId': session_id, 'status': 'not_created'}
            if envelope_rows[0]['expires_at'] is None:
                return {'sessionId': session_id, 'status': 'unmanaged'}
            if envelope_rows[0]['revoked_at'] is None:
                run(
                    """
                    UPDATE hirearchy.candidate_token_envelopes
                    SET revoked_at = pg_catalog.clock_timestamp()
                    WHERE organization_id = $1::pg_catalog.uuid
                      AND session_id = $2
                      AND revoked_at IS NULL
                    """,
                    ['uuid', 'text'],
                    [organization_id, session_id],
                )
            return {'sessionId': session_id, 'status': 'revoked'}

        expires_at = args.get('expiresAt')
        idempotency_key = args.get('idempotencyKey')
        token_hash = args.get('candidateTokenHash')
        token_ciphertext = args.get('candidateTokenCiphertext')
        if (
            not isinstance(expires_at, str)
            or not isinstance(idempotency_key, str)
            or not re.fullmatch(r'[A-Za-z0-9._~-]{1,128}', idempotency_key)
            or not isinstance(token_hash, str)
            or not re.fullmatch(r'[0-9a-f]{64}', token_hash)
            or not isinstance(token_ciphertext, str)
            or not re.fullmatch(r'v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{58}\.[A-Za-z0-9_-]{22}', token_ciphertext)
        ):
            error('Staging request is invalid', '22023')

        normalized_expiry = run(
            """
            SELECT pg_catalog.to_char(
                     $1::pg_catalog.timestamptz AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                   ) AS expires_at
            """,
            ['text'],
            [expires_at],
        )[0]
        if normalized_expiry['expires_at'] != expires_at:
            error('Staging request is invalid', '22023')

        fingerprint_payload = json.dumps(
            {
                'organizationId': organization_id,
                'sessionId': session_id,
                'expiresAt': expires_at,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(',', ':'),
        )
        request_hash = run(
            "SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to($1, 'UTF8')), 'hex') AS value",
            ['text'],
            [fingerprint_payload],
        )[0]['value']
        run(
            "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
            ['text'],
            ['r26-candidate-invitation-key:' + organization_id + ':' + idempotency_key],
        )
        existing_request = run(
            """
            SELECT session_id, issuer_principal_id::pg_catalog.text AS issuer_id,
                   request_hash
            FROM hirearchy.candidate_invitation_requests
            WHERE organization_id = $1::pg_catalog.uuid
              AND idempotency_key = $2
            """,
            ['uuid', 'text'],
            [organization_id, idempotency_key],
        )
        if existing_request:
            prior = existing_request[0]
            if (
                prior['session_id'] != session_id
                or prior['issuer_id'] != principal_id
                or prior['request_hash'] != request_hash
            ):
                return {'conflict': 'IDEMPOTENCY_CONFLICT'}
            return candidate_invitation_view(session_id, True)

        same_session_request = run(
            """
            SELECT idempotency_key
            FROM hirearchy.candidate_invitation_requests
            WHERE organization_id = $1::pg_catalog.uuid
              AND session_id = $2
            LIMIT 1
            """,
            ['uuid', 'text'],
            [organization_id, session_id],
        )
        existing_envelope = run(
            """
            SELECT session_id
            FROM hirearchy.candidate_token_envelopes
            WHERE organization_id = $1::pg_catalog.uuid
              AND session_id = $2
            """,
            ['uuid', 'text'],
            [organization_id, session_id],
        )
        if same_session_request or existing_envelope:
            return {'conflict': 'INVITATION_ALREADY_EXISTS'}

        session_state = session_rows[0]
        if session_state['status'] != 'CREATED' or session_state['activated_at'] is not None:
            return {'conflict': 'INVITATION_ALREADY_EXISTS'}

        fresh_expiry = run(
            """
            SELECT $1::pg_catalog.timestamptz > pg_catalog.clock_timestamp()
                     AND $1::pg_catalog.timestamptz <= pg_catalog.clock_timestamp() + INTERVAL '30 days'
                     AS valid
            """,
            ['text'],
            [expires_at],
        )[0]
        if not fresh_expiry['valid']:
            error('Staging request is invalid', '22023')

        run(
            """
            INSERT INTO hirearchy.candidate_token_envelopes (
              organization_id, session_id, candidate_token_hash,
              candidate_token_ciphertext, expires_at
            ) VALUES (
              $1::pg_catalog.uuid, $2, $3, $4, $5::pg_catalog.timestamptz
            )
            """,
            ['uuid', 'text', 'text', 'text', 'text'],
            [organization_id, session_id, token_hash, token_ciphertext, expires_at],
        )
        run(
            """
            INSERT INTO hirearchy.candidate_invitation_requests (
              organization_id, idempotency_key, session_id,
              issuer_principal_id, request_hash, expires_at
            ) VALUES (
              $1::pg_catalog.uuid, $2, $3, $4::pg_catalog.uuid,
              $5, $6::pg_catalog.timestamptz
            )
            """,
            ['uuid', 'text', 'text', 'uuid', 'text', 'text'],
            [organization_id, idempotency_key, session_id, principal_id, request_hash, expires_at],
        )
        return candidate_invitation_view(session_id, False)

    if operation == 'organization.context':
        reviewers = []
        draft_obj = None
        validated_versions = []
        if role == 'recruiter':
            set_scope(
                subject_id, auth_session_id, principal_id, organization_id,
                list_organization_reviewers='true',
            )
            reviewer_rows = run(
                """
                SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                  'principalId', principal_id::pg_catalog.text,
                  'role', role,
                  'joinedAt', pg_catalog.to_char(joined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                ) ORDER BY principal_id), '[]'::pg_catalog.jsonb) AS items
                FROM hirearchy.organization_memberships
                WHERE organization_id = $1::pg_catalog.uuid
                  AND role = 'reviewer'
                  AND status = 'active'
                  AND revoked_at IS NULL
                """,
                ['uuid'],
                [organization_id],
            )[0]['items']
            reviewers = json_value(reviewer_rows)
            set_scope(subject_id, auth_session_id, principal_id, organization_id)
            draft_rows = run(
                """
                SELECT def.id::pg_catalog.text AS definition_id,
                       def.organization_id::pg_catalog.text AS organization_id,
                       def.author_principal_id::pg_catalog.text AS author_principal_id,
                       def.draft_version AS version,
                       pg_catalog.to_char(def.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                       pg_catalog.to_char(def.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
                       draft.staging_content AS content,
                       draft.template_id AS template_id
                FROM hirearchy.assessment_definitions AS def
                JOIN hirearchy.assessment_drafts AS draft
                  ON draft.definition_id = def.id
                 AND draft.organization_id = def.organization_id
                 AND draft.version = def.draft_version
                WHERE def.organization_id = $1::pg_catalog.uuid
                  AND def.author_principal_id = $2::pg_catalog.uuid
                ORDER BY def.updated_at DESC, def.id DESC
                LIMIT 1
                """,
                ['uuid', 'uuid'],
                [organization_id, principal_id],
            )
            if draft_rows:
                d = draft_rows[0]
                raw_content = json_value(d['content'])
                if isinstance(raw_content, dict):
                    draft_obj = {
                        'templateId': raw_content.get('templateId', d['template_id'] or 'custom'),
                        'definitionId': d['definition_id'],
                        'organizationId': d['organization_id'],
                        'authorPrincipalId': d['author_principal_id'],
                        'version': int(d['version']),
                        'title': raw_content['title'],
                        'brief': raw_content['brief'],
                        'expectedBehavior': raw_content['expectedBehavior'],
                        'acceptanceCriteria': raw_content['acceptanceCriteria'],
                        'primaryFilePath': raw_content['primaryFilePath'],
                        'starterFiles': raw_content['starterFiles'],
                        'durationMinutes': raw_content['durationMinutes'],
                        'terminalEnabled': raw_content['terminalEnabled'],
                        'integratedAi': raw_content['integratedAi'],
                        'rubric': raw_content['rubric'],
                        'createdAt': d['created_at'],
                        'updatedAt': d['updated_at'],
                    }
            validated_rows = run(
                """
                SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                  'id', id::pg_catalog.text,
                  'definitionId', definition_id::pg_catalog.text,
                  'organizationId', organization_id::pg_catalog.text,
                  'authorPrincipalId', author_principal_id::pg_catalog.text,
                  'versionNumber', version_number,
                  'contentDigest', content_digest,
                  'scenarioId', scenario_id,
                  'scenarioVersion', scenario_version,
                  'scenarioTitle', scenario_title,
                  'scenarioSnapshot', scenario_snapshot,
                  'taskRubricSnapshot', task_rubric_snapshot,
                  'durationSeconds', duration_seconds,
                  'terminalEnabled', terminal_enabled,
                  'integratedAi', integrated_ai,
                  'validationReceipt', validation_receipt,
                  'createdAt', pg_catalog.to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                ) ORDER BY created_at DESC, version_number DESC), '[]'::pg_catalog.jsonb) AS items
                FROM hirearchy.assessment_validated_versions
                WHERE organization_id = $1::pg_catalog.uuid
                  AND author_principal_id = $2::pg_catalog.uuid
                """,
                ['uuid', 'uuid'],
                [organization_id, principal_id],
            )[0]['items']
            validated_versions = []
            for v in json_value(validated_rows):
                v = dict(v)
                v['scenarioSnapshot'] = safe_json_value(v.get('scenarioSnapshot'))
                v['taskRubricSnapshot'] = safe_json_value(v.get('taskRubricSnapshot'))
                validated_versions.append(v)

        session_rows = run(
            """
            SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'sessionId', s.id,
              'organizationId', s.organization_id::pg_catalog.text,
              'issuerPrincipalId', s.issuer_principal_id::pg_catalog.text,
              'scenarioId', s.scenario_id,
              'scenarioVersion', s.scenario_version,
              'scenarioTitle', s.scenario_title,
              'status', s.status,
              'durationSeconds', s.duration_seconds,
              'createdAt', pg_catalog.to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
              'activatedAt', CASE WHEN s.activated_at IS NULL THEN NULL
                                  ELSE pg_catalog.to_char(s.activated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
              'submittedAt', CASE WHEN s.submitted_at IS NULL THEN NULL
                                  ELSE pg_catalog.to_char(s.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
              'closureReason', s.closure_reason,
              'reviewProcessStatus', s.review_process_status,
              'terminalEnabled', s.terminal_enabled,
              'visibilityScope', CASE WHEN $3 = 'recruiter' THEN 'issued_by_recruiter' ELSE 'assigned_to_reviewer' END,
              'assignments', COALESCE((
                SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                  'assignmentId', a.id,
                  'sessionId', a.session_id,
                  'organizationId', a.organization_id::pg_catalog.text,
                  'reviewerPrincipalId', a.reviewer_principal_id::pg_catalog.text,
                  'assignedByPrincipalId', a.assigned_by_principal_id::pg_catalog.text,
                  'assignedAt', pg_catalog.to_char(a.assigned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                  'revokedAt', CASE WHEN a.revoked_at IS NULL THEN NULL
                                    ELSE pg_catalog.to_char(a.revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
                  'version', a.version,
                  'isActive', a.revoked_at IS NULL
                ) ORDER BY a.assigned_at DESC, a.id DESC)
                FROM hirearchy.reviewer_assignments AS a
                WHERE a.organization_id = s.organization_id
                  AND a.session_id = s.id
              ), '[]'::pg_catalog.jsonb)
            ) ORDER BY s.created_at DESC, s.id DESC), '[]'::pg_catalog.jsonb) AS items
            FROM hirearchy.assessment_sessions AS s
            WHERE s.organization_id = $1::pg_catalog.uuid
              AND (
                ($3 = 'recruiter' AND s.issuer_principal_id = $2::pg_catalog.uuid)
                OR (
                  $3 = 'reviewer' AND EXISTS (
                    SELECT 1 FROM hirearchy.reviewer_assignments AS assignment
                    WHERE assignment.organization_id = s.organization_id
                      AND assignment.session_id = s.id
                      AND assignment.reviewer_principal_id = $2::pg_catalog.uuid
                      AND assignment.revoked_at IS NULL
                  )
                )
              )
            """,
            ['uuid', 'uuid', 'text'],
            [organization_id, principal_id, role],
        )[0]['items']
        meta_rows = run(
            "SELECT staging.onboarding_get_organization_metadata($1::pg_catalog.uuid, $2::pg_catalog.uuid) AS meta",
            ['uuid', 'uuid'],
            [organization_id, principal_id],
        )
        org_meta = safe_json_value(meta_rows[0]['meta']) if meta_rows else None
        org_display_name = org_meta.get('displayName') if org_meta else None
        org_is_owner = bool(org_meta.get('isOwner')) if org_meta else False
        return {
            'organizationId': organization_id,
            'displayName': org_display_name,
            'isOwner': org_is_owner,
            'principalId': principal_id,
            'role': role,
            'reviewers': reviewers,
            'draft': draft_obj,
            'validatedVersions': validated_versions,
            'sessions': json_value(session_rows),
            'availableTemplates': [
                {
                    'templateId': 'custom',
                    'title': 'Custom authored assessment',
                    'description': 'Author a custom scenario with explicit starter files, brief, and rubric.',
                },
                {
                    'templateId': 'reservation-moves-v3',
                    'title': 'Reservation Moves v3',
                    'description': 'A local Python/pytest scenario where a candidate fixes capacity preservation and idempotent replay for booking moves.',
                    'scenarioId': 'reservation-moves',
                    'scenarioVersion': 'v3',
                },
            ],
        }

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
                   session.duration_seconds,
                   session.terminal_enabled, session.ai_capability_snapshot,
                   session.scenario_snapshot, session.task_rubric_snapshot,
                   pg_catalog.to_char(session.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso,
                   CASE WHEN session.activated_at IS NULL THEN NULL
                        ELSE pg_catalog.to_char(session.activated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS activated_at_iso,
                   CASE WHEN session.submitted_at IS NULL THEN NULL
                        ELSE pg_catalog.to_char(session.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS submitted_at_iso,
                   session.closure_reason, session.review_process_status
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
                        'durationSeconds': session['duration_seconds'],
                        'createdAt': session['created_at_iso'],
                        'activatedAt': session['activated_at_iso'],
                        'submittedAt': session['submitted_at_iso'],
                        'closureReason': session['closure_reason'],
                        'reviewProcessStatus': session['review_process_status'],
                        'terminalEnabled': session['terminal_enabled'],
                        'aiCapabilitySnapshot': json_value(session['ai_capability_snapshot']),
                        'scenarioSnapshot': safe_json_value(session['scenario_snapshot']),
                        'taskRubricSnapshot': safe_json_value(session['task_rubric_snapshot']),
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
                    'durationSeconds': session['duration_seconds'],
                    'createdAt': session['created_at_iso'],
                    'activatedAt': session['activated_at_iso'],
                    'submittedAt': session['submitted_at_iso'],
                    'closureReason': session['closure_reason'],
                    'reviewProcessStatus': session['review_process_status'],
                    'terminalEnabled': session['terminal_enabled'],
                    'aiCapabilitySnapshot': decode_json(session['ai_capability_snapshot']),
                    'scenarioSnapshot': safe_json_value(session['scenario_snapshot']),
                    'taskRubricSnapshot': safe_json_value(session['task_rubric_snapshot']),
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
            'status': session['status'],
            'packets': json.loads(packet_rows) if isinstance(packet_rows, str) else packet_rows,
            'history': json.loads(packet_history) if isinstance(packet_history, str) else packet_history,
        }

    review_write_operations = (
        'evidence.observation.create', 'evidence.observation.update',
        'review.packet.save', 'review.packet.finalize',
    )
    if operation in review_write_operations:
        if role != 'reviewer':
            error('Reviewer membership required', '42501')
        session_id = args.get('sessionId')
        if not isinstance(session_id, str) or not re.fullmatch(r'sess_[A-Za-z0-9_-]{1,128}', session_id):
            error('Staging request is invalid', '22023')

        session_rows = run(
            """
            SELECT status FROM hirearchy.assessment_sessions
            WHERE organization_id = $1::pg_catalog.uuid AND id = $2
            FOR SHARE
            """,
            ['uuid', 'text'],
            [organization_id, session_id],
        )
        if not session_rows or session_rows[0]['status'] != 'SUBMITTED':
            error('Submitted reviewer session is unavailable', '42501')
        assignment_rows = run(
            """
            SELECT id FROM hirearchy.reviewer_assignments
            WHERE organization_id = $1::pg_catalog.uuid
              AND session_id = $2
              AND reviewer_principal_id = $3::pg_catalog.uuid
              AND revoked_at IS NULL
            FOR SHARE
            """,
            ['uuid', 'text', 'uuid'],
            [organization_id, session_id, principal_id],
        )
        if not assignment_rows:
            error('Assigned reviewer access required', '42501')

        if operation in ('evidence.observation.create', 'evidence.observation.update'):
            input = args.get('input')
            if operation == 'evidence.observation.create':
                if not exact_keys(
                    input,
                    ('evidenceSourceType', 'eventSequence', 'evidenceDigest', 'body'),
                    ('filePath', 'fileVersion'),
                ):
                    error('Observation input is invalid', 'R2901')
                source_type = input.get('evidenceSourceType')
                sequence = input.get('eventSequence')
                evidence_digest = input.get('evidenceDigest')
                body = input.get('body')
                file_path = input.get('filePath')
                file_version = input.get('fileVersion')
                if (
                    source_type not in ('timeline_event', 'file_revision')
                    or not isinstance(sequence, str)
                    or not re.fullmatch(r'[1-9][0-9]{0,18}', sequence)
                    or int(sequence) > 9223372036854775807
                    or not isinstance(evidence_digest, str)
                    or not re.fullmatch(r'[0-9a-f]{64}', evidence_digest)
                    or not isinstance(body, str)
                    or len(body.encode('utf-8')) < 1
                    or len(body.encode('utf-8')) > 20000
                ):
                    error('Observation input is invalid', 'R2901')
                if source_type == 'timeline_event':
                    if file_path is not None or file_version is not None:
                        error('Timeline observation must not specify a file revision', 'R2901')
                    event_rows = run(
                        """
                        SELECT payload FROM hirearchy.candidate_session_events
                        WHERE organization_id = $1::pg_catalog.uuid
                          AND session_id = $2
                          AND sequence = $3::pg_catalog.int8
                        """,
                        ['uuid', 'text', 'int8'],
                        [organization_id, session_id, sequence],
                    )
                    if not event_rows:
                        error('Referenced timeline event not found', 'R2902')
                    payload = json_value(event_rows[0]['payload'])
                    digest_rows = run(
                        """SELECT pg_catalog.encode(
                             pg_catalog.sha256(pg_catalog.convert_to($1::pg_catalog.jsonb::pg_catalog.text, 'UTF8')),
                             'hex'
                           ) AS value""",
                        ['text'],
                        [json.dumps(payload, ensure_ascii=False)],
                    )
                    if evidence_digest not in (
                        payload.get('digest'), payload.get('scenarioDigest'),
                        payload.get('workspaceDigest'), payload.get('manifestDigest'),
                        digest_rows[0]['value'],
                    ):
                        error('Timeline event evidence digest mismatch', 'R2902')
                    file_path = None
                    file_version = None
                else:
                    if (
                        not isinstance(file_path, str) or not file_path.strip()
                        or not isinstance(file_version, str)
                        or not re.fullmatch(r'[1-9][0-9]{0,18}', file_version)
                        or int(file_version) > 9223372036854775807
                    ):
                        error('File revision observation requires a valid file path and version', 'R2901')
                    revision_rows = run(
                        """
                        SELECT content_digest FROM hirearchy.candidate_file_revisions
                        WHERE organization_id = $1::pg_catalog.uuid
                          AND session_id = $2
                          AND event_sequence = $3::pg_catalog.int8
                          AND file_path = $4
                          AND version = $5::pg_catalog.int8
                        """,
                        ['uuid', 'text', 'int8', 'text', 'int8'],
                        [organization_id, session_id, sequence, file_path, file_version],
                    )
                    if not revision_rows or revision_rows[0]['content_digest'] != evidence_digest:
                        error('Referenced file revision or digest is unavailable', 'R2902')
                rows = run(
                    """
                    INSERT INTO hirearchy.evaluator_observations (
                      organization_id, session_id, author_principal_id,
                      evidence_source_type, event_sequence, file_path, file_version,
                      evidence_digest, body, version, visibility
                    ) VALUES (
                      $1::pg_catalog.uuid, $2, $3::pg_catalog.uuid, $4,
                      $5::pg_catalog.int8, $6, $7::pg_catalog.int8,
                      $8, $9, 1, 'private'
                    )
                    RETURNING id::pg_catalog.text AS id,
                      evidence_source_type, event_sequence::pg_catalog.text AS event_sequence,
                      file_path, file_version::pg_catalog.text AS file_version,
                      evidence_digest, body, version,
                      pg_catalog.to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                      pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
                    """,
                    ['uuid', 'text', 'uuid', 'text', 'int8', 'text', 'int8', 'text', 'text'],
                    [organization_id, session_id, principal_id, source_type, sequence,
                     file_path, file_version, evidence_digest, body],
                )
                row = rows[0]
            else:
                if not exact_keys(input, ('expectedVersion', 'body')):
                    error('Observation update input is invalid', 'R2901')
                expected_version = input.get('expectedVersion')
                body = input.get('body')
                observation_id = args.get('observationId')
                if (
                    isinstance(expected_version, bool)
                    or not isinstance(expected_version, int)
                    or expected_version < 1
                    or not isinstance(body, str)
                    or len(body.encode('utf-8')) < 1
                    or len(body.encode('utf-8')) > 20000
                    or not is_uuid(observation_id)
                ):
                    error('Observation update input is invalid', 'R2901')
                observation_rows = run(
                    """
                    SELECT * FROM hirearchy.evaluator_observations
                    WHERE id = $1::pg_catalog.uuid
                      AND organization_id = $2::pg_catalog.uuid
                      AND session_id = $3
                      AND author_principal_id = $4::pg_catalog.uuid
                    FOR UPDATE
                    """,
                    ['uuid', 'uuid', 'text', 'uuid'],
                    [observation_id, organization_id, session_id, principal_id],
                )
                if not observation_rows:
                    error('Observation is unavailable', '42501')
                old = observation_rows[0]
                if old['version'] != expected_version:
                    error('Observation version changed', 'R2904')
                changed_at = run(
                    "SELECT pg_catalog.clock_timestamp() AS value"
                )[0]['value']
                run(
                    """
                    INSERT INTO hirearchy.evaluator_observation_history (
                      observation_id, organization_id, session_id, author_principal_id,
                      version, body, evidence_source_type, event_sequence,
                      file_path, file_version, evidence_digest, visibility,
                      valid_from, valid_until, recorded_at
                    ) VALUES (
                      $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3, $4::pg_catalog.uuid,
                      $5::pg_catalog.int8, $6, $7, $8::pg_catalog.int8,
                      $9, $10::pg_catalog.int8, $11, $12,
                      $13::pg_catalog.timestamptz, $13::pg_catalog.timestamptz,
                      $13::pg_catalog.timestamptz
                    )
                    """,
                    ['uuid', 'uuid', 'text', 'uuid', 'int8', 'text', 'text', 'int8', 'text', 'int8', 'text', 'text', 'timestamptz'],
                    [str(old['id']), organization_id, session_id, principal_id,
                     old['version'], old['body'], old['evidence_source_type'], old['event_sequence'],
                     old['file_path'], old['file_version'], old['evidence_digest'], old['visibility'], changed_at],
                )
                rows = run(
                    """
                    UPDATE hirearchy.evaluator_observations
                    SET body = $2, version = version + 1,
                        updated_at = $3::pg_catalog.timestamptz
                    WHERE id = $1::pg_catalog.uuid
                    RETURNING id::pg_catalog.text AS id,
                      evidence_source_type, event_sequence::pg_catalog.text AS event_sequence,
                      file_path, file_version::pg_catalog.text AS file_version,
                      evidence_digest, body, version,
                      pg_catalog.to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                      pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
                    """,
                    ['uuid', 'text', 'timestamptz'],
                    [observation_id, body, changed_at],
                )
                row = rows[0]
            return {
                'id': row['id'],
                'evidenceSourceType': row['evidence_source_type'],
                'eventSequence': row['event_sequence'],
                'filePath': row['file_path'],
                'fileVersion': row['file_version'],
                'evidenceDigest': row['evidence_digest'],
                'body': row['body'],
                'version': row['version'],
                'createdAt': row['created_at'],
                'updatedAt': row['updated_at'],
            }

        packet_input = args.get('input')
        if operation == 'review.packet.save':
            if not exact_keys(
                packet_input,
                ('summary', 'strengths', 'concerns', 'unresolvedQuestions',
                 'referencedObservationIds', 'referencedEvidence'),
                ('expectedVersion',),
            ):
                error('Review packet draft input is invalid', 'R2101')
            summary = packet_input.get('summary')
            strengths = packet_input.get('strengths')
            concerns = packet_input.get('concerns')
            questions = packet_input.get('unresolvedQuestions')
            observation_ids = packet_input.get('referencedObservationIds')
            evidence_references = packet_input.get('referencedEvidence')
            expected_version = packet_input.get('expectedVersion')
            if (
                not isinstance(summary, str)
                or not all(isinstance(items, list) for items in (strengths, concerns, questions, observation_ids, evidence_references))
                or not all(isinstance(item, str) for items in (strengths, concerns, questions) for item in items)
                or (expected_version is not None and (
                    isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version < 1
                ))
            ):
                error('Review packet draft input is invalid', 'R2101')
            validate_review_references(organization_id, session_id, principal_id, observation_ids, evidence_references)
            packet_rows = run(
                """
                SELECT * FROM hirearchy.evaluator_review_packets
                WHERE organization_id = $1::pg_catalog.uuid
                  AND session_id = $2
                  AND author_principal_id = $3::pg_catalog.uuid
                FOR UPDATE
                """,
                ['uuid', 'text', 'uuid'],
                [organization_id, session_id, principal_id],
            )
            encoded = [
                json.dumps(strengths, ensure_ascii=False),
                json.dumps(concerns, ensure_ascii=False),
                json.dumps(questions, ensure_ascii=False),
                json.dumps(observation_ids, ensure_ascii=False),
                json.dumps(evidence_references, ensure_ascii=False),
            ]
            if packet_rows:
                packet = packet_rows[0]
                if packet['status'] == 'FINALIZED':
                    error('Finalized review packet is immutable', 'R2105')
                if expected_version is None or packet['version'] != expected_version:
                    error('Review packet version changed', 'R2104')
                changed_at = run("SELECT pg_catalog.clock_timestamp() AS value")[0]['value']
                run(
                    """
                    INSERT INTO hirearchy.evaluator_review_packet_history (
                      packet_id, organization_id, session_id, author_principal_id,
                      status, version, summary, strengths, concerns, unresolved_questions,
                      referenced_observation_ids, referenced_evidence, finalized_at,
                      final_digest, valid_from, valid_until, recorded_at
                    ) VALUES (
                      $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3, $4::pg_catalog.uuid,
                      $5, $6::pg_catalog.int8, $7, $8::pg_catalog.jsonb, $9::pg_catalog.jsonb,
                      $10::pg_catalog.jsonb, $11::pg_catalog.jsonb, $12::pg_catalog.jsonb,
                      $13::pg_catalog.timestamptz, $14, $15::pg_catalog.timestamptz,
                      $16::pg_catalog.timestamptz, $16::pg_catalog.timestamptz
                    )
                    """,
                    ['uuid', 'uuid', 'text', 'uuid', 'text', 'int8', 'text', 'text', 'text', 'text', 'text', 'text', 'timestamptz', 'text', 'timestamptz', 'timestamptz'],
                    [str(packet['id']), organization_id, session_id, principal_id,
                     packet['status'], packet['version'], packet['summary'],
                     json.dumps(json_value(packet['strengths']), ensure_ascii=False),
                     json.dumps(json_value(packet['concerns']), ensure_ascii=False),
                     json.dumps(json_value(packet['unresolved_questions']), ensure_ascii=False),
                     json.dumps(json_value(packet['referenced_observation_ids']), ensure_ascii=False),
                     json.dumps(json_value(packet['referenced_evidence']), ensure_ascii=False),
                     packet['finalized_at'], packet['final_digest'], packet['updated_at'], changed_at],
                )
                run(
                    """
                    UPDATE hirearchy.evaluator_review_packets
                    SET summary = $2, strengths = $3::pg_catalog.jsonb,
                        concerns = $4::pg_catalog.jsonb,
                        unresolved_questions = $5::pg_catalog.jsonb,
                        referenced_observation_ids = $6::pg_catalog.jsonb,
                        referenced_evidence = $7::pg_catalog.jsonb,
                        version = version + 1, updated_at = $8::pg_catalog.timestamptz
                    WHERE id = $1::pg_catalog.uuid
                    """,
                    ['uuid', 'text', 'text', 'text', 'text', 'text', 'text', 'timestamptz'],
                    [str(packet['id']), summary, encoded[0], encoded[1], encoded[2], encoded[3], encoded[4], changed_at],
                )
                packet_id = str(packet['id'])
            else:
                if expected_version not in (None, 0, 1):
                    error('Review packet version changed', 'R2104')
                rows = run(
                    """
                    INSERT INTO hirearchy.evaluator_review_packets (
                      organization_id, session_id, author_principal_id,
                      summary, strengths, concerns, unresolved_questions,
                      referenced_observation_ids, referenced_evidence
                    ) VALUES (
                      $1::pg_catalog.uuid, $2, $3::pg_catalog.uuid,
                      $4, $5::pg_catalog.jsonb, $6::pg_catalog.jsonb,
                      $7::pg_catalog.jsonb, $8::pg_catalog.jsonb, $9::pg_catalog.jsonb
                    ) RETURNING id::pg_catalog.text AS id
                    """,
                    ['uuid', 'text', 'uuid', 'text', 'text', 'text', 'text', 'text', 'text'],
                    [organization_id, session_id, principal_id, summary, *encoded],
                )
                packet_id = rows[0]['id']
            return {'reviewPacket': staging_review_packet(packet_id)}

        if not exact_keys(packet_input, ('expectedVersion',)):
            error('Review packet finalization input is invalid', 'R2101')
        expected_version = packet_input.get('expectedVersion')
        if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version < 1:
            error('Review packet finalization input is invalid', 'R2101')
        packet_rows = run(
            """
            SELECT * FROM hirearchy.evaluator_review_packets
            WHERE organization_id = $1::pg_catalog.uuid
              AND session_id = $2
              AND author_principal_id = $3::pg_catalog.uuid
            FOR UPDATE
            """,
            ['uuid', 'text', 'uuid'],
            [organization_id, session_id, principal_id],
        )
        if not packet_rows:
            error('Review packet is not available for finalization', 'R2101')
        packet = packet_rows[0]
        if packet['status'] == 'FINALIZED':
            if expected_version in (packet['version'], packet['version'] - 1):
                return {'reviewPacket': staging_review_packet(str(packet['id']))}
            error('Review packet version changed', 'R2104')
        if packet['version'] != expected_version:
            error('Review packet version changed', 'R2104')
        obs_refs = json_value(packet['referenced_observation_ids'])
        evidence_refs = json_value(packet['referenced_evidence'])
        if (
            len(packet['summary'].strip().encode('utf-8')) < 10
            or not (obs_refs or evidence_refs)
        ):
            error('Review packet needs a summary and grounded citation', 'R2103')
        validate_review_references(organization_id, session_id, principal_id, obs_refs, evidence_refs)
        finalized_at = run(
            "SELECT pg_catalog.clock_timestamp() AS value"
        )[0]['value']
        run(
            """
            INSERT INTO hirearchy.evaluator_review_packet_history (
              packet_id, organization_id, session_id, author_principal_id,
              status, version, summary, strengths, concerns, unresolved_questions,
              referenced_observation_ids, referenced_evidence, finalized_at,
              final_digest, valid_from, valid_until, recorded_at
            ) VALUES (
              $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3, $4::pg_catalog.uuid,
              $5, $6::pg_catalog.int8, $7, $8::pg_catalog.jsonb, $9::pg_catalog.jsonb,
              $10::pg_catalog.jsonb, $11::pg_catalog.jsonb, $12::pg_catalog.jsonb,
              $13::pg_catalog.timestamptz, $14, $15::pg_catalog.timestamptz,
              $16::pg_catalog.timestamptz, $16::pg_catalog.timestamptz
            )
            """,
            ['uuid', 'uuid', 'text', 'uuid', 'text', 'int8', 'text', 'text', 'text', 'text', 'text', 'text', 'timestamptz', 'text', 'timestamptz', 'timestamptz'],
            [str(packet['id']), organization_id, session_id, principal_id,
             packet['status'], packet['version'], packet['summary'],
             json.dumps(json_value(packet['strengths']), ensure_ascii=False),
             json.dumps(json_value(packet['concerns']), ensure_ascii=False),
             json.dumps(json_value(packet['unresolved_questions']), ensure_ascii=False),
             json.dumps(obs_refs, ensure_ascii=False), json.dumps(evidence_refs, ensure_ascii=False),
             packet['finalized_at'], packet['final_digest'], packet['updated_at'], finalized_at],
        )
        run(
            """
            UPDATE hirearchy.evaluator_review_packets AS packet
            SET status = 'FINALIZED', finalized_at = $2::pg_catalog.timestamptz,
                final_digest = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                  pg_catalog.jsonb_build_object(
                    'id', packet.id::pg_catalog.text,
                    'organizationId', packet.organization_id::pg_catalog.text,
                    'sessionId', packet.session_id,
                    'authorPrincipalId', packet.author_principal_id::pg_catalog.text,
                    'summary', packet.summary,
                    'strengths', packet.strengths,
                    'concerns', packet.concerns,
                    'unresolvedQuestions', packet.unresolved_questions,
                    'referencedObservationIds', packet.referenced_observation_ids,
                    'referencedEvidence', packet.referenced_evidence,
                    'finalizedAt', pg_catalog.to_char($2::pg_catalog.timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                  )::pg_catalog.text, 'UTF8')), 'hex'),
                version = packet.version + 1, updated_at = $2::pg_catalog.timestamptz
            WHERE packet.id = $1::pg_catalog.uuid
            """,
            ['uuid', 'timestamptz'],
            [str(packet['id']), finalized_at],
        )
        return {'reviewPacket': staging_review_packet(str(packet['id']))}

    if operation == 'organization.update':
        raw_name = args.get('displayName')
        if not isinstance(raw_name, str):
            error('Organization display name is invalid', '22023')
        display_name = raw_name.strip()
        if len(display_name) < 1 or len(display_name) > 120 or re.search(r'[\x00-\x1f\x7f-\x9f]', display_name):
            error('Organization display name is invalid', '22023')
        rows = run(
            "SELECT staging.onboarding_update_organization($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3) AS result",
            ['uuid', 'uuid', 'text'],
            [organization_id, principal_id, display_name],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'organization.members.list':
        rows = run(
            "SELECT staging.onboarding_list_members($1::pg_catalog.uuid, $2::pg_catalog.uuid) AS result",
            ['uuid', 'uuid'],
            [organization_id, principal_id],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'organization.member.remove':
        target_principal_id = require_uuid(args.get('targetPrincipalId'), 'target principal ID')
        rows = run(
            "SELECT staging.onboarding_remove_member($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.uuid) AS result",
            ['uuid', 'uuid', 'uuid'],
            [organization_id, principal_id, target_principal_id],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'organization.invitation.create':
        target_email = args.get('targetEmail')
        expires_at_str = args.get('expiresAt')
        idempotency_key = args.get('idempotencyKey')
        token_hash = args.get('invitationTokenHash')
        token_ciphertext = args.get('invitationTokenCiphertext')
        if (
            not isinstance(target_email, str)
            or not isinstance(expires_at_str, str)
            or not isinstance(idempotency_key, str)
            or not isinstance(token_hash, str)
            or not isinstance(token_ciphertext, str)
        ):
            error('Staging request is invalid', '22023')
        canonical_email = target_email.strip().lower()
        if len(canonical_email) > 255 or not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', canonical_email):
            error('Target email address is invalid', '22023')
        if not re.fullmatch(r'[A-Za-z0-9._~-]{1,128}', idempotency_key):
            error('Idempotency key is invalid', '22023')
        if not re.fullmatch(r'[0-9a-f]{64}', token_hash):
            error('Invitation token hash is invalid', '22023')
        if len(token_ciphertext) < 1 or len(token_ciphertext) > 4096:
            error('Invitation ciphertext is invalid', '22023')

        canonical_request = json.dumps({
            'organizationId': organization_id,
            'targetEmail': canonical_email,
            'expiresAt': expires_at_str,
        }, sort_keys=True, separators=(',', ':'))
        request_digest = sha256_hex(canonical_request)

        rows = run(
            """
            SELECT staging.onboarding_create_invitation(
              $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.uuid,
              $4, $5, $6, $7, $8, $9
            ) AS result
            """,
            ['uuid', 'uuid', 'uuid', 'text', 'text', 'text', 'text', 'text', 'text'],
            [subject_id, organization_id, principal_id, canonical_email, expires_at_str, idempotency_key, request_digest, token_hash, token_ciphertext],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'organization.invitation.list':
        rows = run(
            "SELECT staging.onboarding_list_invitations($1::pg_catalog.uuid, $2::pg_catalog.uuid) AS result",
            ['uuid', 'uuid'],
            [organization_id, principal_id],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'organization.invitation.revoke':
        invitation_id = require_uuid(args.get('invitationId'), 'invitation ID')
        rows = run(
            "SELECT staging.onboarding_revoke_invitation($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.uuid) AS result",
            ['uuid', 'uuid', 'uuid'],
            [organization_id, principal_id, invitation_id],
        )
        return safe_json_value(rows[0]['result'])

    error('Staging operation is unavailable', '22023')

def dispatch_pre_principal(op, args, subject_id, auth_session_id, principal_id, email, auth_exp, proof_exp):
    if op == 'onboarding.status':
        rows = run(
            "SELECT staging.onboarding_get_status($1::pg_catalog.uuid) AS result",
            ['uuid'],
            [subject_id],
        )
        res = safe_json_value(rows[0]['result'])
        res['email'] = email
        return res

    if op == 'organization.bootstrap':
        raw_name = args.get('displayName')
        idempotency_key = args.get('idempotencyKey')
        if not isinstance(raw_name, str) or not isinstance(idempotency_key, str):
            error('Staging request is invalid', '22023')
        display_name = raw_name.strip()
        if len(display_name) < 1 or len(display_name) > 120 or re.search(r'[\x00-\x1f\x7f-\x9f]', display_name):
            error('Organization display name is invalid', '22023')
        if not re.fullmatch(r'[A-Za-z0-9._~-]{1,128}', idempotency_key):
            error('Idempotency key is invalid', '22023')
        
        canonical_request = json.dumps({'displayName': display_name}, sort_keys=True, separators=(',', ':'))
        request_digest = sha256_hex(canonical_request)

        rows = run(
            "SELECT staging.onboarding_bootstrap_organization($1::pg_catalog.uuid, $2, $3, $4, $5) AS result",
            ['uuid', 'text', 'text', 'text', 'text'],
            [subject_id, email, display_name, idempotency_key, request_digest],
        )
        return safe_json_value(rows[0]['result'])

    if op == 'organization.invitation.accept':
        token_hash = args.get('invitationTokenHash')
        if not isinstance(token_hash, str) or not re.fullmatch(r'[0-9a-f]{64}', token_hash):
            error('Invitation token hash is invalid', '22023')
        rows = run(
            "SELECT staging.onboarding_accept_invitation($1::pg_catalog.uuid, $2, $3) AS result",
            ['uuid', 'text', 'text'],
            [subject_id, email, token_hash],
        )
        return safe_json_value(rows[0]['result'])

    error('Staging operation is unavailable', '22023')

def dispatch_account(op, args, subject_id, auth_session_id, principal_id):
    if op == 'account.profile.get':
        rows = run(
            "SELECT staging.onboarding_get_profile($1::pg_catalog.uuid) AS result",
            ['uuid'],
            [principal_id],
        )
        return safe_json_value(rows[0]['result'])

    if op == 'account.profile.update':
        raw_name = args.get('displayName')
        if not isinstance(raw_name, str):
            error('Profile display name is invalid', '22023')
        display_name = raw_name.strip()
        if len(display_name) < 1 or len(display_name) > 120 or re.search(r'[\x00-\x1f\x7f-\x9f]', display_name):
            error('Profile display name is invalid', '22023')
        rows = run(
            "SELECT staging.onboarding_update_profile($1::pg_catalog.uuid, $2) AS result",
            ['uuid', 'text'],
            [principal_id, display_name],
        )
        return safe_json_value(rows[0]['result'])

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
if not exact_keys(proof, CLAIM_KEYS) or proof.get('v') != 2 or isinstance(proof.get('v'), bool):
    error('Staging proof is invalid', '28000')
if proof.get('isRecovery') is not False:
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
principal_id = principal_rows[0]['id'] if principal_rows else None

validate_operation_args(proof['op'], proof['args'])
args = proof['args']

PRE_PRINCIPAL_OPERATIONS = {'onboarding.status', 'organization.bootstrap', 'organization.invitation.accept'}
ACCOUNT_OPERATIONS = {'account.profile.get', 'account.profile.update'}

if proof['op'] in PRE_PRINCIPAL_OPERATIONS:
    user_rows = run(
        """
        SELECT id::pg_catalog.text AS id, email,
               (email_confirmed_at IS NOT NULL) AS email_confirmed
        FROM auth.users
        WHERE id = $1::pg_catalog.uuid
        """,
        ['uuid'],
        [proof['sub']],
    )
    if not user_rows or not user_rows[0]['email_confirmed']:
        error('Email confirmation is required', '42501')
    set_scope(proof['sub'], proof['sid'], principal_id)
    result = dispatch_pre_principal(
        proof['op'], args, proof['sub'], proof['sid'], principal_id,
        user_rows[0]['email'], effective_auth_exp, proof['exp']
    )
elif proof['op'] in ACCOUNT_OPERATIONS:
    if not principal_id:
        error('Application principal is unavailable', '42501')
    set_scope(proof['sub'], proof['sid'], principal_id)
    result = dispatch_account(
        proof['op'], args, proof['sub'], proof['sid'], principal_id
    )
elif proof['op'] == 'membership.list':
    if not principal_id:
        error('Application principal is unavailable', '42501')
    set_scope(proof['sub'], proof['sid'], principal_id)
    result = dispatch(proof['op'], args, proof['sub'], proof['sid'], principal_id, effective_auth_exp, proof['exp'])
else:
    if not principal_id:
        error('Application principal is unavailable', '42501')
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

DO $durable_candidate_marker$
DECLARE
  installed_migration record;
  existing_marker record;
  marker_table record;
  guard_owner pg_catalog.name;
  guard_security_definer pg_catalog.bool;
BEGIN
  SELECT checksum, applied_by
    INTO installed_migration
    FROM hirearchy.schema_migrations
   WHERE version = '0016';
  IF NOT FOUND
     OR installed_migration.applied_by <> 'hirearchy_migrator'
     OR installed_migration.checksum !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Durable candidate lifecycle migration is not verified';
  END IF;

  SELECT role.rolname, routine.prosecdef
    INTO guard_owner, guard_security_definer
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_roles AS role ON role.oid = routine.proowner
   WHERE routine.oid = pg_catalog.to_regprocedure(
     'hirearchy.r26_candidate_command(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.jsonb)'
   );
  IF guard_owner IS DISTINCT FROM 'hirearchy_migrator'
     OR guard_security_definer IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Durable candidate lifecycle guard is missing or unsafe';
  END IF;
  SELECT role.rolname AS owner,
         relation.relrowsecurity,
         relation.relforcerowsecurity
    INTO marker_table
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles AS role ON role.oid = relation.relowner
   WHERE namespace.nspname = 'hirearchy'
     AND relation.relname = 'durable_candidate_installation'
     AND relation.relkind = 'r';
  IF NOT FOUND
     OR marker_table.owner IS DISTINCT FROM 'hirearchy_migrator'
     OR marker_table.relrowsecurity IS DISTINCT FROM true
     OR marker_table.relforcerowsecurity IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Durable candidate installation marker is not protected';
  END IF;
  IF pg_catalog.has_function_privilege(
       'app_candidate_gateway',
       'hirearchy.r26_candidate_command_unchecked(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.jsonb)',
       'EXECUTE'
     )
     OR pg_catalog.has_table_privilege(
       'app_candidate_gateway',
       'hirearchy.durable_candidate_installation',
       'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'app_candidate_gateway',
       'hirearchy.durable_candidate_installation',
       'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'app_candidate_gateway',
       'hirearchy.durable_candidate_installation',
       'DELETE'
     ) THEN
    RAISE EXCEPTION 'Candidate runtime has an unsafe lifecycle bypass';
  END IF;

  INSERT INTO hirearchy.durable_candidate_installation (
    marker_key, marker_version, migration_version, migration_checksum, installed_by
  ) VALUES (
    'durable-candidate-lifecycle-v1', 1, '0016',
    installed_migration.checksum, current_user
  )
  ON CONFLICT (marker_key) DO NOTHING;

  SELECT marker_version, migration_version, migration_checksum
    INTO existing_marker
    FROM hirearchy.durable_candidate_installation
   WHERE marker_key = 'durable-candidate-lifecycle-v1';
  IF NOT FOUND
     OR existing_marker.marker_version <> 1
     OR existing_marker.migration_version <> '0016'
     OR existing_marker.migration_checksum <> installed_migration.checksum THEN
    RAISE EXCEPTION 'Durable candidate lifecycle installation marker is inconsistent';
  END IF;
END
$durable_candidate_marker$;

DO $durable_onboarding_marker$
DECLARE
  installed_migration record;
  existing_marker record;
  marker_table record;
BEGIN
  SELECT checksum, applied_by
    INTO installed_migration
    FROM hirearchy.schema_migrations
   WHERE version = '0017';
  IF NOT FOUND
     OR installed_migration.applied_by <> 'hirearchy_migrator'
     OR installed_migration.checksum !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Durable onboarding lifecycle migration is not verified';
  END IF;

  SELECT role.rolname AS owner,
         relation.relrowsecurity,
         relation.relforcerowsecurity
    INTO marker_table
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles AS role ON role.oid = relation.relowner
   WHERE namespace.nspname = 'hirearchy'
     AND relation.relname = 'durable_onboarding_installation'
     AND relation.relkind = 'r';
  IF NOT FOUND
     OR marker_table.owner IS DISTINCT FROM 'hirearchy_migrator'
     OR marker_table.relrowsecurity IS DISTINCT FROM true
     OR marker_table.relforcerowsecurity IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Durable onboarding installation marker is not protected';
  END IF;

  INSERT INTO hirearchy.durable_onboarding_installation (
    marker_key, marker_version, migration_version, migration_checksum, installed_by
  ) VALUES (
    'durable-onboarding-v1', 1, '0017',
    installed_migration.checksum, current_user
  )
  ON CONFLICT (marker_key) DO NOTHING;

  SELECT marker_version, migration_version, migration_checksum
    INTO existing_marker
    FROM hirearchy.durable_onboarding_installation
   WHERE marker_key = 'durable-onboarding-v1';
  IF NOT FOUND
     OR existing_marker.marker_version <> 1
     OR existing_marker.migration_version <> '0017'
     OR existing_marker.migration_checksum <> installed_migration.checksum THEN
    RAISE EXCEPTION 'Durable onboarding lifecycle installation marker is inconsistent';
  END IF;
END
$durable_onboarding_marker$;

COMMIT;
