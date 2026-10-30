-- Disposable R2.3 Auth/membership fixture only; never apply as a production migration.
BEGIN;

DO $roles$
DECLARE
  gateway_state record;
  owner_oid pg_catalog.oid;
  owner_state record;
BEGIN
  SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
         rolreplication, rolinherit
  INTO gateway_state
  FROM pg_catalog.pg_roles
  WHERE rolname = 'r23_gateway';
  IF NOT FOUND OR NOT gateway_state.rolcanlogin OR gateway_state.rolsuper
     OR gateway_state.rolbypassrls OR gateway_state.rolcreatedb
     OR gateway_state.rolcreaterole OR gateway_state.rolreplication
     OR gateway_state.rolinherit THEN
    RAISE EXCEPTION 'R2.3 gateway role is missing or unsafe';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS role
      ON role.oid = membership.roleid OR role.oid = membership.member
    WHERE role.rolname = 'r23_gateway'
  ) THEN
    RAISE EXCEPTION 'R2.3 gateway role must have no role memberships';
  END IF;

  SELECT oid INTO owner_oid FROM pg_catalog.pg_roles
  WHERE rolname = 'r23_session_owner';
  IF owner_oid IS NULL THEN
    EXECUTE 'CREATE ROLE r23_session_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT';
    SELECT oid INTO owner_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'r23_session_owner';
  END IF;
  SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
         rolreplication, rolinherit
  INTO owner_state
  FROM pg_catalog.pg_roles
  WHERE oid = owner_oid;
  IF owner_state.rolcanlogin OR owner_state.rolsuper OR owner_state.rolbypassrls
     OR owner_state.rolcreatedb OR owner_state.rolcreaterole
     OR owner_state.rolreplication OR owner_state.rolinherit
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_auth_members
       WHERE roleid = owner_oid OR member = owner_oid
     ) THEN
    RAISE EXCEPTION 'R2.3 session owner role is unsafe';
  END IF;
END
$roles$;

CREATE SCHEMA r23 AUTHORIZATION r23_session_owner;
REVOKE ALL ON SCHEMA r23 FROM PUBLIC, r23_gateway;
GRANT USAGE ON SCHEMA r23 TO r23_gateway;
GRANT USAGE ON SCHEMA hirearchy TO r23_session_owner;
REVOKE ALL ON SCHEMA hirearchy FROM r23_gateway;
REVOKE ALL ON ALL TABLES IN SCHEMA hirearchy FROM r23_gateway;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA hirearchy FROM r23_gateway;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hirearchy FROM r23_gateway;

CREATE TABLE r23.principal_subject_bindings (
  subject_id pg_catalog.uuid PRIMARY KEY,
  principal_id pg_catalog.uuid NOT NULL UNIQUE
    REFERENCES hirearchy.application_principals (id) ON DELETE RESTRICT,
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE r23.server_sessions (
  handle_hash pg_catalog.text PRIMARY KEY
    CHECK (handle_hash ~ '^[0-9a-f]{64}$'),
  csrf_hash pg_catalog.text
    CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  callback_hash pg_catalog.text
    CHECK (callback_hash ~ '^[0-9a-f]{64}$'),
  credential_envelope pg_catalog.bytea,
  subject_id pg_catalog.uuid NOT NULL,
  auth_session_id pg_catalog.uuid NOT NULL,
  principal_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.application_principals (id) ON DELETE RESTRICT,
  assurance pg_catalog.text NOT NULL CHECK (assurance IN ('aal1', 'aal2')),
  selected_organization_id pg_catalog.uuid,
  expires_at pg_catalog.timestamptz NOT NULL,
  access_expires_at pg_catalog.timestamptz NOT NULL,
  revoked_at pg_catalog.timestamptz,
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (
    (revoked_at IS NULL AND credential_envelope IS NOT NULL AND csrf_hash IS NOT NULL)
    OR
    (revoked_at IS NOT NULL AND credential_envelope IS NULL AND csrf_hash IS NULL
      AND callback_hash IS NULL AND selected_organization_id IS NULL)
  )
);

ALTER TABLE r23.principal_subject_bindings OWNER TO r23_session_owner;
ALTER TABLE r23.server_sessions OWNER TO r23_session_owner;
ALTER TABLE r23.principal_subject_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE r23.principal_subject_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE r23.server_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE r23.server_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY r23_subject_binding_select ON r23.principal_subject_bindings
  FOR SELECT TO r23_session_owner
  USING (subject_id = NULLIF(pg_catalog.current_setting('r23.auth_subject_id', true), '')::pg_catalog.uuid);
CREATE POLICY r23_subject_binding_insert ON r23.principal_subject_bindings
  FOR INSERT TO r23_session_owner
  WITH CHECK (
    subject_id = NULLIF(pg_catalog.current_setting('r23.auth_subject_id', true), '')::pg_catalog.uuid
    AND principal_id = NULLIF(pg_catalog.current_setting('r23.principal_id', true), '')::pg_catalog.uuid
  );

CREATE POLICY r23_server_session_select ON r23.server_sessions
  FOR SELECT TO r23_session_owner
  USING (handle_hash = NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), ''));
CREATE POLICY r23_server_session_insert ON r23.server_sessions
  FOR INSERT TO r23_session_owner
  WITH CHECK (handle_hash = NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), ''));
CREATE POLICY r23_server_session_update ON r23.server_sessions
  FOR UPDATE TO r23_session_owner
  USING (handle_hash = NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), ''))
  WITH CHECK (handle_hash = NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), ''));

ALTER TABLE hirearchy.application_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.application_principals FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.organization_memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY r23_principal_select ON hirearchy.application_principals
  FOR SELECT TO r23_session_owner
  USING (
    auth_user_id = NULLIF(pg_catalog.current_setting('r23.auth_subject_id', true), '')::pg_catalog.uuid
    OR id = NULLIF(pg_catalog.current_setting('r23.principal_id', true), '')::pg_catalog.uuid
  );
