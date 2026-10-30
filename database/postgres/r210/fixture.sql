-- Disposable R2.10 review packet fixture; never a production migration.
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
    RAISE EXCEPTION 'R2.10 review packet roles are missing or unsafe';
  END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS r210 AUTHORIZATION r23_session_owner;
REVOKE ALL ON SCHEMA r210 FROM PUBLIC, r23_gateway, app_evaluator,
  app_candidate_gateway, app_control_worker;
GRANT USAGE ON SCHEMA r210 TO r23_gateway;
GRANT USAGE ON SCHEMA hirearchy TO r23_session_owner;

REVOKE ALL ON TABLE hirearchy.evaluator_review_packets,
  hirearchy.evaluator_review_packet_history
  FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway,
       app_control_worker;

GRANT SELECT, INSERT, UPDATE (
  status, summary, strengths, concerns, unresolved_questions,
  referenced_observation_ids, referenced_evidence, version,
  finalized_at, final_digest, updated_at
) ON TABLE hirearchy.evaluator_review_packets TO r23_session_owner;

GRANT SELECT, INSERT
  ON TABLE hirearchy.evaluator_review_packet_history TO r23_session_owner;

GRANT SELECT ON TABLE hirearchy.evaluator_observations,
  hirearchy.candidate_file_revisions,
  hirearchy.candidate_session_events,
  hirearchy.candidate_session_submissions,
  hirearchy.assessment_sessions,
  hirearchy.organization_memberships,
  hirearchy.reviewer_assignments TO r23_session_owner;

DROP POLICY IF EXISTS r210_evaluator_review_packets_select
  ON hirearchy.evaluator_review_packets;
