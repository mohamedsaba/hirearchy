-- Migration 0018: Hiring Platform Accounts, Plans, Problem Library, Decisions, Handoffs & Candidate Workspace AI

-- 1. Expand allowed template_id values on assessment_drafts
ALTER TABLE hirearchy.assessment_drafts
  DROP CONSTRAINT IF EXISTS assessment_drafts_template_id_check;

ALTER TABLE hirearchy.assessment_drafts
  ADD CONSTRAINT assessment_drafts_template_id_check CHECK (
    template_id IN (
      'custom',
      'reservation-moves-v3',
      'webhook-dedup-v1',
      'cache-rate-limiter-v1',
      'ai-generated'
    )
  );

-- 2. Expand allowed roles on organization_invitations (cto, recruiter, reviewer)
ALTER TABLE hirearchy.organization_invitations
  DROP CONSTRAINT IF EXISTS organization_invitations_role_check;

ALTER TABLE hirearchy.organization_invitations
  ADD CONSTRAINT organization_invitations_role_check CHECK (
    role IN ('cto', 'recruiter', 'reviewer')
  );

-- 3. Candidate Profiles (verified candidate account identity & hiring profile)
CREATE TABLE hirearchy.candidate_profiles (
  principal_id pg_catalog.uuid PRIMARY KEY
    REFERENCES hirearchy.application_principals (id) ON DELETE RESTRICT,
  candidate_code pg_catalog.text NOT NULL UNIQUE
    CHECK (candidate_code ~ '^HRC-[A-Z0-9]{6,12}$'),
  email pg_catalog.text NOT NULL
    CHECK (
      char_length(email) <= 320
      AND email = lower(trim(email))
      AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    ),
  full_name pg_catalog.text NOT NULL CHECK (char_length(trim(full_name)) BETWEEN 1 AND 120),
  phone pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(phone) <= 40),
  birth_year pg_catalog.int4 CHECK (
    birth_year IS NULL OR (birth_year >= 1940 AND birth_year <= 2012)
  ),
  location_country pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(location_country) <= 100),
  location_city pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(location_city) <= 100),
  work_mode pg_catalog.text NOT NULL DEFAULT 'remote'
    CHECK (work_mode IN ('remote', 'hybrid', 'onsite', 'any')),
  headline_role pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(headline_role) <= 120),
  years_experience pg_catalog.int4 NOT NULL DEFAULT 0 CHECK (years_experience >= 0 AND years_experience <= 50),
  experience_level pg_catalog.text NOT NULL DEFAULT 'mid'
    CHECK (experience_level IN ('junior', 'mid', 'senior', 'staff')),
  skills pg_catalog.jsonb NOT NULL DEFAULT '[]'::pg_catalog.jsonb
    CHECK (pg_catalog.jsonb_typeof(skills) = 'array'),
  id_document_type pg_catalog.text CHECK (
    id_document_type IS NULL
    OR id_document_type IN ('national_id', 'passport', 'drivers_license')
  ),
  id_document_masked pg_catalog.text CHECK (
    id_document_masked IS NULL OR char_length(id_document_masked) <= 64
  ),
  id_verification_status pg_catalog.text NOT NULL DEFAULT 'unsubmitted'
    CHECK (id_verification_status IN ('unsubmitted', 'submitted', 'verified')),
  linkedin_url pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(linkedin_url) <= 300),
  github_url pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(github_url) <= 300),
  portfolio_url pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(portfolio_url) <= 300),
  bio pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 2000),
  profile_completed_at pg_catalog.timestamptz,
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE INDEX candidate_profiles_email_idx
  ON hirearchy.candidate_profiles (lower(email));

