GRANT USAGE ON SCHEMA hirearchy TO app_candidate_gateway;

CREATE TABLE hirearchy.candidate_workspace_files (
  organization_id pg_catalog.uuid NOT NULL,
  session_id pg_catalog.text NOT NULL,
  file_path pg_catalog.text NOT NULL,
  content pg_catalog.text NOT NULL,
  version pg_catalog.int8 NOT NULL CHECK (version >= 0),
  content_digest pg_catalog.text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  updated_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (session_id, file_path),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES hirearchy.assessment_sessions (organization_id, id)
    ON DELETE RESTRICT,
  CHECK (pg_catalog.octet_length(pg_catalog.convert_to(content, 'UTF8')) <= 100000),
  CHECK (
    content_digest = pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(content, 'UTF8')),
      'hex'
    )
  )
);

CREATE INDEX candidate_workspace_files_session_path_idx
  ON hirearchy.candidate_workspace_files (organization_id, session_id, file_path);

CREATE TABLE hirearchy.candidate_session_events (
  organization_id pg_catalog.uuid NOT NULL,
  session_id pg_catalog.text NOT NULL,
  sequence pg_catalog.int8 NOT NULL CHECK (sequence > 0),
  event_type pg_catalog.text NOT NULL CHECK (
    event_type IN ('SESSION_ACTIVATED', 'WORKSPACE_CHANGED', 'SESSION_SUBMITTED')
  ),
  happened_at pg_catalog.timestamptz NOT NULL,
  payload pg_catalog.jsonb NOT NULL,
  PRIMARY KEY (session_id, sequence),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES hirearchy.assessment_sessions (organization_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE hirearchy.candidate_session_operations (
  organization_id pg_catalog.uuid NOT NULL,
  session_id pg_catalog.text NOT NULL,
  request_id pg_catalog.text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  action pg_catalog.text NOT NULL CHECK (action IN ('save', 'submit')),
  intent_digest pg_catalog.text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
  result pg_catalog.jsonb NOT NULL,
  accepted_at pg_catalog.timestamptz NOT NULL,
  PRIMARY KEY (session_id, request_id),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES hirearchy.assessment_sessions (organization_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE hirearchy.candidate_session_submissions (
  organization_id pg_catalog.uuid NOT NULL,
  session_id pg_catalog.text PRIMARY KEY,
  submitted_at pg_catalog.timestamptz NOT NULL,
  closure_reason pg_catalog.text NOT NULL CHECK (
    closure_reason IN ('candidate_submission', 'timeout')
  ),
  workspace_digest pg_catalog.text NOT NULL CHECK (workspace_digest ~ '^[0-9a-f]{64}$'),
  manifest_digest pg_catalog.text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  manifest pg_catalog.jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(manifest) = 'array'),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES hirearchy.assessment_sessions (organization_id, id)
    ON DELETE RESTRICT
);

ALTER TABLE hirearchy.candidate_workspace_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.candidate_workspace_files FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.candidate_session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.candidate_session_events FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.candidate_session_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.candidate_session_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.candidate_session_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.candidate_session_submissions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE hirearchy.candidate_workspace_files FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;
REVOKE ALL ON TABLE hirearchy.candidate_session_events FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;
REVOKE ALL ON TABLE hirearchy.candidate_session_operations FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;
REVOKE ALL ON TABLE hirearchy.candidate_session_submissions FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;

-- These policies scope the function owner to the capability supplied to the
-- SECURITY DEFINER entry point. The application login receives no table grants.
CREATE POLICY r26_candidate_session_select
  ON hirearchy.assessment_sessions
  FOR SELECT TO hirearchy_migrator
  USING (
    id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND EXISTS (
      SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
      WHERE envelope.session_id = assessment_sessions.id
        AND envelope.candidate_token_hash = NULLIF(
          pg_catalog.current_setting('r26.token_hash', true), ''
        )
    )
  );

CREATE POLICY r26_candidate_session_update
  ON hirearchy.assessment_sessions
  FOR UPDATE TO hirearchy_migrator
  USING (
    id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND EXISTS (
      SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
      WHERE envelope.session_id = assessment_sessions.id
        AND envelope.candidate_token_hash = NULLIF(
          pg_catalog.current_setting('r26.token_hash', true), ''
        )
    )
  )
  WITH CHECK (
    id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND EXISTS (
      SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
      WHERE envelope.session_id = assessment_sessions.id
        AND envelope.candidate_token_hash = NULLIF(
          pg_catalog.current_setting('r26.token_hash', true), ''
        )
    )
  );

CREATE POLICY r26_candidate_envelope_capability
  ON hirearchy.candidate_token_envelopes
  FOR SELECT TO hirearchy_migrator
  USING (
    session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND candidate_token_hash = NULLIF(
      pg_catalog.current_setting('r26.token_hash', true), ''
    )
  );

CREATE POLICY r26_candidate_workspace_select
  ON hirearchy.candidate_workspace_files
  FOR SELECT TO hirearchy_migrator
  USING (
    session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND EXISTS (
      SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
      WHERE envelope.session_id = candidate_workspace_files.session_id
        AND envelope.candidate_token_hash = NULLIF(
          pg_catalog.current_setting('r26.token_hash', true), ''
        )
    )
  );

CREATE POLICY r26_candidate_workspace_insert
  ON hirearchy.candidate_workspace_files
  FOR INSERT TO hirearchy_migrator
  WITH CHECK (
    session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND EXISTS (
      SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
      WHERE envelope.session_id = candidate_workspace_files.session_id
        AND envelope.candidate_token_hash = NULLIF(
          pg_catalog.current_setting('r26.token_hash', true), ''
        )
    )
    AND EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions AS session
      WHERE session.id = candidate_workspace_files.session_id
        AND session.status = 'ACTIVE'
    )
  );

CREATE POLICY r26_candidate_workspace_update
  ON hirearchy.candidate_workspace_files
  FOR UPDATE TO hirearchy_migrator
  USING (
    session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND EXISTS (
      SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
      WHERE envelope.session_id = candidate_workspace_files.session_id
        AND envelope.candidate_token_hash = NULLIF(
          pg_catalog.current_setting('r26.token_hash', true), ''
        )
    )
  )
  WITH CHECK (
    session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND EXISTS (
      SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
      WHERE envelope.session_id = candidate_workspace_files.session_id
        AND envelope.candidate_token_hash = NULLIF(
          pg_catalog.current_setting('r26.token_hash', true), ''
        )
    )
    AND EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions AS session
      WHERE session.id = candidate_workspace_files.session_id
        AND session.status = 'ACTIVE'
    )
  );

CREATE TRIGGER candidate_workspace_files_immutable_keys
  BEFORE UPDATE OF organization_id, session_id, file_path
  ON hirearchy.candidate_workspace_files
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_immutable_columns(
    'organization_id', 'session_id', 'file_path'
  );

CREATE POLICY r26_candidate_event_select
  ON hirearchy.candidate_session_events
  FOR SELECT TO hirearchy_migrator
  USING (
    session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND EXISTS (
      SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
      WHERE envelope.session_id = candidate_session_events.session_id
        AND envelope.candidate_token_hash = NULLIF(
          pg_catalog.current_setting('r26.token_hash', true), ''
        )
    )
  );

CREATE POLICY r26_candidate_event_insert
  ON hirearchy.candidate_session_events
  FOR INSERT TO hirearchy_migrator
  WITH CHECK (
    session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND EXISTS (
      SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
      WHERE envelope.session_id = candidate_session_events.session_id
        AND envelope.candidate_token_hash = NULLIF(
          pg_catalog.current_setting('r26.token_hash', true), ''
        )
    )
  );

CREATE POLICY r26_candidate_operation_select
  ON hirearchy.candidate_session_operations
  FOR SELECT TO hirearchy_migrator
  USING (
    session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND EXISTS (
      SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
      WHERE envelope.session_id = candidate_session_operations.session_id
        AND envelope.candidate_token_hash = NULLIF(
          pg_catalog.current_setting('r26.token_hash', true), ''
        )
    )
  );

CREATE POLICY r26_candidate_operation_insert
  ON hirearchy.candidate_session_operations
  FOR INSERT TO hirearchy_migrator
  WITH CHECK (
    session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND EXISTS (
      SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
      WHERE envelope.session_id = candidate_session_operations.session_id
        AND envelope.candidate_token_hash = NULLIF(
          pg_catalog.current_setting('r26.token_hash', true), ''
        )
    )
    AND EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions AS session
      WHERE session.id = candidate_session_operations.session_id
        AND session.status IN ('ACTIVE', 'SUBMITTED')
    )
  );