CREATE POLICY r23_principal_insert ON hirearchy.application_principals
  FOR INSERT TO r23_session_owner
  WITH CHECK (
    id = NULLIF(pg_catalog.current_setting('r23.principal_id', true), '')::pg_catalog.uuid
    AND auth_user_id = NULLIF(pg_catalog.current_setting('r23.auth_subject_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS r23_membership_select ON hirearchy.organization_memberships;
CREATE POLICY r25_membership_select ON hirearchy.organization_memberships
  FOR SELECT TO r23_session_owner
  USING (
    principal_id = NULLIF(pg_catalog.current_setting('r23.principal_id', true), '')::pg_catalog.uuid
    OR (
      NULLIF(pg_catalog.current_setting('r23.organization_id', true), '') IS NOT NULL
      AND organization_id = NULLIF(pg_catalog.current_setting('r23.organization_id', true), '')::pg_catalog.uuid
    )
  );
CREATE POLICY r23_membership_lock ON hirearchy.organization_memberships
  FOR UPDATE TO r23_session_owner
  USING (
    principal_id = NULLIF(pg_catalog.current_setting('r23.principal_id', true), '')::pg_catalog.uuid
    AND (
      NULLIF(pg_catalog.current_setting('r23.organization_id', true), '') IS NULL
      OR organization_id = NULLIF(pg_catalog.current_setting('r23.organization_id', true), '')::pg_catalog.uuid
    )
  )
  WITH CHECK (
    principal_id = NULLIF(pg_catalog.current_setting('r23.principal_id', true), '')::pg_catalog.uuid
    AND (
      NULLIF(pg_catalog.current_setting('r23.organization_id', true), '') IS NULL
      OR organization_id = NULLIF(pg_catalog.current_setting('r23.organization_id', true), '')::pg_catalog.uuid
    )
  );

GRANT SELECT, INSERT ON r23.principal_subject_bindings TO r23_session_owner;
GRANT SELECT ON r23.server_sessions TO r23_session_owner;
GRANT INSERT (
  handle_hash, csrf_hash, callback_hash, credential_envelope, subject_id,
  auth_session_id, principal_id, assurance, expires_at, access_expires_at
) ON r23.server_sessions TO r23_session_owner;
GRANT UPDATE (
  csrf_hash, callback_hash, credential_envelope, selected_organization_id,
  access_expires_at, revoked_at
) ON r23.server_sessions TO r23_session_owner;
GRANT SELECT, INSERT ON hirearchy.application_principals TO r23_session_owner;
GRANT SELECT ON hirearchy.organization_memberships TO r23_session_owner;
GRANT UPDATE (status) ON hirearchy.organization_memberships TO r23_session_owner;

CREATE FUNCTION r23.bind_principal(p_subject_id pg_catalog.uuid)
RETURNS pg_catalog.uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_bound_subject_id pg_catalog.uuid;
BEGIN
  IF SESSION_USER <> 'r23_gateway' OR CURRENT_USER <> 'r23_session_owner'
     OR p_subject_id IS NULL
     OR NULLIF(pg_catalog.current_setting('r23.auth_subject_id', true), '')::pg_catalog.uuid
       IS DISTINCT FROM p_subject_id
     OR NULLIF(pg_catalog.current_setting('r23.auth_session_id', true), '') IS NULL
     OR NULLIF(pg_catalog.current_setting('r23.auth_assurance', true), '') IS NULL
     OR NULLIF(pg_catalog.current_setting('r23.auth_assurance', true), '') NOT IN ('aal1', 'aal2') THEN
    RAISE EXCEPTION 'R2.3 authorization denied' USING ERRCODE = 'R2301';
  END IF;

  SELECT binding.principal_id INTO v_principal_id
  FROM r23.principal_subject_bindings AS binding
  WHERE binding.subject_id = p_subject_id;
  IF FOUND THEN
    PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
    SELECT principal.auth_user_id INTO v_bound_subject_id
    FROM hirearchy.application_principals AS principal
    WHERE principal.id = v_principal_id;
    IF NOT FOUND OR v_bound_subject_id IS DISTINCT FROM p_subject_id THEN
      RAISE EXCEPTION 'R2.3 authorization denied' USING ERRCODE = 'R2301';
    END IF;
    RETURN v_principal_id;
  END IF;

  SELECT principal.id INTO v_principal_id
  FROM hirearchy.application_principals AS principal
  WHERE principal.auth_user_id = p_subject_id;
  IF NOT FOUND THEN
    v_principal_id := pg_catalog.gen_random_uuid();
    PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
    INSERT INTO hirearchy.application_principals (id, auth_user_id)
    VALUES (v_principal_id, p_subject_id)
    ON CONFLICT (auth_user_id) DO NOTHING;
    SELECT principal.id INTO v_principal_id
    FROM hirearchy.application_principals AS principal
    WHERE principal.auth_user_id = p_subject_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'R2.3 authorization denied' USING ERRCODE = 'R2301';
    END IF;
  END IF;

  PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
  INSERT INTO r23.principal_subject_bindings (subject_id, principal_id)
  VALUES (p_subject_id, v_principal_id)
  ON CONFLICT (subject_id) DO NOTHING;
  SELECT binding.principal_id INTO v_bound_subject_id
  FROM r23.principal_subject_bindings AS binding
  WHERE binding.subject_id = p_subject_id;
  IF NOT FOUND OR v_bound_subject_id IS DISTINCT FROM v_principal_id THEN
    RAISE EXCEPTION 'R2.3 authorization denied' USING ERRCODE = 'R2301';
  END IF;
  RETURN v_principal_id;
END
$function$;

CREATE FUNCTION r23.create_session(
  p_handle_hash pg_catalog.text,
  p_csrf_hash pg_catalog.text,
  p_callback_hash pg_catalog.text,
  p_credential_envelope pg_catalog.bytea,
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_expires_at pg_catalog.timestamptz,
  p_access_expires_at pg_catalog.timestamptz
)
RETURNS TABLE (principal_id pg_catalog.uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
BEGIN
  IF SESSION_USER <> 'r23_gateway' OR CURRENT_USER <> 'r23_session_owner'
     OR p_handle_hash IS NULL OR p_handle_hash !~ '^[0-9a-f]{64}$'
     OR p_csrf_hash IS NULL OR p_callback_hash IS NULL
     OR p_csrf_hash !~ '^[0-9a-f]{64}$'
     OR p_callback_hash !~ '^[0-9a-f]{64}$'
     OR p_credential_envelope IS NULL
     OR pg_catalog.octet_length(p_credential_envelope) NOT BETWEEN 1 AND 65536
     OR p_subject_id IS NULL OR p_auth_session_id IS NULL OR p_assurance IS NULL
     OR p_assurance NOT IN ('aal1', 'aal2')
     OR p_expires_at IS NULL OR p_expires_at <= pg_catalog.clock_timestamp()
     OR p_access_expires_at IS NULL OR p_access_expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'R2.3 authorization denied' USING ERRCODE = 'R2301';
  END IF;
  PERFORM pg_catalog.set_config('r23.session_handle_hash', p_handle_hash, true);
  PERFORM pg_catalog.set_config('r23.auth_subject_id', p_subject_id::pg_catalog.text, true);
  PERFORM pg_catalog.set_config('r23.auth_session_id', p_auth_session_id::pg_catalog.text, true);
  PERFORM pg_catalog.set_config('r23.auth_assurance', p_assurance, true);
  v_principal_id := r23.bind_principal(p_subject_id);
  INSERT INTO r23.server_sessions (
    handle_hash, csrf_hash, callback_hash, credential_envelope, subject_id,
    auth_session_id, principal_id, assurance, expires_at, access_expires_at
  ) VALUES (
    p_handle_hash, p_csrf_hash, p_callback_hash, p_credential_envelope,
    p_subject_id, p_auth_session_id, v_principal_id, p_assurance,
    p_expires_at, p_access_expires_at
  );
  RETURN QUERY SELECT v_principal_id;
END
$function$;

CREATE FUNCTION r23.lock_active_session(p_handle_hash pg_catalog.text)
RETURNS TABLE (
  handle_hash pg_catalog.text,
  csrf_hash pg_catalog.text,
  callback_hash pg_catalog.text,
  credential_envelope pg_catalog.bytea,
  subject_id pg_catalog.uuid,
  auth_session_id pg_catalog.uuid,
  principal_id pg_catalog.uuid,
  assurance pg_catalog.text,
  selected_organization_id pg_catalog.uuid,
  expires_at pg_catalog.timestamptz,
  access_expires_at pg_catalog.timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session r23.server_sessions%ROWTYPE;
  v_binding_principal pg_catalog.uuid;
  v_auth_subject pg_catalog.uuid;
BEGIN
  IF SESSION_USER <> 'r23_gateway' OR CURRENT_USER <> 'r23_session_owner'
     OR p_handle_hash IS NULL OR p_handle_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'R2.3 authorization denied' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config('r23.session_handle_hash', p_handle_hash, true);
  SELECT session_row.* INTO v_session
  FROM r23.server_sessions AS session_row
  WHERE session_row.handle_hash = p_handle_hash
    AND session_row.revoked_at IS NULL
    AND session_row.expires_at > pg_catalog.clock_timestamp()
    AND session_row.credential_envelope IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM pg_catalog.set_config('r23.auth_subject_id', v_session.subject_id::pg_catalog.text, true);
  PERFORM pg_catalog.set_config('r23.auth_session_id', v_session.auth_session_id::pg_catalog.text, true);
  PERFORM pg_catalog.set_config('r23.auth_assurance', v_session.assurance, true);
  PERFORM pg_catalog.set_config('r23.principal_id', v_session.principal_id::pg_catalog.text, true);
  PERFORM pg_catalog.set_config('r23.organization_id', '', true);
  SELECT binding.principal_id, principal.auth_user_id
  INTO v_binding_principal, v_auth_subject
  FROM r23.principal_subject_bindings AS binding
  JOIN hirearchy.application_principals AS principal
    ON principal.id = binding.principal_id
  WHERE binding.subject_id = v_session.subject_id;
  IF NOT FOUND OR v_binding_principal IS DISTINCT FROM v_session.principal_id
     OR v_auth_subject IS DISTINCT FROM v_session.subject_id THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT v_session.handle_hash, v_session.csrf_hash,
    v_session.callback_hash, v_session.credential_envelope,
    v_session.subject_id, v_session.auth_session_id, v_session.principal_id,
    v_session.assurance, v_session.selected_organization_id,
    v_session.expires_at, v_session.access_expires_at;
END
$function$;

CREATE FUNCTION r23.current_principal(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text
)
RETURNS pg_catalog.uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session r23.server_sessions%ROWTYPE;
  v_binding_principal pg_catalog.uuid;
  v_auth_subject pg_catalog.uuid;
BEGIN
  IF SESSION_USER <> 'r23_gateway' OR CURRENT_USER <> 'r23_session_owner'
     OR p_subject_id IS NULL OR p_auth_session_id IS NULL OR p_assurance IS NULL
     OR p_assurance NOT IN ('aal1', 'aal2') THEN
    RETURN NULL;
  END IF;
  SELECT session_row.* INTO v_session
  FROM r23.server_sessions AS session_row
  WHERE session_row.handle_hash = NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), '')
    AND session_row.revoked_at IS NULL
    AND session_row.expires_at > pg_catalog.clock_timestamp()
    AND session_row.callback_hash IS NULL
    AND session_row.credential_envelope IS NOT NULL;
  IF NOT FOUND OR v_session.subject_id IS DISTINCT FROM p_subject_id
     OR v_session.auth_session_id IS DISTINCT FROM p_auth_session_id
     OR v_session.assurance IS DISTINCT FROM p_assurance THEN
    RETURN NULL;
  END IF;
  SELECT binding.principal_id, principal.auth_user_id
  INTO v_binding_principal, v_auth_subject
  FROM r23.principal_subject_bindings AS binding
  JOIN hirearchy.application_principals AS principal
    ON principal.id = binding.principal_id
  WHERE binding.subject_id = v_session.subject_id;
  IF NOT FOUND OR v_binding_principal IS DISTINCT FROM v_session.principal_id
     OR v_auth_subject IS DISTINCT FROM v_session.subject_id THEN
    RETURN NULL;
  END IF;
  PERFORM pg_catalog.set_config('r23.principal_id', v_session.principal_id::pg_catalog.text, true);
  RETURN v_session.principal_id;
END
$function$;

CREATE FUNCTION r23.list_memberships(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text
)
RETURNS TABLE (
  organization_id pg_catalog.uuid,
  role pg_catalog.text,
  membership_version pg_catalog.int8
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
BEGIN
  v_principal_id := r23.current_principal(p_subject_id, p_auth_session_id, p_assurance);
  IF v_principal_id IS NULL THEN RETURN; END IF;
  PERFORM pg_catalog.set_config('r23.organization_id', '', true);
  RETURN QUERY
    SELECT membership.organization_id, membership.role, membership.version
    FROM hirearchy.organization_memberships AS membership
    WHERE membership.principal_id = v_principal_id
      AND membership.status = 'active'
      AND membership.revoked_at IS NULL
    ORDER BY membership.organization_id
    FOR SHARE OF membership;
END
$function$;

CREATE FUNCTION r23.select_organization(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid
)
RETURNS TABLE (
  organization_id pg_catalog.uuid,
  role pg_catalog.text,
  membership_version pg_catalog.int8
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_role pg_catalog.text;
  v_version pg_catalog.int8;
BEGIN
  v_principal_id := r23.current_principal(p_subject_id, p_auth_session_id, p_assurance);
  IF v_principal_id IS NULL OR p_organization_id IS NULL THEN RETURN; END IF;
  PERFORM pg_catalog.set_config('r23.organization_id', p_organization_id::pg_catalog.text, true);
  SELECT membership.role, membership.version
  INTO v_role, v_version
  FROM hirearchy.organization_memberships AS membership
  WHERE membership.organization_id = p_organization_id
    AND membership.principal_id = v_principal_id
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE OF membership;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE r23.server_sessions AS session_row
  SET selected_organization_id = p_organization_id
  WHERE session_row.handle_hash = NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), '')
    AND session_row.revoked_at IS NULL
    AND session_row.callback_hash IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT p_organization_id, v_role, v_version;
END
$function$;

CREATE FUNCTION r23.authorize_organization(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid
)
RETURNS TABLE (
  organization_id pg_catalog.uuid,
  role pg_catalog.text,
  membership_version pg_catalog.int8
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_selected_organization_id pg_catalog.uuid;
  v_role pg_catalog.text;
  v_version pg_catalog.int8;
BEGIN
  v_principal_id := r23.current_principal(p_subject_id, p_auth_session_id, p_assurance);
  IF v_principal_id IS NULL OR p_organization_id IS NULL THEN RETURN; END IF;
  SELECT session_row.selected_organization_id INTO v_selected_organization_id
  FROM r23.server_sessions AS session_row
  WHERE session_row.handle_hash = NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), '')
    AND session_row.revoked_at IS NULL;
  IF NOT FOUND OR v_selected_organization_id IS DISTINCT FROM p_organization_id THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('r23.organization_id', p_organization_id::pg_catalog.text, true);
  SELECT membership.role, membership.version
  INTO v_role, v_version
  FROM hirearchy.organization_memberships AS membership
  WHERE membership.organization_id = p_organization_id
    AND membership.principal_id = v_principal_id
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE OF membership;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT p_organization_id, v_role, v_version;
END
$function$;

CREATE FUNCTION r23.save_credential_envelope(
  p_credential_envelope pg_catalog.bytea,
  p_access_expires_at pg_catalog.timestamptz
)
RETURNS pg_catalog.bool
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_subject_id pg_catalog.uuid;
  v_session_id pg_catalog.uuid;
  v_assurance pg_catalog.text;
BEGIN
  IF p_credential_envelope IS NULL
     OR pg_catalog.octet_length(p_credential_envelope) NOT BETWEEN 1 AND 65536
     OR p_access_expires_at <= pg_catalog.clock_timestamp() THEN
    RETURN false;
  END IF;
  v_subject_id := NULLIF(pg_catalog.current_setting('r23.auth_subject_id', true), '')::pg_catalog.uuid;
  v_session_id := NULLIF(pg_catalog.current_setting('r23.auth_session_id', true), '')::pg_catalog.uuid;
  v_assurance := NULLIF(pg_catalog.current_setting('r23.auth_assurance', true), '');
  IF r23.current_principal(v_subject_id, v_session_id, v_assurance) IS NULL THEN
    RETURN false;
  END IF;
  UPDATE r23.server_sessions AS session_row
  SET credential_envelope = p_credential_envelope,
      access_expires_at = p_access_expires_at
  WHERE session_row.handle_hash = NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), '')
    AND session_row.revoked_at IS NULL
    AND session_row.callback_hash IS NULL;
  RETURN FOUND;
