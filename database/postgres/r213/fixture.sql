-- Disposable R2.13 Candidate Execution fixture functions; never a production migration.
BEGIN;

-- 1. Function: hirearchy.r213_admit_execution_operation
CREATE OR REPLACE FUNCTION hirearchy.r213_admit_execution_operation(
  p_token_hash pg_catalog.text,
  p_session_id pg_catalog.text,
  p_request_id pg_catalog.text,
  p_expected_workspace_digest pg_catalog.text,
  p_recipe_id pg_catalog.text DEFAULT 'recipe-python-check-v1',
  p_recipe_version pg_catalog.text DEFAULT '1.0.0',
  p_recipe_digest pg_catalog.text DEFAULT '0760fc4197b0b1654be37456fc70f7c1a9159520ca78cd5b3115e7a5affd6fd2',
  p_provenance pg_catalog.text DEFAULT 'synthetic-execution-adapter'
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
  IF SESSION_USER NOT IN ('app_candidate_gateway', 'postgres', 'hirearchy_migrator', 'r23_gateway', 'r23_session_owner') THEN
    RAISE EXCEPTION 'R2.13 candidate role denied' USING ERRCODE = '42501';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$'
     OR p_request_id IS NULL OR p_request_id !~ '^[A-Za-z0-9_-]{1,128}$'
     OR p_expected_workspace_digest IS NULL OR p_expected_workspace_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'R2.13 invalid input parameters' USING ERRCODE = '22023';
  END IF;

  -- Authenticate candidate bearer against token envelopes
  SELECT envelope.organization_id INTO v_envelope_org_id
  FROM hirearchy.candidate_token_envelopes AS envelope
  WHERE envelope.session_id = p_session_id
    AND envelope.candidate_token_hash = p_token_hash;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'R2.13 candidate authentication failed' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config('r26.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config('r26.token_hash', p_token_hash, true);

  -- Row lock serializes admissions per session to ensure atomic budget check
  SELECT s.* INTO v_session
  FROM hirearchy.assessment_sessions AS s
  WHERE s.id = p_session_id
  FOR UPDATE;

  IF NOT FOUND OR v_session.organization_id <> v_envelope_org_id THEN
    RAISE EXCEPTION 'R2.13 candidate session unavailable' USING ERRCODE = 'R2604';
  END IF;

  -- Capability gating: terminal_enabled must be TRUE
  IF v_session.terminal_enabled IS NOT TRUE THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'DENIED',
      'reason', 'TERMINAL_DISABLED',
      'message', 'Terminal execution is disabled for this assessment session'
    );
  END IF;

  -- Session lifecycle verification: must be ACTIVE
  IF v_session.status <> 'ACTIVE' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'DENIED',
      'reason', 'SESSION_CLOSED',
      'message', 'Session is closed or submitted'
    );
  END IF;

  -- Deadline verification
  v_now := pg_catalog.clock_timestamp();
  v_deadline := v_session.activated_at + (v_session.duration_seconds * INTERVAL '1 second');
  IF v_now >= v_deadline THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'DENIED',
      'reason', 'DEADLINE_EXCEEDED',
      'message', 'Assessment session deadline has expired'
    );
  END IF;

  -- Recipe validation
  v_recipe_id := COALESCE(p_recipe_id, 'recipe-python-check-v1');
  v_recipe_version := COALESCE(p_recipe_version, '1.0.0');
  v_recipe_digest := COALESCE(p_recipe_digest, '0760fc4197b0b1654be37456fc70f7c1a9159520ca78cd5b3115e7a5affd6fd2');
  v_provenance := COALESCE(p_provenance, 'synthetic-execution-adapter');

  -- Idempotency check: if request_id already exists for this session
  SELECT op.* INTO v_existing
  FROM hirearchy.candidate_execution_operations AS op
  WHERE op.session_id = p_session_id
    AND op.request_id = p_request_id;

  IF FOUND THEN
    IF v_existing.workspace_digest <> p_expected_workspace_digest
       OR v_existing.recipe_id <> v_recipe_id
       OR v_existing.recipe_version <> v_recipe_version
       OR v_existing.recipe_digest <> v_recipe_digest THEN
      RAISE EXCEPTION 'R2.13 request ID reused with different intent' USING ERRCODE = '23514';
    END IF;

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

    SELECT pg_catalog.count(*) INTO v_current_count
    FROM hirearchy.candidate_execution_operations
    WHERE session_id = p_session_id;

    RETURN pg_catalog.jsonb_build_object(
      'status', 'REPLAY',
      'remainingExecutions', GREATEST(0, v_max_executions - v_current_count),
      'intent', v_intent_json,
      'operation', v_op_json
    );
  END IF;

  -- Recipe approval and scenario whitelist check
  IF (v_recipe_id = 'recipe-python-check-v1' AND v_recipe_version = '1.0.0' AND v_recipe_digest = '0760fc4197b0b1654be37456fc70f7c1a9159520ca78cd5b3115e7a5affd6fd2') THEN
    -- synthetic check is approved
  ELSIF (v_recipe_id = 'reservation-moves.pytest' AND v_recipe_version = '3' AND v_recipe_digest = 'eeac2baaf62ce107c7511268e862657ae24bb171cd1dec6ca01797c16ffbaad8') THEN
    IF v_session.scenario_id IS DISTINCT FROM 'reservation-moves'
       OR v_session.scenario_version IS DISTINCT FROM 'v3'
       OR v_session.scenario_snapshot::pg_catalog.jsonb #>> '{scenario,templateId}' IS DISTINCT FROM 'reservation-moves-v3'
       OR v_session.scenario_snapshot::pg_catalog.jsonb #>> '{scenario,recipe,id}' IS DISTINCT FROM v_recipe_id
       OR v_session.scenario_snapshot::pg_catalog.jsonb #>> '{scenario,recipe,version}' IS DISTINCT FROM v_recipe_version
       OR v_session.scenario_snapshot::pg_catalog.jsonb #>> '{scenario,recipe,digest}' IS DISTINCT FROM v_recipe_digest
       OR v_session.scenario_snapshot::pg_catalog.jsonb #>> '{scenario,starterWorkspaceDigest}' IS DISTINCT FROM 'c1e172b193fd0c5e78f81ef5bf74ea95a07b6be3215829d5fa8e5116423b0694'
       OR COALESCE(v_session.scenario_snapshot::pg_catalog.jsonb #>> '{scenario,validatedContentDigest}', '') !~ '^[0-9a-f]{64}$'
       OR COALESCE(v_session.scenario_snapshot::pg_catalog.jsonb #>> '{scenario,validatedVersionId}', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'DENIED',
        'reason', 'SCENARIO_INCOMPATIBLE',
        'message', 'Restricted executor recipe is only compatible with reservation-moves scenario'
      );
    END IF;
  ELSE
    RETURN pg_catalog.jsonb_build_object(
      'status', 'DENIED',
      'reason', 'INVALID_RECIPE',
      'message', 'Requested execution recipe is not approved'
    );
  END IF;

  -- Persisted workspace state verification via hirearchy.r26_workspace_state
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

  -- Budget limit check (max 10 executions)
  SELECT pg_catalog.count(*) INTO v_current_count
  FROM hirearchy.candidate_execution_operations
  WHERE session_id = p_session_id;

  IF v_current_count >= v_max_executions THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'DENIED',
      'reason', 'BUDGET_EXHAUSTED',
      'message', 'Execution budget limit of 10 runs reached'
    );
  END IF;

  -- Allocate sequence in candidate_session_events
  SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
  INTO v_sequence
  FROM hirearchy.candidate_session_events AS event
  WHERE event.session_id = p_session_id;

  v_operation_id := 'op_exec_' || pg_catalog.substr(p_request_id, 1, 110);

  -- Record EXECUTION_REQUESTED event
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

  -- Record ADMITTED operation row
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