CREATE POLICY r26_candidate_submission_select
  ON hirearchy.candidate_session_submissions
  FOR SELECT TO hirearchy_migrator
  USING (
    session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND EXISTS (
      SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
      WHERE envelope.session_id = candidate_session_submissions.session_id
        AND envelope.candidate_token_hash = NULLIF(
          pg_catalog.current_setting('r26.token_hash', true), ''
        )
    )
  );

CREATE POLICY r26_candidate_submission_insert
  ON hirearchy.candidate_session_submissions
  FOR INSERT TO hirearchy_migrator
  WITH CHECK (
    session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND EXISTS (
      SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
      WHERE envelope.session_id = candidate_session_submissions.session_id
        AND envelope.candidate_token_hash = NULLIF(
          pg_catalog.current_setting('r26.token_hash', true), ''
        )
    )
    AND EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions AS session
      WHERE session.id = candidate_session_submissions.session_id
        AND session.status = 'SUBMITTED'
        AND session.submitted_at = candidate_session_submissions.submitted_at
        AND session.closure_reason = candidate_session_submissions.closure_reason
    )
  );

CREATE FUNCTION hirearchy.r26_reject_candidate_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'R2.6 candidate evidence is immutable' USING ERRCODE = '23514';
END
$function$;

CREATE TRIGGER candidate_session_events_immutable
  BEFORE UPDATE OR DELETE ON hirearchy.candidate_session_events
  FOR EACH ROW EXECUTE FUNCTION hirearchy.r26_reject_candidate_immutable();