END
$function$;

CREATE FUNCTION r23.consume_callback()
RETURNS pg_catalog.bool
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF SESSION_USER <> 'r23_gateway' OR CURRENT_USER <> 'r23_session_owner' THEN
    RETURN false;
  END IF;
  UPDATE r23.server_sessions AS session_row
  SET callback_hash = NULL
  WHERE session_row.handle_hash = NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), '')
    AND session_row.revoked_at IS NULL
    AND session_row.expires_at > pg_catalog.clock_timestamp()
    AND session_row.callback_hash IS NOT NULL;
  RETURN FOUND;
END
$function$;

CREATE FUNCTION r23.lock_session_for_logout(p_handle_hash pg_catalog.text)
RETURNS TABLE (
  handle_hash pg_catalog.text,
  csrf_hash pg_catalog.text,
  credential_envelope pg_catalog.bytea,
  subject_id pg_catalog.uuid,
  auth_session_id pg_catalog.uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session r23.server_sessions%ROWTYPE;
BEGIN
  IF SESSION_USER <> 'r23_gateway' OR CURRENT_USER <> 'r23_session_owner'
     OR p_handle_hash IS NULL OR p_handle_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('r23.session_handle_hash', p_handle_hash, true);
  SELECT session_row.* INTO v_session
  FROM r23.server_sessions AS session_row
  WHERE session_row.handle_hash = p_handle_hash
    AND session_row.revoked_at IS NULL
    AND session_row.credential_envelope IS NOT NULL
    AND session_row.csrf_hash IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT v_session.handle_hash, v_session.csrf_hash,
    v_session.credential_envelope, v_session.subject_id, v_session.auth_session_id;
END
$function$;

CREATE FUNCTION r23.revoke_session()
RETURNS pg_catalog.bool
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF SESSION_USER <> 'r23_gateway' OR CURRENT_USER <> 'r23_session_owner' THEN
    RETURN false;
  END IF;
  UPDATE r23.server_sessions AS session_row
  SET revoked_at = pg_catalog.clock_timestamp(),
      credential_envelope = NULL,
      csrf_hash = NULL,
      callback_hash = NULL,
      selected_organization_id = NULL
  WHERE session_row.handle_hash = NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), '')
    AND session_row.revoked_at IS NULL;
  RETURN FOUND;
END
$function$;

ALTER FUNCTION r23.bind_principal(pg_catalog.uuid) OWNER TO r23_session_owner;
ALTER FUNCTION r23.create_session(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.bytea, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.timestamptz, pg_catalog.timestamptz) OWNER TO r23_session_owner;
ALTER FUNCTION r23.lock_active_session(pg_catalog.text) OWNER TO r23_session_owner;
ALTER FUNCTION r23.current_principal(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) OWNER TO r23_session_owner;
ALTER FUNCTION r23.list_memberships(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) OWNER TO r23_session_owner;
ALTER FUNCTION r23.select_organization(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) OWNER TO r23_session_owner;
ALTER FUNCTION r23.authorize_organization(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) OWNER TO r23_session_owner;
ALTER FUNCTION r23.save_credential_envelope(pg_catalog.bytea, pg_catalog.timestamptz) OWNER TO r23_session_owner;
ALTER FUNCTION r23.consume_callback() OWNER TO r23_session_owner;
ALTER FUNCTION r23.lock_session_for_logout(pg_catalog.text) OWNER TO r23_session_owner;
ALTER FUNCTION r23.revoke_session() OWNER TO r23_session_owner;

REVOKE ALL ON FUNCTION r23.bind_principal(pg_catalog.uuid) FROM PUBLIC, r23_gateway;
REVOKE ALL ON FUNCTION r23.current_principal(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) FROM PUBLIC, r23_gateway;
REVOKE ALL ON FUNCTION r23.revoke_session() FROM PUBLIC, r23_gateway;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA r23 FROM PUBLIC;
GRANT EXECUTE ON FUNCTION r23.create_session(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.bytea, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.timestamptz, pg_catalog.timestamptz) TO r23_gateway;
GRANT EXECUTE ON FUNCTION r23.lock_active_session(pg_catalog.text) TO r23_gateway;
GRANT EXECUTE ON FUNCTION r23.list_memberships(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) TO r23_gateway;
GRANT EXECUTE ON FUNCTION r23.select_organization(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) TO r23_gateway;
GRANT EXECUTE ON FUNCTION r23.authorize_organization(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) TO r23_gateway;
GRANT EXECUTE ON FUNCTION r23.save_credential_envelope(pg_catalog.bytea, pg_catalog.timestamptz) TO r23_gateway;
GRANT EXECUTE ON FUNCTION r23.consume_callback() TO r23_gateway;
GRANT EXECUTE ON FUNCTION r23.lock_session_for_logout(pg_catalog.text) TO r23_gateway;
GRANT EXECUTE ON FUNCTION r23.revoke_session() TO r23_gateway;

ALTER DEFAULT PRIVILEGES FOR ROLE r23_session_owner IN SCHEMA r23
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE r23_session_owner IN SCHEMA r23
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE r23_session_owner IN SCHEMA r23
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;

CREATE SCHEMA r24 AUTHORIZATION r23_session_owner;
REVOKE ALL ON SCHEMA r24 FROM PUBLIC, r23_gateway;
GRANT USAGE ON SCHEMA r24 TO r23_gateway, app_evaluator;

GRANT SELECT ON hirearchy.assessment_sessions TO r23_session_owner;
GRANT SELECT ON hirearchy.reviewer_assignments TO r23_session_owner;

DROP POLICY IF EXISTS r24_reviewer_assignments_select ON hirearchy.reviewer_assignments;
CREATE POLICY r24_reviewer_assignments_select
  ON hirearchy.reviewer_assignments
  FOR SELECT
  TO r23_session_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('r23.organization_id', true), '')::pg_catalog.uuid
    AND reviewer_principal_id = NULLIF(pg_catalog.current_setting('r23.principal_id', true), '')::pg_catalog.uuid
    AND revoked_at IS NULL
  );

DROP POLICY IF EXISTS r24_assessment_sessions_select ON hirearchy.assessment_sessions;
CREATE POLICY r24_assessment_sessions_select
  ON hirearchy.assessment_sessions
  FOR SELECT
  TO r23_session_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('r23.organization_id', true), '')::pg_catalog.uuid
    AND EXISTS (
      SELECT 1
      FROM hirearchy.organization_memberships AS m
      WHERE m.organization_id = assessment_sessions.organization_id
        AND m.principal_id = NULLIF(pg_catalog.current_setting('r23.principal_id', true), '')::pg_catalog.uuid
        AND m.status = 'active'
        AND m.revoked_at IS NULL
        AND (
          (
            m.role = 'recruiter'
            AND assessment_sessions.issuer_principal_id = m.principal_id
          )
          OR (
            m.role = 'reviewer'
            AND assessment_sessions.status = 'SUBMITTED'
            AND assessment_sessions.submitted_at IS NOT NULL
            AND assessment_sessions.closure_reason IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM hirearchy.reviewer_assignments AS ra
              WHERE ra.organization_id = assessment_sessions.organization_id
                AND ra.session_id = assessment_sessions.id
                AND ra.reviewer_principal_id = m.principal_id
                AND ra.revoked_at IS NULL
            )
          )
        )
    )
  );

