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
  v_existing_credits pg_catalog.int4 := 0;
  v_next_credits pg_catalog.int4 := 0;
BEGIN
  IF p_plan_tier NOT IN ('per_candidate', 'pro', 'ultra') THEN
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

  SELECT candidate_credits_purchased INTO v_existing_credits
  FROM hirearchy.organization_plans
  WHERE organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    v_existing_credits := 0;
  END IF;

  IF p_plan_tier = 'per_candidate' THEN
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
    p_organization_id, p_plan_tier, v_next_credits, p_caller_principal_id, pg_catalog.clock_timestamp()
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
    false,
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
    'aiInteractions', v_ai
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

  SELECT owner_principal_id, name INTO v_owner_id, v_org_name FROM hirearchy.organizations WHERE id = p_organization_id;
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
GRANT EXECUTE ON FUNCTION staging.onboarding_list_user_memberships(pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.onboarding_get_organization_metadata(pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_create_team_invitation(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_candidate_profile_get(pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_candidate_profile_upsert(pg_catalog.uuid, pg_catalog.jsonb) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_candidate_portal_list(pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_candidate_session_verify(pg_catalog.uuid, pg_catalog.text) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_plan_get(pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_plan_update(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.int4) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_library_list(pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_library_save(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.jsonb) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_issue_assessment(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.jsonb) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_candidates_list(pg_catalog.uuid, pg_catalog.uuid) TO staging_verifier_owner;
GRANT EXECUTE ON FUNCTION staging.hiring_get_session_ai_interactions(pg_catalog.uuid, pg_catalog.text) TO staging_verifier_owner;
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
REVOKE ALL ON FUNCTION staging.onboarding_list_user_memberships(pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.onboarding_get_organization_metadata(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_create_team_invitation(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_candidate_profile_get(pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_candidate_profile_upsert(pg_catalog.uuid, pg_catalog.jsonb) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_candidate_portal_list(pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_candidate_session_verify(pg_catalog.uuid, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_plan_get(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_plan_update(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.int4) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_library_list(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_library_save(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.jsonb) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_issue_assessment(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.jsonb) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_candidates_list(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
REVOKE ALL ON FUNCTION staging.hiring_get_session_ai_interactions(pg_catalog.uuid, pg_catalog.text) FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker, hirearchy_migrator;
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
        'candidate.profile.get': ((), ()),
        'candidate.profile.upsert': (('profile',), ()),
        'candidate.portal.list': ((), ()),
        'candidate.session.verify_access': (('sessionId',), ()),
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

    if op == 'candidate.session.verify_access':
        session_id = args.get('sessionId')
        if not isinstance(session_id, str) or not re.fullmatch(r'sess_[A-Za-z0-9_-]{1,128}', session_id):
            error('Session identifier is invalid', '22023')
        rows = run(
            "SELECT staging.hiring_candidate_session_verify($1::pg_catalog.uuid, $2) AS result",
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
}
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

COMMIT;
