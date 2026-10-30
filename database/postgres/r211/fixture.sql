-- Disposable R2.11 assessment authoring fixture; never a production migration.
BEGIN;

DO $roles$
DECLARE
  gateway oid;
  owner_oid oid;
  gateway_state record;
  owner_state record;
BEGIN
  SELECT oid INTO gateway FROM pg_catalog.pg_roles WHERE rolname = 'r23_gateway';
  SELECT oid INTO owner_oid FROM pg_catalog.pg_roles WHERE rolname = 'r23_session_owner';
  SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
         rolreplication, rolinherit
  INTO gateway_state FROM pg_catalog.pg_roles WHERE oid = gateway;
  SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
         rolreplication, rolinherit
  INTO owner_state FROM pg_catalog.pg_roles WHERE oid = owner_oid;
  IF gateway IS NULL OR owner_oid IS NULL
     OR NOT gateway_state.rolcanlogin OR gateway_state.rolsuper
     OR gateway_state.rolbypassrls OR gateway_state.rolcreatedb
     OR gateway_state.rolcreaterole OR gateway_state.rolreplication
     OR gateway_state.rolinherit OR owner_state.rolcanlogin
     OR owner_state.rolsuper OR owner_state.rolbypassrls
     OR owner_state.rolcreatedb OR owner_state.rolcreaterole
     OR owner_state.rolreplication OR owner_state.rolinherit
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_auth_members
       WHERE roleid IN (gateway, owner_oid) OR member IN (gateway, owner_oid)
     ) THEN
    RAISE EXCEPTION 'R2.11 assessment builder roles are missing or unsafe';
  END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS r211 AUTHORIZATION r23_session_owner;
REVOKE ALL ON SCHEMA r211 FROM PUBLIC, r23_gateway, app_evaluator,
  app_candidate_gateway, app_control_worker;
GRANT USAGE ON SCHEMA r211 TO r23_gateway, app_evaluator, r23_session_owner;
GRANT USAGE ON SCHEMA hirearchy TO r23_session_owner;

REVOKE ALL ON TABLE hirearchy.assessment_definitions,
  hirearchy.assessment_drafts,
  hirearchy.assessment_validated_versions
  FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway,
       app_control_worker;

GRANT SELECT, INSERT, UPDATE (
  title, draft_version, updated_at
) ON TABLE hirearchy.assessment_definitions TO r23_session_owner;

GRANT SELECT, INSERT
  ON TABLE hirearchy.assessment_drafts TO r23_session_owner;

GRANT SELECT, INSERT
  ON TABLE hirearchy.assessment_validated_versions TO r23_session_owner;

GRANT SELECT ON TABLE hirearchy.organizations,
  hirearchy.organization_memberships TO r23_session_owner;

-- RLS policies for r23_session_owner on assessment_definitions
DROP POLICY IF EXISTS r211_assessment_definitions_select ON hirearchy.assessment_definitions;
CREATE POLICY r211_assessment_definitions_select
  ON hirearchy.assessment_definitions
  FOR SELECT TO r23_session_owner
  USING (
    organization_id = NULLIF(
      pg_catalog.current_setting('r211.organization_id', true), ''
    )::pg_catalog.uuid
  );

DROP POLICY IF EXISTS r211_assessment_definitions_insert ON hirearchy.assessment_definitions;
CREATE POLICY r211_assessment_definitions_insert
  ON hirearchy.assessment_definitions
  FOR INSERT TO r23_session_owner
  WITH CHECK (
    organization_id = NULLIF(
      pg_catalog.current_setting('r211.organization_id', true), ''
    )::pg_catalog.uuid
    AND author_principal_id = NULLIF(
      pg_catalog.current_setting('r211.principal_id', true), ''
    )::pg_catalog.uuid
  );

DROP POLICY IF EXISTS r211_assessment_definitions_update ON hirearchy.assessment_definitions;
CREATE POLICY r211_assessment_definitions_update
  ON hirearchy.assessment_definitions
  FOR UPDATE TO r23_session_owner
  USING (
    organization_id = NULLIF(
      pg_catalog.current_setting('r211.organization_id', true), ''
    )::pg_catalog.uuid
  );

