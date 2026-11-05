-- The verifier API is installed separately by a database administrator after
-- the verifier role and plpython3u bootstrap. Access is installed atomically with the administrator-only dispatcher.

ALTER TABLE hirearchy.assessment_validated_versions
  ADD CONSTRAINT assessment_validated_versions_staging_link_unique
    UNIQUE (id, definition_id, organization_id);

ALTER TABLE hirearchy.assessment_drafts
  ADD COLUMN staging_content pg_catalog.jsonb
    CHECK (staging_content IS NULL OR pg_catalog.jsonb_typeof(staging_content) = 'object');

ALTER TABLE hirearchy.assessment_issuances
  ADD COLUMN assessment_id pg_catalog.uuid,
  ADD COLUMN validated_version_id pg_catalog.uuid,
  ADD CONSTRAINT assessment_issuances_staging_assessment_fk
    FOREIGN KEY (assessment_id) REFERENCES hirearchy.assessment_definitions(id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT assessment_issuances_staging_version_fk
    FOREIGN KEY (validated_version_id, assessment_id, organization_id)
    REFERENCES hirearchy.assessment_validated_versions(id, definition_id, organization_id)
    ON DELETE RESTRICT;

DROP TRIGGER assessment_issuances_immutable_keys ON hirearchy.assessment_issuances;
CREATE TRIGGER assessment_issuances_immutable_keys
  BEFORE UPDATE OF organization_id, idempotency_key, session_id, issuer_principal_id,
                   request_hash, payload_hash, assessment_id, validated_version_id, created_at
  ON hirearchy.assessment_issuances
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_immutable_columns(
    'organization_id', 'idempotency_key', 'session_id', 'issuer_principal_id',
    'request_hash', 'payload_hash', 'assessment_id', 'validated_version_id', 'created_at'
  );

CREATE INDEX assessment_issuances_org_assessment_idx
  ON hirearchy.assessment_issuances (organization_id, assessment_id, created_at DESC)
  WHERE assessment_id IS NOT NULL;
CREATE INDEX staging_proof_nonces_expires_at_idx
  ON hirearchy.staging_proof_nonces (expires_at);

ALTER TABLE hirearchy.staging_verification_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.staging_verification_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.staging_proof_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.staging_proof_nonces FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.staging_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.staging_sessions FORCE ROW LEVEL SECURITY;
