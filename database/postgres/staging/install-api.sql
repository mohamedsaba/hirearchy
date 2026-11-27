-- Administrator-run API installation after the staging bootstrap and all
-- ordered migrations. This grants r23_gateway only the dispatcher entry point.
BEGIN;

DO $preflight$
DECLARE
  owner_role record;
  readiness_role record;
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
    INTO readiness_role
    FROM pg_catalog.pg_roles
    WHERE rolname = 'staging_readiness_owner';
  IF NOT FOUND
     OR readiness_role.rolcanlogin OR readiness_role.rolsuper
     OR readiness_role.rolbypassrls OR readiness_role.rolcreatedb
     OR readiness_role.rolcreaterole OR readiness_role.rolreplication
     OR readiness_role.rolinherit OR readiness_role.rolconfig IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setrole = readiness_role.oid)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid = readiness_role.oid OR member = readiness_role.oid) THEN
    RAISE EXCEPTION 'staging_readiness_owner is missing or unsafe';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation,
           LATERAL pg_catalog.aclexplode(
             COALESCE(
               relation.relacl,
               pg_catalog.acldefault('r', relation.relowner)
             )
           ) AS privilege
     WHERE privilege.grantee = readiness_role.oid
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
     WHERE privilege.grantee = readiness_role.oid
       AND NOT (
         namespace.nspname = 'hirearchy'
         AND privilege.privilege_type = 'SELECT'
         AND NOT privilege.is_grantable
         AND (
           (relation.relname = 'schema_migrations' AND attribute.attname = 'version')
           OR (
             relation.relname IN (
               'durable_candidate_installation',
               'durable_onboarding_installation'
             )
             AND attribute.attname IN ('marker_key', 'marker_version')
           )
           OR (
             relation.relname = 'candidate_token_storage_meta'
             AND attribute.attname = 'version'
           )
         )
       )
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_namespace AS namespace,
           LATERAL pg_catalog.aclexplode(
             COALESCE(
               namespace.nspacl,
               pg_catalog.acldefault('n', namespace.nspowner)
             )
           ) AS privilege
     WHERE privilege.grantee = readiness_role.oid
       AND NOT (
         namespace.nspname = 'hirearchy'
         AND privilege.privilege_type = 'USAGE'
         AND NOT privilege.is_grantable
       )
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS routine,
           LATERAL pg_catalog.aclexplode(
             COALESCE(
               routine.proacl,
               pg_catalog.acldefault('f', routine.proowner)
             )
           ) AS privilege
     WHERE privilege.grantee = readiness_role.oid
       AND routine.oid IS DISTINCT FROM COALESCE(
         pg_catalog.to_regprocedure('staging.readiness_probe()'),
         0::pg_catalog.oid
       )
  ) THEN
    RAISE EXCEPTION 'staging_readiness_owner has grants outside the readiness metadata boundary';
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