-- RLS policies for r23_session_owner on assessment_drafts
DROP POLICY IF EXISTS r211_assessment_drafts_select ON hirearchy.assessment_drafts;
CREATE POLICY r211_assessment_drafts_select
  ON hirearchy.assessment_drafts
  FOR SELECT TO r23_session_owner
  USING (
    organization_id = NULLIF(
      pg_catalog.current_setting('r211.organization_id', true), ''
    )::pg_catalog.uuid
  );

DROP POLICY IF EXISTS r211_assessment_drafts_insert ON hirearchy.assessment_drafts;
CREATE POLICY r211_assessment_drafts_insert
  ON hirearchy.assessment_drafts
  FOR INSERT TO r23_session_owner
  WITH CHECK (
    organization_id = NULLIF(
      pg_catalog.current_setting('r211.organization_id', true), ''
    )::pg_catalog.uuid
    AND author_principal_id = NULLIF(
      pg_catalog.current_setting('r211.principal_id', true), ''
    )::pg_catalog.uuid
  );

-- RLS policies for r23_session_owner on assessment_validated_versions
DROP POLICY IF EXISTS r211_assessment_validated_versions_select ON hirearchy.assessment_validated_versions;
CREATE POLICY r211_assessment_validated_versions_select
  ON hirearchy.assessment_validated_versions
  FOR SELECT TO r23_session_owner
  USING (
    organization_id = NULLIF(
      pg_catalog.current_setting('r211.organization_id', true), ''
    )::pg_catalog.uuid
  );

DROP POLICY IF EXISTS r211_assessment_validated_versions_insert ON hirearchy.assessment_validated_versions;
CREATE POLICY r211_assessment_validated_versions_insert
  ON hirearchy.assessment_validated_versions
  FOR INSERT TO r23_session_owner
  WITH CHECK (
    organization_id = NULLIF(
      pg_catalog.current_setting('r211.organization_id', true), ''
    )::pg_catalog.uuid
    AND author_principal_id = NULLIF(
      pg_catalog.current_setting('r211.principal_id', true), ''
    )::pg_catalog.uuid
  );