CREATE TRIGGER candidate_session_operations_immutable
  BEFORE UPDATE OR DELETE ON hirearchy.candidate_session_operations
  FOR EACH ROW EXECUTE FUNCTION hirearchy.r26_reject_candidate_immutable();
CREATE TRIGGER candidate_session_submissions_immutable
  BEFORE UPDATE OR DELETE ON hirearchy.candidate_session_submissions
  FOR EACH ROW EXECUTE FUNCTION hirearchy.r26_reject_candidate_immutable();

REVOKE ALL ON FUNCTION hirearchy.r26_reject_candidate_immutable() FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;

CREATE FUNCTION hirearchy.r26_read_issued_snapshot(
  p_session_id pg_catalog.text,
  p_token_hash pg_catalog.text
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_session record;
  v_snapshot pg_catalog.jsonb;
  v_snapshot_duration pg_catalog.int4;
  v_file record;
  v_total_bytes pg_catalog.int8 := 0;
  v_file_count pg_catalog.int8 := 0;
BEGIN
  SELECT s.scenario_id, s.scenario_version, s.scenario_title,
         s.duration_seconds, s.scenario_snapshot
  INTO v_session
  FROM hirearchy.assessment_sessions AS s
  WHERE s.id = p_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'R2.6 issued snapshot unavailable' USING ERRCODE = 'R2606';
  END IF;
  IF v_session.scenario_snapshot IS NULL
     OR v_session.duration_seconds IS NULL OR v_session.duration_seconds <= 0 THEN
    RAISE EXCEPTION 'R2.6 issued snapshot unavailable' USING ERRCODE = 'R2606';
  END IF;

  BEGIN
    v_snapshot := v_session.scenario_snapshot::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'R2.6 issued snapshot unavailable' USING ERRCODE = 'R2606';
  END;

  BEGIN
    v_snapshot_duration := NULLIF(v_snapshot -> 'scenario' ->> 'durationSeconds', '')::pg_catalog.int4;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'R2.6 issued snapshot unavailable' USING ERRCODE = 'R2606';
  END;

  IF pg_catalog.jsonb_typeof(v_snapshot) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_snapshot -> 'scenario') IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_snapshot -> 'workspaceFiles') IS DISTINCT FROM 'object'
     OR v_snapshot -> 'scenario' ->> 'id' IS DISTINCT FROM v_session.scenario_id
     OR v_snapshot -> 'scenario' ->> 'version' IS DISTINCT FROM v_session.scenario_version
     OR v_snapshot -> 'scenario' ->> 'title' IS DISTINCT FROM v_session.scenario_title
     OR v_snapshot_duration IS DISTINCT FROM v_session.duration_seconds THEN
    RAISE EXCEPTION 'R2.6 issued snapshot unavailable' USING ERRCODE = 'R2606';
  END IF;

  SELECT pg_catalog.count(*) INTO v_file_count
  FROM pg_catalog.jsonb_object_keys(v_snapshot -> 'workspaceFiles');
  IF v_file_count = 0 OR v_file_count > 20 THEN
    RAISE EXCEPTION 'R2.6 issued snapshot unavailable' USING ERRCODE = 'R2606';
  END IF;

  FOR v_file IN SELECT key, value FROM pg_catalog.jsonb_each(v_snapshot -> 'workspaceFiles') LOOP
    IF pg_catalog.jsonb_typeof(v_file.value) IS DISTINCT FROM 'string'
       OR v_file.key = ''
       OR pg_catalog.length(v_file.key) > 160
       OR v_file.key <> pg_catalog.btrim(v_file.key)
       OR v_file.key ~ '(^/|/$|//|(^|/)(\.|\.\.)(/|$))'
       OR pg_catalog.strpos(v_file.key, pg_catalog.chr(92)) > 0
       OR pg_catalog.strpos(v_file.key, ':') > 0
       OR v_file.key !~ '\.(py|md|json|txt)$' THEN
      RAISE EXCEPTION 'R2.6 issued snapshot unavailable' USING ERRCODE = 'R2606';
    END IF;
    v_total_bytes := v_total_bytes + pg_catalog.octet_length(
      pg_catalog.convert_to(v_file.value #>> '{}', 'UTF8')
    );
    IF pg_catalog.octet_length(pg_catalog.convert_to(v_file.value #>> '{}', 'UTF8')) > 100000
       OR v_total_bytes > 1048576 THEN
      RAISE EXCEPTION 'R2.6 issued snapshot unavailable' USING ERRCODE = 'R2606';
    END IF;
  END LOOP;

  RETURN v_snapshot;
END
$function$;

CREATE FUNCTION hirearchy.r26_workspace_state(
  p_session_id pg_catalog.text
) RETURNS TABLE (
  files pg_catalog.jsonb,
  identity pg_catalog.jsonb,
  workspace_digest pg_catalog.text,
  manifest_digest pg_catalog.text
)
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'path', f.file_path,
               'content', f.content,
               'version', f.version::pg_catalog.text,
               'digest', f.content_digest
             ) ORDER BY f.file_path
           ),
           '[]'::pg_catalog.jsonb
         ),
         COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'path', f.file_path,
               'version', f.version::pg_catalog.text,
               'digest', f.content_digest
             ) ORDER BY f.file_path
           ),
           '[]'::pg_catalog.jsonb
         )
  INTO files, identity
  FROM hirearchy.candidate_workspace_files AS f
  WHERE f.session_id = p_session_id;

  workspace_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(identity::pg_catalog.text, 'UTF8')),
    'hex'
  );
  manifest_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(files::pg_catalog.text, 'UTF8')),
    'hex'
  );
  RETURN NEXT;
