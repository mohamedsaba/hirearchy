-- Migration 0022: Product, Marketing & Hiring Intelligence Telemetry Layer
-- Captures structured product events, acquisition attribution, and candidate/team micro-feedback
-- without storing candidate code, AI chat content, PII, or credentials in telemetry payloads.

-- 1. Structured Product & Hiring Event Log
CREATE TABLE hirearchy.product_events (
  id pg_catalog.uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  occurred_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  event_name pg_catalog.text NOT NULL
    CHECK (
      char_length(event_name) <= 80
      AND event_name ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$'
    ),
  category pg_catalog.text NOT NULL
    CHECK (
      category IN (
        'acquisition',
        'team_funnel',
        'candidate_funnel',
        'ai_quality',
        'monetization',
        'ux_friction',
        'performance',
        'error'
      )
    ),
  actor_type pg_catalog.text NOT NULL
    CHECK (actor_type IN ('visitor', 'team_member', 'candidate', 'system')),
  anonymous_id pg_catalog.text
    CHECK (anonymous_id IS NULL OR char_length(anonymous_id) <= 80),
  organization_id pg_catalog.uuid
    REFERENCES hirearchy.organizations (id) ON DELETE SET NULL,
  principal_id pg_catalog.uuid
    REFERENCES hirearchy.application_principals (id) ON DELETE SET NULL,
  session_id pg_catalog.text
    REFERENCES hirearchy.assessment_sessions (id) ON DELETE SET NULL,
  route pg_catalog.text NOT NULL DEFAULT ''
    CHECK (char_length(route) <= 200),
  plan_tier pg_catalog.text
    CHECK (
      plan_tier IS NULL
      OR plan_tier IN ('none', 'per_candidate', 'pro', 'ultra')
    ),
  status pg_catalog.text NOT NULL DEFAULT 'ok'
    CHECK (status IN ('ok', 'error', 'abandoned', 'blocked')),
  duration_ms pg_catalog.int4
    CHECK (duration_ms IS NULL OR (duration_ms >= 0 AND duration_ms <= 3600000)),
  properties pg_catalog.jsonb NOT NULL DEFAULT '{}'::pg_catalog.jsonb
    CHECK (pg_catalog.jsonb_typeof(properties) = 'object')
);

CREATE INDEX product_events_occurred_idx
  ON hirearchy.product_events (occurred_at DESC);

CREATE INDEX product_events_name_occurred_idx
  ON hirearchy.product_events (event_name, occurred_at DESC);

CREATE INDEX product_events_category_occurred_idx
  ON hirearchy.product_events (category, occurred_at DESC);

CREATE INDEX product_events_org_occurred_idx
  ON hirearchy.product_events (organization_id, occurred_at DESC)
  WHERE organization_id IS NOT NULL;

CREATE INDEX product_events_session_occurred_idx
  ON hirearchy.product_events (session_id, occurred_at DESC)
  WHERE session_id IS NOT NULL;

CREATE INDEX product_events_anon_occurred_idx
  ON hirearchy.product_events (anonymous_id, occurred_at DESC)
  WHERE anonymous_id IS NOT NULL;

-- 2. First-Touch & Last-Touch Marketing Attribution
CREATE TABLE hirearchy.acquisition_attributions (
  anonymous_id pg_catalog.text PRIMARY KEY
    CHECK (char_length(anonymous_id) BETWEEN 8 AND 80),
  first_utm_source pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(first_utm_source) <= 160),
  first_utm_medium pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(first_utm_medium) <= 160),
  first_utm_campaign pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(first_utm_campaign) <= 160),
  first_utm_term pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(first_utm_term) <= 160),
  first_utm_content pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(first_utm_content) <= 160),
  first_referrer_domain pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(first_referrer_domain) <= 160),
  first_landing_path pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(first_landing_path) <= 200),
  last_utm_source pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(last_utm_source) <= 160),
  last_utm_medium pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(last_utm_medium) <= 160),
  last_utm_campaign pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(last_utm_campaign) <= 160),
  last_referrer_domain pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(last_referrer_domain) <= 160),
  last_landing_path pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(last_landing_path) <= 200),
  actor_type pg_catalog.text NOT NULL DEFAULT 'visitor'
    CHECK (actor_type IN ('visitor', 'team_member', 'candidate')),
  principal_id pg_catalog.uuid
    REFERENCES hirearchy.application_principals (id) ON DELETE SET NULL,
  organization_id pg_catalog.uuid
    REFERENCES hirearchy.organizations (id) ON DELETE SET NULL,
  first_seen_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  last_seen_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  converted_at pg_catalog.timestamptz
);

CREATE INDEX acquisition_attributions_source_idx
  ON hirearchy.acquisition_attributions (first_utm_source, first_seen_at DESC);

CREATE INDEX acquisition_attributions_org_idx
  ON hirearchy.acquisition_attributions (organization_id)
  WHERE organization_id IS NOT NULL;

CREATE INDEX acquisition_attributions_principal_idx
  ON hirearchy.acquisition_attributions (principal_id)
  WHERE principal_id IS NOT NULL;

-- 3. Contextual Candidate & Team Micro-Feedback
CREATE TABLE hirearchy.product_feedback (
  id pg_catalog.uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  actor_type pg_catalog.text NOT NULL
    CHECK (actor_type IN ('team_member', 'candidate')),
  surface pg_catalog.text NOT NULL
    CHECK (surface IN ('candidate_post_submit', 'builder_ai_generated', 'evaluator_review', 'general')),
  organization_id pg_catalog.uuid
    REFERENCES hirearchy.organizations (id) ON DELETE SET NULL,
  principal_id pg_catalog.uuid
    REFERENCES hirearchy.application_principals (id) ON DELETE SET NULL,
  session_id pg_catalog.text
    REFERENCES hirearchy.assessment_sessions (id) ON DELETE SET NULL,
  rating pg_catalog.int2 NOT NULL CHECK (rating BETWEEN 1 AND 5),
  tags pg_catalog.jsonb NOT NULL DEFAULT '[]'::pg_catalog.jsonb
    CHECK (pg_catalog.jsonb_typeof(tags) = 'array'),
  comment pg_catalog.text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 1000),
  context pg_catalog.jsonb NOT NULL DEFAULT '{}'::pg_catalog.jsonb
    CHECK (pg_catalog.jsonb_typeof(context) = 'object')
);

CREATE INDEX product_feedback_surface_created_idx
  ON hirearchy.product_feedback (surface, created_at DESC);

CREATE INDEX product_feedback_actor_created_idx
  ON hirearchy.product_feedback (actor_type, created_at DESC);

CREATE INDEX product_feedback_session_idx
  ON hirearchy.product_feedback (session_id)
  WHERE session_id IS NOT NULL;

-- 4. Strict Row Level Security & Default-Deny Grants
ALTER TABLE hirearchy.product_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.product_events FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.acquisition_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.acquisition_attributions FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.product_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.product_feedback FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  hirearchy.product_events,
  hirearchy.acquisition_attributions,
  hirearchy.product_feedback
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;

DO $revoke_gateway_telemetry$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r23_gateway') THEN
    REVOKE ALL ON TABLE
      hirearchy.product_events,
      hirearchy.acquisition_attributions,
      hirearchy.product_feedback
      FROM r23_gateway;
  END IF;
END
$revoke_gateway_telemetry$;