-- 2. Function: hirearchy.r213_complete_execution_operation
CREATE OR REPLACE FUNCTION hirearchy.r213_complete_execution_operation(
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
  IF SESSION_USER NOT IN ('app_candidate_gateway', 'postgres', 'hirearchy_migrator', 'r23_gateway', 'r23_session_owner') THEN
    RAISE EXCEPTION 'R2.13 candidate role denied' USING ERRCODE = '42501';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$'
     OR p_operation_id IS NULL OR p_operation_id !~ '^[A-Za-z0-9_-]{1,128}$'
     OR p_fence IS NULL OR p_fence <= 0 THEN
    RAISE EXCEPTION 'R2.13 invalid input parameters' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('r26.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config('r26.token_hash', p_token_hash, true);

  -- Authenticate candidate bearer
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

  -- Stale generation or fence rejection
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

  v_cleanup_status := COALESCE(p_cleanup_status, 'CLEAN');
  IF v_cleanup_status NOT IN ('CLEAN', 'RESOURCE_LEAK', 'UNKNOWN') THEN
    v_cleanup_status := 'CLEAN';
  END IF;

  v_provenance := COALESCE(p_provenance, v_op.provenance);

  -- Allocate sequence in candidate_session_events
  SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
  INTO v_sequence
  FROM hirearchy.candidate_session_events AS event
  WHERE event.session_id = p_session_id;

  -- Record EXECUTION_COMPLETED event
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

  -- Update candidate_execution_operations
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

-- 3. Function: hirearchy.r213_fail_execution_operation
CREATE OR REPLACE FUNCTION hirearchy.r213_fail_execution_operation(
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
  IF SESSION_USER NOT IN ('app_candidate_gateway', 'postgres', 'hirearchy_migrator', 'r23_gateway', 'r23_session_owner') THEN
    RAISE EXCEPTION 'R2.13 candidate role denied' USING ERRCODE = '42501';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$'
     OR p_operation_id IS NULL OR p_operation_id !~ '^[A-Za-z0-9_-]{1,128}$'
     OR p_fence IS NULL OR p_fence <= 0 THEN
    RAISE EXCEPTION 'R2.13 invalid input parameters' USING ERRCODE = '22023';
  END IF;

  v_status := COALESCE(p_status, 'FAILED');
  IF v_status NOT IN ('FAILED', 'TIMED_OUT', 'UNKNOWN') THEN
    RAISE EXCEPTION 'R2.13 invalid failure status' USING ERRCODE = '22023';
  END IF;

  v_is_unknown := COALESCE(p_is_unknown, false);
  IF v_status = 'UNKNOWN' THEN
    v_is_unknown := true;
  END IF;

  v_cleanup_status := COALESCE(p_cleanup_status, 'CLEAN');
  IF v_status = 'UNKNOWN' AND v_cleanup_status = 'CLEAN' THEN
    v_cleanup_status := 'UNKNOWN';
  END IF;

  PERFORM pg_catalog.set_config('r26.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config('r26.token_hash', p_token_hash, true);

  -- Authenticate candidate bearer
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

  -- Stale generation or fence rejection
  IF v_op.fence <> p_fence OR v_op.generation <> COALESCE(p_generation, 1) THEN
    RAISE EXCEPTION 'R2.13 stale generation or fence rejected' USING ERRCODE = '23514';
  END IF;

  v_now := pg_catalog.clock_timestamp();

  v_stdout_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(COALESCE(p_stdout, ''), 'UTF8')),
    'hex'
  );

  v_stderr_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(COALESCE(p_stderr, ''), 'UTF8')),
    'hex'
  );

  v_provenance := COALESCE(p_provenance, v_op.provenance);

  -- Allocate sequence in candidate_session_events
  SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
  INTO v_sequence
  FROM hirearchy.candidate_session_events AS event
  WHERE event.session_id = p_session_id;

  -- Record EXECUTION_FAILED event
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

  -- Update candidate_execution_operations
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

