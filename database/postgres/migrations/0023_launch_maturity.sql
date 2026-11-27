-- Migration 0023: Launch Maturity (Shareable Dossiers, Outbound Webhooks & Org Nudges)
-- Defines tenant-scoped tables, strict CHECK constraints, indexes, and default-deny RLS.
-- Runtime RPCs live exclusively in database/postgres/staging/install-api.sql (staging schema).

-- 1. Shareable Executive Verdict & Evidence Dossier Links
CREATE TABLE hirearchy.dossier_share_links (
  id pg_catalog.uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.organizations (id) ON DELETE RESTRICT,
  session_id pg_catalog.text NOT NULL
    REFERENCES hirearchy.hiring_decisions (session_id) ON DELETE RESTRICT,
  created_by_principal_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.application_principals (id) ON DELETE RESTRICT,
  token_hash pg_catalog.text NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  visibility_mode pg_catalog.text NOT NULL DEFAULT 'redacted'
    CHECK (visibility_mode IN ('redacted', 'named')),
  include_ai_advisory pg_catalog.bool NOT NULL DEFAULT true,
  include_verification_questions pg_catalog.bool NOT NULL DEFAULT true,
  expires_at pg_catalog.timestamptz NOT NULL,
  revoked_at pg_catalog.timestamptz,
  view_count pg_catalog.int4 NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  last_viewed_at pg_catalog.timestamptz,
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT dossier_share_links_lifecycle_check CHECK (
    expires_at > created_at
    AND expires_at <= created_at + INTERVAL '90 days'
    AND (revoked_at IS NULL OR revoked_at >= created_at)
  )
);

CREATE INDEX dossier_share_links_org_session_idx
  ON hirearchy.dossier_share_links (organization_id, session_id, created_at DESC);

-- 2. Outbound Organization Webhooks & Slack Incoming Webhooks
CREATE TABLE hirearchy.organization_webhooks (
  id pg_catalog.uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.organizations (id) ON DELETE RESTRICT,
  created_by_principal_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.application_principals (id) ON DELETE RESTRICT,
  label pg_catalog.text NOT NULL
    CHECK (char_length(trim(label)) BETWEEN 1 AND 80),
  target_url pg_catalog.text NOT NULL
    CHECK (char_length(target_url) BETWEEN 12 AND 500 AND target_url ~ '^https?://'),
  payload_mode pg_catalog.text NOT NULL DEFAULT 'json'
    CHECK (payload_mode IN ('json', 'slack_block_kit')),
  event_types pg_catalog.jsonb NOT NULL DEFAULT '["candidate.started","candidate.submitted","verdict.published","handoff.updated"]'::pg_catalog.jsonb
    CHECK (pg_catalog.jsonb_typeof(event_types) = 'array'),
  signing_secret_ciphertext pg_catalog.text NOT NULL
    CHECK (char_length(signing_secret_ciphertext) >= 16),
  signing_secret_prefix pg_catalog.text NOT NULL
    CHECK (char_length(signing_secret_prefix) BETWEEN 4 AND 16),
  is_active pg_catalog.bool NOT NULL DEFAULT true,
  consecutive_failures pg_catalog.int4 NOT NULL DEFAULT 0
    CHECK (consecutive_failures >= 0),
  disabled_reason pg_catalog.text NOT NULL DEFAULT ''
    CHECK (char_length(disabled_reason) <= 400),
  last_delivered_at pg_catalog.timestamptz,
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE INDEX organization_webhooks_org_created_idx
  ON hirearchy.organization_webhooks (organization_id, created_at DESC);

-- 3. Outbound Webhook Delivery Ledger & Retry Queue
CREATE TABLE hirearchy.webhook_deliveries (
  id pg_catalog.uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  webhook_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.organization_webhooks (id) ON DELETE CASCADE,
  organization_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.organizations (id) ON DELETE RESTRICT,
  event_id pg_catalog.uuid NOT NULL,
  event_type pg_catalog.text NOT NULL
    CHECK (
      event_type IN (
        'webhook.ping',
        'candidate.started',
        'candidate.submitted',
        'verdict.published',
        'handoff.updated'
      )
    ),
  session_id pg_catalog.text
    REFERENCES hirearchy.assessment_sessions (id) ON DELETE SET NULL,
  status pg_catalog.text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed', 'blocked_ssrf')),
  attempt_count pg_catalog.int2 NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  http_status pg_catalog.int4,
  latency_ms pg_catalog.int4 CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_summary pg_catalog.text NOT NULL DEFAULT ''
    CHECK (char_length(error_summary) <= 400),
  request_payload pg_catalog.jsonb NOT NULL DEFAULT '{}'::pg_catalog.jsonb
    CHECK (pg_catalog.jsonb_typeof(request_payload) = 'object'),
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  delivered_at pg_catalog.timestamptz
);

CREATE INDEX webhook_deliveries_webhook_created_idx
  ON hirearchy.webhook_deliveries (webhook_id, created_at DESC);

CREATE INDEX webhook_deliveries_org_created_idx
  ON hirearchy.webhook_deliveries (organization_id, created_at DESC);

CREATE INDEX webhook_deliveries_pending_next_idx
  ON hirearchy.webhook_deliveries (next_attempt_at)
  WHERE status = 'pending';

-- 4. Organization Lifecycle Nudges & Operator Outreach State
CREATE TABLE hirearchy.organization_nudges (
  id pg_catalog.uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.organizations (id) ON DELETE RESTRICT,
  nudge_key pg_catalog.text NOT NULL
    CHECK (
      nudge_key IN (
        'no_assessment_48h',
        'unreviewed_submission_48h',
        'plan_gate_no_upgrade',
        'problem_health_alert',
        'connect_slack_webhook'
      )
    ),
  target_ref pg_catalog.text NOT NULL DEFAULT ''
    CHECK (char_length(target_ref) <= 200),
  status pg_catalog.text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'dismissed', 'snoozed', 'resolved', 'contacted')),
  snoozed_until pg_catalog.timestamptz,
  founder_note pg_catalog.text NOT NULL DEFAULT ''
    CHECK (char_length(founder_note) <= 1000),
  contacted_at pg_catalog.timestamptz,
  updated_by_principal_id pg_catalog.uuid
    REFERENCES hirearchy.application_principals (id) ON DELETE SET NULL,
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (organization_id, nudge_key, target_ref)
);

CREATE INDEX organization_nudges_org_status_idx
  ON hirearchy.organization_nudges (organization_id, status, updated_at DESC);

-- 5. Strict Row Level Security & Default-Deny Grants
ALTER TABLE hirearchy.dossier_share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.dossier_share_links FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.organization_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.organization_webhooks FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.webhook_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.organization_nudges ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.organization_nudges FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  hirearchy.dossier_share_links,
  hirearchy.organization_webhooks,
  hirearchy.webhook_deliveries,
  hirearchy.organization_nudges
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;

DO $revoke_gateway_launch_maturity$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r23_gateway') THEN
    REVOKE ALL ON TABLE
      hirearchy.dossier_share_links,
      hirearchy.organization_webhooks,
      hirearchy.webhook_deliveries,
      hirearchy.organization_nudges
      FROM r23_gateway;
  END IF;
END
$revoke_gateway_launch_maturity$;
