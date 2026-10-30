CREATE TABLE hirearchy.assessment_definitions (
  id pg_catalog.uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id pg_catalog.uuid NOT NULL,
  author_principal_id pg_catalog.uuid NOT NULL,
  title pg_catalog.text NOT NULL,
  draft_version pg_catalog.int8 NOT NULL DEFAULT 1 CHECK (draft_version >= 1),
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY (organization_id)
    REFERENCES hirearchy.organizations (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, author_principal_id)
    REFERENCES hirearchy.organization_memberships (organization_id, principal_id)
    ON DELETE RESTRICT
);

CREATE TABLE hirearchy.assessment_drafts (
  definition_id pg_catalog.uuid NOT NULL,
  organization_id pg_catalog.uuid NOT NULL,
  author_principal_id pg_catalog.uuid NOT NULL,
  version pg_catalog.int8 NOT NULL CHECK (version >= 1),
  title pg_catalog.text NOT NULL,
  brief pg_catalog.text NOT NULL,
  expected_behavior pg_catalog.jsonb NOT NULL,
  acceptance_criteria pg_catalog.jsonb NOT NULL,
  primary_file_path pg_catalog.text NOT NULL,
  starter_files pg_catalog.jsonb NOT NULL,
  duration_minutes pg_catalog.int4 NOT NULL CHECK (duration_minutes IN (30, 45, 60, 90)),
  terminal_enabled pg_catalog.bool NOT NULL DEFAULT true,
  integrated_ai pg_catalog.bool NOT NULL DEFAULT false,
  rubric pg_catalog.jsonb NOT NULL,
  updated_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (definition_id, version),
  FOREIGN KEY (organization_id)
    REFERENCES hirearchy.organizations (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, author_principal_id)
    REFERENCES hirearchy.organization_memberships (organization_id, principal_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (definition_id)
    REFERENCES hirearchy.assessment_definitions (id)
    ON DELETE RESTRICT
);

CREATE TABLE hirearchy.assessment_validated_versions (
  id pg_catalog.uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.assessment_definitions (id)
    ON DELETE RESTRICT,
  organization_id pg_catalog.uuid NOT NULL,
  author_principal_id pg_catalog.uuid NOT NULL,
  version_number pg_catalog.int4 NOT NULL CHECK (version_number >= 1),
  content_digest pg_catalog.text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  scenario_id pg_catalog.text NOT NULL,
  scenario_version pg_catalog.text NOT NULL,
  scenario_title pg_catalog.text NOT NULL,
  scenario_snapshot pg_catalog.text NOT NULL,
  task_rubric_snapshot pg_catalog.jsonb NOT NULL,
  duration_seconds pg_catalog.int4 NOT NULL CHECK (duration_seconds IN (1800, 2700, 3600, 5400)),
  terminal_enabled pg_catalog.bool NOT NULL DEFAULT true,
  integrated_ai pg_catalog.bool NOT NULL DEFAULT false,
  validation_receipt pg_catalog.jsonb NOT NULL,
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (definition_id, version_number),
  FOREIGN KEY (organization_id)
    REFERENCES hirearchy.organizations (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, author_principal_id)
    REFERENCES hirearchy.organization_memberships (organization_id, principal_id)
    ON DELETE RESTRICT
);

CREATE INDEX assessment_definitions_organization_id_idx
  ON hirearchy.assessment_definitions (organization_id, updated_at DESC);

CREATE INDEX assessment_drafts_org_def_idx
  ON hirearchy.assessment_drafts (organization_id, definition_id, version DESC);

CREATE INDEX assessment_validated_versions_org_def_idx
  ON hirearchy.assessment_validated_versions (organization_id, definition_id, version_number DESC);

CREATE INDEX assessment_validated_versions_content_digest_idx
  ON hirearchy.assessment_validated_versions (content_digest);

CREATE TRIGGER assessment_definitions_immutable_columns
  BEFORE UPDATE OF id, organization_id, author_principal_id, created_at
  ON hirearchy.assessment_definitions
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_immutable_columns(
    'id', 'organization_id', 'author_principal_id', 'created_at'
  );

CREATE TRIGGER assessment_drafts_immutable_columns
  BEFORE UPDATE OF definition_id, organization_id, author_principal_id, version
  ON hirearchy.assessment_drafts
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_immutable_columns(
    'definition_id', 'organization_id', 'author_principal_id', 'version'
  );

CREATE FUNCTION hirearchy.r211_reject_validated_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Validated assessment version is immutable' USING ERRCODE = '23514';
END
$function$;

CREATE TRIGGER assessment_validated_versions_immutable
  BEFORE UPDATE OR DELETE ON hirearchy.assessment_validated_versions
  FOR EACH ROW EXECUTE FUNCTION hirearchy.r211_reject_validated_version_mutation();

ALTER TABLE hirearchy.assessment_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.assessment_definitions FORCE ROW LEVEL SECURITY;

ALTER TABLE hirearchy.assessment_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.assessment_drafts FORCE ROW LEVEL SECURITY;

ALTER TABLE hirearchy.assessment_validated_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.assessment_validated_versions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE hirearchy.assessment_definitions
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;

REVOKE ALL ON TABLE hirearchy.assessment_drafts
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;

REVOKE ALL ON TABLE hirearchy.assessment_validated_versions
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;

REVOKE ALL ON FUNCTION hirearchy.r211_reject_validated_version_mutation()
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;

DO $revoke_gateway$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r23_gateway') THEN
    REVOKE ALL ON TABLE hirearchy.assessment_definitions FROM r23_gateway;
    REVOKE ALL ON TABLE hirearchy.assessment_drafts FROM r23_gateway;
    REVOKE ALL ON TABLE hirearchy.assessment_validated_versions FROM r23_gateway;
    REVOKE ALL ON FUNCTION hirearchy.r211_reject_validated_version_mutation() FROM r23_gateway;
  END IF;
END
$revoke_gateway$;
