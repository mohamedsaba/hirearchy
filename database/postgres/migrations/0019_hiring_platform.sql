-- Migration 0019: Hiring Platform Accounts, Plans, Problem Library, Decisions, Handoffs & Candidate Workspace AI

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
  END IF;
END
$revoke_gateway_hiring$;
