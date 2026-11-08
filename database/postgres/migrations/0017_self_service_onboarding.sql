-- Wave 2 Priority 6: Self-Service Onboarding and Reviewer Invitations
-- Schema additions: organization ownership & display name, reviewer invitations, and onboarding receipts.

ALTER TABLE hirearchy.organizations
  ADD COLUMN owner_principal_id pg_catalog.uuid,
  ADD COLUMN display_name pg_catalog.text,
  ADD CONSTRAINT organizations_owner_principal_fk
    FOREIGN KEY (owner_principal_id)
    REFERENCES hirearchy.application_principals (id) ON DELETE RESTRICT,
  ADD CONSTRAINT organizations_display_name_check CHECK (
    display_name IS NULL OR (
      char_length(trim(display_name)) >= 1
      AND char_length(display_name) <= 120
      AND display_name !~ '[\u0000-\u001F\u007F-\u009F]'
    )
  );

CREATE OR REPLACE FUNCTION hirearchy.reject_owner_principal_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, hirearchy, pg_temp
AS $function$
BEGIN
  IF OLD.owner_principal_id IS NOT NULL
     AND NEW.owner_principal_id IS DISTINCT FROM OLD.owner_principal_id THEN
    RAISE EXCEPTION 'Immutable organization owner principal changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER organizations_owner_principal_immutable
  BEFORE UPDATE OF owner_principal_id ON hirearchy.organizations
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_owner_principal_mutation();

ALTER TABLE hirearchy.application_principals
  ADD COLUMN display_name pg_catalog.text,
  ADD CONSTRAINT application_principals_display_name_check CHECK (
    display_name IS NULL OR (
      char_length(trim(display_name)) >= 1
      AND char_length(display_name) <= 120
      AND display_name !~ '[\u0000-\u001F\u007F-\u009F]'
    )
  );

CREATE TABLE hirearchy.organization_invitations (
  id pg_catalog.uuid PRIMARY KEY,
  organization_id pg_catalog.uuid NOT NULL,
  inviter_principal_id pg_catalog.uuid NOT NULL,
  target_email pg_catalog.text NOT NULL
    CHECK (
      char_length(target_email) <= 255
      AND target_email = lower(trim(target_email))
      AND target_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    ),
  role pg_catalog.text NOT NULL CHECK (role = 'reviewer'),
  token_hash pg_catalog.text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_ciphertext pg_catalog.text NOT NULL,
  expires_at pg_catalog.timestamptz NOT NULL,
  revoked_at pg_catalog.timestamptz,
  accepted_at pg_catalog.timestamptz,
  accepted_by_principal_id pg_catalog.uuid,
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY (organization_id)
    REFERENCES hirearchy.organizations (id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, inviter_principal_id)
    REFERENCES hirearchy.organization_memberships (organization_id, principal_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (accepted_by_principal_id)
    REFERENCES hirearchy.application_principals (id) ON DELETE RESTRICT,
  CONSTRAINT organization_invitations_lifecycle_check CHECK (
    expires_at > created_at
    AND expires_at <= created_at + INTERVAL '30 days'
    AND (revoked_at IS NULL OR revoked_at >= created_at)
    AND (accepted_at IS NULL OR accepted_at >= created_at)
  )
);

CREATE INDEX organization_invitations_org_idx
  ON hirearchy.organization_invitations (organization_id, created_at);

CREATE INDEX organization_invitations_email_idx
  ON hirearchy.organization_invitations (organization_id, target_email);

CREATE TABLE hirearchy.onboarding_request_receipts (
  subject_id pg_catalog.uuid NOT NULL,
  operation pg_catalog.text NOT NULL,
  idempotency_key pg_catalog.text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9._~-]{1,128}$'),
  request_digest pg_catalog.text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  response_payload pg_catalog.jsonb NOT NULL,
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (subject_id, operation, idempotency_key)
);

CREATE TABLE hirearchy.durable_onboarding_installation (
  marker_key pg_catalog.text PRIMARY KEY
    CHECK (marker_key = 'durable-onboarding-v1'),
  marker_version pg_catalog.int4 NOT NULL CHECK (marker_version = 1),
  migration_version pg_catalog.text NOT NULL CHECK (migration_version = '0017'),
  migration_checksum pg_catalog.text NOT NULL CHECK (migration_checksum ~ '^[0-9a-f]{64}$'),
  installed_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  installed_by pg_catalog.name NOT NULL DEFAULT current_user
);

REVOKE ALL ON hirearchy.organization_invitations FROM PUBLIC;
REVOKE ALL ON hirearchy.onboarding_request_receipts FROM PUBLIC;
REVOKE ALL ON hirearchy.durable_onboarding_installation FROM PUBLIC;
REVOKE ALL ON FUNCTION hirearchy.reject_owner_principal_mutation() FROM PUBLIC;

ALTER TABLE hirearchy.organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.organization_invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.onboarding_request_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.onboarding_request_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.durable_onboarding_installation ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.durable_onboarding_installation FORCE ROW LEVEL SECURITY;

REVOKE ALL ON hirearchy.organization_invitations
  FROM app_evaluator, app_candidate_gateway, app_control_worker;
REVOKE ALL ON hirearchy.onboarding_request_receipts
  FROM app_evaluator, app_candidate_gateway, app_control_worker;
REVOKE ALL ON hirearchy.durable_onboarding_installation
  FROM app_evaluator, app_candidate_gateway, app_control_worker;
