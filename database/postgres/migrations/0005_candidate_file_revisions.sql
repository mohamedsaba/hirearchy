CREATE TABLE hirearchy.candidate_file_revisions (
  organization_id pg_catalog.uuid NOT NULL,
  session_id pg_catalog.text NOT NULL,
  file_path pg_catalog.text NOT NULL,
  version pg_catalog.int8 NOT NULL CHECK (version >= 1),
  request_id pg_catalog.text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  event_sequence pg_catalog.int8 NOT NULL CHECK (event_sequence > 0),
  accepted_at pg_catalog.timestamptz NOT NULL,
  content_encoding pg_catalog.text NOT NULL DEFAULT 'utf-8' CHECK (content_encoding = 'utf-8'),
  content pg_catalog.text NOT NULL,
  content_length pg_catalog.int8 NOT NULL CHECK (content_length >= 0 AND content_length <= 100000),
  content_digest pg_catalog.text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  previous_version pg_catalog.int8 NOT NULL CHECK (previous_version >= 0),
  previous_digest pg_catalog.text NOT NULL CHECK (previous_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (session_id, file_path, version),
  UNIQUE (session_id, request_id),
  UNIQUE (session_id, event_sequence),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES hirearchy.assessment_sessions (organization_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (session_id, request_id)
    REFERENCES hirearchy.candidate_session_operations (session_id, request_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (session_id, event_sequence)
    REFERENCES hirearchy.candidate_session_events (session_id, sequence)
    ON DELETE RESTRICT,
  CHECK (content_length = pg_catalog.octet_length(pg_catalog.convert_to(content, 'UTF8'))),
  CHECK (content_digest = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(content, 'UTF8')), 'hex')),
  CHECK (version = previous_version + 1)
);

CREATE INDEX candidate_file_revisions_org_session_idx
  ON hirearchy.candidate_file_revisions (organization_id, session_id);

ALTER TABLE hirearchy.candidate_file_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.candidate_file_revisions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE hirearchy.candidate_file_revisions
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker, r23_gateway;

CREATE POLICY r26_candidate_revision_select
  ON hirearchy.candidate_file_revisions
  FOR SELECT TO hirearchy_migrator
  USING (
    session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND EXISTS (
      SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
      WHERE envelope.session_id = candidate_file_revisions.session_id
        AND envelope.candidate_token_hash = NULLIF(
          pg_catalog.current_setting('r26.token_hash', true), ''
        )
    )
  );

CREATE POLICY r26_candidate_revision_insert
  ON hirearchy.candidate_file_revisions
  FOR INSERT TO hirearchy_migrator
  WITH CHECK (
    session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND EXISTS (
      SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
      WHERE envelope.session_id = candidate_file_revisions.session_id
        AND envelope.candidate_token_hash = NULLIF(
          pg_catalog.current_setting('r26.token_hash', true), ''
        )
    )
    AND EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions AS session
      WHERE session.id = candidate_file_revisions.session_id
        AND session.status = 'ACTIVE'
    )
  );

CREATE TRIGGER candidate_file_revisions_immutable
  BEFORE UPDATE OR DELETE ON hirearchy.candidate_file_revisions
  FOR EACH ROW EXECUTE FUNCTION hirearchy.r26_reject_candidate_immutable();

CREATE OR REPLACE FUNCTION hirearchy.r26_candidate_command(
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

    IF (SELECT COALESCE(pg_catalog.sum(content_length), 0) FROM hirearchy.candidate_file_revisions WHERE session_id = p_session_id) + pg_catalog.octet_length(pg_catalog.convert_to(v_content, 'UTF8')) > 10485760 THEN
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

    INSERT INTO hirearchy.candidate_file_revisions (
      organization_id, session_id, file_path, version,
      request_id, event_sequence, accepted_at,
      content_encoding, content, content_length,
      content_digest, previous_version, previous_digest
    ) VALUES (
      v_session.organization_id, p_session_id, v_path, v_current_version + 1,
      v_request_id, v_sequence, v_now,
      'utf-8', v_content, pg_catalog.octet_length(pg_catalog.convert_to(v_content, 'UTF8')),
      v_new_digest, v_current_version, v_current_digest
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

ALTER FUNCTION hirearchy.r26_candidate_command(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb) OWNER TO hirearchy_migrator;
REVOKE ALL ON FUNCTION hirearchy.r26_candidate_command(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb) FROM PUBLIC, app_evaluator, app_control_worker;
GRANT EXECUTE ON FUNCTION hirearchy.r26_candidate_command(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb) TO app_candidate_gateway;