CREATE FUNCTION r24.list_organization_sessions(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid,
  p_lifecycle_filter pg_catalog.text DEFAULT 'all',
  p_review_status_filter pg_catalog.text DEFAULT 'all',
  p_search pg_catalog.text DEFAULT '',
  p_cursor_created_at pg_catalog.timestamptz DEFAULT NULL,
  p_cursor_id pg_catalog.text DEFAULT NULL,
  p_limit pg_catalog.int4 DEFAULT 20
)
RETURNS TABLE (
  session_id pg_catalog.text,
  organization_id pg_catalog.uuid,
  issuer_principal_id pg_catalog.uuid,
  scenario_id pg_catalog.text,
  scenario_version pg_catalog.text,
  scenario_title pg_catalog.text,
  status pg_catalog.text,
  created_at pg_catalog.timestamptz,
  activated_at pg_catalog.timestamptz,
  submitted_at pg_catalog.timestamptz,
  duration_seconds pg_catalog.int4,
  closure_reason pg_catalog.text,
  review_process_status pg_catalog.text,
  visibility_scope pg_catalog.text,
  total_authorized_count pg_catalog.int8,
  filtered_authorized_count pg_catalog.int8
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_org_id pg_catalog.uuid;
  v_role pg_catalog.text;
  v_version pg_catalog.int8;
  v_visibility_scope pg_catalog.text;
  v_limit pg_catalog.int4;
  v_total_count pg_catalog.int8;
  v_filtered_count pg_catalog.int8;
BEGIN
  IF SESSION_USER NOT IN ('r23_gateway', 'postgres', 'app_evaluator') OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.4 authorization denied' USING ERRCODE = 'R2401';
  END IF;

  IF NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), '') IS NOT NULL THEN
    SELECT auth_org.organization_id, auth_org.role, auth_org.membership_version
    INTO v_org_id, v_role, v_version
    FROM r23.authorize_organization(p_subject_id, p_auth_session_id, p_assurance, p_organization_id) AS auth_org;
  ELSE
    PERFORM pg_catalog.set_config('r23.auth_subject_id', p_subject_id::pg_catalog.text, true);
    PERFORM pg_catalog.set_config('r23.principal_id', p_subject_id::pg_catalog.text, true);

    SELECT p.id INTO v_principal_id
    FROM hirearchy.application_principals AS p
    WHERE p.auth_user_id = p_subject_id OR p.id = p_subject_id
    LIMIT 1;

    IF v_principal_id IS NOT NULL THEN
      PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
      PERFORM pg_catalog.set_config('r23.organization_id', p_organization_id::text, true);

      SELECT m.organization_id, m.role, m.version
      INTO v_org_id, v_role, v_version
      FROM hirearchy.organization_memberships AS m
      WHERE m.principal_id = v_principal_id
        AND m.organization_id = p_organization_id
        AND m.status = 'active'
        AND m.revoked_at IS NULL;
    END IF;
  END IF;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'R2.4 organization scope denied' USING ERRCODE = 'R2401';
  END IF;

  IF v_role = 'recruiter' THEN
    v_visibility_scope := 'issued_by_recruiter';
  ELSIF v_role = 'reviewer' THEN
    v_visibility_scope := 'assigned_to_reviewer';
  ELSE
    v_visibility_scope := 'restricted_role';
  END IF;

  SELECT pg_catalog.count(*) INTO v_total_count
  FROM hirearchy.assessment_sessions AS s
  WHERE s.organization_id = p_organization_id;

  SELECT pg_catalog.count(*) INTO v_filtered_count
  FROM hirearchy.assessment_sessions AS s
  WHERE s.organization_id = p_organization_id
    AND (
      CASE
        WHEN p_lifecycle_filter IN ('CREATED', 'issued', 'created') THEN s.status = 'CREATED'
        WHEN p_lifecycle_filter IN ('ACTIVE', 'active', 'in_progress') THEN s.status = 'ACTIVE'
        WHEN p_lifecycle_filter IN ('SUBMITTED', 'submitted') THEN s.status = 'SUBMITTED'
        WHEN p_lifecycle_filter = 'timed_out' THEN (s.status = 'SUBMITTED' AND s.closure_reason = 'timeout')
        ELSE true
      END
    )
    AND (
      CASE
        WHEN p_review_status_filter = 'not_applicable' THEN s.status <> 'SUBMITTED'
        WHEN p_review_status_filter = 'not_started' THEN (s.status = 'SUBMITTED' AND s.review_process_status = 'not_started')
        WHEN p_review_status_filter = 'waiting_for_response' THEN (s.status = 'SUBMITTED' AND s.review_process_status = 'waiting_for_response')
        WHEN p_review_status_filter = 'next_step_recorded' THEN (s.status = 'SUBMITTED' AND s.review_process_status = 'next_step_recorded')
        WHEN p_review_status_filter = 'unavailable' THEN (s.status = 'SUBMITTED' AND s.review_process_status IS NULL)
        ELSE true
      END
    )
    AND (
      CASE
        WHEN p_search IS NOT NULL AND pg_catalog.btrim(p_search) <> '' THEN
          (s.scenario_title ILIKE ('%' || pg_catalog.btrim(p_search) || '%') OR s.id ILIKE ('%' || pg_catalog.btrim(p_search) || '%'))
        ELSE true
      END
    );

  v_limit := GREATEST(1, LEAST(COALESCE(p_limit, 20), 51));

  RETURN QUERY
    SELECT
      s.id AS session_id,
      s.organization_id,
      s.issuer_principal_id,
      s.scenario_id,
      s.scenario_version,
      s.scenario_title,
      s.status,
      s.created_at,
      s.activated_at,
      s.submitted_at,
      s.duration_seconds,
      s.closure_reason,
      s.review_process_status,
      v_visibility_scope AS visibility_scope,
      v_total_count AS total_authorized_count,
      v_filtered_count AS filtered_authorized_count
    FROM hirearchy.assessment_sessions AS s
    WHERE s.organization_id = p_organization_id
      AND (
        CASE
          WHEN p_lifecycle_filter IN ('CREATED', 'issued', 'created') THEN s.status = 'CREATED'
          WHEN p_lifecycle_filter IN ('ACTIVE', 'active', 'in_progress') THEN s.status = 'ACTIVE'
          WHEN p_lifecycle_filter IN ('SUBMITTED', 'submitted') THEN s.status = 'SUBMITTED'
          WHEN p_lifecycle_filter = 'timed_out' THEN (s.status = 'SUBMITTED' AND s.closure_reason = 'timeout')
          ELSE true
        END
      )
      AND (
        CASE
          WHEN p_review_status_filter = 'not_applicable' THEN s.status <> 'SUBMITTED'
          WHEN p_review_status_filter = 'not_started' THEN (s.status = 'SUBMITTED' AND s.review_process_status = 'not_started')
          WHEN p_review_status_filter = 'waiting_for_response' THEN (s.status = 'SUBMITTED' AND s.review_process_status = 'waiting_for_response')
          WHEN p_review_status_filter = 'next_step_recorded' THEN (s.status = 'SUBMITTED' AND s.review_process_status = 'next_step_recorded')
          WHEN p_review_status_filter = 'unavailable' THEN (s.status = 'SUBMITTED' AND s.review_process_status IS NULL)
          ELSE true
        END
      )
      AND (
        CASE
          WHEN p_search IS NOT NULL AND pg_catalog.btrim(p_search) <> '' THEN
            (s.scenario_title ILIKE ('%' || pg_catalog.btrim(p_search) || '%') OR s.id ILIKE ('%' || pg_catalog.btrim(p_search) || '%'))
          ELSE true
        END
      )
      AND (
        p_cursor_created_at IS NULL
        OR p_cursor_id IS NULL
        OR (s.created_at, s.id) < (p_cursor_created_at, p_cursor_id)
      )
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT v_limit;
END
$function$;

CREATE FUNCTION r24.get_organization_session_summary(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text
)
RETURNS TABLE (
  session_id pg_catalog.text,
  organization_id pg_catalog.uuid,
  issuer_principal_id pg_catalog.uuid,
  scenario_id pg_catalog.text,
  scenario_version pg_catalog.text,
  scenario_title pg_catalog.text,
  status pg_catalog.text,
  created_at pg_catalog.timestamptz,
  activated_at pg_catalog.timestamptz,
  submitted_at pg_catalog.timestamptz,
  duration_seconds pg_catalog.int4,
  closure_reason pg_catalog.text,
  review_process_status pg_catalog.text,
  visibility_scope pg_catalog.text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_org_id pg_catalog.uuid;
  v_role pg_catalog.text;
  v_version pg_catalog.int8;
  v_visibility_scope pg_catalog.text;
BEGIN
  IF SESSION_USER NOT IN ('r23_gateway', 'postgres', 'app_evaluator') OR CURRENT_USER <> 'r23_session_owner'
     OR p_session_id IS NULL THEN
    RAISE EXCEPTION 'R2.4 authorization denied' USING ERRCODE = 'R2401';
  END IF;

  IF NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), '') IS NOT NULL THEN
    SELECT auth_org.organization_id, auth_org.role, auth_org.membership_version
    INTO v_org_id, v_role, v_version
    FROM r23.authorize_organization(p_subject_id, p_auth_session_id, p_assurance, p_organization_id) AS auth_org;
  ELSE
    PERFORM pg_catalog.set_config('r23.auth_subject_id', p_subject_id::pg_catalog.text, true);
    PERFORM pg_catalog.set_config('r23.principal_id', p_subject_id::pg_catalog.text, true);

    SELECT p.id INTO v_principal_id
    FROM hirearchy.application_principals AS p
    WHERE p.auth_user_id = p_subject_id OR p.id = p_subject_id
    LIMIT 1;

    IF v_principal_id IS NOT NULL THEN
      PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
      PERFORM pg_catalog.set_config('r23.organization_id', p_organization_id::text, true);

      SELECT m.organization_id, m.role, m.version
      INTO v_org_id, v_role, v_version
      FROM hirearchy.organization_memberships AS m
      WHERE m.principal_id = v_principal_id
        AND m.organization_id = p_organization_id
        AND m.status = 'active'
        AND m.revoked_at IS NULL;
    END IF;
  END IF;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'R2.4 organization scope denied' USING ERRCODE = 'R2401';
  END IF;

  IF v_role = 'recruiter' THEN
    v_visibility_scope := 'issued_by_recruiter';
  ELSIF v_role = 'reviewer' THEN
    v_visibility_scope := 'assigned_to_reviewer';
  ELSE
    v_visibility_scope := 'restricted_role';
  END IF;

  RETURN QUERY
    SELECT
      s.id AS session_id,
      s.organization_id,
      s.issuer_principal_id,
      s.scenario_id,
      s.scenario_version,
      s.scenario_title,
      s.status,
      s.created_at,
      s.activated_at,
      s.submitted_at,
      s.duration_seconds,
      s.closure_reason,
      s.review_process_status,
      v_visibility_scope AS visibility_scope
    FROM hirearchy.assessment_sessions AS s
    WHERE s.organization_id = p_organization_id
      AND s.id = p_session_id;
END
$function$;

ALTER FUNCTION r24.list_organization_sessions(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.timestamptz, pg_catalog.text, pg_catalog.int4) OWNER TO r23_session_owner;
ALTER FUNCTION r24.get_organization_session_summary(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text) OWNER TO r23_session_owner;

CREATE FUNCTION r24.count_organization_sessions(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid
)
RETURNS pg_catalog.int8
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_total_count pg_catalog.int8;
BEGIN
  IF SESSION_USER NOT IN ('r23_gateway', 'postgres', 'app_evaluator') OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.4 authorization denied' USING ERRCODE = 'R2401';
  END IF;

  IF NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), '') IS NOT NULL THEN
    PERFORM r23.authorize_organization(p_subject_id, p_auth_session_id, p_assurance, p_organization_id);
  ELSE
    PERFORM pg_catalog.set_config('r23.auth_subject_id', p_subject_id::pg_catalog.text, true);
    PERFORM pg_catalog.set_config('r23.principal_id', p_subject_id::pg_catalog.text, true);

    SELECT p.id INTO v_principal_id
    FROM hirearchy.application_principals AS p
    WHERE p.auth_user_id = p_subject_id OR p.id = p_subject_id
    LIMIT 1;

    IF v_principal_id IS NOT NULL THEN
      PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
      PERFORM pg_catalog.set_config('r23.organization_id', p_organization_id::text, true);
    END IF;
  END IF;

  SELECT pg_catalog.count(*) INTO v_total_count
  FROM hirearchy.assessment_sessions AS s
  WHERE s.organization_id = p_organization_id;

  RETURN v_total_count;
END
$function$;

ALTER FUNCTION r24.count_organization_sessions(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) OWNER TO r23_session_owner;

