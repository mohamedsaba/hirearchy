-- Disposable R2.9 evaluator observations fixture; never a production migration.
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
    RAISE EXCEPTION 'R2.9 observation roles are missing or unsafe';
  END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS r29 AUTHORIZATION r23_session_owner;
REVOKE ALL ON SCHEMA r29 FROM PUBLIC, r23_gateway, app_evaluator,
  app_candidate_gateway, app_control_worker;
GRANT USAGE ON SCHEMA r29 TO r23_gateway;
GRANT USAGE ON SCHEMA hirearchy TO r23_session_owner;

REVOKE ALL ON TABLE hirearchy.evaluator_observations,
  hirearchy.evaluator_observation_history
  FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway,
       app_control_worker;

GRANT SELECT, INSERT, UPDATE (body, version, updated_at)
  ON TABLE hirearchy.evaluator_observations TO r23_session_owner;

GRANT SELECT, INSERT
  ON TABLE hirearchy.evaluator_observation_history TO r23_session_owner;

GRANT SELECT ON TABLE hirearchy.candidate_file_revisions,
  hirearchy.candidate_session_events,
  hirearchy.candidate_session_submissions,
  hirearchy.assessment_sessions,
  hirearchy.organization_memberships,
  hirearchy.reviewer_assignments TO r23_session_owner;

DROP POLICY IF EXISTS r29_evaluator_observations_select
  ON hirearchy.evaluator_observations;