-- 4. Organization Plans & Per-Candidate Credits (no free plan; default 'none')
CREATE TABLE hirearchy.organization_plans (
  organization_id pg_catalog.uuid PRIMARY KEY
    REFERENCES hirearchy.organizations (id) ON DELETE RESTRICT,
  plan_tier pg_catalog.text NOT NULL DEFAULT 'none'
    CHECK (plan_tier IN ('none', 'per_candidate', 'pro', 'ultra')),
  candidate_credits_purchased pg_catalog.int4 NOT NULL DEFAULT 0
    CHECK (candidate_credits_purchased >= 0),
  updated_by_principal_id pg_catalog.uuid
    REFERENCES hirearchy.application_principals (id) ON DELETE RESTRICT,
  updated_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE hirearchy.organization_candidate_credits (
  organization_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.organizations (id) ON DELETE RESTRICT,
  candidate_email pg_catalog.text NOT NULL
    CHECK (
      char_length(candidate_email) <= 320
      AND candidate_email = lower(trim(candidate_email))
    ),
  first_session_id pg_catalog.text NOT NULL
    REFERENCES hirearchy.assessment_sessions (id) ON DELETE RESTRICT,
  consumed_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (organization_id, candidate_email)
);

-- 5. Reusable Saved Problem Library
CREATE TABLE hirearchy.assessment_library_entries (
  definition_id pg_catalog.uuid PRIMARY KEY
    REFERENCES hirearchy.assessment_definitions (id) ON DELETE RESTRICT,
  organization_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.organizations (id) ON DELETE RESTRICT,
  author_principal_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.application_principals (id) ON DELETE RESTRICT,
  validated_version_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.assessment_validated_versions (id) ON DELETE RESTRICT,
  source_kind pg_catalog.text NOT NULL CHECK (source_kind IN ('template', 'ai_generated')),
  template_id pg_catalog.text,
  target_role pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(target_role) <= 120),
  experience_level pg_catalog.text NOT NULL DEFAULT 'mid'
    CHECK (experience_level IN ('junior', 'mid', 'senior', 'staff')),
  years_experience pg_catalog.int4 NOT NULL DEFAULT 3 CHECK (years_experience >= 0 AND years_experience <= 50),
  skills pg_catalog.jsonb NOT NULL DEFAULT '[]'::pg_catalog.jsonb
    CHECK (pg_catalog.jsonb_typeof(skills) = 'array'),
  problem_structure pg_catalog.text NOT NULL DEFAULT 'multi_file'
    CHECK (problem_structure IN ('multi_file', 'single_module')),
  work_kind pg_catalog.text NOT NULL DEFAULT 'incident' CHECK (char_length(work_kind) <= 64),
  domain pg_catalog.text NOT NULL DEFAULT 'developer-tools' CHECK (char_length(domain) <= 64),
  generation_brief pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(generation_brief) <= 2000),
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE INDEX assessment_library_org_idx
  ON hirearchy.assessment_library_entries (organization_id, updated_at DESC);

-- 6. Session Hiring Metadata (binds issued session to candidate email, role, skills, definition)
CREATE TABLE hirearchy.hiring_session_metadata (
  session_id pg_catalog.text PRIMARY KEY
    REFERENCES hirearchy.assessment_sessions (id) ON DELETE RESTRICT,
  organization_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.organizations (id) ON DELETE RESTRICT,
  candidate_email pg_catalog.text NOT NULL
    CHECK (
      char_length(candidate_email) <= 320
      AND candidate_email = lower(trim(candidate_email))
      AND candidate_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    ),
  candidate_principal_id pg_catalog.uuid
    REFERENCES hirearchy.application_principals (id) ON DELETE RESTRICT,
  definition_id pg_catalog.uuid
    REFERENCES hirearchy.assessment_definitions (id) ON DELETE RESTRICT,
  target_role pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(target_role) <= 120),
  experience_level pg_catalog.text NOT NULL DEFAULT 'mid'
    CHECK (experience_level IN ('junior', 'mid', 'senior', 'staff')),
  skills pg_catalog.jsonb NOT NULL DEFAULT '[]'::pg_catalog.jsonb
    CHECK (pg_catalog.jsonb_typeof(skills) = 'array'),
  invitation_note pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(invitation_note) <= 1000),
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE INDEX hiring_session_metadata_org_email_idx
  ON hirearchy.hiring_session_metadata (organization_id, candidate_email);

CREATE INDEX hiring_session_metadata_email_idx
  ON hirearchy.hiring_session_metadata (candidate_email);

-- 7. Published Hiring Decisions, Candidate Feedback & Managerial Handoff Dossiers
CREATE TABLE hirearchy.hiring_decisions (
  session_id pg_catalog.text PRIMARY KEY
    REFERENCES hirearchy.assessment_sessions (id) ON DELETE RESTRICT,
  organization_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.organizations (id) ON DELETE RESTRICT,
  decided_by_principal_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.application_principals (id) ON DELETE RESTRICT,
  decision pg_catalog.text NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  candidate_strengths pg_catalog.jsonb NOT NULL DEFAULT '[]'::pg_catalog.jsonb
    CHECK (pg_catalog.jsonb_typeof(candidate_strengths) = 'array'),
  candidate_weaknesses pg_catalog.jsonb NOT NULL DEFAULT '[]'::pg_catalog.jsonb
    CHECK (pg_catalog.jsonb_typeof(candidate_weaknesses) = 'array'),
  candidate_feedback_note pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(candidate_feedback_note) <= 5000),
  internal_notes pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(internal_notes) <= 10000),
  next_stage_label pg_catalog.text CHECK (next_stage_label IS NULL OR char_length(next_stage_label) <= 120),
  handoff_recipient_principal_id pg_catalog.uuid
    REFERENCES hirearchy.application_principals (id) ON DELETE RESTRICT,
  handoff_status pg_catalog.text NOT NULL DEFAULT 'none'
    CHECK (handoff_status IN ('none', 'pending', 'reviewed', 'completed')),
  performance_report pg_catalog.jsonb,
  published_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE INDEX hiring_decisions_org_idx
  ON hirearchy.hiring_decisions (organization_id, published_at DESC);