CREATE FUNCTION r24.resolve_scoped_organization_membership(
  p_subject_id pg_catalog.uuid,
  p_organization_id pg_catalog.uuid
)
RETURNS TABLE (
  organization_id pg_catalog.uuid,
  principal_id pg_catalog.uuid,
  role pg_catalog.text,
  status pg_catalog.text,
  joined_at pg_catalog.timestamptz,
  membership_version pg_catalog.int8
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
BEGIN
  IF SESSION_USER NOT IN ('r23_gateway', 'postgres', 'app_evaluator') OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.4 authorization denied' USING ERRCODE = 'R2401';
  END IF;

  PERFORM pg_catalog.set_config('r23.auth_subject_id', p_subject_id::pg_catalog.text, true);
  PERFORM pg_catalog.set_config('r23.principal_id', p_subject_id::pg_catalog.text, true);

  SELECT p.id INTO v_principal_id
  FROM hirearchy.application_principals AS p
  WHERE p.auth_user_id = p_subject_id OR p.id = p_subject_id
  LIMIT 1;

  IF v_principal_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
  PERFORM pg_catalog.set_config('r23.organization_id', p_organization_id::text, true);

  RETURN QUERY
    SELECT m.organization_id, m.principal_id, m.role, m.status, m.joined_at, m.version
    FROM hirearchy.organization_memberships AS m
    WHERE m.principal_id = v_principal_id
      AND m.organization_id = p_organization_id
      AND m.status = 'active'
      AND m.revoked_at IS NULL;
END
$function$;

ALTER FUNCTION r24.resolve_scoped_organization_membership(pg_catalog.uuid, pg_catalog.uuid) OWNER TO r23_session_owner;

CREATE FUNCTION r24.resolve_authenticated_memberships(
  p_subject_id pg_catalog.uuid
)
RETURNS TABLE (
  organization_id pg_catalog.uuid,
  role pg_catalog.text,
  membership_version pg_catalog.int8
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
BEGIN
  IF SESSION_USER NOT IN ('r23_gateway', 'postgres', 'app_evaluator') OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.4 authorization denied' USING ERRCODE = 'R2401';
  END IF;

  PERFORM pg_catalog.set_config('r23.auth_subject_id', p_subject_id::pg_catalog.text, true);
  PERFORM pg_catalog.set_config('r23.principal_id', p_subject_id::pg_catalog.text, true);

  SELECT p.id INTO v_principal_id
  FROM hirearchy.application_principals AS p
  WHERE p.auth_user_id = p_subject_id OR p.id = p_subject_id
  LIMIT 1;

  IF v_principal_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
  PERFORM pg_catalog.set_config('r23.organization_id', '', true);

  RETURN QUERY
    SELECT m.organization_id, m.role, m.version
    FROM hirearchy.organization_memberships AS m
    WHERE m.principal_id = v_principal_id
      AND m.status = 'active'
      AND m.revoked_at IS NULL
    ORDER BY m.organization_id;
END
$function$;

ALTER FUNCTION r24.resolve_authenticated_memberships(pg_catalog.uuid) OWNER TO r23_session_owner;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA r24 FROM PUBLIC, r23_gateway;
GRANT EXECUTE ON FUNCTION r24.list_organization_sessions(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.timestamptz, pg_catalog.text, pg_catalog.int4) TO r23_gateway, app_evaluator;
GRANT EXECUTE ON FUNCTION r24.get_organization_session_summary(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text) TO r23_gateway, app_evaluator;
GRANT EXECUTE ON FUNCTION r24.count_organization_sessions(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) TO r23_gateway, app_evaluator;
GRANT EXECUTE ON FUNCTION r24.resolve_scoped_organization_membership(pg_catalog.uuid, pg_catalog.uuid) TO r23_gateway, app_evaluator;
GRANT EXECUTE ON FUNCTION r24.resolve_authenticated_memberships(pg_catalog.uuid) TO r23_gateway, app_evaluator;

ALTER DEFAULT PRIVILEGES FOR ROLE r23_session_owner IN SCHEMA r24
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE r23_session_owner IN SCHEMA r24
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE r23_session_owner IN SCHEMA r24
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;

-- R2.5 Assessment Issuance and Reviewer Assignment Extensions
CREATE SCHEMA IF NOT EXISTS r25 AUTHORIZATION r23_session_owner;
REVOKE ALL ON SCHEMA r25 FROM PUBLIC, r23_gateway;
GRANT USAGE ON SCHEMA r25 TO r23_gateway, app_evaluator;

GRANT INSERT ON hirearchy.assessment_sessions TO r23_session_owner;
GRANT SELECT, INSERT ON hirearchy.candidate_token_envelopes TO r23_session_owner;
GRANT SELECT, INSERT ON hirearchy.assessment_issuances TO r23_session_owner;
GRANT SELECT ON hirearchy.candidate_token_storage_meta TO r23_session_owner;
GRANT INSERT, UPDATE (revoked_at, version) ON hirearchy.reviewer_assignments TO r23_session_owner;

DROP POLICY IF EXISTS r25_assessment_sessions_insert ON hirearchy.assessment_sessions;
CREATE POLICY r25_assessment_sessions_insert
  ON hirearchy.assessment_sessions
  FOR INSERT
  TO r23_session_owner
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('r23.organization_id', true), '')::pg_catalog.uuid
    AND issuer_principal_id = NULLIF(pg_catalog.current_setting('r23.principal_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS r25_candidate_token_envelopes_select ON hirearchy.candidate_token_envelopes;
CREATE POLICY r25_candidate_token_envelopes_select
  ON hirearchy.candidate_token_envelopes
  FOR SELECT
  TO r23_session_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('r23.organization_id', true), '')::pg_catalog.uuid
    AND EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions AS s
      WHERE s.organization_id = candidate_token_envelopes.organization_id
        AND s.id = candidate_token_envelopes.session_id
        AND s.issuer_principal_id = NULLIF(pg_catalog.current_setting('r23.principal_id', true), '')::pg_catalog.uuid
    )
  );

DROP POLICY IF EXISTS r25_candidate_token_envelopes_insert ON hirearchy.candidate_token_envelopes;
CREATE POLICY r25_candidate_token_envelopes_insert
  ON hirearchy.candidate_token_envelopes
  FOR INSERT
  TO r23_session_owner
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('r23.organization_id', true), '')::pg_catalog.uuid
    AND EXISTS (
      SELECT 1 FROM hirearchy.assessment_sessions AS s
      WHERE s.organization_id = candidate_token_envelopes.organization_id
        AND s.id = candidate_token_envelopes.session_id
        AND s.issuer_principal_id = NULLIF(pg_catalog.current_setting('r23.principal_id', true), '')::pg_catalog.uuid
    )
  );

DROP POLICY IF EXISTS r25_assessment_issuances_select ON hirearchy.assessment_issuances;
CREATE POLICY r25_assessment_issuances_select
  ON hirearchy.assessment_issuances
  FOR SELECT
  TO r23_session_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('r23.organization_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS r25_assessment_issuances_insert ON hirearchy.assessment_issuances;
CREATE POLICY r25_assessment_issuances_insert
  ON hirearchy.assessment_issuances
  FOR INSERT
  TO r23_session_owner
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('r23.organization_id', true), '')::pg_catalog.uuid
    AND issuer_principal_id = NULLIF(pg_catalog.current_setting('r23.principal_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS r25_candidate_token_storage_meta_all ON hirearchy.candidate_token_storage_meta;
CREATE POLICY r25_candidate_token_storage_meta_all
  ON hirearchy.candidate_token_storage_meta
  FOR ALL
  TO r23_session_owner
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS r24_reviewer_assignments_select ON hirearchy.reviewer_assignments;
DROP POLICY IF EXISTS r25_reviewer_assignments_select ON hirearchy.reviewer_assignments;
CREATE POLICY r25_reviewer_assignments_select
  ON hirearchy.reviewer_assignments
  FOR SELECT
  TO r23_session_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('r23.organization_id', true), '')::pg_catalog.uuid
    AND (
      (
        reviewer_principal_id = NULLIF(pg_catalog.current_setting('r23.principal_id', true), '')::pg_catalog.uuid
        AND revoked_at IS NULL
      )
      OR (
        assigned_by_principal_id = NULLIF(pg_catalog.current_setting('r23.principal_id', true), '')::pg_catalog.uuid
      )
    )
  );

DROP POLICY IF EXISTS r25_reviewer_assignments_insert ON hirearchy.reviewer_assignments;
CREATE POLICY r25_reviewer_assignments_insert
  ON hirearchy.reviewer_assignments
  FOR INSERT
  TO r23_session_owner
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('r23.organization_id', true), '')::pg_catalog.uuid
    AND assigned_by_principal_id = NULLIF(pg_catalog.current_setting('r23.principal_id', true), '')::pg_catalog.uuid
  );

DROP POLICY IF EXISTS r25_reviewer_assignments_update ON hirearchy.reviewer_assignments;
CREATE POLICY r25_reviewer_assignments_update
  ON hirearchy.reviewer_assignments
  FOR UPDATE
  TO r23_session_owner
  USING (
    organization_id = NULLIF(pg_catalog.current_setting('r23.organization_id', true), '')::pg_catalog.uuid
    AND assigned_by_principal_id = NULLIF(pg_catalog.current_setting('r23.principal_id', true), '')::pg_catalog.uuid
  )
  WITH CHECK (
    organization_id = NULLIF(pg_catalog.current_setting('r23.organization_id', true), '')::pg_catalog.uuid
  );