-- Helper to format draft record as JSON matching R211AssessmentDraft
CREATE OR REPLACE FUNCTION r211.format_draft(
  p_definition_id pg_catalog.uuid,
  p_version pg_catalog.int8
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $function$
DECLARE
  v_draft record;
  v_def record;
BEGIN
  SELECT * INTO v_draft
  FROM hirearchy.assessment_drafts
  WHERE definition_id = p_definition_id AND version = p_version;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_def
  FROM hirearchy.assessment_definitions
  WHERE id = p_definition_id;

  RETURN pg_catalog.jsonb_build_object(
    'definitionId', v_draft.definition_id::pg_catalog.text,
    'organizationId', v_draft.organization_id::pg_catalog.text,
    'authorPrincipalId', v_draft.author_principal_id::pg_catalog.text,
    'version', v_draft.version,
    'templateId', v_draft.template_id,
    'title', v_draft.title,
    'brief', v_draft.brief,
    'expectedBehavior', v_draft.expected_behavior,
    'acceptanceCriteria', v_draft.acceptance_criteria,
    'primaryFilePath', v_draft.primary_file_path,
    'starterFiles', v_draft.starter_files,
    'durationMinutes', v_draft.duration_minutes,
    'terminalEnabled', v_draft.terminal_enabled,
    'integratedAi', v_draft.integrated_ai,
    'rubric', v_draft.rubric,
    'createdAt', pg_catalog.to_char(v_def.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updatedAt', pg_catalog.to_char(v_draft.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
END
$function$;

-- Helper to format validated version record as JSON matching R211ValidatedVersion
CREATE OR REPLACE FUNCTION r211.format_validated_version(
  p_version_id pg_catalog.uuid
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $function$
DECLARE
  v_row record;
BEGIN
  SELECT * INTO v_row
  FROM hirearchy.assessment_validated_versions
  WHERE id = p_version_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_row.id::pg_catalog.text,
    'definitionId', v_row.definition_id::pg_catalog.text,
    'organizationId', v_row.organization_id::pg_catalog.text,
    'authorPrincipalId', v_row.author_principal_id::pg_catalog.text,
    'versionNumber', v_row.version_number,
    'contentDigest', v_row.content_digest,
    'scenarioId', v_row.scenario_id,
    'scenarioVersion', v_row.scenario_version,
    'scenarioTitle', v_row.scenario_title,
    'scenarioSnapshot', v_row.scenario_snapshot::pg_catalog.jsonb,
    'taskRubricSnapshot', v_row.task_rubric_snapshot,
    'durationSeconds', v_row.duration_seconds,
    'terminalEnabled', v_row.terminal_enabled,
    'integratedAi', v_row.integrated_ai,
    'validationReceipt', v_row.validation_receipt,
    'createdAt', pg_catalog.to_char(v_row.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
END
$function$;

-- 1. save_assessment_draft
CREATE OR REPLACE FUNCTION r211.save_assessment_draft(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid,
  p_draft_json pg_catalog.jsonb
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_selected_organization_id pg_catalog.uuid;
  v_membership_role pg_catalog.text;
  v_definition_id_text pg_catalog.text;
  v_definition_id pg_catalog.uuid;
  v_expected_version pg_catalog.int8;
  v_def record;
  v_new_version pg_catalog.int8;
  v_title pg_catalog.text;
  v_brief pg_catalog.text;
  v_expected_behavior pg_catalog.jsonb;
  v_acceptance_criteria pg_catalog.jsonb;
  v_primary_file_path pg_catalog.text;
  v_starter_files pg_catalog.jsonb;
  v_duration_minutes pg_catalog.int4;
  v_terminal_enabled pg_catalog.bool;
  v_integrated_ai pg_catalog.bool;
  v_rubric pg_catalog.jsonb;
  v_template_id pg_catalog.text;
BEGIN
  IF SESSION_USER NOT IN ('r23_gateway', 'app_evaluator') OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.11 assessment builder access denied' USING ERRCODE = '42501';
  END IF;

  IF p_subject_id IS NULL OR p_auth_session_id IS NULL
     OR p_assurance IS NULL OR p_assurance NOT IN ('aal1', 'aal2')
     OR p_organization_id IS NULL
     OR p_draft_json IS NULL OR pg_catalog.jsonb_typeof(p_draft_json) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'R2.11 assessment draft parameters are invalid' USING ERRCODE = '22023';
  END IF;

  v_principal_id := r23.current_principal(
    p_subject_id, p_auth_session_id, p_assurance
  );
  IF v_principal_id IS NULL THEN
    RAISE EXCEPTION 'Authentication session invalid' USING ERRCODE = 'R2401';
  END IF;

  SELECT session_row.selected_organization_id
  INTO v_selected_organization_id
  FROM r23.server_sessions AS session_row
  WHERE session_row.handle_hash = NULLIF(
    pg_catalog.current_setting('r23.session_handle_hash', true), ''
  )
    AND session_row.revoked_at IS NULL;
  IF NOT FOUND OR v_selected_organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'Organization selection mismatch' USING ERRCODE = 'R2401';
  END IF;

  SELECT membership.role INTO v_membership_role
  FROM hirearchy.organization_memberships AS membership
  WHERE membership.organization_id = p_organization_id
    AND membership.principal_id = v_principal_id
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE OF membership;
  IF NOT FOUND OR v_membership_role <> 'recruiter' THEN
    RAISE EXCEPTION 'Recruiter role required' USING ERRCODE = 'R2401';
  END IF;

  PERFORM pg_catalog.set_config(
    'r211.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config(
    'r211.principal_id', v_principal_id::pg_catalog.text, true
  );

  v_definition_id_text := NULLIF(pg_catalog.btrim(p_draft_json ->> 'definitionId'), '');
  v_title := COALESCE(p_draft_json ->> 'title', '');
  v_brief := COALESCE(p_draft_json ->> 'brief', '');
  v_expected_behavior := COALESCE(p_draft_json -> 'expectedBehavior', '[]'::pg_catalog.jsonb);
  v_acceptance_criteria := COALESCE(p_draft_json -> 'acceptanceCriteria', '[]'::pg_catalog.jsonb);
  v_primary_file_path := COALESCE(p_draft_json ->> 'primaryFilePath', '');
  v_starter_files := COALESCE(p_draft_json -> 'starterFiles', '[]'::pg_catalog.jsonb);
  v_duration_minutes := COALESCE((p_draft_json ->> 'durationMinutes')::pg_catalog.int4, 60);
  v_terminal_enabled := COALESCE((p_draft_json ->> 'terminalEnabled')::pg_catalog.bool, true);
  v_integrated_ai := COALESCE((p_draft_json ->> 'integratedAi')::pg_catalog.bool, false);
  v_rubric := COALESCE(p_draft_json -> 'rubric', '[]'::pg_catalog.jsonb);
  v_template_id := COALESCE(p_draft_json ->> 'templateId', 'custom');
  IF v_template_id NOT IN ('custom', 'reservation-moves-v3') THEN
    RAISE EXCEPTION 'Unknown assessment template' USING ERRCODE = '22023';
  END IF;
  IF p_draft_json ->> 'expectedVersion' IS NOT NULL THEN
    v_expected_version := (p_draft_json ->> 'expectedVersion')::pg_catalog.int8;
  END IF;

  IF v_definition_id_text IS NOT NULL AND v_definition_id_text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_definition_id := v_definition_id_text::pg_catalog.uuid;
    SELECT def.id, def.draft_version, def.organization_id
    INTO v_def
    FROM hirearchy.assessment_definitions AS def
    WHERE def.id = v_definition_id AND def.organization_id = p_organization_id
    FOR UPDATE;

    IF FOUND THEN
      IF v_expected_version IS NOT NULL AND v_def.draft_version <> v_expected_version THEN
        RAISE EXCEPTION 'DRAFT_CONCURRENCY_CONFLICT' USING ERRCODE = '23505';
      END IF;

      v_new_version := v_def.draft_version + 1;
      UPDATE hirearchy.assessment_definitions
      SET title = v_title,
          draft_version = v_new_version,
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = v_def.id;
    ELSE
      IF v_expected_version IS NOT NULL THEN
        RAISE EXCEPTION 'DRAFT_CONCURRENCY_CONFLICT' USING ERRCODE = '23505';
      END IF;
      v_new_version := 1;
      INSERT INTO hirearchy.assessment_definitions (
        id, organization_id, author_principal_id, title, draft_version, created_at, updated_at
      ) VALUES (
        v_definition_id, p_organization_id, v_principal_id, v_title, 1, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
      );
    END IF;
  ELSE
    v_new_version := 1;
    INSERT INTO hirearchy.assessment_definitions (
      organization_id, author_principal_id, title, draft_version, created_at, updated_at
    ) VALUES (
      p_organization_id, v_principal_id, v_title, 1, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
    ) RETURNING id INTO v_definition_id;
  END IF;

  INSERT INTO hirearchy.assessment_drafts (
    definition_id, organization_id, author_principal_id, version,
    title, brief, expected_behavior, acceptance_criteria,
    primary_file_path, starter_files, duration_minutes,
    terminal_enabled, integrated_ai, rubric, template_id, updated_at
  ) VALUES (
    v_definition_id, p_organization_id, v_principal_id, v_new_version,
    v_title, v_brief, v_expected_behavior, v_acceptance_criteria,
    v_primary_file_path, v_starter_files, v_duration_minutes,
    v_terminal_enabled, v_integrated_ai, v_rubric, v_template_id, pg_catalog.clock_timestamp()
  );

  RETURN r211.format_draft(v_definition_id, v_new_version);
END
$function$;

-- 2. get_assessment_draft
CREATE OR REPLACE FUNCTION r211.get_assessment_draft(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid,
  p_definition_id pg_catalog.uuid DEFAULT NULL
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_selected_organization_id pg_catalog.uuid;
  v_membership_role pg_catalog.text;
  v_target_def_id pg_catalog.uuid;
  v_target_version pg_catalog.int8;
BEGIN
  IF SESSION_USER NOT IN ('r23_gateway', 'app_evaluator') OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.11 assessment builder access denied' USING ERRCODE = '42501';
  END IF;

  IF p_subject_id IS NULL OR p_auth_session_id IS NULL
     OR p_assurance IS NULL OR p_assurance NOT IN ('aal1', 'aal2')
     OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'R2.11 assessment draft parameters are invalid' USING ERRCODE = '22023';
  END IF;

  v_principal_id := r23.current_principal(
    p_subject_id, p_auth_session_id, p_assurance
  );
  IF v_principal_id IS NULL THEN
    RAISE EXCEPTION 'Authentication session invalid' USING ERRCODE = 'R2401';
  END IF;

  SELECT session_row.selected_organization_id
  INTO v_selected_organization_id
  FROM r23.server_sessions AS session_row
  WHERE session_row.handle_hash = NULLIF(
    pg_catalog.current_setting('r23.session_handle_hash', true), ''
  )
    AND session_row.revoked_at IS NULL;
  IF NOT FOUND OR v_selected_organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'Organization selection mismatch' USING ERRCODE = 'R2401';
  END IF;

  SELECT membership.role INTO v_membership_role
  FROM hirearchy.organization_memberships AS membership
  WHERE membership.organization_id = p_organization_id
    AND membership.principal_id = v_principal_id
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE OF membership;
  IF NOT FOUND OR v_membership_role NOT IN ('recruiter', 'reviewer') THEN
    RAISE EXCEPTION 'Recruiter or reviewer role required' USING ERRCODE = 'R2401';
  END IF;

  PERFORM pg_catalog.set_config(
    'r211.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config(
    'r211.principal_id', v_principal_id::pg_catalog.text, true
  );

  IF p_definition_id IS NOT NULL THEN
    SELECT d.definition_id, d.version
    INTO v_target_def_id, v_target_version
    FROM hirearchy.assessment_drafts AS d
    WHERE d.definition_id = p_definition_id AND d.organization_id = p_organization_id
    ORDER BY d.version DESC
    LIMIT 1;
  ELSE
    SELECT d.definition_id, d.version
    INTO v_target_def_id, v_target_version
    FROM hirearchy.assessment_drafts AS d
    WHERE d.organization_id = p_organization_id
    ORDER BY d.updated_at DESC, d.version DESC
    LIMIT 1;
  END IF;

  IF NOT FOUND OR v_target_def_id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN r211.format_draft(v_target_def_id, v_target_version);
END
$function$;

-- 3. list_assessment_definitions
CREATE OR REPLACE FUNCTION r211.list_assessment_definitions(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_selected_organization_id pg_catalog.uuid;
  v_membership_role pg_catalog.text;
  v_result pg_catalog.jsonb;
BEGIN
  IF SESSION_USER NOT IN ('r23_gateway', 'app_evaluator') OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.11 assessment builder access denied' USING ERRCODE = '42501';
  END IF;

  IF p_subject_id IS NULL OR p_auth_session_id IS NULL
     OR p_assurance IS NULL OR p_assurance NOT IN ('aal1', 'aal2')
     OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'R2.11 assessment draft parameters are invalid' USING ERRCODE = '22023';
  END IF;

  v_principal_id := r23.current_principal(
    p_subject_id, p_auth_session_id, p_assurance
  );
  IF v_principal_id IS NULL THEN
    RAISE EXCEPTION 'Authentication session invalid' USING ERRCODE = 'R2401';
  END IF;

  SELECT session_row.selected_organization_id
  INTO v_selected_organization_id
  FROM r23.server_sessions AS session_row
  WHERE session_row.handle_hash = NULLIF(
    pg_catalog.current_setting('r23.session_handle_hash', true), ''
  )
    AND session_row.revoked_at IS NULL;
  IF NOT FOUND OR v_selected_organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'Organization selection mismatch' USING ERRCODE = 'R2401';
  END IF;

  SELECT membership.role INTO v_membership_role
  FROM hirearchy.organization_memberships AS membership
  WHERE membership.organization_id = p_organization_id
    AND membership.principal_id = v_principal_id
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE OF membership;
  IF NOT FOUND OR v_membership_role NOT IN ('recruiter', 'reviewer') THEN
    RAISE EXCEPTION 'Recruiter or reviewer role required' USING ERRCODE = 'R2401';
  END IF;

  PERFORM pg_catalog.set_config(
    'r211.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config(
    'r211.principal_id', v_principal_id::pg_catalog.text, true
  );

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', def.id::pg_catalog.text,
        'organizationId', def.organization_id::pg_catalog.text,
        'authorPrincipalId', def.author_principal_id::pg_catalog.text,
        'title', def.title,
        'draftVersion', def.draft_version,
        'createdAt', pg_catalog.to_char(def.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'updatedAt', pg_catalog.to_char(def.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) ORDER BY def.updated_at DESC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_result
  FROM hirearchy.assessment_definitions AS def
  WHERE def.organization_id = p_organization_id;

  RETURN v_result;
END
$function$;

-- 4. create_validated_version
CREATE OR REPLACE FUNCTION r211.create_validated_version(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid,
  p_version_json pg_catalog.jsonb
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_selected_organization_id pg_catalog.uuid;
  v_membership_role pg_catalog.text;
  v_definition_id pg_catalog.uuid;
  v_definition_id_text pg_catalog.text;
  v_scenario_id pg_catalog.text;
  v_scenario_version pg_catalog.text;
  v_scenario_title pg_catalog.text;
  v_scenario_snapshot pg_catalog.text;
  v_task_rubric_snapshot pg_catalog.jsonb;
  v_duration_seconds pg_catalog.int4;
  v_terminal_enabled pg_catalog.bool;
  v_integrated_ai pg_catalog.bool;
  v_content_digest pg_catalog.text;
  v_validation_receipt pg_catalog.jsonb;
  v_expected_draft_version pg_catalog.int8;
  v_current_draft_version pg_catalog.int8;
  v_version_number pg_catalog.int4;
  v_version_id pg_catalog.uuid;
  v_draft_template pg_catalog.text;
  v_snapshot pg_catalog.jsonb;
BEGIN
  IF SESSION_USER NOT IN ('r23_gateway', 'app_evaluator') OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.11 assessment builder access denied' USING ERRCODE = '42501';
  END IF;

  IF p_subject_id IS NULL OR p_auth_session_id IS NULL
     OR p_assurance IS NULL OR p_assurance NOT IN ('aal1', 'aal2')
     OR p_organization_id IS NULL
     OR p_version_json IS NULL OR pg_catalog.jsonb_typeof(p_version_json) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'R2.11 validated version parameters are invalid' USING ERRCODE = '22023';
  END IF;

  v_principal_id := r23.current_principal(
    p_subject_id, p_auth_session_id, p_assurance
  );
  IF v_principal_id IS NULL THEN
    RAISE EXCEPTION 'Authentication session invalid' USING ERRCODE = 'R2401';
  END IF;

  SELECT session_row.selected_organization_id
  INTO v_selected_organization_id
  FROM r23.server_sessions AS session_row
  WHERE session_row.handle_hash = NULLIF(
    pg_catalog.current_setting('r23.session_handle_hash', true), ''
  )
    AND session_row.revoked_at IS NULL;
  IF NOT FOUND OR v_selected_organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'Organization selection mismatch' USING ERRCODE = 'R2401';
  END IF;

  SELECT membership.role INTO v_membership_role
  FROM hirearchy.organization_memberships AS membership
  WHERE membership.organization_id = p_organization_id
    AND membership.principal_id = v_principal_id
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE OF membership;
  IF NOT FOUND OR v_membership_role <> 'recruiter' THEN
    RAISE EXCEPTION 'Recruiter role required' USING ERRCODE = 'R2401';
  END IF;

  PERFORM pg_catalog.set_config(
    'r211.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config(
    'r211.principal_id', v_principal_id::pg_catalog.text, true
  );

  v_definition_id_text := p_version_json ->> 'definitionId';
  IF v_definition_id_text IS NULL OR v_definition_id_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Definition ID invalid' USING ERRCODE = '22023';
  END IF;
  v_definition_id := v_definition_id_text::pg_catalog.uuid;

  SELECT def.draft_version INTO v_current_draft_version
  FROM hirearchy.assessment_definitions AS def
  WHERE def.id = v_definition_id AND def.organization_id = p_organization_id
  FOR SHARE OF def;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assessment definition not found' USING ERRCODE = '23503';
  END IF;

  IF p_version_json ->> 'expectedDraftVersion' IS NOT NULL THEN
    v_expected_draft_version := (p_version_json ->> 'expectedDraftVersion')::pg_catalog.int8;
    IF v_current_draft_version <> v_expected_draft_version THEN
      RAISE EXCEPTION 'DRAFT_CONCURRENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
  END IF;

  v_scenario_id := COALESCE(p_version_json ->> 'scenarioId', '');
  v_scenario_version := COALESCE(p_version_json ->> 'scenarioVersion', '1.0.0');
  v_scenario_title := COALESCE(p_version_json ->> 'scenarioTitle', '');

  IF pg_catalog.jsonb_typeof(p_version_json -> 'scenarioSnapshot') = 'string' THEN
    v_scenario_snapshot := p_version_json ->> 'scenarioSnapshot';
  ELSE
    v_scenario_snapshot := (p_version_json -> 'scenarioSnapshot')::pg_catalog.text;
  END IF;

  SELECT template_id INTO v_draft_template
  FROM hirearchy.assessment_drafts
  WHERE definition_id = v_definition_id AND version = v_current_draft_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assessment draft not found' USING ERRCODE = '23503';
  END IF;
  v_snapshot := v_scenario_snapshot::pg_catalog.jsonb;
  IF v_draft_template = 'reservation-moves-v3' THEN
    IF v_scenario_id IS DISTINCT FROM 'reservation-moves'
       OR v_scenario_version IS DISTINCT FROM 'v3'
       OR v_snapshot #>> '{scenario,templateId}' IS DISTINCT FROM 'reservation-moves-v3'
       OR v_snapshot #>> '{scenario,recipe,id}' IS DISTINCT FROM 'reservation-moves.pytest'
       OR v_snapshot #>> '{scenario,recipe,version}' IS DISTINCT FROM '3'
       OR v_snapshot #>> '{scenario,recipe,digest}' IS DISTINCT FROM 'eeac2baaf62ce107c7511268e862657ae24bb171cd1dec6ca01797c16ffbaad8'
       OR v_snapshot #>> '{scenario,starterWorkspaceDigest}' IS DISTINCT FROM 'c1e172b193fd0c5e78f81ef5bf74ea95a07b6be3215829d5fa8e5116423b0694'
       OR pg_catalog.jsonb_typeof(v_snapshot -> 'workspaceFiles') IS DISTINCT FROM 'object'
       OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_snapshot -> 'workspaceFiles')) <> 4
       OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_snapshot #>> '{workspaceFiles,src/sender.py}', 'UTF8')), 'hex') IS DISTINCT FROM 'c5baff96c4ff1ee96e136cb9dda8ed60f30f119242d6441146063fcf0957ce43'
       OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_snapshot #>> '{workspaceFiles,src/service.py}', 'UTF8')), 'hex') IS DISTINCT FROM '4097b58fe01238aaef7cb3c1689c619057c55ca363177e11dd1ca381091a80f0'
       OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_snapshot #>> '{workspaceFiles,src/state.py}', 'UTF8')), 'hex') IS DISTINCT FROM '6dc12fb0f53bc0989f0cbfaeeb80c7e3e86311604d645b734a6f1b82d18eba8b'
       OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_snapshot #>> '{workspaceFiles,tests/test_moves.py}', 'UTF8')), 'hex') IS DISTINCT FROM '09a4a8faed44eac4c5ce939684900ced1ec0a570439004fcc928381f0d170b5a'
       OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_snapshot #>> '{scenario,brief}', 'UTF8')), 'hex') IS DISTINCT FROM 'd460bf3b4dad0f10306a976781303e996822301db544ac6a3dbade649eb93c73' THEN
      RAISE EXCEPTION 'Approved assessment template does not match the reviewed version' USING ERRCODE = '23514';
    END IF;
  ELSIF v_scenario_id = 'reservation-moves' THEN
    RAISE EXCEPTION 'Approved scenario requires its explicit template' USING ERRCODE = '23514';
  END IF;

  v_task_rubric_snapshot := COALESCE(p_version_json -> 'taskRubricSnapshot', '{}'::pg_catalog.jsonb);

  IF p_version_json ->> 'durationSeconds' IS NOT NULL THEN
    v_duration_seconds := (p_version_json ->> 'durationSeconds')::pg_catalog.int4;
  ELSIF p_version_json ->> 'durationMinutes' IS NOT NULL THEN
    v_duration_seconds := (p_version_json ->> 'durationMinutes')::pg_catalog.int4 * 60;
  END IF;

  IF v_duration_seconds IS NULL OR v_duration_seconds NOT IN (1800, 2700, 3600, 5400) THEN
    RAISE EXCEPTION 'Invalid duration seconds' USING ERRCODE = '23514';
  END IF;

  v_terminal_enabled := COALESCE((p_version_json ->> 'terminalEnabled')::pg_catalog.bool, true);
  v_integrated_ai := COALESCE((p_version_json ->> 'integratedAi')::pg_catalog.bool, false);
  v_content_digest := p_version_json ->> 'contentDigest';
  IF v_content_digest IS NULL OR v_content_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid content digest' USING ERRCODE = '23514';
  END IF;

  v_validation_receipt := COALESCE(p_version_json -> 'validationReceipt', '{}'::pg_catalog.jsonb);

  IF p_version_json ->> 'versionNumber' IS NOT NULL THEN
    v_version_number := (p_version_json ->> 'versionNumber')::pg_catalog.int4;
  ELSE
    SELECT COALESCE(pg_catalog.max(version_number), 0) + 1
    INTO v_version_number
    FROM hirearchy.assessment_validated_versions
    WHERE definition_id = v_definition_id;
  END IF;

  INSERT INTO hirearchy.assessment_validated_versions (
    definition_id,
    organization_id,
    author_principal_id,
    version_number,
    content_digest,
    scenario_id,
    scenario_version,
    scenario_title,
    scenario_snapshot,
    task_rubric_snapshot,
    duration_seconds,
    terminal_enabled,
    integrated_ai,
    validation_receipt,
    created_at
  ) VALUES (
    v_definition_id,
    p_organization_id,
    v_principal_id,
    v_version_number,
    v_content_digest,
    v_scenario_id,
    v_scenario_version,
    v_scenario_title,
    v_scenario_snapshot,
    v_task_rubric_snapshot,
    v_duration_seconds,
    v_terminal_enabled,
    v_integrated_ai,
    v_validation_receipt,
    pg_catalog.clock_timestamp()
  ) RETURNING id INTO v_version_id;

  RETURN r211.format_validated_version(v_version_id);
END
$function$;

-- 5. get_validated_version
CREATE OR REPLACE FUNCTION r211.get_validated_version(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance text,
  p_organization_id pg_catalog.uuid,
  p_version_id pg_catalog.uuid
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_selected_organization_id pg_catalog.uuid;
  v_membership_role pg_catalog.text;
  v_row record;
BEGIN
  IF SESSION_USER NOT IN ('r23_gateway', 'app_evaluator') OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.11 assessment builder access denied' USING ERRCODE = '42501';
  END IF;

  IF p_subject_id IS NULL OR p_auth_session_id IS NULL
     OR p_assurance IS NULL OR p_assurance NOT IN ('aal1', 'aal2')
     OR p_organization_id IS NULL
     OR p_version_id IS NULL THEN
    RAISE EXCEPTION 'R2.11 validated version parameters are invalid' USING ERRCODE = '22023';
  END IF;

  v_principal_id := r23.current_principal(
    p_subject_id, p_auth_session_id, p_assurance
  );
  IF v_principal_id IS NULL THEN
    RAISE EXCEPTION 'Authentication session invalid' USING ERRCODE = 'R2401';
  END IF;

  SELECT session_row.selected_organization_id
  INTO v_selected_organization_id
  FROM r23.server_sessions AS session_row
  WHERE session_row.handle_hash = NULLIF(
    pg_catalog.current_setting('r23.session_handle_hash', true), ''
  )
    AND session_row.revoked_at IS NULL;
  IF NOT FOUND OR v_selected_organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'Organization selection mismatch' USING ERRCODE = 'R2401';
  END IF;

  SELECT membership.role INTO v_membership_role
  FROM hirearchy.organization_memberships AS membership
  WHERE membership.organization_id = p_organization_id
    AND membership.principal_id = v_principal_id
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE OF membership;
  IF NOT FOUND OR v_membership_role NOT IN ('recruiter', 'reviewer') THEN
    RAISE EXCEPTION 'Recruiter or reviewer role required' USING ERRCODE = 'R2401';
  END IF;

  PERFORM pg_catalog.set_config(
    'r211.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config(
    'r211.principal_id', v_principal_id::pg_catalog.text, true
  );

  SELECT id INTO v_row
  FROM hirearchy.assessment_validated_versions
  WHERE id = p_version_id AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN r211.format_validated_version(v_row.id);
END
$function$;

ALTER FUNCTION r211.format_draft(pg_catalog.uuid, pg_catalog.int8) OWNER TO r23_session_owner;
ALTER FUNCTION r211.format_validated_version(pg_catalog.uuid) OWNER TO r23_session_owner;
ALTER FUNCTION r211.save_assessment_draft(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.jsonb) OWNER TO r23_session_owner;
ALTER FUNCTION r211.get_assessment_draft(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.uuid) OWNER TO r23_session_owner;
ALTER FUNCTION r211.list_assessment_definitions(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) OWNER TO r23_session_owner;
ALTER FUNCTION r211.create_validated_version(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.jsonb) OWNER TO r23_session_owner;
ALTER FUNCTION r211.get_validated_version(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.uuid) OWNER TO r23_session_owner;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA r211 FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA r211 TO r23_session_owner, r23_gateway, app_evaluator;

COMMIT;
