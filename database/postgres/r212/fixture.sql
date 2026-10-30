-- Disposable R2.12 Candidate AI Assistance fixture functions; never a production migration.
BEGIN;

-- 1. Function: hirearchy.r212_admit_ai_interaction
CREATE OR REPLACE FUNCTION hirearchy.r212_admit_ai_interaction(
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
  v_max_interactions pg_catalog.int4 := 5;
  v_current_count pg_catalog.int4 := 0;
  v_remaining_budget pg_catalog.int4;
  v_provider_id pg_catalog.text;
  v_model_id pg_catalog.text;
BEGIN
  IF SESSION_USER NOT IN ('app_candidate_gateway', 'postgres', 'hirearchy_migrator', 'r23_gateway') THEN
    RAISE EXCEPTION 'R2.12 candidate role denied' USING ERRCODE = '42501';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$'
     OR p_request_id IS NULL OR p_request_id !~ '^[A-Za-z0-9_-]{1,128}$'
     OR p_prompt IS NULL THEN
    RAISE EXCEPTION 'R2.12 invalid input parameters' USING ERRCODE = '22023';
  END IF;

  -- Authenticate candidate bearer against token envelopes
  SELECT envelope.organization_id INTO v_envelope_org_id
  FROM hirearchy.candidate_token_envelopes AS envelope
  WHERE envelope.session_id = p_session_id
    AND envelope.candidate_token_hash = p_token_hash;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'R2.12 candidate authentication failed' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config('r26.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config('r26.token_hash', p_token_hash, true);

  -- Row lock serializes admissions per session to ensure atomic budget check
  SELECT s.* INTO v_session
  FROM hirearchy.assessment_sessions AS s
  WHERE s.id = p_session_id
  FOR UPDATE;

  IF NOT FOUND OR v_session.organization_id <> v_envelope_org_id THEN
    RAISE EXCEPTION 'R2.12 candidate session unavailable' USING ERRCODE = 'R2604';
  END IF;

  -- Capability gating: assessment snapshot MUST have enabled = true
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
    5
  );

  -- Idempotency check: if request_id already exists for this session
  SELECT ai.* INTO v_existing
  FROM hirearchy.candidate_ai_interactions AS ai
  WHERE ai.session_id = p_session_id
    AND ai.request_id = p_request_id;

  IF FOUND THEN
    IF v_existing.candidate_prompt <> p_prompt THEN
      RAISE EXCEPTION 'R2.12 request ID reused with different intent' USING ERRCODE = '23514';
    END IF;

    SELECT pg_catalog.count(*) INTO v_current_count
    FROM hirearchy.candidate_ai_interactions
    WHERE session_id = p_session_id
      AND status IN ('ADMITTED', 'COMPLETED');

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

  -- Session lifecycle verification: must be ACTIVE
  IF v_session.status <> 'ACTIVE' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'DENIED',
      'reason', 'SESSION_CLOSED',
      'remainingBudget', 0
    );
  END IF;

  -- Deadline verification
  v_now := pg_catalog.clock_timestamp();
  v_deadline := v_session.activated_at + (v_session.duration_seconds * INTERVAL '1 second');
  IF v_now >= v_deadline THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'DENIED',
      'reason', 'DEADLINE_EXCEEDED',
      'remainingBudget', 0
    );
  END IF;

  -- Count admitted and completed interactions against budget limit
  SELECT pg_catalog.count(*) INTO v_current_count
  FROM hirearchy.candidate_ai_interactions
  WHERE session_id = p_session_id
    AND status IN ('ADMITTED', 'COMPLETED');

  -- Prompt length check
  IF pg_catalog.char_length(p_prompt) > 4000 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'DENIED',
      'reason', 'PROMPT_TOO_LARGE',
      'remainingBudget', GREATEST(0, v_max_interactions - v_current_count)
    );
  END IF;

  -- Budget limit check
  IF v_current_count >= v_max_interactions THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'DENIED',
      'reason', 'BUDGET_EXHAUSTED',
      'remainingBudget', 0
    );
  END IF;

  -- Allocate sequence in candidate_session_events
  SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
  INTO v_sequence
  FROM hirearchy.candidate_session_events AS event
  WHERE event.session_id = p_session_id;

  v_interaction_id := 'ai_' || p_request_id;
  v_provider_id := COALESCE(v_session.ai_capability_snapshot ->> 'configuredProviderId', 'synthetic-test-provider');
  v_model_id := COALESCE(v_session.ai_capability_snapshot ->> 'configuredModelId', 'synthetic-model-r212');

  -- Record AI_REQUEST_STARTED event
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

  -- Record ADMITTED interaction row
  INSERT INTO hirearchy.candidate_ai_interactions (
    organization_id, session_id, interaction_id, request_id,
    sequence_start, candidate_prompt, status, provider_id, model_id, created_at
  ) VALUES (
    v_session.organization_id, p_session_id, v_interaction_id, p_request_id,
    v_sequence, p_prompt, 'ADMITTED', v_provider_id, v_model_id, v_now
  );

  v_remaining_budget := v_max_interactions - (v_current_count + 1);

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ADMITTED',
    'remainingBudget', v_remaining_budget,
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