END
$function$;

CREATE FUNCTION hirearchy.r26_candidate_view(
  p_session_id pg_catalog.text,
  p_token_hash pg_catalog.text,
  p_operation pg_catalog.jsonb DEFAULT NULL
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_session record;
  v_snapshot pg_catalog.jsonb;
  v_scenario pg_catalog.jsonb;
  v_submission_view pg_catalog.jsonb := NULL;
  v_files pg_catalog.jsonb := '[]'::pg_catalog.jsonb;
  v_workspace_digest pg_catalog.text;
  v_manifest_digest pg_catalog.text;
  v_deadline pg_catalog.timestamptz;
  v_view pg_catalog.jsonb;
BEGIN
  PERFORM pg_catalog.set_config('r26.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config('r26.token_hash', p_token_hash, true);

  SELECT s.* INTO v_session
  FROM hirearchy.assessment_sessions AS s
  WHERE s.id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'R2.6 candidate session unavailable' USING ERRCODE = 'R2604';
  END IF;
  v_snapshot := hirearchy.r26_read_issued_snapshot(p_session_id, p_token_hash);
  v_scenario := (v_snapshot -> 'scenario') - 'originalContent';

  IF v_session.activated_at IS NOT NULL THEN
    v_deadline := v_session.activated_at + (v_session.duration_seconds * INTERVAL '1 second');
  END IF;

  IF v_session.status = 'SUBMITTED' THEN
    SELECT pg_catalog.jsonb_build_object(
             'submittedAt', submission.submitted_at,
             'closureReason', submission.closure_reason,
             'workspaceDigest', submission.workspace_digest,
             'manifestDigest', submission.manifest_digest,
             'files', submission.manifest
           )
    INTO v_submission_view
    FROM hirearchy.candidate_session_submissions AS submission
    WHERE submission.session_id = p_session_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'R2.6 submission evidence unavailable' USING ERRCODE = 'R2606';
    END IF;
    v_files := v_submission_view -> 'files';
    v_workspace_digest := v_submission_view ->> 'workspaceDigest';
    v_manifest_digest := v_submission_view ->> 'manifestDigest';
  ELSIF v_session.status = 'ACTIVE' THEN
    SELECT state.files, state.workspace_digest, state.manifest_digest
    INTO v_files, v_workspace_digest, v_manifest_digest
    FROM hirearchy.r26_workspace_state(p_session_id) AS state;
  END IF;

  v_view := pg_catalog.jsonb_build_object(
    'sessionId', v_session.id,
    'status', v_session.status,
    'scenario', v_scenario,
    'scenarioDigest', pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(v_session.scenario_snapshot, 'UTF8')),
      'hex'
    ),
    'activatedAt', v_session.activated_at,
    'deadline', v_deadline,
    'durationSeconds', v_session.duration_seconds,
    'submittedAt', v_session.submitted_at,
    'closureReason', v_session.closure_reason,
    'serverNow', pg_catalog.clock_timestamp(),
    'files', v_files,
    'workspaceDigest', v_workspace_digest,
    'events', COALESCE(
      (
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'sequence', event.sequence::pg_catalog.text,
            'type', event.event_type,
            'timestamp', event.happened_at,
            'payload', event.payload
          ) ORDER BY event.sequence
        )
        FROM hirearchy.candidate_session_events AS event
        WHERE event.session_id = p_session_id
      ),
      '[]'::pg_catalog.jsonb
    ),
    'submission', v_submission_view
  );

  IF p_operation IS NOT NULL THEN
    v_view := v_view || pg_catalog.jsonb_build_object('operation', p_operation);
  END IF;
  RETURN v_view;