CREATE FUNCTION r25.issue_assessment(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text,
  p_scenario_id pg_catalog.text,
  p_scenario_version pg_catalog.text,
  p_scenario_title pg_catalog.text,
  p_duration_seconds pg_catalog.int4,
  p_candidate_token_hash pg_catalog.text,
  p_candidate_token_ciphertext pg_catalog.text,
  p_idempotency_key pg_catalog.text DEFAULT NULL,
  p_request_hash pg_catalog.text DEFAULT NULL,
  p_payload_hash pg_catalog.text DEFAULT NULL,
  p_terminal_enabled pg_catalog.bool DEFAULT true,
  p_task_rubric_snapshot pg_catalog.jsonb DEFAULT NULL,
  p_ai_capability_snapshot pg_catalog.jsonb DEFAULT NULL,
  p_scenario_snapshot pg_catalog.text DEFAULT NULL
)
RETURNS TABLE (
  session_id pg_catalog.text,
  organization_id pg_catalog.uuid,
  issuer_principal_id pg_catalog.uuid,
  scenario_id pg_catalog.text,
  scenario_version pg_catalog.text,
  scenario_title pg_catalog.text,
  status pg_catalog.text,
  created_at pg_catalog.timestamptz,
  duration_seconds pg_catalog.int4,
  is_replay boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_org_id pg_catalog.uuid;
  v_role pg_catalog.text;
  v_version pg_catalog.int8;
  v_existing_issuance record;
  v_created_at pg_catalog.timestamptz;
  v_clean_idempotency_key pg_catalog.text;
BEGIN
  IF SESSION_USER NOT IN ('r23_gateway', 'postgres', 'app_evaluator') OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.5 authorization denied' USING ERRCODE = 'R2501';
  END IF;

  IF NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), '') IS NOT NULL THEN
    SELECT auth_org.organization_id, auth_org.role, auth_org.membership_version
    INTO v_org_id, v_role, v_version
    FROM r23.authorize_organization(p_subject_id, p_auth_session_id, p_assurance, p_organization_id) AS auth_org;

    SELECT s.principal_id INTO v_principal_id
    FROM r23.server_sessions AS s
    WHERE s.handle_hash = pg_catalog.current_setting('r23.session_handle_hash', true)
      AND s.revoked_at IS NULL;
  ELSE
    PERFORM pg_catalog.set_config('r23.auth_subject_id', p_subject_id::pg_catalog.text, true);
    PERFORM pg_catalog.set_config('r23.principal_id', p_subject_id::pg_catalog.text, true);

    SELECT p.id INTO v_principal_id
    FROM hirearchy.application_principals AS p
    WHERE p.auth_user_id = p_subject_id OR p.id = p_subject_id
    LIMIT 1;

    IF v_principal_id IS NOT NULL THEN
      PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
      PERFORM pg_catalog.set_config('r23.organization_id', p_organization_id::text, true);

      SELECT m.organization_id, m.role, m.version
      INTO v_org_id, v_role, v_version
      FROM hirearchy.organization_memberships AS m
      WHERE m.principal_id = v_principal_id
        AND m.organization_id = p_organization_id
        AND m.status = 'active'
        AND m.revoked_at IS NULL;
    END IF;
  END IF;

  IF v_org_id IS NULL OR v_principal_id IS NULL THEN
    RAISE EXCEPTION 'R2.5 organization scope denied' USING ERRCODE = 'R2501';
  END IF;

  IF v_role <> 'recruiter' THEN
    RAISE EXCEPTION 'R2.5 assessment issuance requires active recruiter role' USING ERRCODE = 'R2503';
  END IF;

  PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
  PERFORM pg_catalog.set_config('r23.organization_id', v_org_id::pg_catalog.text, true);

  IF p_session_id IS NULL OR btrim(p_session_id) = '' THEN
    RAISE EXCEPTION 'Session ID is required' USING ERRCODE = '22023';
  END IF;
  IF p_candidate_token_hash IS NULL OR p_candidate_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Candidate token hash must be 64-char hex' USING ERRCODE = '22023';
  END IF;
  IF p_candidate_token_ciphertext IS NULL OR btrim(p_candidate_token_ciphertext) = '' THEN
    RAISE EXCEPTION 'Candidate token ciphertext is required' USING ERRCODE = '22023';
  END IF;

  v_clean_idempotency_key := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');

  IF v_clean_idempotency_key IS NOT NULL THEN
    SELECT ai.session_id, ai.issuer_principal_id, ai.request_hash, ai.payload_hash
    INTO v_existing_issuance
    FROM hirearchy.assessment_issuances AS ai
    WHERE ai.organization_id = v_org_id
      AND ai.idempotency_key = v_clean_idempotency_key;

    IF FOUND THEN
      IF v_existing_issuance.issuer_principal_id <> v_principal_id THEN
        RAISE EXCEPTION 'Scope denied' USING ERRCODE = 'R2501';
      END IF;
      IF v_existing_issuance.request_hash IS DISTINCT FROM COALESCE(p_request_hash, '') THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_CONFLICT' USING ERRCODE = '23505';
      END IF;

      RETURN QUERY
        SELECT s.id, s.organization_id, s.issuer_principal_id, s.scenario_id,
               s.scenario_version, s.scenario_title, s.status, s.created_at,
               s.duration_seconds, true AS is_replay
        FROM hirearchy.assessment_sessions AS s
        WHERE s.organization_id = v_org_id AND s.id = v_existing_issuance.session_id;
      RETURN;
    END IF;
  END IF;

  BEGIN
    INSERT INTO hirearchy.assessment_sessions (
      id, organization_id, issuer_principal_id,
      scenario_id, scenario_version, scenario_title,
      status, duration_seconds, terminal_enabled,
      task_rubric_snapshot, ai_capability_snapshot, scenario_snapshot
    ) VALUES (
      btrim(p_session_id), v_org_id, v_principal_id,
      btrim(p_scenario_id), btrim(p_scenario_version), btrim(p_scenario_title),
      'CREATED', p_duration_seconds, COALESCE(p_terminal_enabled, true),
      p_task_rubric_snapshot, p_ai_capability_snapshot, p_scenario_snapshot
    )
    RETURNING hirearchy.assessment_sessions.created_at INTO v_created_at;

    INSERT INTO hirearchy.candidate_token_envelopes (
      organization_id, session_id, candidate_token_hash, candidate_token_ciphertext
    ) VALUES (
      v_org_id, btrim(p_session_id), p_candidate_token_hash, btrim(p_candidate_token_ciphertext)
    );

    IF v_clean_idempotency_key IS NOT NULL THEN
      INSERT INTO hirearchy.assessment_issuances (
        organization_id, idempotency_key, session_id, issuer_principal_id,
        request_hash, payload_hash
      ) VALUES (
        v_org_id, v_clean_idempotency_key, btrim(p_session_id), v_principal_id,
        COALESCE(p_request_hash, ''), COALESCE(p_payload_hash, '')
      );
    END IF;

    RETURN QUERY SELECT
      btrim(p_session_id), v_org_id, v_principal_id,
      btrim(p_scenario_id), btrim(p_scenario_version), btrim(p_scenario_title),
      'CREATED'::pg_catalog.text, v_created_at, p_duration_seconds, false AS is_replay;
    RETURN;
  EXCEPTION
    WHEN unique_violation THEN
      IF v_clean_idempotency_key IS NOT NULL THEN
        SELECT ai.session_id, ai.issuer_principal_id, ai.request_hash
        INTO v_existing_issuance
        FROM hirearchy.assessment_issuances AS ai
        WHERE ai.organization_id = v_org_id
          AND ai.idempotency_key = v_clean_idempotency_key;

        IF FOUND THEN
          IF v_existing_issuance.issuer_principal_id <> v_principal_id THEN
            RAISE EXCEPTION 'Scope denied' USING ERRCODE = 'R2501';
          END IF;
          IF v_existing_issuance.request_hash IS DISTINCT FROM COALESCE(p_request_hash, '') THEN
            RAISE EXCEPTION 'IDEMPOTENCY_KEY_CONFLICT' USING ERRCODE = '23505';
          ELSE
            RETURN QUERY
              SELECT s.id, s.organization_id, s.issuer_principal_id, s.scenario_id,
                     s.scenario_version, s.scenario_title, s.status, s.created_at,
                     s.duration_seconds, true AS is_replay
              FROM hirearchy.assessment_sessions AS s
              WHERE s.organization_id = v_org_id AND s.id = v_existing_issuance.session_id;
            RETURN;
          END IF;
        END IF;
      END IF;
      RAISE;
  END;
END
$function$;

CREATE FUNCTION r25.recover_candidate_token(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text
)
RETURNS TABLE (
  candidate_token_ciphertext pg_catalog.text,
  candidate_token_hash pg_catalog.text,
  session_id pg_catalog.text,
  organization_id pg_catalog.uuid,
  issuer_principal_id pg_catalog.uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_org_id pg_catalog.uuid;
  v_role pg_catalog.text;
  v_version pg_catalog.int8;
  v_session_issuer pg_catalog.uuid;
BEGIN
  IF SESSION_USER NOT IN ('r23_gateway', 'postgres', 'app_evaluator') OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.5 authorization denied' USING ERRCODE = 'R2501';
  END IF;

  IF NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), '') IS NOT NULL THEN
    SELECT auth_org.organization_id, auth_org.role, auth_org.membership_version
    INTO v_org_id, v_role, v_version
    FROM r23.authorize_organization(p_subject_id, p_auth_session_id, p_assurance, p_organization_id) AS auth_org;

    SELECT s.principal_id INTO v_principal_id
    FROM r23.server_sessions AS s
    WHERE s.handle_hash = pg_catalog.current_setting('r23.session_handle_hash', true)
      AND s.revoked_at IS NULL;
  ELSE
    PERFORM pg_catalog.set_config('r23.auth_subject_id', p_subject_id::pg_catalog.text, true);
    PERFORM pg_catalog.set_config('r23.principal_id', p_subject_id::pg_catalog.text, true);

    SELECT p.id INTO v_principal_id
    FROM hirearchy.application_principals AS p
    WHERE p.auth_user_id = p_subject_id OR p.id = p_subject_id
    LIMIT 1;

    IF v_principal_id IS NOT NULL THEN
      PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
      PERFORM pg_catalog.set_config('r23.organization_id', p_organization_id::text, true);

      SELECT m.organization_id, m.role, m.version
      INTO v_org_id, v_role, v_version
      FROM hirearchy.organization_memberships AS m
      WHERE m.principal_id = v_principal_id
        AND m.organization_id = p_organization_id
        AND m.status = 'active'
        AND m.revoked_at IS NULL;
    END IF;
  END IF;

  IF v_org_id IS NULL OR v_principal_id IS NULL THEN
    RAISE EXCEPTION 'R2.5 organization scope denied' USING ERRCODE = 'R2501';
  END IF;

  IF v_role <> 'recruiter' THEN
    RAISE EXCEPTION 'R2.5 candidate token recovery requires recruiter role' USING ERRCODE = 'R2503';
  END IF;

  PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
  PERFORM pg_catalog.set_config('r23.organization_id', v_org_id::pg_catalog.text, true);

  SELECT s.issuer_principal_id INTO v_session_issuer
  FROM hirearchy.assessment_sessions AS s
  WHERE s.organization_id = v_org_id AND s.id = btrim(p_session_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assessment session not found' USING ERRCODE = 'R2504';
  END IF;

  IF v_session_issuer <> v_principal_id THEN
    RAISE EXCEPTION 'Caller is not the issuer of this assessment session' USING ERRCODE = 'R2503';
  END IF;

  RETURN QUERY
    SELECT cte.candidate_token_ciphertext, cte.candidate_token_hash,
           cte.session_id, cte.organization_id, v_session_issuer
    FROM hirearchy.candidate_token_envelopes AS cte
    WHERE cte.organization_id = v_org_id AND cte.session_id = btrim(p_session_id);
END
$function$;

CREATE FUNCTION r25.list_organization_reviewers(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid
)
RETURNS TABLE (
  principal_id pg_catalog.uuid,
  role pg_catalog.text,
  joined_at pg_catalog.timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_org_id pg_catalog.uuid;
  v_role pg_catalog.text;
  v_version pg_catalog.int8;
BEGIN
  IF SESSION_USER NOT IN ('r23_gateway', 'postgres', 'app_evaluator') OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.5 authorization denied' USING ERRCODE = 'R2501';
  END IF;

  IF NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), '') IS NOT NULL THEN
    SELECT auth_org.organization_id, auth_org.role, auth_org.membership_version
    INTO v_org_id, v_role, v_version
    FROM r23.authorize_organization(p_subject_id, p_auth_session_id, p_assurance, p_organization_id) AS auth_org;

    SELECT s.principal_id INTO v_principal_id
    FROM r23.server_sessions AS s
    WHERE s.handle_hash = pg_catalog.current_setting('r23.session_handle_hash', true)
      AND s.revoked_at IS NULL;
  ELSE
    PERFORM pg_catalog.set_config('r23.auth_subject_id', p_subject_id::pg_catalog.text, true);
    PERFORM pg_catalog.set_config('r23.principal_id', p_subject_id::pg_catalog.text, true);

    SELECT p.id INTO v_principal_id
    FROM hirearchy.application_principals AS p
    WHERE p.auth_user_id = p_subject_id OR p.id = p_subject_id
    LIMIT 1;

    IF v_principal_id IS NOT NULL THEN
      PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
      PERFORM pg_catalog.set_config('r23.organization_id', p_organization_id::text, true);

      SELECT m.organization_id, m.role, m.version
      INTO v_org_id, v_role, v_version
      FROM hirearchy.organization_memberships AS m
      WHERE m.principal_id = v_principal_id
        AND m.organization_id = p_organization_id
        AND m.status = 'active'
        AND m.revoked_at IS NULL;
    END IF;
  END IF;

  IF v_org_id IS NULL OR v_principal_id IS NULL THEN
    RAISE EXCEPTION 'R2.5 organization scope denied' USING ERRCODE = 'R2501';
  END IF;

  PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
  PERFORM pg_catalog.set_config('r23.organization_id', v_org_id::pg_catalog.text, true);

  IF v_role <> 'recruiter' THEN
    RAISE EXCEPTION 'Recruiter role required' USING ERRCODE = 'R2501';
  END IF;

  RETURN QUERY
    SELECT m.principal_id, m.role, m.joined_at
    FROM hirearchy.organization_memberships AS m
    WHERE m.organization_id = v_org_id
      AND m.role = 'reviewer'
      AND m.status = 'active'
      AND m.revoked_at IS NULL
    ORDER BY m.joined_at ASC, m.principal_id ASC;
