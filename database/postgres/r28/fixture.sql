-- Disposable R2.8 read-only evaluator revision fixture; never a production migration.
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
    RAISE EXCEPTION 'R2.8 revision roles are missing or unsafe';
  END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS r28 AUTHORIZATION r23_session_owner;
REVOKE ALL ON SCHEMA r28 FROM PUBLIC, r23_gateway, app_evaluator,
  app_candidate_gateway, app_control_worker;
GRANT USAGE ON SCHEMA r28 TO r23_gateway;
GRANT USAGE ON SCHEMA hirearchy TO r23_session_owner;

REVOKE ALL ON TABLE hirearchy.candidate_file_revisions
  FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway,
       app_control_worker;
GRANT SELECT ON TABLE hirearchy.candidate_file_revisions,
  hirearchy.candidate_session_events,
  hirearchy.candidate_session_submissions TO r23_session_owner;

DROP POLICY IF EXISTS r28_candidate_file_revisions_select
  ON hirearchy.candidate_file_revisions;
CREATE POLICY r28_candidate_file_revisions_select
  ON hirearchy.candidate_file_revisions
  FOR SELECT TO r23_session_owner
  USING (
    organization_id = NULLIF(
      pg_catalog.current_setting('r28.organization_id', true), ''
    )::pg_catalog.uuid
    AND session_id = NULLIF(
      pg_catalog.current_setting('r28.session_id', true), ''
    )
    AND EXISTS (
      SELECT 1
      FROM hirearchy.organization_memberships AS membership
      JOIN hirearchy.reviewer_assignments AS assignment
        ON assignment.organization_id = membership.organization_id
       AND assignment.reviewer_principal_id = membership.principal_id
       AND assignment.session_id = candidate_file_revisions.session_id
       AND assignment.revoked_at IS NULL
      JOIN hirearchy.assessment_sessions AS session
        ON session.organization_id = assignment.organization_id
       AND session.id = assignment.session_id
       AND session.status = 'SUBMITTED'
      WHERE membership.organization_id = candidate_file_revisions.organization_id
        AND membership.principal_id = NULLIF(
          pg_catalog.current_setting('r28.principal_id', true), ''
        )::pg_catalog.uuid
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
  );

DROP POLICY IF EXISTS r28_candidate_events_select
  ON hirearchy.candidate_session_events;
CREATE POLICY r28_candidate_events_select
  ON hirearchy.candidate_session_events
  FOR SELECT TO r23_session_owner
  USING (
    organization_id = NULLIF(
      pg_catalog.current_setting('r28.organization_id', true), ''
    )::pg_catalog.uuid
    AND session_id = NULLIF(
      pg_catalog.current_setting('r28.session_id', true), ''
    )
    AND EXISTS (
      SELECT 1
      FROM hirearchy.organization_memberships AS membership
      JOIN hirearchy.reviewer_assignments AS assignment
        ON assignment.organization_id = membership.organization_id
       AND assignment.reviewer_principal_id = membership.principal_id
       AND assignment.session_id = candidate_session_events.session_id
       AND assignment.revoked_at IS NULL
      JOIN hirearchy.assessment_sessions AS session
        ON session.organization_id = assignment.organization_id
       AND session.id = assignment.session_id
       AND session.status = 'SUBMITTED'
      WHERE membership.organization_id = candidate_session_events.organization_id
        AND membership.principal_id = NULLIF(
          pg_catalog.current_setting('r28.principal_id', true), ''
        )::pg_catalog.uuid
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
  );

DROP POLICY IF EXISTS r28_candidate_submissions_select
  ON hirearchy.candidate_session_submissions;
CREATE POLICY r28_candidate_submissions_select
  ON hirearchy.candidate_session_submissions
  FOR SELECT TO r23_session_owner
  USING (
    organization_id = NULLIF(
      pg_catalog.current_setting('r28.organization_id', true), ''
    )::pg_catalog.uuid
    AND session_id = NULLIF(
      pg_catalog.current_setting('r28.session_id', true), ''
    )
    AND EXISTS (
      SELECT 1
      FROM hirearchy.organization_memberships AS membership
      JOIN hirearchy.reviewer_assignments AS assignment
        ON assignment.organization_id = membership.organization_id
       AND assignment.reviewer_principal_id = membership.principal_id
       AND assignment.session_id = candidate_session_submissions.session_id
       AND assignment.revoked_at IS NULL
      JOIN hirearchy.assessment_sessions AS session
        ON session.organization_id = assignment.organization_id
       AND session.id = assignment.session_id
       AND session.status = 'SUBMITTED'
      WHERE membership.organization_id = candidate_session_submissions.organization_id
        AND membership.principal_id = NULLIF(
          pg_catalog.current_setting('r28.principal_id', true), ''
        )::pg_catalog.uuid
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
  );

CREATE OR REPLACE FUNCTION r28.get_file_revision(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text,
  p_sequence pg_catalog.text
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_selected_organization_id pg_catalog.uuid;
  v_membership_role pg_catalog.text;
  v_assignment record;
  v_session record;
  v_event record;
  v_revision record;
  v_snapshot pg_catalog.jsonb;
  v_starter_files pg_catalog.jsonb;
  v_starter_content pg_catalog.text;
  v_previous_content pg_catalog.text;
  v_submitted_content pg_catalog.text;
  v_submitted_digest pg_catalog.text;
  v_submitted_version pg_catalog.text;
  v_is_submitted boolean := false;
  v_seq_num pg_catalog.int8;
  v_target_file_path pg_catalog.text;
  v_target_version pg_catalog.int8;
  v_target_prev_version pg_catalog.int8;
BEGIN
  IF SESSION_USER <> 'r23_gateway' OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.8 revision access denied' USING ERRCODE = '42501';
  END IF;

  IF p_subject_id IS NULL OR p_auth_session_id IS NULL
     OR p_assurance IS NULL OR p_assurance NOT IN ('aal1', 'aal2')
     OR p_organization_id IS NULL
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$'
     OR p_sequence IS NULL
     OR p_sequence !~ '^[1-9][0-9]{0,18}$'
     OR p_sequence::pg_catalog.numeric > 9223372036854775807 THEN
    RAISE EXCEPTION 'R2.8 revision query is invalid' USING ERRCODE = 'R2801';
  END IF;

  v_seq_num := p_sequence::pg_catalog.int8;

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

  SELECT assignment.id, assignment.version, assignment.assigned_at
  INTO v_assignment
  FROM hirearchy.reviewer_assignments AS assignment
  WHERE assignment.organization_id = p_organization_id
    AND assignment.session_id = p_session_id
    AND assignment.reviewer_principal_id = v_principal_id
    AND assignment.revoked_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;

  PERFORM pg_catalog.set_config(
    'r28.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config('r28.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config(
    'r28.principal_id', v_principal_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config(
    'r27.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config('r27.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config(
    'r27.principal_id', v_principal_id::pg_catalog.text, true
  );

  SELECT session.* INTO v_session
  FROM hirearchy.assessment_sessions AS session
  WHERE session.organization_id = p_organization_id
    AND session.id = p_session_id
    AND session.status = 'SUBMITTED';
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Lookup event sequence in candidate_session_events
  SELECT event.* INTO v_event
  FROM hirearchy.candidate_session_events AS event
  WHERE event.organization_id = p_organization_id
    AND event.session_id = p_session_id
    AND event.sequence = v_seq_num;
  IF NOT FOUND OR v_event.event_type <> 'WORKSPACE_CHANGED' THEN
    RETURN NULL;
  END IF;

  -- Parse scenario snapshot for starterFiles
  BEGIN
    v_snapshot := v_session.scenario_snapshot::pg_catalog.jsonb;
    v_starter_files := v_snapshot -> 'workspaceFiles';
    IF pg_catalog.jsonb_typeof(v_starter_files) IS DISTINCT FROM 'object' THEN
      v_starter_files := NULL;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_starter_files := NULL;
  END;

  -- Query candidate_file_revisions
  SELECT revision.* INTO v_revision
  FROM hirearchy.candidate_file_revisions AS revision
  WHERE revision.organization_id = p_organization_id
    AND revision.session_id = p_session_id
    AND revision.event_sequence = v_seq_num;

  IF FOUND THEN
    v_target_file_path := v_revision.file_path;
    v_target_version := v_revision.version;
    v_target_prev_version := v_revision.previous_version;

    -- starterContent
    IF v_starter_files IS NOT NULL AND v_starter_files ? v_target_file_path THEN
      v_starter_content := v_starter_files ->> v_target_file_path;
    ELSE
      v_starter_content := NULL;
    END IF;

    -- previousContent
    IF v_target_prev_version = 0 THEN
      v_previous_content := v_starter_content;
    ELSE
      SELECT prev.content INTO v_previous_content
      FROM hirearchy.candidate_file_revisions AS prev
      WHERE prev.organization_id = p_organization_id
        AND prev.session_id = p_session_id
        AND prev.file_path = v_target_file_path
        AND prev.version = v_target_prev_version;
    END IF;

    -- submittedContent & isSubmitted
    SELECT file.value ->> 'content', file.value ->> 'digest', file.value ->> 'version'
    INTO v_submitted_content, v_submitted_digest, v_submitted_version
    FROM hirearchy.candidate_session_submissions AS sub,
         pg_catalog.jsonb_array_elements(sub.manifest) AS file(value)
    WHERE sub.organization_id = p_organization_id
      AND sub.session_id = p_session_id
      AND file.value ->> 'path' = v_target_file_path;

    IF v_submitted_version IS NOT NULL
       AND v_submitted_version = v_target_version::pg_catalog.text
       AND v_submitted_digest = v_revision.content_digest THEN
      v_is_submitted := true;
    ELSE
      v_is_submitted := false;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'organizationId', p_organization_id::pg_catalog.text,
      'sessionId', p_session_id,
      'filePath', v_target_file_path,
      'version', v_target_version::pg_catalog.text,
      'requestId', v_revision.request_id,
      'eventSequence', v_seq_num::pg_catalog.text,
      'acceptedAt', pg_catalog.to_char(
        v_revision.accepted_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'contentEncoding', v_revision.content_encoding,
      'content', v_revision.content,
      'contentLength', v_revision.content_length,
      'contentDigest', v_revision.content_digest,
      'previousVersion', v_target_prev_version::pg_catalog.text,
      'previousDigest', v_revision.previous_digest,
      'previousContent', v_previous_content,
      'starterContent', v_starter_content,
      'submittedContent', v_submitted_content,
      'isSubmitted', v_is_submitted,
      'availability', 'available',
      'provenance', 'hirearchy.candidate_file_revisions'
    );
  ELSE
    -- Historical pre-R2.8 or missing revision row
    v_target_file_path := v_event.payload ->> 'path';
    v_target_version := (v_event.payload ->> 'version')::pg_catalog.int8;
    v_target_prev_version := (v_event.payload ->> 'previousVersion')::pg_catalog.int8;

    -- starterContent
    IF v_starter_files IS NOT NULL AND v_starter_files ? v_target_file_path THEN
      v_starter_content := v_starter_files ->> v_target_file_path;
    ELSE
      v_starter_content := NULL;
    END IF;

    -- previousContent
    IF v_target_prev_version = 0 THEN
      v_previous_content := v_starter_content;
    ELSE
      v_previous_content := NULL;
    END IF;

    -- submittedContent & isSubmitted
    SELECT file.value ->> 'content', file.value ->> 'digest', file.value ->> 'version'
    INTO v_submitted_content, v_submitted_digest, v_submitted_version
    FROM hirearchy.candidate_session_submissions AS sub,
         pg_catalog.jsonb_array_elements(sub.manifest) AS file(value)
    WHERE sub.organization_id = p_organization_id
      AND sub.session_id = p_session_id
      AND file.value ->> 'path' = v_target_file_path;

    IF v_submitted_version IS NOT NULL
       AND v_submitted_version = v_target_version::pg_catalog.text
       AND v_submitted_digest = (v_event.payload ->> 'digest') THEN
      v_is_submitted := true;
    ELSE
      v_is_submitted := false;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'organizationId', p_organization_id::pg_catalog.text,
      'sessionId', p_session_id,
      'filePath', v_target_file_path,
      'version', (v_event.payload ->> 'version'),
      'requestId', (v_event.payload ->> 'requestId'),
      'eventSequence', v_seq_num::pg_catalog.text,
      'acceptedAt', pg_catalog.to_char(
        v_event.happened_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'contentEncoding', 'utf-8',
      'content', NULL,
      'contentLength', 0,
      'contentDigest', (v_event.payload ->> 'digest'),
      'previousVersion', (v_event.payload ->> 'previousVersion'),
      'previousDigest', (v_event.payload ->> 'previousDigest'),
      'previousContent', v_previous_content,
      'starterContent', v_starter_content,
      'submittedContent', v_submitted_content,
      'isSubmitted', v_is_submitted,
      'availability', 'unavailable',
      'provenance', 'hirearchy.candidate_session_events',
      'limitations', pg_catalog.jsonb_build_array(
        'Intermediate file contents were not retained; save events provide metadata only.'
      )
    );
  END IF;
END
$function$;

ALTER FUNCTION r28.get_file_revision(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid,
  pg_catalog.text, pg_catalog.text
) OWNER TO r23_session_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA r28 FROM PUBLIC, r23_gateway,
  app_evaluator, app_candidate_gateway, app_control_worker;
GRANT EXECUTE ON FUNCTION r28.get_file_revision(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid,
  pg_catalog.text, pg_catalog.text
) TO r23_gateway;

COMMIT;
