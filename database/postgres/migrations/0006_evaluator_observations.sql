CREATE TABLE hirearchy.evaluator_observations (
  id pg_catalog.uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id pg_catalog.uuid NOT NULL,
  session_id pg_catalog.text NOT NULL,
  author_principal_id pg_catalog.uuid NOT NULL,
  evidence_source_type pg_catalog.text NOT NULL CHECK (evidence_source_type IN ('timeline_event', 'file_revision')),
  event_sequence pg_catalog.int8 NOT NULL CHECK (event_sequence > 0),
  file_path pg_catalog.text NULL,
  file_version pg_catalog.int8 NULL CHECK (file_version IS NULL OR file_version >= 1),
  evidence_digest pg_catalog.text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  body pg_catalog.text NOT NULL CHECK (
    pg_catalog.octet_length(pg_catalog.convert_to(body, 'UTF8')) >= 1 AND
    pg_catalog.octet_length(pg_catalog.convert_to(body, 'UTF8')) <= 20000
  ),
  version pg_catalog.int8 NOT NULL DEFAULT 1 CHECK (version >= 1),
  visibility pg_catalog.text NOT NULL DEFAULT 'private' CHECK (visibility = 'private'),
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES hirearchy.assessment_sessions (organization_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, author_principal_id)
    REFERENCES hirearchy.organization_memberships (organization_id, principal_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (session_id, event_sequence)
    REFERENCES hirearchy.candidate_session_events (session_id, sequence)
    ON DELETE RESTRICT,
  CHECK (
    (evidence_source_type = 'timeline_event' AND file_path IS NULL AND file_version IS NULL)
    OR (evidence_source_type = 'file_revision' AND file_path IS NOT NULL AND file_version IS NOT NULL)
  )
);

CREATE TABLE hirearchy.evaluator_observation_history (
  history_id pg_catalog.uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.evaluator_observations (id)
    ON DELETE RESTRICT,
  organization_id pg_catalog.uuid NOT NULL,
  session_id pg_catalog.text NOT NULL,
  author_principal_id pg_catalog.uuid NOT NULL,
  version pg_catalog.int8 NOT NULL CHECK (version >= 1),
  body pg_catalog.text NOT NULL,
  evidence_source_type pg_catalog.text NOT NULL,
  event_sequence pg_catalog.int8 NOT NULL,
  file_path pg_catalog.text NULL,
  file_version pg_catalog.int8 NULL,
  evidence_digest pg_catalog.text NOT NULL,
  visibility pg_catalog.text NOT NULL,
  valid_from pg_catalog.timestamptz NOT NULL,
  valid_until pg_catalog.timestamptz NOT NULL,
  recorded_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES hirearchy.assessment_sessions (organization_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, author_principal_id)
    REFERENCES hirearchy.organization_memberships (organization_id, principal_id)
    ON DELETE RESTRICT
);

CREATE INDEX evaluator_observations_org_session_author_idx
  ON hirearchy.evaluator_observations (organization_id, session_id, author_principal_id);

CREATE INDEX evaluator_observations_obs_id_idx
  ON hirearchy.evaluator_observations (id);

CREATE INDEX evaluator_observation_history_obs_id_idx
  ON hirearchy.evaluator_observation_history (observation_id);

CREATE INDEX evaluator_observation_history_org_session_author_idx
  ON hirearchy.evaluator_observation_history (organization_id, session_id, author_principal_id);

CREATE TRIGGER evaluator_observations_immutable_fields
  BEFORE UPDATE OF id, organization_id, session_id, author_principal_id,
                   evidence_source_type, event_sequence, file_path, file_version,
                   evidence_digest, created_at, visibility
  ON hirearchy.evaluator_observations
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_immutable_columns(
    'id', 'organization_id', 'session_id', 'author_principal_id',
    'evidence_source_type', 'event_sequence', 'file_path', 'file_version',
    'evidence_digest', 'created_at', 'visibility'
  );

CREATE FUNCTION hirearchy.r29_reject_observation_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Evaluator observation history is append-only and immutable' USING ERRCODE = '23514';
END
$function$;

CREATE TRIGGER evaluator_observation_history_immutable
  BEFORE UPDATE OR DELETE ON hirearchy.evaluator_observation_history
  FOR EACH ROW EXECUTE FUNCTION hirearchy.r29_reject_observation_history_mutation();

ALTER TABLE hirearchy.evaluator_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.evaluator_observations FORCE ROW LEVEL SECURITY;

ALTER TABLE hirearchy.evaluator_observation_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.evaluator_observation_history FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE hirearchy.evaluator_observations
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker, r23_gateway;

REVOKE ALL ON TABLE hirearchy.evaluator_observation_history
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker, r23_gateway;

REVOKE ALL ON FUNCTION hirearchy.r29_reject_observation_history_mutation()
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker, r23_gateway;
