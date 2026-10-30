-- Disposable R2.7 read-only evaluator evidence fixture; never a production migration.
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
    RAISE EXCEPTION 'R2.7 evidence roles are missing or unsafe';
  END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS r27 AUTHORIZATION r23_session_owner;
REVOKE ALL ON SCHEMA r27 FROM PUBLIC, r23_gateway, app_evaluator,
  app_candidate_gateway, app_control_worker;
GRANT USAGE ON SCHEMA r27 TO r23_gateway;
GRANT USAGE ON SCHEMA hirearchy TO r23_session_owner;

REVOKE ALL ON TABLE hirearchy.candidate_session_events,
  hirearchy.candidate_session_submissions
  FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway,
       app_control_worker;
GRANT SELECT ON TABLE hirearchy.candidate_session_events,
  hirearchy.candidate_session_submissions TO r23_session_owner;

DO $r27_ai_grants$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_tables
    WHERE schemaname = 'hirearchy' AND tablename = 'candidate_ai_interactions'
  ) THEN
    EXECUTE 'GRANT SELECT ON TABLE hirearchy.candidate_ai_interactions TO r23_session_owner';
    EXECUTE 'DROP POLICY IF EXISTS r27_candidate_ai_interactions_select ON hirearchy.candidate_ai_interactions';
    EXECUTE $policy$
      CREATE POLICY r27_candidate_ai_interactions_select
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
$r27_ai_grants$;

DO $r27_execution_grants$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_tables
    WHERE schemaname = 'hirearchy' AND tablename = 'candidate_execution_operations'
  ) THEN
    EXECUTE 'GRANT SELECT ON TABLE hirearchy.candidate_execution_operations TO r23_session_owner';
    EXECUTE 'DROP POLICY IF EXISTS r27_candidate_execution_operations_select ON hirearchy.candidate_execution_operations';
    EXECUTE $policy$
      CREATE POLICY r27_candidate_execution_operations_select
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
$r27_execution_grants$;

DROP POLICY IF EXISTS r27_candidate_events_select
  ON hirearchy.candidate_session_events;
CREATE POLICY r27_candidate_events_select
  ON hirearchy.candidate_session_events
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
       AND assignment.session_id = candidate_session_events.session_id
       AND assignment.revoked_at IS NULL
      JOIN hirearchy.assessment_sessions AS session
        ON session.organization_id = assignment.organization_id
       AND session.id = assignment.session_id
       AND session.status = 'SUBMITTED'
      WHERE membership.organization_id = candidate_session_events.organization_id
        AND membership.principal_id = NULLIF(
          pg_catalog.current_setting('r27.principal_id', true), ''
        )::pg_catalog.uuid
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
  );

DROP POLICY IF EXISTS r27_candidate_submissions_select
  ON hirearchy.candidate_session_submissions;
CREATE POLICY r27_candidate_submissions_select
  ON hirearchy.candidate_session_submissions
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
       AND assignment.session_id = candidate_session_submissions.session_id
       AND assignment.revoked_at IS NULL
      JOIN hirearchy.assessment_sessions AS session
        ON session.organization_id = assignment.organization_id
       AND session.id = assignment.session_id
       AND session.status = 'SUBMITTED'
      WHERE membership.organization_id = candidate_session_submissions.organization_id
        AND membership.principal_id = NULLIF(
          pg_catalog.current_setting('r27.principal_id', true), ''
        )::pg_catalog.uuid
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
  );