-- 2. Function: hirearchy.r212_complete_ai_interaction
CREATE OR REPLACE FUNCTION hirearchy.r212_complete_ai_interaction(
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
  IF SESSION_USER NOT IN ('app_candidate_gateway', 'postgres', 'hirearchy_migrator', 'r23_gateway') THEN
    RAISE EXCEPTION 'R2.12 candidate role denied' USING ERRCODE = '42501';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$'
     OR p_request_id IS NULL OR p_request_id !~ '^[A-Za-z0-9_-]{1,128}$'
     OR p_assistant_response IS NULL THEN
    RAISE EXCEPTION 'R2.12 invalid input parameters' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('r26.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config('r26.token_hash', p_token_hash, true);

  -- Authenticate candidate bearer against token envelopes
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

  -- Submission finality: no in-flight requests may complete after session is closed
  IF v_session.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'R2.12 candidate session is not active' USING ERRCODE = 'R2605';
  END IF;

  SELECT ai.* INTO v_interaction
  FROM hirearchy.candidate_ai_interactions AS ai
  WHERE ai.session_id = p_session_id
    AND ai.request_id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'R2.12 interaction not found' USING ERRCODE = '22023';
  END IF;

  -- Idempotent completion replay
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

  IF v_interaction.status <> 'ADMITTED' THEN
    RAISE EXCEPTION 'R2.12 interaction cannot be completed in current status' USING ERRCODE = '23514';
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

-- 3. Function: hirearchy.r212_fail_ai_interaction
CREATE OR REPLACE FUNCTION hirearchy.r212_fail_ai_interaction(
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
  IF SESSION_USER NOT IN ('app_candidate_gateway', 'postgres', 'hirearchy_migrator', 'r23_gateway') THEN
    RAISE EXCEPTION 'R2.12 candidate role denied' USING ERRCODE = '42501';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$'
     OR p_request_id IS NULL OR p_request_id !~ '^[A-Za-z0-9_-]{1,128}$'
     OR p_failure_reason IS NULL THEN
    RAISE EXCEPTION 'R2.12 invalid input parameters' USING ERRCODE = '22023';
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

  -- Submission finality: no in-flight requests may fail after session is closed
  IF v_session.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'R2.12 candidate session is not active' USING ERRCODE = 'R2605';
  END IF;

  SELECT ai.* INTO v_interaction
  FROM hirearchy.candidate_ai_interactions AS ai
  WHERE ai.session_id = p_session_id
    AND ai.request_id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'R2.12 interaction not found' USING ERRCODE = '22023';
  END IF;

  IF v_interaction.status = 'FAILED' THEN
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

  IF v_interaction.status <> 'ADMITTED' THEN
    RAISE EXCEPTION 'R2.12 interaction cannot be failed in current status' USING ERRCODE = '23514';
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
      'durationMs', p_duration_ms,
      'failureReason', p_failure_reason,
      'errorMessage', p_error_message
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

-- 4. Function: hirearchy.r212_get_candidate_ai_view
CREATE OR REPLACE FUNCTION hirearchy.r212_get_candidate_ai_view(
  p_token_hash pg_catalog.text,
  p_session_id pg_catalog.text
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session record;
  v_interactions pg_catalog.jsonb;
  v_max_interactions pg_catalog.int4 := 5;
  v_used_interactions pg_catalog.int4 := 0;
  v_enabled boolean := false;
  v_provider_id pg_catalog.text := 'none';
  v_model_id pg_catalog.text := 'none';
BEGIN
  IF SESSION_USER NOT IN ('app_candidate_gateway', 'postgres', 'hirearchy_migrator', 'r23_gateway') THEN
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
    v_provider_id := COALESCE(v_session.ai_capability_snapshot ->> 'configuredProviderId', 'synthetic-test-provider');
    v_model_id := COALESCE(v_session.ai_capability_snapshot ->> 'configuredModelId', 'synthetic-model-r212');
    v_max_interactions := COALESCE((v_session.ai_capability_snapshot ->> 'maxInteractions')::pg_catalog.int4, 5);
  END IF;

  SELECT pg_catalog.count(*) INTO v_used_interactions
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

-- 5. Function: hirearchy.r212_get_evaluator_ai_interactions
CREATE OR REPLACE FUNCTION hirearchy.r212_get_evaluator_ai_interactions(
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
  v_interactions pg_catalog.jsonb;
BEGIN
  IF SESSION_USER NOT IN ('app_evaluator', 'postgres', 'hirearchy_migrator', 'r23_session_owner', 'r23_gateway') THEN
    RAISE EXCEPTION 'R2.12 evaluator role denied' USING ERRCODE = '42501';
  END IF;

  IF p_organization_id IS NULL
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$' THEN
    RAISE EXCEPTION 'R2.12 invalid input parameters' USING ERRCODE = '22023';
  END IF;

  v_principal_id := COALESCE(
    p_reviewer_principal_id,
    NULLIF(pg_catalog.current_setting('r27.principal_id', true), '')::pg_catalog.uuid,
    NULLIF(pg_catalog.current_setting('hirearchy.evaluator_principal_id', true), '')::pg_catalog.uuid
  );

  IF v_principal_id IS NULL THEN
    RAISE EXCEPTION 'R2.12 evaluator principal identity required' USING ERRCODE = '42501';
  END IF;

  -- Reviewer authorization: active reviewer assignment in specified organization
  IF NOT EXISTS (
    SELECT 1
    FROM hirearchy.reviewer_assignments AS assignment
    JOIN hirearchy.organization_memberships AS membership
      ON membership.organization_id = assignment.organization_id
     AND membership.principal_id = assignment.reviewer_principal_id
    WHERE assignment.organization_id = p_organization_id
      AND assignment.session_id = p_session_id
      AND assignment.reviewer_principal_id = v_principal_id
      AND assignment.revoked_at IS NULL
      AND membership.role = 'reviewer'
      AND membership.status = 'active'
      AND membership.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'R2.12 evaluator access denied' USING ERRCODE = '42501';
  END IF;

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
  WHERE ai.organization_id = p_organization_id
    AND ai.session_id = p_session_id;

  RETURN v_interactions;
END
$function$;

-- 6. Schema r212 aliases and wrappers
CREATE SCHEMA IF NOT EXISTS r212;

CREATE OR REPLACE FUNCTION r212.admit_ai_interaction(
  p_token_hash pg_catalog.text,
  p_session_id pg_catalog.text,
  p_request_id pg_catalog.text,
  p_prompt pg_catalog.text
) RETURNS pg_catalog.jsonb
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT hirearchy.r212_admit_ai_interaction(p_token_hash, p_session_id, p_request_id, p_prompt);
$$;

CREATE OR REPLACE FUNCTION r212.complete_ai_interaction(
  p_token_hash pg_catalog.text,
  p_session_id pg_catalog.text,
  p_request_id pg_catalog.text,
  p_assistant_response pg_catalog.text,
  p_duration_ms pg_catalog.int4 DEFAULT NULL
) RETURNS pg_catalog.jsonb
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT hirearchy.r212_complete_ai_interaction(p_token_hash, p_session_id, p_request_id, p_assistant_response, p_duration_ms);
$$;

CREATE OR REPLACE FUNCTION r212.fail_ai_interaction(
  p_token_hash pg_catalog.text,
  p_session_id pg_catalog.text,
  p_request_id pg_catalog.text,
  p_failure_reason pg_catalog.text,
  p_error_message pg_catalog.text,
  p_duration_ms pg_catalog.int4 DEFAULT NULL
) RETURNS pg_catalog.jsonb
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT hirearchy.r212_fail_ai_interaction(p_token_hash, p_session_id, p_request_id, p_failure_reason, p_error_message, p_duration_ms);
$$;

CREATE OR REPLACE FUNCTION r212.get_candidate_ai_view(
  p_token_hash pg_catalog.text,
  p_session_id pg_catalog.text
) RETURNS pg_catalog.jsonb
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT hirearchy.r212_get_candidate_ai_view(p_token_hash, p_session_id);
$$;

CREATE OR REPLACE FUNCTION r212.get_evaluator_ai_interactions(
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text,
  p_reviewer_principal_id pg_catalog.uuid DEFAULT NULL
) RETURNS pg_catalog.jsonb
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT hirearchy.r212_get_evaluator_ai_interactions(p_organization_id, p_session_id, p_reviewer_principal_id);
$$;

-- 7. Permissions and Grants
GRANT USAGE ON SCHEMA hirearchy TO app_evaluator, app_control_worker;
GRANT USAGE ON SCHEMA r212 TO app_candidate_gateway, app_evaluator, app_control_worker;

GRANT EXECUTE ON FUNCTION hirearchy.r212_admit_ai_interaction(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO app_candidate_gateway;
GRANT EXECUTE ON FUNCTION hirearchy.r212_complete_ai_interaction(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) TO app_candidate_gateway;
GRANT EXECUTE ON FUNCTION hirearchy.r212_fail_ai_interaction(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) TO app_candidate_gateway;
GRANT EXECUTE ON FUNCTION hirearchy.r212_get_candidate_ai_view(pg_catalog.text, pg_catalog.text) TO app_candidate_gateway;
GRANT EXECUTE ON FUNCTION hirearchy.r212_get_evaluator_ai_interactions(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) TO app_evaluator;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA r212 TO app_candidate_gateway, app_evaluator;

DO $gateway_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r23_gateway') THEN
    GRANT USAGE ON SCHEMA r212 TO r23_gateway;
    GRANT EXECUTE ON FUNCTION hirearchy.r212_admit_ai_interaction(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO r23_gateway;
    GRANT EXECUTE ON FUNCTION hirearchy.r212_complete_ai_interaction(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) TO r23_gateway;
    GRANT EXECUTE ON FUNCTION hirearchy.r212_fail_ai_interaction(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) TO r23_gateway;
    GRANT EXECUTE ON FUNCTION hirearchy.r212_get_candidate_ai_view(pg_catalog.text, pg_catalog.text) TO r23_gateway;
    GRANT EXECUTE ON FUNCTION hirearchy.r212_get_evaluator_ai_interactions(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) TO r23_gateway;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA r212 TO r23_gateway;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r23_session_owner') THEN
    GRANT USAGE ON SCHEMA r212 TO r23_session_owner;
    GRANT SELECT ON TABLE hirearchy.candidate_ai_interactions TO r23_session_owner;
    EXECUTE 'DROP POLICY IF EXISTS r212_session_owner_ai_interactions_select ON hirearchy.candidate_ai_interactions';
    EXECUTE $policy$
      CREATE POLICY r212_session_owner_ai_interactions_select
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
    GRANT EXECUTE ON FUNCTION hirearchy.r212_admit_ai_interaction(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO r23_session_owner;
    GRANT EXECUTE ON FUNCTION hirearchy.r212_complete_ai_interaction(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) TO r23_session_owner;
    GRANT EXECUTE ON FUNCTION hirearchy.r212_fail_ai_interaction(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) TO r23_session_owner;
    GRANT EXECUTE ON FUNCTION hirearchy.r212_get_candidate_ai_view(pg_catalog.text, pg_catalog.text) TO r23_session_owner;
    GRANT EXECUTE ON FUNCTION hirearchy.r212_get_evaluator_ai_interactions(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) TO r23_session_owner;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA r212 TO r23_session_owner;
  END IF;
END
$gateway_grants$;

COMMIT;