END
$function$;

CREATE FUNCTION r25.assign_reviewer(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text,
  p_reviewer_principal_id pg_catalog.uuid,
  p_assignment_id pg_catalog.text
)
RETURNS TABLE (
  assignment_id pg_catalog.text,
  session_id pg_catalog.text,
  organization_id pg_catalog.uuid,
  reviewer_principal_id pg_catalog.uuid,
  assigned_by_principal_id pg_catalog.uuid,
  assigned_at pg_catalog.timestamptz,
  revoked_at pg_catalog.timestamptz,
  version pg_catalog.int8,
  is_replay boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_org_id pg_catalog.uuid;
  v_role pg_catalog.text;
  v_version pg_catalog.int8;
  v_session_issuer pg_catalog.uuid;
  v_reviewer_valid boolean;
  v_existing_assignment record;
  v_assigned_at pg_catalog.timestamptz;
BEGIN
  IF SESSION_USER NOT IN ('r23_gateway', 'postgres', 'app_evaluator') OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.5 authorization denied' USING ERRCODE = 'R2501';
  END IF;

  IF NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), '') IS NOT NULL THEN
    SELECT auth_org.organization_id, auth_org.role, auth_org.membership_version
    INTO v_org_id, v_role, v_version
    FROM r23.authorize_organization(p_subject_id, p_auth_session_id, p_assurance, p_organization_id) AS auth_org;

    SELECT s.principal_id INTO v_principal_id
    FROM r23.server_sessions AS s
    WHERE s.handle_hash = pg_catalog.current_setting('r23.session_handle_hash', true)
      AND s.revoked_at IS NULL;
  ELSE
    PERFORM pg_catalog.set_config('r23.auth_subject_id', p_subject_id::pg_catalog.text, true);
    PERFORM pg_catalog.set_config('r23.principal_id', p_subject_id::pg_catalog.text, true);

    SELECT p.id INTO v_principal_id
    FROM hirearchy.application_principals AS p
    WHERE p.auth_user_id = p_subject_id OR p.id = p_subject_id
    LIMIT 1;

    IF v_principal_id IS NOT NULL THEN
      PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
      PERFORM pg_catalog.set_config('r23.organization_id', p_organization_id::text, true);

      SELECT m.organization_id, m.role, m.version
      INTO v_org_id, v_role, v_version
      FROM hirearchy.organization_memberships AS m
      WHERE m.principal_id = v_principal_id
        AND m.organization_id = p_organization_id
        AND m.status = 'active'
        AND m.revoked_at IS NULL;
    END IF;
  END IF;

  IF v_org_id IS NULL OR v_principal_id IS NULL THEN
    RAISE EXCEPTION 'R2.5 organization scope denied' USING ERRCODE = 'R2501';
  END IF;

  IF v_role <> 'recruiter' THEN
    RAISE EXCEPTION 'R2.5 reviewer assignment requires active recruiter role' USING ERRCODE = 'R2503';
  END IF;

  PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
  PERFORM pg_catalog.set_config('r23.organization_id', v_org_id::pg_catalog.text, true);

  SELECT s.issuer_principal_id INTO v_session_issuer
  FROM hirearchy.assessment_sessions AS s
  WHERE s.organization_id = v_org_id AND s.id = btrim(p_session_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assessment session not found' USING ERRCODE = 'R2504';
  END IF;

  IF v_session_issuer <> v_principal_id THEN
    RAISE EXCEPTION 'Caller is not the issuer of this assessment session' USING ERRCODE = 'R2503';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM hirearchy.organization_memberships AS m
    WHERE m.organization_id = v_org_id
      AND m.principal_id = p_reviewer_principal_id
      AND m.role = 'reviewer'
      AND m.status = 'active'
      AND m.revoked_at IS NULL
  ) INTO v_reviewer_valid;

  IF NOT v_reviewer_valid THEN
    RAISE EXCEPTION 'Principal is not an active reviewer in this organization' USING ERRCODE = 'R2505';
  END IF;

  SELECT ra.id, ra.session_id, ra.organization_id, ra.reviewer_principal_id,
         ra.assigned_by_principal_id, ra.assigned_at, ra.revoked_at, ra.version
  INTO v_existing_assignment
  FROM hirearchy.reviewer_assignments AS ra
  WHERE ra.organization_id = v_org_id
    AND ra.session_id = btrim(p_session_id)
    AND ra.reviewer_principal_id = p_reviewer_principal_id
    AND ra.revoked_at IS NULL;

  IF FOUND THEN
    RETURN QUERY SELECT
      v_existing_assignment.id, v_existing_assignment.session_id,
      v_existing_assignment.organization_id, v_existing_assignment.reviewer_principal_id,
      v_existing_assignment.assigned_by_principal_id, v_existing_assignment.assigned_at,
      v_existing_assignment.revoked_at, v_existing_assignment.version, true AS is_replay;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO hirearchy.reviewer_assignments (
      id, organization_id, session_id, reviewer_principal_id,
      assigned_by_principal_id, assigned_at, revoked_at, version
    ) VALUES (
      btrim(p_assignment_id), v_org_id, btrim(p_session_id), p_reviewer_principal_id,
      v_principal_id, pg_catalog.clock_timestamp(), NULL, 1
    )
    RETURNING hirearchy.reviewer_assignments.assigned_at INTO v_assigned_at;

    RETURN QUERY SELECT
      btrim(p_assignment_id), btrim(p_session_id), v_org_id, p_reviewer_principal_id,
      v_principal_id, v_assigned_at, NULL::pg_catalog.timestamptz, 1::pg_catalog.int8, false AS is_replay;
    RETURN;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT ra.id, ra.session_id, ra.organization_id, ra.reviewer_principal_id,
             ra.assigned_by_principal_id, ra.assigned_at, ra.revoked_at, ra.version
      INTO v_existing_assignment
      FROM hirearchy.reviewer_assignments AS ra
      WHERE ra.organization_id = v_org_id
        AND ra.session_id = btrim(p_session_id)
        AND ra.reviewer_principal_id = p_reviewer_principal_id
        AND ra.revoked_at IS NULL;

      IF FOUND THEN
        RETURN QUERY SELECT
          v_existing_assignment.id, v_existing_assignment.session_id,
          v_existing_assignment.organization_id, v_existing_assignment.reviewer_principal_id,
          v_existing_assignment.assigned_by_principal_id, v_existing_assignment.assigned_at,
          v_existing_assignment.revoked_at, v_existing_assignment.version, true AS is_replay;
        RETURN;
      END IF;
      RAISE;
  END;
END
$function$;

