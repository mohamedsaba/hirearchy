ALTER TABLE hirearchy.candidate_token_envelopes
  ADD COLUMN expires_at pg_catalog.timestamptz,
  ADD COLUMN revoked_at pg_catalog.timestamptz,
  ADD CONSTRAINT candidate_token_envelopes_lifecycle_check CHECK (
    (expires_at IS NULL AND revoked_at IS NULL)
    OR (expires_at IS NOT NULL
        AND expires_at > created_at
        AND expires_at <= created_at + INTERVAL '30 days'
        AND (revoked_at IS NULL OR revoked_at >= created_at))
  );

CREATE TABLE hirearchy.candidate_invitation_requests (
  organization_id pg_catalog.uuid NOT NULL,
  idempotency_key pg_catalog.text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9._~-]{1,128}$'),
  session_id pg_catalog.text NOT NULL,
  issuer_principal_id pg_catalog.uuid NOT NULL,
  request_hash pg_catalog.text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  expires_at pg_catalog.timestamptz NOT NULL,
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (organization_id, idempotency_key),
  UNIQUE (organization_id, session_id),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES hirearchy.assessment_sessions (organization_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, issuer_principal_id)
    REFERENCES hirearchy.organization_memberships (organization_id, principal_id)
    ON DELETE RESTRICT
);

