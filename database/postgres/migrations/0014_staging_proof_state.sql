-- Durable state only. No callable API, application grant, or key is installed.
CREATE TABLE hirearchy.staging_verification_keys (
  key_id text PRIMARY KEY CHECK (length(key_id) BETWEEN 1 AND 128),
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 256),
  audience text NOT NULL CHECK (length(audience) BETWEEN 1 AND 256),
  public_key bytea NOT NULL CHECK (octet_length(public_key) = 32),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (valid_until > valid_from)
);
CREATE TABLE hirearchy.staging_proof_nonces (
  key_id text NOT NULL REFERENCES hirearchy.staging_verification_keys(key_id),
  nonce uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (key_id, nonce)
);
CREATE TABLE hirearchy.staging_sessions (
  auth_session_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES hirearchy.organizations(id) ON DELETE RESTRICT,
  principal_id uuid NOT NULL REFERENCES hirearchy.application_principals(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (auth_session_id, organization_id)
);
CREATE TRIGGER staging_sessions_identity_immutable
  BEFORE UPDATE OF auth_session_id, subject_id, organization_id, principal_id
  ON hirearchy.staging_sessions
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_immutable_columns(
    'auth_session_id', 'subject_id', 'organization_id', 'principal_id'
  );
REVOKE ALL ON hirearchy.staging_verification_keys, hirearchy.staging_proof_nonces,
  hirearchy.staging_sessions FROM PUBLIC, app_evaluator, app_candidate_gateway,
  app_control_worker;