CREATE FUNCTION r25.revoke_reviewer_assignment(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text,
  p_assignment_id pg_catalog.text DEFAULT NULL,
  p_reviewer_principal_id pg_catalog.uuid DEFAULT NULL
)
RETURNS TABLE (
  assignment_id pg_catalog.text,
  session_id pg_catalog.text,
  organization_id pg_catalog.uuid,
  reviewer_principal_id pg_catalog.uuid,
  assigned_by_principal_id pg_catalog.uuid,
  assigned_at pg_catalog.timestamptz,
  revoked_at pg_catalog.timestamptz,
  version pg_catalog.int8,
  revoked boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_org_id pg_catalog.uuid;
  v_role pg_catalog.text;
  v_version pg_catalog.int8;
  v_session_issuer pg_catalog.uuid;
  v_assignment record;
BEGIN
  IF SESSION_USER NOT IN ('r23_gateway', 'postgres', 'app_evaluator') OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.5 authorization denied' USING ERRCODE = 'R2501';
  END IF;

  IF NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), '') IS NOT NULL THEN
    SELECT auth_org.organization_id, auth_org.role, auth_org.membership_version
    INTO v_org_id, v_role, v_version
    FROM r23.authorize_organization(p_subject_id, p_auth_session_id, p_assurance, p_organization_id) AS auth_org;

    SELECT s.principal_id INTO v_principal_id
    FROM r23.server_sessions AS s
    WHERE s.handle_hash = pg_catalog.current_setting('r23.session_handle_hash', true)
      AND s.revoked_at IS NULL;
  ELSE
    PERFORM pg_catalog.set_config('r23.auth_subject_id', p_subject_id::pg_catalog.text, true);
    PERFORM pg_catalog.set_config('r23.principal_id', p_subject_id::pg_catalog.text, true);

    SELECT p.id INTO v_principal_id
    FROM hirearchy.application_principals AS p
    WHERE p.auth_user_id = p_subject_id OR p.id = p_subject_id
    LIMIT 1;

    IF v_principal_id IS NOT NULL THEN
      PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
      PERFORM pg_catalog.set_config('r23.organization_id', p_organization_id::text, true);

      SELECT m.organization_id, m.role, m.version
      INTO v_org_id, v_role, v_version
      FROM hirearchy.organization_memberships AS m
      WHERE m.principal_id = v_principal_id
        AND m.organization_id = p_organization_id
        AND m.status = 'active'
        AND m.revoked_at IS NULL;
    END IF;
  END IF;

  IF v_org_id IS NULL OR v_principal_id IS NULL THEN
    RAISE EXCEPTION 'R2.5 organization scope denied' USING ERRCODE = 'R2501';
  END IF;

  IF v_role <> 'recruiter' THEN
    RAISE EXCEPTION 'R2.5 reviewer revocation requires active recruiter role' USING ERRCODE = 'R2503';
  END IF;

  PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
  PERFORM pg_catalog.set_config('r23.organization_id', v_org_id::pg_catalog.text, true);

  SELECT s.issuer_principal_id INTO v_session_issuer
  FROM hirearchy.assessment_sessions AS s
  WHERE s.organization_id = v_org_id AND s.id = btrim(p_session_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assessment session not found' USING ERRCODE = 'R2504';
  END IF;

  IF v_session_issuer <> v_principal_id THEN
    RAISE EXCEPTION 'Caller is not the issuer of this assessment session' USING ERRCODE = 'R2503';
  END IF;

  UPDATE hirearchy.reviewer_assignments
  SET revoked_at = pg_catalog.clock_timestamp(),
      version = hirearchy.reviewer_assignments.version + 1
  WHERE hirearchy.reviewer_assignments.organization_id = v_org_id
    AND hirearchy.reviewer_assignments.session_id = btrim(p_session_id)
    AND (
      (p_assignment_id IS NOT NULL AND hirearchy.reviewer_assignments.id = btrim(p_assignment_id))
      OR (p_assignment_id IS NULL AND hirearchy.reviewer_assignments.reviewer_principal_id = p_reviewer_principal_id)
    )
    AND hirearchy.reviewer_assignments.revoked_at IS NULL
  RETURNING hirearchy.reviewer_assignments.id,
            hirearchy.reviewer_assignments.session_id,
            hirearchy.reviewer_assignments.organization_id,
            hirearchy.reviewer_assignments.reviewer_principal_id,
            hirearchy.reviewer_assignments.assigned_by_principal_id,
            hirearchy.reviewer_assignments.assigned_at,
            hirearchy.reviewer_assignments.revoked_at,
            hirearchy.reviewer_assignments.version
  INTO v_assignment;

  IF FOUND THEN
    RETURN QUERY SELECT
      v_assignment.id, v_assignment.session_id, v_assignment.organization_id,
      v_assignment.reviewer_principal_id, v_assignment.assigned_by_principal_id,
      v_assignment.assigned_at, v_assignment.revoked_at, v_assignment.version, true AS revoked;
    RETURN;
  END IF;

  SELECT ra.id, ra.session_id, ra.organization_id, ra.reviewer_principal_id,
         ra.assigned_by_principal_id, ra.assigned_at, ra.revoked_at, ra.version
  INTO v_assignment
  FROM hirearchy.reviewer_assignments AS ra
  WHERE ra.organization_id = v_org_id
    AND ra.session_id = btrim(p_session_id)
    AND (
      (p_assignment_id IS NOT NULL AND ra.id = btrim(p_assignment_id))
      OR (p_assignment_id IS NULL AND ra.reviewer_principal_id = p_reviewer_principal_id)
    )
  ORDER BY ra.version DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT
      v_assignment.id, v_assignment.session_id, v_assignment.organization_id,
      v_assignment.reviewer_principal_id, v_assignment.assigned_by_principal_id,
      v_assignment.assigned_at, v_assignment.revoked_at, v_assignment.version, false AS revoked;
    RETURN;
  END IF;

  RAISE EXCEPTION 'Reviewer assignment not found' USING ERRCODE = 'R2506';
END
$function$;

CREATE FUNCTION r25.list_session_reviewer_assignments(
  p_subject_id pg_catalog.uuid,
  p_auth_session_id pg_catalog.uuid,
  p_assurance pg_catalog.text,
  p_organization_id pg_catalog.uuid,
  p_session_id pg_catalog.text
)
RETURNS TABLE (
  assignment_id pg_catalog.text,
  session_id pg_catalog.text,
  organization_id pg_catalog.uuid,
  reviewer_principal_id pg_catalog.uuid,
  assigned_by_principal_id pg_catalog.uuid,
  assigned_at pg_catalog.timestamptz,
  revoked_at pg_catalog.timestamptz,
  version pg_catalog.int8,
  is_active boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_principal_id pg_catalog.uuid;
  v_org_id pg_catalog.uuid;
  v_role pg_catalog.text;
  v_version pg_catalog.int8;
BEGIN
  IF SESSION_USER NOT IN ('r23_gateway', 'postgres', 'app_evaluator') OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.5 authorization denied' USING ERRCODE = 'R2501';
  END IF;

  IF NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), '') IS NOT NULL THEN
    SELECT auth_org.organization_id, auth_org.role, auth_org.membership_version
    INTO v_org_id, v_role, v_version
    FROM r23.authorize_organization(p_subject_id, p_auth_session_id, p_assurance, p_organization_id) AS auth_org;

    SELECT s.principal_id INTO v_principal_id
    FROM r23.server_sessions AS s
    WHERE s.handle_hash = pg_catalog.current_setting('r23.session_handle_hash', true)
      AND s.revoked_at IS NULL;
  ELSE
    PERFORM pg_catalog.set_config('r23.auth_subject_id', p_subject_id::pg_catalog.text, true);
    PERFORM pg_catalog.set_config('r23.principal_id', p_subject_id::pg_catalog.text, true);

    SELECT p.id INTO v_principal_id
    FROM hirearchy.application_principals AS p
    WHERE p.auth_user_id = p_subject_id OR p.id = p_subject_id
    LIMIT 1;

    IF v_principal_id IS NOT NULL THEN
      PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
      PERFORM pg_catalog.set_config('r23.organization_id', p_organization_id::text, true);

      SELECT m.organization_id, m.role, m.version
      INTO v_org_id, v_role, v_version
      FROM hirearchy.organization_memberships AS m
      WHERE m.principal_id = v_principal_id
        AND m.organization_id = p_organization_id
        AND m.status = 'active'
        AND m.revoked_at IS NULL;
    END IF;
  END IF;

  IF v_org_id IS NULL OR v_principal_id IS NULL THEN
    RAISE EXCEPTION 'R2.5 organization scope denied' USING ERRCODE = 'R2501';
  END IF;

  PERFORM pg_catalog.set_config('r23.principal_id', v_principal_id::pg_catalog.text, true);
  PERFORM pg_catalog.set_config('r23.organization_id', v_org_id::pg_catalog.text, true);

  RETURN QUERY
    SELECT ra.id, ra.session_id, ra.organization_id, ra.reviewer_principal_id,
           ra.assigned_by_principal_id, ra.assigned_at, ra.revoked_at, ra.version,
           (ra.revoked_at IS NULL) AS is_active
    FROM hirearchy.reviewer_assignments AS ra
    WHERE ra.organization_id = v_org_id
      AND ra.session_id = btrim(p_session_id)
    ORDER BY ra.assigned_at DESC, ra.id DESC;
END
$function$;

CREATE FUNCTION r25.validate_issuance_intent(
  p_subject_id uuid, p_auth_session_id uuid, p_assurance text,
  p_organization_id uuid, p_idempotency_key text, p_request_hash text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_role text;
  v_principal uuid;
  v_existing record;
BEGIN
  IF SESSION_USER <> 'r23_gateway' OR CURRENT_USER <> 'r23_session_owner'
     OR NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), '') IS NULL THEN
    RAISE EXCEPTION 'Scope denied' USING ERRCODE = 'R2501';
  END IF;
  SELECT a.role INTO v_role FROM r23.authorize_organization(
    p_subject_id, p_auth_session_id, p_assurance, p_organization_id) a;
  IF v_role IS DISTINCT FROM 'recruiter' THEN
    RAISE EXCEPTION 'Scope denied' USING ERRCODE = 'R2501';
  END IF;
  SELECT s.principal_id INTO v_principal FROM r23.server_sessions s
    WHERE s.handle_hash = pg_catalog.current_setting('r23.session_handle_hash', true) AND s.revoked_at IS NULL;
  PERFORM pg_catalog.set_config('r23.principal_id', v_principal::text, true);
  PERFORM pg_catalog.set_config('r23.organization_id', p_organization_id::text, true);
  SELECT i.issuer_principal_id, i.request_hash INTO v_existing
    FROM hirearchy.assessment_issuances i
    WHERE i.organization_id = p_organization_id AND i.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.issuer_principal_id IS DISTINCT FROM v_principal THEN
      RAISE EXCEPTION 'Scope denied' USING ERRCODE = 'R2501';
    END IF;
    IF v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
  END IF;
END
$function$;
ALTER FUNCTION r25.validate_issuance_intent(uuid,uuid,text,uuid,text,text) OWNER TO r23_session_owner;

CREATE FUNCTION r25.get_candidate_token_storage_meta()
RETURNS TABLE (
  slot pg_catalog.int4,
  version pg_catalog.int4,
  database_id pg_catalog.text,
  key_check pg_catalog.text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF SESSION_USER NOT IN ('r23_gateway', 'postgres', 'app_evaluator') OR CURRENT_USER <> 'r23_session_owner' THEN
    RAISE EXCEPTION 'R2.5 authorization denied' USING ERRCODE = 'R2501';
  END IF;

  RETURN QUERY
    SELECT m.slot, m.version, m.database_id, m.key_check
    FROM hirearchy.candidate_token_storage_meta AS m
    WHERE m.slot = 1;
END
$function$;

ALTER FUNCTION r25.issue_assessment(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.bool, pg_catalog.jsonb, pg_catalog.jsonb, pg_catalog.text) OWNER TO r23_session_owner;
ALTER FUNCTION r25.recover_candidate_token(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text) OWNER TO r23_session_owner;
ALTER FUNCTION r25.list_organization_reviewers(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) OWNER TO r23_session_owner;
ALTER FUNCTION r25.assign_reviewer(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text) OWNER TO r23_session_owner;
ALTER FUNCTION r25.revoke_reviewer_assignment(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.uuid) OWNER TO r23_session_owner;
ALTER FUNCTION r25.list_session_reviewer_assignments(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text) OWNER TO r23_session_owner;
ALTER FUNCTION r25.get_candidate_token_storage_meta() OWNER TO r23_session_owner;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA r25 FROM PUBLIC, r23_gateway;
GRANT EXECUTE ON FUNCTION r25.issue_assessment(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.bool, pg_catalog.jsonb, pg_catalog.jsonb, pg_catalog.text) TO r23_gateway, app_evaluator;
GRANT EXECUTE ON FUNCTION r25.recover_candidate_token(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text) TO r23_gateway, app_evaluator;
GRANT EXECUTE ON FUNCTION r25.list_organization_reviewers(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) TO r23_gateway, app_evaluator;
GRANT EXECUTE ON FUNCTION r25.assign_reviewer(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text) TO r23_gateway, app_evaluator;
GRANT EXECUTE ON FUNCTION r25.revoke_reviewer_assignment(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.uuid) TO r23_gateway, app_evaluator;
GRANT EXECUTE ON FUNCTION r25.list_session_reviewer_assignments(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text) TO r23_gateway, app_evaluator;
GRANT EXECUTE ON FUNCTION r25.validate_issuance_intent(uuid,uuid,text,uuid,text,text) TO r23_gateway;
GRANT EXECUTE ON FUNCTION r25.get_candidate_token_storage_meta() TO r23_gateway, app_evaluator;

ALTER DEFAULT PRIVILEGES FOR ROLE r23_session_owner IN SCHEMA r25
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE r23_session_owner IN SCHEMA r25
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE r23_session_owner IN SCHEMA r25
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;

COMMIT;