CREATE POLICY r210_evaluator_review_packets_select
  ON hirearchy.evaluator_review_packets
  FOR SELECT TO r23_session_owner
  USING (
    organization_id = NULLIF(
      pg_catalog.current_setting('r210.organization_id', true), ''
    )::pg_catalog.uuid
    AND session_id = NULLIF(
      pg_catalog.current_setting('r210.session_id', true), ''
    )
    AND author_principal_id = NULLIF(
      pg_catalog.current_setting('r210.principal_id', true), ''
    )::pg_catalog.uuid
    AND EXISTS (
      SELECT 1
      FROM hirearchy.organization_memberships AS membership
      JOIN hirearchy.reviewer_assignments AS assignment
        ON assignment.organization_id = membership.organization_id
       AND assignment.reviewer_principal_id = membership.principal_id
       AND assignment.session_id = evaluator_review_packets.session_id
       AND assignment.revoked_at IS NULL
      JOIN hirearchy.assessment_sessions AS session
        ON session.organization_id = assignment.organization_id
       AND session.id = assignment.session_id
       AND session.status = 'SUBMITTED'
      WHERE membership.organization_id = evaluator_review_packets.organization_id
        AND membership.principal_id = evaluator_review_packets.author_principal_id
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
  );

DROP POLICY IF EXISTS r210_evaluator_review_packets_insert
  ON hirearchy.evaluator_review_packets;
CREATE POLICY r210_evaluator_review_packets_insert
  ON hirearchy.evaluator_review_packets
  FOR INSERT TO r23_session_owner
  WITH CHECK (
    organization_id = NULLIF(
      pg_catalog.current_setting('r210.organization_id', true), ''
    )::pg_catalog.uuid
    AND session_id = NULLIF(
      pg_catalog.current_setting('r210.session_id', true), ''
    )
    AND author_principal_id = NULLIF(
      pg_catalog.current_setting('r210.principal_id', true), ''
    )::pg_catalog.uuid
    AND EXISTS (
      SELECT 1
      FROM hirearchy.organization_memberships AS membership
      JOIN hirearchy.reviewer_assignments AS assignment
        ON assignment.organization_id = membership.organization_id
       AND assignment.reviewer_principal_id = membership.principal_id
       AND assignment.session_id = evaluator_review_packets.session_id
       AND assignment.revoked_at IS NULL
      JOIN hirearchy.assessment_sessions AS session
        ON session.organization_id = assignment.organization_id
       AND session.id = assignment.session_id
       AND session.status = 'SUBMITTED'
      WHERE membership.organization_id = evaluator_review_packets.organization_id
        AND membership.principal_id = evaluator_review_packets.author_principal_id
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
  );

DROP POLICY IF EXISTS r210_evaluator_review_packets_update
  ON hirearchy.evaluator_review_packets;
CREATE POLICY r210_evaluator_review_packets_update
  ON hirearchy.evaluator_review_packets
  FOR UPDATE TO r23_session_owner
  USING (
    organization_id = NULLIF(
      pg_catalog.current_setting('r210.organization_id', true), ''
    )::pg_catalog.uuid
    AND session_id = NULLIF(
      pg_catalog.current_setting('r210.session_id', true), ''
    )
    AND author_principal_id = NULLIF(
      pg_catalog.current_setting('r210.principal_id', true), ''
    )::pg_catalog.uuid
    AND EXISTS (
      SELECT 1
      FROM hirearchy.organization_memberships AS membership
      JOIN hirearchy.reviewer_assignments AS assignment
        ON assignment.organization_id = membership.organization_id
       AND assignment.reviewer_principal_id = membership.principal_id
       AND assignment.session_id = evaluator_review_packets.session_id
       AND assignment.revoked_at IS NULL
      JOIN hirearchy.assessment_sessions AS session
        ON session.organization_id = assignment.organization_id
       AND session.id = assignment.session_id
       AND session.status = 'SUBMITTED'
      WHERE membership.organization_id = evaluator_review_packets.organization_id
        AND membership.principal_id = evaluator_review_packets.author_principal_id
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
  )
  WITH CHECK (
    organization_id = NULLIF(
      pg_catalog.current_setting('r210.organization_id', true), ''
    )::pg_catalog.uuid
    AND session_id = NULLIF(
      pg_catalog.current_setting('r210.session_id', true), ''
    )
    AND author_principal_id = NULLIF(
      pg_catalog.current_setting('r210.principal_id', true), ''
    )::pg_catalog.uuid
  );

DROP POLICY IF EXISTS r210_evaluator_review_packet_history_select
  ON hirearchy.evaluator_review_packet_history;
CREATE POLICY r210_evaluator_review_packet_history_select
  ON hirearchy.evaluator_review_packet_history
  FOR SELECT TO r23_session_owner
  USING (
    organization_id = NULLIF(
      pg_catalog.current_setting('r210.organization_id', true), ''
    )::pg_catalog.uuid
    AND session_id = NULLIF(
      pg_catalog.current_setting('r210.session_id', true), ''
    )
    AND author_principal_id = NULLIF(
      pg_catalog.current_setting('r210.principal_id', true), ''
    )::pg_catalog.uuid
    AND EXISTS (
      SELECT 1
      FROM hirearchy.organization_memberships AS membership
      JOIN hirearchy.reviewer_assignments AS assignment
        ON assignment.organization_id = membership.organization_id
       AND assignment.reviewer_principal_id = membership.principal_id
       AND assignment.session_id = evaluator_review_packet_history.session_id
       AND assignment.revoked_at IS NULL
      JOIN hirearchy.assessment_sessions AS session
        ON session.organization_id = assignment.organization_id
       AND session.id = assignment.session_id
       AND session.status = 'SUBMITTED'
      WHERE membership.organization_id = evaluator_review_packet_history.organization_id
        AND membership.principal_id = evaluator_review_packet_history.author_principal_id
        AND membership.role = 'reviewer'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
    )
  );

DROP POLICY IF EXISTS r210_evaluator_review_packet_history_insert
  ON hirearchy.evaluator_review_packet_history;
CREATE POLICY r210_evaluator_review_packet_history_insert
  ON hirearchy.evaluator_review_packet_history
  FOR INSERT TO r23_session_owner
  WITH CHECK (
    organization_id = NULLIF(
      pg_catalog.current_setting('r210.organization_id', true), ''
    )::pg_catalog.uuid
    AND session_id = NULLIF(
      pg_catalog.current_setting('r210.session_id', true), ''
    )
    AND author_principal_id = NULLIF(
      pg_catalog.current_setting('r210.principal_id', true), ''
    )::pg_catalog.uuid
  );

CREATE OR REPLACE FUNCTION r210.validate_references(
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text,
  p_principal_id pg_catalog.uuid,
  p_referenced_obs pg_catalog.jsonb,
  p_referenced_evidence pg_catalog.jsonb
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_obs_elem pg_catalog.jsonb;
  v_obs_elem_str pg_catalog.text;
  v_obs_uuid pg_catalog.uuid;
  v_check_obs_id pg_catalog.uuid;
  v_evidence_elem pg_catalog.jsonb;
  v_evidence_source_type pg_catalog.text;
  v_event_sequence_str pg_catalog.text;
  v_seq_num pg_catalog.int8;
  v_file_path pg_catalog.text;
  v_file_version_str pg_catalog.text;
  v_file_version_num pg_catalog.int8;
  v_evidence_digest pg_catalog.text;
  v_event record;
  v_revision record;
BEGIN
  IF p_referenced_obs IS NOT NULL AND pg_catalog.jsonb_typeof(p_referenced_obs) = 'array' THEN
    FOR v_obs_elem IN SELECT * FROM pg_catalog.jsonb_array_elements(p_referenced_obs) LOOP
      v_obs_elem_str := v_obs_elem #>> '{}';
      IF v_obs_elem_str IS NULL OR v_obs_elem_str !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'Invalid observation reference: format error' USING ERRCODE = 'R2102';
      END IF;
      v_obs_uuid := v_obs_elem_str::pg_catalog.uuid;

      SELECT obs.id INTO v_check_obs_id
      FROM hirearchy.evaluator_observations AS obs
      WHERE obs.id = v_obs_uuid
        AND obs.organization_id = p_organization_id
        AND obs.session_id = p_session_id
        AND obs.author_principal_id = p_principal_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid observation reference' USING ERRCODE = 'R2102';
      END IF;
    END LOOP;
  END IF;

  IF p_referenced_evidence IS NOT NULL AND pg_catalog.jsonb_typeof(p_referenced_evidence) = 'array' THEN
    FOR v_evidence_elem IN SELECT * FROM pg_catalog.jsonb_array_elements(p_referenced_evidence) LOOP
      IF pg_catalog.jsonb_typeof(v_evidence_elem) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Invalid evidence reference: must be object' USING ERRCODE = 'R2102';
      END IF;

      v_evidence_source_type := v_evidence_elem ->> 'evidenceSourceType';
      v_event_sequence_str := v_evidence_elem ->> 'eventSequence';
      v_file_path := v_evidence_elem ->> 'filePath';
      v_file_version_str := v_evidence_elem ->> 'fileVersion';
      v_evidence_digest := v_evidence_elem ->> 'evidenceDigest';

      IF v_evidence_source_type IS NULL
         OR v_evidence_source_type NOT IN ('timeline_event', 'file_revision')
         OR v_event_sequence_str IS NULL
         OR v_event_sequence_str !~ '^[1-9][0-9]{0,18}$'
         OR v_event_sequence_str::pg_catalog.numeric > 9223372036854775807
         OR v_evidence_digest IS NULL
         OR v_evidence_digest !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Invalid evidence reference format' USING ERRCODE = 'R2102';
      END IF;

      v_seq_num := v_event_sequence_str::pg_catalog.int8;

      IF v_evidence_source_type = 'timeline_event' THEN
        IF (v_evidence_elem -> 'filePath') IS NOT NULL AND pg_catalog.jsonb_typeof(v_evidence_elem -> 'filePath') IS DISTINCT FROM 'null' THEN
          RAISE EXCEPTION 'Timeline event reference must not specify filePath' USING ERRCODE = 'R2102';
        END IF;
        IF (v_evidence_elem -> 'fileVersion') IS NOT NULL AND pg_catalog.jsonb_typeof(v_evidence_elem -> 'fileVersion') IS DISTINCT FROM 'null' THEN
          RAISE EXCEPTION 'Timeline event reference must not specify fileVersion' USING ERRCODE = 'R2102';
        END IF;

        SELECT event.* INTO v_event
        FROM hirearchy.candidate_session_events AS event
        WHERE event.organization_id = p_organization_id
          AND event.session_id = p_session_id
          AND event.sequence = v_seq_num;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Referenced timeline event not found' USING ERRCODE = 'R2102';
        END IF;

        IF (
          v_evidence_digest IS DISTINCT FROM (v_event.payload ->> 'digest')
          AND v_evidence_digest IS DISTINCT FROM (v_event.payload ->> 'scenarioDigest')
          AND v_evidence_digest IS DISTINCT FROM (v_event.payload ->> 'workspaceDigest')
          AND v_evidence_digest IS DISTINCT FROM (v_event.payload ->> 'manifestDigest')
          AND v_evidence_digest IS DISTINCT FROM pg_catalog.encode(
            pg_catalog.sha256(pg_catalog.convert_to(v_event.payload::pg_catalog.text, 'UTF8')),
            'hex'
          )
        ) THEN
          RAISE EXCEPTION 'Timeline event evidence digest mismatch' USING ERRCODE = 'R2102';
        END IF;
      ELSE
        IF v_file_path IS NULL OR pg_catalog.btrim(v_file_path) = '' THEN
          RAISE EXCEPTION 'File revision reference requires filePath' USING ERRCODE = 'R2102';
        END IF;
        IF v_file_version_str IS NULL
           OR v_file_version_str !~ '^[1-9][0-9]{0,18}$'
           OR v_file_version_str::pg_catalog.numeric > 9223372036854775807 THEN
          RAISE EXCEPTION 'File revision reference requires valid fileVersion' USING ERRCODE = 'R2102';
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
          RAISE EXCEPTION 'Referenced file revision not found' USING ERRCODE = 'R2102';
        END IF;

        IF v_revision.content_digest IS DISTINCT FROM v_evidence_digest THEN
          RAISE EXCEPTION 'File revision content digest mismatch' USING ERRCODE = 'R2102';
        END IF;
      END IF;
    END LOOP;
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION r210.format_packet(p_packet_id pg_catalog.uuid)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_packet record;
  v_history pg_catalog.jsonb;
BEGIN
  SELECT packet.* INTO v_packet
  FROM hirearchy.evaluator_review_packets AS packet
  WHERE packet.id = p_packet_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'historyId', h.history_id::pg_catalog.text,
        'packetId', h.packet_id::pg_catalog.text,
        'organizationId', h.organization_id::pg_catalog.text,
        'sessionId', h.session_id,
        'authorPrincipalId', h.author_principal_id::pg_catalog.text,
        'status', h.status,
        'version', h.version,
        'summary', h.summary,
        'strengths', h.strengths,
        'concerns', h.concerns,
        'unresolvedQuestions', h.unresolved_questions,
        'referencedObservationIds', h.referenced_observation_ids,
        'referencedEvidence', h.referenced_evidence,
        'finalizedAt', CASE WHEN h.finalized_at IS NOT NULL THEN pg_catalog.to_char(h.finalized_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ELSE NULL END,
        'finalDigest', h.final_digest,
        'validFrom', pg_catalog.to_char(h.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'validUntil', pg_catalog.to_char(h.valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'recordedAt', pg_catalog.to_char(h.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) ORDER BY h.version ASC
    ),
    '[]'::pg_catalog.jsonb
  ) INTO v_history
  FROM hirearchy.evaluator_review_packet_history AS h
  WHERE h.packet_id = v_packet.id;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_packet.id::pg_catalog.text,
    'organizationId', v_packet.organization_id::pg_catalog.text,
    'sessionId', v_packet.session_id,
    'authorPrincipalId', v_packet.author_principal_id::pg_catalog.text,
    'status', v_packet.status,
    'summary', v_packet.summary,
    'strengths', v_packet.strengths,
    'concerns', v_packet.concerns,
    'unresolvedQuestions', v_packet.unresolved_questions,
    'referencedObservationIds', v_packet.referenced_observation_ids,
    'referencedEvidence', v_packet.referenced_evidence,
    'version', v_packet.version,
    'createdAt', pg_catalog.to_char(v_packet.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updatedAt', pg_catalog.to_char(v_packet.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'finalizedAt', CASE WHEN v_packet.finalized_at IS NOT NULL THEN pg_catalog.to_char(v_packet.finalized_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ELSE NULL END,
    'finalDigest', v_packet.final_digest,
    'history', v_history
  );
END
$function$;

CREATE OR REPLACE FUNCTION r210.get_review_packet(
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
  v_packet record;
BEGIN
  IF SESSION_USER <> 'r23_gateway' OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.10 review packet access denied' USING ERRCODE = '42501';
  END IF;

  IF p_subject_id IS NULL OR p_auth_session_id IS NULL
     OR p_assurance IS NULL OR p_assurance NOT IN ('aal1', 'aal2')
     OR p_organization_id IS NULL
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$' THEN
    RAISE EXCEPTION 'R2.10 review packet query is invalid' USING ERRCODE = 'R2101';
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
  IF NOT FOUND OR v_membership_role <> 'reviewer' THEN
    RAISE EXCEPTION 'Reviewer role required' USING ERRCODE = 'R2401';
  END IF;

  SELECT assignment.id INTO v_assignment_id
  FROM hirearchy.reviewer_assignments AS assignment
  WHERE assignment.organization_id = p_organization_id
    AND assignment.session_id = p_session_id
    AND assignment.reviewer_principal_id = v_principal_id
    AND assignment.revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reviewer assignment not found or revoked' USING ERRCODE = 'R2401';
  END IF;

  SELECT session.id INTO v_session_check_id
  FROM hirearchy.assessment_sessions AS session
  WHERE session.organization_id = p_organization_id
    AND session.id = p_session_id
    AND session.status = 'SUBMITTED';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assessment session is not submitted' USING ERRCODE = 'R2401';
  END IF;

  PERFORM pg_catalog.set_config(
    'r210.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config('r210.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config(
    'r210.principal_id', v_principal_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config(
    'r29.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config('r29.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config(
    'r29.principal_id', v_principal_id::pg_catalog.text, true
  );
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

  SELECT packet.id INTO v_packet
  FROM hirearchy.evaluator_review_packets AS packet
  WHERE packet.organization_id = p_organization_id
    AND packet.session_id = p_session_id
    AND packet.author_principal_id = v_principal_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN r210.format_packet(v_packet.id);
END
$function$;

CREATE OR REPLACE FUNCTION r210.save_review_packet_draft(
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
  v_summary pg_catalog.text;
  v_strengths pg_catalog.jsonb;
  v_concerns pg_catalog.jsonb;
  v_unresolved_questions pg_catalog.jsonb;
  v_ref_obs pg_catalog.jsonb;
  v_ref_evidence pg_catalog.jsonb;
  v_expected_version pg_catalog.int8;
  v_packet record;
  v_target_packet record;
BEGIN
  IF SESSION_USER <> 'r23_gateway' OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.10 review packet access denied' USING ERRCODE = '42501';
  END IF;

  IF p_subject_id IS NULL OR p_auth_session_id IS NULL
     OR p_assurance IS NULL OR p_assurance NOT IN ('aal1', 'aal2')
     OR p_organization_id IS NULL
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$'
     OR p_input IS NULL OR pg_catalog.jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'R2.10 review packet parameters are invalid' USING ERRCODE = 'R2101';
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
  IF NOT FOUND OR v_membership_role <> 'reviewer' THEN
    RAISE EXCEPTION 'Reviewer role required' USING ERRCODE = 'R2401';
  END IF;

  SELECT assignment.id INTO v_assignment_id
  FROM hirearchy.reviewer_assignments AS assignment
  WHERE assignment.organization_id = p_organization_id
    AND assignment.session_id = p_session_id
    AND assignment.reviewer_principal_id = v_principal_id
    AND assignment.revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reviewer assignment not found or revoked' USING ERRCODE = 'R2401';
  END IF;

  SELECT session.id INTO v_session_check_id
  FROM hirearchy.assessment_sessions AS session
  WHERE session.organization_id = p_organization_id
    AND session.id = p_session_id
    AND session.status = 'SUBMITTED';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assessment session is not submitted' USING ERRCODE = 'R2401';
  END IF;

  PERFORM pg_catalog.set_config(
    'r210.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config('r210.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config(
    'r210.principal_id', v_principal_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config(
    'r29.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config('r29.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config(
    'r29.principal_id', v_principal_id::pg_catalog.text, true
  );
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

  v_summary := COALESCE(p_input ->> 'summary', '');
  v_strengths := COALESCE(p_input -> 'strengths', '[]'::pg_catalog.jsonb);
  v_concerns := COALESCE(p_input -> 'concerns', '[]'::pg_catalog.jsonb);
  v_unresolved_questions := COALESCE(p_input -> 'unresolvedQuestions', '[]'::pg_catalog.jsonb);
  v_ref_obs := COALESCE(p_input -> 'referencedObservationIds', '[]'::pg_catalog.jsonb);
  v_ref_evidence := COALESCE(p_input -> 'referencedEvidence', '[]'::pg_catalog.jsonb);

  IF pg_catalog.jsonb_typeof(v_strengths) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(v_concerns) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(v_unresolved_questions) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(v_ref_obs) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(v_ref_evidence) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'R2.10 invalid draft parameter arrays' USING ERRCODE = 'R2101';
  END IF;

  -- Validate referenced observations and evidence
  PERFORM r210.validate_references(
    p_organization_id, p_session_id, v_principal_id, v_ref_obs, v_ref_evidence
  );

  IF (p_input ? 'expectedVersion') AND (p_input -> 'expectedVersion') IS NOT NULL AND pg_catalog.jsonb_typeof(p_input -> 'expectedVersion') = 'number' THEN
    v_expected_version := (p_input ->> 'expectedVersion')::pg_catalog.int8;
  ELSE
    v_expected_version := NULL;
  END IF;

  SELECT packet.* INTO v_packet
  FROM hirearchy.evaluator_review_packets AS packet
  WHERE packet.organization_id = p_organization_id
    AND packet.session_id = p_session_id
    AND packet.author_principal_id = v_principal_id
  FOR UPDATE;

  IF v_packet.id IS NOT NULL THEN
    IF v_packet.status = 'FINALIZED' THEN
      RAISE EXCEPTION 'Cannot update finalized packet' USING ERRCODE = 'R2105';
    END IF;

    IF v_expected_version IS NULL OR v_packet.version <> v_expected_version THEN
      RAISE EXCEPTION 'Edit conflict: review packet version mismatch' USING ERRCODE = 'R2104';
    END IF;

    -- Append current version to history
    INSERT INTO hirearchy.evaluator_review_packet_history (
      packet_id, organization_id, session_id, author_principal_id,
      status, version, summary, strengths, concerns, unresolved_questions,
      referenced_observation_ids, referenced_evidence,
      finalized_at, final_digest,
      valid_from, valid_until, recorded_at
    ) VALUES (
      v_packet.id, v_packet.organization_id, v_packet.session_id, v_packet.author_principal_id,
      v_packet.status, v_packet.version, v_packet.summary, v_packet.strengths, v_packet.concerns, v_packet.unresolved_questions,
      v_packet.referenced_observation_ids, v_packet.referenced_evidence,
      v_packet.finalized_at, v_packet.final_digest,
      v_packet.updated_at, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
    );

    UPDATE hirearchy.evaluator_review_packets
    SET summary = v_summary,
        strengths = v_strengths,
        concerns = v_concerns,
        unresolved_questions = v_unresolved_questions,
        referenced_observation_ids = v_ref_obs,
        referenced_evidence = v_ref_evidence,
        version = v_packet.version + 1,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_packet.id
    RETURNING * INTO v_target_packet;
  ELSE
    IF v_expected_version IS NOT NULL AND v_expected_version <> 0 AND v_expected_version <> 1 THEN
      RAISE EXCEPTION 'Edit conflict: initial review packet version mismatch' USING ERRCODE = 'R2104';
    END IF;

    INSERT INTO hirearchy.evaluator_review_packets (
      organization_id, session_id, author_principal_id,
      status, summary, strengths, concerns, unresolved_questions,
      referenced_observation_ids, referenced_evidence,
      version, finalized_at, final_digest,
      created_at, updated_at
    ) VALUES (
      p_organization_id, p_session_id, v_principal_id,
      'DRAFT', v_summary, v_strengths, v_concerns, v_unresolved_questions,
      v_ref_obs, v_ref_evidence,
      1, NULL, NULL,
      pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
    ) RETURNING * INTO v_target_packet;
  END IF;

  RETURN r210.format_packet(v_target_packet.id);
END
$function$;

CREATE OR REPLACE FUNCTION r210.finalize_review_packet(
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
  v_expected_version pg_catalog.int8;
  v_packet record;
  v_target_packet record;
  v_finalized_at pg_catalog.timestamptz;
  v_final_digest pg_catalog.text;
BEGIN
  IF SESSION_USER <> 'r23_gateway' OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.10 review packet access denied' USING ERRCODE = '42501';
  END IF;

  IF p_subject_id IS NULL OR p_auth_session_id IS NULL
     OR p_assurance IS NULL OR p_assurance NOT IN ('aal1', 'aal2')
     OR p_organization_id IS NULL
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$'
     OR p_input IS NULL OR pg_catalog.jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'R2.10 review packet parameters are invalid' USING ERRCODE = 'R2101';
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
  IF NOT FOUND OR v_membership_role <> 'reviewer' THEN
    RAISE EXCEPTION 'Reviewer role required' USING ERRCODE = 'R2401';
  END IF;

  SELECT assignment.id INTO v_assignment_id
  FROM hirearchy.reviewer_assignments AS assignment
  WHERE assignment.organization_id = p_organization_id
    AND assignment.session_id = p_session_id
    AND assignment.reviewer_principal_id = v_principal_id
    AND assignment.revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reviewer assignment not found or revoked' USING ERRCODE = 'R2401';
  END IF;

  SELECT session.id INTO v_session_check_id
  FROM hirearchy.assessment_sessions AS session
  WHERE session.organization_id = p_organization_id
    AND session.id = p_session_id
    AND session.status = 'SUBMITTED';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assessment session is not submitted' USING ERRCODE = 'R2401';
  END IF;

  PERFORM pg_catalog.set_config(
    'r210.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config('r210.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config(
    'r210.principal_id', v_principal_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config(
    'r29.organization_id', p_organization_id::pg_catalog.text, true
  );
  PERFORM pg_catalog.set_config('r29.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config(
    'r29.principal_id', v_principal_id::pg_catalog.text, true
  );
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

  IF NOT (p_input ? 'expectedVersion')
     OR pg_catalog.jsonb_typeof(p_input -> 'expectedVersion') IS DISTINCT FROM 'number'
     OR (p_input ->> 'expectedVersion') !~ '^[1-9][0-9]{0,18}$'
     OR (p_input ->> 'expectedVersion')::pg_catalog.numeric > 9223372036854775807 THEN
    RAISE EXCEPTION 'R2.10 invalid expectedVersion for finalization' USING ERRCODE = 'R2101';
  END IF;

  v_expected_version := (p_input ->> 'expectedVersion')::pg_catalog.int8;

  SELECT packet.* INTO v_packet
  FROM hirearchy.evaluator_review_packets AS packet
  WHERE packet.organization_id = p_organization_id
    AND packet.session_id = p_session_id
    AND packet.author_principal_id = v_principal_id
  FOR UPDATE;

  IF v_packet.id IS NULL THEN
    RAISE EXCEPTION 'Review packet not found for finalization' USING ERRCODE = 'R2101';
  END IF;

  IF v_packet.status = 'FINALIZED' THEN
    IF v_expected_version = v_packet.version OR v_expected_version = (v_packet.version - 1) THEN
      -- Return existing finalized packet idempotently without modifying it
      RETURN r210.format_packet(v_packet.id);
    ELSE
      RAISE EXCEPTION 'Edit conflict: review packet version mismatch' USING ERRCODE = 'R2104';
    END IF;
  END IF;

  IF v_packet.version <> v_expected_version THEN
    RAISE EXCEPTION 'Edit conflict: review packet version mismatch' USING ERRCODE = 'R2104';
  END IF;

  -- Validate finalization requirements:
  -- 1. Summary non-empty and length >= 10
  IF v_packet.summary IS NULL
     OR pg_catalog.btrim(v_packet.summary) = ''
     OR pg_catalog.octet_length(pg_catalog.convert_to(pg_catalog.btrim(v_packet.summary), 'UTF8')) < 10 THEN
    RAISE EXCEPTION 'Review packet summary must be at least 10 characters for finalization' USING ERRCODE = 'R2103';
  END IF;

  -- 2. At least 1 grounded reference required
  IF pg_catalog.jsonb_array_length(v_packet.referenced_observation_ids) = 0
     AND pg_catalog.jsonb_array_length(v_packet.referenced_evidence) = 0 THEN
    RAISE EXCEPTION 'Review packet must contain at least one observation or evidence reference for finalization' USING ERRCODE = 'R2103';
  END IF;

  -- 3. Verify reference integrity
  PERFORM r210.validate_references(
    p_organization_id, p_session_id, v_principal_id,
    v_packet.referenced_observation_ids, v_packet.referenced_evidence
  );

  v_finalized_at := pg_catalog.clock_timestamp();

  -- Stable final digest calculation
  v_final_digest := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'id', v_packet.id::pg_catalog.text,
          'organizationId', v_packet.organization_id::pg_catalog.text,
          'sessionId', v_packet.session_id,
          'authorPrincipalId', v_packet.author_principal_id::pg_catalog.text,
          'summary', v_packet.summary,
          'strengths', v_packet.strengths,
          'concerns', v_packet.concerns,
          'unresolvedQuestions', v_packet.unresolved_questions,
          'referencedObservationIds', v_packet.referenced_observation_ids,
          'referencedEvidence', v_packet.referenced_evidence,
          'finalizedAt', pg_catalog.to_char(v_finalized_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        )::pg_catalog.text,
        'UTF8'
      )
    ),
    'hex'
  );

  -- Append draft state to history
  INSERT INTO hirearchy.evaluator_review_packet_history (
    packet_id, organization_id, session_id, author_principal_id,
    status, version, summary, strengths, concerns, unresolved_questions,
    referenced_observation_ids, referenced_evidence,
    finalized_at, final_digest,
    valid_from, valid_until, recorded_at
  ) VALUES (
    v_packet.id, v_packet.organization_id, v_packet.session_id, v_packet.author_principal_id,
    v_packet.status, v_packet.version, v_packet.summary, v_packet.strengths, v_packet.concerns, v_packet.unresolved_questions,
    v_packet.referenced_observation_ids, v_packet.referenced_evidence,
    v_packet.finalized_at, v_packet.final_digest,
    v_packet.updated_at, v_finalized_at, pg_catalog.clock_timestamp()
  );

  -- Finalize packet
  UPDATE hirearchy.evaluator_review_packets
  SET status = 'FINALIZED',
      finalized_at = v_finalized_at,
      final_digest = v_final_digest,
      version = v_packet.version + 1,
      updated_at = v_finalized_at
  WHERE id = v_packet.id
  RETURNING * INTO v_target_packet;

  RETURN r210.format_packet(v_target_packet.id);
END
$function$;

ALTER FUNCTION r210.validate_references(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.jsonb, pg_catalog.jsonb
) OWNER TO r23_session_owner;

ALTER FUNCTION r210.format_packet(pg_catalog.uuid) OWNER TO r23_session_owner;

ALTER FUNCTION r210.get_review_packet(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid,
  pg_catalog.text
) OWNER TO r23_session_owner;

ALTER FUNCTION r210.save_review_packet_draft(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid,
  pg_catalog.text, pg_catalog.jsonb
) OWNER TO r23_session_owner;

ALTER FUNCTION r210.finalize_review_packet(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid,
  pg_catalog.text, pg_catalog.jsonb
) OWNER TO r23_session_owner;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA r210 FROM PUBLIC, r23_gateway,
  app_evaluator, app_candidate_gateway, app_control_worker;

GRANT EXECUTE ON FUNCTION r210.get_review_packet(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid,
  pg_catalog.text
) TO r23_gateway;

GRANT EXECUTE ON FUNCTION r210.save_review_packet_draft(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid,
  pg_catalog.text, pg_catalog.jsonb
) TO r23_gateway;

GRANT EXECUTE ON FUNCTION r210.finalize_review_packet(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid,
  pg_catalog.text, pg_catalog.jsonb
) TO r23_gateway;

COMMIT;
