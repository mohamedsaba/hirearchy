CREATE TABLE hirearchy.evaluator_review_packets (
  id pg_catalog.uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id pg_catalog.uuid NOT NULL,
  session_id pg_catalog.text NOT NULL,
  author_principal_id pg_catalog.uuid NOT NULL,
  status pg_catalog.text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'FINALIZED')),
  summary pg_catalog.text NOT NULL DEFAULT '',
  strengths pg_catalog.jsonb NOT NULL DEFAULT '[]'::pg_catalog.jsonb,
  concerns pg_catalog.jsonb NOT NULL DEFAULT '[]'::pg_catalog.jsonb,
  unresolved_questions pg_catalog.jsonb NOT NULL DEFAULT '[]'::pg_catalog.jsonb,
  referenced_observation_ids pg_catalog.jsonb NOT NULL DEFAULT '[]'::pg_catalog.jsonb,
  referenced_evidence pg_catalog.jsonb NOT NULL DEFAULT '[]'::pg_catalog.jsonb,
  version pg_catalog.int8 NOT NULL DEFAULT 1 CHECK (version >= 1),
  finalized_at pg_catalog.timestamptz NULL,
  final_digest pg_catalog.text NULL CHECK (final_digest IS NULL OR final_digest ~ '^[0-9a-f]{64}$'),
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES hirearchy.assessment_sessions (organization_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, author_principal_id)
    REFERENCES hirearchy.organization_memberships (organization_id, principal_id)
    ON DELETE RESTRICT,
  UNIQUE (organization_id, session_id, author_principal_id),
  CHECK (
    (status = 'DRAFT' AND finalized_at IS NULL AND final_digest IS NULL)
    OR (status = 'FINALIZED' AND finalized_at IS NOT NULL AND final_digest IS NOT NULL)
  )
);

CREATE TABLE hirearchy.evaluator_review_packet_history (
  history_id pg_catalog.uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  packet_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.evaluator_review_packets (id)
    ON DELETE RESTRICT,
  organization_id pg_catalog.uuid NOT NULL,
  session_id pg_catalog.text NOT NULL,
  author_principal_id pg_catalog.uuid NOT NULL,
  status pg_catalog.text NOT NULL,
  version pg_catalog.int8 NOT NULL CHECK (version >= 1),
  summary pg_catalog.text NOT NULL,
  strengths pg_catalog.jsonb NOT NULL,
  concerns pg_catalog.jsonb NOT NULL,
  unresolved_questions pg_catalog.jsonb NOT NULL,
  referenced_observation_ids pg_catalog.jsonb NOT NULL,
  referenced_evidence pg_catalog.jsonb NOT NULL,
  finalized_at pg_catalog.timestamptz NULL,
  final_digest pg_catalog.text NULL,
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

CREATE INDEX evaluator_review_packets_org_session_author_idx
  ON hirearchy.evaluator_review_packets (organization_id, session_id, author_principal_id);

CREATE INDEX evaluator_review_packets_id_idx
  ON hirearchy.evaluator_review_packets (id);

CREATE INDEX evaluator_review_packet_history_packet_id_idx
  ON hirearchy.evaluator_review_packet_history (packet_id);

CREATE INDEX evaluator_review_packet_history_org_session_author_idx
  ON hirearchy.evaluator_review_packet_history (organization_id, session_id, author_principal_id);

CREATE TRIGGER evaluator_review_packets_immutable_fields
  BEFORE UPDATE OF id, organization_id, session_id, author_principal_id, created_at
  ON hirearchy.evaluator_review_packets
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_immutable_columns(
    'id', 'organization_id', 'session_id', 'author_principal_id', 'created_at'
  );

CREATE FUNCTION hirearchy.r210_reject_finalized_packet_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF OLD.status = 'FINALIZED' THEN
    RAISE EXCEPTION 'Finalized review packet is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER evaluator_review_packets_reject_finalized_mutation
  BEFORE UPDATE OR DELETE ON hirearchy.evaluator_review_packets
  FOR EACH ROW EXECUTE FUNCTION hirearchy.r210_reject_finalized_packet_mutation();

CREATE FUNCTION hirearchy.r210_reject_review_packet_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Review packet history is append-only and immutable' USING ERRCODE = '23514';
END
$function$;

CREATE TRIGGER evaluator_review_packet_history_immutable
  BEFORE UPDATE OR DELETE ON hirearchy.evaluator_review_packet_history
  FOR EACH ROW EXECUTE FUNCTION hirearchy.r210_reject_review_packet_history_mutation();

ALTER TABLE hirearchy.evaluator_review_packets ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.evaluator_review_packets FORCE ROW LEVEL SECURITY;

ALTER TABLE hirearchy.evaluator_review_packet_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.evaluator_review_packet_history FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE hirearchy.evaluator_review_packets
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker, r23_gateway;

REVOKE ALL ON TABLE hirearchy.evaluator_review_packet_history
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker, r23_gateway;

REVOKE ALL ON FUNCTION hirearchy.r210_reject_finalized_packet_mutation()
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker, r23_gateway;

REVOKE ALL ON FUNCTION hirearchy.r210_reject_review_packet_history_mutation()
  FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker, r23_gateway;