CREATE OR REPLACE FUNCTION r27.get_submitted_evidence(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text,
  p_after_sequence pg_catalog.text,
  p_limit pg_catalog.int4
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
  v_submission record;
  v_snapshot pg_catalog.jsonb;
  v_starter_files pg_catalog.jsonb;
  v_manifest pg_catalog.jsonb;
  v_identity pg_catalog.jsonb;
  v_manifest_text pg_catalog.text;
  v_identity_text pg_catalog.text;
  v_manifest_digest pg_catalog.text;
  v_workspace_digest pg_catalog.text;
  v_total_bytes pg_catalog.int8 := 0;
  v_file record;
  v_page pg_catalog.jsonb;
  v_closure_event boolean;
  v_file_count pg_catalog.int8;
  v_unique_path_count pg_catalog.int8;
BEGIN
  IF SESSION_USER <> 'r23_gateway' OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.7 evidence access denied' USING ERRCODE = '42501';
  END IF;
  IF p_subject_id IS NULL OR p_auth_session_id IS NULL
     OR p_assurance IS NULL OR p_assurance NOT IN ('aal1', 'aal2')
     OR p_organization_id IS NULL
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$'
     OR p_after_sequence IS NULL
     OR p_after_sequence !~ '^(0|[1-9][0-9]{0,18})$'
     OR p_after_sequence::pg_catalog.numeric > 9223372036854775807
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'R2.7 evidence query is invalid' USING ERRCODE = 'R2701';
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

  SELECT assignment.id, assignment.version, assignment.assigned_at
  INTO v_assignment
  FROM hirearchy.reviewer_assignments AS assignment
  WHERE assignment.organization_id = p_organization_id
    AND assignment.session_id = p_session_id
    AND assignment.reviewer_principal_id = v_principal_id
    AND assignment.revoked_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;

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
  IF v_session.scenario_snapshot IS NULL THEN
    RAISE EXCEPTION 'R2.7 evidence integrity unavailable' USING ERRCODE = 'R2702';
  END IF;
  BEGIN
    v_snapshot := v_session.scenario_snapshot::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'R2.7 evidence integrity unavailable' USING ERRCODE = 'R2702';
  END;
  IF pg_catalog.jsonb_typeof(v_snapshot) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_snapshot -> 'scenario') IS DISTINCT FROM 'object'
     OR v_snapshot -> 'scenario' ->> 'id' IS DISTINCT FROM v_session.scenario_id
     OR v_snapshot -> 'scenario' ->> 'version' IS DISTINCT FROM v_session.scenario_version
     OR v_snapshot -> 'scenario' ->> 'title' IS DISTINCT FROM v_session.scenario_title THEN
    RAISE EXCEPTION 'R2.7 evidence integrity unavailable' USING ERRCODE = 'R2702';
  END IF;
  v_starter_files := v_snapshot -> 'workspaceFiles';
  IF pg_catalog.jsonb_typeof(v_starter_files) IS DISTINCT FROM 'object' THEN
    v_starter_files := NULL;
  END IF;

  SELECT submission.submitted_at, submission.closure_reason,
         submission.workspace_digest, submission.manifest_digest,
         submission.manifest, submission.manifest::pg_catalog.text AS manifest_text
  INTO v_submission
  FROM hirearchy.candidate_session_submissions AS submission
  WHERE submission.organization_id = p_organization_id
    AND submission.session_id = p_session_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_submission.submitted_at IS DISTINCT FROM v_session.submitted_at
     OR v_submission.closure_reason IS DISTINCT FROM v_session.closure_reason
     OR pg_catalog.jsonb_typeof(v_submission.manifest) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(v_submission.manifest) NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'R2.7 evidence integrity unavailable' USING ERRCODE = 'R2702';
  END IF;

  v_manifest := v_submission.manifest;
  v_manifest_text := v_submission.manifest_text;
  SELECT pg_catalog.count(*), pg_catalog.count(DISTINCT value ->> 'path')
  INTO v_file_count, v_unique_path_count
  FROM pg_catalog.jsonb_array_elements(v_manifest) AS item(value);
  IF v_file_count <> v_unique_path_count THEN
    RAISE EXCEPTION 'R2.7 evidence integrity unavailable' USING ERRCODE = 'R2702';
  END IF;
  FOR v_file IN SELECT value FROM pg_catalog.jsonb_array_elements(v_manifest) LOOP
    IF pg_catalog.jsonb_typeof(v_file.value) IS DISTINCT FROM 'object'
       OR NOT (v_file.value ?& ARRAY['path', 'content', 'version', 'digest'])
       OR (SELECT pg_catalog.count(*)
           FROM pg_catalog.jsonb_object_keys(v_file.value)) <> 4
       OR pg_catalog.jsonb_typeof(v_file.value -> 'path') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_file.value -> 'content') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_file.value -> 'version') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_file.value -> 'digest') IS DISTINCT FROM 'string'
       OR v_file.value ->> 'path' = ''
       OR v_file.value ->> 'path' <> pg_catalog.btrim(v_file.value ->> 'path')
       OR (v_file.value ->> 'path') ~ '(^/|/$|//|(^|/)(\.|\.\.)(/|$))'
       OR pg_catalog.strpos(v_file.value ->> 'path', pg_catalog.chr(92)) > 0
       OR pg_catalog.strpos(v_file.value ->> 'path', ':') > 0
       OR (v_file.value ->> 'path') !~ '\.(py|md|json|txt)$'
       OR (v_file.value ->> 'version') !~ '^(0|[1-9][0-9]{0,18})$'
       OR (v_file.value ->> 'digest') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'R2.7 evidence integrity unavailable' USING ERRCODE = 'R2702';
    END IF;
    BEGIN
      PERFORM (v_file.value ->> 'version')::pg_catalog.int8;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'R2.7 evidence integrity unavailable' USING ERRCODE = 'R2702';
    END;
    v_total_bytes := v_total_bytes + pg_catalog.octet_length(
      pg_catalog.convert_to(v_file.value ->> 'content', 'UTF8')
    );
    IF pg_catalog.octet_length(pg_catalog.convert_to(
         v_file.value ->> 'content', 'UTF8'
       )) > 100000 OR v_total_bytes > 1048576
       OR (v_file.value ->> 'digest') IS DISTINCT FROM pg_catalog.encode(
         pg_catalog.sha256(pg_catalog.convert_to(v_file.value ->> 'content', 'UTF8')),
         'hex'
       ) THEN
      RAISE EXCEPTION 'R2.7 evidence integrity unavailable' USING ERRCODE = 'R2702';
    END IF;
  END LOOP;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'path', file.value ->> 'path',
               'version', file.value ->> 'version',
               'digest', file.value ->> 'digest'
             ) ORDER BY file.value ->> 'path'
           ), '[]'::pg_catalog.jsonb
         )
  INTO v_identity
  FROM pg_catalog.jsonb_array_elements(v_manifest) AS file(value);
  v_identity_text := v_identity::pg_catalog.text;
  v_manifest_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_manifest_text, 'UTF8')), 'hex'
  );
  v_workspace_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_identity_text, 'UTF8')), 'hex'
  );
  IF v_manifest_digest IS DISTINCT FROM v_submission.manifest_digest
     OR v_workspace_digest IS DISTINCT FROM v_submission.workspace_digest THEN
    RAISE EXCEPTION 'R2.7 evidence integrity unavailable' USING ERRCODE = 'R2702';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM hirearchy.candidate_session_events AS event
    WHERE event.organization_id = p_organization_id
      AND event.session_id = p_session_id
      AND event.event_type = 'SESSION_SUBMITTED'
      AND event.happened_at = v_session.submitted_at
      AND event.payload ->> 'closureReason' = v_session.closure_reason
      AND event.payload ->> 'workspaceDigest' = v_submission.workspace_digest
      AND event.payload ->> 'manifestDigest' = v_submission.manifest_digest
  ) INTO v_closure_event;
  IF NOT v_closure_event THEN
    RAISE EXCEPTION 'R2.7 evidence integrity unavailable' USING ERRCODE = 'R2702';
  END IF;

  WITH page AS (
    SELECT event.sequence, event.event_type, event.happened_at, event.payload
    FROM hirearchy.candidate_session_events AS event
    WHERE event.organization_id = p_organization_id
      AND event.session_id = p_session_id
      AND event.sequence > p_after_sequence::pg_catalog.int8
    ORDER BY event.sequence
    LIMIT p_limit + 1
  ), returned AS (
    SELECT * FROM page ORDER BY sequence LIMIT p_limit
  ), page_count AS (
    SELECT pg_catalog.count(*) AS count FROM page
  )
  SELECT
    pg_catalog.jsonb_build_object(
      'events', COALESCE(
        (SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'sequence', event.sequence::pg_catalog.text,
            'type', event.event_type,
            'timestamp', pg_catalog.to_char(
              event.happened_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ),
            'payload', CASE event.event_type
              WHEN 'SESSION_ACTIVATED' THEN pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'scenarioDigest', event.payload -> 'scenarioDigest'
                )
              )
              WHEN 'WORKSPACE_CHANGED' THEN pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'requestId', event.payload -> 'requestId',
                  'path', event.payload -> 'path',
                  'previousVersion', event.payload -> 'previousVersion',
                  'version', event.payload -> 'version',
                  'previousDigest', event.payload -> 'previousDigest',
                  'digest', event.payload -> 'digest'
                )
              )
              WHEN 'AI_REQUEST_STARTED' THEN pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'requestId', event.payload -> 'requestId',
                  'interactionId', event.payload -> 'interactionId',
                  'promptChars', event.payload -> 'promptChars'
                )
              )
              WHEN 'AI_RESPONSE_COMPLETED' THEN pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'requestId', event.payload -> 'requestId',
                  'interactionId', event.payload -> 'interactionId',
                  'sequenceStart', event.payload -> 'sequenceStart',
                  'durationMs', event.payload -> 'durationMs',
                  'responseChars', event.payload -> 'responseChars'
                )
              )
              WHEN 'AI_REQUEST_FAILED' THEN pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'requestId', event.payload -> 'requestId',
                  'interactionId', event.payload -> 'interactionId',
                  'sequenceStart', event.payload -> 'sequenceStart',
                  'durationMs', event.payload -> 'durationMs',
                  'failureReason', event.payload -> 'failureReason',
                  'errorMessage', event.payload -> 'errorMessage'
                )
              )
              WHEN 'EXECUTION_REQUESTED' THEN pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'operationId', event.payload -> 'operationId',
                  'requestId', event.payload -> 'requestId',
                  'workspaceDigest', event.payload -> 'workspaceDigest',
                  'workspaceVersion', event.payload -> 'workspaceVersion',
                  'recipeId', event.payload -> 'recipeId',
                  'recipeVersion', event.payload -> 'recipeVersion',
                  'recipeDigest', event.payload -> 'recipeDigest',
                  'generation', event.payload -> 'generation',
                  'fence', event.payload -> 'fence'
                )
              )
              WHEN 'EXECUTION_COMPLETED' THEN pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'operationId', event.payload -> 'operationId',
                  'generation', event.payload -> 'generation',
                  'fence', event.payload -> 'fence',
                  'exitCode', event.payload -> 'exitCode',
                  'durationMs', event.payload -> 'durationMs',
                  'stdoutDigest', event.payload -> 'stdoutDigest',
                  'stderrDigest', event.payload -> 'stderrDigest',
                  'cleanupStatus', event.payload -> 'cleanupStatus'
                )
              )
              WHEN 'EXECUTION_FAILED' THEN pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'operationId', event.payload -> 'operationId',
                  'generation', event.payload -> 'generation',
                  'fence', event.payload -> 'fence',
                  'status', event.payload -> 'status',
                  'failureReason', event.payload -> 'failureReason',
                  'errorMessage', event.payload -> 'errorMessage',
                  'durationMs', event.payload -> 'durationMs',
                  'cleanupStatus', event.payload -> 'cleanupStatus',
                  'isUnknown', event.payload -> 'isUnknown'
                )
              )
              ELSE pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'closureReason', event.payload -> 'closureReason',
                  'workspaceDigest', event.payload -> 'workspaceDigest',
                  'manifestDigest', event.payload -> 'manifestDigest'
                )
              )
            END
          ) ORDER BY event.sequence
        ) FROM returned AS event), '[]'::pg_catalog.jsonb
      ),
      'nextAfterSequence', CASE
        WHEN (SELECT count FROM page_count) > p_limit THEN
          (SELECT last_event.sequence::pg_catalog.text FROM returned AS last_event
           ORDER BY last_event.sequence DESC LIMIT 1)
        ELSE NULL
      END
    ) INTO v_page;

  RETURN pg_catalog.jsonb_build_object(
    'permission', 'assigned_reviewer',
    'reviewer', pg_catalog.jsonb_build_object(
      'subjectId', p_subject_id,
      'principalId', v_principal_id
    ),
    'organizationId', p_organization_id,
    'sessionId', v_session.id,
    'assignment', pg_catalog.jsonb_build_object(
      'id', v_assignment.id,
      'version', v_assignment.version::pg_catalog.text,
      'assignedAt', pg_catalog.to_char(
        v_assignment.assigned_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    ),
    'scenario', pg_catalog.jsonb_build_object(
      'id', v_session.scenario_id,
      'version', v_session.scenario_version,
      'title', v_session.scenario_title,
      'snapshotText', v_session.scenario_snapshot,
      'snapshotDigest', pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(v_session.scenario_snapshot, 'UTF8')),
        'hex'
      ),
      'starterFiles', v_starter_files
    ),
    'status', v_session.status,
    'durationSeconds', v_session.duration_seconds,
    'createdAt', pg_catalog.to_char(
      v_session.created_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'activatedAt', pg_catalog.to_char(
      v_session.activated_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'submittedAt', pg_catalog.to_char(
      v_session.submitted_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'closureReason', v_session.closure_reason,
    'submission', pg_catalog.jsonb_build_object(
      'submittedAt', pg_catalog.to_char(
        v_submission.submitted_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'closureReason', v_submission.closure_reason,
      'workspaceDigest', v_submission.workspace_digest,
      'manifestDigest', v_submission.manifest_digest,
      'files', v_manifest
    ),
    'manifestText', v_manifest_text,
    'identityText', v_identity_text,
    'events', v_page -> 'events',
    'aiInteractions', CASE
      WHEN pg_catalog.to_regclass('hirearchy.candidate_ai_interactions') IS NOT NULL THEN
        COALESCE(
          (
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'interactionId', ai.interaction_id,
                'requestId', ai.request_id,
                'sequenceStart', ai.sequence_start::pg_catalog.text,
                'sequenceCompleted', ai.sequence_completed::pg_catalog.text,
                'candidatePrompt', ai.candidate_prompt,
                'assistantResponse', ai.assistant_response,
                'status', ai.status,
                'failureReason', ai.failure_reason,
                'errorMessage', ai.error_message,
                'providerId', ai.provider_id,
                'modelId', ai.model_id,
                'createdAt', pg_catalog.to_char(
                  ai.created_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                ),
                'completedAt', CASE WHEN ai.completed_at IS NOT NULL THEN pg_catalog.to_char(
                  ai.completed_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                ) ELSE NULL END
              ) ORDER BY ai.sequence_start
            )
            FROM hirearchy.candidate_ai_interactions AS ai
            WHERE ai.organization_id = p_organization_id
              AND ai.session_id = p_session_id
          ),
          '[]'::pg_catalog.jsonb
        )
      ELSE '[]'::pg_catalog.jsonb
    END,
    'executions', CASE
      WHEN pg_catalog.to_regclass('hirearchy.candidate_execution_operations') IS NOT NULL THEN
        COALESCE(
          (
            SELECT pg_catalog.jsonb_agg(
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
                'isSynthetic', true,
                'createdAt', pg_catalog.to_char(
                  op.created_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                ),
                'completedAt', CASE WHEN op.completed_at IS NOT NULL THEN pg_catalog.to_char(
                  op.completed_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                ) ELSE NULL END
              ) ORDER BY op.sequence_start
            )
            FROM hirearchy.candidate_execution_operations AS op
            WHERE op.organization_id = p_organization_id
              AND op.session_id = p_session_id
          ),
          '[]'::pg_catalog.jsonb
        )
      ELSE '[]'::pg_catalog.jsonb
    END,
    'pagination', pg_catalog.jsonb_build_object(
      'limit', p_limit,
      'nextAfterSequence', v_page -> 'nextAfterSequence'
    )
  );
END
$function$;

ALTER FUNCTION r27.get_submitted_evidence(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid,
  pg_catalog.text, pg_catalog.text, pg_catalog.int4
) OWNER TO r23_session_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA r27 FROM PUBLIC, r23_gateway,
  app_evaluator, app_candidate_gateway, app_control_worker;
GRANT EXECUTE ON FUNCTION r27.get_submitted_evidence(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid,
  pg_catalog.text, pg_catalog.text, pg_catalog.int4
) TO r23_gateway;

COMMIT;