-- 4. Function: hirearchy.r213_get_candidate_executions
CREATE OR REPLACE FUNCTION hirearchy.r213_get_candidate_executions(
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
  IF SESSION_USER NOT IN ('app_candidate_gateway', 'postgres', 'hirearchy_migrator', 'r23_gateway', 'r23_session_owner') THEN
    RAISE EXCEPTION 'R2.13 candidate role denied' USING ERRCODE = '42501';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$' THEN
    RAISE EXCEPTION 'R2.13 invalid input parameters' USING ERRCODE = '22023';
  END IF;

  SELECT envelope.organization_id INTO v_envelope_org_id
  FROM hirearchy.candidate_token_envelopes AS envelope
  WHERE envelope.session_id = p_session_id
    AND envelope.candidate_token_hash = p_token_hash;

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

  SELECT pg_catalog.count(*) INTO v_count
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
    'terminalEnabled', COALESCE(v_session.terminal_enabled, false),
    'remainingExecutions', GREATEST(0, 10 - v_count),
    'maxExecutions', 10,
    'currentWorkspaceDigest', COALESCE(v_workspace_digest, ''),
    'operations', v_ops
  );
END
$function$;

-- 5. Function: hirearchy.r213_get_evaluator_executions
CREATE OR REPLACE FUNCTION hirearchy.r213_get_evaluator_executions(
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text,
  p_reviewer_principal_id pg_catalog.uuid DEFAULT NULL
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_ops pg_catalog.jsonb;
BEGIN
  IF SESSION_USER NOT IN ('app_evaluator', 'postgres', 'hirearchy_migrator', 'r23_session_owner', 'r23_gateway') THEN
    RAISE EXCEPTION 'R2.13 evaluator role denied' USING ERRCODE = '42501';
  END IF;

  IF p_organization_id IS NULL
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$' THEN
    RAISE EXCEPTION 'R2.13 invalid input parameters' USING ERRCODE = '22023';
  END IF;

  v_principal_id := COALESCE(
    p_reviewer_principal_id,
    NULLIF(pg_catalog.current_setting('r27.principal_id', true), '')::pg_catalog.uuid,
    NULLIF(pg_catalog.current_setting('hirearchy.evaluator_principal_id', true), '')::pg_catalog.uuid
  );

  IF v_principal_id IS NULL THEN
    RAISE EXCEPTION 'R2.13 evaluator principal identity required' USING ERRCODE = '42501';
  END IF;

  -- Reviewer authorization: active reviewer assignment in specified organization on submitted session
  IF NOT EXISTS (
    SELECT 1
    FROM hirearchy.reviewer_assignments AS assignment
    JOIN hirearchy.organization_memberships AS membership
      ON membership.organization_id = assignment.organization_id
     AND membership.principal_id = assignment.reviewer_principal_id
    JOIN hirearchy.assessment_sessions AS session
      ON session.organization_id = assignment.organization_id
     AND session.id = assignment.session_id
    WHERE assignment.organization_id = p_organization_id
      AND assignment.session_id = p_session_id
      AND assignment.reviewer_principal_id = v_principal_id
      AND assignment.revoked_at IS NULL
      AND membership.role = 'reviewer'
      AND membership.status = 'active'
      AND membership.revoked_at IS NULL
      AND session.status = 'SUBMITTED'
  ) THEN
    RAISE EXCEPTION 'R2.13 evaluator access denied' USING ERRCODE = '42501';
  END IF;

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
  WHERE op.organization_id = p_organization_id
    AND op.session_id = p_session_id;

  RETURN v_ops;
END
$function$;

-- 6. Schema r213 wrappers
CREATE SCHEMA IF NOT EXISTS r213;

CREATE OR REPLACE FUNCTION r213.admit_execution_operation(
  p_token_hash pg_catalog.text,
  p_session_id pg_catalog.text,
  p_request_id pg_catalog.text,
  p_expected_workspace_digest pg_catalog.text,
  p_recipe_id pg_catalog.text DEFAULT 'recipe-python-check-v1',
  p_recipe_version pg_catalog.text DEFAULT '1.0.0',
  p_recipe_digest pg_catalog.text DEFAULT '0760fc4197b0b1654be37456fc70f7c1a9159520ca78cd5b3115e7a5affd6fd2',
  p_provenance pg_catalog.text DEFAULT 'synthetic-execution-adapter'
) RETURNS pg_catalog.jsonb
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT hirearchy.r213_admit_execution_operation(
    p_token_hash, p_session_id, p_request_id, p_expected_workspace_digest,
    p_recipe_id, p_recipe_version, p_recipe_digest, p_provenance
  );
$$;

CREATE OR REPLACE FUNCTION r213.complete_execution_operation(
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
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT hirearchy.r213_complete_execution_operation(
    p_token_hash, p_session_id, p_operation_id, p_fence, p_generation,
    p_exit_code, p_stdout, p_stderr, p_stdout_digest, p_stderr_digest,
    p_truncated_stdout, p_truncated_stderr, p_duration_ms, p_cleanup_status,
    p_provenance
  );
$$;

CREATE OR REPLACE FUNCTION r213.fail_execution_operation(
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
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT hirearchy.r213_fail_execution_operation(
    p_token_hash, p_session_id, p_operation_id, p_fence, p_generation,
    p_status, p_failure_reason, p_error_message, p_stdout, p_stderr,
    p_duration_ms, p_cleanup_status, p_is_unknown, p_provenance
  );
$$;

CREATE OR REPLACE FUNCTION r213.get_candidate_executions(
  p_token_hash pg_catalog.text,
  p_session_id pg_catalog.text
) RETURNS pg_catalog.jsonb
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT hirearchy.r213_get_candidate_executions(p_token_hash, p_session_id);
$$;

CREATE OR REPLACE FUNCTION r213.get_evaluator_executions(
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text,
  p_reviewer_principal_id pg_catalog.uuid DEFAULT NULL
) RETURNS pg_catalog.jsonb
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT hirearchy.r213_get_evaluator_executions(p_organization_id, p_session_id, p_reviewer_principal_id);
$$;

-- 7. Permissions and Grants
GRANT USAGE ON SCHEMA hirearchy TO app_evaluator, app_control_worker;
GRANT USAGE ON SCHEMA r213 TO app_candidate_gateway, app_evaluator, app_control_worker;

GRANT EXECUTE ON FUNCTION hirearchy.r213_admit_execution_operation(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO app_candidate_gateway;
GRANT EXECUTE ON FUNCTION hirearchy.r213_complete_execution_operation(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int8, pg_catalog.int4, pg_catalog.int4, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, boolean, boolean, pg_catalog.int4, pg_catalog.text, pg_catalog.text) TO app_candidate_gateway;
GRANT EXECUTE ON FUNCTION hirearchy.r213_fail_execution_operation(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int8, pg_catalog.int4, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4, pg_catalog.text, boolean, pg_catalog.text) TO app_candidate_gateway;
GRANT EXECUTE ON FUNCTION hirearchy.r213_get_candidate_executions(pg_catalog.text, pg_catalog.text) TO app_candidate_gateway;
GRANT EXECUTE ON FUNCTION hirearchy.r213_get_evaluator_executions(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) TO app_evaluator;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA r213 TO app_candidate_gateway, app_evaluator;

DO $gateway_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r23_gateway') THEN
    GRANT USAGE ON SCHEMA r213 TO r23_gateway;
    GRANT EXECUTE ON FUNCTION hirearchy.r213_admit_execution_operation(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO r23_gateway;
    GRANT EXECUTE ON FUNCTION hirearchy.r213_complete_execution_operation(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int8, pg_catalog.int4, pg_catalog.int4, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, boolean, boolean, pg_catalog.int4, pg_catalog.text, pg_catalog.text) TO r23_gateway;
    GRANT EXECUTE ON FUNCTION hirearchy.r213_fail_execution_operation(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int8, pg_catalog.int4, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4, pg_catalog.text, boolean, pg_catalog.text) TO r23_gateway;
    GRANT EXECUTE ON FUNCTION hirearchy.r213_get_candidate_executions(pg_catalog.text, pg_catalog.text) TO r23_gateway;
    GRANT EXECUTE ON FUNCTION hirearchy.r213_get_evaluator_executions(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) TO r23_gateway;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA r213 TO r23_gateway;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r23_session_owner') THEN
    GRANT USAGE ON SCHEMA r213 TO r23_session_owner;
    GRANT EXECUTE ON FUNCTION hirearchy.r213_admit_execution_operation(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO r23_session_owner;
    GRANT EXECUTE ON FUNCTION hirearchy.r213_complete_execution_operation(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int8, pg_catalog.int4, pg_catalog.int4, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, boolean, boolean, pg_catalog.int4, pg_catalog.text, pg_catalog.text) TO r23_session_owner;
    GRANT EXECUTE ON FUNCTION hirearchy.r213_fail_execution_operation(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int8, pg_catalog.int4, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4, pg_catalog.text, boolean, pg_catalog.text) TO r23_session_owner;
    GRANT EXECUTE ON FUNCTION hirearchy.r213_get_candidate_executions(pg_catalog.text, pg_catalog.text) TO r23_session_owner;
    GRANT EXECUTE ON FUNCTION hirearchy.r213_get_evaluator_executions(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) TO r23_session_owner;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA r213 TO r23_session_owner;
  END IF;
END
$gateway_grants$;

COMMIT;