END
$function$;

CREATE FUNCTION hirearchy.r26_finalize_candidate_session(
  p_session_id pg_catalog.text,
  p_closure_reason pg_catalog.text,
  p_submitted_at pg_catalog.timestamptz
) RETURNS VOID
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_session record;
  v_files pg_catalog.jsonb;
  v_identity pg_catalog.jsonb;
  v_workspace_digest pg_catalog.text;
  v_manifest_digest pg_catalog.text;
  v_sequence pg_catalog.int8;
BEGIN
  IF p_closure_reason NOT IN ('candidate_submission', 'timeout') THEN
    RAISE EXCEPTION 'R2.6 invalid closure reason' USING ERRCODE = 'R2603';
  END IF;
  SELECT s.* INTO v_session
  FROM hirearchy.assessment_sessions AS s
  WHERE s.id = p_session_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'R2.6 candidate session unavailable' USING ERRCODE = 'R2604';
  END IF;
  IF v_session.status = 'SUBMITTED' THEN
    RETURN;
  END IF;
  IF v_session.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'R2.6 candidate session is not active' USING ERRCODE = 'R2605';
  END IF;

  SELECT state.files, state.identity, state.workspace_digest,
         state.manifest_digest
  INTO v_files, v_identity, v_workspace_digest, v_manifest_digest
  FROM hirearchy.r26_workspace_state(p_session_id) AS state;

  UPDATE hirearchy.assessment_sessions
  SET status = 'SUBMITTED', submitted_at = GREATEST(
        p_submitted_at, v_session.activated_at
      ), closure_reason = p_closure_reason
  WHERE id = p_session_id;

  INSERT INTO hirearchy.candidate_session_submissions (
    organization_id, session_id, submitted_at, closure_reason,
    workspace_digest, manifest_digest, manifest
  ) VALUES (
    v_session.organization_id, p_session_id,
    GREATEST(p_submitted_at, v_session.activated_at),
    p_closure_reason, v_workspace_digest, v_manifest_digest, v_files
  );

  SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
  INTO v_sequence
  FROM hirearchy.candidate_session_events AS event
  WHERE event.session_id = p_session_id;
  INSERT INTO hirearchy.candidate_session_events (
    organization_id, session_id, sequence, event_type, happened_at, payload
  ) VALUES (
    v_session.organization_id, p_session_id, v_sequence,
    'SESSION_SUBMITTED', GREATEST(p_submitted_at, v_session.activated_at),
    pg_catalog.jsonb_build_object(
      'closureReason', p_closure_reason,
      'workspaceDigest', v_workspace_digest,
      'manifestDigest', v_manifest_digest
    )
  );
END
$function$;