CREATE TABLE hirearchy.candidate_data_consents (
  organization_id pg_catalog.uuid NOT NULL,
  session_id pg_catalog.text PRIMARY KEY,
  notice_version pg_catalog.text NOT NULL CHECK (notice_version = 'candidate-data-v1'),
  notice_digest pg_catalog.text NOT NULL CHECK (
    notice_digest = '9bfa590ff8fe9f3af6c9d020d9641bb736340b3f4ca03bc9e7aac3a0a1e22059'
  ),
  notice_text pg_catalog.text NOT NULL CHECK (
    notice_text = 'This workspace records saved code, revisions, task activity and submission for your assigned hiring team’s review. This demo uses synthetic data; do not enter secrets or real candidate information. AI assistance and code execution are unavailable in this demo.'
  ),
  accepted_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES hirearchy.assessment_sessions (organization_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE hirearchy.durable_candidate_installation (
  marker_key pg_catalog.text PRIMARY KEY
    CHECK (marker_key = 'durable-candidate-lifecycle-v1'),
  marker_version pg_catalog.int4 NOT NULL CHECK (marker_version = 1),
  migration_version pg_catalog.text NOT NULL CHECK (migration_version = '0016'),
  migration_checksum pg_catalog.text NOT NULL CHECK (migration_checksum ~ '^[0-9a-f]{64}$'),
  installed_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  installed_by pg_catalog.name NOT NULL DEFAULT current_user
);

ALTER TABLE hirearchy.candidate_invitation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.candidate_invitation_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.candidate_data_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.candidate_data_consents FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.durable_candidate_installation ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.durable_candidate_installation FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE hirearchy.candidate_invitation_requests,
  hirearchy.candidate_data_consents,
  hirearchy.durable_candidate_installation
  FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway,
       app_control_worker;

CREATE POLICY r26_candidate_consent_select
  ON hirearchy.candidate_data_consents
  FOR SELECT TO hirearchy_migrator
  USING (
    session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND EXISTS (
      SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
      WHERE envelope.session_id = candidate_data_consents.session_id
        AND envelope.candidate_token_hash = NULLIF(
          pg_catalog.current_setting('r26.token_hash', true), ''
        )
    )
  );
CREATE POLICY r26_candidate_consent_insert
  ON hirearchy.candidate_data_consents
  FOR INSERT TO hirearchy_migrator
  WITH CHECK (
    session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND EXISTS (
      SELECT 1 FROM hirearchy.candidate_token_envelopes AS envelope
      WHERE envelope.session_id = candidate_data_consents.session_id
        AND envelope.candidate_token_hash = NULLIF(
          pg_catalog.current_setting('r26.token_hash', true), ''
        )
        AND envelope.expires_at > pg_catalog.clock_timestamp()
        AND envelope.revoked_at IS NULL
    )
  );
CREATE POLICY r26_candidate_envelope_update
  ON hirearchy.candidate_token_envelopes
  FOR UPDATE TO hirearchy_migrator
  USING (
    session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND candidate_token_hash = NULLIF(
      pg_catalog.current_setting('r26.token_hash', true), ''
    )
  )
  WITH CHECK (
    session_id = NULLIF(pg_catalog.current_setting('r26.session_id', true), '')
    AND candidate_token_hash = NULLIF(
      pg_catalog.current_setting('r26.token_hash', true), ''
    )
  );
CREATE POLICY r26_durable_candidate_marker_select
  ON hirearchy.durable_candidate_installation
  FOR SELECT TO hirearchy_migrator
  USING (true);

CREATE TRIGGER candidate_invitation_requests_immutable
  BEFORE UPDATE OR DELETE ON hirearchy.candidate_invitation_requests
  FOR EACH ROW EXECUTE FUNCTION hirearchy.r26_reject_candidate_immutable();
CREATE TRIGGER candidate_data_consents_immutable
  BEFORE UPDATE OR DELETE ON hirearchy.candidate_data_consents
  FOR EACH ROW EXECUTE FUNCTION hirearchy.r26_reject_candidate_immutable();
CREATE TRIGGER durable_candidate_installation_immutable
  BEFORE UPDATE OR DELETE ON hirearchy.durable_candidate_installation
  FOR EACH ROW EXECUTE FUNCTION hirearchy.r26_reject_candidate_immutable();

CREATE FUNCTION hirearchy.r26_guard_candidate_invitation_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.candidate_token_hash IS DISTINCT FROM OLD.candidate_token_hash
     OR NEW.candidate_token_ciphertext IS DISTINCT FROM OLD.candidate_token_ciphertext
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'R2.5 candidate invitation material is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'R2.5 candidate invitation expiry is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     AND (OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR OLD.expires_at IS NULL) THEN
    RAISE EXCEPTION 'R2.5 candidate invitation revocation is terminal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION hirearchy.r26_guard_candidate_invitation_lifecycle()
  OWNER TO hirearchy_migrator;
REVOKE ALL ON FUNCTION hirearchy.r26_guard_candidate_invitation_lifecycle()
  FROM PUBLIC, r23_gateway, app_evaluator, app_candidate_gateway, app_control_worker;
CREATE TRIGGER candidate_token_envelopes_lifecycle_immutable
  BEFORE UPDATE ON hirearchy.candidate_token_envelopes
  FOR EACH ROW EXECUTE FUNCTION hirearchy.r26_guard_candidate_invitation_lifecycle();

CREATE FUNCTION hirearchy.r26_candidate_lifecycle_ready()
RETURNS pg_catalog.bool
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF SESSION_USER <> 'app_candidate_gateway'
     OR CURRENT_USER <> 'hirearchy_migrator' THEN
    RAISE EXCEPTION 'R2.6 candidate role denied' USING ERRCODE = 'R2608';
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM hirearchy.durable_candidate_installation AS marker
    JOIN hirearchy.schema_migrations AS migration
      ON migration.version = marker.migration_version
     AND migration.checksum = marker.migration_checksum
    WHERE marker.marker_key = 'durable-candidate-lifecycle-v1'
      AND marker.marker_version = 1
      AND marker.migration_version = '0016'
      AND migration.applied_by = 'hirearchy_migrator'
  );
END
$function$;

ALTER FUNCTION hirearchy.r26_candidate_lifecycle_ready()
  OWNER TO hirearchy_migrator;
REVOKE ALL ON FUNCTION hirearchy.r26_candidate_lifecycle_ready()
  FROM PUBLIC, r23_gateway, app_evaluator, app_control_worker;
GRANT EXECUTE ON FUNCTION hirearchy.r26_candidate_lifecycle_ready()
  TO app_candidate_gateway;

ALTER FUNCTION hirearchy.r26_candidate_command(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb
) RENAME TO r26_candidate_command_unchecked;
REVOKE ALL ON FUNCTION hirearchy.r26_candidate_command_unchecked(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb
) FROM PUBLIC, app_candidate_gateway, app_evaluator, app_control_worker,
     r23_gateway;

CREATE FUNCTION hirearchy.r26_candidate_command(
  p_token_hash pg_catalog.text,
  p_session_id pg_catalog.text,
  p_action pg_catalog.text,
  p_input pg_catalog.jsonb
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_marker record;
  v_session record;
  v_invitation record;
  v_consent record;
  v_has_consent pg_catalog.bool;
  v_input_key_count pg_catalog.int8;
  v_consent_key_count pg_catalog.int8;
  v_now pg_catalog.timestamptz;
  v_notice pg_catalog.text := 'This workspace records saved code, revisions, task activity and submission for your assigned hiring team’s review. This demo uses synthetic data; do not enter secrets or real candidate information. AI assistance and code execution are unavailable in this demo.';
  v_notice_digest pg_catalog.text := '9bfa590ff8fe9f3af6c9d020d9641bb736340b3f4ca03bc9e7aac3a0a1e22059';
  v_result pg_catalog.jsonb;
BEGIN
  IF SESSION_USER <> 'app_candidate_gateway'
     OR CURRENT_USER <> 'hirearchy_migrator' THEN
    RAISE EXCEPTION 'R2.6 candidate role denied' USING ERRCODE = 'R2608';
  END IF;

  SELECT marker.marker_version, marker.migration_version,
         marker.migration_checksum
    INTO v_marker
    FROM hirearchy.durable_candidate_installation AS marker
   WHERE marker.marker_key = 'durable-candidate-lifecycle-v1';
  IF NOT FOUND THEN
    RETURN hirearchy.r26_candidate_command_unchecked(
      p_token_hash, p_session_id, p_action, p_input
    );
  END IF;
  IF v_marker.marker_version <> 1
     OR v_marker.migration_version <> '0016'
     OR NOT EXISTS (
       SELECT 1 FROM hirearchy.schema_migrations AS migration
       WHERE migration.version = v_marker.migration_version
         AND migration.checksum = v_marker.migration_checksum
         AND migration.applied_by = 'hirearchy_migrator'
     ) THEN
    RAISE EXCEPTION 'R2.6 candidate lifecycle is unavailable' USING ERRCODE = 'R2608';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_session_id IS NULL OR p_session_id !~ '^sess_[A-Za-z0-9_-]{1,128}$'
     OR p_action NOT IN ('read', 'activate', 'save', 'submit')
     OR p_input IS NULL OR pg_catalog.jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'R2.6 invalid candidate command' USING ERRCODE = 'R2603';
  END IF;

  PERFORM pg_catalog.set_config('r26.session_id', p_session_id, true);
  PERFORM pg_catalog.set_config('r26.token_hash', p_token_hash, true);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('r26-candidate:' || p_session_id, 0)
  );

  -- The shared per-session advisory lock serializes recruiter lifecycle changes
  -- before the candidate function takes its session and invitation row locks.
  SELECT session.* INTO v_session
    FROM hirearchy.assessment_sessions AS session
   WHERE session.id = p_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'R2.6 candidate session unavailable' USING ERRCODE = 'R2604';
  END IF;

  SELECT envelope.organization_id, envelope.expires_at, envelope.revoked_at
    INTO v_invitation
    FROM hirearchy.candidate_token_envelopes AS envelope
   WHERE envelope.session_id = p_session_id
     AND envelope.candidate_token_hash = p_token_hash
   FOR UPDATE;
  IF NOT FOUND OR v_invitation.expires_at IS NULL
     OR v_invitation.revoked_at IS NOT NULL
     OR v_invitation.expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'R2.6 candidate session unavailable' USING ERRCODE = 'R2604';
  END IF;

  SELECT consent.notice_version, consent.notice_digest, consent.notice_text
    INTO v_consent
    FROM hirearchy.candidate_data_consents AS consent
   WHERE consent.session_id = p_session_id;
  v_has_consent := FOUND;

  IF p_action = 'activate' THEN
    IF pg_catalog.jsonb_typeof(p_input -> 'consent') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'R2.6 candidate consent is required' USING ERRCODE = 'R2603';
    END IF;
    SELECT pg_catalog.count(*) INTO v_input_key_count
      FROM pg_catalog.jsonb_object_keys(p_input);
    SELECT pg_catalog.count(*) INTO v_consent_key_count
      FROM pg_catalog.jsonb_object_keys(p_input -> 'consent');
    IF v_input_key_count <> 1
       OR v_consent_key_count <> 3
       OR pg_catalog.jsonb_typeof(p_input -> 'consent' -> 'version') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(p_input -> 'consent' -> 'digest') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(p_input -> 'consent' -> 'accepted') IS DISTINCT FROM 'boolean'
       OR p_input -> 'consent' ->> 'version' IS DISTINCT FROM 'candidate-data-v1'
       OR p_input -> 'consent' ->> 'digest' IS DISTINCT FROM v_notice_digest
       OR p_input -> 'consent' -> 'accepted' IS DISTINCT FROM 'true'::pg_catalog.jsonb THEN
      RAISE EXCEPTION 'R2.6 candidate consent is required' USING ERRCODE = 'R2603';
    END IF;
    IF v_has_consent THEN
      IF v_consent.notice_version <> 'candidate-data-v1'
         OR v_consent.notice_digest <> v_notice_digest
         OR v_consent.notice_text <> v_notice THEN
        RAISE EXCEPTION 'R2.6 candidate consent is unavailable' USING ERRCODE = 'R2608';
      END IF;
    ELSE
      IF v_session.status <> 'CREATED'
         OR v_session.activated_at IS NOT NULL
         OR EXISTS (
           SELECT 1 FROM hirearchy.candidate_session_events AS event
           WHERE event.session_id = p_session_id
         ) THEN
        RAISE EXCEPTION 'R2.6 candidate session is unavailable' USING ERRCODE = 'R2605';
      END IF;
      INSERT INTO hirearchy.candidate_data_consents (
        organization_id, session_id, notice_version, notice_digest, notice_text
      ) VALUES (
        v_invitation.organization_id, p_session_id,
        'candidate-data-v1', v_notice_digest, v_notice
      );
    END IF;
    v_result := hirearchy.r26_candidate_command_unchecked(
      p_token_hash, p_session_id, p_action, '{}'::pg_catalog.jsonb
    );
  ELSE
    IF NOT v_has_consent
       AND (p_action <> 'read' OR v_session.status <> 'CREATED') THEN
      RAISE EXCEPTION 'R2.6 candidate consent is unavailable' USING ERRCODE = 'R2604';
    END IF;
    v_result := hirearchy.r26_candidate_command_unchecked(
      p_token_hash, p_session_id, p_action, p_input
    );
  END IF;

  RETURN v_result || pg_catalog.jsonb_build_object(
    'invitationExpiresAt', v_invitation.expires_at,
    'capabilities', pg_catalog.jsonb_build_object('ai', false, 'execution', false),
    'dataNotice', pg_catalog.jsonb_build_object(
      'version', 'candidate-data-v1',
      'digest', v_notice_digest,
      'text', v_notice
    )
  );
END
$function$;

ALTER FUNCTION hirearchy.r26_candidate_command(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb
) OWNER TO hirearchy_migrator;
REVOKE ALL ON FUNCTION hirearchy.r26_candidate_command(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb
) FROM PUBLIC, app_evaluator, app_control_worker, r23_gateway;
GRANT EXECUTE ON FUNCTION hirearchy.r26_candidate_command(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb
) TO app_candidate_gateway;
