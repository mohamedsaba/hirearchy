BEGIN;

CREATE SCHEMA restricted_executor AUTHORIZATION restricted_executor_owner;
REVOKE ALL ON SCHEMA restricted_executor FROM PUBLIC;
GRANT USAGE ON SCHEMA restricted_executor TO restricted_executor_runtime;

SET ROLE restricted_executor_owner;

CREATE TABLE restricted_executor.schema_meta (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL CHECK (version = 1),
  installed_at timestamp with time zone NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

INSERT INTO restricted_executor.schema_meta (singleton, version) VALUES (true, 1);

CREATE TABLE restricted_executor.requests (
  request_id text PRIMARY KEY CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  generation bigint NOT NULL CHECK (generation > 0),
  fence bigint NOT NULL CHECK (fence > 0),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  intent jsonb NOT NULL CHECK (
    pg_catalog.jsonb_typeof(intent) = 'object'
    AND intent ?& ARRAY['requestId', 'sessionRef', 'scenarioRef', 'scenarioVersion', 'snapshotDigest', 'recipeId', 'recipeVersion', 'recipeDigest', 'timeoutMs', 'resources', 'outputBytes', 'operationId', 'generation', 'fence', 'callerId', 'keyId', 'admissionVersion']
    AND intent - ARRAY['requestId', 'sessionRef', 'scenarioRef', 'scenarioVersion', 'snapshotDigest', 'recipeId', 'recipeVersion', 'recipeDigest', 'timeoutMs', 'resources', 'outputBytes', 'operationId', 'generation', 'fence', 'callerId', 'keyId', 'admissionVersion'] = '{}'::jsonb
  ),
  state text NOT NULL CHECK (state IN ('active', 'reconciling', 'unknown', 'complete')),
  owner jsonb,
  owner_token uuid UNIQUE,
  attempt jsonb NOT NULL CHECK (COALESCE((
    pg_catalog.jsonb_typeof(attempt) = 'object'
    AND attempt ?& ARRAY['attemptId', 'containerName', 'requestLabel', 'operationLabel', 'attemptLabel', 'stage', 'createAmbiguous', 'containerId']
    AND attempt - ARRAY['attemptId', 'containerName', 'requestLabel', 'operationLabel', 'attemptLabel', 'stage', 'createAmbiguous', 'containerId'] = '{}'::jsonb
    AND attempt->>'attemptId' ~ '^[a-f0-9]{32}$'
    AND attempt->>'containerName' = 'hirearchy-executor-codex-' || (attempt->>'attemptId')
    AND attempt->>'requestLabel' ~ '^[a-f0-9]{64}$'
    AND attempt->>'operationLabel' ~ '^[a-f0-9]{64}$'
    AND attempt->>'attemptLabel' = attempt->>'attemptId'
    AND attempt->>'stage' IN ('prepared', 'creating', 'created', 'starting', 'running')
    AND pg_catalog.jsonb_typeof(attempt->'createAmbiguous') = 'boolean'
    AND pg_catalog.jsonb_typeof(attempt->'containerId') IN ('string', 'null')
    AND (
      (attempt->>'stage' = 'prepared' AND attempt->>'createAmbiguous' = 'false' AND attempt->>'containerId' IS NULL)
      OR (attempt->>'stage' = 'creating' AND attempt->>'createAmbiguous' = 'true' AND (attempt->>'containerId' IS NULL OR attempt->>'containerId' ~ '^[a-f0-9]{64}$'))
      OR (attempt->>'stage' IN ('created', 'starting', 'running') AND attempt->>'createAmbiguous' = 'false' AND attempt->>'containerId' ~ '^[a-f0-9]{64}$')
    )
  ), false)),
  cleanup jsonb CHECK (cleanup IS NULL OR COALESCE((
    pg_catalog.jsonb_typeof(cleanup) = 'object'
    AND cleanup ?& ARRAY['verified', 'containerRemoved', 'containerId', 'containerStatus', 'lateCreatePossible', 'stagingDirectoryRemoved', 'dockerClientConfigRemoved']
    AND cleanup - ARRAY['verified', 'containerRemoved', 'containerId', 'containerStatus', 'lateCreatePossible', 'stagingDirectoryRemoved', 'dockerClientConfigRemoved'] = '{}'::jsonb
    AND pg_catalog.jsonb_typeof(cleanup->'verified') = 'boolean'
    AND pg_catalog.jsonb_typeof(cleanup->'containerRemoved') = 'boolean'
    AND pg_catalog.jsonb_typeof(cleanup->'lateCreatePossible') = 'boolean'
    AND pg_catalog.jsonb_typeof(cleanup->'stagingDirectoryRemoved') = 'boolean'
    AND pg_catalog.jsonb_typeof(cleanup->'dockerClientConfigRemoved') = 'boolean'
    AND (cleanup->>'containerId' IS NULL OR cleanup->>'containerId' ~ '^[a-f0-9]{64}$')
    AND cleanup->>'containerStatus' IN ('absent', 'removed', 'present', 'unverified', 'unavailable')
  ), false)),
  receipt jsonb CHECK (
    receipt IS NULL OR (
      COALESCE((pg_catalog.jsonb_typeof(receipt) = 'object'
      AND receipt->>'requestId' = request_id
      AND receipt->>'operationId' = operation_id
      AND receipt->>'generation' = generation::text
      AND receipt->>'fence' = fence::text), false)
    )
  ),
  created_at timestamp with time zone NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamp with time zone NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (operation_id, generation),
  UNIQUE (operation_id, fence),
  UNIQUE (operation_id, request_id, generation, fence),
  CHECK (COALESCE(intent->>'requestId' = request_id, false)),
  CHECK (COALESCE(intent->>'operationId' = operation_id, false)),
  CHECK (COALESCE(intent->>'generation' = generation::text, false)),
  CHECK (COALESCE(intent->>'fence' = fence::text, false)),
  CHECK (COALESCE((
    (state IN ('active', 'reconciling') AND pg_catalog.jsonb_typeof(owner) = 'object' AND owner_token IS NOT NULL)
    OR (state IN ('unknown', 'complete') AND owner IS NULL AND owner_token IS NULL)
  ), false)),
  CHECK ((state = 'complete') = (receipt IS NOT NULL)),
  CHECK (owner IS NULL OR COALESCE((
    pg_catalog.jsonb_typeof(owner) = 'object'
    AND owner ?& ARRAY['pid', 'startTicks', 'bootId', 'pidNamespace']
    AND owner - ARRAY['pid', 'startTicks', 'bootId', 'pidNamespace'] = '{}'::jsonb
    AND owner->>'pid' ~ '^[1-9][0-9]*$'
    AND owner->>'startTicks' ~ '^[0-9]+$'
    AND owner->>'bootId' ~ '^[A-Fa-f0-9-]{16,64}$'
    AND owner->>'pidNamespace' LIKE 'pid:%'
  ), false))
);

CREATE UNIQUE INDEX requests_attempt_id_unique
  ON restricted_executor.requests ((attempt->>'attemptId'));

CREATE TABLE restricted_executor.request_owners (
  owner_token uuid PRIMARY KEY,
  request_id text NOT NULL REFERENCES restricted_executor.requests (request_id),
  acquired_at timestamp with time zone NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE restricted_executor.request_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id text NOT NULL REFERENCES restricted_executor.requests (request_id),
  operation_id text NOT NULL,
  generation bigint NOT NULL,
  fence bigint NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('reserved', 'state_transition', 'owner_transition', 'attempt_updated')),
  from_state text CHECK (from_state IS NULL OR from_state IN ('active', 'reconciling', 'unknown', 'complete')),
  to_state text NOT NULL CHECK (to_state IN ('active', 'reconciling', 'unknown', 'complete')),
  from_owner_token uuid,
  to_owner_token uuid,
  attempt_id text NOT NULL CHECK (attempt_id ~ '^[a-f0-9]{32}$'),
  stage text NOT NULL CHECK (stage IN ('prepared', 'creating', 'created', 'starting', 'running')),
  container_id text CHECK (container_id IS NULL OR container_id ~ '^[a-f0-9]{64}$'),
  create_ambiguous boolean NOT NULL,
  occurred_at timestamp with time zone NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE restricted_executor.operations (
  operation_id text PRIMARY KEY CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  generation bigint NOT NULL CHECK (generation > 0),
  fence bigint NOT NULL CHECK (fence > 0),
  request_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'reconciling', 'unknown', 'complete')),
  updated_at timestamp with time zone NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (operation_id, request_id, generation, fence),
  FOREIGN KEY (operation_id, request_id, generation, fence)
    REFERENCES restricted_executor.requests (operation_id, request_id, generation, fence)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION restricted_executor.guard_request_write() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, restricted_executor