-- 8. Second-Opinion Peer Reviews
CREATE TABLE hirearchy.hiring_second_opinions (
  id pg_catalog.uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.organizations (id) ON DELETE RESTRICT,
  session_id pg_catalog.text NOT NULL
    REFERENCES hirearchy.assessment_sessions (id) ON DELETE RESTRICT,
  requested_by_principal_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.application_principals (id) ON DELETE RESTRICT,
  requested_reviewer_principal_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.application_principals (id) ON DELETE RESTRICT,
  request_note pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(request_note) <= 2000),
  response_note pg_catalog.text CHECK (response_note IS NULL OR char_length(response_note) <= 5000),
  status pg_catalog.text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  responded_at pg_catalog.timestamptz
);

CREATE INDEX hiring_second_opinions_session_idx
  ON hirearchy.hiring_second_opinions (organization_id, session_id, created_at DESC);

-- 9. Strict Row Level Security & Default-Deny Grants on All New Tables
ALTER TABLE hirearchy.candidate_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.candidate_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.organization_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.organization_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.organization_candidate_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.organization_candidate_credits FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.assessment_library_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.assessment_library_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.hiring_session_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.hiring_session_metadata FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.hiring_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.hiring_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.hiring_second_opinions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.hiring_second_opinions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  hirearchy.candidate_profiles,
  hirearchy.organization_plans,
  hirearchy.organization_candidate_credits,
  hirearchy.assessment_library_entries,
  hirearchy.hiring_session_metadata,
  hirearchy.hiring_decisions,
  hirearchy.hiring_second_opinions
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;

-- 10. Durable Candidate AI Functions (SECURITY DEFINER owned by hirearchy_migrator for app_candidate_gateway)
CREATE OR REPLACE FUNCTION hirearchy.hiring_r212_get_view(
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

CREATE OR REPLACE FUNCTION hirearchy.hiring_r212_admit(
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

CREATE OR REPLACE FUNCTION hirearchy.hiring_r212_complete(
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

CREATE OR REPLACE FUNCTION hirearchy.hiring_r212_fail(
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

ALTER FUNCTION hirearchy.hiring_r212_get_view(pg_catalog.text, pg_catalog.text) OWNER TO hirearchy_migrator;
ALTER FUNCTION hirearchy.hiring_r212_admit(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) OWNER TO hirearchy_migrator;
ALTER FUNCTION hirearchy.hiring_r212_complete(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) OWNER TO hirearchy_migrator;
ALTER FUNCTION hirearchy.hiring_r212_fail(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) OWNER TO hirearchy_migrator;

REVOKE ALL ON FUNCTION hirearchy.hiring_r212_get_view(pg_catalog.text, pg_catalog.text) FROM PUBLIC, app_evaluator, app_control_worker;
REVOKE ALL ON FUNCTION hirearchy.hiring_r212_admit(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM PUBLIC, app_evaluator, app_control_worker;
REVOKE ALL ON FUNCTION hirearchy.hiring_r212_complete(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) FROM PUBLIC, app_evaluator, app_control_worker;
REVOKE ALL ON FUNCTION hirearchy.hiring_r212_fail(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) FROM PUBLIC, app_evaluator, app_control_worker;

GRANT EXECUTE ON FUNCTION hirearchy.hiring_r212_get_view(pg_catalog.text, pg_catalog.text) TO app_candidate_gateway;
GRANT EXECUTE ON FUNCTION hirearchy.hiring_r212_admit(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO app_candidate_gateway;
GRANT EXECUTE ON FUNCTION hirearchy.hiring_r212_complete(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) TO app_candidate_gateway;
GRANT EXECUTE ON FUNCTION hirearchy.hiring_r212_fail(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) TO app_candidate_gateway;

DO $revoke_gateway_hiring$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r23_gateway') THEN
    REVOKE ALL ON TABLE
      hirearchy.candidate_profiles,
      hirearchy.organization_plans,
      hirearchy.organization_candidate_credits,
      hirearchy.assessment_library_entries,
      hirearchy.hiring_session_metadata,
      hirearchy.hiring_decisions,
      hirearchy.hiring_second_opinions
      FROM r23_gateway;
    REVOKE ALL ON FUNCTION hirearchy.hiring_r212_get_view(pg_catalog.text, pg_catalog.text) FROM r23_gateway;
    REVOKE ALL ON FUNCTION hirearchy.hiring_r212_admit(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM r23_gateway;
    REVOKE ALL ON FUNCTION hirearchy.hiring_r212_complete(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) FROM r23_gateway;
    REVOKE ALL ON FUNCTION hirearchy.hiring_r212_fail(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) FROM r23_gateway;
  END IF;
END
$revoke_gateway_hiring$;