DROP POLICY IF EXISTS staging_verifier_reusable_problem_access ON hirearchy.reusable_problems;
CREATE POLICY staging_verifier_reusable_problem_access
  ON hirearchy.reusable_problems
  TO staging_verifier_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
  )
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('staging.organization_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS staging_verifier_reusable_problem_author ON hirearchy.reusable_problems;
CREATE POLICY staging_verifier_reusable_problem_author
  ON hirearchy.reusable_problems
  AS RESTRICTIVE
  FOR INSERT TO staging_verifier_owner
  WITH CHECK (
    author_principal_id = NULLIF(pg_catalog.current_setting('staging.principal_id', true), '')::pg_catalog.uuid
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
REVOKE ALL ON hirearchy.reusable_problems
  FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker;
GRANT SELECT (id, organization_id, author_principal_id, version, content, created_at, updated_at),
  INSERT (organization_id, author_principal_id, content),
  UPDATE (version, content, updated_at), DELETE
  ON hirearchy.reusable_problems TO staging_verifier_owner;
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
          'role', v_inv.role,
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
    v_inv.organization_id, v_principal_id, v_inv.role, 'active',
    pg_catalog.clock_timestamp(), 1
  );

  UPDATE hirearchy.organization_invitations
  SET accepted_at = pg_catalog.clock_timestamp(),
      accepted_by_principal_id = v_principal_id
  WHERE id = v_inv.id;

  RETURN pg_catalog.jsonb_build_object(
    'organizationId', v_inv.organization_id::pg_catalog.text,
    'role', v_inv.role,
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
  ) || CASE WHEN p.avatar_webp IS NULL THEN '{}'::pg_catalog.jsonb
    ELSE pg_catalog.jsonb_build_object('avatarWebp', p.avatar_webp) END
    INTO v_profile
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

CREATE OR REPLACE FUNCTION staging.onboarding_update_avatar(
  p_principal_id pg_catalog.uuid,
  p_avatar_webp pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, pg_temp
AS $function$
BEGIN
  UPDATE hirearchy.application_principals
  SET avatar_webp = p_avatar_webp
  WHERE id = p_principal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account profile unavailable' USING ERRCODE = '22023';
  END IF;

  RETURN pg_catalog.jsonb_build_object('updated', true);
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

CREATE OR REPLACE FUNCTION staging.hiring_get_session_executions(
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_items pg_catalog.jsonb;
BEGIN
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'organizationId', op.organization_id::pg_catalog.text,
        'sessionId', op.session_id,
        'operationId', op.operation_id,
        'requestId', op.request_id,
        'sequenceStart', op.sequence_start::pg_catalog.text,
        'sequenceCompleted', CASE WHEN op.sequence_completed IS NOT NULL THEN op.sequence_completed::pg_catalog.text ELSE NULL END,
        'workspaceDigest', op.workspace_digest,
        'workspaceVersion', op.workspace_version::pg_catalog.text,
        'recipeId', op.recipe_id,
        'recipeVersion', op.recipe_version,
        'recipeDigest', op.recipe_digest,
        'generation', op.generation,
        'fence', op.fence,
        'status', op.status,
        'exitCode', op.exit_code,
        'stdout', op.stdout,
        'stderr', op.stderr,
        'stdoutDigest', op.stdout_digest,
        'stderrDigest', op.stderr_digest,
        'truncatedStdout', op.truncated_stdout,
        'truncatedStderr', op.truncated_stderr,
        'durationMs', op.duration_ms,
        'failureReason', op.failure_reason,
        'errorMessage', op.error_message,
        'cleanupStatus', op.cleanup_status,
        'isUnknown', op.is_unknown,
        'provenance', op.provenance,
        'isSynthetic', (op.provenance = 'synthetic-execution-adapter'),
        'createdAt', pg_catalog.to_char(op.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'completedAt', CASE WHEN op.completed_at IS NOT NULL THEN pg_catalog.to_char(op.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ELSE NULL END
      ) ORDER BY op.sequence_start
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_items
  FROM hirearchy.candidate_execution_operations AS op
  WHERE op.organization_id = p_organization_id
    AND op.session_id = p_session_id;

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

CREATE OR REPLACE FUNCTION staging.hiring_create_team_invitation(
  p_subject_id pg_catalog.uuid,
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_target_email pg_catalog.text,
  p_role pg_catalog.text,
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
  v_caller_role pg_catalog.text;
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

  IF p_role NOT IN ('cto', 'recruiter', 'reviewer') THEN
    RAISE EXCEPTION 'Invitation role is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT owner_principal_id INTO v_owner_id
  FROM hirearchy.organizations
  WHERE id = p_organization_id;

  SELECT role INTO v_caller_role
  FROM hirearchy.organization_memberships
  WHERE organization_id = p_organization_id
    AND principal_id = p_caller_principal_id
    AND status = 'active'
    AND revoked_at IS NULL;

  IF NOT FOUND OR (v_owner_id <> p_caller_principal_id AND v_caller_role <> 'cto') THEN
    RAISE EXCEPTION 'Invitation creation requires CTO or owner permission' USING ERRCODE = '42501';
  END IF;

  v_canonical_email := lower(trim(COALESCE(p_target_email, '')));
  IF length(v_canonical_email) > 255 OR v_canonical_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Target email address is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT request_digest, response_payload INTO v_receipt
  FROM hirearchy.onboarding_request_receipts
  WHERE subject_id = p_subject_id
    AND operation = 'hiring.team.invitation.create'
    AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_receipt.request_digest <> p_request_digest THEN
      RAISE EXCEPTION 'Idempotency key already exists with different request parameters' USING ERRCODE = '22023';
    END IF;
    RETURN v_receipt.response_payload;
  END IF;

  v_expires_at := p_expires_at_str::pg_catalog.timestamptz;
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
    p_role, p_token_hash, p_token_ciphertext, v_expires_at
  );

  v_response := pg_catalog.jsonb_build_object(
    'invitationId', v_invitation_id::pg_catalog.text,
    'organizationId', p_organization_id::pg_catalog.text,
    'targetEmail', v_canonical_email,
    'role', p_role,
    'expiresAt', v_formatted_expiry,
    'emailDeliveryEnabled', false
  );

  INSERT INTO hirearchy.onboarding_request_receipts (
    subject_id, operation, idempotency_key, request_digest, response_payload
  ) VALUES (
    p_subject_id, 'hiring.team.invitation.create', p_idempotency_key, p_request_digest, v_response
  );

  RETURN v_response;
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_candidate_profile_get(
  p_subject_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_user record;
  v_principal_id pg_catalog.uuid;
  v_profile record;
BEGIN
  SELECT id, lower(trim(email)) AS email, (email_confirmed_at IS NOT NULL) AS confirmed
  INTO v_user
  FROM auth.users
  WHERE id = p_subject_id;

  IF NOT FOUND OR NOT v_user.confirmed THEN
    RAISE EXCEPTION 'Email confirmation is required' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_principal_id
  FROM hirearchy.application_principals
  WHERE auth_user_id = p_subject_id;

  IF v_principal_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'email', v_user.email,
      'profile', NULL
    );
  END IF;

  SELECT * INTO v_profile
  FROM hirearchy.candidate_profiles
  WHERE principal_id = v_principal_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'email', v_user.email,
      'principalId', v_principal_id::pg_catalog.text,
      'profile', NULL
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'email', v_user.email,
    'principalId', v_principal_id::pg_catalog.text,
    'profile', pg_catalog.jsonb_build_object(
      'principalId', v_profile.principal_id::pg_catalog.text,
      'candidateCode', v_profile.candidate_code,
      'email', v_profile.email,
      'fullName', v_profile.full_name,
      'phone', v_profile.phone,
      'birthYear', v_profile.birth_year,
      'locationCountry', v_profile.location_country,
      'locationCity', v_profile.location_city,
      'workMode', v_profile.work_mode,
      'headlineRole', v_profile.headline_role,
      'yearsExperience', v_profile.years_experience,
      'experienceLevel', v_profile.experience_level,
      'skills', v_profile.skills,
      'idDocumentType', v_profile.id_document_type,
      'idDocumentMasked', v_profile.id_document_masked,
      'idVerificationStatus', v_profile.id_verification_status,
      'linkedinUrl', v_profile.linkedin_url,
      'githubUrl', v_profile.github_url,
      'portfolioUrl', v_profile.portfolio_url,
      'bio', v_profile.bio,
      'profileCompletedAt', CASE WHEN v_profile.profile_completed_at IS NULL THEN NULL ELSE pg_catalog.to_char(v_profile.profile_completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
      'updatedAt', pg_catalog.to_char(v_profile.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    )
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_candidate_profile_upsert(
  p_subject_id pg_catalog.uuid,
  p_payload pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_user record;
  v_principal_id pg_catalog.uuid;
  v_full_name pg_catalog.text;
  v_code pg_catalog.text;
  v_birth_year pg_catalog.int4;
  v_years_exp pg_catalog.int4;
  v_exp_level pg_catalog.text;
  v_work_mode pg_catalog.text;
  v_skills pg_catalog.jsonb;
  v_existing_code pg_catalog.text;
BEGIN
  SELECT id, lower(trim(email)) AS email, (email_confirmed_at IS NOT NULL) AS confirmed
  INTO v_user
  FROM auth.users
  WHERE id = p_subject_id;

  IF NOT FOUND OR NOT v_user.confirmed THEN
    RAISE EXCEPTION 'Email confirmation is required' USING ERRCODE = '42501';
  END IF;

  v_full_name := trim(COALESCE(p_payload ->> 'fullName', ''));
  IF length(v_full_name) < 2 OR length(v_full_name) > 120 THEN
    RAISE EXCEPTION 'Full name must be between 2 and 120 characters' USING ERRCODE = '22023';
  END IF;

  INSERT INTO hirearchy.application_principals (id, auth_user_id, display_name)
  VALUES (pg_catalog.gen_random_uuid(), p_subject_id, v_full_name)
  ON CONFLICT (auth_user_id) DO NOTHING;

  SELECT id INTO STRICT v_principal_id
  FROM hirearchy.application_principals
  WHERE auth_user_id = p_subject_id;

  SELECT candidate_code INTO v_existing_code
  FROM hirearchy.candidate_profiles
  WHERE principal_id = v_principal_id;

  v_code := COALESCE(
    v_existing_code,
    'HRC-' || upper(substr(replace(pg_catalog.gen_random_uuid()::pg_catalog.text, '-', ''), 1, 8))
  );

  IF p_payload ? 'birthYear' AND p_payload -> 'birthYear' IS NOT NULL AND pg_catalog.jsonb_typeof(p_payload -> 'birthYear') = 'number' THEN
    v_birth_year := (p_payload ->> 'birthYear')::pg_catalog.int4;
    IF v_birth_year < 1940 OR v_birth_year > 2012 THEN
      RAISE EXCEPTION 'Birth year must be between 1940 and 2012' USING ERRCODE = '22023';
    END IF;
  ELSE
    v_birth_year := NULL;
  END IF;

  v_years_exp := GREATEST(0, LEAST(50, COALESCE((p_payload ->> 'yearsExperience')::pg_catalog.int4, 0)));
  v_exp_level := COALESCE(NULLIF(trim(p_payload ->> 'experienceLevel'), ''), 'mid');
  IF v_exp_level NOT IN ('junior', 'mid', 'senior', 'staff') THEN
    v_exp_level := 'mid';
  END IF;

  v_work_mode := COALESCE(NULLIF(trim(p_payload ->> 'workMode'), ''), 'remote');
  IF v_work_mode NOT IN ('remote', 'hybrid', 'onsite', 'any') THEN
    v_work_mode := 'remote';
  END IF;

  v_skills := CASE
    WHEN pg_catalog.jsonb_typeof(p_payload -> 'skills') = 'array' THEN p_payload -> 'skills'
    ELSE '[]'::pg_catalog.jsonb
  END;

  INSERT INTO hirearchy.candidate_profiles (
    principal_id, candidate_code, email, full_name, phone, birth_year,
    location_country, location_city, work_mode, headline_role,
    years_experience, experience_level, skills,
    linkedin_url, github_url, portfolio_url, bio,
    profile_completed_at, updated_at
  ) VALUES (
    v_principal_id,
    v_code,
    v_user.email,
    v_full_name,
    left(trim(COALESCE(p_payload ->> 'phone', '')), 40),
    v_birth_year,
    left(trim(COALESCE(p_payload ->> 'locationCountry', '')), 100),
    left(trim(COALESCE(p_payload ->> 'locationCity', '')), 100),
    v_work_mode,
    left(trim(COALESCE(p_payload ->> 'headlineRole', '')), 120),
    v_years_exp,
    v_exp_level,
    v_skills,
    left(trim(COALESCE(p_payload ->> 'linkedinUrl', '')), 300),
    left(trim(COALESCE(p_payload ->> 'githubUrl', '')), 300),
    left(trim(COALESCE(p_payload ->> 'portfolioUrl', '')), 300),
    left(trim(COALESCE(p_payload ->> 'bio', '')), 2000),
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT (principal_id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = EXCLUDED.full_name,
    phone = EXCLUDED.phone,
    birth_year = EXCLUDED.birth_year,
    location_country = EXCLUDED.location_country,
    location_city = EXCLUDED.location_city,
    work_mode = EXCLUDED.work_mode,
    headline_role = EXCLUDED.headline_role,
    years_experience = EXCLUDED.years_experience,
    experience_level = EXCLUDED.experience_level,
    skills = EXCLUDED.skills,
    linkedin_url = EXCLUDED.linkedin_url,
    github_url = EXCLUDED.github_url,
    portfolio_url = EXCLUDED.portfolio_url,
    bio = EXCLUDED.bio,
    profile_completed_at = COALESCE(hirearchy.candidate_profiles.profile_completed_at, pg_catalog.clock_timestamp()),
    updated_at = pg_catalog.clock_timestamp();

  UPDATE hirearchy.hiring_session_metadata
  SET candidate_principal_id = v_principal_id
  WHERE candidate_email = v_user.email
    AND candidate_principal_id IS NULL;

  RETURN staging.hiring_candidate_profile_get(p_subject_id);
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_candidate_portal_list(
  p_subject_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_profile_bundle pg_catalog.jsonb;
  v_user record;
  v_principal_id pg_catalog.uuid;
  v_items pg_catalog.jsonb;
BEGIN
  SELECT id, lower(trim(email)) AS email, (email_confirmed_at IS NOT NULL) AS confirmed
  INTO v_user
  FROM auth.users
  WHERE id = p_subject_id;

  IF NOT FOUND OR NOT v_user.confirmed THEN
    RAISE EXCEPTION 'Email confirmation is required' USING ERRCODE = '42501';
  END IF;

  v_profile_bundle := staging.hiring_candidate_profile_get(p_subject_id);

  SELECT id INTO v_principal_id
  FROM hirearchy.application_principals
  WHERE auth_user_id = p_subject_id;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'sessionId', s.id,
        'organizationId', s.organization_id::pg_catalog.text,
        'organizationName', COALESCE(o.display_name, 'Hiring Organization'),
        'scenarioTitle', s.scenario_title,
        'targetRole', m.target_role,
        'experienceLevel', m.experience_level,
        'skills', m.skills,
        'durationSeconds', s.duration_seconds,
        'status', s.status,
        'createdAt', pg_catalog.to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'activatedAt', CASE WHEN s.activated_at IS NULL THEN NULL ELSE pg_catalog.to_char(s.activated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
        'submittedAt', CASE WHEN s.submitted_at IS NULL THEN NULL ELSE pg_catalog.to_char(s.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
        'invitationExpiresAt', CASE WHEN e.expires_at IS NULL THEN NULL ELSE pg_catalog.to_char(e.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
        'invitationRevokedAt', CASE WHEN e.revoked_at IS NULL THEN NULL ELSE pg_catalog.to_char(e.revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
        'invitationActive', (e.revoked_at IS NULL AND e.expires_at IS NOT NULL AND e.expires_at > pg_catalog.clock_timestamp()),
        'candidateTokenCiphertext', CASE WHEN e.revoked_at IS NULL AND e.expires_at IS NOT NULL AND e.expires_at > pg_catalog.clock_timestamp() THEN e.candidate_token_ciphertext ELSE NULL END,
        'publishedOutcome', CASE
          WHEN d.session_id IS NULL THEN NULL
          ELSE pg_catalog.jsonb_build_object(
            'decision', d.decision,
            'strengths', d.candidate_strengths,
            'weaknesses', d.candidate_weaknesses,
            'feedbackNote', d.candidate_feedback_note,
            'nextStageLabel', CASE WHEN d.decision = 'accepted' THEN d.next_stage_label ELSE NULL END,
            'publishedAt', pg_catalog.to_char(d.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          )
        END
      ) ORDER BY s.created_at DESC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_items
  FROM hirearchy.hiring_session_metadata m
  JOIN hirearchy.assessment_sessions s ON s.id = m.session_id
  JOIN hirearchy.organizations o ON o.id = s.organization_id
  LEFT JOIN hirearchy.candidate_token_envelopes e ON e.session_id = s.id
  LEFT JOIN hirearchy.hiring_decisions d ON d.session_id = s.id
  WHERE m.candidate_email = v_user.email
    AND (m.candidate_principal_id IS NULL OR m.candidate_principal_id = v_principal_id);

  RETURN pg_catalog.jsonb_build_object(
    'email', v_user.email,
    'profile', v_profile_bundle -> 'profile',
    'assessments', v_items
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_candidate_session_verify(
  p_subject_id pg_catalog.uuid,
  p_session_id pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_user record;
  v_principal_id pg_catalog.uuid;
  v_profile hirearchy.candidate_profiles%ROWTYPE;
  v_meta hirearchy.hiring_session_metadata%ROWTYPE;
BEGIN
  SELECT id, lower(trim(email)) AS email, (email_confirmed_at IS NOT NULL) AS confirmed
  INTO v_user
  FROM auth.users
  WHERE id = p_subject_id;

  IF NOT FOUND OR NOT v_user.confirmed THEN
    RAISE EXCEPTION 'Email confirmation is required' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_principal_id
  FROM hirearchy.application_principals
  WHERE auth_user_id = p_subject_id;

  SELECT * INTO v_meta
  FROM hirearchy.hiring_session_metadata
  WHERE session_id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('gateState', 'unavailable');
  END IF;

  IF (
    v_meta.candidate_email <> v_user.email OR
    (v_meta.candidate_principal_id IS NOT NULL AND v_meta.candidate_principal_id IS DISTINCT FROM v_principal_id)
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'gateState', 'email_mismatch',
      'signedInEmail', v_user.email
    );
  END IF;

  IF v_principal_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'gateState', 'profile_required',
      'signedInEmail', v_user.email
    );
  END IF;

  SELECT * INTO v_profile
  FROM hirearchy.candidate_profiles
  WHERE principal_id = v_principal_id;

  IF NOT FOUND OR v_profile.profile_completed_at IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'gateState', 'profile_required',
      'signedInEmail', v_user.email
    );
  END IF;

  IF v_meta.candidate_principal_id IS NULL THEN
    UPDATE hirearchy.hiring_session_metadata
    SET candidate_principal_id = v_principal_id
    WHERE session_id = p_session_id AND candidate_principal_id IS NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'gateState', 'ready',
    'signedInEmail', v_user.email,
    'candidateName', v_profile.full_name,
    'candidateCode', v_profile.candidate_code
  );
END
$function$;

-- Account-authorized reads of frozen submissions never use the invitation envelope.
CREATE OR REPLACE FUNCTION staging.hiring_candidate_submission_read(
  p_subject_id pg_catalog.uuid,
  p_session_id pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_submission pg_catalog.jsonb;
  v_gate pg_catalog.text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM hirearchy.assessment_sessions
    WHERE id = p_session_id AND status = 'SUBMITTED'
  ) THEN
    RETURN NULL;
  END IF;

  v_gate := staging.hiring_candidate_session_verify(p_subject_id, p_session_id) ->> 'gateState';
  -- The profile requirement applies to starting an assessment. Both states have
  -- already matched the confirmed email and any bound candidate principal.
  IF COALESCE(v_gate, '') NOT IN ('ready', 'profile_required') THEN
    RETURN NULL;
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'title', session.scenario_title,
    'submittedAt', pg_catalog.to_char(submission.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'files', submission.manifest
  )
  INTO v_submission
  FROM hirearchy.candidate_session_submissions AS submission
  JOIN hirearchy.assessment_sessions AS session
    ON session.id = submission.session_id AND session.organization_id = submission.organization_id
  WHERE session.id = p_session_id AND session.status = 'SUBMITTED';

  RETURN v_submission;
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_plan_get(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_plan record;
  v_used pg_catalog.int4 := 0;
  v_emails pg_catalog.jsonb;
  v_purchased pg_catalog.int4 := 0;
  v_tier pg_catalog.text := 'none';
  v_updated_at pg_catalog.timestamptz := NULL;
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

  SELECT plan_tier, candidate_credits_purchased, updated_at
  INTO v_plan
  FROM hirearchy.organization_plans
  WHERE organization_id = p_organization_id;

  IF FOUND THEN
    v_tier := v_plan.plan_tier;
    v_purchased := v_plan.candidate_credits_purchased;
    v_updated_at := v_plan.updated_at;
  END IF;

  SELECT count(*)::pg_catalog.int4,
         COALESCE(pg_catalog.jsonb_agg(candidate_email ORDER BY consumed_at DESC), '[]'::pg_catalog.jsonb)
  INTO v_used, v_emails
  FROM hirearchy.organization_candidate_credits
  WHERE organization_id = p_organization_id;

  RETURN pg_catalog.jsonb_build_object(
    'planTier', v_tier,
    'candidateCreditsPurchased', v_purchased,
    'candidateCreditsUsed', v_used,
    'candidateCreditsRemaining', CASE WHEN v_tier = 'per_candidate' THEN GREATEST(0, v_purchased - v_used) ELSE NULL END,
    'creditedEmails', v_emails,
    'updatedAt', CASE WHEN v_updated_at IS NOT NULL THEN pg_catalog.to_char(v_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ELSE NULL END
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_plan_update(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_plan_tier pg_catalog.text,
  p_credits_mode pg_catalog.text,
  p_credits_amount pg_catalog.int4
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_owner_id pg_catalog.uuid;
  v_role pg_catalog.text;
  v_current_plan_tier pg_catalog.text;
  v_next_plan_tier pg_catalog.text := p_plan_tier;
  v_existing_credits pg_catalog.int4 := 0;
  v_next_credits pg_catalog.int4 := 0;
BEGIN
  IF p_plan_tier NOT IN ('per_candidate', 'pro', 'ultra', 'current') THEN
    RAISE EXCEPTION 'Invalid paid plan tier' USING ERRCODE = '22023';
  END IF;
  IF p_credits_mode NOT IN ('set', 'add') OR p_credits_amount < 0 THEN
    RAISE EXCEPTION 'Invalid candidate credit update' USING ERRCODE = '22023';
  END IF;

  SELECT owner_principal_id INTO v_owner_id
  FROM hirearchy.organizations
  WHERE id = p_organization_id;

  SELECT role INTO v_role
  FROM hirearchy.organization_memberships
  WHERE organization_id = p_organization_id
    AND principal_id = p_caller_principal_id
    AND status = 'active'
    AND revoked_at IS NULL;

  IF NOT FOUND OR (v_owner_id <> p_caller_principal_id AND v_role <> 'cto') THEN
    RAISE EXCEPTION 'Plan management requires CTO or owner permission' USING ERRCODE = '42501';
  END IF;

  SELECT candidate_credits_purchased, plan_tier INTO v_existing_credits, v_current_plan_tier
  FROM hirearchy.organization_plans
  WHERE organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    v_existing_credits := 0;
  END IF;

  IF p_plan_tier = 'current' THEN
    IF v_current_plan_tier IS DISTINCT FROM 'per_candidate' THEN
      RAISE EXCEPTION 'Candidate slots can only be adjusted on the Per Candidate plan' USING ERRCODE = '22023';
    END IF;
    v_next_plan_tier := v_current_plan_tier;
  END IF;

  IF v_next_plan_tier = 'per_candidate' THEN
    IF p_credits_mode = 'add' THEN
      v_next_credits := GREATEST(0, v_existing_credits + p_credits_amount);
    ELSE
      v_next_credits := GREATEST(0, p_credits_amount);
    END IF;
  ELSE
    v_next_credits := v_existing_credits;
  END IF;

  INSERT INTO hirearchy.organization_plans (
    organization_id, plan_tier, candidate_credits_purchased, updated_by_principal_id, updated_at
  ) VALUES (
    p_organization_id, v_next_plan_tier, v_next_credits, p_caller_principal_id, pg_catalog.clock_timestamp()
  )
  ON CONFLICT (organization_id) DO UPDATE SET
    plan_tier = EXCLUDED.plan_tier,
    candidate_credits_purchased = EXCLUDED.candidate_credits_purchased,
    updated_by_principal_id = EXCLUDED.updated_by_principal_id,
    updated_at = pg_catalog.clock_timestamp();

  RETURN staging.hiring_plan_get(p_organization_id, p_caller_principal_id);
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_library_list(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_items pg_catalog.jsonb;
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
        'definitionId', lib.definition_id::pg_catalog.text,
        'validatedVersionId', lib.validated_version_id::pg_catalog.text,
        'organizationId', lib.organization_id::pg_catalog.text,
        'authorPrincipalId', lib.author_principal_id::pg_catalog.text,
        'authorName', COALESCE(NULLIF(trim(ap.display_name), ''), u.email, 'Team Member'),
        'title', d.title,
        'brief', d.brief,
        'expectedBehavior', d.expected_behavior,
        'acceptanceCriteria', d.acceptance_criteria,
        'primaryFilePath', d.primary_file_path,
        'starterFiles', d.starter_files,
        'durationMinutes', d.duration_minutes,
        'terminalEnabled', d.terminal_enabled,
        'integratedAi', d.integrated_ai,
        'rubric', d.rubric,
        'sourceKind', lib.source_kind,
        'templateId', lib.template_id,
        'targetRole', lib.target_role,
        'experienceLevel', lib.experience_level,
        'yearsExperience', lib.years_experience,
        'skills', lib.skills,
        'problemStructure', lib.problem_structure,
        'workKind', lib.work_kind,
        'domain', lib.domain,
        'issuedCount', (
          SELECT count(*)::pg_catalog.int4
          FROM hirearchy.hiring_session_metadata m
          WHERE m.definition_id = lib.definition_id
        ),
        'createdAt', pg_catalog.to_char(lib.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) ORDER BY lib.updated_at DESC, lib.created_at DESC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_items
  FROM hirearchy.assessment_library_entries lib
  JOIN hirearchy.assessment_definitions def ON def.id = lib.definition_id
  JOIN hirearchy.assessment_drafts d
    ON d.definition_id = def.id
   AND d.organization_id = def.organization_id
   AND d.version = def.draft_version
  JOIN hirearchy.application_principals ap ON ap.id = lib.author_principal_id
  LEFT JOIN auth.users u ON u.id = ap.auth_user_id
  WHERE lib.organization_id = p_organization_id;

  RETURN pg_catalog.jsonb_build_object('problems', v_items);
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_library_save(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_payload pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_def_id pg_catalog.uuid;
  v_version_id pg_catalog.uuid;
  v_draft pg_catalog.jsonb;
  v_val pg_catalog.jsonb;
  v_meta pg_catalog.jsonb;
  v_template_id pg_catalog.text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM hirearchy.organization_memberships
    WHERE organization_id = p_organization_id
      AND principal_id = p_caller_principal_id
      AND role IN ('cto', 'recruiter', 'reviewer')
      AND status = 'active'
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Organization access denied' USING ERRCODE = '42501';
  END IF;

  v_draft := p_payload -> 'draft';
  v_val := p_payload -> 'validatedVersion';
  v_meta := p_payload -> 'metadata';

  v_def_id := pg_catalog.gen_random_uuid();
  v_version_id := pg_catalog.gen_random_uuid();
  v_template_id := COALESCE(NULLIF(v_draft ->> 'templateId', ''), 'ai-generated');
  IF v_template_id NOT IN ('custom', 'reservation-moves-v3', 'webhook-dedup-v1', 'cache-rate-limiter-v1', 'ai-generated') THEN
    v_template_id := 'ai-generated';
  END IF;

  INSERT INTO hirearchy.assessment_definitions (
    id, organization_id, author_principal_id, title, draft_version
  ) VALUES (
    v_def_id, p_organization_id, p_caller_principal_id, trim(v_draft ->> 'title'), 1
  );

  INSERT INTO hirearchy.assessment_drafts (
    definition_id, organization_id, author_principal_id, version,
    title, brief, expected_behavior, acceptance_criteria,
    primary_file_path, starter_files, duration_minutes,
    terminal_enabled, integrated_ai, rubric, template_id, updated_at, staging_content
  ) VALUES (
    v_def_id, p_organization_id, p_caller_principal_id, 1,
    trim(v_draft ->> 'title'),
    trim(v_draft ->> 'brief'),
    v_draft -> 'expectedBehavior',
    v_draft -> 'acceptanceCriteria',
    trim(v_draft ->> 'primaryFilePath'),
    v_draft -> 'starterFiles',
    (v_draft ->> 'durationMinutes')::pg_catalog.int4,
    COALESCE((v_draft ->> 'terminalEnabled')::pg_catalog.bool, true),
    COALESCE((v_draft ->> 'integratedAi')::pg_catalog.bool, false),
    v_draft -> 'rubric',
    v_template_id,
    pg_catalog.clock_timestamp(),
    v_draft
  );

  INSERT INTO hirearchy.assessment_validated_versions (
    id, definition_id, organization_id, author_principal_id,
    version_number, content_digest, scenario_id, scenario_version,
    scenario_title, scenario_snapshot, task_rubric_snapshot,
    duration_seconds, terminal_enabled, integrated_ai, validation_receipt
  ) VALUES (
    v_version_id, v_def_id, p_organization_id, p_caller_principal_id,
    1,
    v_val ->> 'contentDigest',
    v_val ->> 'scenarioId',
    v_val ->> 'scenarioVersion',
    v_val ->> 'scenarioTitle',
    (v_val -> 'scenarioSnapshot')::pg_catalog.text,
    v_val -> 'taskRubricSnapshot',
    (v_val ->> 'durationSeconds')::pg_catalog.int4,
    COALESCE((v_val ->> 'terminalEnabled')::pg_catalog.bool, true),
    COALESCE((v_val ->> 'integratedAi')::pg_catalog.bool, false),
    v_val -> 'validationReceipt'
  );

  INSERT INTO hirearchy.assessment_library_entries (
    definition_id, organization_id, author_principal_id, validated_version_id,
    source_kind, template_id, target_role, experience_level, years_experience,
    skills, problem_structure, work_kind, domain, generation_brief
  ) VALUES (
    v_def_id, p_organization_id, p_caller_principal_id, v_version_id,
    CASE WHEN (v_meta ->> 'sourceKind') = 'template' THEN 'template' ELSE 'ai_generated' END,
    v_template_id,
    left(trim(COALESCE(v_meta ->> 'targetRole', '')), 120),
    CASE WHEN (v_meta ->> 'experienceLevel') IN ('junior', 'mid', 'senior', 'staff') THEN (v_meta ->> 'experienceLevel') ELSE 'mid' END,
    GREATEST(0, LEAST(50, COALESCE((v_meta ->> 'yearsExperience')::pg_catalog.int4, 3))),
    CASE WHEN pg_catalog.jsonb_typeof(v_meta -> 'skills') = 'array' THEN v_meta -> 'skills' ELSE '[]'::pg_catalog.jsonb END,
    CASE WHEN (v_meta ->> 'problemStructure') = 'single_module' THEN 'single_module' ELSE 'multi_file' END,
    left(trim(COALESCE(v_meta ->> 'workKind', 'incident')), 64),
    left(trim(COALESCE(v_meta ->> 'domain', 'developer-tools')), 64),
    left(trim(COALESCE(v_meta ->> 'generationBrief', '')), 2000)
  );

  RETURN pg_catalog.jsonb_build_object(
    'definitionId', v_def_id::pg_catalog.text,
    'validatedVersionId', v_version_id::pg_catalog.text
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_issue_assessment(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_payload pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_caller_role pg_catalog.text;
  v_plan record;
  v_credits_used pg_catalog.int4 := 0;
  v_credits_purchased pg_catalog.int4 := 0;
  v_plan_tier pg_catalog.text := 'none';
  v_candidate_email pg_catalog.text;
  v_existing_credit pg_catalog.text;
  v_request_id pg_catalog.text;
  v_idem_key pg_catalog.text;
  v_request_hash pg_catalog.text;
  v_existing_issuance record;
  v_def_id pg_catalog.uuid;
  v_version_id pg_catalog.uuid;
  v_version record;
  v_lib hirearchy.assessment_library_entries%ROWTYPE;
  v_reviewer_id pg_catalog.uuid;
  v_session_id pg_catalog.text;
  v_candidate_principal_id pg_catalog.uuid;
  v_expires_at pg_catalog.timestamptz;
  v_token_hash pg_catalog.text;
  v_token_ciphertext pg_catalog.text;
  v_ai_snapshot pg_catalog.jsonb;
  v_credit_consumed boolean := false;
BEGIN
  SELECT role INTO v_caller_role
  FROM hirearchy.organization_memberships
  WHERE organization_id = p_organization_id
    AND principal_id = p_caller_principal_id
    AND status = 'active'
    AND revoked_at IS NULL;

  IF NOT FOUND OR v_caller_role NOT IN ('cto', 'recruiter', 'reviewer') THEN
    RAISE EXCEPTION 'Organization access denied' USING ERRCODE = '42501';
  END IF;

  v_candidate_email := lower(trim(COALESCE(p_payload ->> 'candidateEmail', '')));
  IF length(v_candidate_email) > 320 OR v_candidate_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Valid candidate email is required' USING ERRCODE = '22023';
  END IF;

  v_request_id := trim(COALESCE(p_payload ->> 'requestId', ''));
  IF v_request_id !~ '^[A-Za-z0-9._~-]{8,128}$' THEN
    RAISE EXCEPTION 'Valid requestId is required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hiring-plan:' || p_organization_id::pg_catalog.text, 0)
  );

  v_def_id := (p_payload ->> 'definitionId')::pg_catalog.uuid;
  v_version_id := (p_payload ->> 'validatedVersionId')::pg_catalog.uuid;
  v_reviewer_id := COALESCE(
    NULLIF(trim(p_payload ->> 'reviewerPrincipalId'), '')::pg_catalog.uuid,
    p_caller_principal_id
  );

  IF NOT EXISTS (
    SELECT 1 FROM hirearchy.organization_memberships
    WHERE organization_id = p_organization_id
      AND principal_id = v_reviewer_id
      AND status = 'active'
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Assigned reviewer must be an active organization member' USING ERRCODE = '42501';
  END IF;

  v_idem_key := 'hiring-issue-' || v_request_id;
  v_request_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      p_organization_id::pg_catalog.text || ':' || v_def_id::pg_catalog.text || ':' || v_version_id::pg_catalog.text || ':' || v_candidate_email || ':' || v_reviewer_id::pg_catalog.text,
      'UTF8'
    )),
    'hex'
  );

  SELECT session_id, request_hash INTO v_existing_issuance
  FROM hirearchy.assessment_issuances
  WHERE organization_id = p_organization_id
    AND idempotency_key = v_idem_key;

  IF FOUND THEN
    IF v_existing_issuance.request_hash <> v_request_hash THEN
      RAISE EXCEPTION 'Idempotency key reused with different issuance parameters' USING ERRCODE = '23505';
    END IF;
    SELECT count(*)::pg_catalog.int4 INTO v_credits_used
    FROM hirearchy.organization_candidate_credits
    WHERE organization_id = p_organization_id;
    SELECT candidate_credits_purchased INTO v_credits_purchased
    FROM hirearchy.organization_plans
    WHERE organization_id = p_organization_id;
    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'replayed', true,
      'sessionId', v_existing_issuance.session_id,
      'candidateTokenCiphertext', (SELECT candidate_token_ciphertext FROM hirearchy.candidate_token_envelopes WHERE session_id = v_existing_issuance.session_id),
      'expiresAt', (SELECT pg_catalog.to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM hirearchy.candidate_token_envelopes WHERE session_id = v_existing_issuance.session_id),
      'creditConsumed', false,
      'creditsUsed', v_credits_used,
      'creditsPurchased', COALESCE(v_credits_purchased, 0)
    );
  END IF;

  SELECT plan_tier, candidate_credits_purchased INTO v_plan
  FROM hirearchy.organization_plans
  WHERE organization_id = p_organization_id
  FOR UPDATE;

  IF FOUND THEN
    v_plan_tier := v_plan.plan_tier;
    v_credits_purchased := v_plan.candidate_credits_purchased;
  END IF;

  IF v_plan_tier = 'none' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false,
      'errorCode', 'PLAN_REQUIRED',
      'message', 'No active plan. A CTO or workspace owner must select Per Candidate, Pro, or Ultra in Team & Plan before issuing assessments.'
    );
  END IF;

  SELECT count(*)::pg_catalog.int4 INTO v_credits_used
  FROM hirearchy.organization_candidate_credits
  WHERE organization_id = p_organization_id;

  IF v_plan_tier = 'per_candidate' THEN
    SELECT candidate_email INTO v_existing_credit
    FROM hirearchy.organization_candidate_credits
    WHERE organization_id = p_organization_id
      AND candidate_email = v_candidate_email;

    IF NOT FOUND THEN
      IF v_credits_used >= v_credits_purchased THEN
        RETURN pg_catalog.jsonb_build_object(
          'ok', false,
          'errorCode', 'CANDIDATE_CREDIT_EXHAUSTED',
          'creditsUsed', v_credits_used,
          'creditsPurchased', v_credits_purchased,
          'message', 'All purchased candidate slots (' || v_credits_used || '/' || v_credits_purchased || ') have been used. Purchase more candidate credits or upgrade to Pro/Ultra.'
        );
      END IF;
      v_credit_consumed := true;
    END IF;
  END IF;

  SELECT * INTO v_version
  FROM hirearchy.assessment_validated_versions
  WHERE id = v_version_id
    AND definition_id = v_def_id
    AND organization_id = p_organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Validated assessment version not found' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_lib
  FROM hirearchy.assessment_library_entries
  WHERE definition_id = v_def_id
    AND organization_id = p_organization_id;

  v_expires_at := (p_payload ->> 'expiresAt')::pg_catalog.timestamptz;
  IF v_expires_at <= pg_catalog.clock_timestamp() OR v_expires_at > pg_catalog.clock_timestamp() + INTERVAL '30 days' THEN
    RAISE EXCEPTION 'Invitation expiry must be between now and 30 days' USING ERRCODE = '22023';
  END IF;

  v_token_hash := p_payload ->> 'candidateTokenHash';
  v_token_ciphertext := p_payload ->> 'candidateTokenCiphertext';
  IF v_token_hash !~ '^[0-9a-f]{64}$' OR v_token_ciphertext IS NULL OR length(v_token_ciphertext) < 10 THEN
    RAISE EXCEPTION 'Candidate invitation token material is invalid' USING ERRCODE = '22023';
  END IF;

  v_session_id := COALESCE(
    NULLIF(trim(COALESCE(p_payload ->> 'sessionId', '')), ''),
    'sess_' || pg_catalog.gen_random_uuid()::pg_catalog.text
  );
  IF v_session_id !~ '^sess_[A-Za-z0-9_-]{8,128}$' THEN
    RAISE EXCEPTION 'Invalid sessionId format' USING ERRCODE = '22023';
  END IF;
  v_ai_snapshot := CASE
    WHEN v_version.integrated_ai THEN pg_catalog.jsonb_build_object(
      'enabled', true,
      'providerId', 'nvidia-nim',
      'modelId', 'moonshotai/kimi-k3.1-pro',
      'maxInteractions', 15,
      'maxPromptChars', 4000
    )
    ELSE '{"enabled": false, "integratedAi": false}'::pg_catalog.jsonb
  END;

  INSERT INTO hirearchy.assessment_sessions (
    id, organization_id, issuer_principal_id, scenario_id,
    scenario_version, scenario_title, scenario_snapshot,
    task_rubric_snapshot, duration_seconds, terminal_enabled,
    ai_capability_snapshot, status, created_at
  ) VALUES (
    v_session_id,
    p_organization_id,
    p_caller_principal_id,
    v_version.scenario_id,
    v_version.scenario_version,
    v_version.scenario_title,
    v_version.scenario_snapshot,
    v_version.task_rubric_snapshot,
    v_version.duration_seconds,
    true,
    v_ai_snapshot,
    'CREATED',
    pg_catalog.clock_timestamp()
  );

  INSERT INTO hirearchy.reviewer_assignments (
    id, organization_id, session_id, reviewer_principal_id, assigned_by_principal_id
  ) VALUES (
    'rva_' || pg_catalog.gen_random_uuid()::pg_catalog.text,
    p_organization_id, v_session_id, v_reviewer_id, p_caller_principal_id
  );

  INSERT INTO hirearchy.assessment_issuances (
    organization_id, idempotency_key, session_id, issuer_principal_id,
    request_hash, payload_hash, assessment_id, validated_version_id
  ) VALUES (
    p_organization_id, v_idem_key, v_session_id, p_caller_principal_id,
    v_request_hash, v_version.content_digest, v_def_id, v_version_id
  );

  INSERT INTO hirearchy.candidate_token_envelopes (
    organization_id, session_id, candidate_token_hash, candidate_token_ciphertext, expires_at
  ) VALUES (
    p_organization_id, v_session_id, v_token_hash, v_token_ciphertext, v_expires_at
  );

  INSERT INTO hirearchy.candidate_invitation_requests (
    organization_id, idempotency_key, session_id, issuer_principal_id, request_hash, expires_at
  ) VALUES (
    p_organization_id, v_idem_key, v_session_id, p_caller_principal_id, v_request_hash, v_expires_at
  );

  SELECT cp.principal_id INTO v_candidate_principal_id
  FROM hirearchy.candidate_profiles cp
  WHERE lower(cp.email) = v_candidate_email
  LIMIT 1;

  INSERT INTO hirearchy.hiring_session_metadata (
    session_id, organization_id, candidate_email, candidate_principal_id,
    definition_id, target_role, experience_level, skills, invitation_note
  ) VALUES (
    v_session_id,
    p_organization_id,
    v_candidate_email,
    v_candidate_principal_id,
    v_def_id,
    COALESCE(NULLIF(trim(p_payload ->> 'targetRole'), ''), v_lib.target_role, ''),
    COALESCE(NULLIF(trim(p_payload ->> 'experienceLevel'), ''), v_lib.experience_level, 'mid'),
    CASE
      WHEN pg_catalog.jsonb_typeof(p_payload -> 'skills') = 'array' THEN p_payload -> 'skills'
      WHEN v_lib.skills IS NOT NULL THEN v_lib.skills
      ELSE '[]'::pg_catalog.jsonb
    END,
    left(trim(COALESCE(p_payload ->> 'invitationNote', '')), 1000)
  );

  IF v_plan_tier = 'per_candidate' AND v_credit_consumed THEN
    INSERT INTO hirearchy.organization_candidate_credits (
      organization_id, candidate_email, first_session_id
    ) VALUES (
      p_organization_id, v_candidate_email, v_session_id
    ) ON CONFLICT DO NOTHING;
    v_credits_used := v_credits_used + 1;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'replayed', false,
    'sessionId', v_session_id,
    'candidateTokenCiphertext', v_token_ciphertext,
    'expiresAt', pg_catalog.to_char(v_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'creditConsumed', v_credit_consumed,
    'creditsUsed', v_credits_used,
    'creditsPurchased', v_credits_purchased
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_candidates_list(
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
  v_role pg_catalog.text;
  v_is_org_wide boolean;
  v_rows pg_catalog.jsonb;
BEGIN
  SELECT owner_principal_id INTO v_owner_id
  FROM hirearchy.organizations
  WHERE id = p_organization_id;

  SELECT role INTO v_role
  FROM hirearchy.organization_memberships
  WHERE organization_id = p_organization_id
    AND principal_id = p_caller_principal_id
    AND status = 'active'
    AND revoked_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization access denied' USING ERRCODE = '42501';
  END IF;

  v_is_org_wide := (v_owner_id = p_caller_principal_id OR v_role IN ('cto', 'recruiter'));

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'sessionId', s.id,
        'candidateEmail', m.candidate_email,
        'candidatePrincipalId', m.candidate_principal_id::pg_catalog.text,
        'scenarioTitle', s.scenario_title,
        'targetRole', m.target_role,
        'experienceLevel', m.experience_level,
        'skills', m.skills,
        'durationSeconds', s.duration_seconds,
        'lifecycleStatus', s.status,
        'createdAt', pg_catalog.to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'activatedAt', CASE WHEN s.activated_at IS NULL THEN NULL ELSE pg_catalog.to_char(s.activated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
        'submittedAt', CASE WHEN s.submitted_at IS NULL THEN NULL ELSE pg_catalog.to_char(s.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
        'issuerPrincipalId', s.issuer_principal_id::pg_catalog.text,
        'issuerName', COALESCE(NULLIF(trim(issuer_p.display_name), ''), issuer_u.email, 'Team Member'),
        'assignedReviewerPrincipalId', ra.reviewer_principal_id::pg_catalog.text,
        'assignedReviewerName', COALESCE(NULLIF(trim(rev_p.display_name), ''), rev_u.email),
        'invitationActive', (env.revoked_at IS NULL AND env.expires_at IS NOT NULL AND env.expires_at > pg_catalog.clock_timestamp()),
        'invitationExpiresAt', CASE WHEN env.expires_at IS NULL THEN NULL ELSE pg_catalog.to_char(env.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
        'candidateTokenCiphertext', CASE WHEN (v_is_org_wide OR s.issuer_principal_id = p_caller_principal_id) AND env.revoked_at IS NULL AND env.expires_at IS NOT NULL AND env.expires_at > pg_catalog.clock_timestamp() THEN env.candidate_token_ciphertext ELSE NULL END,
        'profile', CASE
          WHEN cp.principal_id IS NULL THEN NULL
          ELSE pg_catalog.jsonb_build_object(
            'candidateCode', cp.candidate_code,
            'fullName', cp.full_name,
            'phone', cp.phone,
            'locationCountry', cp.location_country,
            'locationCity', cp.location_city,
            'workMode', cp.work_mode,
            'headlineRole', cp.headline_role,
            'yearsExperience', cp.years_experience,
            'experienceLevel', cp.experience_level,
            'skills', cp.skills,
            'linkedinUrl', cp.linkedin_url,
            'githubUrl', cp.github_url,
            'portfolioUrl', cp.portfolio_url,
            'bio', cp.bio
          )
        END,
        'decision', CASE
          WHEN dec.session_id IS NULL THEN NULL
          ELSE pg_catalog.jsonb_build_object(
            'sessionId', dec.session_id,
            'organizationId', dec.organization_id::pg_catalog.text,
            'decidedByPrincipalId', dec.decided_by_principal_id::pg_catalog.text,
            'decidedByName', COALESCE(NULLIF(trim(dec_p.display_name), ''), dec_u.email, 'Evaluator'),
            'decision', dec.decision,
            'candidateStrengths', dec.candidate_strengths,
            'candidateWeaknesses', dec.candidate_weaknesses,
            'candidateFeedbackNote', dec.candidate_feedback_note,
            'nextStageLabel', dec.next_stage_label,
            'handoffRecipientPrincipalId', dec.handoff_recipient_principal_id::pg_catalog.text,
            'handoffRecipientName', COALESCE(NULLIF(trim(hr_p.display_name), ''), hr_u.email),
            'handoffStatus', dec.handoff_status,
            'publishedAt', pg_catalog.to_char(dec.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'updatedAt', pg_catalog.to_char(dec.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          )
        END,
        'secondOpinions', COALESCE((
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'id', so.id::pg_catalog.text,
              'sessionId', so.session_id,
              'requestedByPrincipalId', so.requested_by_principal_id::pg_catalog.text,
              'requestedByName', COALESCE(NULLIF(trim(so_req_p.display_name), ''), so_req_u.email, 'Team Member'),
              'requestedReviewerPrincipalId', so.requested_reviewer_principal_id::pg_catalog.text,
              'requestedReviewerName', COALESCE(NULLIF(trim(so_rev_p.display_name), ''), so_rev_u.email, 'Reviewer'),
              'requestNote', so.request_note,
              'requestContext', COALESCE(so.request_context, '{}'::pg_catalog.jsonb),
              'responseNote', so.response_note,
              'verdict', so.verdict,
              'status', so.status,
              'createdAt', pg_catalog.to_char(so.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
              'respondedAt', CASE WHEN so.responded_at IS NULL THEN NULL ELSE pg_catalog.to_char(so.responded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
            ) ORDER BY so.created_at DESC
          )
          FROM hirearchy.hiring_second_opinions so
          LEFT JOIN hirearchy.application_principals so_req_p ON so_req_p.id = so.requested_by_principal_id
          LEFT JOIN auth.users so_req_u ON so_req_u.id = so_req_p.auth_user_id
          LEFT JOIN hirearchy.application_principals so_rev_p ON so_rev_p.id = so.requested_reviewer_principal_id
          LEFT JOIN auth.users so_rev_u ON so_rev_u.id = so_rev_p.auth_user_id
          WHERE so.session_id = s.id AND so.organization_id = p_organization_id
        ), '[]'::pg_catalog.jsonb)
      ) ORDER BY s.created_at DESC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_rows
  FROM hirearchy.hiring_session_metadata m
  JOIN hirearchy.assessment_sessions s ON s.id = m.session_id
  LEFT JOIN hirearchy.candidate_profiles cp
    ON cp.principal_id = COALESCE(
      m.candidate_principal_id,
      (SELECT cp2.principal_id FROM hirearchy.candidate_profiles cp2 WHERE lower(cp2.email) = m.candidate_email LIMIT 1)
    )
  LEFT JOIN hirearchy.candidate_token_envelopes env ON env.session_id = s.id
  LEFT JOIN LATERAL (
    SELECT a.reviewer_principal_id
    FROM hirearchy.reviewer_assignments a
    WHERE a.organization_id = p_organization_id AND a.session_id = s.id AND a.revoked_at IS NULL
    ORDER BY a.assigned_at ASC
    LIMIT 1
  ) ra ON true
  LEFT JOIN hirearchy.application_principals issuer_p ON issuer_p.id = s.issuer_principal_id
  LEFT JOIN auth.users issuer_u ON issuer_u.id = issuer_p.auth_user_id
  LEFT JOIN hirearchy.application_principals rev_p ON rev_p.id = ra.reviewer_principal_id
  LEFT JOIN auth.users rev_u ON rev_u.id = rev_p.auth_user_id
  LEFT JOIN hirearchy.hiring_decisions dec ON dec.session_id = s.id
  LEFT JOIN hirearchy.application_principals dec_p ON dec_p.id = dec.decided_by_principal_id
  LEFT JOIN auth.users dec_u ON dec_u.id = dec_p.auth_user_id
  LEFT JOIN hirearchy.application_principals hr_p ON hr_p.id = dec.handoff_recipient_principal_id
  LEFT JOIN auth.users hr_u ON hr_u.id = hr_p.auth_user_id
  WHERE m.organization_id = p_organization_id
    AND (
      v_is_org_wide
      OR s.issuer_principal_id = p_caller_principal_id
      OR EXISTS (
        SELECT 1 FROM hirearchy.reviewer_assignments a2
        WHERE a2.organization_id = p_organization_id
          AND a2.session_id = s.id
          AND a2.reviewer_principal_id = p_caller_principal_id
          AND a2.revoked_at IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM hirearchy.hiring_second_opinions so2
        WHERE so2.organization_id = p_organization_id
          AND so2.session_id = s.id
          AND so2.requested_reviewer_principal_id = p_caller_principal_id
      )
      OR (dec.handoff_recipient_principal_id = p_caller_principal_id)
    );

  RETURN pg_catalog.jsonb_build_object(
    'rows', v_rows,
    'plan', staging.hiring_plan_get(p_organization_id, p_caller_principal_id),
    'currentRole', CASE WHEN v_owner_id = p_caller_principal_id THEN 'cto' ELSE v_role END,
    'isOwner', (v_owner_id = p_caller_principal_id)
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_get_session_ai_interactions(
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_items pg_catalog.jsonb;
BEGIN
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'interactionId', ai.interaction_id,
        'requestId', ai.request_id,
        'sequenceStart', ai.sequence_start::pg_catalog.text,
        'sequenceCompleted', CASE WHEN ai.sequence_completed IS NULL THEN NULL ELSE ai.sequence_completed::pg_catalog.text END,
        'candidatePrompt', ai.candidate_prompt,
        'assistantResponse', ai.assistant_response,
        'status', ai.status,
        'failureReason', ai.failure_reason,
        'errorMessage', ai.error_message,
        'providerId', ai.provider_id,
        'modelId', ai.model_id,
        'createdAt', pg_catalog.to_char(ai.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'completedAt', CASE WHEN ai.completed_at IS NULL THEN NULL ELSE pg_catalog.to_char(ai.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
      ) ORDER BY ai.sequence_start
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_items
  FROM hirearchy.candidate_ai_interactions ai
  WHERE ai.organization_id = p_organization_id
    AND ai.session_id = p_session_id;

  RETURN v_items;
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_get_session_executions(
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_items pg_catalog.jsonb;
BEGIN
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'organizationId', op.organization_id::pg_catalog.text,
        'sessionId', op.session_id,
        'operationId', op.operation_id,
        'requestId', op.request_id,
        'sequenceStart', op.sequence_start::pg_catalog.text,
        'sequenceCompleted', CASE WHEN op.sequence_completed IS NOT NULL THEN op.sequence_completed::pg_catalog.text ELSE NULL END,
        'workspaceDigest', op.workspace_digest,
        'workspaceVersion', op.workspace_version::pg_catalog.text,
        'recipeId', op.recipe_id,
        'recipeVersion', op.recipe_version,
        'recipeDigest', op.recipe_digest,
        'generation', op.generation,
        'fence', op.fence,
        'status', op.status,
        'exitCode', op.exit_code,
        'stdout', op.stdout,
        'stderr', op.stderr,
        'stdoutDigest', op.stdout_digest,
        'stderrDigest', op.stderr_digest,
        'truncatedStdout', op.truncated_stdout,
        'truncatedStderr', op.truncated_stderr,
        'durationMs', op.duration_ms,
        'failureReason', op.failure_reason,
        'errorMessage', op.error_message,
        'cleanupStatus', op.cleanup_status,
        'isUnknown', op.is_unknown,
        'provenance', op.provenance,
        'isSynthetic', (op.provenance = 'synthetic-execution-adapter'),
        'createdAt', pg_catalog.to_char(op.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'completedAt', CASE WHEN op.completed_at IS NOT NULL THEN pg_catalog.to_char(op.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ELSE NULL END
      ) ORDER BY op.sequence_start
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_items
  FROM hirearchy.candidate_execution_operations AS op
  WHERE op.organization_id = p_organization_id
    AND op.session_id = p_session_id;

  RETURN v_items;
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_can_access_session(
  p_organization_id pg_catalog.uuid,
  p_principal_id pg_catalog.uuid,
  p_session_id pg_catalog.text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_owner_id pg_catalog.uuid;
  v_role pg_catalog.text;
BEGIN
  SELECT owner_principal_id INTO v_owner_id
  FROM hirearchy.organizations WHERE id = p_organization_id;

  SELECT role INTO v_role
  FROM hirearchy.organization_memberships
  WHERE organization_id = p_organization_id
    AND principal_id = p_principal_id
    AND status = 'active'
    AND revoked_at IS NULL;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_owner_id = p_principal_id OR v_role IN ('cto', 'recruiter') THEN
    RETURN EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions
      WHERE organization_id = p_organization_id AND id = p_session_id
    );
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM hirearchy.assessment_sessions s
    WHERE s.organization_id = p_organization_id
      AND s.id = p_session_id
      AND (
        s.issuer_principal_id = p_principal_id
        OR EXISTS (
          SELECT 1 FROM hirearchy.reviewer_assignments a
          WHERE a.organization_id = p_organization_id
            AND a.session_id = p_session_id
            AND a.reviewer_principal_id = p_principal_id
            AND a.revoked_at IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM hirearchy.hiring_second_opinions so
          WHERE so.organization_id = p_organization_id
            AND so.session_id = p_session_id
            AND so.requested_reviewer_principal_id = p_principal_id
        )
        OR EXISTS (
          SELECT 1 FROM hirearchy.hiring_decisions d
          WHERE d.organization_id = p_organization_id
            AND d.session_id = p_session_id
            AND d.handoff_recipient_principal_id = p_principal_id
        )
      )
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_can_publish_decision(
  p_organization_id pg_catalog.uuid,
  p_principal_id pg_catalog.uuid,
  p_session_id pg_catalog.text
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM hirearchy.organizations o
    JOIN hirearchy.organization_memberships m ON m.organization_id = o.id
    JOIN hirearchy.assessment_sessions s ON s.organization_id = o.id
    WHERE o.id = p_organization_id AND s.id = p_session_id
      AND m.principal_id = p_principal_id AND m.status = 'active' AND m.revoked_at IS NULL
      AND (
        o.owner_principal_id = p_principal_id OR m.role = 'cto' OR EXISTS (
          SELECT 1 FROM hirearchy.reviewer_assignments a
          WHERE a.organization_id = o.id AND a.session_id = s.id
            AND a.reviewer_principal_id = p_principal_id AND a.revoked_at IS NULL
        )
      )
  );
$function$;

REVOKE ALL ON FUNCTION staging.hiring_can_publish_decision(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staging.hiring_can_publish_decision(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) TO staging_verifier_owner;

CREATE OR REPLACE FUNCTION staging.hiring_evidence_read(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_session_id pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_session record;
  v_events pg_catalog.jsonb;
  v_revisions pg_catalog.jsonb;
  v_submissions pg_catalog.jsonb;
  v_observations pg_catalog.jsonb;
  v_obs_history pg_catalog.jsonb;
  v_ai pg_catalog.jsonb;
  v_executions pg_catalog.jsonb;
BEGIN
  IF NOT staging.hiring_can_access_session(p_organization_id, p_caller_principal_id, p_session_id) THEN
    RAISE EXCEPTION 'Session evidence access denied' USING ERRCODE = '42501';
  END IF;

  SELECT s.*,
         pg_catalog.to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso,
         CASE WHEN s.activated_at IS NULL THEN NULL ELSE pg_catalog.to_char(s.activated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS activated_at_iso,
         CASE WHEN s.submitted_at IS NULL THEN NULL ELSE pg_catalog.to_char(s.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS submitted_at_iso
  INTO v_session
  FROM hirearchy.assessment_sessions s
  WHERE s.organization_id = p_organization_id AND s.id = p_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assessment session not found' USING ERRCODE = '42501';
  END IF;

  IF v_session.status <> 'SUBMITTED' THEN
    RETURN pg_catalog.jsonb_build_object(
      'session', pg_catalog.jsonb_build_object(
        'id', v_session.id, 'organizationId', p_organization_id::pg_catalog.text,
        'scenarioId', v_session.scenario_id, 'scenarioVersion', v_session.scenario_version,
        'scenarioTitle', v_session.scenario_title, 'status', v_session.status,
        'durationSeconds', v_session.duration_seconds,
        'createdAt', v_session.created_at_iso,
        'activatedAt', v_session.activated_at_iso,
        'submittedAt', v_session.submitted_at_iso,
        'closureReason', v_session.closure_reason,
        'reviewProcessStatus', v_session.review_process_status,
        'terminalEnabled', v_session.terminal_enabled,
        'aiCapabilitySnapshot', v_session.ai_capability_snapshot,
        'scenarioSnapshot', v_session.scenario_snapshot,
        'taskRubricSnapshot', v_session.task_rubric_snapshot
      ),
      'events', '[]'::pg_catalog.jsonb,
      'fileRevisions', '[]'::pg_catalog.jsonb,
      'submissions', '[]'::pg_catalog.jsonb,
      'observations', '[]'::pg_catalog.jsonb,
      'observationHistory', '[]'::pg_catalog.jsonb,
      'aiInteractions', '[]'::pg_catalog.jsonb,
      'executions', '[]'::pg_catalog.jsonb,
      'captureLimitation', 'Evidence opens after the candidate submits their workspace.'
    );
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'sequence', sequence, 'eventType', event_type,
    'happenedAt', pg_catalog.to_char(happened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'payload', payload
  ) ORDER BY sequence), '[]'::pg_catalog.jsonb)
  INTO v_events
  FROM hirearchy.candidate_session_events
  WHERE organization_id = p_organization_id AND session_id = p_session_id;

  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'path', file_path, 'version', version, 'content', content,
    'contentDigest', content_digest,
    'acceptedAt', pg_catalog.to_char(accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'eventSequence', event_sequence
  ) ORDER BY file_path, version), '[]'::pg_catalog.jsonb)
  INTO v_revisions
  FROM hirearchy.candidate_file_revisions
  WHERE organization_id = p_organization_id AND session_id = p_session_id;

  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'submittedAt', pg_catalog.to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'closureReason', closure_reason, 'workspaceDigest', workspace_digest,
    'manifestDigest', manifest_digest, 'manifest', manifest
  )), '[]'::pg_catalog.jsonb)
  INTO v_submissions
  FROM hirearchy.candidate_session_submissions
  WHERE organization_id = p_organization_id AND session_id = p_session_id;

  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', id::pg_catalog.text, 'sourceType', evidence_source_type,
    'eventSequence', event_sequence, 'filePath', file_path,
    'fileVersion', file_version, 'evidenceDigest', evidence_digest,
    'body', body, 'version', version,
    'createdAt', pg_catalog.to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updatedAt', pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ) ORDER BY created_at, id), '[]'::pg_catalog.jsonb)
  INTO v_observations
  FROM hirearchy.evaluator_observations
  WHERE organization_id = p_organization_id AND session_id = p_session_id;

  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'historyId', history_id::pg_catalog.text, 'observationId', observation_id::pg_catalog.text,
    'version', version, 'body', body, 'validFrom', valid_from,
    'validUntil', valid_until, 'recordedAt', recorded_at
  ) ORDER BY recorded_at, history_id), '[]'::pg_catalog.jsonb)
  INTO v_obs_history
  FROM hirearchy.evaluator_observation_history
  WHERE organization_id = p_organization_id AND session_id = p_session_id;

  v_ai := staging.hiring_get_session_ai_interactions(p_organization_id, p_session_id);
  v_executions := staging.hiring_get_session_executions(p_organization_id, p_session_id);

  RETURN pg_catalog.jsonb_build_object(
    'session', pg_catalog.jsonb_build_object(
      'id', v_session.id, 'organizationId', p_organization_id::pg_catalog.text,
      'scenarioId', v_session.scenario_id, 'scenarioVersion', v_session.scenario_version,
      'scenarioTitle', v_session.scenario_title, 'status', v_session.status,
      'durationSeconds', v_session.duration_seconds,
      'createdAt', v_session.created_at_iso,
      'activatedAt', v_session.activated_at_iso,
      'submittedAt', v_session.submitted_at_iso,
      'closureReason', v_session.closure_reason,
      'reviewProcessStatus', v_session.review_process_status,
      'terminalEnabled', v_session.terminal_enabled,
      'aiCapabilitySnapshot', v_session.ai_capability_snapshot,
      'scenarioSnapshot', v_session.scenario_snapshot,
      'taskRubricSnapshot', v_session.task_rubric_snapshot
    ),
    'events', v_events,
    'fileRevisions', v_revisions,
    'submissions', v_submissions,
    'observations', v_observations,
    'observationHistory', v_obs_history,
    'aiInteractions', v_ai,
    'executions', v_executions
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_review_context(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_session_id pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_owner_id pg_catalog.uuid;
  v_org_name pg_catalog.text;
  v_scenario_title pg_catalog.text;
  v_role pg_catalog.text;
  v_meta hirearchy.hiring_session_metadata%ROWTYPE;
  v_cp hirearchy.candidate_profiles%ROWTYPE;
  v_has_cp boolean := false;
  v_dec record;
  v_has_dec boolean := false;
  v_opinions pg_catalog.jsonb;
  v_members pg_catalog.jsonb;
  v_plan pg_catalog.jsonb;
BEGIN
  IF NOT staging.hiring_can_access_session(p_organization_id, p_caller_principal_id, p_session_id) THEN
    RAISE EXCEPTION 'Review context access denied' USING ERRCODE = '42501';
  END IF;

  SELECT owner_principal_id, COALESCE(display_name, 'Organization') INTO v_owner_id, v_org_name FROM hirearchy.organizations WHERE id = p_organization_id;
  SELECT scenario_title INTO v_scenario_title FROM hirearchy.assessment_sessions WHERE id = p_session_id AND organization_id = p_organization_id;
  SELECT role INTO v_role FROM hirearchy.organization_memberships
  WHERE organization_id = p_organization_id AND principal_id = p_caller_principal_id AND status = 'active' AND revoked_at IS NULL;

  SELECT * INTO v_meta FROM hirearchy.hiring_session_metadata WHERE session_id = p_session_id;
  IF FOUND THEN
    SELECT * INTO v_cp FROM hirearchy.candidate_profiles
    WHERE principal_id = COALESCE(
      v_meta.candidate_principal_id,
      (SELECT cp2.principal_id FROM hirearchy.candidate_profiles cp2 WHERE lower(cp2.email) = v_meta.candidate_email LIMIT 1)
    );
    v_has_cp := FOUND;
  END IF;

  SELECT d.*,
         COALESCE(NULLIF(trim(dp.display_name), ''), du.email, 'Evaluator') AS decided_by_name,
         COALESCE(NULLIF(trim(hp.display_name), ''), hu.email) AS handoff_recipient_name
  INTO v_dec
  FROM hirearchy.hiring_decisions d
  LEFT JOIN hirearchy.application_principals dp ON dp.id = d.decided_by_principal_id
  LEFT JOIN auth.users du ON du.id = dp.auth_user_id
  LEFT JOIN hirearchy.application_principals hp ON hp.id = d.handoff_recipient_principal_id
  LEFT JOIN auth.users hu ON hu.id = hp.auth_user_id
  WHERE d.session_id = p_session_id AND d.organization_id = p_organization_id;
  v_has_dec := FOUND;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', so.id::pg_catalog.text,
        'sessionId', so.session_id,
        'requestedByPrincipalId', so.requested_by_principal_id::pg_catalog.text,
        'requestedByName', COALESCE(NULLIF(trim(rp.display_name), ''), ru.email, 'Team Member'),
        'requestedByEmail', COALESCE(ru.email, ''),
        'requestedReviewerPrincipalId', so.requested_reviewer_principal_id::pg_catalog.text,
        'requestedReviewerName', COALESCE(NULLIF(trim(vp.display_name), ''), vu.email, 'Reviewer'),
        'requestedReviewerEmail', COALESCE(vu.email, ''),
        'requestNote', so.request_note,
        'requestContext', COALESCE(so.request_context, '{}'::pg_catalog.jsonb),
        'responseNote', so.response_note,
        'verdict', so.verdict,
        'status', so.status,
        'createdAt', pg_catalog.to_char(so.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'respondedAt', CASE WHEN so.responded_at IS NULL THEN NULL ELSE pg_catalog.to_char(so.responded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
      ) ORDER BY so.created_at DESC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_opinions
  FROM hirearchy.hiring_second_opinions so
  LEFT JOIN hirearchy.application_principals rp ON rp.id = so.requested_by_principal_id
  LEFT JOIN auth.users ru ON ru.id = rp.auth_user_id
  LEFT JOIN hirearchy.application_principals vp ON vp.id = so.requested_reviewer_principal_id
  LEFT JOIN auth.users vu ON vu.id = vp.auth_user_id
  WHERE so.session_id = p_session_id AND so.organization_id = p_organization_id;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'principalId', m.principal_id::pg_catalog.text,
        'displayName', COALESCE(NULLIF(trim(p.display_name), ''), u.email, 'Team Member'),
        'email', COALESCE(u.email, ''),
        'role', CASE WHEN v_owner_id = m.principal_id THEN 'cto' ELSE m.role END,
        'isOwner', (v_owner_id = m.principal_id)
      ) ORDER BY (v_owner_id = m.principal_id) DESC, m.joined_at ASC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_members
  FROM hirearchy.organization_memberships m
  JOIN hirearchy.application_principals p ON p.id = m.principal_id
  LEFT JOIN auth.users u ON u.id = p.auth_user_id
  WHERE m.organization_id = p_organization_id AND m.status = 'active' AND m.revoked_at IS NULL;

  v_plan := staging.hiring_plan_get(p_organization_id, p_caller_principal_id);

  RETURN pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id::pg_catalog.text,
    'organizationName', COALESCE(v_org_name, ''),
    'sessionId', p_session_id,
    'scenarioTitle', COALESCE(v_scenario_title, ''),
    'currentPrincipalId', p_caller_principal_id::pg_catalog.text,
    'currentRole', CASE WHEN v_owner_id = p_caller_principal_id THEN 'cto' ELSE v_role END,
    'isOwner', (v_owner_id = p_caller_principal_id),
    'canPublishDecision', staging.hiring_can_publish_decision(p_organization_id, p_caller_principal_id, p_session_id),
    'plan', v_plan,
    'targetRole', COALESCE(v_meta.target_role, ''),
    'experienceLevel', COALESCE(v_meta.experience_level, 'mid'),
    'skills', COALESCE(v_meta.skills, '[]'::pg_catalog.jsonb),
    'candidateEmail', v_meta.candidate_email,
    'candidateName', CASE WHEN v_has_cp THEN v_cp.full_name ELSE NULL END,
    'candidateCode', CASE WHEN v_has_cp THEN v_cp.candidate_code ELSE NULL END,
    'decision', CASE
      WHEN NOT v_has_dec THEN NULL
      ELSE pg_catalog.jsonb_build_object(
        'sessionId', v_dec.session_id,
        'organizationId', v_dec.organization_id::pg_catalog.text,
        'decidedByPrincipalId', v_dec.decided_by_principal_id::pg_catalog.text,
        'decidedByName', v_dec.decided_by_name,
        'decision', v_dec.decision,
        'candidateStrengths', v_dec.candidate_strengths,
        'candidateWeaknesses', v_dec.candidate_weaknesses,
        'candidateFeedbackNote', v_dec.candidate_feedback_note,
        'internalNotes', v_dec.internal_notes,
        'nextStageLabel', v_dec.next_stage_label,
        'handoffRecipientPrincipalId', v_dec.handoff_recipient_principal_id::pg_catalog.text,
        'handoffRecipientName', v_dec.handoff_recipient_name,
        'handoffStatus', v_dec.handoff_status,
        'performanceReport', v_dec.performance_report,
        'publishedAt', pg_catalog.to_char(v_dec.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'updatedAt', pg_catalog.to_char(v_dec.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      )
    END,
    'secondOpinions', v_opinions,
    'teamMembers', v_members
  );
END
$function$;

DROP FUNCTION IF EXISTS staging.hiring_second_opinion_create(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text
);

CREATE OR REPLACE FUNCTION staging.hiring_second_opinion_create(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_session_id pg_catalog.text,
  p_reviewer_principal_id pg_catalog.uuid,
  p_note pg_catalog.text,
  p_request_context pg_catalog.jsonb DEFAULT '{}'::pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_id pg_catalog.uuid;
  v_context pg_catalog.jsonb;
BEGIN
  IF NOT staging.hiring_can_access_session(p_organization_id, p_caller_principal_id, p_session_id) THEN
    RAISE EXCEPTION 'Session access denied' USING ERRCODE = '42501';
  END IF;

  IF p_reviewer_principal_id = p_caller_principal_id THEN
    RAISE EXCEPTION 'Peer review requires a different team member' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM hirearchy.organization_memberships
    WHERE organization_id = p_organization_id
      AND principal_id = p_reviewer_principal_id
      AND status = 'active'
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Target reviewer must be an active organization member' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM hirearchy.reviewer_assignments
    WHERE organization_id = p_organization_id
      AND session_id = p_session_id
      AND reviewer_principal_id = p_reviewer_principal_id
      AND revoked_at IS NULL
  ) THEN
    INSERT INTO hirearchy.reviewer_assignments (
      id, organization_id, session_id, reviewer_principal_id, assigned_by_principal_id
    ) VALUES (
      'rva_' || pg_catalog.gen_random_uuid()::pg_catalog.text,
      p_organization_id, p_session_id, p_reviewer_principal_id, p_caller_principal_id
    );
  END IF;

  v_context := CASE
    WHEN p_request_context IS NOT NULL AND pg_catalog.jsonb_typeof(p_request_context) = 'object'
      THEN p_request_context
    ELSE '{}'::pg_catalog.jsonb
  END;

  v_id := pg_catalog.gen_random_uuid();
  INSERT INTO hirearchy.hiring_second_opinions (
    id, organization_id, session_id, requested_by_principal_id, requested_reviewer_principal_id, request_note, request_context
  ) VALUES (
    v_id, p_organization_id, p_session_id, p_caller_principal_id, p_reviewer_principal_id,
    left(trim(COALESCE(p_note, '')), 2000),
    v_context
  );

  UPDATE hirearchy.assessment_sessions
  SET review_process_status = CASE
    WHEN review_process_status = 'not_started' THEN 'waiting_for_response'
    ELSE review_process_status
  END
  WHERE organization_id = p_organization_id AND id = p_session_id;

  RETURN staging.hiring_review_context(p_organization_id, p_caller_principal_id, p_session_id);
END
$function$;

DROP FUNCTION IF EXISTS staging.hiring_second_opinion_respond(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text
);

CREATE OR REPLACE FUNCTION staging.hiring_second_opinion_respond(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_opinion_id pg_catalog.uuid,
  p_response_note pg_catalog.text,
  p_verdict pg_catalog.text DEFAULT 'comment'
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_op record;
  v_verdict pg_catalog.text;
BEGIN
  SELECT * INTO v_op
  FROM hirearchy.hiring_second_opinions
  WHERE id = p_opinion_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND OR v_op.requested_reviewer_principal_id <> p_caller_principal_id THEN
    RAISE EXCEPTION 'Second opinion request not assigned to caller' USING ERRCODE = '42501';
  END IF;

  v_verdict := CASE
    WHEN p_verdict IN ('approve', 'comment', 'request_changes') THEN p_verdict
    ELSE 'comment'
  END;

  UPDATE hirearchy.hiring_second_opinions
  SET response_note = left(trim(COALESCE(p_response_note, '')), 5000),
      verdict = v_verdict,
      status = 'completed',
      responded_at = pg_catalog.clock_timestamp()
  WHERE id = p_opinion_id;

  RETURN staging.hiring_review_context(p_organization_id, p_caller_principal_id, v_op.session_id);
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_decision_publish(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_session_id pg_catalog.text,
  p_payload pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_status pg_catalog.text;
  v_decision pg_catalog.text;
  v_next_stage pg_catalog.text;
  v_recipient_id pg_catalog.uuid;
  v_handoff_status pg_catalog.text;
  v_report pg_catalog.jsonb;
BEGIN
  IF NOT staging.hiring_can_publish_decision(p_organization_id, p_caller_principal_id, p_session_id) THEN
    RAISE EXCEPTION 'Session decision permission denied' USING ERRCODE = '42501';
  END IF;

  SELECT status INTO v_status
  FROM hirearchy.assessment_sessions
  WHERE organization_id = p_organization_id AND id = p_session_id
  FOR UPDATE;

  IF NOT FOUND OR v_status <> 'SUBMITTED' THEN
    RAISE EXCEPTION 'Assessment must be submitted before publishing a decision' USING ERRCODE = '22023';
  END IF;

  v_decision := p_payload ->> 'decision';
  IF v_decision NOT IN ('accepted', 'rejected') THEN
    RAISE EXCEPTION 'Decision must be accepted or rejected' USING ERRCODE = '22023';
  END IF;

  IF v_decision = 'accepted' THEN
    v_next_stage := COALESCE(NULLIF(trim(p_payload ->> 'nextStageLabel'), ''), 'Managerial Interview');
    v_recipient_id := NULLIF(trim(COALESCE(p_payload ->> 'handoffRecipientPrincipalId', '')), '')::pg_catalog.uuid;
    IF v_recipient_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM hirearchy.organization_memberships
      WHERE organization_id = p_organization_id AND principal_id = v_recipient_id AND status = 'active' AND revoked_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Handoff recipient must be an active organization member' USING ERRCODE = '22023';
    END IF;
    v_handoff_status := 'pending';
    v_report := p_payload -> 'performanceReport';
  ELSE
    v_next_stage := NULL;
    v_recipient_id := NULL;
    v_handoff_status := 'none';
    v_report := NULL;
  END IF;

  INSERT INTO hirearchy.hiring_decisions (
    session_id, organization_id, decided_by_principal_id, decision,
    candidate_strengths, candidate_weaknesses, candidate_feedback_note, internal_notes,
    next_stage_label, handoff_recipient_principal_id, handoff_status, performance_report,
    published_at, updated_at
  ) VALUES (
    p_session_id,
    p_organization_id,
    p_caller_principal_id,
    v_decision,
    CASE WHEN pg_catalog.jsonb_typeof(p_payload -> 'candidateStrengths') = 'array' THEN p_payload -> 'candidateStrengths' ELSE '[]'::pg_catalog.jsonb END,
    CASE WHEN pg_catalog.jsonb_typeof(p_payload -> 'candidateWeaknesses') = 'array' THEN p_payload -> 'candidateWeaknesses' ELSE '[]'::pg_catalog.jsonb END,
    left(trim(COALESCE(p_payload ->> 'candidateFeedbackNote', '')), 5000),
    left(trim(COALESCE(p_payload ->> 'internalNotes', '')), 10000),
    v_next_stage,
    v_recipient_id,
    v_handoff_status,
    v_report,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT (session_id) DO UPDATE SET
    decided_by_principal_id = EXCLUDED.decided_by_principal_id,
    decision = EXCLUDED.decision,
    candidate_strengths = EXCLUDED.candidate_strengths,
    candidate_weaknesses = EXCLUDED.candidate_weaknesses,
    candidate_feedback_note = EXCLUDED.candidate_feedback_note,
    internal_notes = EXCLUDED.internal_notes,
    next_stage_label = EXCLUDED.next_stage_label,
    handoff_recipient_principal_id = EXCLUDED.handoff_recipient_principal_id,
    handoff_status = EXCLUDED.handoff_status,
    performance_report = COALESCE(EXCLUDED.performance_report, hirearchy.hiring_decisions.performance_report),
    updated_at = pg_catalog.clock_timestamp();

  UPDATE hirearchy.assessment_sessions
  SET review_process_status = 'next_step_recorded'
  WHERE organization_id = p_organization_id AND id = p_session_id;

  RETURN staging.hiring_review_context(p_organization_id, p_caller_principal_id, p_session_id);
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_handoffs_list(
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
  v_role pg_catalog.text;
  v_org_name pg_catalog.text;
  v_items pg_catalog.jsonb;
BEGIN
  SELECT owner_principal_id, COALESCE(display_name, 'Organization')
  INTO v_owner_id, v_org_name
  FROM hirearchy.organizations WHERE id = p_organization_id;

  SELECT role INTO v_role
  FROM hirearchy.organization_memberships
  WHERE organization_id = p_organization_id
    AND principal_id = p_caller_principal_id
    AND status = 'active'
    AND revoked_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization access denied' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'sessionId', d.session_id,
        'organizationId', d.organization_id::pg_catalog.text,
        'organizationName', v_org_name,
        'scenarioTitle', s.scenario_title,
        'targetRole', COALESCE(m.target_role, ''),
        'experienceLevel', COALESCE(m.experience_level, 'mid'),
        'skills', COALESCE(m.skills, '[]'::pg_catalog.jsonb),
        'candidateEmail', COALESCE(m.candidate_email, ''),
        'candidateName', COALESCE(NULLIF(trim(cp.full_name), ''), m.candidate_email, 'Candidate'),
        'candidateCode', cp.candidate_code,
        'submittedAt', CASE WHEN s.submitted_at IS NULL THEN NULL ELSE pg_catalog.to_char(s.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
        'candidateProfile', pg_catalog.jsonb_build_object(
          'headlineRole', COALESCE(cp.headline_role, ''),
          'yearsExperience', cp.years_experience,
          'locationCountry', COALESCE(cp.location_country, ''),
          'locationCity', COALESCE(cp.location_city, ''),
          'workMode', cp.work_mode,
          'skills', COALESCE(cp.skills, '[]'::pg_catalog.jsonb),
          'linkedinUrl', COALESCE(cp.linkedin_url, ''),
          'githubUrl', COALESCE(cp.github_url, ''),
          'portfolioUrl', COALESCE(cp.portfolio_url, ''),
          'bio', COALESCE(cp.bio, '')
        ),
        'decision', pg_catalog.jsonb_build_object(
          'sessionId', d.session_id,
          'organizationId', d.organization_id::pg_catalog.text,
          'decidedByPrincipalId', d.decided_by_principal_id::pg_catalog.text,
          'decidedByName', COALESCE(NULLIF(trim(dp.display_name), ''), du.email, 'Evaluator'),
          'decision', d.decision,
          'candidateStrengths', d.candidate_strengths,
          'candidateWeaknesses', d.candidate_weaknesses,
          'candidateFeedbackNote', d.candidate_feedback_note,
          'internalNotes', d.internal_notes,
          'nextStageLabel', d.next_stage_label,
          'handoffRecipientPrincipalId', d.handoff_recipient_principal_id::pg_catalog.text,
          'handoffRecipientName', COALESCE(NULLIF(trim(hp.display_name), ''), hu.email),
          'handoffStatus', d.handoff_status,
          'performanceReport', d.performance_report,
          'publishedAt', pg_catalog.to_char(d.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'updatedAt', pg_catalog.to_char(d.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        ),
        'secondOpinions', COALESCE((
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'id', so.id::pg_catalog.text,
              'sessionId', so.session_id,
              'requestedByPrincipalId', so.requested_by_principal_id::pg_catalog.text,
              'requestedByName', COALESCE(NULLIF(trim(srp.display_name), ''), sru.email, 'Team Member'),
              'requestedReviewerPrincipalId', so.requested_reviewer_principal_id::pg_catalog.text,
              'requestedReviewerName', COALESCE(NULLIF(trim(svp.display_name), ''), svu.email, 'Reviewer'),
              'requestNote', so.request_note,
              'requestContext', COALESCE(so.request_context, '{}'::pg_catalog.jsonb),
              'responseNote', so.response_note,
              'verdict', so.verdict,
              'status', so.status,
              'createdAt', pg_catalog.to_char(so.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
              'respondedAt', CASE WHEN so.responded_at IS NULL THEN NULL ELSE pg_catalog.to_char(so.responded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
            ) ORDER BY so.created_at DESC
          )
          FROM hirearchy.hiring_second_opinions so
          LEFT JOIN hirearchy.application_principals srp ON srp.id = so.requested_by_principal_id
          LEFT JOIN auth.users sru ON sru.id = srp.auth_user_id
          LEFT JOIN hirearchy.application_principals svp ON svp.id = so.requested_reviewer_principal_id
          LEFT JOIN auth.users svu ON svu.id = svp.auth_user_id
          WHERE so.session_id = d.session_id AND so.organization_id = p_organization_id
        ), '[]'::pg_catalog.jsonb)
      ) ORDER BY d.published_at DESC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_items
  FROM hirearchy.hiring_decisions d
  JOIN hirearchy.assessment_sessions s ON s.id = d.session_id
  LEFT JOIN hirearchy.hiring_session_metadata m ON m.session_id = d.session_id
  LEFT JOIN hirearchy.candidate_profiles cp
    ON cp.principal_id = COALESCE(
      m.candidate_principal_id,
      (SELECT cp2.principal_id FROM hirearchy.candidate_profiles cp2 WHERE lower(cp2.email) = m.candidate_email LIMIT 1)
    )
  LEFT JOIN hirearchy.application_principals dp ON dp.id = d.decided_by_principal_id
  LEFT JOIN auth.users du ON du.id = dp.auth_user_id
  LEFT JOIN hirearchy.application_principals hp ON hp.id = d.handoff_recipient_principal_id
  LEFT JOIN auth.users hu ON hu.id = hp.auth_user_id
  WHERE d.organization_id = p_organization_id
    AND d.decision = 'accepted'
    AND (
      v_owner_id = p_caller_principal_id
      OR v_role IN ('cto', 'recruiter')
      OR d.handoff_recipient_principal_id = p_caller_principal_id
      OR d.decided_by_principal_id = p_caller_principal_id
    );

  RETURN pg_catalog.jsonb_build_object(
    'handoffs', v_items,
    'plan', staging.hiring_plan_get(p_organization_id, p_caller_principal_id),
    'currentRole', CASE WHEN v_owner_id = p_caller_principal_id THEN 'cto' ELSE v_role END,
    'isOwner', (v_owner_id = p_caller_principal_id)
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_handoff_update(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_session_id pg_catalog.text,
  p_payload pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, staging, pg_temp
AS $function$
DECLARE
  v_owner_id pg_catalog.uuid;
  v_role pg_catalog.text;
  v_dec record;
  v_status pg_catalog.text;
BEGIN
  SELECT owner_principal_id INTO v_owner_id FROM hirearchy.organizations WHERE id = p_organization_id;
  SELECT role INTO v_role FROM hirearchy.organization_memberships
  WHERE organization_id = p_organization_id AND principal_id = p_caller_principal_id AND status = 'active' AND revoked_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization access denied' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_dec
  FROM hirearchy.hiring_decisions
  WHERE organization_id = p_organization_id AND session_id = p_session_id AND decision = 'accepted'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Handoff dossier not found' USING ERRCODE = '22023';
  END IF;

  IF p_payload ? 'expectedUpdatedAt' AND
     v_dec.updated_at IS DISTINCT FROM (p_payload ->> 'expectedUpdatedAt')::pg_catalog.timestamptz THEN
    RAISE EXCEPTION 'Handoff has changed' USING ERRCODE = '40001';
  END IF;

  IF NOT (
    v_owner_id = p_caller_principal_id
    OR v_role = 'cto'
    OR v_dec.handoff_recipient_principal_id = p_caller_principal_id
    OR v_dec.decided_by_principal_id = p_caller_principal_id
  ) THEN
    RAISE EXCEPTION 'Handoff update permission denied' USING ERRCODE = '42501';
  END IF;

  v_status := COALESCE(NULLIF(trim(p_payload ->> 'handoffStatus'), ''), v_dec.handoff_status);
  IF v_status NOT IN ('pending', 'reviewed', 'completed') THEN
    RAISE EXCEPTION 'Invalid handoff status' USING ERRCODE = '22023';
  END IF;

  UPDATE hirearchy.hiring_decisions
  SET handoff_status = v_status,
      performance_report = CASE
        WHEN p_payload ? 'performanceReport' AND p_payload -> 'performanceReport' IS NOT NULL
        THEN p_payload -> 'performanceReport'
        ELSE hirearchy.hiring_decisions.performance_report
      END,
      updated_at = pg_catalog.clock_timestamp()
  WHERE session_id = p_session_id AND organization_id = p_organization_id;

  RETURN staging.hiring_handoffs_list(p_organization_id, p_caller_principal_id);
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
GRANT EXECUTE ON FUNCTION staging.onboarding_update_avatar(pg_catalog.uuid, pg_catalog.text) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.onboarding_list_user_memberships(pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.onboarding_get_organization_metadata(pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_create_team_invitation(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_candidate_profile_get(pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_candidate_profile_upsert(pg_catalog.uuid, pg_catalog.jsonb) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_candidate_portal_list(pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_candidate_session_verify(pg_catalog.uuid, pg_catalog.text) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_candidate_submission_read(pg_catalog.uuid, pg_catalog.text) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_plan_get(pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_plan_update(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.int4) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_library_list(pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_library_save(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.jsonb) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_issue_assessment(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.jsonb) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_candidates_list(pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_get_session_ai_interactions(pg_catalog.uuid, pg_catalog.text) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_get_session_executions(pg_catalog.uuid, pg_catalog.text) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_can_access_session(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_evidence_read(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_review_context(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_second_opinion_create(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_second_opinion_respond(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_decision_publish(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_handoffs_list(pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_handoff_update(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb) TO staging_verifier_owner;

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
REVOKE ALL ON FUNCTION staging.onboarding_update_avatar(pg_catalog.uuid, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.onboarding_list_user_memberships(pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.onboarding_get_organization_metadata(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_create_team_invitation(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_candidate_profile_get(pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_candidate_profile_upsert(pg_catalog.uuid, pg_catalog.jsonb) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_candidate_portal_list(pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_candidate_session_verify(pg_catalog.uuid, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_candidate_submission_read(pg_catalog.uuid, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, staging_readiness_owner, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_plan_get(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_plan_update(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.int4) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_library_list(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_library_save(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.jsonb) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_issue_assessment(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.jsonb) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_candidates_list(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_get_session_ai_interactions(pg_catalog.uuid, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_get_session_executions(pg_catalog.uuid, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_can_access_session(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_evidence_read(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_review_context(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_second_opinion_create(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_second_opinion_respond(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_decision_publish(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_handoffs_list(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_handoff_update(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;


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
    if 'templateId' in content and content['templateId'] not in ('custom', 'reservation-moves-v3', 'webhook-dedup-v1', 'cache-rate-limiter-v1', 'ai-generated'):
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
        'organization.context': (('organizationId',), ('assessmentId',)),
        'session.open': (('organizationId',), ()),
        'session.revoke': (('organizationId',), ()),
        'assessment.create': (('organizationId', 'content'), ('assessmentId',)),
        'assessment.get': (('organizationId', 'assessmentId'), ()),
        'assessment.validate': (('organizationId', 'assessmentId', 'content', 'validatedVersion'), ()),
        'assessment.issue': (('organizationId', 'assessmentId', 'reviewerPrincipalId'), ()),
        'problem.create': (('organizationId', 'content'), ()),
        'problem.list': (('organizationId',), ()),
        'problem.get': (('organizationId', 'problemId'), ()),
        'problem.update': (('organizationId', 'problemId', 'expectedVersion', 'content'), ()),
        'problem.delete': (('organizationId', 'problemId', 'expectedVersion'), ()),
        'problem.reuse': (('organizationId', 'problemId'), ()),
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
        'account.avatar.update': (('avatarWebp',), ()),
        'candidate.profile.get': ((), ()),
        'candidate.profile.upsert': (('profile',), ()),
        'candidate.portal.list': ((), ()),
        'candidate.session.verify_access': (('sessionId',), ()),
        'candidate.session.submitted_read': (('sessionId',), ()),
        'hiring.team.invitation.create': (('organizationId', 'targetEmail', 'role', 'expiresAt', 'idempotencyKey', 'invitationTokenHash', 'invitationTokenCiphertext'), ()),
        'hiring.plan.get': (('organizationId',), ()),
        'hiring.plan.update': (('organizationId', 'planTier', 'creditsMode', 'creditsAmount'), ()),
        'hiring.library.list': (('organizationId',), ()),
        'hiring.library.save': (('organizationId', 'entry'), ()),
        'hiring.assessment.issue': (('organizationId', 'input'), ()),
        'hiring.candidates.list': (('organizationId',), ()),
        'hiring.evidence.read': (('organizationId', 'sessionId'), ()),
        'hiring.review.context': (('organizationId', 'sessionId'), ()),
        'hiring.second_opinion.create': (('organizationId', 'sessionId', 'reviewerPrincipalId', 'note'), ('requestContext',)),
        'hiring.second_opinion.respond': (('organizationId', 'opinionId', 'responseNote'), ('verdict',)),
        'hiring.decision.publish': (('organizationId', 'sessionId', 'input'), ()),
        'hiring.handoffs.list': (('organizationId',), ()),
        'hiring.handoff.update': (('organizationId', 'sessionId', 'input'), ()),
        'hiring.dossier.share.create': (('organizationId', 'sessionId', 'tokenHash', 'input'), ()),
        'hiring.dossier.share.list': (('organizationId', 'sessionId'), ()),
        'hiring.dossier.share.revoke': (('organizationId', 'shareId'), ()),
        'hiring.webhook.list': (('organizationId',), ()),
        'hiring.webhook.upsert': (('organizationId', 'input'), ()),
        'hiring.webhook.delete': (('organizationId', 'webhookId'), ()),
        'hiring.library.health': (('organizationId',), ()),
        'hiring.nudges.get': (('organizationId',), ()),
        'hiring.nudge.dismiss': (('organizationId', 'nudgeKey', 'action'), ('targetRef',)),
    }
    if operation not in schemas:
        error('Staging operation is unavailable', '22023')
    required, optional = schemas[operation]
    require_args(args, required, optional)

# Shared projection for library reads and write results.
PROBLEM_JSON = """
    pg_catalog.jsonb_build_object(
      'id', id, 'organizationId', organization_id,
      'authorPrincipalId', author_principal_id, 'version', version,
      'content', content, 'createdAt', created_at, 'updatedAt', updated_at
    )
"""

def read_reusable_problem(organization_id, problem_id, lock=False):
    lock_clause = 'FOR UPDATE' if lock else ''
    rows = run(
        f"""
        SELECT {PROBLEM_JSON} AS problem
        FROM hirearchy.reusable_problems
        WHERE organization_id = $1::pg_catalog.uuid AND id = $2::pg_catalog.uuid
        {lock_clause}
        """,
        ['uuid', 'uuid'],
        [organization_id, problem_id],
    )
    if not rows:
        error('Problem not found.', 'P0002')
    return json_value(rows[0]['problem'])

def operate_reusable_problem(operation, args, organization_id, principal_id):
    if operation == 'problem.list':
        rows = run(
            f"""
            SELECT COALESCE(pg_catalog.jsonb_agg(
              {PROBLEM_JSON} ORDER BY updated_at DESC, id
            ), '[]'::pg_catalog.jsonb) AS problems
            FROM hirearchy.reusable_problems
            WHERE organization_id = $1::pg_catalog.uuid
            """,
            ['uuid'],
            [organization_id],
        )
        return {'problems': json_value(rows[0]['problems'])}

    if operation in ('problem.create', 'problem.update'):
        content = args['content']
        require_draft(content)
        if (
            'definitionId' in content or 'expectedVersion' in content
            or 'templateId' not in content
            or content['durationMinutes'] not in (30, 45, 60, 90)
            or not content['terminalEnabled']
        ):
            error('Problem content is invalid', '22023')
        serialized_content = json.dumps(content, ensure_ascii=False)

    if operation == 'problem.create':
        rows = run(
            f"""
            INSERT INTO hirearchy.reusable_problems (organization_id, author_principal_id, content)
            VALUES ($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.jsonb)
            RETURNING {PROBLEM_JSON} AS problem
            """,
            ['uuid', 'uuid', 'text'],
            [organization_id, principal_id, serialized_content],
        )
        return {'problem': json_value(rows[0]['problem'])}

    problem_id = require_uuid(args.get('problemId'), 'problem ID')
    if operation == 'problem.get':
        return {'problem': read_reusable_problem(organization_id, problem_id)}

    expected_version = args.get('expectedVersion')
    if type(expected_version) is not int or not 1 <= expected_version <= MAX_SAFE_INTEGER:
        error('Staging request is invalid', '22023')
    problem = read_reusable_problem(organization_id, problem_id, lock=True)
    if problem['version'] != expected_version:
        error('Reusable problem was updated concurrently', 'R2111')

    if operation == 'problem.delete':
        run(
            """
            DELETE FROM hirearchy.reusable_problems
            WHERE organization_id = $1::pg_catalog.uuid AND id = $2::pg_catalog.uuid
            """,
            ['uuid', 'uuid'],
            [organization_id, problem_id],
        )
        return {'deleted': True}

    rows = run(
        f"""
        UPDATE hirearchy.reusable_problems
        SET content = $3::pg_catalog.jsonb, version = version + 1,
            updated_at = pg_catalog.clock_timestamp()
        WHERE organization_id = $1::pg_catalog.uuid AND id = $2::pg_catalog.uuid
        RETURNING {PROBLEM_JSON} AS problem
        """,
        ['uuid', 'uuid', 'text'],
        [organization_id, problem_id, serialized_content],
    )
    return {'problem': json_value(rows[0]['problem'])}

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
        organization_id, principal_id, ('cto', 'recruiter', 'reviewer')
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
        if role in ('cto', 'recruiter'):
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
                  AND ($3::pg_catalog.uuid IS NULL OR def.id = $3::pg_catalog.uuid)
                ORDER BY def.updated_at DESC, def.id DESC
                LIMIT 1
                """,
                ['uuid', 'uuid', 'uuid'],
                [organization_id, principal_id, require_uuid(args['assessmentId'], 'assessment ID') if 'assessmentId' in args else None],
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
                ($3 = 'cto')
                OR ($3 = 'recruiter' AND s.issuer_principal_id = $2::pg_catalog.uuid)
                OR (
                  $3 = 'reviewer' AND (
                    s.issuer_principal_id = $2::pg_catalog.uuid
                    OR EXISTS (
                      SELECT 1 FROM hirearchy.reviewer_assignments AS assignment
                      WHERE assignment.organization_id = s.organization_id
                        AND assignment.session_id = s.id
                        AND assignment.reviewer_principal_id = $2::pg_catalog.uuid
                        AND assignment.revoked_at IS NULL
                    )
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

    if operation in ('problem.create', 'problem.list', 'problem.get', 'problem.update', 'problem.delete'):
        if role != 'recruiter':
            error('Recruiter membership required', '42501')
        return operate_reusable_problem(operation, args, organization_id, principal_id)

    if operation in ('assessment.create', 'problem.reuse'):
        if role != 'recruiter':
            error('Recruiter membership required', '42501')
        if operation == 'problem.reuse':
            problem_id = require_uuid(args.get('problemId'), 'problem ID')
            content = read_reusable_problem(organization_id, problem_id)['content']
        else:
            content = args['content']
        require_draft(content)
        requested_id = (
            args.get('assessmentId') or content.get('definitionId')
            if operation == 'assessment.create' else None
        )
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
            inserted = run(
                """
                INSERT INTO hirearchy.assessment_definitions (
                  id, organization_id, author_principal_id, title, draft_version
                ) VALUES (
                  $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.uuid,
                  $4, 1
                )
                RETURNING pg_catalog.jsonb_build_object(
                  'createdAt', created_at, 'updatedAt', updated_at
                ) AS timestamps
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
        if operation == 'problem.reuse':
            return {'draft': {
                **content,
                'definitionId': assessment_id,
                'organizationId': organization_id,
                'authorPrincipalId': principal_id,
                'version': next_version,
                **json_value(inserted[0]['timestamps']),
            }}
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
            ai_rows = run(
                "SELECT staging.hiring_get_session_ai_interactions($1::pg_catalog.uuid, $2) AS items",
                ['uuid', 'text'],
                [organization_id, session_id],
            )[0]['items']
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
                'aiInteractions': decode_json(ai_rows),
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

    if operation == 'hiring.team.invitation.create':
        target_email = args.get('targetEmail')
        invite_role = args.get('role')
        expires_at_str = args.get('expiresAt')
        idempotency_key = args.get('idempotencyKey')
        token_hash = args.get('invitationTokenHash')
        token_ciphertext = args.get('invitationTokenCiphertext')
        if (
            not isinstance(target_email, str)
            or invite_role not in ('cto', 'recruiter', 'reviewer')
            or not isinstance(expires_at_str, str)
            or not isinstance(idempotency_key, str)
            or not isinstance(token_hash, str)
            or not isinstance(token_ciphertext, str)
        ):
            error('Staging request is invalid', '22023')
        canonical_email = target_email.strip().lower()
        canonical_request = json.dumps({
            'organizationId': organization_id,
            'targetEmail': canonical_email,
            'role': invite_role,
            'expiresAt': expires_at_str,
        }, sort_keys=True, separators=(',', ':'))
        request_digest = sha256_hex(canonical_request)
        rows = run(
            """
            SELECT staging.hiring_create_team_invitation(
              $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.uuid,
              $4, $5, $6, $7, $8, $9, $10
            ) AS result
            """,
            ['uuid', 'uuid', 'uuid', 'text', 'text', 'text', 'text', 'text', 'text', 'text'],
            [subject_id, organization_id, principal_id, canonical_email, invite_role, expires_at_str, idempotency_key, request_digest, token_hash, token_ciphertext],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.plan.get':
        rows = run(
            "SELECT staging.hiring_plan_get($1::pg_catalog.uuid, $2::pg_catalog.uuid) AS result",
            ['uuid', 'uuid'],
            [organization_id, principal_id],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.plan.update':
        plan_tier = args.get('planTier')
        credits_mode = args.get('creditsMode')
        credits_amount = args.get('creditsAmount')
        if (
            not isinstance(plan_tier, str)
            or not isinstance(credits_mode, str)
            or isinstance(credits_amount, bool)
            or not isinstance(credits_amount, int)
        ):
            error('Invalid plan update arguments', '22023')
        rows = run(
            "SELECT staging.hiring_plan_update($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3, $4, $5::pg_catalog.int4) AS result",
            ['uuid', 'uuid', 'text', 'text', 'int4'],
            [organization_id, principal_id, plan_tier, credits_mode, credits_amount],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.library.list':
        rows = run(
            "SELECT staging.hiring_library_list($1::pg_catalog.uuid, $2::pg_catalog.uuid) AS result",
            ['uuid', 'uuid'],
            [organization_id, principal_id],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.library.save':
        entry = args.get('entry')
        if not isinstance(entry, dict):
            error('Invalid library entry payload', '22023')
        rows = run(
            "SELECT staging.hiring_library_save($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.jsonb) AS result",
            ['uuid', 'uuid', 'text'],
            [organization_id, principal_id, json.dumps(entry, ensure_ascii=False)],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.assessment.issue':
        payload = args.get('input')
        if not isinstance(payload, dict):
            error('Invalid assessment issuance payload', '22023')
        rows = run(
            "SELECT staging.hiring_issue_assessment($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.jsonb) AS result",
            ['uuid', 'uuid', 'text'],
            [organization_id, principal_id, json.dumps(payload, ensure_ascii=False)],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.candidates.list':
        rows = run(
            "SELECT staging.hiring_candidates_list($1::pg_catalog.uuid, $2::pg_catalog.uuid) AS result",
            ['uuid', 'uuid'],
            [organization_id, principal_id],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.evidence.read':
        session_id = args.get('sessionId')
        if not isinstance(session_id, str) or not re.fullmatch(r'sess_[A-Za-z0-9_-]{1,128}', session_id):
            error('Staging request is invalid', '22023')
        rows = run(
            "SELECT staging.hiring_evidence_read($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3) AS result",
            ['uuid', 'uuid', 'text'],
            [organization_id, principal_id, session_id],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.review.context':
        session_id = args.get('sessionId')
        if not isinstance(session_id, str) or not re.fullmatch(r'sess_[A-Za-z0-9_-]{1,128}', session_id):
            error('Staging request is invalid', '22023')
        rows = run(
            "SELECT staging.hiring_review_context($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3) AS result",
            ['uuid', 'uuid', 'text'],
            [organization_id, principal_id, session_id],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.second_opinion.create':
        session_id = args.get('sessionId')
        reviewer_id = require_uuid(args.get('reviewerPrincipalId'), 'reviewer principal ID')
        note = args.get('note')
        request_context = args.get('requestContext') if 'requestContext' in args else {}
        if not isinstance(session_id, str) or not re.fullmatch(r'sess_[A-Za-z0-9_-]{1,128}', session_id) or not isinstance(note, str) or not isinstance(request_context, dict):
            error('Staging request is invalid', '22023')
        rows = run(
            "SELECT staging.hiring_second_opinion_create($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3, $4::pg_catalog.uuid, $5, $6::pg_catalog.jsonb) AS result",
            ['uuid', 'uuid', 'text', 'uuid', 'text', 'text'],
            [organization_id, principal_id, session_id, reviewer_id, note, json.dumps(request_context, ensure_ascii=False)],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.second_opinion.respond':
        opinion_id = require_uuid(args.get('opinionId'), 'opinion ID')
        response_note = args.get('responseNote')
        verdict = args.get('verdict') if 'verdict' in args else 'comment'
        if not isinstance(response_note, str) or verdict not in ('approve', 'comment', 'request_changes'):
            error('Staging request is invalid', '22023')
        rows = run(
            "SELECT staging.hiring_second_opinion_respond($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.uuid, $4, $5) AS result",
            ['uuid', 'uuid', 'uuid', 'text', 'text'],
            [organization_id, principal_id, opinion_id, response_note, verdict],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.decision.publish':
        session_id = args.get('sessionId')
        payload = args.get('input')
        if not isinstance(session_id, str) or not re.fullmatch(r'sess_[A-Za-z0-9_-]{1,128}', session_id) or not isinstance(payload, dict):
            error('Staging request is invalid', '22023')
        rows = run(
            "SELECT staging.hiring_decision_publish($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3, $4::pg_catalog.jsonb) AS result",
            ['uuid', 'uuid', 'text', 'text'],
            [organization_id, principal_id, session_id, json.dumps(payload, ensure_ascii=False)],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.handoffs.list':
        rows = run(
            "SELECT staging.hiring_handoffs_list($1::pg_catalog.uuid, $2::pg_catalog.uuid) AS result",
            ['uuid', 'uuid'],
            [organization_id, principal_id],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.handoff.update':
        session_id = args.get('sessionId')
        payload = args.get('input')
        if not isinstance(session_id, str) or not re.fullmatch(r'sess_[A-Za-z0-9_-]{1,128}', session_id) or not isinstance(payload, dict):
            error('Staging request is invalid', '22023')
        rows = run(
            "SELECT staging.hiring_handoff_update($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3, $4::pg_catalog.jsonb) AS result",
            ['uuid', 'uuid', 'text', 'text'],
            [organization_id, principal_id, session_id, json.dumps(payload, ensure_ascii=False)],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.dossier.share.create':
        session_id = args.get('sessionId')
        token_hash = args.get('tokenHash')
        payload = args.get('input')
        if (
            not isinstance(session_id, str)
            or not re.fullmatch(r'sess_[A-Za-z0-9_-]{1,128}', session_id)
            or not isinstance(token_hash, str)
            or not re.fullmatch(r'[0-9a-f]{64}', token_hash)
            or not isinstance(payload, dict)
        ):
            error('Staging request is invalid', '22023')
        rows = run(
            "SELECT staging.hiring_dossier_share_create($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3, $4, $5::pg_catalog.jsonb) AS result",
            ['uuid', 'uuid', 'text', 'text', 'text'],
            [organization_id, principal_id, session_id, token_hash, json.dumps(payload, ensure_ascii=False)],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.dossier.share.list':
        session_id = args.get('sessionId')
        if not isinstance(session_id, str) or not re.fullmatch(r'sess_[A-Za-z0-9_-]{1,128}', session_id):
            error('Staging request is invalid', '22023')
        rows = run(
            "SELECT staging.hiring_dossier_share_list($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3) AS result",
            ['uuid', 'uuid', 'text'],
            [organization_id, principal_id, session_id],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.dossier.share.revoke':
        share_id = require_uuid(args.get('shareId'), 'share ID')
        rows = run(
            "SELECT staging.hiring_dossier_share_revoke($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.uuid) AS result",
            ['uuid', 'uuid', 'uuid'],
            [organization_id, principal_id, share_id],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.webhook.list':
        rows = run(
            "SELECT staging.hiring_webhook_list($1::pg_catalog.uuid, $2::pg_catalog.uuid) AS result",
            ['uuid', 'uuid'],
            [organization_id, principal_id],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.webhook.upsert':
        payload = args.get('input')
        if not isinstance(payload, dict):
            error('Staging request is invalid', '22023')
        rows = run(
            "SELECT staging.hiring_webhook_upsert($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.jsonb) AS result",
            ['uuid', 'uuid', 'text'],
            [organization_id, principal_id, json.dumps(payload, ensure_ascii=False)],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.webhook.delete':
        webhook_id = require_uuid(args.get('webhookId'), 'webhook ID')
        rows = run(
            "SELECT staging.hiring_webhook_delete($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.uuid) AS result",
            ['uuid', 'uuid', 'uuid'],
            [organization_id, principal_id, webhook_id],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.library.health':
        rows = run(
            "SELECT staging.hiring_org_problem_health($1::pg_catalog.uuid, $2::pg_catalog.uuid) AS result",
            ['uuid', 'uuid'],
            [organization_id, principal_id],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.nudges.get':
        rows = run(
            "SELECT staging.hiring_org_nudges_get($1::pg_catalog.uuid, $2::pg_catalog.uuid) AS result",
            ['uuid', 'uuid'],
            [organization_id, principal_id],
        )
        return safe_json_value(rows[0]['result'])

    if operation == 'hiring.nudge.dismiss':
        nudge_key = args.get('nudgeKey')
        action = args.get('action')
        target_ref = args.get('targetRef') if 'targetRef' in args else ''
        if (
            nudge_key not in ('no_assessment_48h', 'unreviewed_submission_48h', 'plan_gate_no_upgrade', 'problem_health_alert', 'connect_slack_webhook')
            or action not in ('snooze', 'dismiss')
            or not isinstance(target_ref, str)
            or len(target_ref) > 200
        ):
            error('Staging request is invalid', '22023')
        rows = run(
            "SELECT staging.hiring_org_nudge_dismiss($1::pg_catalog.uuid, $2::pg_catalog.uuid, $3, $4, $5) AS result",
            ['uuid', 'uuid', 'text', 'text', 'text'],
            [organization_id, principal_id, nudge_key, target_ref, action],
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

    if op == 'candidate.profile.get':
        rows = run(
            "SELECT staging.hiring_candidate_profile_get($1::pg_catalog.uuid) AS result",
            ['uuid'],
            [subject_id],
        )
        return safe_json_value(rows[0]['result'])

    if op == 'candidate.profile.upsert':
        profile = args.get('profile')
        if not isinstance(profile, dict):
            error('Candidate profile payload is invalid', '22023')
        rows = run(
            "SELECT staging.hiring_candidate_profile_upsert($1::pg_catalog.uuid, $2::pg_catalog.jsonb) AS result",
            ['uuid', 'text'],
            [subject_id, json.dumps(profile, ensure_ascii=False)],
        )
        return safe_json_value(rows[0]['result'])

    if op == 'candidate.portal.list':
        rows = run(
            "SELECT staging.hiring_candidate_portal_list($1::pg_catalog.uuid) AS result",
            ['uuid'],
            [subject_id],
        )
        return safe_json_value(rows[0]['result'])

    if op in ('candidate.session.verify_access', 'candidate.session.submitted_read'):
        session_id = args.get('sessionId')
        if not isinstance(session_id, str) or not re.fullmatch(r'sess_[A-Za-z0-9_-]{1,128}', session_id):
            error('Session identifier is invalid', '22023')
        query = (
            "SELECT staging.hiring_candidate_submission_read($1::pg_catalog.uuid, $2) AS result"
            if op == 'candidate.session.submitted_read' else
            "SELECT staging.hiring_candidate_session_verify($1::pg_catalog.uuid, $2) AS result"
        )
        rows = run(
            query,
            ['uuid', 'text'],
            [subject_id, session_id],
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

    if op == 'account.avatar.update':
        avatar = args.get('avatarWebp')
        if avatar is not None and (
            not isinstance(avatar, str) or not 16 <= len(avatar) <= 24000
            or not re.fullmatch(r'UklGR[A-Za-z0-9+/]+={0,2}', avatar)
        ):
            error('Invalid account photo', '22023')
        rows = run(
            "SELECT staging.onboarding_update_avatar($1::pg_catalog.uuid, $2) AS result",
            ['uuid', 'text'],
            [principal_id, avatar],
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

PRE_PRINCIPAL_OPERATIONS = {
    'onboarding.status',
    'organization.bootstrap',
    'organization.invitation.accept',
    'candidate.profile.get',
    'candidate.profile.upsert',
    'candidate.portal.list',
    'candidate.session.verify_access',
    'candidate.session.submitted_read',
}
ACCOUNT_OPERATIONS = {'account.profile.get', 'account.profile.update', 'account.avatar.update'}

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
        organization_id, principal_id, ('cto', 'recruiter', 'reviewer')
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

-- The gateway can execute one redacted readiness probe. Its dedicated
-- NOLOGIN owner can read only migration/install metadata and has no tenant,
-- Auth, mutation, or verifier-dispatch grants.
GRANT USAGE ON SCHEMA hirearchy TO staging_readiness_owner;
GRANT SELECT (version) ON hirearchy.schema_migrations
  TO staging_readiness_owner;
GRANT SELECT (marker_key, marker_version)
  ON hirearchy.durable_candidate_installation,
     hirearchy.durable_onboarding_installation
  TO staging_readiness_owner;
GRANT SELECT (version) ON hirearchy.candidate_token_storage_meta
  TO staging_readiness_owner;

DROP POLICY IF EXISTS staging_readiness_candidate_marker
  ON hirearchy.durable_candidate_installation;
CREATE POLICY staging_readiness_candidate_marker
  ON hirearchy.durable_candidate_installation
  FOR SELECT TO staging_readiness_owner
  USING (true);

DROP POLICY IF EXISTS staging_readiness_onboarding_marker
  ON hirearchy.durable_onboarding_installation;
CREATE POLICY staging_readiness_onboarding_marker
  ON hirearchy.durable_onboarding_installation
  FOR SELECT TO staging_readiness_owner
  USING (true);

DROP POLICY IF EXISTS staging_readiness_token_metadata
  ON hirearchy.candidate_token_storage_meta;
CREATE POLICY staging_readiness_token_metadata
  ON hirearchy.candidate_token_storage_meta
  FOR SELECT TO staging_readiness_owner
  USING (true);

CREATE OR REPLACE FUNCTION staging.readiness_probe()
RETURNS pg_catalog.jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'migrationVersion', (
      SELECT version
        FROM hirearchy.schema_migrations
       ORDER BY version DESC
       LIMIT 1
    ),
    'markers', pg_catalog.jsonb_build_object(
      'candidateLifecycle', EXISTS (
        SELECT 1
          FROM hirearchy.durable_candidate_installation
         WHERE marker_key = 'durable-candidate-lifecycle-v1'
           AND marker_version = 1
      ),
      'onboarding', EXISTS (
        SELECT 1
          FROM hirearchy.durable_onboarding_installation
         WHERE marker_key = 'durable-onboarding-v1'
           AND marker_version = 1
      ),
      'candidateTokenStorage', EXISTS (
        SELECT 1
          FROM hirearchy.candidate_token_storage_meta
         WHERE version = 1
      ),
      'authoringR211',
        pg_catalog.to_regclass('hirearchy.assessment_validated_versions') IS NOT NULL,
      'executionR214',
        pg_catalog.to_regclass('hirearchy.candidate_execution_operations') IS NOT NULL
    )
  );
$function$;
ALTER FUNCTION staging.readiness_probe()
  OWNER TO staging_readiness_owner;
REVOKE ALL ON FUNCTION staging.readiness_probe()
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker,
       staging_verifier_owner, hirearchy_migrator;
GRANT EXECUTE ON FUNCTION staging.readiness_probe() TO r23_gateway;

-- Hiring Platform durable Candidate AI RPCs live in the staging schema so the
-- base hirearchy schema keeps only r26_candidate_command and its readiness
-- probe executable by app_candidate_gateway.
CREATE OR REPLACE FUNCTION staging.hiring_r212_get_view(
  p_token_hash pg_catalog.text,
  p_session_id pg_catalog.text
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session record;
  v_enabled pg_catalog.bool := false;
  v_provider_id pg_catalog.text := 'nvidia-nim';
  v_model_id pg_catalog.text := 'moonshotai/kimi-k3.1-pro';
  v_max_interactions pg_catalog.int4 := 15;
  v_used_interactions pg_catalog.int4 := 0;
  v_interactions pg_catalog.jsonb;
BEGIN
  IF SESSION_USER NOT IN ('app_candidate_gateway', 'postgres', 'hirearchy_migrator') THEN
    RAISE EXCEPTION 'R2.12 candidate role denied' USING ERRCODE = '42501';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$' THEN
    RAISE EXCEPTION 'R2.12 invalid input parameters' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('r26.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config('r26.token_hash', p_token_hash, true);

  IF NOT EXISTS (
    SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
    WHERE envelope.session_id = p_session_id
      AND envelope.candidate_token_hash = p_token_hash
      AND envelope.revoked_at IS NULL
      AND (envelope.expires_at IS NULL OR envelope.expires_at > pg_catalog.clock_timestamp())
  ) THEN
    RAISE EXCEPTION 'R2.12 candidate authentication failed' USING ERRCODE = '42501';
  END IF;

  SELECT s.* INTO v_session
  FROM hirearchy.assessment_sessions AS s
  WHERE s.id = p_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'R2.12 candidate session unavailable' USING ERRCODE = 'R2604';
  END IF;

  IF v_session.ai_capability_snapshot IS NOT NULL THEN
    v_enabled := COALESCE((v_session.ai_capability_snapshot ->> 'enabled')::boolean, false);
    v_provider_id := COALESCE(
      NULLIF(v_session.ai_capability_snapshot ->> 'providerId', ''),
      NULLIF(v_session.ai_capability_snapshot ->> 'configuredProviderId', ''),
      'nvidia-nim'
    );
    v_model_id := COALESCE(
      NULLIF(v_session.ai_capability_snapshot ->> 'modelId', ''),
      NULLIF(v_session.ai_capability_snapshot ->> 'configuredModelId', ''),
      'moonshotai/kimi-k3.1-pro'
    );
    v_max_interactions := COALESCE((v_session.ai_capability_snapshot ->> 'maxInteractions')::pg_catalog.int4, 15);
  END IF;

  SELECT pg_catalog.count(*)::pg_catalog.int4 INTO v_used_interactions
  FROM hirearchy.candidate_ai_interactions
  WHERE session_id = p_session_id
    AND status IN ('ADMITTED', 'COMPLETED');

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'interactionId', ai.interaction_id,
        'requestId', ai.request_id,
        'sequenceStart', ai.sequence_start,
        'sequenceCompleted', ai.sequence_completed,
        'candidatePrompt', ai.candidate_prompt,
        'assistantResponse', ai.assistant_response,
        'status', ai.status,
        'failureReason', ai.failure_reason,
        'errorMessage', ai.error_message,
        'providerId', ai.provider_id,
        'modelId', ai.model_id,
        'createdAt', pg_catalog.to_char(ai.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'completedAt', CASE WHEN ai.completed_at IS NOT NULL THEN pg_catalog.to_char(ai.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ELSE NULL END
      ) ORDER BY ai.sequence_start
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_interactions
  FROM hirearchy.candidate_ai_interactions AS ai
  WHERE ai.session_id = p_session_id;

  RETURN pg_catalog.jsonb_build_object(
    'enabled', v_enabled,
    'providerId', v_provider_id,
    'modelId', v_model_id,
    'remainingInteractions', GREATEST(0, v_max_interactions - v_used_interactions),
    'totalInteractionsAllowed', v_max_interactions,
    'interactions', v_interactions
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_r212_admit(
  p_token_hash pg_catalog.text,
  p_session_id pg_catalog.text,
  p_request_id pg_catalog.text,
  p_prompt pg_catalog.text
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_envelope_org_id pg_catalog.uuid;
  v_session record;
  v_existing record;
  v_sequence pg_catalog.int8;
  v_interaction_id pg_catalog.text;
  v_now pg_catalog.timestamptz;
  v_deadline pg_catalog.timestamptz;
  v_max_interactions pg_catalog.int4 := 15;
  v_current_count pg_catalog.int4 := 0;
  v_provider_id pg_catalog.text;
  v_model_id pg_catalog.text;
BEGIN
  IF SESSION_USER NOT IN ('app_candidate_gateway', 'postgres', 'hirearchy_migrator') THEN
    RAISE EXCEPTION 'R2.12 candidate role denied' USING ERRCODE = '42501';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$'
     OR p_request_id IS NULL OR p_request_id !~ '^[A-Za-z0-9_-]{1,128}$'
     OR p_prompt IS NULL THEN
    RAISE EXCEPTION 'R2.12 invalid input parameters' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('r26.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config('r26.token_hash', p_token_hash, true);

  SELECT envelope.organization_id INTO v_envelope_org_id
  FROM hirearchy.candidate_token_envelopes AS envelope
  WHERE envelope.session_id = p_session_id
    AND envelope.candidate_token_hash = p_token_hash
    AND envelope.revoked_at IS NULL
    AND (envelope.expires_at IS NULL OR envelope.expires_at > pg_catalog.clock_timestamp());

  IF NOT FOUND THEN
    RAISE EXCEPTION 'R2.12 candidate authentication failed' USING ERRCODE = '42501';
  END IF;

  SELECT s.* INTO v_session
  FROM hirearchy.assessment_sessions AS s
  WHERE s.id = p_session_id
  FOR UPDATE;

  IF NOT FOUND OR v_session.organization_id <> v_envelope_org_id THEN
    RAISE EXCEPTION 'R2.12 candidate session unavailable' USING ERRCODE = 'R2604';
  END IF;

  IF v_session.ai_capability_snapshot IS NULL
     OR (v_session.ai_capability_snapshot ->> 'enabled')::boolean IS NOT TRUE THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'DENIED',
      'reason', 'NOT_ENABLED',
      'remainingBudget', 0
    );
  END IF;

  v_max_interactions := COALESCE(
    (v_session.ai_capability_snapshot ->> 'maxInteractions')::pg_catalog.int4,
    15
  );

  SELECT ai.* INTO v_existing
  FROM hirearchy.candidate_ai_interactions AS ai
  WHERE ai.session_id = p_session_id
    AND ai.request_id = p_request_id;

  IF FOUND THEN
    IF v_existing.candidate_prompt <> p_prompt THEN
      RAISE EXCEPTION 'R2.12 request ID reused with different intent' USING ERRCODE = '23514';
    END IF;
    SELECT pg_catalog.count(*)::pg_catalog.int4 INTO v_current_count
    FROM hirearchy.candidate_ai_interactions
    WHERE session_id = p_session_id AND status IN ('ADMITTED', 'COMPLETED');
    RETURN pg_catalog.jsonb_build_object(
      'status', 'REPLAY',
      'remainingBudget', GREATEST(0, v_max_interactions - v_current_count),
      'interaction', pg_catalog.jsonb_build_object(
        'interactionId', v_existing.interaction_id,
        'requestId', v_existing.request_id,
        'sequenceStart', v_existing.sequence_start,
        'sequenceCompleted', v_existing.sequence_completed,
        'candidatePrompt', v_existing.candidate_prompt,
        'assistantResponse', v_existing.assistant_response,
        'status', v_existing.status,
        'failureReason', v_existing.failure_reason,
        'errorMessage', v_existing.error_message,
        'providerId', v_existing.provider_id,
        'modelId', v_existing.model_id,
        'createdAt', pg_catalog.to_char(v_existing.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'completedAt', CASE WHEN v_existing.completed_at IS NOT NULL THEN pg_catalog.to_char(v_existing.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ELSE NULL END
      )
    );
  END IF;

  IF v_session.status <> 'ACTIVE' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'DENIED',
      'reason', 'SESSION_CLOSED',
      'remainingBudget', 0
    );
  END IF;

  v_now := pg_catalog.clock_timestamp();
  v_deadline := v_session.activated_at + (v_session.duration_seconds * INTERVAL '1 second');
  IF v_now >= v_deadline THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'DENIED',
      'reason', 'DEADLINE_EXCEEDED',
      'remainingBudget', 0
    );
  END IF;

  SELECT pg_catalog.count(*)::pg_catalog.int4 INTO v_current_count
  FROM hirearchy.candidate_ai_interactions
  WHERE session_id = p_session_id AND status IN ('ADMITTED', 'COMPLETED');

  IF pg_catalog.char_length(p_prompt) > 4000 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'DENIED',
      'reason', 'PROMPT_TOO_LARGE',
      'remainingBudget', GREATEST(0, v_max_interactions - v_current_count)
    );
  END IF;

  IF v_current_count >= v_max_interactions THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'DENIED',
      'reason', 'BUDGET_EXHAUSTED',
      'remainingBudget', 0
    );
  END IF;

  SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
  INTO v_sequence
  FROM hirearchy.candidate_session_events AS event
  WHERE event.session_id = p_session_id;

  v_interaction_id := 'ai_' || p_request_id;
  v_provider_id := COALESCE(
    NULLIF(v_session.ai_capability_snapshot ->> 'providerId', ''),
    NULLIF(v_session.ai_capability_snapshot ->> 'configuredProviderId', ''),
    'nvidia-nim'
  );
  v_model_id := COALESCE(
    NULLIF(v_session.ai_capability_snapshot ->> 'modelId', ''),
    NULLIF(v_session.ai_capability_snapshot ->> 'configuredModelId', ''),
    'moonshotai/kimi-k3.1-pro'
  );

  INSERT INTO hirearchy.candidate_session_events (
    organization_id, session_id, sequence, event_type, happened_at, payload
  ) VALUES (
    v_session.organization_id, p_session_id, v_sequence,
    'AI_REQUEST_STARTED', v_now,
    pg_catalog.jsonb_build_object(
      'requestId', p_request_id,
      'interactionId', v_interaction_id,
      'promptChars', pg_catalog.char_length(p_prompt)
    )
  );

  INSERT INTO hirearchy.candidate_ai_interactions (
    organization_id, session_id, interaction_id, request_id,
    sequence_start, candidate_prompt, status, provider_id, model_id, created_at
  ) VALUES (
    v_session.organization_id, p_session_id, v_interaction_id, p_request_id,
    v_sequence, p_prompt, 'ADMITTED', v_provider_id, v_model_id, v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ADMITTED',
    'remainingBudget', GREATEST(0, v_max_interactions - (v_current_count + 1)),
    'interaction', pg_catalog.jsonb_build_object(
      'interactionId', v_interaction_id,
      'requestId', p_request_id,
      'sequenceStart', v_sequence,
      'sequenceCompleted', NULL,
      'candidatePrompt', p_prompt,
      'assistantResponse', NULL,
      'status', 'ADMITTED',
      'failureReason', NULL,
      'errorMessage', NULL,
      'providerId', v_provider_id,
      'modelId', v_model_id,
      'createdAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'completedAt', NULL
    )
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_r212_complete(
  p_token_hash pg_catalog.text,
  p_session_id pg_catalog.text,
  p_request_id pg_catalog.text,
  p_assistant_response pg_catalog.text,
  p_duration_ms pg_catalog.int4 DEFAULT NULL
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session record;
  v_interaction record;
  v_sequence pg_catalog.int8;
  v_now pg_catalog.timestamptz;
BEGIN
  IF SESSION_USER NOT IN ('app_candidate_gateway', 'postgres', 'hirearchy_migrator') THEN
    RAISE EXCEPTION 'R2.12 candidate role denied' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config('r26.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config('r26.token_hash', p_token_hash, true);

  IF NOT EXISTS (
    SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
    WHERE envelope.session_id = p_session_id
      AND envelope.candidate_token_hash = p_token_hash
  ) THEN
    RAISE EXCEPTION 'R2.12 candidate authentication failed' USING ERRCODE = '42501';
  END IF;

  SELECT s.* INTO v_session
  FROM hirearchy.assessment_sessions AS s
  WHERE s.id = p_session_id
  FOR UPDATE;

  IF NOT FOUND OR v_session.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'R2.12 candidate session is not active' USING ERRCODE = 'R2605';
  END IF;

  SELECT ai.* INTO v_interaction
  FROM hirearchy.candidate_ai_interactions AS ai
  WHERE ai.session_id = p_session_id AND ai.request_id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'R2.12 interaction not found' USING ERRCODE = '22023';
  END IF;

  IF v_interaction.status = 'COMPLETED' THEN
    RETURN pg_catalog.jsonb_build_object(
      'interactionId', v_interaction.interaction_id,
      'requestId', v_interaction.request_id,
      'sequenceStart', v_interaction.sequence_start,
      'sequenceCompleted', v_interaction.sequence_completed,
      'candidatePrompt', v_interaction.candidate_prompt,
      'assistantResponse', v_interaction.assistant_response,
      'status', v_interaction.status,
      'failureReason', v_interaction.failure_reason,
      'errorMessage', v_interaction.error_message,
      'providerId', v_interaction.provider_id,
      'modelId', v_interaction.model_id,
      'createdAt', pg_catalog.to_char(v_interaction.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'completedAt', pg_catalog.to_char(v_interaction.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    );
  END IF;

  v_now := pg_catalog.clock_timestamp();
  SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
  INTO v_sequence
  FROM hirearchy.candidate_session_events AS event
  WHERE event.session_id = p_session_id;

  INSERT INTO hirearchy.candidate_session_events (
    organization_id, session_id, sequence, event_type, happened_at, payload
  ) VALUES (
    v_session.organization_id, p_session_id, v_sequence,
    'AI_RESPONSE_COMPLETED', v_now,
    pg_catalog.jsonb_build_object(
      'requestId', p_request_id,
      'interactionId', v_interaction.interaction_id,
      'sequenceStart', v_interaction.sequence_start,
      'durationMs', p_duration_ms,
      'responseChars', pg_catalog.char_length(p_assistant_response)
    )
  );

  UPDATE hirearchy.candidate_ai_interactions
  SET status = 'COMPLETED',
      assistant_response = p_assistant_response,
      sequence_completed = v_sequence,
      completed_at = v_now
  WHERE session_id = p_session_id AND request_id = p_request_id;

  RETURN pg_catalog.jsonb_build_object(
    'interactionId', v_interaction.interaction_id,
    'requestId', p_request_id,
    'sequenceStart', v_interaction.sequence_start,
    'sequenceCompleted', v_sequence,
    'candidatePrompt', v_interaction.candidate_prompt,
    'assistantResponse', p_assistant_response,
    'status', 'COMPLETED',
    'failureReason', NULL,
    'errorMessage', NULL,
    'providerId', v_interaction.provider_id,
    'modelId', v_interaction.model_id,
    'createdAt', pg_catalog.to_char(v_interaction.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'completedAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_r212_fail(
  p_token_hash pg_catalog.text,
  p_session_id pg_catalog.text,
  p_request_id pg_catalog.text,
  p_failure_reason pg_catalog.text,
  p_error_message pg_catalog.text,
  p_duration_ms pg_catalog.int4 DEFAULT NULL
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session record;
  v_interaction record;
  v_sequence pg_catalog.int8;
  v_now pg_catalog.timestamptz;
BEGIN
  IF SESSION_USER NOT IN ('app_candidate_gateway', 'postgres', 'hirearchy_migrator') THEN
    RAISE EXCEPTION 'R2.12 candidate role denied' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config('r26.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config('r26.token_hash', p_token_hash, true);

  IF NOT EXISTS (
    SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
    WHERE envelope.session_id = p_session_id
      AND envelope.candidate_token_hash = p_token_hash
  ) THEN
    RAISE EXCEPTION 'R2.12 candidate authentication failed' USING ERRCODE = '42501';
  END IF;

  SELECT s.* INTO v_session
  FROM hirearchy.assessment_sessions AS s
  WHERE s.id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'R2.12 candidate session unavailable' USING ERRCODE = 'R2604';
  END IF;

  SELECT ai.* INTO v_interaction
  FROM hirearchy.candidate_ai_interactions AS ai
  WHERE ai.session_id = p_session_id AND ai.request_id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'R2.12 interaction not found' USING ERRCODE = '22023';
  END IF;

  IF v_interaction.status IN ('COMPLETED', 'FAILED') THEN
    RETURN pg_catalog.jsonb_build_object(
      'interactionId', v_interaction.interaction_id,
      'requestId', v_interaction.request_id,
      'sequenceStart', v_interaction.sequence_start,
      'sequenceCompleted', v_interaction.sequence_completed,
      'candidatePrompt', v_interaction.candidate_prompt,
      'assistantResponse', v_interaction.assistant_response,
      'status', v_interaction.status,
      'failureReason', v_interaction.failure_reason,
      'errorMessage', v_interaction.error_message,
      'providerId', v_interaction.provider_id,
      'modelId', v_interaction.model_id,
      'createdAt', pg_catalog.to_char(v_interaction.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'completedAt', pg_catalog.to_char(v_interaction.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    );
  END IF;

  v_now := pg_catalog.clock_timestamp();
  SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
  INTO v_sequence
  FROM hirearchy.candidate_session_events AS event
  WHERE event.session_id = p_session_id;

  INSERT INTO hirearchy.candidate_session_events (
    organization_id, session_id, sequence, event_type, happened_at, payload
  ) VALUES (
    v_session.organization_id, p_session_id, v_sequence,
    'AI_REQUEST_FAILED', v_now,
    pg_catalog.jsonb_build_object(
      'requestId', p_request_id,
      'interactionId', v_interaction.interaction_id,
      'sequenceStart', v_interaction.sequence_start,
      'failureReason', p_failure_reason,
      'durationMs', p_duration_ms
    )
  );

  UPDATE hirearchy.candidate_ai_interactions
  SET status = 'FAILED',
      failure_reason = p_failure_reason,
      error_message = p_error_message,
      sequence_completed = v_sequence,
      completed_at = v_now
  WHERE session_id = p_session_id AND request_id = p_request_id;

  RETURN pg_catalog.jsonb_build_object(
    'interactionId', v_interaction.interaction_id,
    'requestId', p_request_id,
    'sequenceStart', v_interaction.sequence_start,
    'sequenceCompleted', v_sequence,
    'candidatePrompt', v_interaction.candidate_prompt,
    'assistantResponse', NULL,
    'status', 'FAILED',
    'failureReason', p_failure_reason,
    'errorMessage', p_error_message,
    'providerId', v_interaction.provider_id,
    'modelId', v_interaction.model_id,
    'createdAt', pg_catalog.to_char(v_interaction.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'completedAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
END
$function$;

ALTER FUNCTION staging.hiring_r212_get_view(pg_catalog.text, pg_catalog.text) OWNER TO hirearchy_migrator;
ALTER FUNCTION staging.hiring_r212_admit(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) OWNER TO hirearchy_migrator;
ALTER FUNCTION staging.hiring_r212_complete(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) OWNER TO hirearchy_migrator;
ALTER FUNCTION staging.hiring_r212_fail(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) OWNER TO hirearchy_migrator;

REVOKE ALL ON FUNCTION staging.hiring_r212_get_view(pg_catalog.text, pg_catalog.text)
  FROM PUBLIC, r23_gateway, app_evaluator, app_control_worker, staging_verifier_owner, staging_readiness_owner;
REVOKE ALL ON FUNCTION staging.hiring_r212_admit(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text)
  FROM PUBLIC, r23_gateway, app_evaluator, app_control_worker, staging_verifier_owner, staging_readiness_owner;
REVOKE ALL ON FUNCTION staging.hiring_r212_complete(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4)
  FROM PUBLIC, r23_gateway, app_evaluator, app_control_worker, staging_verifier_owner, staging_readiness_owner;
REVOKE ALL ON FUNCTION staging.hiring_r212_fail(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4)
  FROM PUBLIC, r23_gateway, app_evaluator, app_control_worker, staging_verifier_owner, staging_readiness_owner;

GRANT USAGE ON SCHEMA staging TO app_candidate_gateway;
GRANT EXECUTE ON FUNCTION staging.hiring_r212_get_view(pg_catalog.text, pg_catalog.text) TO app_candidate_gateway;
GRANT EXECUTE ON FUNCTION staging.hiring_r212_admit(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO app_candidate_gateway;
GRANT EXECUTE ON FUNCTION staging.hiring_r212_complete(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) TO app_candidate_gateway;
GRANT EXECUTE ON FUNCTION staging.hiring_r212_fail(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) TO app_candidate_gateway;

-- terminal_enabled is an immutable session column, so existing sessions are not
-- rewritten; hiring execution RPCs below treat hiring sessions as always enabled.

-- R2.13 Execution RPCs exposed to app_candidate_gateway strictly inside staging schema
CREATE OR REPLACE FUNCTION staging.hiring_r213_get_view(
  p_token_hash pg_catalog.text,
  p_session_id pg_catalog.text
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_envelope_org_id pg_catalog.uuid;
  v_session record;
  v_workspace_digest pg_catalog.text;
  v_count pg_catalog.int4 := 0;
  v_ops pg_catalog.jsonb;
BEGIN
  IF SESSION_USER NOT IN ('app_candidate_gateway', 'postgres', 'hirearchy_migrator') THEN
    RAISE EXCEPTION 'R2.13 candidate role denied' USING ERRCODE = '42501';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$' THEN
    RAISE EXCEPTION 'R2.13 invalid input parameters' USING ERRCODE = '22023';
  END IF;

  SELECT envelope.organization_id INTO v_envelope_org_id
  FROM hirearchy.candidate_token_envelopes AS envelope
  WHERE envelope.session_id = p_session_id
    AND envelope.candidate_token_hash = p_token_hash
    AND envelope.revoked_at IS NULL
    AND (envelope.expires_at IS NULL OR envelope.expires_at > pg_catalog.clock_timestamp());

  IF NOT FOUND THEN
    RAISE EXCEPTION 'R2.13 candidate authentication failed' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config('r26.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config('r26.token_hash', p_token_hash, true);

  SELECT s.* INTO v_session
  FROM hirearchy.assessment_sessions AS s
  WHERE s.id = p_session_id;

  IF NOT FOUND OR v_session.organization_id <> v_envelope_org_id THEN
    RAISE EXCEPTION 'R2.13 candidate session unavailable' USING ERRCODE = 'R2604';
  END IF;

  SELECT state.workspace_digest INTO v_workspace_digest
  FROM hirearchy.r26_workspace_state(p_session_id) AS state;

  SELECT pg_catalog.count(*)::pg_catalog.int4 INTO v_count
  FROM hirearchy.candidate_execution_operations
  WHERE session_id = p_session_id;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'organizationId', op.organization_id::pg_catalog.text,
        'sessionId', op.session_id,
        'operationId', op.operation_id,
        'requestId', op.request_id,
        'sequenceStart', op.sequence_start::pg_catalog.text,
        'sequenceCompleted', CASE WHEN op.sequence_completed IS NOT NULL THEN op.sequence_completed::pg_catalog.text ELSE NULL END,
        'workspaceDigest', op.workspace_digest,
        'workspaceVersion', op.workspace_version::pg_catalog.text,
        'recipeId', op.recipe_id,
        'recipeVersion', op.recipe_version,
        'recipeDigest', op.recipe_digest,
        'generation', op.generation,
        'fence', op.fence,
        'status', op.status,
        'exitCode', op.exit_code,
        'stdout', op.stdout,
        'stderr', op.stderr,
        'stdoutDigest', op.stdout_digest,
        'stderrDigest', op.stderr_digest,
        'truncatedStdout', op.truncated_stdout,
        'truncatedStderr', op.truncated_stderr,
        'durationMs', op.duration_ms,
        'failureReason', op.failure_reason,
        'errorMessage', op.error_message,
        'cleanupStatus', op.cleanup_status,
        'isUnknown', op.is_unknown,
        'provenance', op.provenance,
        'isSynthetic', (op.provenance = 'synthetic-execution-adapter'),
        'createdAt', pg_catalog.to_char(op.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'completedAt', CASE WHEN op.completed_at IS NOT NULL THEN pg_catalog.to_char(op.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ELSE NULL END
      ) ORDER BY op.sequence_start
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_ops
  FROM hirearchy.candidate_execution_operations AS op
  WHERE op.session_id = p_session_id;

  RETURN pg_catalog.jsonb_build_object(
    'terminalEnabled', true,
    'remainingExecutions', GREATEST(0, 10 - v_count),
    'maxExecutions', 10,
    'currentWorkspaceDigest', COALESCE(v_workspace_digest, ''),
    'operations', v_ops
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_r213_admit(
  p_token_hash pg_catalog.text,
  p_session_id pg_catalog.text,
  p_request_id pg_catalog.text,
  p_expected_workspace_digest pg_catalog.text,
  p_recipe_id pg_catalog.text DEFAULT 'recipe-python-check-v1',
  p_recipe_version pg_catalog.text DEFAULT '1.0.0',
  p_recipe_digest pg_catalog.text DEFAULT '0760fc4197b0b1654be37456fc70f7c1a9159520ca78cd5b3115e7a5affd6fd2',
  p_provenance pg_catalog.text DEFAULT 'hiring-workspace-runner'
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_envelope_org_id pg_catalog.uuid;
  v_session record;
  v_existing record;
  v_sequence pg_catalog.int8;
  v_operation_id pg_catalog.text;
  v_now pg_catalog.timestamptz;
  v_deadline pg_catalog.timestamptz;
  v_max_executions pg_catalog.int4 := 10;
  v_current_count pg_catalog.int4 := 0;
  v_recipe_id pg_catalog.text;
  v_recipe_version pg_catalog.text;
  v_recipe_digest pg_catalog.text;
  v_provenance pg_catalog.text;
  v_workspace_digest pg_catalog.text;
  v_workspace_version pg_catalog.int8;
  v_op_json pg_catalog.jsonb;
  v_intent_json pg_catalog.jsonb;
BEGIN
  IF SESSION_USER NOT IN ('app_candidate_gateway', 'postgres', 'hirearchy_migrator') THEN
    RAISE EXCEPTION 'R2.13 candidate role denied' USING ERRCODE = '42501';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$'
     OR p_request_id IS NULL OR p_request_id !~ '^[A-Za-z0-9_-]{1,128}$'
     OR p_expected_workspace_digest IS NULL OR p_expected_workspace_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'R2.13 invalid input parameters' USING ERRCODE = '22023';
  END IF;

  SELECT envelope.organization_id INTO v_envelope_org_id
  FROM hirearchy.candidate_token_envelopes AS envelope
  WHERE envelope.session_id = p_session_id
    AND envelope.candidate_token_hash = p_token_hash
    AND envelope.revoked_at IS NULL
    AND (envelope.expires_at IS NULL OR envelope.expires_at > pg_catalog.clock_timestamp());

  IF NOT FOUND THEN
    RAISE EXCEPTION 'R2.13 candidate authentication failed' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config('r26.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config('r26.token_hash', p_token_hash, true);

  SELECT s.* INTO v_session
  FROM hirearchy.assessment_sessions AS s
  WHERE s.id = p_session_id
  FOR UPDATE;

  IF NOT FOUND OR v_session.organization_id <> v_envelope_org_id THEN
    RAISE EXCEPTION 'R2.13 candidate session unavailable' USING ERRCODE = 'R2604';
  END IF;

  IF v_session.status <> 'ACTIVE' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'DENIED',
      'reason', 'SESSION_CLOSED',
      'message', 'Session is closed or submitted'
    );
  END IF;

  v_now := pg_catalog.clock_timestamp();
  v_deadline := v_session.activated_at + (v_session.duration_seconds * INTERVAL '1 second');
  IF v_now >= v_deadline THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'DENIED',
      'reason', 'DEADLINE_EXCEEDED',
      'message', 'Assessment session deadline has expired'
    );
  END IF;

  v_recipe_id := COALESCE(p_recipe_id, 'recipe-python-check-v1');
  v_recipe_version := COALESCE(p_recipe_version, '1.0.0');
  v_recipe_digest := COALESCE(p_recipe_digest, '0760fc4197b0b1654be37456fc70f7c1a9159520ca78cd5b3115e7a5affd6fd2');
  v_provenance := COALESCE(p_provenance, 'hiring-workspace-runner');

  SELECT op.* INTO v_existing
  FROM hirearchy.candidate_execution_operations AS op
  WHERE op.session_id = p_session_id
    AND op.request_id = p_request_id;

  IF FOUND THEN
    IF v_existing.workspace_digest <> p_expected_workspace_digest THEN
      RAISE EXCEPTION 'R2.13 request ID reused with different intent' USING ERRCODE = '23514';
    END IF;

    SELECT pg_catalog.count(*)::pg_catalog.int4 INTO v_current_count
    FROM hirearchy.candidate_execution_operations
    WHERE session_id = p_session_id;

    v_intent_json := pg_catalog.jsonb_build_object(
      'organizationId', v_existing.organization_id::pg_catalog.text,
      'sessionId', v_existing.session_id,
      'operationId', v_existing.operation_id,
      'requestId', v_existing.request_id,
      'assessmentVersion', v_session.scenario_id || '@' || v_session.scenario_version,
      'persistedWorkspaceVersion', v_existing.workspace_version::pg_catalog.text,
      'canonicalWorkspaceSnapshotDigest', v_existing.workspace_digest,
      'approvedRecipeId', v_existing.recipe_id,
      'approvedRecipeVersion', v_existing.recipe_version,
      'approvedRecipeDigest', v_existing.recipe_digest,
      'admittedAt', pg_catalog.to_char(v_existing.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'sessionDeadline', pg_catalog.to_char(v_deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'budgets', pg_catalog.jsonb_build_object(
        'timeoutMs', 10000,
        'maxStdoutBytes', 64000,
        'maxStderrBytes', 64000,
        'maxExecutionCount', 10
      ),
      'generation', v_existing.generation,
      'fence', v_existing.fence,
      'protocolVersion', 'r213-execution-v1'
    );

    v_op_json := pg_catalog.jsonb_build_object(
      'organizationId', v_existing.organization_id::pg_catalog.text,
      'sessionId', v_existing.session_id,
      'operationId', v_existing.operation_id,
      'requestId', v_existing.request_id,
      'sequenceStart', v_existing.sequence_start::pg_catalog.text,
      'sequenceCompleted', CASE WHEN v_existing.sequence_completed IS NOT NULL THEN v_existing.sequence_completed::pg_catalog.text ELSE NULL END,
      'workspaceDigest', v_existing.workspace_digest,
      'workspaceVersion', v_existing.workspace_version::pg_catalog.text,
      'recipeId', v_existing.recipe_id,
      'recipeVersion', v_existing.recipe_version,
      'recipeDigest', v_existing.recipe_digest,
      'generation', v_existing.generation,
      'fence', v_existing.fence,
      'status', v_existing.status,
      'exitCode', v_existing.exit_code,
      'stdout', v_existing.stdout,
      'stderr', v_existing.stderr,
      'stdoutDigest', v_existing.stdout_digest,
      'stderrDigest', v_existing.stderr_digest,
      'truncatedStdout', v_existing.truncated_stdout,
      'truncatedStderr', v_existing.truncated_stderr,
      'durationMs', v_existing.duration_ms,
      'failureReason', v_existing.failure_reason,
      'errorMessage', v_existing.error_message,
      'cleanupStatus', v_existing.cleanup_status,
      'isUnknown', v_existing.is_unknown,
      'provenance', v_existing.provenance,
      'isSynthetic', (v_existing.provenance = 'synthetic-execution-adapter'),
      'createdAt', pg_catalog.to_char(v_existing.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'completedAt', CASE WHEN v_existing.completed_at IS NOT NULL THEN pg_catalog.to_char(v_existing.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ELSE NULL END
    );

    RETURN pg_catalog.jsonb_build_object(
      'status', 'REPLAY',
      'remainingExecutions', GREATEST(0, v_max_executions - v_current_count),
      'intent', v_intent_json,
      'operation', v_op_json
    );
  END IF;

  SELECT state.workspace_digest INTO v_workspace_digest
  FROM hirearchy.r26_workspace_state(p_session_id) AS state;

  IF v_workspace_digest IS NULL OR v_workspace_digest <> p_expected_workspace_digest THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'DENIED',
      'reason', 'STALE_WORKSPACE',
      'message', 'Persisted workspace digest does not match expected digest'
    );
  END IF;

  SELECT COALESCE(pg_catalog.max(f.version), 0) INTO v_workspace_version
  FROM hirearchy.candidate_workspace_files AS f
  WHERE f.session_id = p_session_id;

  SELECT pg_catalog.count(*)::pg_catalog.int4 INTO v_current_count
  FROM hirearchy.candidate_execution_operations
  WHERE session_id = p_session_id;

  IF v_current_count >= v_max_executions THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'DENIED',
      'reason', 'BUDGET_EXHAUSTED',
      'message', 'Execution budget limit of 10 runs reached'
    );
  END IF;

  SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
  INTO v_sequence
  FROM hirearchy.candidate_session_events AS event
  WHERE event.session_id = p_session_id;

  v_operation_id := 'op_exec_' || pg_catalog.substr(p_request_id, 1, 110);

  INSERT INTO hirearchy.candidate_session_events (
    organization_id, session_id, sequence, event_type, happened_at, payload
  ) VALUES (
    v_session.organization_id, p_session_id, v_sequence,
    'EXECUTION_REQUESTED', v_now,
    pg_catalog.jsonb_build_object(
      'operationId', v_operation_id,
      'requestId', p_request_id,
      'workspaceDigest', v_workspace_digest,
      'workspaceVersion', v_workspace_version,
      'recipeId', v_recipe_id,
      'recipeVersion', v_recipe_version,
      'recipeDigest', v_recipe_digest,
      'generation', 1,
      'fence', v_sequence
    )
  );

  INSERT INTO hirearchy.candidate_execution_operations (
    organization_id, session_id, operation_id, request_id,
    sequence_start, workspace_digest, workspace_version,
    recipe_id, recipe_version, recipe_digest,
    generation, fence, status, provenance, created_at
  ) VALUES (
    v_session.organization_id, p_session_id, v_operation_id, p_request_id,
    v_sequence, v_workspace_digest, v_workspace_version,
    v_recipe_id, v_recipe_version, v_recipe_digest,
    1, v_sequence, 'ADMITTED', v_provenance, v_now
  );

  v_intent_json := pg_catalog.jsonb_build_object(
    'organizationId', v_session.organization_id::pg_catalog.text,
    'sessionId', p_session_id,
    'operationId', v_operation_id,
    'requestId', p_request_id,
    'assessmentVersion', v_session.scenario_id || '@' || v_session.scenario_version,
    'persistedWorkspaceVersion', v_workspace_version::pg_catalog.text,
    'canonicalWorkspaceSnapshotDigest', v_workspace_digest,
    'approvedRecipeId', v_recipe_id,
    'approvedRecipeVersion', v_recipe_version,
    'approvedRecipeDigest', v_recipe_digest,
    'admittedAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'sessionDeadline', pg_catalog.to_char(v_deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'budgets', pg_catalog.jsonb_build_object(
      'timeoutMs', 10000,
      'maxStdoutBytes', 64000,
      'maxStderrBytes', 64000,
      'maxExecutionCount', 10
    ),
    'generation', 1,
    'fence', v_sequence,
    'protocolVersion', 'r213-execution-v1'
  );

  v_op_json := pg_catalog.jsonb_build_object(
    'organizationId', v_session.organization_id::pg_catalog.text,
    'sessionId', p_session_id,
    'operationId', v_operation_id,
    'requestId', p_request_id,
    'sequenceStart', v_sequence::pg_catalog.text,
    'sequenceCompleted', NULL,
    'workspaceDigest', v_workspace_digest,
    'workspaceVersion', v_workspace_version::pg_catalog.text,
    'recipeId', v_recipe_id,
    'recipeVersion', v_recipe_version,
    'recipeDigest', v_recipe_digest,
    'generation', 1,
    'fence', v_sequence,
    'status', 'ADMITTED',
    'exitCode', NULL,
    'stdout', NULL,
    'stderr', NULL,
    'stdoutDigest', NULL,
    'stderrDigest', NULL,
    'truncatedStdout', false,
    'truncatedStderr', false,
    'durationMs', NULL,
    'failureReason', NULL,
    'errorMessage', NULL,
    'cleanupStatus', 'CLEAN',
    'isUnknown', false,
    'provenance', v_provenance,
    'isSynthetic', (v_provenance = 'synthetic-execution-adapter'),
    'createdAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'completedAt', NULL
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ADMITTED',
    'remainingExecutions', GREATEST(0, v_max_executions - (v_current_count + 1)),
    'intent', v_intent_json,
    'operation', v_op_json
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_r213_complete(
  p_token_hash pg_catalog.text,
  p_session_id pg_catalog.text,
  p_operation_id pg_catalog.text,
  p_fence pg_catalog.int8,
  p_generation pg_catalog.int4 DEFAULT 1,
  p_exit_code pg_catalog.int4 DEFAULT 0,
  p_stdout pg_catalog.text DEFAULT '',
  p_stderr pg_catalog.text DEFAULT '',
  p_stdout_digest pg_catalog.text DEFAULT NULL,
  p_stderr_digest pg_catalog.text DEFAULT NULL,
  p_truncated_stdout boolean DEFAULT false,
  p_truncated_stderr boolean DEFAULT false,
  p_duration_ms pg_catalog.int4 DEFAULT NULL,
  p_cleanup_status pg_catalog.text DEFAULT 'CLEAN',
  p_provenance pg_catalog.text DEFAULT NULL
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_op record;
  v_sequence pg_catalog.int8;
  v_now pg_catalog.timestamptz;
  v_stdout_digest pg_catalog.text;
  v_stderr_digest pg_catalog.text;
  v_cleanup_status pg_catalog.text;
  v_provenance pg_catalog.text;
BEGIN
  IF SESSION_USER NOT IN ('app_candidate_gateway', 'postgres', 'hirearchy_migrator') THEN
    RAISE EXCEPTION 'R2.13 candidate role denied' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config('r26.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config('r26.token_hash', p_token_hash, true);

  IF NOT EXISTS (
    SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
    WHERE envelope.session_id = p_session_id
      AND envelope.candidate_token_hash = p_token_hash
  ) THEN
    RAISE EXCEPTION 'R2.13 candidate authentication failed' USING ERRCODE = '42501';
  END IF;

  SELECT op.* INTO v_op
  FROM hirearchy.candidate_execution_operations AS op
  WHERE op.session_id = p_session_id
    AND op.operation_id = p_operation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'R2.13 execution operation not found' USING ERRCODE = '22023';
  END IF;

  IF v_op.status <> 'ADMITTED' THEN
    RAISE EXCEPTION 'R2.13 execution operation already finished' USING ERRCODE = '23514';
  END IF;

  IF v_op.fence <> p_fence OR v_op.generation <> COALESCE(p_generation, 1) THEN
    RAISE EXCEPTION 'R2.13 stale generation or fence rejected' USING ERRCODE = '23514';
  END IF;

  v_now := pg_catalog.clock_timestamp();
  v_stdout_digest := COALESCE(
    p_stdout_digest,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(p_stdout, ''), 'UTF8')), 'hex')
  );
  v_stderr_digest := COALESCE(
    p_stderr_digest,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(p_stderr, ''), 'UTF8')), 'hex')
  );
  v_cleanup_status := CASE WHEN p_cleanup_status IN ('CLEAN', 'RESOURCE_LEAK', 'UNKNOWN') THEN p_cleanup_status ELSE 'CLEAN' END;
  v_provenance := COALESCE(p_provenance, v_op.provenance);

  SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
  INTO v_sequence
  FROM hirearchy.candidate_session_events AS event
  WHERE event.session_id = p_session_id;

  INSERT INTO hirearchy.candidate_session_events (
    organization_id, session_id, sequence, event_type, happened_at, payload
  ) VALUES (
    v_op.organization_id, p_session_id, v_sequence,
    'EXECUTION_COMPLETED', v_now,
    pg_catalog.jsonb_build_object(
      'operationId', p_operation_id,
      'generation', v_op.generation,
      'fence', v_op.fence,
      'exitCode', p_exit_code,
      'durationMs', p_duration_ms,
      'stdoutDigest', v_stdout_digest,
      'stderrDigest', v_stderr_digest,
      'cleanupStatus', v_cleanup_status
    )
  );

  UPDATE hirearchy.candidate_execution_operations
  SET sequence_completed = v_sequence,
      status = 'COMPLETED',
      exit_code = p_exit_code,
      stdout = p_stdout,
      stderr = p_stderr,
      stdout_digest = v_stdout_digest,
      stderr_digest = v_stderr_digest,
      truncated_stdout = COALESCE(p_truncated_stdout, false),
      truncated_stderr = COALESCE(p_truncated_stderr, false),
      duration_ms = p_duration_ms,
      cleanup_status = v_cleanup_status,
      provenance = v_provenance,
      completed_at = v_now
  WHERE session_id = p_session_id
    AND operation_id = p_operation_id;

  RETURN pg_catalog.jsonb_build_object(
    'organizationId', v_op.organization_id::pg_catalog.text,
    'sessionId', v_op.session_id,
    'operationId', v_op.operation_id,
    'requestId', v_op.request_id,
    'sequenceStart', v_op.sequence_start::pg_catalog.text,
    'sequenceCompleted', v_sequence::pg_catalog.text,
    'workspaceDigest', v_op.workspace_digest,
    'workspaceVersion', v_op.workspace_version::pg_catalog.text,
    'recipeId', v_op.recipe_id,
    'recipeVersion', v_op.recipe_version,
    'recipeDigest', v_op.recipe_digest,
    'generation', v_op.generation,
    'fence', v_op.fence,
    'status', 'COMPLETED',
    'exitCode', p_exit_code,
    'stdout', p_stdout,
    'stderr', p_stderr,
    'stdoutDigest', v_stdout_digest,
    'stderrDigest', v_stderr_digest,
    'truncatedStdout', COALESCE(p_truncated_stdout, false),
    'truncatedStderr', COALESCE(p_truncated_stderr, false),
    'durationMs', p_duration_ms,
    'failureReason', NULL,
    'errorMessage', NULL,
    'cleanupStatus', v_cleanup_status,
    'isUnknown', false,
    'provenance', v_provenance,
    'isSynthetic', (v_provenance = 'synthetic-execution-adapter'),
    'createdAt', pg_catalog.to_char(v_op.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'completedAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_r213_fail(
  p_token_hash pg_catalog.text,
  p_session_id pg_catalog.text,
  p_operation_id pg_catalog.text,
  p_fence pg_catalog.int8,
  p_generation pg_catalog.int4 DEFAULT 1,
  p_status pg_catalog.text DEFAULT 'FAILED',
  p_failure_reason pg_catalog.text DEFAULT 'RUNNER_FAILURE',
  p_error_message pg_catalog.text DEFAULT 'Execution failed',
  p_stdout pg_catalog.text DEFAULT '',
  p_stderr pg_catalog.text DEFAULT '',
  p_duration_ms pg_catalog.int4 DEFAULT NULL,
  p_cleanup_status pg_catalog.text DEFAULT 'CLEAN',
  p_is_unknown boolean DEFAULT false,
  p_provenance pg_catalog.text DEFAULT NULL
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_op record;
  v_sequence pg_catalog.int8;
  v_now pg_catalog.timestamptz;
  v_stdout_digest pg_catalog.text;
  v_stderr_digest pg_catalog.text;
  v_status pg_catalog.text;
  v_cleanup_status pg_catalog.text;
  v_is_unknown boolean;
  v_provenance pg_catalog.text;
BEGIN
  IF SESSION_USER NOT IN ('app_candidate_gateway', 'postgres', 'hirearchy_migrator') THEN
    RAISE EXCEPTION 'R2.13 candidate role denied' USING ERRCODE = '42501';
  END IF;

  v_status := CASE WHEN p_status IN ('FAILED', 'TIMED_OUT', 'UNKNOWN') THEN p_status ELSE 'FAILED' END;
  v_is_unknown := COALESCE(p_is_unknown, false) OR (v_status = 'UNKNOWN');
  v_cleanup_status := CASE WHEN v_status = 'UNKNOWN' AND COALESCE(p_cleanup_status, 'CLEAN') = 'CLEAN' THEN 'UNKNOWN' ELSE COALESCE(p_cleanup_status, 'CLEAN') END;

  PERFORM pg_catalog.set_config('r26.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config('r26.token_hash', p_token_hash, true);

  IF NOT EXISTS (
    SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
    WHERE envelope.session_id = p_session_id
      AND envelope.candidate_token_hash = p_token_hash
  ) THEN
    RAISE EXCEPTION 'R2.13 candidate authentication failed' USING ERRCODE = '42501';
  END IF;

  SELECT op.* INTO v_op
  FROM hirearchy.candidate_execution_operations AS op
  WHERE op.session_id = p_session_id
    AND op.operation_id = p_operation_id
  FOR UPDATE;

  IF NOT FOUND OR v_op.status <> 'ADMITTED' THEN
    RAISE EXCEPTION 'R2.13 execution operation unavailable' USING ERRCODE = '23514';
  END IF;

  IF v_op.fence <> p_fence OR v_op.generation <> COALESCE(p_generation, 1) THEN
    RAISE EXCEPTION 'R2.13 stale generation or fence rejected' USING ERRCODE = '23514';
  END IF;

  v_now := pg_catalog.clock_timestamp();
  v_stdout_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(p_stdout, ''), 'UTF8')), 'hex');
  v_stderr_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(p_stderr, ''), 'UTF8')), 'hex');
  v_provenance := COALESCE(p_provenance, v_op.provenance);

  SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
  INTO v_sequence
  FROM hirearchy.candidate_session_events AS event
  WHERE event.session_id = p_session_id;

  INSERT INTO hirearchy.candidate_session_events (
    organization_id, session_id, sequence, event_type, happened_at, payload
  ) VALUES (
    v_op.organization_id, p_session_id, v_sequence,
    'EXECUTION_FAILED', v_now,
    pg_catalog.jsonb_build_object(
      'operationId', p_operation_id,
      'generation', v_op.generation,
      'fence', v_op.fence,
      'status', v_status,
      'failureReason', COALESCE(p_failure_reason, 'RUNNER_FAILURE'),
      'errorMessage', COALESCE(p_error_message, 'Execution failed'),
      'durationMs', p_duration_ms,
      'cleanupStatus', v_cleanup_status,
      'isUnknown', v_is_unknown
    )
  );

  UPDATE hirearchy.candidate_execution_operations
  SET sequence_completed = v_sequence,
      status = v_status,
      failure_reason = COALESCE(p_failure_reason, 'RUNNER_FAILURE'),
      error_message = COALESCE(p_error_message, 'Execution failed'),
      stdout = p_stdout,
      stderr = p_stderr,
      stdout_digest = v_stdout_digest,
      stderr_digest = v_stderr_digest,
      duration_ms = p_duration_ms,
      cleanup_status = v_cleanup_status,
      is_unknown = v_is_unknown,
      provenance = v_provenance,
      completed_at = v_now
  WHERE session_id = p_session_id
    AND operation_id = p_operation_id;

  RETURN pg_catalog.jsonb_build_object(
    'organizationId', v_op.organization_id::pg_catalog.text,
    'sessionId', v_op.session_id,
    'operationId', v_op.operation_id,
    'requestId', v_op.request_id,
    'sequenceStart', v_op.sequence_start::pg_catalog.text,
    'sequenceCompleted', v_sequence::pg_catalog.text,
    'workspaceDigest', v_op.workspace_digest,
    'workspaceVersion', v_op.workspace_version::pg_catalog.text,
    'recipeId', v_op.recipe_id,
    'recipeVersion', v_op.recipe_version,
    'recipeDigest', v_op.recipe_digest,
    'generation', v_op.generation,
    'fence', v_op.fence,
    'status', v_status,
    'exitCode', NULL,
    'stdout', p_stdout,
    'stderr', p_stderr,
    'stdoutDigest', v_stdout_digest,
    'stderrDigest', v_stderr_digest,
    'truncatedStdout', false,
    'truncatedStderr', false,
    'durationMs', p_duration_ms,
    'failureReason', COALESCE(p_failure_reason, 'RUNNER_FAILURE'),
    'errorMessage', COALESCE(p_error_message, 'Execution failed'),
    'cleanupStatus', v_cleanup_status,
    'isUnknown', v_is_unknown,
    'provenance', v_provenance,
    'isSynthetic', (v_provenance = 'synthetic-execution-adapter'),
    'createdAt', pg_catalog.to_char(v_op.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'completedAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
END
$function$;

ALTER FUNCTION staging.hiring_r213_get_view(pg_catalog.text, pg_catalog.text) OWNER TO hirearchy_migrator;
ALTER FUNCTION staging.hiring_r213_admit(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) OWNER TO hirearchy_migrator;
ALTER FUNCTION staging.hiring_r213_complete(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int8, pg_catalog.int4, pg_catalog.int4, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, boolean, boolean, pg_catalog.int4, pg_catalog.text, pg_catalog.text) OWNER TO hirearchy_migrator;
ALTER FUNCTION staging.hiring_r213_fail(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int8, pg_catalog.int4, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4, pg_catalog.text, boolean, pg_catalog.text) OWNER TO hirearchy_migrator;

REVOKE ALL ON FUNCTION staging.hiring_r213_get_view(pg_catalog.text, pg_catalog.text)
  FROM PUBLIC, r23_gateway, app_evaluator, app_control_worker, staging_verifier_owner, staging_readiness_owner;
REVOKE ALL ON FUNCTION staging.hiring_r213_admit(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text)
  FROM PUBLIC, r23_gateway, app_evaluator, app_control_worker, staging_verifier_owner, staging_readiness_owner;
REVOKE ALL ON FUNCTION staging.hiring_r213_complete(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int8, pg_catalog.int4, pg_catalog.int4, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, boolean, boolean, pg_catalog.int4, pg_catalog.text, pg_catalog.text)
  FROM PUBLIC, r23_gateway, app_evaluator, app_control_worker, staging_verifier_owner, staging_readiness_owner;
REVOKE ALL ON FUNCTION staging.hiring_r213_fail(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int8, pg_catalog.int4, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4, pg_catalog.text, boolean, pg_catalog.text)
  FROM PUBLIC, r23_gateway, app_evaluator, app_control_worker, staging_verifier_owner, staging_readiness_owner;

GRANT EXECUTE ON FUNCTION staging.hiring_r213_get_view(pg_catalog.text, pg_catalog.text) TO app_candidate_gateway;
GRANT EXECUTE ON FUNCTION staging.hiring_r213_admit(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO app_candidate_gateway;
GRANT EXECUTE ON FUNCTION staging.hiring_r213_complete(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int8, pg_catalog.int4, pg_catalog.int4, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, boolean, boolean, pg_catalog.int4, pg_catalog.text, pg_catalog.text) TO app_candidate_gateway;
GRANT EXECUTE ON FUNCTION staging.hiring_r213_fail(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int8, pg_catalog.int4, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4, pg_catalog.text, boolean, pg_catalog.text) TO app_candidate_gateway;

-- Product, Marketing & Hiring Intelligence RPCs
CREATE OR REPLACE FUNCTION staging.telemetry_record_events(
  p_events pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, pg_temp
AS $function$
DECLARE
  v_item pg_catalog.jsonb;
  v_inserted pg_catalog.int4 := 0;
  v_event_name pg_catalog.text;
  v_category pg_catalog.text;
  v_actor_type pg_catalog.text;
  v_anon_id pg_catalog.text;
  v_org_id pg_catalog.uuid;
  v_principal_id pg_catalog.uuid;
  v_session_id pg_catalog.text;
  v_route pg_catalog.text;
  v_plan_tier pg_catalog.text;
  v_status pg_catalog.text;
  v_duration_ms pg_catalog.int4;
  v_props pg_catalog.jsonb;
  v_attr pg_catalog.jsonb;
  v_attr_source pg_catalog.text;
  v_attr_medium pg_catalog.text;
  v_attr_campaign pg_catalog.text;
  v_attr_term pg_catalog.text;
  v_attr_content pg_catalog.text;
  v_attr_referrer pg_catalog.text;
  v_attr_landing pg_catalog.text;
  v_attr_actor pg_catalog.text;
BEGIN
  IF p_events IS NULL OR pg_catalog.jsonb_typeof(p_events) <> 'array' THEN
    RETURN pg_catalog.jsonb_build_object('accepted', 0);
  END IF;

  FOR v_item IN
    SELECT elem
    FROM pg_catalog.jsonb_array_elements(p_events) AS elem
    LIMIT 50
  LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object' THEN
      CONTINUE;
    END IF;

    v_event_name := pg_catalog.left(COALESCE(v_item ->> 'eventName', ''), 80);
    v_category := COALESCE(v_item ->> 'category', '');
    v_actor_type := COALESCE(v_item ->> 'actorType', 'visitor');
    IF v_event_name !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$'
       OR v_category NOT IN (
         'acquisition', 'team_funnel', 'candidate_funnel', 'ai_quality',
         'monetization', 'ux_friction', 'performance', 'error'
       )
       OR v_actor_type NOT IN ('visitor', 'team_member', 'candidate', 'system') THEN
      CONTINUE;
    END IF;

    v_anon_id := NULLIF(pg_catalog.left(COALESCE(v_item ->> 'anonymousId', ''), 80), '');
    v_route := pg_catalog.left(COALESCE(v_item ->> 'route', ''), 200);
    v_status := COALESCE(v_item ->> 'status', 'ok');
    IF v_status NOT IN ('ok', 'error', 'abandoned', 'blocked') THEN
      v_status := 'ok';
    END IF;

    v_plan_tier := NULLIF(COALESCE(v_item ->> 'planTier', ''), '');
    IF v_plan_tier IS NOT NULL AND v_plan_tier NOT IN ('none', 'per_candidate', 'pro', 'ultra') THEN
      v_plan_tier := NULL;
    END IF;

    v_duration_ms := NULL;
    IF (v_item ->> 'durationMs') ~ '^\d{1,7}$' THEN
      v_duration_ms := LEAST(3600000, (v_item ->> 'durationMs')::pg_catalog.int4);
    END IF;

    v_org_id := NULL;
    IF COALESCE(v_item ->> 'organizationId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      SELECT o.id INTO v_org_id
      FROM hirearchy.organizations AS o
      WHERE o.id = (v_item ->> 'organizationId')::pg_catalog.uuid;
    END IF;

    v_principal_id := NULL;
    IF COALESCE(v_item ->> 'principalId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      SELECT p.id INTO v_principal_id
      FROM hirearchy.application_principals AS p
      WHERE p.id = (v_item ->> 'principalId')::pg_catalog.uuid;
    END IF;

    v_session_id := NULL;
    IF COALESCE(v_item ->> 'sessionId', '') <> '' THEN
      SELECT s.id INTO v_session_id
      FROM hirearchy.assessment_sessions AS s
      WHERE s.id = v_item ->> 'sessionId';
    END IF;

    v_props := CASE
      WHEN pg_catalog.jsonb_typeof(v_item -> 'properties') = 'object' THEN v_item -> 'properties'
      ELSE '{}'::pg_catalog.jsonb
    END;

    INSERT INTO hirearchy.product_events (
      event_name, category, actor_type, anonymous_id,
      organization_id, principal_id, session_id,
      route, plan_tier, status, duration_ms, properties
    ) VALUES (
      v_event_name, v_category, v_actor_type, v_anon_id,
      v_org_id, v_principal_id, v_session_id,
      v_route, v_plan_tier, v_status, v_duration_ms, v_props
    );
    v_inserted := v_inserted + 1;

    v_attr := v_item -> 'attribution';
    IF v_attr IS NOT NULL AND pg_catalog.jsonb_typeof(v_attr) = 'object' THEN
      v_anon_id := COALESCE(v_anon_id, NULLIF(pg_catalog.left(COALESCE(v_attr ->> 'anonymousId', ''), 80), ''));
      IF v_anon_id IS NOT NULL AND pg_catalog.char_length(v_anon_id) BETWEEN 8 AND 80 THEN
        v_attr_source := pg_catalog.left(COALESCE(v_attr ->> 'utmSource', ''), 160);
        v_attr_medium := pg_catalog.left(COALESCE(v_attr ->> 'utmMedium', ''), 160);
        v_attr_campaign := pg_catalog.left(COALESCE(v_attr ->> 'utmCampaign', ''), 160);
        v_attr_term := pg_catalog.left(COALESCE(v_attr ->> 'utmTerm', ''), 160);
        v_attr_content := pg_catalog.left(COALESCE(v_attr ->> 'utmContent', ''), 160);
        v_attr_referrer := pg_catalog.left(COALESCE(v_attr ->> 'referrerDomain', ''), 160);
        v_attr_landing := pg_catalog.left(COALESCE(v_attr ->> 'landingPath', v_route), 200);
        v_attr_actor := CASE
          WHEN v_actor_type IN ('team_member', 'candidate') THEN v_actor_type
          ELSE 'visitor'
        END;

        INSERT INTO hirearchy.acquisition_attributions (
          anonymous_id,
          first_utm_source, first_utm_medium, first_utm_campaign,
          first_utm_term, first_utm_content, first_referrer_domain, first_landing_path,
          last_utm_source, last_utm_medium, last_utm_campaign,
          last_referrer_domain, last_landing_path,
          actor_type, principal_id, organization_id,
          first_seen_at, last_seen_at, converted_at
        ) VALUES (
          v_anon_id,
          v_attr_source, v_attr_medium, v_attr_campaign,
          v_attr_term, v_attr_content, v_attr_referrer, v_attr_landing,
          v_attr_source, v_attr_medium, v_attr_campaign,
          v_attr_referrer, v_attr_landing,
          v_attr_actor, v_principal_id, v_org_id,
          pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
          CASE WHEN v_org_id IS NOT NULL OR v_principal_id IS NOT NULL THEN pg_catalog.clock_timestamp() ELSE NULL END
        )
        ON CONFLICT (anonymous_id) DO UPDATE SET
          last_utm_source = CASE WHEN EXCLUDED.last_utm_source <> '' THEN EXCLUDED.last_utm_source ELSE acquisition_attributions.last_utm_source END,
          last_utm_medium = CASE WHEN EXCLUDED.last_utm_medium <> '' THEN EXCLUDED.last_utm_medium ELSE acquisition_attributions.last_utm_medium END,
          last_utm_campaign = CASE WHEN EXCLUDED.last_utm_campaign <> '' THEN EXCLUDED.last_utm_campaign ELSE acquisition_attributions.last_utm_campaign END,
          last_referrer_domain = CASE WHEN EXCLUDED.last_referrer_domain <> '' THEN EXCLUDED.last_referrer_domain ELSE acquisition_attributions.last_referrer_domain END,
          last_landing_path = CASE WHEN EXCLUDED.last_landing_path <> '' THEN EXCLUDED.last_landing_path ELSE acquisition_attributions.last_landing_path END,
          actor_type = CASE WHEN EXCLUDED.actor_type IN ('team_member', 'candidate') THEN EXCLUDED.actor_type ELSE acquisition_attributions.actor_type END,
          principal_id = COALESCE(acquisition_attributions.principal_id, EXCLUDED.principal_id),
          organization_id = COALESCE(acquisition_attributions.organization_id, EXCLUDED.organization_id),
          last_seen_at = pg_catalog.clock_timestamp(),
          converted_at = COALESCE(acquisition_attributions.converted_at, EXCLUDED.converted_at);
      END IF;
    END IF;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object('accepted', v_inserted);
END
$function$;

CREATE OR REPLACE FUNCTION staging.telemetry_record_feedback(
  p_payload pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, pg_temp
AS $function$
DECLARE
  v_actor_type pg_catalog.text;
  v_surface pg_catalog.text;
  v_rating pg_catalog.int2;
  v_org_id pg_catalog.uuid;
  v_principal_id pg_catalog.uuid;
  v_session_id pg_catalog.text;
  v_tags pg_catalog.jsonb;
  v_comment pg_catalog.text;
  v_context pg_catalog.jsonb;
  v_id pg_catalog.uuid;
  v_created_at pg_catalog.timestamptz;
BEGIN
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Invalid feedback payload' USING ERRCODE = '22023';
  END IF;

  v_actor_type := COALESCE(p_payload ->> 'actorType', '');
  v_surface := COALESCE(p_payload ->> 'surface', '');
  IF v_actor_type NOT IN ('team_member', 'candidate')
     OR v_surface NOT IN ('candidate_post_submit', 'builder_ai_generated', 'evaluator_review', 'general') THEN
    RAISE EXCEPTION 'Invalid feedback actor or surface' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(p_payload ->> 'rating', '') !~ '^[1-5]$' THEN
    RAISE EXCEPTION 'Rating must be between 1 and 5' USING ERRCODE = '22023';
  END IF;
  v_rating := (p_payload ->> 'rating')::pg_catalog.int2;

  v_org_id := NULL;
  IF COALESCE(p_payload ->> 'organizationId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT o.id INTO v_org_id
    FROM hirearchy.organizations AS o
    WHERE o.id = (p_payload ->> 'organizationId')::pg_catalog.uuid;
  END IF;

  v_principal_id := NULL;
  IF COALESCE(p_payload ->> 'principalId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT p.id INTO v_principal_id
    FROM hirearchy.application_principals AS p
    WHERE p.id = (p_payload ->> 'principalId')::pg_catalog.uuid;
  END IF;

  v_session_id := NULL;
  IF COALESCE(p_payload ->> 'sessionId', '') <> '' THEN
    SELECT s.id INTO v_session_id
    FROM hirearchy.assessment_sessions AS s
    WHERE s.id = p_payload ->> 'sessionId';
  END IF;

  v_tags := CASE
    WHEN pg_catalog.jsonb_typeof(p_payload -> 'tags') = 'array' THEN p_payload -> 'tags'
    ELSE '[]'::pg_catalog.jsonb
  END;
  v_comment := pg_catalog.left(trim(COALESCE(p_payload ->> 'comment', '')), 1000);
  v_context := CASE
    WHEN pg_catalog.jsonb_typeof(p_payload -> 'context') = 'object' THEN p_payload -> 'context'
    ELSE '{}'::pg_catalog.jsonb
  END;

  INSERT INTO hirearchy.product_feedback (
    actor_type, surface, organization_id, principal_id, session_id,
    rating, tags, comment, context
  ) VALUES (
    v_actor_type, v_surface, v_org_id, v_principal_id, v_session_id,
    v_rating, v_tags, v_comment, v_context
  )
  RETURNING id, created_at INTO v_id, v_created_at;

  INSERT INTO hirearchy.product_events (
    event_name, category, actor_type, organization_id, principal_id, session_id,
    route, status, properties
  ) VALUES (
    'feedback.submitted',
    'ux_friction',
    v_actor_type,
    v_org_id,
    v_principal_id,
    v_session_id,
    COALESCE(NULLIF(pg_catalog.left(COALESCE(v_context ->> 'route', ''), 200), ''), ''),
    'ok',
    pg_catalog.jsonb_build_object(
      'surface', v_surface,
      'rating', v_rating,
      'tagCount', pg_catalog.jsonb_array_length(v_tags)
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'id', v_id::pg_catalog.text,
    'createdAt', pg_catalog.to_char(v_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.telemetry_insights_report(
  p_days pg_catalog.int4 DEFAULT 30
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, pg_temp
AS $function$
DECLARE
  v_days pg_catalog.int4 := GREATEST(1, LEAST(3650, COALESCE(p_days, 30)));
  v_since pg_catalog.timestamptz := pg_catalog.clock_timestamp() - pg_catalog.make_interval(days => v_days);
  v_marketing pg_catalog.jsonb;
  v_channels pg_catalog.jsonb;
  v_funnel pg_catalog.jsonb;
  v_assessment_health pg_catalog.jsonb;
  v_ai_perf pg_catalog.jsonb;
  v_monetization pg_catalog.jsonb;
  v_ux_friction pg_catalog.jsonb;
  v_recent_feedback pg_catalog.jsonb;
BEGIN
  WITH sess AS (
    SELECT
      s.id,
      s.organization_id,
      s.status,
      s.created_at,
      s.activated_at,
      s.submitted_at,
      COALESCE((s.ai_capability_snapshot ->> 'enabled')::boolean, false) AS ai_enabled
    FROM hirearchy.assessment_sessions AS s
    WHERE s.created_at >= v_since
  ),
  decs AS (
    SELECT d.session_id, d.decision, d.published_at, s.submitted_at
    FROM hirearchy.hiring_decisions AS d
    JOIN hirearchy.assessment_sessions AS s ON s.id = d.session_id
    WHERE d.published_at >= v_since
  ),
  cand_fb AS (
    SELECT f.rating
    FROM hirearchy.product_feedback AS f
    WHERE f.created_at >= v_since
      AND f.actor_type = 'candidate'
  )
  SELECT pg_catalog.jsonb_build_object(
    'totalOrganizations', (SELECT COUNT(*)::pg_catalog.int4 FROM hirearchy.organizations),
    'activeOrganizations', (SELECT COUNT(DISTINCT s.organization_id)::pg_catalog.int4 FROM sess AS s),
    'totalSessionsIssued', (SELECT COUNT(*)::pg_catalog.int4 FROM sess),
    'sessionsStarted', (SELECT COUNT(*)::pg_catalog.int4 FROM sess WHERE activated_at IS NOT NULL),
    'sessionsSubmitted', (SELECT COUNT(*)::pg_catalog.int4 FROM sess WHERE submitted_at IS NOT NULL),
    'candidateStartRatePct', COALESCE((
      SELECT ROUND((COUNT(*) FILTER (WHERE activated_at IS NOT NULL) * 100.0) / NULLIF(COUNT(*), 0), 1)
      FROM sess
    ), 0),
    'candidateCompletionRatePct', COALESCE((
      SELECT ROUND((COUNT(*) FILTER (WHERE submitted_at IS NOT NULL) * 100.0) / NULLIF(COUNT(*) FILTER (WHERE activated_at IS NOT NULL), 0), 1)
      FROM sess
    ), 0),
    'medianCandidateMinutes', (
      SELECT ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (submitted_at - activated_at)) / 60.0))::numeric, 1)
      FROM sess
      WHERE activated_at IS NOT NULL AND submitted_at IS NOT NULL AND submitted_at >= activated_at
    ),
    'medianReviewTurnaroundHours', (
      SELECT ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (published_at - submitted_at)) / 3600.0))::numeric, 1)
      FROM decs
      WHERE submitted_at IS NOT NULL AND published_at >= submitted_at
    ),
    'decisionsPublished', (SELECT COUNT(*)::pg_catalog.int4 FROM decs),
    'acceptanceRatePct', COALESCE((
      SELECT ROUND((COUNT(*) FILTER (WHERE decision = 'accepted') * 100.0) / NULLIF(COUNT(*), 0), 1)
      FROM decs
    ), 0),
    'aiAssistantEnabledPct', COALESCE((
      SELECT ROUND((COUNT(*) FILTER (WHERE ai_enabled) * 100.0) / NULLIF(COUNT(*), 0), 1)
      FROM sess
    ), 0),
    'candidateSatisfactionAvg', (SELECT ROUND(AVG(rating)::numeric, 2) FROM cand_fb),
    'candidateFairnessPositivePct', COALESCE((
      SELECT ROUND((COUNT(*) FILTER (WHERE rating >= 4) * 100.0) / NULLIF(COUNT(*), 0), 1)
      FROM cand_fb
    ), 0),
    'totalCandidateFeedback', (SELECT COUNT(*)::pg_catalog.int4 FROM cand_fb)
  ) INTO v_marketing;

  SELECT COALESCE(pg_catalog.jsonb_agg(row_obj ORDER BY visitors DESC), '[]'::pg_catalog.jsonb)
  INTO v_channels
  FROM (
    SELECT
      pg_catalog.jsonb_build_object(
        'source', src,
        'medium', med,
        'campaign', camp,
        'visitors', COUNT(*)::pg_catalog.int4,
        'signups', COUNT(*) FILTER (WHERE principal_id IS NOT NULL)::pg_catalog.int4,
        'orgsCreated', COUNT(*) FILTER (WHERE organization_id IS NOT NULL)::pg_catalog.int4,
        'conversionRatePct', COALESCE(ROUND((COUNT(*) FILTER (WHERE principal_id IS NOT NULL OR organization_id IS NOT NULL) * 100.0) / NULLIF(COUNT(*), 0), 1), 0)
      ) AS row_obj,
      COUNT(*) AS visitors
    FROM (
      SELECT
        COALESCE(NULLIF(first_utm_source, ''), NULLIF(first_referrer_domain, ''), 'direct') AS src,
        COALESCE(NULLIF(first_utm_medium, ''), CASE WHEN first_referrer_domain <> '' THEN 'referral' ELSE 'none' END) AS med,
        COALESCE(NULLIF(first_utm_campaign, ''), '—') AS camp,
        principal_id,
        organization_id
      FROM hirearchy.acquisition_attributions
      WHERE last_seen_at >= v_since
    ) AS raw_ch
    GROUP BY src, med, camp
    ORDER BY visitors DESC
    LIMIT 15
  ) AS ch;

  WITH ran_sessions AS (
    SELECT DISTINCT eo.session_id
    FROM hirearchy.candidate_execution_operations AS eo
    WHERE eo.created_at >= v_since
  ),
  opened_sessions AS (
    SELECT DISTINCT pe.session_id
    FROM hirearchy.product_events AS pe
    WHERE pe.occurred_at >= v_since
      AND pe.event_name = 'candidate.workspace.opened'
      AND pe.session_id IS NOT NULL
  )
  SELECT pg_catalog.jsonb_build_object(
    'orgsCreated', (
      SELECT COUNT(*)::pg_catalog.int4
      FROM (
        SELECT o.id, MIN(om.joined_at) AS first_joined_at
        FROM hirearchy.organizations AS o
        JOIN hirearchy.organization_memberships AS om ON om.organization_id = o.id
        GROUP BY o.id
      ) AS org_dates
      WHERE org_dates.first_joined_at >= v_since
    ),
    'assessmentsAuthored', (SELECT COUNT(*)::pg_catalog.int4 FROM hirearchy.assessment_library_entries WHERE created_at >= v_since),
    'invitesIssued', (SELECT COUNT(*)::pg_catalog.int4 FROM hirearchy.assessment_sessions WHERE created_at >= v_since),
    'candidatesOpened', (
      SELECT COUNT(DISTINCT s.id)::pg_catalog.int4
      FROM hirearchy.assessment_sessions AS s
      WHERE s.created_at >= v_since
        AND (s.activated_at IS NOT NULL OR s.id IN (SELECT session_id FROM opened_sessions))
    ),
    'candidatesStarted', (
      SELECT COUNT(*)::pg_catalog.int4
      FROM hirearchy.assessment_sessions
      WHERE created_at >= v_since AND activated_at IS NOT NULL
    ),
    'candidatesRanCode', (
      SELECT COUNT(*)::pg_catalog.int4
      FROM hirearchy.assessment_sessions AS s
      WHERE s.created_at >= v_since AND s.id IN (SELECT session_id FROM ran_sessions)
    ),
    'candidatesSubmitted', (
      SELECT COUNT(*)::pg_catalog.int4
      FROM hirearchy.assessment_sessions
      WHERE created_at >= v_since AND submitted_at IS NOT NULL
    ),
    'decisionsPublished', (
      SELECT COUNT(*)::pg_catalog.int4
      FROM hirearchy.hiring_decisions
      WHERE published_at >= v_since
    ),
    'handoffsCompleted', (
      SELECT COUNT(*)::pg_catalog.int4
      FROM hirearchy.hiring_decisions
      WHERE published_at >= v_since AND handoff_status = 'completed'
    )
  ) INTO v_funnel;

  SELECT COALESCE(pg_catalog.jsonb_agg(item_obj ORDER BY issued DESC, title ASC), '[]'::pg_catalog.jsonb)
  INTO v_assessment_health
  FROM (
    SELECT
      row_title AS title,
      COUNT(*)::pg_catalog.int4 AS issued,
      pg_catalog.jsonb_build_object(
        'title', row_title,
        'sourceKind', COALESCE(MAX(source_kind), 'template'),
        'targetRole', COALESCE(NULLIF(MAX(target_role), ''), 'General'),
        'issued', COUNT(*)::pg_catalog.int4,
        'started', COUNT(*) FILTER (WHERE activated_at IS NOT NULL)::pg_catalog.int4,
        'submitted', COUNT(*) FILTER (WHERE submitted_at IS NOT NULL)::pg_catalog.int4,
        'completionRatePct', COALESCE(ROUND((COUNT(*) FILTER (WHERE submitted_at IS NOT NULL) * 100.0) / NULLIF(COUNT(*) FILTER (WHERE activated_at IS NOT NULL), 0), 1), 0),
        'medianMinutes', ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY CASE WHEN submitted_at IS NOT NULL AND activated_at IS NOT NULL AND submitted_at >= activated_at THEN EXTRACT(EPOCH FROM (submitted_at - activated_at)) / 60.0 ELSE NULL END))::numeric, 1),
        'executionErrorRatePct', COALESCE(ROUND((SUM(err_ops) * 100.0) / NULLIF(SUM(total_ops), 0), 1), 0),
        'avgCandidateRating', ROUND(AVG(fb_rating)::numeric, 2),
        'healthFlag', CASE
          WHEN COUNT(*) FILTER (WHERE activated_at IS NOT NULL) < 3 THEN 'low_sample'
          WHEN COALESCE((SUM(err_ops) * 100.0) / NULLIF(SUM(total_ops), 0), 0) >= 35 THEN 'runner_errors'
          WHEN COALESCE((COUNT(*) FILTER (WHERE submitted_at IS NOT NULL) * 100.0) / NULLIF(COUNT(*) FILTER (WHERE activated_at IS NOT NULL), 0), 0) < 55 THEN 'high_dropoff'
          WHEN COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY CASE WHEN submitted_at IS NOT NULL AND activated_at IS NOT NULL AND submitted_at >= activated_at THEN EXTRACT(EPOCH FROM (submitted_at - activated_at)) / 60.0 ELSE NULL END), 0) >= (MAX(duration_seconds) / 60.0) * 0.9 THEN 'time_pressure'
          ELSE 'healthy'
        END
      ) AS item_obj
    FROM (
      SELECT
        s.id,
        s.scenario_title AS row_title,
        s.activated_at,
        s.submitted_at,
        s.duration_seconds,
        lib.source_kind,
        m.target_role,
        COALESCE(op_stats.total_ops, 0) AS total_ops,
        COALESCE(op_stats.err_ops, 0) AS err_ops,
        fb.avg_rating AS fb_rating
      FROM hirearchy.assessment_sessions AS s
      LEFT JOIN hirearchy.hiring_session_metadata AS m ON m.session_id = s.id
      LEFT JOIN hirearchy.assessment_library_entries AS lib ON lib.definition_id = m.definition_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS total_ops,
          COUNT(*) FILTER (WHERE status IN ('FAILED', 'TIMED_OUT', 'UNKNOWN')) AS err_ops
        FROM hirearchy.candidate_execution_operations AS eo
        WHERE eo.session_id = s.id
      ) AS op_stats ON true
      LEFT JOIN LATERAL (
        SELECT AVG(f.rating)::numeric AS avg_rating
        FROM hirearchy.product_feedback AS f
        WHERE f.session_id = s.id AND f.actor_type = 'candidate'
      ) AS fb ON true
      WHERE s.created_at >= v_since
    ) AS raw_rows
    GROUP BY row_title
    ORDER BY issued DESC, row_title ASC
    LIMIT 25
  ) AS grouped;

  WITH ai_ev AS (
    SELECT event_name, duration_ms
    FROM hirearchy.product_events
    WHERE occurred_at >= v_since
      AND event_name IN (
        'builder.ai_generate.started',
        'builder.ai_generate.completed',
        'builder.ai_generate.failed',
        'hiring.fit_report.generated',
        'evaluator.ai_review.opened'
      )
  )
  SELECT pg_catalog.jsonb_build_object(
    'generateStarted', (SELECT COUNT(*)::pg_catalog.int4 FROM ai_ev WHERE event_name = 'builder.ai_generate.started'),
    'generateCompleted', (SELECT COUNT(*)::pg_catalog.int4 FROM ai_ev WHERE event_name = 'builder.ai_generate.completed'),
    'generateFailed', (SELECT COUNT(*)::pg_catalog.int4 FROM ai_ev WHERE event_name = 'builder.ai_generate.failed'),
    'successRatePct', COALESCE((
      SELECT ROUND((COUNT(*) FILTER (WHERE event_name = 'builder.ai_generate.completed') * 100.0) / NULLIF(COUNT(*) FILTER (WHERE event_name IN ('builder.ai_generate.completed', 'builder.ai_generate.failed')), 0), 1)
      FROM ai_ev
    ), 0),
    'medianLatencyMs', (
      SELECT ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms))::numeric, 0)
      FROM ai_ev WHERE event_name = 'builder.ai_generate.completed' AND duration_ms IS NOT NULL
    ),
    'p95LatencyMs', (
      SELECT ROUND((percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::numeric, 0)
      FROM ai_ev WHERE event_name = 'builder.ai_generate.completed' AND duration_ms IS NOT NULL
    ),
    'problemsSaved', (
      SELECT COUNT(*)::pg_catalog.int4
      FROM hirearchy.assessment_library_entries
      WHERE created_at >= v_since AND source_kind = 'ai_generated'
    ),
    'aiProblemsIssued', (
      SELECT COUNT(*)::pg_catalog.int4
      FROM hirearchy.assessment_sessions AS s
      JOIN hirearchy.hiring_session_metadata AS m ON m.session_id = s.id
      JOIN hirearchy.assessment_library_entries AS lib ON lib.definition_id = m.definition_id
      WHERE s.created_at >= v_since AND lib.source_kind = 'ai_generated'
    ),
    'avgAiQualityRating', (
      SELECT ROUND(AVG(rating)::numeric, 2)
      FROM hirearchy.product_feedback
      WHERE created_at >= v_since AND surface = 'builder_ai_generated'
    ),
    'aiFeedbackCount', (
      SELECT COUNT(*)::pg_catalog.int4
      FROM hirearchy.product_feedback
      WHERE created_at >= v_since AND surface = 'builder_ai_generated'
    ),
    'advisoryReviewOpened', (
      SELECT COUNT(*)::pg_catalog.int4 FROM ai_ev WHERE event_name = 'evaluator.ai_review.opened'
    )
  ) INTO v_ai_perf;

  SELECT pg_catalog.jsonb_build_object(
    'planDistribution', pg_catalog.jsonb_build_object(
      'none', (SELECT COUNT(*)::pg_catalog.int4 FROM hirearchy.organization_plans WHERE plan_tier = 'none'),
      'per_candidate', (SELECT COUNT(*)::pg_catalog.int4 FROM hirearchy.organization_plans WHERE plan_tier = 'per_candidate'),
      'pro', (SELECT COUNT(*)::pg_catalog.int4 FROM hirearchy.organization_plans WHERE plan_tier = 'pro'),
      'ultra', (SELECT COUNT(*)::pg_catalog.int4 FROM hirearchy.organization_plans WHERE plan_tier = 'ultra')
    ),
    'planGateHits', (SELECT COUNT(*)::pg_catalog.int4 FROM hirearchy.product_events WHERE occurred_at >= v_since AND event_name = 'monetization.plan_gate_hit'),
    'upgradePageVisits', (SELECT COUNT(*)::pg_catalog.int4 FROM hirearchy.product_events WHERE occurred_at >= v_since AND event_name = 'monetization.upgrade_viewed'),
    'planUpgrades', (SELECT COUNT(*)::pg_catalog.int4 FROM hirearchy.product_events WHERE occurred_at >= v_since AND event_name = 'monetization.plan_changed'),
    'slotAddons', (SELECT COUNT(*)::pg_catalog.int4 FROM hirearchy.product_events WHERE occurred_at >= v_since AND event_name = 'monetization.slots_added')
  ) INTO v_monetization;

  SELECT pg_catalog.jsonb_build_object(
    'topErrors', COALESCE((
      SELECT pg_catalog.jsonb_agg(e_obj ORDER BY cnt DESC)
      FROM (
        SELECT COUNT(*) AS cnt, pg_catalog.jsonb_build_object(
          'eventName', event_name,
          'route', COALESCE(NULLIF(route, ''), '—'),
          'count', COUNT(*)::pg_catalog.int4
        ) AS e_obj
        FROM hirearchy.product_events
        WHERE occurred_at >= v_since AND status = 'error'
        GROUP BY event_name, route
        ORDER BY cnt DESC
        LIMIT 10
      ) AS errs
    ), '[]'::pg_catalog.jsonb),
    'topRoutes', COALESCE((
      SELECT pg_catalog.jsonb_agg(r_obj ORDER BY cnt DESC)
      FROM (
        SELECT COUNT(*) AS cnt, pg_catalog.jsonb_build_object(
          'route', COALESCE(NULLIF(route, ''), '/'),
          'views', COUNT(*)::pg_catalog.int4
        ) AS r_obj
        FROM hirearchy.product_events
        WHERE occurred_at >= v_since AND event_name = 'ux.page_view'
        GROUP BY route
        ORDER BY cnt DESC
        LIMIT 10
      ) AS rts
    ), '[]'::pg_catalog.jsonb),
    'themeSplit', pg_catalog.jsonb_build_object(
      'light', (SELECT COUNT(*)::pg_catalog.int4 FROM hirearchy.product_events WHERE occurred_at >= v_since AND event_name = 'ux.page_view' AND (properties ->> 'theme') = 'light'),
      'dark', (SELECT COUNT(*)::pg_catalog.int4 FROM hirearchy.product_events WHERE occurred_at >= v_since AND event_name = 'ux.page_view' AND (properties ->> 'theme') = 'dark')
    ),
    'clientErrorCount', (SELECT COUNT(*)::pg_catalog.int4 FROM hirearchy.product_events WHERE occurred_at >= v_since AND event_name = 'error.client_runtime'),
    'p95ApiDurationMs', (
      SELECT ROUND((percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::numeric, 0)
      FROM hirearchy.product_events
      WHERE occurred_at >= v_since AND duration_ms IS NOT NULL
    )
  ) INTO v_ux_friction;

  SELECT COALESCE(pg_catalog.jsonb_agg(f_obj ORDER BY created_at DESC), '[]'::pg_catalog.jsonb)
  INTO v_recent_feedback
  FROM (
    SELECT created_at, pg_catalog.jsonb_build_object(
      'id', id::pg_catalog.text,
      'createdAt', pg_catalog.to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'actorType', actor_type,
      'surface', surface,
      'rating', rating,
      'tags', tags,
      'comment', comment,
      'context', context
    ) AS f_obj
    FROM hirearchy.product_feedback
    WHERE created_at >= v_since
    ORDER BY created_at DESC
    LIMIT 30
  ) AS fb_rows;

  RETURN pg_catalog.jsonb_build_object(
    'windowDays', v_days,
    'generatedAt', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'marketingProof', v_marketing,
    'acquisitionChannels', v_channels,
    'hiringFunnel', v_funnel,
    'assessmentHealth', v_assessment_health,
    'aiPerformance', v_ai_perf,
    'monetization', v_monetization,
    'uxFriction', v_ux_friction,
    'recentFeedback', v_recent_feedback
  );
END
$function$;

ALTER FUNCTION staging.telemetry_record_events(pg_catalog.jsonb) OWNER TO postgres;
ALTER FUNCTION staging.telemetry_record_feedback(pg_catalog.jsonb) OWNER TO postgres;
ALTER FUNCTION staging.telemetry_insights_report(pg_catalog.int4) OWNER TO postgres;

REVOKE ALL ON FUNCTION staging.telemetry_record_events(pg_catalog.jsonb)
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker, staging_verifier_owner, staging_readiness_owner, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.telemetry_record_feedback(pg_catalog.jsonb)
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker, staging_verifier_owner, staging_readiness_owner, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.telemetry_insights_report(pg_catalog.int4)
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker, staging_verifier_owner, staging_readiness_owner, hirearchy_migrator;

GRANT EXECUTE ON FUNCTION staging.telemetry_record_events(pg_catalog.jsonb) TO r23_gateway;
GRANT EXECUTE ON FUNCTION staging.telemetry_record_feedback(pg_catalog.jsonb) TO r23_gateway;
GRANT EXECUTE ON FUNCTION staging.telemetry_insights_report(pg_catalog.int4) TO r23_gateway;

-- ============================================================================
-- Migration 0023 Launch Maturity RPCs (Dossier Sharing, Webhooks, Diagnostics, Nudges)
-- ============================================================================

CREATE OR REPLACE FUNCTION staging.hiring_dossier_share_create(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_session_id pg_catalog.text,
  p_token_hash pg_catalog.text,
  p_payload pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_visibility pg_catalog.text;
  v_include_ai boolean;
  v_include_q boolean;
  v_expires_days pg_catalog.int4;
  v_expires_at pg_catalog.timestamptz;
  v_id pg_catalog.uuid;
  v_created_at pg_catalog.timestamptz;
BEGIN
  IF NOT staging.hiring_can_access_session(p_organization_id, p_caller_principal_id, p_session_id) THEN
    RAISE EXCEPTION 'Session dossier share permission denied' USING ERRCODE = '42501';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid dossier share token hash' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM hirearchy.hiring_decisions
    WHERE organization_id = p_organization_id AND session_id = p_session_id
  ) THEN
    RAISE EXCEPTION 'A published hiring decision is required before sharing a dossier' USING ERRCODE = '22023';
  END IF;

  v_visibility := CASE
    WHEN COALESCE(p_payload ->> 'visibilityMode', 'redacted') = 'named' THEN 'named'
    ELSE 'redacted'
  END;
  v_include_ai := COALESCE((p_payload ->> 'includeAiAdvisory')::boolean, true);
  v_include_q := COALESCE((p_payload ->> 'includeVerificationQuestions')::boolean, true);
  v_expires_days := GREATEST(1, LEAST(90, COALESCE((p_payload ->> 'expiresDays')::pg_catalog.int4, 14)));
  v_created_at := pg_catalog.clock_timestamp();
  v_expires_at := v_created_at + pg_catalog.make_interval(days => v_expires_days);

  INSERT INTO hirearchy.dossier_share_links (
    organization_id, session_id, created_by_principal_id, token_hash,
    visibility_mode, include_ai_advisory, include_verification_questions,
    expires_at, created_at
  ) VALUES (
    p_organization_id, p_session_id, p_caller_principal_id, p_token_hash,
    v_visibility, v_include_ai, v_include_q,
    v_expires_at, v_created_at
  )
  RETURNING id INTO v_id;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_id::pg_catalog.text,
    'visibilityMode', v_visibility,
    'includeAiAdvisory', v_include_ai,
    'includeVerificationQuestions', v_include_q,
    'expiresAt', pg_catalog.to_char(v_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'revokedAt', NULL,
    'viewCount', 0,
    'lastViewedAt', NULL,
    'createdAt', pg_catalog.to_char(v_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_dossier_share_list(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_session_id pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_links pg_catalog.jsonb;
BEGIN
  IF NOT staging.hiring_can_access_session(p_organization_id, p_caller_principal_id, p_session_id) THEN
    RAISE EXCEPTION 'Session dossier list permission denied' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', l.id::pg_catalog.text,
        'visibilityMode', l.visibility_mode,
        'includeAiAdvisory', l.include_ai_advisory,
        'includeVerificationQuestions', l.include_verification_questions,
        'expiresAt', pg_catalog.to_char(l.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'revokedAt', CASE WHEN l.revoked_at IS NULL THEN NULL ELSE pg_catalog.to_char(l.revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
        'viewCount', l.view_count,
        'lastViewedAt', CASE WHEN l.last_viewed_at IS NULL THEN NULL ELSE pg_catalog.to_char(l.last_viewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
        'createdAt', pg_catalog.to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) ORDER BY l.created_at DESC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_links
  FROM hirearchy.dossier_share_links AS l
  WHERE l.organization_id = p_organization_id
    AND l.session_id = p_session_id;

  RETURN pg_catalog.jsonb_build_object('links', v_links);
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_dossier_share_revoke(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_share_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_session_id pg_catalog.text;
BEGIN
  SELECT session_id INTO v_session_id
  FROM hirearchy.dossier_share_links
  WHERE id = p_share_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Share link not found' USING ERRCODE = '22023';
  END IF;

  IF NOT staging.hiring_can_access_session(p_organization_id, p_caller_principal_id, v_session_id) THEN
    RAISE EXCEPTION 'Session dossier revoke permission denied' USING ERRCODE = '42501';
  END IF;

  UPDATE hirearchy.dossier_share_links
  SET revoked_at = COALESCE(revoked_at, pg_catalog.clock_timestamp())
  WHERE id = p_share_id AND organization_id = p_organization_id;

  RETURN pg_catalog.jsonb_build_object('ok', true);
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_dossier_share_resolve(
  p_token_hash pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, pg_temp
AS $function$
DECLARE
  v_link hirearchy.dossier_share_links%ROWTYPE;
  v_dec record;
  v_sess hirearchy.assessment_sessions%ROWTYPE;
  v_meta hirearchy.hiring_session_metadata%ROWTYPE;
  v_cp hirearchy.candidate_profiles%ROWTYPE;
  v_has_cp boolean := false;
  v_org_name pg_catalog.text;
  v_files_changed pg_catalog.int4 := 0;
  v_revision_count pg_catalog.int4 := 0;
  v_exec_passed pg_catalog.int4 := 0;
  v_exec_total pg_catalog.int4 := 0;
  v_ai_count pg_catalog.int4 := 0;
  v_duration_minutes pg_catalog.int4;
  v_display_name pg_catalog.text;
  v_first_name pg_catalog.text;
  v_last_part pg_catalog.text;
  v_parts pg_catalog.text[];
  v_report pg_catalog.jsonb;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_link
  FROM hirearchy.dossier_share_links
  WHERE token_hash = p_token_hash
    AND revoked_at IS NULL
    AND expires_at > pg_catalog.clock_timestamp()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE hirearchy.dossier_share_links
  SET view_count = view_count + 1,
      last_viewed_at = pg_catalog.clock_timestamp()
  WHERE id = v_link.id;

  SELECT COALESCE(NULLIF(trim(display_name), ''), 'Organization')
  INTO v_org_name
  FROM hirearchy.organizations
  WHERE id = v_link.organization_id;

  SELECT d.*,
         COALESCE(NULLIF(trim(dp.display_name), ''), du.email, 'Evaluator') AS decided_by_name
  INTO v_dec
  FROM hirearchy.hiring_decisions AS d
  LEFT JOIN hirearchy.application_principals AS dp ON dp.id = d.decided_by_principal_id
  LEFT JOIN auth.users AS du ON du.id = dp.auth_user_id
  WHERE d.session_id = v_link.session_id
    AND d.organization_id = v_link.organization_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_sess
  FROM hirearchy.assessment_sessions
  WHERE id = v_link.session_id
    AND organization_id = v_link.organization_id;

  SELECT * INTO v_meta
  FROM hirearchy.hiring_session_metadata
  WHERE session_id = v_link.session_id
    AND organization_id = v_link.organization_id;

  IF FOUND THEN
    SELECT * INTO v_cp
    FROM hirearchy.candidate_profiles
    WHERE principal_id = COALESCE(
      v_meta.candidate_principal_id,
      (SELECT cp2.principal_id FROM hirearchy.candidate_profiles AS cp2 WHERE lower(cp2.email) = v_meta.candidate_email LIMIT 1)
    );
    v_has_cp := FOUND;
  END IF;

  SELECT COUNT(DISTINCT file_path)::pg_catalog.int4, COUNT(*)::pg_catalog.int4
  INTO v_files_changed, v_revision_count
  FROM hirearchy.candidate_file_revisions
  WHERE organization_id = v_link.organization_id
    AND session_id = v_link.session_id;

  SELECT
    COUNT(*) FILTER (WHERE status = 'COMPLETED' AND exit_code = 0)::pg_catalog.int4,
    COUNT(*)::pg_catalog.int4
  INTO v_exec_passed, v_exec_total
  FROM hirearchy.candidate_execution_operations
  WHERE organization_id = v_link.organization_id
    AND session_id = v_link.session_id;

  SELECT COUNT(*)::pg_catalog.int4
  INTO v_ai_count
  FROM hirearchy.candidate_ai_interactions
  WHERE organization_id = v_link.organization_id
    AND session_id = v_link.session_id;

  v_duration_minutes := CASE
    WHEN v_sess.activated_at IS NOT NULL AND v_sess.submitted_at IS NOT NULL AND v_sess.submitted_at >= v_sess.activated_at
      THEN GREATEST(1, ROUND(EXTRACT(EPOCH FROM (v_sess.submitted_at - v_sess.activated_at)) / 60.0)::pg_catalog.int4)
    ELSE NULL
  END;

  IF v_link.visibility_mode = 'named' THEN
    v_display_name := CASE
      WHEN v_has_cp AND NULLIF(trim(v_cp.full_name), '') IS NOT NULL THEN trim(v_cp.full_name)
      WHEN v_has_cp AND v_cp.candidate_code IS NOT NULL THEN 'Candidate ' || v_cp.candidate_code
      ELSE 'Candidate'
    END;
  ELSE
    IF v_has_cp AND NULLIF(trim(v_cp.full_name), '') IS NOT NULL THEN
      v_parts := pg_catalog.regexp_split_to_array(trim(v_cp.full_name), '\s+');
      v_first_name := COALESCE(v_parts[1], 'Candidate');
      IF pg_catalog.array_length(v_parts, 1) >= 2 THEN
        v_last_part := pg_catalog.left(v_parts[pg_catalog.array_length(v_parts, 1)], 1) || '.';
        v_display_name := v_first_name || ' ' || v_last_part;
      ELSE
        v_display_name := v_first_name;
      END IF;
    ELSIF v_has_cp AND v_cp.candidate_code IS NOT NULL THEN
      v_display_name := 'Candidate ' || v_cp.candidate_code;
    ELSE
      v_display_name := 'Redacted Candidate';
    END IF;
  END IF;

  IF NOT v_link.include_ai_advisory OR v_dec.performance_report IS NULL THEN
    v_report := NULL;
  ELSIF NOT v_link.include_verification_questions THEN
    v_report := v_dec.performance_report || pg_catalog.jsonb_build_object('suggestedNextInterviewQuestions', '[]'::pg_catalog.jsonb);
  ELSE
    v_report := v_dec.performance_report;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'shareId', v_link.id::pg_catalog.text,
    'visibilityMode', v_link.visibility_mode,
    'includeAiAdvisory', v_link.include_ai_advisory,
    'includeVerificationQuestions', v_link.include_verification_questions,
    'expiresAt', pg_catalog.to_char(v_link.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'viewCount', v_link.view_count + 1,
    'createdAt', pg_catalog.to_char(v_link.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'organizationName', v_org_name,
    'sessionId', v_link.session_id,
    'scenarioTitle', COALESCE(v_sess.scenario_title, 'Engineering Assessment'),
    'targetRole', COALESCE(v_meta.target_role, ''),
    'experienceLevel', COALESCE(v_meta.experience_level, 'mid'),
    'skills', COALESCE(v_meta.skills, '[]'::pg_catalog.jsonb),
    'submittedAt', CASE WHEN v_sess.submitted_at IS NULL THEN NULL ELSE pg_catalog.to_char(v_sess.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
    'candidate', pg_catalog.jsonb_build_object(
      'candidateCode', CASE WHEN v_has_cp THEN v_cp.candidate_code ELSE NULL END,
      'displayName', v_display_name,
      'headlineRole', CASE WHEN v_link.visibility_mode = 'named' AND v_has_cp THEN NULLIF(trim(v_cp.headline_role), '') ELSE NULL END,
      'locationCity', CASE WHEN v_link.visibility_mode = 'named' AND v_has_cp THEN NULLIF(trim(v_cp.location_city), '') ELSE NULL END,
      'locationCountry', CASE WHEN v_link.visibility_mode = 'named' AND v_has_cp THEN NULLIF(trim(v_cp.location_country), '') ELSE NULL END
    ),
    'decision', pg_catalog.jsonb_build_object(
      'decision', v_dec.decision,
      'decidedByName', v_dec.decided_by_name,
      'nextStageLabel', v_dec.next_stage_label,
      'publishedAt', pg_catalog.to_char(v_dec.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'candidateStrengths', v_dec.candidate_strengths,
      'candidateWeaknesses', v_dec.candidate_weaknesses,
      'candidateFeedbackNote', v_dec.candidate_feedback_note
    ),
    'evidenceSummary', pg_catalog.jsonb_build_object(
      'durationMinutes', v_duration_minutes,
      'filesChanged', v_files_changed,
      'revisionCount', v_revision_count,
      'executionRunsPassed', v_exec_passed,
      'executionRunsTotal', v_exec_total,
      'aiInteractionsCount', v_ai_count
    ),
    'performanceReport', v_report
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_webhook_list(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_owner_id pg_catalog.uuid;
  v_role pg_catalog.text;
  v_webhooks pg_catalog.jsonb;
  v_deliveries pg_catalog.jsonb;
BEGIN
  SELECT owner_principal_id INTO v_owner_id
  FROM hirearchy.organizations WHERE id = p_organization_id;

  SELECT role INTO v_role
  FROM hirearchy.organization_memberships
  WHERE organization_id = p_organization_id
    AND principal_id = p_caller_principal_id
    AND status = 'active'
    AND revoked_at IS NULL;

  IF NOT FOUND OR (v_owner_id IS DISTINCT FROM p_caller_principal_id AND v_role <> 'cto') THEN
    RAISE EXCEPTION 'Webhook management requires CTO or owner permission' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', w.id::pg_catalog.text,
        'label', w.label,
        'targetUrl', w.target_url,
        'payloadMode', w.payload_mode,
        'eventTypes', w.event_types,
        'signingSecretPrefix', w.signing_secret_prefix,
        'isActive', w.is_active,
        'consecutiveFailures', w.consecutive_failures,
        'disabledReason', w.disabled_reason,
        'lastDeliveredAt', CASE WHEN w.last_delivered_at IS NULL THEN NULL ELSE pg_catalog.to_char(w.last_delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
        'createdAt', pg_catalog.to_char(w.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) ORDER BY w.created_at DESC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_webhooks
  FROM hirearchy.organization_webhooks AS w
  WHERE w.organization_id = p_organization_id;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      d_obj ORDER BY d_created DESC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_deliveries
  FROM (
    SELECT d.created_at AS d_created,
      pg_catalog.jsonb_build_object(
        'id', d.id::pg_catalog.text,
        'webhookId', d.webhook_id::pg_catalog.text,
        'eventType', d.event_type,
        'status', d.status,
        'httpStatus', d.http_status,
        'latencyMs', d.latency_ms,
        'errorSummary', d.error_summary,
        'createdAt', pg_catalog.to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) AS d_obj
    FROM hirearchy.webhook_deliveries AS d
    WHERE d.organization_id = p_organization_id
    ORDER BY d.created_at DESC
    LIMIT 25
  ) AS recent_del;

  RETURN pg_catalog.jsonb_build_object(
    'webhooks', v_webhooks,
    'deliveries', v_deliveries
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_webhook_upsert(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_payload pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_owner_id pg_catalog.uuid;
  v_role pg_catalog.text;
  v_webhook_id pg_catalog.uuid;
  v_label pg_catalog.text;
  v_target_url pg_catalog.text;
  v_payload_mode pg_catalog.text;
  v_event_types pg_catalog.jsonb;
  v_ciphertext pg_catalog.text;
  v_prefix pg_catalog.text;
  v_is_active boolean;
  v_count pg_catalog.int4;
  v_row hirearchy.organization_webhooks%ROWTYPE;
BEGIN
  SELECT owner_principal_id INTO v_owner_id
  FROM hirearchy.organizations WHERE id = p_organization_id;

  SELECT role INTO v_role
  FROM hirearchy.organization_memberships
  WHERE organization_id = p_organization_id
    AND principal_id = p_caller_principal_id
    AND status = 'active'
    AND revoked_at IS NULL;

  IF NOT FOUND OR (v_owner_id IS DISTINCT FROM p_caller_principal_id AND v_role <> 'cto') THEN
    RAISE EXCEPTION 'Webhook management requires CTO or owner permission' USING ERRCODE = '42501';
  END IF;

  v_webhook_id := NULLIF(trim(COALESCE(p_payload ->> 'webhookId', '')), '')::pg_catalog.uuid;
  v_label := NULLIF(left(trim(COALESCE(p_payload ->> 'label', '')), 80), '');
  v_target_url := NULLIF(trim(COALESCE(p_payload ->> 'targetUrl', '')), '');
  v_payload_mode := COALESCE(NULLIF(trim(p_payload ->> 'payloadMode'), ''), 'json');
  v_ciphertext := NULLIF(trim(COALESCE(p_payload ->> 'signingSecretCiphertext', '')), '');
  v_prefix := NULLIF(left(trim(COALESCE(p_payload ->> 'signingSecretPrefix', '')), 16), '');
  v_event_types := CASE
    WHEN pg_catalog.jsonb_typeof(p_payload -> 'eventTypes') = 'array' THEN p_payload -> 'eventTypes'
    ELSE NULL
  END;

  IF v_webhook_id IS NULL THEN
    SELECT COUNT(*)::pg_catalog.int4 INTO v_count
    FROM hirearchy.organization_webhooks
    WHERE organization_id = p_organization_id;

    IF v_count >= 10 THEN
      RAISE EXCEPTION 'Maximum of 10 webhook endpoints per organization reached' USING ERRCODE = '22023';
    END IF;

    IF v_label IS NULL OR v_target_url IS NULL OR v_target_url !~ '^https?://' OR length(v_target_url) < 12 OR length(v_target_url) > 500 THEN
      RAISE EXCEPTION 'Valid label and target URL are required' USING ERRCODE = '22023';
    END IF;

    IF v_payload_mode NOT IN ('json', 'slack_block_kit') THEN
      RAISE EXCEPTION 'Invalid webhook payload mode' USING ERRCODE = '22023';
    END IF;

    IF v_ciphertext IS NULL OR v_prefix IS NULL THEN
      RAISE EXCEPTION 'Webhook signing secret material is required' USING ERRCODE = '22023';
    END IF;

    INSERT INTO hirearchy.organization_webhooks (
      organization_id, created_by_principal_id, label, target_url,
      payload_mode, event_types, signing_secret_ciphertext, signing_secret_prefix,
      is_active
    ) VALUES (
      p_organization_id,
      p_caller_principal_id,
      v_label,
      v_target_url,
      v_payload_mode,
      COALESCE(v_event_types, '["candidate.started","candidate.submitted","verdict.published","handoff.updated"]'::pg_catalog.jsonb),
      v_ciphertext,
      v_prefix,
      COALESCE((p_payload ->> 'isActive')::boolean, true)
    )
    RETURNING * INTO v_row;
  ELSE
    SELECT * INTO v_row
    FROM hirearchy.organization_webhooks
    WHERE id = v_webhook_id AND organization_id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Webhook not found' USING ERRCODE = '22023';
    END IF;

    IF v_target_url IS NOT NULL AND (v_target_url !~ '^https?://' OR length(v_target_url) < 12 OR length(v_target_url) > 500) THEN
      RAISE EXCEPTION 'Invalid webhook target URL' USING ERRCODE = '22023';
    END IF;

    IF p_payload ? 'payloadMode' AND v_payload_mode NOT IN ('json', 'slack_block_kit') THEN
      RAISE EXCEPTION 'Invalid webhook payload mode' USING ERRCODE = '22023';
    END IF;

    v_is_active := COALESCE((p_payload ->> 'isActive')::boolean, v_row.is_active);

    UPDATE hirearchy.organization_webhooks
    SET label = COALESCE(v_label, label),
        target_url = COALESCE(v_target_url, target_url),
        payload_mode = CASE WHEN p_payload ? 'payloadMode' THEN v_payload_mode ELSE payload_mode END,
        event_types = COALESCE(v_event_types, event_types),
        signing_secret_ciphertext = COALESCE(v_ciphertext, signing_secret_ciphertext),
        signing_secret_prefix = COALESCE(v_prefix, signing_secret_prefix),
        is_active = v_is_active,
        consecutive_failures = CASE WHEN v_is_active AND NOT v_row.is_active THEN 0 ELSE consecutive_failures END,
        disabled_reason = CASE WHEN v_is_active THEN '' ELSE disabled_reason END,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_webhook_id AND organization_id = p_organization_id
    RETURNING * INTO v_row;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'webhook', pg_catalog.jsonb_build_object(
      'id', v_row.id::pg_catalog.text,
      'label', v_row.label,
      'targetUrl', v_row.target_url,
      'payloadMode', v_row.payload_mode,
      'eventTypes', v_row.event_types,
      'signingSecretPrefix', v_row.signing_secret_prefix,
      'isActive', v_row.is_active,
      'consecutiveFailures', v_row.consecutive_failures,
      'disabledReason', v_row.disabled_reason,
      'lastDeliveredAt', CASE WHEN v_row.last_delivered_at IS NULL THEN NULL ELSE pg_catalog.to_char(v_row.last_delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
      'createdAt', pg_catalog.to_char(v_row.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    )
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_webhook_delete(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_webhook_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_owner_id pg_catalog.uuid;
  v_role pg_catalog.text;
BEGIN
  SELECT owner_principal_id INTO v_owner_id
  FROM hirearchy.organizations WHERE id = p_organization_id;

  SELECT role INTO v_role
  FROM hirearchy.organization_memberships
  WHERE organization_id = p_organization_id
    AND principal_id = p_caller_principal_id
    AND status = 'active'
    AND revoked_at IS NULL;

  IF NOT FOUND OR (v_owner_id IS DISTINCT FROM p_caller_principal_id AND v_role <> 'cto') THEN
    RAISE EXCEPTION 'Webhook management requires CTO or owner permission' USING ERRCODE = '42501';
  END IF;

  DELETE FROM hirearchy.organization_webhooks
  WHERE id = p_webhook_id AND organization_id = p_organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Webhook not found' USING ERRCODE = '22023';
  END IF;

  RETURN pg_catalog.jsonb_build_object('ok', true);
END
$function$;

CREATE OR REPLACE FUNCTION staging.webhook_enqueue_session_event(
  p_session_id pg_catalog.text,
  p_event_type pg_catalog.text,
  p_payload pg_catalog.jsonb DEFAULT '{}'::pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, pg_temp
AS $function$
DECLARE
  v_sess record;
  v_wh record;
  v_event_id pg_catalog.uuid;
  v_del_id pg_catalog.uuid;
  v_envelope pg_catalog.jsonb;
  v_out pg_catalog.jsonb := '[]'::pg_catalog.jsonb;
BEGIN
  IF p_event_type NOT IN ('candidate.started', 'candidate.submitted', 'verdict.published', 'handoff.updated') THEN
    RAISE EXCEPTION 'Invalid webhook event type' USING ERRCODE = '22023';
  END IF;

  SELECT
    s.id,
    s.organization_id,
    s.scenario_title,
    s.status AS lifecycle_status,
    COALESCE(NULLIF(trim(o.display_name), ''), 'Organization') AS org_name,
    COALESCE(m.target_role, '') AS target_role,
    COALESCE(m.experience_level, 'mid') AS experience_level,
    d.decision,
    d.next_stage_label,
    d.handoff_status
  INTO v_sess
  FROM hirearchy.assessment_sessions AS s
  JOIN hirearchy.organizations AS o ON o.id = s.organization_id
  LEFT JOIN hirearchy.hiring_session_metadata AS m ON m.session_id = s.id
  LEFT JOIN hirearchy.hiring_decisions AS d ON d.session_id = s.id
  WHERE s.id = p_session_id;

  IF NOT FOUND THEN
    RETURN '[]'::pg_catalog.jsonb;
  END IF;

  FOR v_wh IN
    SELECT *
    FROM hirearchy.organization_webhooks
    WHERE organization_id = v_sess.organization_id
      AND is_active = true
      AND event_types ? p_event_type
    ORDER BY created_at ASC
  LOOP
    v_event_id := pg_catalog.gen_random_uuid();
    v_envelope := pg_catalog.jsonb_build_object(
      'eventId', v_event_id::pg_catalog.text,
      'eventType', p_event_type,
      'occurredAt', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'organizationId', v_sess.organization_id::pg_catalog.text,
      'organizationName', v_sess.org_name,
      'sessionId', v_sess.id,
      'scenarioTitle', v_sess.scenario_title,
      'targetRole', v_sess.target_role,
      'experienceLevel', v_sess.experience_level,
      'lifecycleStatus', v_sess.lifecycle_status,
      'decision', v_sess.decision,
      'nextStageLabel', v_sess.next_stage_label,
      'handoffStatus', v_sess.handoff_status
    ) || COALESCE(p_payload, '{}'::pg_catalog.jsonb);

    INSERT INTO hirearchy.webhook_deliveries (
      webhook_id, organization_id, event_id, event_type, session_id,
      status, attempt_count, request_payload
    ) VALUES (
      v_wh.id, v_sess.organization_id, v_event_id, p_event_type, v_sess.id,
      'pending', 0, v_envelope
    )
    RETURNING id INTO v_del_id;

    v_out := v_out || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'deliveryId', v_del_id::pg_catalog.text,
        'webhookId', v_wh.id::pg_catalog.text,
        'organizationId', v_sess.organization_id::pg_catalog.text,
        'targetUrl', v_wh.target_url,
        'payloadMode', v_wh.payload_mode,
        'signingSecretCiphertext', v_wh.signing_secret_ciphertext,
        'eventId', v_event_id::pg_catalog.text,
        'eventType', p_event_type,
        'sessionId', v_sess.id,
        'payload', v_envelope
      )
    );
  END LOOP;

  RETURN v_out;
END
$function$;

CREATE OR REPLACE FUNCTION staging.webhook_enqueue_ping(
  p_organization_id pg_catalog.uuid,
  p_webhook_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, pg_temp
AS $function$
DECLARE
  v_wh hirearchy.organization_webhooks%ROWTYPE;
  v_org_name pg_catalog.text;
  v_event_id pg_catalog.uuid;
  v_del_id pg_catalog.uuid;
  v_envelope pg_catalog.jsonb;
BEGIN
  SELECT * INTO v_wh
  FROM hirearchy.organization_webhooks
  WHERE id = p_webhook_id AND organization_id = p_organization_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(NULLIF(trim(display_name), ''), 'Organization')
  INTO v_org_name
  FROM hirearchy.organizations
  WHERE id = p_organization_id;

  v_event_id := pg_catalog.gen_random_uuid();
  v_envelope := pg_catalog.jsonb_build_object(
    'eventId', v_event_id::pg_catalog.text,
    'eventType', 'webhook.ping',
    'occurredAt', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'organizationId', p_organization_id::pg_catalog.text,
    'organizationName', COALESCE(v_org_name, 'Organization'),
    'webhookLabel', v_wh.label
  );

  INSERT INTO hirearchy.webhook_deliveries (
    webhook_id, organization_id, event_id, event_type, session_id,
    status, attempt_count, request_payload
  ) VALUES (
    v_wh.id, p_organization_id, v_event_id, 'webhook.ping', NULL,
    'pending', 0, v_envelope
  )
  RETURNING id INTO v_del_id;

  RETURN pg_catalog.jsonb_build_object(
    'deliveryId', v_del_id::pg_catalog.text,
    'webhookId', v_wh.id::pg_catalog.text,
    'organizationId', p_organization_id::pg_catalog.text,
    'targetUrl', v_wh.target_url,
    'payloadMode', v_wh.payload_mode,
    'signingSecretCiphertext', v_wh.signing_secret_ciphertext,
    'eventId', v_event_id::pg_catalog.text,
    'eventType', 'webhook.ping',
    'sessionId', NULL,
    'payload', v_envelope
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.webhook_mark_delivery(
  p_delivery_id pg_catalog.uuid,
  p_status pg_catalog.text,
  p_http_status pg_catalog.int4,
  p_latency_ms pg_catalog.int4,
  p_error_summary pg_catalog.text,
  p_next_attempt_at pg_catalog.timestamptz DEFAULT NULL
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, pg_temp
AS $function$
DECLARE
  v_del hirearchy.webhook_deliveries%ROWTYPE;
  v_safe_err pg_catalog.text := left(COALESCE(p_error_summary, ''), 400);
BEGIN
  IF p_status NOT IN ('pending', 'delivered', 'failed', 'blocked_ssrf') THEN
    RAISE EXCEPTION 'Invalid delivery status' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_del
  FROM hirearchy.webhook_deliveries
  WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('ok', false);
  END IF;

  UPDATE hirearchy.webhook_deliveries
  SET status = p_status,
      attempt_count = attempt_count + 1,
      http_status = p_http_status,
      latency_ms = CASE WHEN p_latency_ms IS NULL THEN NULL ELSE GREATEST(0, p_latency_ms) END,
      error_summary = v_safe_err,
      next_attempt_at = COALESCE(p_next_attempt_at, next_attempt_at),
      delivered_at = CASE WHEN p_status = 'delivered' THEN pg_catalog.clock_timestamp() ELSE delivered_at END
  WHERE id = p_delivery_id;

  IF p_status = 'delivered' THEN
    UPDATE hirearchy.organization_webhooks
    SET consecutive_failures = 0,
        disabled_reason = '',
        last_delivered_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_del.webhook_id;
  ELSIF p_status IN ('failed', 'blocked_ssrf') AND p_next_attempt_at IS NULL THEN
    UPDATE hirearchy.organization_webhooks
    SET consecutive_failures = consecutive_failures + 1,
        is_active = CASE WHEN consecutive_failures + 1 >= 10 THEN false ELSE is_active END,
        disabled_reason = CASE
          WHEN consecutive_failures + 1 >= 10 THEN COALESCE(NULLIF(v_safe_err, ''), 'Disabled after 10 consecutive delivery failures')
          ELSE disabled_reason
        END,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_del.webhook_id;
  END IF;

  RETURN pg_catalog.jsonb_build_object('ok', true);
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_org_problem_health(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_problems pg_catalog.jsonb;
  v_benchmarks pg_catalog.jsonb;
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

  WITH session_rows AS (
    SELECT
      m.definition_id,
      s.id AS session_id,
      s.activated_at,
      s.submitted_at,
      COALESCE(op_stats.total_ops, 0) AS total_ops,
      COALESCE(op_stats.err_ops, 0) AS err_ops,
      fb.avg_rating
    FROM hirearchy.hiring_session_metadata AS m
    JOIN hirearchy.assessment_sessions AS s ON s.id = m.session_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS total_ops,
        COUNT(*) FILTER (WHERE eo.status IN ('FAILED', 'TIMED_OUT', 'UNKNOWN')) AS err_ops
      FROM hirearchy.candidate_execution_operations AS eo
      WHERE eo.session_id = s.id
    ) AS op_stats ON true
    LEFT JOIN LATERAL (
      SELECT AVG(f.rating)::numeric AS avg_rating
      FROM hirearchy.product_feedback AS f
      WHERE f.session_id = s.id AND f.actor_type = 'candidate'
    ) AS fb ON true
    WHERE m.organization_id = p_organization_id
      AND m.definition_id IS NOT NULL
  ),
  agg AS (
    SELECT
      lib.definition_id,
      d.title,
      lib.source_kind,
      COALESCE(NULLIF(trim(lib.target_role), ''), 'General') AS target_role,
      lib.experience_level,
      d.duration_minutes,
      COUNT(sr.session_id)::pg_catalog.int4 AS issued,
      COUNT(sr.session_id) FILTER (WHERE sr.activated_at IS NOT NULL)::pg_catalog.int4 AS started,
      COUNT(sr.session_id) FILTER (WHERE sr.submitted_at IS NOT NULL)::pg_catalog.int4 AS submitted,
      COALESCE(ROUND((COUNT(sr.session_id) FILTER (WHERE sr.submitted_at IS NOT NULL) * 100.0) / NULLIF(COUNT(sr.session_id) FILTER (WHERE sr.activated_at IS NOT NULL), 0), 1), 0) AS completion_pct,
      ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY CASE WHEN sr.submitted_at IS NOT NULL AND sr.activated_at IS NOT NULL AND sr.submitted_at >= sr.activated_at THEN EXTRACT(EPOCH FROM (sr.submitted_at - sr.activated_at)) / 60.0 ELSE NULL END))::numeric, 1) AS median_minutes,
      COALESCE(ROUND((SUM(sr.err_ops) * 100.0) / NULLIF(SUM(sr.total_ops), 0), 1), 0) AS err_pct,
      ROUND(AVG(sr.avg_rating)::numeric, 2) AS avg_rating
    FROM hirearchy.assessment_library_entries AS lib
    JOIN hirearchy.assessment_definitions AS def ON def.id = lib.definition_id
    JOIN hirearchy.assessment_drafts AS d
      ON d.definition_id = def.id
     AND d.organization_id = def.organization_id
     AND d.version = def.draft_version
    LEFT JOIN session_rows AS sr ON sr.definition_id = lib.definition_id
    WHERE lib.organization_id = p_organization_id
    GROUP BY lib.definition_id, d.title, lib.source_kind, lib.target_role, lib.experience_level, d.duration_minutes, lib.updated_at
    ORDER BY lib.updated_at DESC
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'definitionId', a.definition_id::pg_catalog.text,
        'title', a.title,
        'sourceKind', a.source_kind,
        'targetRole', a.target_role,
        'experienceLevel', a.experience_level,
        'durationMinutes', a.duration_minutes,
        'issued', a.issued,
        'started', a.started,
        'submitted', a.submitted,
        'completionRatePct', a.completion_pct,
        'medianMinutes', a.median_minutes,
        'executionErrorRatePct', a.err_pct,
        'avgCandidateRating', a.avg_rating,
        'healthFlag', flag,
        'diagnosticHint', CASE flag
          WHEN 'low_sample' THEN 'Collect at least 3 started candidate sessions to calibrate completion and timing.'
          WHEN 'runner_errors' THEN ROUND(a.err_pct, 0)::pg_catalog.text || '% of sandbox runs failed — inspect starter tests or recipe setup.'
          WHEN 'high_dropoff' THEN 'Completion is ' || ROUND(a.completion_pct, 0)::pg_catalog.text || '% — review brief clarity or trim scope.'
          WHEN 'time_pressure' THEN 'Median solve (' || COALESCE(ROUND(a.median_minutes, 0)::pg_catalog.text, '—') || 'm) is near the ' || a.duration_minutes::pg_catalog.text || 'm cap — consider extending duration.'
          ELSE 'Healthy calibration across completion, timing, and execution stability.'
        END
      )
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_problems
  FROM (
    SELECT agg.*,
      CASE
        WHEN agg.started < 3 THEN 'low_sample'
        WHEN agg.err_pct >= 35 THEN 'runner_errors'
        WHEN agg.completion_pct < 55 THEN 'high_dropoff'
        WHEN COALESCE(agg.median_minutes, 0) >= agg.duration_minutes * 0.9 THEN 'time_pressure'
        ELSE 'healthy'
      END AS flag
    FROM agg
  ) AS a;

  WITH org_buckets AS (
    SELECT DISTINCT
      COALESCE(NULLIF(trim(target_role), ''), 'General') AS target_role,
      experience_level
    FROM (
      SELECT target_role, experience_level
      FROM hirearchy.assessment_library_entries
      WHERE organization_id = p_organization_id
      UNION ALL
      SELECT target_role, experience_level
      FROM hirearchy.hiring_session_metadata
      WHERE organization_id = p_organization_id
    ) AS raw_b
    WHERE COALESCE(NULLIF(trim(target_role), ''), '') <> ''
  ),
  org_stats AS (
    SELECT
      COALESCE(NULLIF(trim(m.target_role), ''), 'General') AS target_role,
      m.experience_level,
      ROUND((COUNT(*) FILTER (WHERE s.submitted_at IS NOT NULL) * 100.0) / NULLIF(COUNT(*) FILTER (WHERE s.activated_at IS NOT NULL), 0), 1) AS org_completion_pct,
      ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY CASE WHEN s.submitted_at IS NOT NULL AND s.activated_at IS NOT NULL AND s.submitted_at >= s.activated_at THEN EXTRACT(EPOCH FROM (s.submitted_at - s.activated_at)) / 60.0 ELSE NULL END))::numeric, 1) AS org_median_minutes
    FROM hirearchy.hiring_session_metadata AS m
    JOIN hirearchy.assessment_sessions AS s ON s.id = m.session_id
    WHERE m.organization_id = p_organization_id
    GROUP BY COALESCE(NULLIF(trim(m.target_role), ''), 'General'), m.experience_level
  ),
  plat_role_level AS (
    SELECT
      COALESCE(NULLIF(trim(m.target_role), ''), 'General') AS target_role,
      m.experience_level,
      COUNT(DISTINCT s.organization_id)::pg_catalog.int4 AS org_cnt,
      COUNT(*) FILTER (WHERE s.activated_at IS NOT NULL)::pg_catalog.int4 AS started_cnt,
      ROUND((COUNT(*) FILTER (WHERE s.submitted_at IS NOT NULL) * 100.0) / NULLIF(COUNT(*) FILTER (WHERE s.activated_at IS NOT NULL), 0), 1) AS completion_pct,
      ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY CASE WHEN s.submitted_at IS NOT NULL AND s.activated_at IS NOT NULL AND s.submitted_at >= s.activated_at THEN EXTRACT(EPOCH FROM (s.submitted_at - s.activated_at)) / 60.0 ELSE NULL END))::numeric, 1) AS median_minutes,
      ROUND((COUNT(*) FILTER (WHERE dec.decision = 'accepted') * 100.0) / NULLIF(COUNT(dec.session_id), 0), 1) AS acceptance_pct
    FROM hirearchy.hiring_session_metadata AS m
    JOIN hirearchy.assessment_sessions AS s ON s.id = m.session_id
    LEFT JOIN hirearchy.hiring_decisions AS dec ON dec.session_id = s.id
    GROUP BY COALESCE(NULLIF(trim(m.target_role), ''), 'General'), m.experience_level
    HAVING COUNT(DISTINCT s.organization_id) >= 5 AND COUNT(*) FILTER (WHERE s.activated_at IS NOT NULL) >= 15
  ),
  plat_role AS (
    SELECT
      COALESCE(NULLIF(trim(m.target_role), ''), 'General') AS target_role,
      COUNT(DISTINCT s.organization_id)::pg_catalog.int4 AS org_cnt,
      COUNT(*) FILTER (WHERE s.activated_at IS NOT NULL)::pg_catalog.int4 AS started_cnt,
      ROUND((COUNT(*) FILTER (WHERE s.submitted_at IS NOT NULL) * 100.0) / NULLIF(COUNT(*) FILTER (WHERE s.activated_at IS NOT NULL), 0), 1) AS completion_pct,
      ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY CASE WHEN s.submitted_at IS NOT NULL AND s.activated_at IS NOT NULL AND s.submitted_at >= s.activated_at THEN EXTRACT(EPOCH FROM (s.submitted_at - s.activated_at)) / 60.0 ELSE NULL END))::numeric, 1) AS median_minutes,
      ROUND((COUNT(*) FILTER (WHERE dec.decision = 'accepted') * 100.0) / NULLIF(COUNT(dec.session_id), 0), 1) AS acceptance_pct
    FROM hirearchy.hiring_session_metadata AS m
    JOIN hirearchy.assessment_sessions AS s ON s.id = m.session_id
    LEFT JOIN hirearchy.hiring_decisions AS dec ON dec.session_id = s.id
    GROUP BY COALESCE(NULLIF(trim(m.target_role), ''), 'General')
    HAVING COUNT(DISTINCT s.organization_id) >= 5 AND COUNT(*) FILTER (WHERE s.activated_at IS NOT NULL) >= 15
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'targetRole', ob.target_role,
        'experienceLevel', ob.experience_level,
        'benchmarkScope', CASE WHEN prl.target_role IS NOT NULL THEN 'role_level' ELSE 'role' END,
        'orgCompletionRatePct', os.org_completion_pct,
        'orgMedianMinutes', os.org_median_minutes,
        'platformMedianCompletionRatePct', COALESCE(prl.completion_pct, pr.completion_pct),
        'platformMedianMinutes', COALESCE(prl.median_minutes, pr.median_minutes),
        'platformAcceptanceRatePct', COALESCE(prl.acceptance_pct, pr.acceptance_pct),
        'sampleSessions', COALESCE(prl.started_cnt, pr.started_cnt, 0)
      ) ORDER BY ob.target_role ASC, ob.experience_level ASC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_benchmarks
  FROM org_buckets AS ob
  LEFT JOIN org_stats AS os
    ON os.target_role = ob.target_role AND os.experience_level = ob.experience_level
  LEFT JOIN plat_role_level AS prl
    ON prl.target_role = ob.target_role AND prl.experience_level = ob.experience_level
  LEFT JOIN plat_role AS pr
    ON pr.target_role = ob.target_role;

  RETURN pg_catalog.jsonb_build_object(
    'problems', v_problems,
    'benchmarks', v_benchmarks
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_org_nudges_get(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_org_id_text pg_catalog.text := p_organization_id::pg_catalog.text;
  v_unreviewed_cnt pg_catalog.int4 := 0;
  v_plan_tier pg_catalog.text := 'none';
  v_credits_purchased pg_catalog.int4 := 0;
  v_credits_used pg_catalog.int4 := 0;
  v_gate_hits pg_catalog.int4 := 0;
  v_first_joined pg_catalog.timestamptz;
  v_session_cnt pg_catalog.int4 := 0;
  v_webhook_cnt pg_catalog.int4 := 0;
  v_health_alerts pg_catalog.int4 := 0;
  v_first_alert_def pg_catalog.text := '';
  v_nudges pg_catalog.jsonb;
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

  SELECT MIN(joined_at) INTO v_first_joined
  FROM hirearchy.organization_memberships
  WHERE organization_id = p_organization_id;

  SELECT COUNT(*)::pg_catalog.int4 INTO v_session_cnt
  FROM hirearchy.assessment_sessions
  WHERE organization_id = p_organization_id;

  SELECT COUNT(*)::pg_catalog.int4 INTO v_unreviewed_cnt
  FROM hirearchy.assessment_sessions AS s
  WHERE s.organization_id = p_organization_id
    AND s.status = 'SUBMITTED'
    AND s.submitted_at <= pg_catalog.clock_timestamp() - INTERVAL '48 hours'
    AND NOT EXISTS (
      SELECT 1 FROM hirearchy.hiring_decisions AS d
      WHERE d.session_id = s.id
    );

  SELECT COALESCE(plan_tier, 'none'), COALESCE(candidate_credits_purchased, 0)
  INTO v_plan_tier, v_credits_purchased
  FROM hirearchy.organization_plans
  WHERE organization_id = p_organization_id;

  SELECT COUNT(*)::pg_catalog.int4 INTO v_credits_used
  FROM hirearchy.organization_candidate_credits
  WHERE organization_id = p_organization_id;

  SELECT COUNT(*)::pg_catalog.int4 INTO v_gate_hits
  FROM hirearchy.product_events
  WHERE organization_id = p_organization_id
    AND event_name = 'monetization.plan_gate_hit'
    AND occurred_at >= pg_catalog.clock_timestamp() - INTERVAL '14 days'
    AND NOT EXISTS (
      SELECT 1 FROM hirearchy.product_events AS pe2
      WHERE pe2.organization_id = p_organization_id
        AND pe2.event_name IN ('monetization.plan_changed', 'monetization.slots_added')
        AND pe2.occurred_at >= product_events.occurred_at
    );

  SELECT COUNT(*)::pg_catalog.int4 INTO v_webhook_cnt
  FROM hirearchy.organization_webhooks
  WHERE organization_id = p_organization_id;

  WITH problem_stats AS (
    SELECT
      m.definition_id::pg_catalog.text AS def_id,
      COUNT(*) FILTER (WHERE s.activated_at IS NOT NULL) AS started_cnt,
      COALESCE((COUNT(*) FILTER (WHERE s.submitted_at IS NOT NULL) * 100.0) / NULLIF(COUNT(*) FILTER (WHERE s.activated_at IS NOT NULL), 0), 0) AS comp_pct,
      COALESCE((SUM(op_stats.err_ops) * 100.0) / NULLIF(SUM(op_stats.total_ops), 0), 0) AS err_pct
    FROM hirearchy.hiring_session_metadata AS m
    JOIN hirearchy.assessment_sessions AS s ON s.id = m.session_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS total_ops,
        COUNT(*) FILTER (WHERE eo.status IN ('FAILED', 'TIMED_OUT', 'UNKNOWN')) AS err_ops
      FROM hirearchy.candidate_execution_operations AS eo
      WHERE eo.session_id = s.id
    ) AS op_stats ON true
    WHERE m.organization_id = p_organization_id AND m.definition_id IS NOT NULL
    GROUP BY m.definition_id
    HAVING COUNT(*) FILTER (WHERE s.activated_at IS NOT NULL) >= 3
       AND (
         COALESCE((SUM(op_stats.err_ops) * 100.0) / NULLIF(SUM(op_stats.total_ops), 0), 0) >= 35
         OR COALESCE((COUNT(*) FILTER (WHERE s.submitted_at IS NOT NULL) * 100.0) / NULLIF(COUNT(*) FILTER (WHERE s.activated_at IS NOT NULL), 0), 0) < 55
       )
  )
  SELECT COUNT(*)::pg_catalog.int4, COALESCE(MIN(def_id), '')
  INTO v_health_alerts, v_first_alert_def
  FROM problem_stats;

  WITH candidates AS (
    SELECT
      'unreviewed_submission_48h'::pg_catalog.text AS nudge_key,
      ''::pg_catalog.text AS target_ref,
      1 AS priority,
      v_unreviewed_cnt || ' submitted ' || CASE WHEN v_unreviewed_cnt = 1 THEN 'candidate has' ELSE 'candidates have' END || ' waited over 48 hours' AS title,
      'Fast human feedback lifts candidate fairness scores and protects conversion.' AS detail,
      'Review ready submissions' AS cta_label,
      '/r23/organizations/' || v_org_id_text || '/candidates?status=awaiting_review' AS cta_href,
      v_unreviewed_cnt AS cnt
    WHERE v_unreviewed_cnt >= 1

    UNION ALL

    SELECT
      'plan_gate_no_upgrade'::pg_catalog.text,
      ''::pg_catalog.text,
      2,
      CASE
        WHEN v_plan_tier = 'per_candidate' AND (v_credits_purchased - v_credits_used) <= 1
          THEN 'Only ' || GREATEST(0, v_credits_purchased - v_credits_used)::pg_catalog.text || ' candidate slot remaining'
        ELSE 'Team members hit a plan limit recently'
      END,
      'Review Per Candidate slots, Pro, or Ultra so assessment invitations are not blocked.',
      'Review plan options',
      '/r23/organizations/' || v_org_id_text || '/upgrade',
      GREATEST(1, v_gate_hits)
    WHERE v_gate_hits > 0
       OR (v_plan_tier = 'per_candidate' AND (v_credits_purchased - v_credits_used) <= 1)

    UNION ALL

    SELECT
      'problem_health_alert'::pg_catalog.text,
      v_first_alert_def,
      3,
      v_health_alerts || ' saved ' || CASE WHEN v_health_alerts = 1 THEN 'problem shows' ELSE 'problems show' END || ' drop-off or runner errors',
      'Inspect completion rate, timing, and sandbox failure diagnostics in your Problem Library.',
      'Inspect problem health',
      '/r23/organizations/' || v_org_id_text || '/problems',
      v_health_alerts
    WHERE v_health_alerts > 0

    UNION ALL

    SELECT
      'no_assessment_48h'::pg_catalog.text,
      ''::pg_catalog.text,
      4,
      'Issue your first candidate assessment',
      'Your workspace has been active for over 48 hours without an issued session. Preview a template or invite a candidate.',
      'Open Assessment Builder',
      '/r23/organizations/' || v_org_id_text || '/builder?mode=new',
      1
    WHERE v_session_cnt = 0
      AND v_first_joined IS NOT NULL
      AND v_first_joined <= pg_catalog.clock_timestamp() - INTERVAL '48 hours'

    UNION ALL

    SELECT
      'connect_slack_webhook'::pg_catalog.text,
      ''::pg_catalog.text,
      5,
      'Connect Slack or outbound webhooks',
      'Get instant alerts when candidates start, submit work, or receive a published verdict.',
      'Connect Slack / Webhook',
      '/r23/organizations/' || v_org_id_text || '/settings#webhooks',
      1
    WHERE v_session_cnt >= 1 AND v_webhook_cnt = 0
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'nudgeKey', c.nudge_key,
        'targetRef', c.target_ref,
        'priority', c.priority,
        'title', c.title,
        'detail', c.detail,
        'ctaLabel', c.cta_label,
        'ctaHref', c.cta_href,
        'count', c.cnt
      ) ORDER BY c.priority ASC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_nudges
  FROM candidates AS c
  WHERE NOT EXISTS (
    SELECT 1 FROM hirearchy.organization_nudges AS n
    WHERE n.organization_id = p_organization_id
      AND n.nudge_key = c.nudge_key
      AND n.target_ref = c.target_ref
      AND (
        n.status IN ('dismissed', 'resolved')
        OR (n.status = 'snoozed' AND n.snoozed_until > pg_catalog.clock_timestamp())
      )
  );

  RETURN pg_catalog.jsonb_build_object('nudges', v_nudges);
END
$function$;

CREATE OR REPLACE FUNCTION staging.hiring_org_nudge_dismiss(
  p_organization_id pg_catalog.uuid,
  p_caller_principal_id pg_catalog.uuid,
  p_nudge_key pg_catalog.text,
  p_target_ref pg_catalog.text,
  p_action pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, staging, pg_temp
AS $function$
DECLARE
  v_status pg_catalog.text;
  v_snoozed_until pg_catalog.timestamptz;
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

  IF p_nudge_key NOT IN ('no_assessment_48h', 'unreviewed_submission_48h', 'plan_gate_no_upgrade', 'problem_health_alert', 'connect_slack_webhook')
     OR p_action NOT IN ('snooze', 'dismiss') THEN
    RAISE EXCEPTION 'Invalid nudge action' USING ERRCODE = '22023';
  END IF;

  v_status := CASE WHEN p_action = 'snooze' THEN 'snoozed' ELSE 'dismissed' END;
  v_snoozed_until := CASE WHEN p_action = 'snooze' THEN pg_catalog.clock_timestamp() + INTERVAL '7 days' ELSE NULL END;

  INSERT INTO hirearchy.organization_nudges (
    organization_id, nudge_key, target_ref, status, snoozed_until, updated_by_principal_id, updated_at
  ) VALUES (
    p_organization_id,
    p_nudge_key,
    left(COALESCE(p_target_ref, ''), 200),
    v_status,
    v_snoozed_until,
    p_caller_principal_id,
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT (organization_id, nudge_key, target_ref) DO UPDATE SET
    status = EXCLUDED.status,
    snoozed_until = EXCLUDED.snoozed_until,
    updated_by_principal_id = EXCLUDED.updated_by_principal_id,
    updated_at = pg_catalog.clock_timestamp();

  RETURN pg_catalog.jsonb_build_object('ok', true);
END
$function$;

CREATE OR REPLACE FUNCTION staging.telemetry_lifecycle_report()
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, auth, pg_temp
AS $function$
DECLARE
  v_action_queue pg_catalog.jsonb;
  v_cohorts pg_catalog.jsonb;
BEGIN
  WITH org_base AS (
    SELECT
      o.id AS org_id,
      COALESCE(NULLIF(trim(o.display_name), ''), 'Workspace') AS org_name,
      o.owner_principal_id,
      COALESCE(u.email, '') AS owner_email,
      COALESCE(p.plan_tier, 'none') AS plan_tier,
      COALESCE(p.candidate_credits_purchased, 0) AS credits_purchased,
      (SELECT COUNT(*)::pg_catalog.int4 FROM hirearchy.organization_candidate_credits c WHERE c.organization_id = o.id) AS credits_used,
      MIN(om.joined_at) AS first_joined_at
    FROM hirearchy.organizations AS o
    JOIN hirearchy.organization_memberships AS om ON om.organization_id = o.id
    LEFT JOIN hirearchy.application_principals AS ap ON ap.id = o.owner_principal_id
    LEFT JOIN auth.users AS u ON u.id = ap.auth_user_id
    LEFT JOIN hirearchy.organization_plans AS p ON p.organization_id = o.id
    GROUP BY o.id, o.display_name, o.owner_principal_id, u.email, p.plan_tier, p.candidate_credits_purchased
  ),
  raw_items AS (
    SELECT
      ob.org_id,
      ob.org_name,
      ob.owner_email,
      ob.plan_tier,
      'no_assessment_48h'::pg_catalog.text AS nudge_key,
      ''::pg_catalog.text AS target_ref,
      ROUND((EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - ob.first_joined_at)) / 3600.0)::numeric, 1) AS hours_age,
      1 AS affected_count,
      'Created >48h ago with 0 issued assessments' AS summary
    FROM org_base AS ob
    WHERE ob.first_joined_at <= pg_catalog.clock_timestamp() - INTERVAL '48 hours'
      AND NOT EXISTS (SELECT 1 FROM hirearchy.assessment_sessions AS s WHERE s.organization_id = ob.org_id)

    UNION ALL

    SELECT
      ob.org_id,
      ob.org_name,
      ob.owner_email,
      ob.plan_tier,
      'unreviewed_submission_48h'::pg_catalog.text,
      ''::pg_catalog.text,
      ROUND((MAX(EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - s.submitted_at)) / 3600.0))::numeric, 1),
      COUNT(*)::pg_catalog.int4,
      COUNT(*)::pg_catalog.text || ' submitted candidate(s) waiting >48h for verdict'
    FROM org_base AS ob
    JOIN hirearchy.assessment_sessions AS s ON s.organization_id = ob.org_id
    WHERE s.status = 'SUBMITTED'
      AND s.submitted_at <= pg_catalog.clock_timestamp() - INTERVAL '48 hours'
      AND NOT EXISTS (SELECT 1 FROM hirearchy.hiring_decisions AS d WHERE d.session_id = s.id)
    GROUP BY ob.org_id, ob.org_name, ob.owner_email, ob.plan_tier

    UNION ALL

    SELECT
      ob.org_id,
      ob.org_name,
      ob.owner_email,
      ob.plan_tier,
      'plan_gate_no_upgrade'::pg_catalog.text,
      ''::pg_catalog.text,
      ROUND((COALESCE(EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - MAX(pe.occurred_at))) / 3600.0, 0))::numeric, 1),
      GREATEST(1, COUNT(pe.id)::pg_catalog.int4),
      CASE
        WHEN ob.plan_tier = 'per_candidate' AND (ob.credits_purchased - ob.credits_used) <= 1
          THEN 'Per-candidate slots nearly exhausted (' || GREATEST(0, ob.credits_purchased - ob.credits_used)::pg_catalog.text || ' left)'
        ELSE 'Hit plan gate without upgrading in last 14d'
      END
    FROM org_base AS ob
    LEFT JOIN hirearchy.product_events AS pe
      ON pe.organization_id = ob.org_id
     AND pe.event_name = 'monetization.plan_gate_hit'
     AND pe.occurred_at >= pg_catalog.clock_timestamp() - INTERVAL '14 days'
     AND NOT EXISTS (
       SELECT 1 FROM hirearchy.product_events AS pe2
       WHERE pe2.organization_id = ob.org_id
         AND pe2.event_name IN ('monetization.plan_changed', 'monetization.slots_added')
         AND pe2.occurred_at >= pe.occurred_at
     )
    GROUP BY ob.org_id, ob.org_name, ob.owner_email, ob.plan_tier, ob.credits_purchased, ob.credits_used
    HAVING COUNT(pe.id) > 0 OR (ob.plan_tier = 'per_candidate' AND (ob.credits_purchased - ob.credits_used) <= 1)

    UNION ALL

    SELECT
      ob.org_id,
      ob.org_name,
      ob.owner_email,
      ob.plan_tier,
      'problem_health_alert'::pg_catalog.text,
      COALESCE(m.definition_id::pg_catalog.text, ''),
      ROUND((EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - MAX(s.created_at))) / 3600.0)::numeric, 1),
      COUNT(*) FILTER (WHERE s.activated_at IS NOT NULL)::pg_catalog.int4,
      'Problem "' || MAX(s.scenario_title) || '" flagged for high drop-off or runner errors'
    FROM org_base AS ob
    JOIN hirearchy.hiring_session_metadata AS m ON m.organization_id = ob.org_id
    JOIN hirearchy.assessment_sessions AS s ON s.id = m.session_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS total_ops,
        COUNT(*) FILTER (WHERE eo.status IN ('FAILED', 'TIMED_OUT', 'UNKNOWN')) AS err_ops
      FROM hirearchy.candidate_execution_operations AS eo
      WHERE eo.session_id = s.id
    ) AS op_stats ON true
    GROUP BY ob.org_id, ob.org_name, ob.owner_email, ob.plan_tier, m.definition_id
    HAVING COUNT(*) FILTER (WHERE s.activated_at IS NOT NULL) >= 3
       AND (
         COALESCE((SUM(op_stats.err_ops) * 100.0) / NULLIF(SUM(op_stats.total_ops), 0), 0) >= 35
         OR COALESCE((COUNT(*) FILTER (WHERE s.submitted_at IS NOT NULL) * 100.0) / NULLIF(COUNT(*) FILTER (WHERE s.activated_at IS NOT NULL), 0), 0) < 55
       )
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'organizationId', ri.org_id::pg_catalog.text,
        'organizationName', ri.org_name,
        'ownerEmail', ri.owner_email,
        'planTier', ri.plan_tier,
        'nudgeKey', ri.nudge_key,
        'targetRef', ri.target_ref,
        'hoursAge', ri.hours_age,
        'affectedCount', ri.affected_count,
        'summary', ri.summary,
        'nudgeStatus', COALESCE(n.status, 'active'),
        'snoozedUntil', CASE WHEN n.snoozed_until IS NULL THEN NULL ELSE pg_catalog.to_char(n.snoozed_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
        'founderNote', COALESCE(n.founder_note, ''),
        'contactedAt', CASE WHEN n.contacted_at IS NULL THEN NULL ELSE pg_catalog.to_char(n.contacted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
      ) ORDER BY ri.hours_age DESC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_action_queue
  FROM raw_items AS ri
  LEFT JOIN hirearchy.organization_nudges AS n
    ON n.organization_id = ri.org_id
   AND n.nudge_key = ri.nudge_key
   AND n.target_ref = ri.target_ref;

  WITH org_dates AS (
    SELECT
      o.id AS org_id,
      MIN(om.joined_at) AS first_joined_at,
      date_trunc('month', MIN(om.joined_at)) AS cohort_month
    FROM hirearchy.organizations AS o
    JOIN hirearchy.organization_memberships AS om ON om.organization_id = o.id
    GROUP BY o.id
  ),
  recent_cohorts AS (
    SELECT *
    FROM org_dates
    WHERE cohort_month >= date_trunc('month', pg_catalog.clock_timestamp()) - INTERVAL '5 months'
  ),
  org_activity AS (
    SELECT organization_id AS org_id, created_at AS act_at FROM hirearchy.assessment_sessions
    UNION ALL
    SELECT organization_id AS org_id, published_at AS act_at FROM hirearchy.hiring_decisions
    UNION ALL
    SELECT organization_id AS org_id, created_at AS act_at FROM hirearchy.hiring_second_opinions
  ),
  org_rollup AS (
    SELECT
      rc.org_id,
      rc.cohort_month,
      rc.first_joined_at,
      MIN(s.created_at) AS first_session_at,
      EXISTS (
        SELECT 1 FROM hirearchy.assessment_sessions AS s7
        WHERE s7.organization_id = rc.org_id
          AND s7.created_at <= rc.first_joined_at + INTERVAL '7 days'
      ) AS activated_7d,
      EXISTS (
        SELECT 1 FROM org_activity AS oa
        WHERE oa.org_id = rc.org_id
          AND oa.act_at >= rc.cohort_month + INTERVAL '1 month'
          AND oa.act_at < rc.cohort_month + INTERVAL '2 months'
      ) AS retained_m1,
      EXISTS (
        SELECT 1 FROM org_activity AS oa
        WHERE oa.org_id = rc.org_id
          AND oa.act_at >= rc.cohort_month + INTERVAL '2 months'
          AND oa.act_at < rc.cohort_month + INTERVAL '3 months'
      ) AS retained_m2,
      EXISTS (
        SELECT 1 FROM org_activity AS oa
        WHERE oa.org_id = rc.org_id
          AND oa.act_at >= rc.cohort_month + INTERVAL '3 months'
          AND oa.act_at < rc.cohort_month + INTERVAL '4 months'
      ) AS retained_m3,
      (
        SELECT COUNT(DISTINCT floor(EXTRACT(EPOCH FROM (sw.created_at - min_s.first_s)) / (21 * 86400.0))) >= 2
        FROM hirearchy.assessment_sessions AS sw
        CROSS JOIN (
          SELECT MIN(created_at) AS first_s
          FROM hirearchy.assessment_sessions
          WHERE organization_id = rc.org_id
        ) AS min_s
        WHERE sw.organization_id = rc.org_id
          AND min_s.first_s IS NOT NULL
      ) AS is_repeat_wave
    FROM recent_cohorts AS rc
    LEFT JOIN hirearchy.assessment_sessions AS s ON s.organization_id = rc.org_id
    GROUP BY rc.org_id, rc.cohort_month, rc.first_joined_at
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'cohortMonth', pg_catalog.to_char(c_month, 'YYYY-MM'),
        'orgsCreated', orgs_created,
        'activated7dPct', activated_7d_pct,
        'retainedM1Pct', CASE WHEN c_month + INTERVAL '1 month' <= date_trunc('month', pg_catalog.clock_timestamp()) THEN m1_pct ELSE NULL END,
        'retainedM2Pct', CASE WHEN c_month + INTERVAL '2 months' <= date_trunc('month', pg_catalog.clock_timestamp()) THEN m2_pct ELSE NULL END,
        'retainedM3Pct', CASE WHEN c_month + INTERVAL '3 months' <= date_trunc('month', pg_catalog.clock_timestamp()) THEN m3_pct ELSE NULL END,
        'repeatWaveOrgsCount', repeat_wave_cnt,
        'repeatWavePct', repeat_wave_pct,
        'medianHoursToFirstInvite', median_hours
      ) ORDER BY c_month DESC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_cohorts
  FROM (
    SELECT
      cohort_month AS c_month,
      COUNT(*)::pg_catalog.int4 AS orgs_created,
      COALESCE(ROUND((COUNT(*) FILTER (WHERE activated_7d) * 100.0) / NULLIF(COUNT(*), 0), 1), 0) AS activated_7d_pct,
      COALESCE(ROUND((COUNT(*) FILTER (WHERE retained_m1) * 100.0) / NULLIF(COUNT(*), 0), 1), 0) AS m1_pct,
      COALESCE(ROUND((COUNT(*) FILTER (WHERE retained_m2) * 100.0) / NULLIF(COUNT(*), 0), 1), 0) AS m2_pct,
      COALESCE(ROUND((COUNT(*) FILTER (WHERE retained_m3) * 100.0) / NULLIF(COUNT(*), 0), 1), 0) AS m3_pct,
      COUNT(*) FILTER (WHERE is_repeat_wave)::pg_catalog.int4 AS repeat_wave_cnt,
      COALESCE(ROUND((COUNT(*) FILTER (WHERE is_repeat_wave) * 100.0) / NULLIF(COUNT(*), 0), 1), 0) AS repeat_wave_pct,
      ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY CASE WHEN first_session_at IS NOT NULL AND first_session_at >= first_joined_at THEN EXTRACT(EPOCH FROM (first_session_at - first_joined_at)) / 3600.0 ELSE NULL END))::numeric, 1) AS median_hours
    FROM org_rollup
    GROUP BY cohort_month
  ) AS cohort_summary;

  RETURN pg_catalog.jsonb_build_object(
    'actionQueue', v_action_queue,
    'cohortRetention', v_cohorts
  );
END
$function$;

CREATE OR REPLACE FUNCTION staging.telemetry_update_nudge(
  p_organization_id pg_catalog.uuid,
  p_nudge_key pg_catalog.text,
  p_target_ref pg_catalog.text,
  p_status pg_catalog.text,
  p_founder_note pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hirearchy, pg_temp
AS $function$
DECLARE
  v_snoozed_until pg_catalog.timestamptz;
BEGIN
  IF p_nudge_key NOT IN ('no_assessment_48h', 'unreviewed_submission_48h', 'plan_gate_no_upgrade', 'problem_health_alert', 'connect_slack_webhook')
     OR p_status NOT IN ('contacted', 'snoozed', 'resolved') THEN
    RAISE EXCEPTION 'Invalid lifecycle nudge update' USING ERRCODE = '22023';
  END IF;

  v_snoozed_until := CASE
    WHEN p_status = 'snoozed' THEN pg_catalog.clock_timestamp() + INTERVAL '7 days'
    ELSE NULL
  END;

  INSERT INTO hirearchy.organization_nudges (
    organization_id, nudge_key, target_ref, status, snoozed_until, founder_note, contacted_at, updated_at
  ) VALUES (
    p_organization_id,
    p_nudge_key,
    left(COALESCE(p_target_ref, ''), 200),
    p_status,
    v_snoozed_until,
    left(trim(COALESCE(p_founder_note, '')), 1000),
    CASE WHEN p_status = 'contacted' THEN pg_catalog.clock_timestamp() ELSE NULL END,
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT (organization_id, nudge_key, target_ref) DO UPDATE SET
    status = EXCLUDED.status,
    snoozed_until = EXCLUDED.snoozed_until,
    founder_note = CASE
      WHEN EXCLUDED.founder_note <> '' THEN EXCLUDED.founder_note
      ELSE hirearchy.organization_nudges.founder_note
    END,
    contacted_at = COALESCE(EXCLUDED.contacted_at, hirearchy.organization_nudges.contacted_at),
    updated_at = pg_catalog.clock_timestamp();

  INSERT INTO hirearchy.product_events (
    event_name, category, actor_type, organization_id, route, status, properties
  ) VALUES (
    'operator.outreach.logged',
    'team_funnel',
    'system',
    p_organization_id,
    '/r23/intelligence',
    'ok',
    pg_catalog.jsonb_build_object(
      'nudgeKey', p_nudge_key,
      'status', p_status
    )
  );

  RETURN pg_catalog.jsonb_build_object('ok', true);
END
$function$;

ALTER FUNCTION staging.hiring_dossier_share_create(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb) OWNER TO postgres;
ALTER FUNCTION staging.hiring_dossier_share_list(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) OWNER TO postgres;
ALTER FUNCTION staging.hiring_dossier_share_revoke(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid) OWNER TO postgres;
ALTER FUNCTION staging.hiring_webhook_list(pg_catalog.uuid, pg_catalog.uuid) OWNER TO postgres;
ALTER FUNCTION staging.hiring_webhook_upsert(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.jsonb) OWNER TO postgres;
ALTER FUNCTION staging.hiring_webhook_delete(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid) OWNER TO postgres;
ALTER FUNCTION staging.hiring_org_problem_health(pg_catalog.uuid, pg_catalog.uuid) OWNER TO postgres;
ALTER FUNCTION staging.hiring_org_nudges_get(pg_catalog.uuid, pg_catalog.uuid) OWNER TO postgres;
ALTER FUNCTION staging.hiring_org_nudge_dismiss(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text) OWNER TO postgres;

ALTER FUNCTION staging.hiring_dossier_share_resolve(pg_catalog.text) OWNER TO postgres;
ALTER FUNCTION staging.webhook_enqueue_session_event(pg_catalog.text, pg_catalog.text, pg_catalog.jsonb) OWNER TO postgres;
ALTER FUNCTION staging.webhook_enqueue_ping(pg_catalog.uuid, pg_catalog.uuid) OWNER TO postgres;
ALTER FUNCTION staging.webhook_mark_delivery(pg_catalog.uuid, pg_catalog.text, pg_catalog.int4, pg_catalog.int4, pg_catalog.text, pg_catalog.timestamptz) OWNER TO postgres;
ALTER FUNCTION staging.telemetry_lifecycle_report() OWNER TO postgres;
ALTER FUNCTION staging.telemetry_update_nudge(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) OWNER TO postgres;

REVOKE ALL ON FUNCTION staging.hiring_dossier_share_create(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, staging_readiness_owner, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_dossier_share_list(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, staging_readiness_owner, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_dossier_share_revoke(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, staging_readiness_owner, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_webhook_list(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, staging_readiness_owner, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_webhook_upsert(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.jsonb) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, staging_readiness_owner, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_webhook_delete(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, staging_readiness_owner, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_org_problem_health(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, staging_readiness_owner, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_org_nudges_get(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, staging_readiness_owner, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_org_nudge_dismiss(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, staging_readiness_owner, hirearchy_migrator;

GRANT EXECUTE ON FUNCTION staging.hiring_dossier_share_create(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_dossier_share_list(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_dossier_share_revoke(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_webhook_list(pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_webhook_upsert(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.jsonb) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_webhook_delete(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_org_problem_health(pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_org_nudges_get(pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_org_nudge_dismiss(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO staging_verifier_owner;

REVOKE ALL ON FUNCTION staging.hiring_dossier_share_resolve(pg_catalog.text) FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker, staging_verifier_owner, staging_readiness_owner, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.webhook_enqueue_session_event(pg_catalog.text, pg_catalog.text, pg_catalog.jsonb) FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker, staging_verifier_owner, staging_readiness_owner, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.webhook_enqueue_ping(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker, staging_verifier_owner, staging_readiness_owner, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.webhook_mark_delivery(pg_catalog.uuid, pg_catalog.text, pg_catalog.int4, pg_catalog.int4, pg_catalog.text, pg_catalog.timestamptz) FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker, staging_verifier_owner, staging_readiness_owner, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.telemetry_lifecycle_report() FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker, staging_verifier_owner, staging_readiness_owner, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.telemetry_update_nudge(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker, staging_verifier_owner, staging_readiness_owner, hirearchy_migrator;

GRANT EXECUTE ON FUNCTION staging.hiring_dossier_share_resolve(pg_catalog.text) TO r23_gateway;
GRANT EXECUTE ON FUNCTION staging.webhook_enqueue_session_event(pg_catalog.text, pg_catalog.text, pg_catalog.jsonb) TO r23_gateway;
GRANT EXECUTE ON FUNCTION staging.webhook_enqueue_ping(pg_catalog.uuid, pg_catalog.uuid) TO r23_gateway;
GRANT EXECUTE ON FUNCTION staging.webhook_mark_delivery(pg_catalog.uuid, pg_catalog.text, pg_catalog.int4, pg_catalog.int4, pg_catalog.text, pg_catalog.timestamptz) TO r23_gateway;
GRANT EXECUTE ON FUNCTION staging.telemetry_lifecycle_report() TO r23_gateway;
GRANT EXECUTE ON FUNCTION staging.telemetry_update_nudge(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO r23_gateway;

COMMIT;