AS $function$
DECLARE
  current_operation restricted_executor.operations%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'active' OR NEW.receipt IS NOT NULL OR NEW.cleanup IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'new execution must start active';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('operation:' || NEW.operation_id, 0)
    );
    SELECT * INTO current_operation
      FROM restricted_executor.operations
      WHERE operation_id = NEW.operation_id
      FOR UPDATE;
    IF FOUND AND (
      current_operation.state <> 'complete'
      OR NEW.generation <= current_operation.generation
      OR NEW.fence <= current_operation.fence
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operation generation or fence is not admissible';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'complete'
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.generation IS DISTINCT FROM OLD.generation
     OR NEW.fence IS DISTINCT FROM OLD.fence
     OR NEW.intent_digest IS DISTINCT FROM OLD.intent_digest
     OR NEW.intent IS DISTINCT FROM OLD.intent
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'execution identity or completed receipt is immutable';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('operation:' || NEW.operation_id, 0)
  );
  SELECT * INTO current_operation
    FROM restricted_executor.operations
    WHERE operation_id = NEW.operation_id
    FOR UPDATE;
  IF NOT FOUND OR current_operation.request_id <> NEW.request_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'only the current operation owner may update execution';
  END IF;

  IF NOT (
    (OLD.state = NEW.state AND NEW.state IN ('active', 'reconciling'))
    OR (OLD.state = 'active' AND NEW.state IN ('reconciling', 'unknown', 'complete'))
    OR (OLD.state = 'unknown' AND NEW.state = 'reconciling')
    OR (OLD.state = 'reconciling' AND NEW.state = 'unknown')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid execution state transition';
  END IF;

  IF OLD.state = NEW.state AND (
    OLD.owner_token IS DISTINCT FROM NEW.owner_token
    OR OLD.owner IS DISTINCT FROM NEW.owner
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'execution owner cannot change without a state transition';
  END IF;
  IF OLD.owner_token IS DISTINCT FROM NEW.owner_token
     AND NEW.state NOT IN ('reconciling', 'unknown', 'complete') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'execution owner transition is invalid';
  END IF;

  IF OLD.attempt->>'attemptId' IS DISTINCT FROM NEW.attempt->>'attemptId'
     OR OLD.attempt->>'containerName' IS DISTINCT FROM NEW.attempt->>'containerName'
     OR OLD.attempt->>'requestLabel' IS DISTINCT FROM NEW.attempt->>'requestLabel'
     OR OLD.attempt->>'operationLabel' IS DISTINCT FROM NEW.attempt->>'operationLabel'
     OR OLD.attempt->>'attemptLabel' IS DISTINCT FROM NEW.attempt->>'attemptLabel'
     OR (OLD.attempt->>'containerId' IS NOT NULL AND OLD.attempt->>'containerId' IS DISTINCT FROM NEW.attempt->>'containerId')
     OR (OLD.attempt->>'stage' = 'prepared' AND NEW.attempt->>'stage' NOT IN ('prepared', 'creating'))
     OR (OLD.attempt->>'stage' = 'creating' AND NEW.attempt->>'stage' NOT IN ('creating', 'created', 'starting', 'running'))
     OR (OLD.attempt->>'stage' = 'created' AND NEW.attempt->>'stage' NOT IN ('created', 'starting', 'running'))
     OR (OLD.attempt->>'stage' = 'starting' AND NEW.attempt->>'stage' NOT IN ('starting', 'running'))
     OR (OLD.attempt->>'stage' = 'running' AND NEW.attempt->>'stage' <> 'running')
     OR (OLD.attempt->>'createAmbiguous' = 'true' AND NEW.attempt->>'createAmbiguous' = 'false'
         AND (NEW.attempt->>'stage' <> 'created' OR NEW.attempt->>'containerId' IS NULL OR NEW.attempt->>'containerId' = 'null'))
     OR (OLD.attempt->>'createAmbiguous' = 'false' AND NEW.attempt->>'createAmbiguous' = 'true'
         AND NOT (OLD.attempt->>'stage' = 'prepared' AND NEW.attempt->>'stage' = 'creating')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'container attempt identity cannot be changed or rewound';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER requests_guard_write
  BEFORE INSERT OR UPDATE ON restricted_executor.requests
  FOR EACH ROW EXECUTE FUNCTION restricted_executor.guard_request_write();

CREATE FUNCTION restricted_executor.record_request_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, restricted_executor
AS $function$
DECLARE
  event_kind text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    event_kind := 'reserved';
  ELSIF OLD.state IS DISTINCT FROM NEW.state THEN
    event_kind := 'state_transition';
  ELSIF OLD.owner_token IS DISTINCT FROM NEW.owner_token THEN
    event_kind := 'owner_transition';
  ELSE
    event_kind := 'attempt_updated';
  END IF;

  IF NEW.owner_token IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.owner_token IS DISTINCT FROM NEW.owner_token) THEN
    INSERT INTO restricted_executor.request_owners (owner_token, request_id)
    VALUES (NEW.owner_token, NEW.request_id);
  END IF;

  INSERT INTO restricted_executor.request_events (
    request_id,
    operation_id,
    generation,
    fence,
    event_kind,
    from_state,
    to_state,
    from_owner_token,
    to_owner_token,
    attempt_id,
    stage,
    container_id,
    create_ambiguous
  ) VALUES (
    NEW.request_id,
    NEW.operation_id,
    NEW.generation,
    NEW.fence,
    event_kind,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.state END,
    NEW.state,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.owner_token END,
    NEW.owner_token,
    NEW.attempt->>'attemptId',
    NEW.attempt->>'stage',
    NEW.attempt->>'containerId',
    (NEW.attempt->>'createAmbiguous')::boolean
  );
  RETURN NULL;
END
$function$;

CREATE TRIGGER requests_record_event
  AFTER INSERT OR UPDATE ON restricted_executor.requests
  FOR EACH ROW EXECUTE FUNCTION restricted_executor.record_request_event();

CREATE FUNCTION restricted_executor.guard_operation_write() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, restricted_executor
AS $function$
DECLARE
  current_request restricted_executor.requests%ROWTYPE;
BEGIN
  SELECT * INTO current_request
    FROM restricted_executor.requests
    WHERE operation_id = NEW.operation_id
      AND request_id = NEW.request_id
      AND generation = NEW.generation
      AND fence = NEW.fence;
  IF NOT FOUND OR current_request.state <> NEW.state THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operation head must match its durable request';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'active' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'new operation must start active';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operation identity cannot change';
  END IF;
  IF NEW.generation IS DISTINCT FROM OLD.generation
     OR NEW.fence IS DISTINCT FROM OLD.fence
     OR NEW.request_id IS DISTINCT FROM OLD.request_id THEN
    IF OLD.state <> 'complete'
       OR NEW.state <> 'active'
       OR NEW.generation <= OLD.generation
       OR NEW.fence <= OLD.fence
       OR NEW.request_id = OLD.request_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operation generation and fence must increase after completion';
    END IF;
  ELSIF NOT (
    (OLD.state = NEW.state AND NEW.state IN ('active', 'reconciling'))
    OR (OLD.state = 'active' AND NEW.state IN ('reconciling', 'unknown', 'complete'))
    OR (OLD.state = 'unknown' AND NEW.state = 'reconciling')
    OR (OLD.state = 'reconciling' AND NEW.state = 'unknown')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid operation state transition';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER operations_guard_write
  BEFORE INSERT OR UPDATE ON restricted_executor.operations
  FOR EACH ROW EXECUTE FUNCTION restricted_executor.guard_operation_write();

CREATE FUNCTION restricted_executor.check_request_head() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, restricted_executor
AS $function$
DECLARE
  current_operation restricted_executor.operations%ROWTYPE;
BEGIN
  SELECT * INTO current_operation
    FROM restricted_executor.operations
    WHERE operation_id = NEW.operation_id;
  IF NOT FOUND
     OR current_operation.request_id <> NEW.request_id
     OR current_operation.generation <> NEW.generation
     OR current_operation.fence <> NEW.fence
     OR current_operation.state <> NEW.state THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'request and operation head must commit together';
  END IF;
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER requests_head_consistent
  AFTER INSERT OR UPDATE ON restricted_executor.requests
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION restricted_executor.check_request_head();

ALTER TABLE restricted_executor.schema_meta
  ADD COLUMN guard_fingerprint text CHECK (guard_fingerprint ~ '^[a-f0-9]{32}$');

UPDATE restricted_executor.schema_meta
   SET guard_fingerprint = (
     SELECT pg_catalog.md5(
       (SELECT pg_catalog.string_agg(
          procedure.proname::text || ':'::text || procedure.prosrc || ':'::text || procedure.prosecdef::text || ':'::text ||
          COALESCE(pg_catalog.array_to_string(procedure.proconfig, ','), '') || ':'::text || owner.rolname::text,
          E'\n'::text ORDER BY procedure.proname)
          FROM pg_catalog.pg_proc AS procedure
          JOIN pg_catalog.pg_namespace AS function_namespace ON function_namespace.oid = procedure.pronamespace
          JOIN pg_catalog.pg_roles AS owner ON owner.oid = procedure.proowner
         WHERE function_namespace.nspname = 'restricted_executor'
           AND procedure.proname IN ('check_request_head', 'guard_operation_write', 'guard_request_write', 'record_request_event'))
       || E'\n-- triggers --\n' ||
       (SELECT pg_catalog.string_agg(
          trigger.tgname::text || ':'::text || procedure.proname::text || ':'::text || trigger.tgtype::text || ':'::text ||
          trigger.tgenabled::text || ':'::text || trigger.tgdeferrable::text || ':'::text || trigger.tginitdeferred::text || ':'::text ||
          pg_catalog.pg_get_triggerdef(trigger.oid, true),
          E'\n'::text ORDER BY trigger.tgname)
          FROM pg_catalog.pg_trigger AS trigger
          JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
          JOIN pg_catalog.pg_namespace AS trigger_namespace ON trigger_namespace.oid = relation.relnamespace
          JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = trigger.tgfoid
         WHERE trigger_namespace.nspname = 'restricted_executor'
           AND NOT trigger.tgisinternal)
     )
   )
 WHERE singleton;

ALTER TABLE restricted_executor.schema_meta
  ALTER COLUMN guard_fingerprint SET NOT NULL;

RESET ROLE;

REVOKE ALL ON ALL TABLES IN SCHEMA restricted_executor FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA restricted_executor FROM PUBLIC;
GRANT SELECT ON restricted_executor.schema_meta TO restricted_executor_runtime;
GRANT SELECT ON restricted_executor.request_events TO restricted_executor_runtime;
GRANT SELECT ON restricted_executor.request_owners TO restricted_executor_runtime;
GRANT SELECT, INSERT, UPDATE ON restricted_executor.operations, restricted_executor.requests TO restricted_executor_runtime;

COMMIT;