CREATE FUNCTION hirearchy.r26_candidate_command(
  p_token_hash pg_catalog.text,
  p_session_id pg_catalog.text,
  p_action pg_catalog.text,
  p_input pg_catalog.jsonb
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session record;
  v_snapshot pg_catalog.jsonb;
  v_workspace_files pg_catalog.jsonb;
  v_file record;
  v_content pg_catalog.text;
  v_path pg_catalog.text;
  v_request_id pg_catalog.text;
  v_expected_version pg_catalog.int8;
  v_current_version pg_catalog.int8;
  v_current_digest pg_catalog.text;
  v_new_digest pg_catalog.text;
  v_current_bytes pg_catalog.int8;
  v_new_bytes pg_catalog.int8;
  v_intent_digest pg_catalog.text;
  v_prior record;
  v_deadline pg_catalog.timestamptz;
  v_now pg_catalog.timestamptz;
  v_admitted_at pg_catalog.timestamptz := pg_catalog.statement_timestamp();
  v_closure_reason pg_catalog.text;
  v_sequence pg_catalog.int8;
  v_workspace_state record;
  v_operation pg_catalog.jsonb;
BEGIN
  IF SESSION_USER <> 'app_candidate_gateway'
     OR CURRENT_USER <> 'hirearchy_migrator' THEN
    RAISE EXCEPTION 'R2.6 candidate role denied' USING ERRCODE = 'R2608';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$'
     OR p_action NOT IN ('read', 'activate', 'save', 'submit')
     OR p_input IS NULL OR pg_catalog.jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'R2.6 invalid candidate command' USING ERRCODE = 'R2603';
  END IF;

  PERFORM pg_catalog.set_config('r26.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config('r26.token_hash', p_token_hash, true);

  -- The row lock serializes activation, saves, reads that cross the deadline,
  -- and submission against one durable session capability.
  SELECT s.* INTO v_session
  FROM hirearchy.assessment_sessions AS s
  WHERE s.id = p_session_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'R2.6 candidate session unavailable' USING ERRCODE = 'R2604';
  END IF;

  v_snapshot := hirearchy.r26_read_issued_snapshot(p_session_id, p_token_hash);

  IF p_action IN ('save', 'submit') THEN
    v_request_id := p_input ->> 'requestId';
    IF v_request_id IS NULL OR v_request_id !~ '^[A-Za-z0-9_-]{1,128}$' THEN
      RAISE EXCEPTION 'R2.6 invalid request ID' USING ERRCODE = 'R2603';
    END IF;
    v_intent_digest := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.jsonb_build_object('action', p_action, 'input', p_input)::pg_catalog.text,
        'UTF8'
      )),
      'hex'
    );
    SELECT operation.action, operation.intent_digest
    INTO v_prior
    FROM hirearchy.candidate_session_operations AS operation
    WHERE operation.session_id = p_session_id
      AND operation.request_id = v_request_id;
    IF FOUND THEN
      IF v_prior.action <> p_action OR v_prior.intent_digest <> v_intent_digest THEN
        RAISE EXCEPTION 'R2.6 request ID reused with different intent' USING ERRCODE = 'R2601';
      END IF;
      RETURN hirearchy.r26_candidate_view(
        p_session_id, p_token_hash,
        pg_catalog.jsonb_build_object('requestId', v_request_id, 'replayed', true)
      );
    END IF;
  END IF;

  IF p_action IN ('read', 'activate') AND p_input <> '{}'::pg_catalog.jsonb THEN
    RAISE EXCEPTION 'R2.6 invalid candidate command' USING ERRCODE = 'R2603';
  END IF;

  IF p_action = 'read' THEN
    v_now := pg_catalog.clock_timestamp();
    IF v_session.status = 'ACTIVE' THEN
      v_deadline := v_session.activated_at + (v_session.duration_seconds * INTERVAL '1 second');
      IF v_now >= v_deadline THEN
        PERFORM hirearchy.r26_finalize_candidate_session(
          p_session_id, 'timeout', GREATEST(v_now, v_deadline)
        );
      END IF;
    END IF;
    RETURN hirearchy.r26_candidate_view(p_session_id, p_token_hash);
  END IF;

  IF p_action = 'activate' THEN
    IF v_session.status = 'ACTIVE' THEN
      RETURN hirearchy.r26_candidate_view(p_session_id, p_token_hash);
    END IF;
    IF v_session.status <> 'CREATED' THEN
      RAISE EXCEPTION 'R2.6 candidate session is already final' USING ERRCODE = 'R2605';
    END IF;

    v_workspace_files := v_snapshot -> 'workspaceFiles';
    v_now := GREATEST(pg_catalog.clock_timestamp(), v_session.created_at);
    UPDATE hirearchy.assessment_sessions
    SET status = 'ACTIVE', activated_at = v_now
    WHERE id = p_session_id;

    FOR v_file IN SELECT key, value FROM pg_catalog.jsonb_each(v_workspace_files) LOOP
      v_path := v_file.key;
      v_content := v_file.value #>> '{}';
      INSERT INTO hirearchy.candidate_workspace_files (
        organization_id, session_id, file_path, content, version, content_digest
      ) VALUES (
        v_session.organization_id, p_session_id, v_path, v_content, 0,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_content, 'UTF8')), 'hex')
      );
    END LOOP;

    SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
    INTO v_sequence
    FROM hirearchy.candidate_session_events AS event
    WHERE event.session_id = p_session_id;
    INSERT INTO hirearchy.candidate_session_events (
      organization_id, session_id, sequence, event_type, happened_at, payload
    ) VALUES (
      v_session.organization_id, p_session_id, v_sequence,
      'SESSION_ACTIVATED', GREATEST(v_now, v_session.created_at),
      pg_catalog.jsonb_build_object('scenarioDigest', pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(v_session.scenario_snapshot, 'UTF8')),
        'hex'
      ))
    );
    RETURN hirearchy.r26_candidate_view(p_session_id, p_token_hash);
  END IF;

  IF p_action = 'save' THEN
    IF NOT (p_input ?& ARRAY['requestId', 'path', 'content', 'expectedVersion'])
       OR (p_input - ARRAY['requestId', 'path', 'content', 'expectedVersion']) <> '{}'::pg_catalog.jsonb
       OR pg_catalog.jsonb_typeof(p_input -> 'path') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(p_input -> 'content') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(p_input -> 'expectedVersion') IS DISTINCT FROM 'string'
       OR (p_input ->> 'expectedVersion') !~ '^(0|[1-9][0-9]{0,18})$' THEN
      RAISE EXCEPTION 'R2.6 invalid save input' USING ERRCODE = 'R2603';
    END IF;
    IF v_session.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'R2.6 candidate session is not active' USING ERRCODE = 'R2605';
    END IF;
    v_now := pg_catalog.clock_timestamp();
    v_deadline := v_session.activated_at + (v_session.duration_seconds * INTERVAL '1 second');
    IF v_now >= v_deadline THEN
      RAISE EXCEPTION 'R2.6 candidate deadline exceeded' USING ERRCODE = 'R2607';
    END IF;

    v_path := p_input ->> 'path';
    v_content := pg_catalog.replace(
      pg_catalog.replace(p_input ->> 'content', E'\r\n', E'\n'),
      E'\r', E'\n'
    );
    IF v_path = '' OR v_path <> pg_catalog.btrim(v_path)
       OR v_path ~ '(^/|/$|//|(^|/)(\.|\.\.)(/|$))'
       OR pg_catalog.strpos(v_path, pg_catalog.chr(92)) > 0
       OR pg_catalog.strpos(v_path, ':') > 0 THEN
      RAISE EXCEPTION 'R2.6 invalid file path' USING ERRCODE = 'R2603';
    END IF;
    IF pg_catalog.octet_length(pg_catalog.convert_to(v_content, 'UTF8')) > 100000 THEN
      RAISE EXCEPTION 'R2.6 candidate file too large' USING ERRCODE = 'R2609';
    END IF;

    SELECT file.version, file.content_digest,
           pg_catalog.octet_length(pg_catalog.convert_to(file.content, 'UTF8'))
    INTO v_current_version, v_current_digest, v_current_bytes
    FROM hirearchy.candidate_workspace_files AS file
    WHERE file.session_id = p_session_id AND file.file_path = v_path
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'R2.6 file is not in the issued snapshot' USING ERRCODE = 'R2603';
    END IF;
    v_expected_version := (p_input ->> 'expectedVersion')::pg_catalog.int8;
    IF v_current_version <> v_expected_version THEN
      RAISE EXCEPTION 'R2.6 workspace version changed' USING ERRCODE = 'R2602';
    END IF;

    SELECT COALESCE(
      pg_catalog.sum(pg_catalog.octet_length(pg_catalog.convert_to(file.content, 'UTF8'))), 0
    )
    INTO v_current_bytes
    FROM hirearchy.candidate_workspace_files AS file
    WHERE file.session_id = p_session_id;
    v_new_bytes := v_current_bytes
      - pg_catalog.octet_length(pg_catalog.convert_to(
          (SELECT file.content FROM hirearchy.candidate_workspace_files AS file
           WHERE file.session_id = p_session_id AND file.file_path = v_path),
          'UTF8'
        ))
      + pg_catalog.octet_length(pg_catalog.convert_to(v_content, 'UTF8'));
    IF v_new_bytes > 1048576 THEN
      RAISE EXCEPTION 'R2.6 candidate workspace too large' USING ERRCODE = 'R2609';
    END IF;

    v_new_digest := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(v_content, 'UTF8')),
      'hex'
    );
    UPDATE hirearchy.candidate_workspace_files
    SET content = v_content,
        version = version + 1,
        content_digest = v_new_digest,
        updated_at = v_now
    WHERE session_id = p_session_id AND file_path = v_path;

    SELECT state.files, state.identity, state.workspace_digest, state.manifest_digest
    INTO v_workspace_state
    FROM hirearchy.r26_workspace_state(p_session_id) AS state;
    SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
    INTO v_sequence
    FROM hirearchy.candidate_session_events AS event
    WHERE event.session_id = p_session_id;
    INSERT INTO hirearchy.candidate_session_events (
      organization_id, session_id, sequence, event_type, happened_at, payload
    ) VALUES (
      v_session.organization_id, p_session_id, v_sequence, 'WORKSPACE_CHANGED', v_now,
      pg_catalog.jsonb_build_object(
        'requestId', v_request_id,
        'path', v_path,
        'previousVersion', v_current_version::pg_catalog.text,
        'version', (v_current_version + 1)::pg_catalog.text,
        'previousDigest', v_current_digest,
        'digest', v_new_digest
      )
    );

    INSERT INTO hirearchy.candidate_session_operations (
      organization_id, session_id, request_id, action,
      intent_digest, result, accepted_at
    ) VALUES (
      v_session.organization_id, p_session_id, v_request_id, 'save',
      v_intent_digest,
      pg_catalog.jsonb_build_object(
        'path', v_path,
        'version', (v_current_version + 1)::pg_catalog.text,
        'digest', v_new_digest,
        'workspaceDigest', v_workspace_state.workspace_digest,
        'sequence', v_sequence::pg_catalog.text
      ),
      v_now
    );
    RETURN hirearchy.r26_candidate_view(
      p_session_id, p_token_hash,
      pg_catalog.jsonb_build_object('requestId', v_request_id, 'replayed', false)
    );
  END IF;

  IF p_action = 'submit' THEN
    IF NOT (p_input ?& ARRAY['requestId', 'expectedWorkspaceDigest'])
       OR (p_input - ARRAY['requestId', 'expectedWorkspaceDigest']) <> '{}'::pg_catalog.jsonb
       OR pg_catalog.jsonb_typeof(p_input -> 'expectedWorkspaceDigest') IS DISTINCT FROM 'string'
       OR (p_input ->> 'expectedWorkspaceDigest') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'R2.6 invalid submission input' USING ERRCODE = 'R2603';
    END IF;
    IF v_session.status = 'SUBMITTED' THEN
      SELECT submission.workspace_digest INTO v_current_digest
      FROM hirearchy.candidate_session_submissions AS submission
      WHERE submission.session_id = p_session_id;
      IF NOT FOUND OR v_current_digest <> p_input ->> 'expectedWorkspaceDigest' THEN
        RAISE EXCEPTION 'R2.6 submitted workspace differs' USING ERRCODE = 'R2602';
      END IF;
      INSERT INTO hirearchy.candidate_session_operations (
        organization_id, session_id, request_id, action,
        intent_digest, result, accepted_at
      ) VALUES (
        v_session.organization_id, p_session_id, v_request_id, 'submit',
        v_intent_digest,
        pg_catalog.jsonb_build_object(
          'workspaceDigest', v_current_digest,
          'closureReason', v_session.closure_reason,
          'submittedAt', v_session.submitted_at
        ),
        pg_catalog.clock_timestamp()
      );
      RETURN hirearchy.r26_candidate_view(
        p_session_id, p_token_hash,
        pg_catalog.jsonb_build_object('requestId', v_request_id, 'replayed', true)
      );
    END IF;
    IF v_session.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'R2.6 candidate session is not active' USING ERRCODE = 'R2605';
    END IF;
    SELECT state.workspace_digest INTO v_current_digest
    FROM hirearchy.r26_workspace_state(p_session_id) AS state;
    IF v_current_digest <> p_input ->> 'expectedWorkspaceDigest' THEN
      RAISE EXCEPTION 'R2.6 workspace digest changed' USING ERRCODE = 'R2602';
    END IF;
    v_deadline := v_session.activated_at + (v_session.duration_seconds * INTERVAL '1 second');
    v_closure_reason := CASE
      WHEN v_admitted_at < v_deadline THEN 'candidate_submission'
      ELSE 'timeout'
    END;
    v_now := GREATEST(pg_catalog.clock_timestamp(), v_session.activated_at);
    PERFORM hirearchy.r26_finalize_candidate_session(
      p_session_id, v_closure_reason, v_now
    );
    SELECT submission.workspace_digest, submission.manifest_digest,
           submission.closure_reason, submission.submitted_at
    INTO v_workspace_state
    FROM hirearchy.candidate_session_submissions AS submission
    WHERE submission.session_id = p_session_id;
    INSERT INTO hirearchy.candidate_session_operations (
      organization_id, session_id, request_id, action,
      intent_digest, result, accepted_at
    ) VALUES (
      v_session.organization_id, p_session_id, v_request_id, 'submit',
      v_intent_digest,
      pg_catalog.jsonb_build_object(
        'workspaceDigest', v_workspace_state.workspace_digest,
        'manifestDigest', v_workspace_state.manifest_digest,
        'closureReason', v_workspace_state.closure_reason,
        'submittedAt', v_workspace_state.submitted_at
      ),
      v_now
    );
    RETURN hirearchy.r26_candidate_view(
      p_session_id, p_token_hash,
      pg_catalog.jsonb_build_object('requestId', v_request_id, 'replayed', false)
    );
  END IF;

  RAISE EXCEPTION 'R2.6 unsupported candidate command' USING ERRCODE = 'R2603';
END
$function$;

REVOKE ALL ON FUNCTION hirearchy.r26_reject_candidate_immutable() FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;
REVOKE ALL ON FUNCTION hirearchy.r26_read_issued_snapshot(pg_catalog.text, pg_catalog.text) FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;
REVOKE ALL ON FUNCTION hirearchy.r26_workspace_state(pg_catalog.text) FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;
REVOKE ALL ON FUNCTION hirearchy.r26_candidate_view(pg_catalog.text, pg_catalog.text, pg_catalog.jsonb) FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;
REVOKE ALL ON FUNCTION hirearchy.r26_finalize_candidate_session(pg_catalog.text, pg_catalog.text, pg_catalog.timestamptz) FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;
REVOKE ALL ON FUNCTION hirearchy.r26_candidate_command(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb) FROM PUBLIC, app_evaluator, app_control_worker;
GRANT EXECUTE ON FUNCTION hirearchy.r26_candidate_command(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb) TO app_candidate_gateway;