CREATE POLICY r29_evaluator_observations_select
  ON hirearchy.evaluator_observations
  FOR SELECT TO r23_session_owner
  USING (
    organization_id = NULLIF(
      pg_catalog.current_setting('r29.organization_id', true), ''
    )::pg_catalog.uuid
    AND session_id = NULLIF(
      pg_catalog.current_setting('r29.session_id', true), ''
    )
    AND author_principal_id = NULLIF(
      pg_catalog.current_setting('r29.principal_id', true), ''
    )::pg_catalog.uuid
    AND EXISTS (
      SELECT 1
      FROM hirearchy.organization_memberships AS membership
      JOIN hirearchy.reviewer_assignments AS assignment
        ON assignment.organization_id = membership.organization_id
       AND assignment.reviewer_principal_id = membership.principal_id
       AND assignment.session_id = evaluator_observations.session_id
       AND assignment.revoked_at IS NULL
      JOIN hirearchy.assessment_sessions AS session
        ON session.organization_id = assignment.organization_id
       AND session.id = assignment.session_id
       AND session.status = 'SUBMITTED'
      WHERE membership.organization_id = evaluator_observations.organization_id
        AND membership.principal_id = evaluator_observations.author_principal_id
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
  );

DROP POLICY IF EXISTS r29_evaluator_observations_insert
  ON hirearchy.evaluator_observations;
CREATE POLICY r29_evaluator_observations_insert
  ON hirearchy.evaluator_observations
  FOR INSERT TO r23_session_owner
  WITH CHECK (
    organization_id = NULLIF(
      pg_catalog.current_setting('r29.organization_id', true), ''
    )::pg_catalog.uuid
    AND session_id = NULLIF(
      pg_catalog.current_setting('r29.session_id', true), ''
    )
    AND author_principal_id = NULLIF(
      pg_catalog.current_setting('r29.principal_id', true), ''
    )::pg_catalog.uuid
    AND EXISTS (
      SELECT 1
      FROM hirearchy.organization_memberships AS membership
      JOIN hirearchy.reviewer_assignments AS assignment
        ON assignment.organization_id = membership.organization_id
       AND assignment.reviewer_principal_id = membership.principal_id
       AND assignment.session_id = evaluator_observations.session_id
       AND assignment.revoked_at IS NULL
      JOIN hirearchy.assessment_sessions AS session
        ON session.organization_id = assignment.organization_id
       AND session.id = assignment.session_id
       AND session.status = 'SUBMITTED'
      WHERE membership.organization_id = evaluator_observations.organization_id
        AND membership.principal_id = evaluator_observations.author_principal_id
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
  );

DROP POLICY IF EXISTS r29_evaluator_observations_update
  ON hirearchy.evaluator_observations;
CREATE POLICY r29_evaluator_observations_update
  ON hirearchy.evaluator_observations
  FOR UPDATE TO r23_session_owner
  USING (
    organization_id = NULLIF(
      pg_catalog.current_setting('r29.organization_id', true), ''
    )::pg_catalog.uuid
    AND session_id = NULLIF(
      pg_catalog.current_setting('r29.session_id', true), ''
    )
    AND author_principal_id = NULLIF(
      pg_catalog.current_setting('r29.principal_id', true), ''
    )::pg_catalog.uuid
    AND EXISTS (
      SELECT 1
      FROM hirearchy.organization_memberships AS membership
      JOIN hirearchy.reviewer_assignments AS assignment
        ON assignment.organization_id = membership.organization_id
       AND assignment.reviewer_principal_id = membership.principal_id
       AND assignment.session_id = evaluator_observations.session_id
       AND assignment.revoked_at IS NULL
      JOIN hirearchy.assessment_sessions AS session
        ON session.organization_id = assignment.organization_id
       AND session.id = assignment.session_id
       AND session.status = 'SUBMITTED'
      WHERE membership.organization_id = evaluator_observations.organization_id
        AND membership.principal_id = evaluator_observations.author_principal_id
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
  )
  WITH CHECK (
    organization_id = NULLIF(
      pg_catalog.current_setting('r29.organization_id', true), ''
    )::pg_catalog.uuid
    AND session_id = NULLIF(
      pg_catalog.current_setting('r29.session_id', true), ''
    )
    AND author_principal_id = NULLIF(
      pg_catalog.current_setting('r29.principal_id', true), ''
    )::pg_catalog.uuid
  );

DROP POLICY IF EXISTS r29_evaluator_observation_history_select
  ON hirearchy.evaluator_observation_history;
CREATE POLICY r29_evaluator_observation_history_select
  ON hirearchy.evaluator_observation_history
  FOR SELECT TO r23_session_owner
  USING (
    organization_id = NULLIF(
      pg_catalog.current_setting('r29.organization_id', true), ''
    )::pg_catalog.uuid
    AND session_id = NULLIF(
      pg_catalog.current_setting('r29.session_id', true), ''
    )
    AND author_principal_id = NULLIF(
      pg_catalog.current_setting('r29.principal_id', true), ''
    )::pg_catalog.uuid
    AND EXISTS (
      SELECT 1
      FROM hirearchy.organization_memberships AS membership
      JOIN hirearchy.reviewer_assignments AS assignment
        ON assignment.organization_id = membership.organization_id
       AND assignment.reviewer_principal_id = membership.principal_id
       AND assignment.session_id = evaluator_observation_history.session_id
       AND assignment.revoked_at IS NULL
      JOIN hirearchy.assessment_sessions AS session
        ON session.organization_id = assignment.organization_id
       AND session.id = assignment.session_id
       AND session.status = 'SUBMITTED'
      WHERE membership.organization_id = evaluator_observation_history.organization_id
        AND membership.principal_id = evaluator_observation_history.author_principal_id
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
  );

DROP POLICY IF EXISTS r29_evaluator_observation_history_insert
  ON hirearchy.evaluator_observation_history;
CREATE POLICY r29_evaluator_observation_history_insert
  ON hirearchy.evaluator_observation_history
  FOR INSERT TO r23_session_owner
  WITH CHECK (
    organization_id = NULLIF(
      pg_catalog.current_setting('r29.organization_id', true), ''
    )::pg_catalog.uuid
    AND session_id = NULLIF(
      pg_catalog.current_setting('r29.session_id', true), ''
    )
    AND author_principal_id = NULLIF(
      pg_catalog.current_setting('r29.principal_id', true), ''
    )::pg_catalog.uuid
  );

CREATE OR REPLACE FUNCTION r29.create_observation(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text,
  p_input pg_catalog.jsonb
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_selected_organization_id pg_catalog.uuid;
  v_membership_role pg_catalog.text;
  v_assignment_id pg_catalog.text;
  v_session_check_id pg_catalog.text;
  v_evidence_source_type pg_catalog.text;
  v_event_sequence_str pg_catalog.text;
  v_seq_num pg_catalog.int8;
  v_file_path pg_catalog.text;
  v_file_version_str pg_catalog.text;
  v_file_version_num pg_catalog.int8;
  v_evidence_digest pg_catalog.text;
  v_body pg_catalog.text;
  v_event record;
  v_revision record;
  v_obs record;
BEGIN
  IF SESSION_USER <> 'r23_gateway' OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.9 observation access denied' USING ERRCODE = '42501';
  END IF;

  IF p_subject_id IS NULL OR p_auth_session_id IS NULL
     OR p_assurance IS NULL OR p_assurance NOT IN ('aal1', 'aal2')
     OR p_organization_id IS NULL
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$'
     OR p_input IS NULL OR pg_catalog.jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'R2.9 observation parameters are invalid' USING ERRCODE = 'R2901';
  END IF;

  v_principal_id := r23.current_principal(
    p_subject_id, p_auth_session_id, p_assurance
  );
  IF v_principal_id IS NULL THEN RETURN NULL; END IF;

  SELECT session_row.selected_organization_id
  INTO v_selected_organization_id
  FROM r23.server_sessions AS session_row
  WHERE session_row.handle_hash = NULLIF(
    pg_catalog.current_setting('r23.session_handle_hash', true), ''
  )
    AND session_row.revoked_at IS NULL;
  IF NOT FOUND OR v_selected_organization_id IS DISTINCT FROM p_organization_id THEN
    RETURN NULL;
  END IF;

  PERFORM pg_catalog.set_config(
    'r23.organization_id', p_organization_id::pg_catalog.text, true
  );
  SELECT membership.role INTO v_membership_role
  FROM hirearchy.organization_memberships AS membership
  WHERE membership.organization_id = p_organization_id
    AND membership.principal_id = v_principal_id
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE OF membership;
  IF NOT FOUND OR v_membership_role <> 'reviewer' THEN RETURN NULL; END IF;

  SELECT assignment.id INTO v_assignment_id
  FROM hirearchy.reviewer_assignments AS assignment
  WHERE assignment.organization_id = p_organization_id
    AND assignment.session_id = p_session_id
    AND assignment.reviewer_principal_id = v_principal_id
    AND assignment.revoked_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT session.id INTO v_session_check_id
  FROM hirearchy.assessment_sessions AS session
  WHERE session.organization_id = p_organization_id
    AND session.id = p_session_id
    AND session.status = 'SUBMITTED';
  IF NOT FOUND THEN RETURN NULL; END IF;

  PERFORM pg_catalog.set_config(
    'r29.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config('r29.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config(
    'r29.principal_id', v_principal_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config(
    'r27.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config('r27.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config(
    'r27.principal_id', v_principal_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config(
    'r28.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config('r28.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config(
    'r28.principal_id', v_principal_id::pg_catalog.text, true
  );

  v_evidence_source_type := p_input ->> 'evidenceSourceType';
  v_event_sequence_str := p_input ->> 'eventSequence';
  v_file_path := p_input ->> 'filePath';
  v_file_version_str := p_input ->> 'fileVersion';
  v_evidence_digest := p_input ->> 'evidenceDigest';
  v_body := p_input ->> 'body';

  IF v_evidence_source_type IS NULL
     OR v_evidence_source_type NOT IN ('timeline_event', 'file_revision')
     OR v_event_sequence_str IS NULL
     OR v_event_sequence_str !~ '^[1-9][0-9]{0,18}$'
     OR v_event_sequence_str::pg_catalog.numeric > 9223372036854775807
     OR v_evidence_digest IS NULL
     OR v_evidence_digest !~ '^[0-9a-f]{64}$'
     OR v_body IS NULL
     OR pg_catalog.octet_length(pg_catalog.convert_to(v_body, 'UTF8')) < 1
     OR pg_catalog.octet_length(pg_catalog.convert_to(v_body, 'UTF8')) > 20000 THEN
    RAISE EXCEPTION 'R2.9 invalid observation input parameters' USING ERRCODE = 'R2901';
  END IF;

  v_seq_num := v_event_sequence_str::pg_catalog.int8;

  IF v_evidence_source_type = 'timeline_event' THEN
    IF (p_input -> 'filePath') IS NOT NULL AND pg_catalog.jsonb_typeof(p_input -> 'filePath') IS DISTINCT FROM 'null' THEN
      RAISE EXCEPTION 'Timeline event observation must not specify filePath' USING ERRCODE = 'R2901';
    END IF;
    IF (p_input -> 'fileVersion') IS NOT NULL AND pg_catalog.jsonb_typeof(p_input -> 'fileVersion') IS DISTINCT FROM 'null' THEN
      RAISE EXCEPTION 'Timeline event observation must not specify fileVersion' USING ERRCODE = 'R2901';
    END IF;

    SELECT event.* INTO v_event
    FROM hirearchy.candidate_session_events AS event
    WHERE event.organization_id = p_organization_id
      AND event.session_id = p_session_id
      AND event.sequence = v_seq_num;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Referenced timeline event not found' USING ERRCODE = 'R2902';
    END IF;

    IF NOT (
      v_evidence_digest = (v_event.payload ->> 'digest')
      OR v_evidence_digest = (v_event.payload ->> 'scenarioDigest')
      OR v_evidence_digest = (v_event.payload ->> 'workspaceDigest')
      OR v_evidence_digest = (v_event.payload ->> 'manifestDigest')
      OR v_evidence_digest = pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(v_event.payload::pg_catalog.text, 'UTF8')),
        'hex'
      )
    ) THEN
      RAISE EXCEPTION 'Timeline event evidence digest mismatch' USING ERRCODE = 'R2902';
    END IF;

    v_file_path := NULL;
    v_file_version_num := NULL;
  ELSE
    IF v_file_path IS NULL OR pg_catalog.btrim(v_file_path) = '' THEN
      RAISE EXCEPTION 'File revision observation requires filePath' USING ERRCODE = 'R2901';
    END IF;
    IF v_file_version_str IS NULL
       OR v_file_version_str !~ '^[1-9][0-9]{0,18}$'
       OR v_file_version_str::pg_catalog.numeric > 9223372036854775807 THEN
      RAISE EXCEPTION 'File revision observation requires valid fileVersion' USING ERRCODE = 'R2901';
    END IF;
    v_file_version_num := v_file_version_str::pg_catalog.int8;

    SELECT revision.* INTO v_revision
    FROM hirearchy.candidate_file_revisions AS revision
    WHERE revision.organization_id = p_organization_id
      AND revision.session_id = p_session_id
      AND revision.event_sequence = v_seq_num
      AND revision.file_path = v_file_path
      AND revision.version = v_file_version_num;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Referenced file revision not found' USING ERRCODE = 'R2902';
    END IF;

    IF v_revision.content_digest IS DISTINCT FROM v_evidence_digest THEN
      RAISE EXCEPTION 'File revision content digest mismatch' USING ERRCODE = 'R2902';
    END IF;
  END IF;

  INSERT INTO hirearchy.evaluator_observations (
    organization_id, session_id, author_principal_id,
    evidence_source_type, event_sequence, file_path, file_version,
    evidence_digest, body, version, visibility
  ) VALUES (
    p_organization_id, p_session_id, v_principal_id,
    v_evidence_source_type, v_seq_num, v_file_path, v_file_version_num,
    v_evidence_digest, v_body, 1, 'private'
  ) RETURNING * INTO v_obs;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_obs.id::pg_catalog.text,
    'organizationId', v_obs.organization_id::pg_catalog.text,
    'sessionId', v_obs.session_id,
    'authorPrincipalId', v_obs.author_principal_id::pg_catalog.text,
    'evidenceSourceType', v_obs.evidence_source_type,
    'eventSequence', v_obs.event_sequence::pg_catalog.text,
    'filePath', v_obs.file_path,
    'fileVersion', CASE WHEN v_obs.file_version IS NOT NULL THEN v_obs.file_version::pg_catalog.text ELSE NULL END,
    'evidenceDigest', v_obs.evidence_digest,
    'body', v_obs.body,
    'version', v_obs.version,
    'visibility', v_obs.visibility,
    'createdAt', pg_catalog.to_char(v_obs.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updatedAt', pg_catalog.to_char(v_obs.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
END
$function$;

CREATE OR REPLACE FUNCTION r29.update_observation(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text,
  p_observation_id pg_catalog.uuid,
  p_input pg_catalog.jsonb
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_selected_organization_id pg_catalog.uuid;
  v_membership_role pg_catalog.text;
  v_assignment_id pg_catalog.text;
  v_session_check_id pg_catalog.text;
  v_expected_version pg_catalog.int8;
  v_body pg_catalog.text;
  v_obs record;
  v_updated_obs record;
BEGIN
  IF SESSION_USER <> 'r23_gateway' OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.9 observation access denied' USING ERRCODE = '42501';
  END IF;

  IF p_subject_id IS NULL OR p_auth_session_id IS NULL
     OR p_assurance IS NULL OR p_assurance NOT IN ('aal1', 'aal2')
     OR p_organization_id IS NULL
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$'
     OR p_observation_id IS NULL
     OR p_input IS NULL OR pg_catalog.jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'R2.9 observation parameters are invalid' USING ERRCODE = 'R2901';
  END IF;

  v_principal_id := r23.current_principal(
    p_subject_id, p_auth_session_id, p_assurance
  );
  IF v_principal_id IS NULL THEN RETURN NULL; END IF;

  SELECT session_row.selected_organization_id
  INTO v_selected_organization_id
  FROM r23.server_sessions AS session_row
  WHERE session_row.handle_hash = NULLIF(
    pg_catalog.current_setting('r23.session_handle_hash', true), ''
  )
    AND session_row.revoked_at IS NULL;
  IF NOT FOUND OR v_selected_organization_id IS DISTINCT FROM p_organization_id THEN
    RETURN NULL;
  END IF;

  PERFORM pg_catalog.set_config(
    'r23.organization_id', p_organization_id::pg_catalog.text, true
  );
  SELECT membership.role INTO v_membership_role
  FROM hirearchy.organization_memberships AS membership
  WHERE membership.organization_id = p_organization_id
    AND membership.principal_id = v_principal_id
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE OF membership;
  IF NOT FOUND OR v_membership_role <> 'reviewer' THEN RETURN NULL; END IF;

  SELECT assignment.id INTO v_assignment_id
  FROM hirearchy.reviewer_assignments AS assignment
  WHERE assignment.organization_id = p_organization_id
    AND assignment.session_id = p_session_id
    AND assignment.reviewer_principal_id = v_principal_id
    AND assignment.revoked_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT session.id INTO v_session_check_id
  FROM hirearchy.assessment_sessions AS session
  WHERE session.organization_id = p_organization_id
    AND session.id = p_session_id
    AND session.status = 'SUBMITTED';
  IF NOT FOUND THEN RETURN NULL; END IF;

  PERFORM pg_catalog.set_config(
    'r29.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config('r29.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config(
    'r29.principal_id', v_principal_id::pg_catalog.text, true
  );

  IF NOT (p_input ? 'expectedVersion')
     OR pg_catalog.jsonb_typeof(p_input -> 'expectedVersion') IS DISTINCT FROM 'number'
     OR (p_input ->> 'expectedVersion') !~ '^[1-9][0-9]{0,18}$'
     OR (p_input ->> 'expectedVersion')::pg_catalog.numeric > 9223372036854775807
     OR NOT (p_input ? 'body')
     OR pg_catalog.jsonb_typeof(p_input -> 'body') IS DISTINCT FROM 'string'
     OR pg_catalog.octet_length(pg_catalog.convert_to(p_input ->> 'body', 'UTF8')) < 1
     OR pg_catalog.octet_length(pg_catalog.convert_to(p_input ->> 'body', 'UTF8')) > 20000 THEN
    RAISE EXCEPTION 'R2.9 invalid observation update parameters' USING ERRCODE = 'R2901';
  END IF;

  v_expected_version := (p_input ->> 'expectedVersion')::pg_catalog.int8;
  v_body := p_input ->> 'body';

  SELECT obs.* INTO v_obs
  FROM hirearchy.evaluator_observations AS obs
  WHERE obs.id = p_observation_id
    AND obs.organization_id = p_organization_id
    AND obs.session_id = p_session_id
    AND obs.author_principal_id = v_principal_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_obs.version <> v_expected_version THEN
    RAISE EXCEPTION 'Concurrency conflict on observation update' USING ERRCODE = 'R2904';
  END IF;

  INSERT INTO hirearchy.evaluator_observation_history (
    observation_id, organization_id, session_id, author_principal_id,
    version, body, evidence_source_type, event_sequence,
    file_path, file_version, evidence_digest, visibility,
    valid_from, valid_until
  ) VALUES (
    v_obs.id, v_obs.organization_id, v_obs.session_id, v_obs.author_principal_id,
    v_obs.version, v_obs.body, v_obs.evidence_source_type, v_obs.event_sequence,
    v_obs.file_path, v_obs.file_version, v_obs.evidence_digest, v_obs.visibility,
    v_obs.updated_at, pg_catalog.clock_timestamp()
  );

  UPDATE hirearchy.evaluator_observations
  SET body = v_body,
      version = v_obs.version + 1,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = v_obs.id
  RETURNING * INTO v_updated_obs;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_updated_obs.id::pg_catalog.text,
    'organizationId', v_updated_obs.organization_id::pg_catalog.text,
    'sessionId', v_updated_obs.session_id,
    'authorPrincipalId', v_updated_obs.author_principal_id::pg_catalog.text,
    'evidenceSourceType', v_updated_obs.evidence_source_type,
    'eventSequence', v_updated_obs.event_sequence::pg_catalog.text,
    'filePath', v_updated_obs.file_path,
    'fileVersion', CASE WHEN v_updated_obs.file_version IS NOT NULL THEN v_updated_obs.file_version::pg_catalog.text ELSE NULL END,
    'evidenceDigest', v_updated_obs.evidence_digest,
    'body', v_updated_obs.body,
    'version', v_updated_obs.version,
    'visibility', v_updated_obs.visibility,
    'createdAt', pg_catalog.to_char(v_updated_obs.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updatedAt', pg_catalog.to_char(v_updated_obs.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
END
$function$;

CREATE OR REPLACE FUNCTION r29.list_observations(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_selected_organization_id pg_catalog.uuid;
  v_membership_role pg_catalog.text;
  v_assignment_id pg_catalog.text;
  v_session_check_id pg_catalog.text;
  v_result pg_catalog.jsonb;
BEGIN
  IF SESSION_USER <> 'r23_gateway' OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.9 observation access denied' USING ERRCODE = '42501';
  END IF;

  IF p_subject_id IS NULL OR p_auth_session_id IS NULL
     OR p_assurance IS NULL OR p_assurance NOT IN ('aal1', 'aal2')
     OR p_organization_id IS NULL
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$' THEN
    RAISE EXCEPTION 'R2.9 observation query is invalid' USING ERRCODE = 'R2901';
  END IF;

  v_principal_id := r23.current_principal(
    p_subject_id, p_auth_session_id, p_assurance
  );
  IF v_principal_id IS NULL THEN RETURN NULL; END IF;

  SELECT session_row.selected_organization_id
  INTO v_selected_organization_id
  FROM r23.server_sessions AS session_row
  WHERE session_row.handle_hash = NULLIF(
    pg_catalog.current_setting('r23.session_handle_hash', true), ''
  )
    AND session_row.revoked_at IS NULL;
  IF NOT FOUND OR v_selected_organization_id IS DISTINCT FROM p_organization_id THEN
    RETURN NULL;
  END IF;

  PERFORM pg_catalog.set_config(
    'r23.organization_id', p_organization_id::pg_catalog.text, true
  );
  SELECT membership.role INTO v_membership_role
  FROM hirearchy.organization_memberships AS membership
  WHERE membership.organization_id = p_organization_id
    AND membership.principal_id = v_principal_id
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE OF membership;
  IF NOT FOUND OR v_membership_role <> 'reviewer' THEN RETURN NULL; END IF;

  SELECT assignment.id INTO v_assignment_id
  FROM hirearchy.reviewer_assignments AS assignment
  WHERE assignment.organization_id = p_organization_id
    AND assignment.session_id = p_session_id
    AND assignment.reviewer_principal_id = v_principal_id
    AND assignment.revoked_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT session.id INTO v_session_check_id
  FROM hirearchy.assessment_sessions AS session
  WHERE session.organization_id = p_organization_id
    AND session.id = p_session_id
    AND session.status = 'SUBMITTED';
  IF NOT FOUND THEN RETURN NULL; END IF;

  PERFORM pg_catalog.set_config(
    'r29.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config('r29.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config(
    'r29.principal_id', v_principal_id::pg_catalog.text, true
  );

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', obs.id::pg_catalog.text,
        'organizationId', obs.organization_id::pg_catalog.text,
        'sessionId', obs.session_id,
        'authorPrincipalId', obs.author_principal_id::pg_catalog.text,
        'evidenceSourceType', obs.evidence_source_type,
        'eventSequence', obs.event_sequence::pg_catalog.text,
        'filePath', obs.file_path,
        'fileVersion', CASE WHEN obs.file_version IS NOT NULL THEN obs.file_version::pg_catalog.text ELSE NULL END,
        'evidenceDigest', obs.evidence_digest,
        'body', obs.body,
        'version', obs.version,
        'visibility', obs.visibility,
        'createdAt', pg_catalog.to_char(obs.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'updatedAt', pg_catalog.to_char(obs.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) ORDER BY obs.created_at ASC, obs.id ASC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_result
  FROM hirearchy.evaluator_observations AS obs
  WHERE obs.organization_id = p_organization_id
    AND obs.session_id = p_session_id
    AND obs.author_principal_id = v_principal_id;

  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION r29.get_observation(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text,
  p_observation_id pg_catalog.uuid
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_selected_organization_id pg_catalog.uuid;
  v_membership_role pg_catalog.text;
  v_assignment_id pg_catalog.text;
  v_session_check_id pg_catalog.text;
  v_obs record;
  v_history pg_catalog.jsonb;
BEGIN
  IF SESSION_USER <> 'r23_gateway' OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.9 observation access denied' USING ERRCODE = '42501';
  END IF;

  IF p_subject_id IS NULL OR p_auth_session_id IS NULL
     OR p_assurance IS NULL OR p_assurance NOT IN ('aal1', 'aal2')
     OR p_organization_id IS NULL
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$'
     OR p_observation_id IS NULL THEN
    RAISE EXCEPTION 'R2.9 observation query is invalid' USING ERRCODE = 'R2901';
  END IF;

  v_principal_id := r23.current_principal(
    p_subject_id, p_auth_session_id, p_assurance
  );
  IF v_principal_id IS NULL THEN RETURN NULL; END IF;

  SELECT session_row.selected_organization_id
  INTO v_selected_organization_id
  FROM r23.server_sessions AS session_row
  WHERE session_row.handle_hash = NULLIF(
    pg_catalog.current_setting('r23.session_handle_hash', true), ''
  )
    AND session_row.revoked_at IS NULL;
  IF NOT FOUND OR v_selected_organization_id IS DISTINCT FROM p_organization_id THEN
    RETURN NULL;
  END IF;

  PERFORM pg_catalog.set_config(
    'r23.organization_id', p_organization_id::pg_catalog.text, true
  );
  SELECT membership.role INTO v_membership_role
  FROM hirearchy.organization_memberships AS membership
  WHERE membership.organization_id = p_organization_id
    AND membership.principal_id = v_principal_id
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE OF membership;
  IF NOT FOUND OR v_membership_role <> 'reviewer' THEN RETURN NULL; END IF;

  SELECT assignment.id INTO v_assignment_id
  FROM hirearchy.reviewer_assignments AS assignment
  WHERE assignment.organization_id = p_organization_id
    AND assignment.session_id = p_session_id
    AND assignment.reviewer_principal_id = v_principal_id
    AND assignment.revoked_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT session.id INTO v_session_check_id
  FROM hirearchy.assessment_sessions AS session
  WHERE session.organization_id = p_organization_id
    AND session.id = p_session_id
    AND session.status = 'SUBMITTED';
  IF NOT FOUND THEN RETURN NULL; END IF;

  PERFORM pg_catalog.set_config(
    'r29.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config('r29.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config(
    'r29.principal_id', v_principal_id::pg_catalog.text, true
  );

  SELECT obs.* INTO v_obs
  FROM hirearchy.evaluator_observations AS obs
  WHERE obs.id = p_observation_id
    AND obs.organization_id = p_organization_id
    AND obs.session_id = p_session_id
    AND obs.author_principal_id = v_principal_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'historyId', h.history_id::pg_catalog.text,
        'observationId', h.observation_id::pg_catalog.text,
        'version', h.version,
        'body', h.body,
        'evidenceSourceType', h.evidence_source_type,
        'eventSequence', h.event_sequence::pg_catalog.text,
        'filePath', h.file_path,
        'fileVersion', CASE WHEN h.file_version IS NOT NULL THEN h.file_version::pg_catalog.text ELSE NULL END,
        'evidenceDigest', h.evidence_digest,
        'visibility', h.visibility,
        'validFrom', pg_catalog.to_char(h.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'validUntil', pg_catalog.to_char(h.valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'recordedAt', pg_catalog.to_char(h.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) ORDER BY h.version ASC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_history
  FROM hirearchy.evaluator_observation_history AS h
  WHERE h.observation_id = v_obs.id;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_obs.id::pg_catalog.text,
    'organizationId', v_obs.organization_id::pg_catalog.text,
    'sessionId', v_obs.session_id,
    'authorPrincipalId', v_obs.author_principal_id::pg_catalog.text,
    'evidenceSourceType', v_obs.evidence_source_type,
    'eventSequence', v_obs.event_sequence::pg_catalog.text,
    'filePath', v_obs.file_path,
    'fileVersion', CASE WHEN v_obs.file_version IS NOT NULL THEN v_obs.file_version::pg_catalog.text ELSE NULL END,
    'evidenceDigest', v_obs.evidence_digest,
    'body', v_obs.body,
    'version', v_obs.version,
    'visibility', v_obs.visibility,
    'createdAt', pg_catalog.to_char(v_obs.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updatedAt', pg_catalog.to_char(v_obs.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'history', v_history
  );
END
$function$;

ALTER FUNCTION r29.create_observation(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid,
  pg_catalog.text, pg_catalog.jsonb
) OWNER TO r23_session_owner;

ALTER FUNCTION r29.update_observation(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid,
  pg_catalog.text, pg_catalog.uuid, pg_catalog.jsonb
) OWNER TO r23_session_owner;

ALTER FUNCTION r29.list_observations(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid,
  pg_catalog.text
) OWNER TO r23_session_owner;

ALTER FUNCTION r29.get_observation(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid,
  pg_catalog.text, pg_catalog.uuid
) OWNER TO r23_session_owner;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA r29 FROM PUBLIC, r23_gateway,
  app_evaluator, app_candidate_gateway, app_control_worker;

GRANT EXECUTE ON FUNCTION r29.create_observation(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid,
  pg_catalog.text, pg_catalog.jsonb
) TO r23_gateway;

GRANT EXECUTE ON FUNCTION r29.update_observation(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid,
  pg_catalog.text, pg_catalog.uuid, pg_catalog.jsonb
) TO r23_gateway;

GRANT EXECUTE ON FUNCTION r29.list_observations(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid,
  pg_catalog.text
) TO r23_gateway;

GRANT EXECUTE ON FUNCTION r29.get_observation(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid,
  pg_catalog.text, pg_catalog.uuid
) TO r23_gateway;

COMMIT;
