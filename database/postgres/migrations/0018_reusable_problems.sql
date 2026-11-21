CREATE TABLE hirearchy.reusable_problems (
  id pg_catalog.uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id pg_catalog.uuid NOT NULL,
  author_principal_id pg_catalog.uuid NOT NULL,
  version pg_catalog.int8 NOT NULL DEFAULT 1 CHECK (version >= 1),
  content pg_catalog.jsonb NOT NULL CHECK ((
    pg_catalog.jsonb_typeof(content) = 'object'
    AND NOT (content ?| ARRAY['definitionId', 'expectedVersion'])
    AND content->>'templateId' IN ('custom', 'reservation-moves-v3')
    AND pg_catalog.jsonb_typeof(content->'title') = 'string'
    AND pg_catalog.jsonb_typeof(content->'brief') = 'string'
    AND pg_catalog.jsonb_typeof(content->'expectedBehavior') = 'array'
    AND pg_catalog.jsonb_typeof(content->'acceptanceCriteria') = 'array'
    AND pg_catalog.jsonb_typeof(content->'primaryFilePath') = 'string'
    AND pg_catalog.jsonb_typeof(content->'starterFiles') = 'array'
    AND content->'durationMinutes' IN ('30'::pg_catalog.jsonb, '45', '60', '90')
    AND content->'terminalEnabled' = 'true'::pg_catalog.jsonb
    AND pg_catalog.jsonb_typeof(content->'integratedAi') = 'boolean'
    AND pg_catalog.jsonb_typeof(content->'rubric') = 'array'
  ) IS TRUE),
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY (organization_id, author_principal_id)
    REFERENCES hirearchy.organization_memberships (organization_id, principal_id)
    ON DELETE RESTRICT
);

CREATE INDEX reusable_problems_organization_updated_idx
  ON hirearchy.reusable_problems (organization_id, updated_at DESC, id);

ALTER TABLE hirearchy.reusable_problems ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.reusable_problems FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE hirearchy.reusable_problems
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker;

DO $revoke_gateway$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r23_gateway') THEN
    REVOKE ALL ON TABLE hirearchy.reusable_problems FROM r23_gateway;
  END IF;
END
$revoke_gateway$;
