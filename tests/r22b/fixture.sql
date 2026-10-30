-- Disposable integration fixture only; never apply to production or a configured database.
-- The broad owner policies are confined to the fixed SECURITY DEFINER commands below.
BEGIN;

DO $role$
DECLARE
  membership_owner pg_catalog.oid;
  role_state record;
BEGIN
  SELECT oid INTO membership_owner
  FROM pg_catalog.pg_roles
  WHERE rolname = 'r22b_membership_owner';
  IF membership_owner IS NULL THEN
    EXECUTE 'CREATE ROLE r22b_membership_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT';
    SELECT oid INTO membership_owner
    FROM pg_catalog.pg_roles
    WHERE rolname = 'r22b_membership_owner';
  END IF;

  SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
         rolreplication, rolinherit
  INTO role_state
  FROM pg_catalog.pg_roles
  WHERE oid = membership_owner;
  IF role_state.rolcanlogin OR role_state.rolsuper OR role_state.rolbypassrls
     OR role_state.rolcreatedb OR role_state.rolcreaterole
     OR role_state.rolreplication OR role_state.rolinherit THEN
    RAISE EXCEPTION 'Disposable membership owner has unsafe role attributes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members
    WHERE roleid = membership_owner OR member = membership_owner
  ) THEN
    RAISE EXCEPTION 'Disposable membership owner has role memberships';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'hirearchy'
      AND relation.relname = ANY(ARRAY[
        'organizations', 'application_principals',
        'organization_memberships', 'assessment_sessions'
      ]::pg_catalog.name[])
      AND (NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity)
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'hirearchy'
      AND relation.relname = ANY(ARRAY[
        'organizations', 'application_principals',
        'organization_memberships', 'assessment_sessions'
      ]::pg_catalog.name[])
  ) <> 4 THEN
    RAISE EXCEPTION 'Foundation tables must retain forced row security';
  END IF;
END
$role$;

CREATE SCHEMA r22b AUTHORIZATION r22b_membership_owner;
REVOKE ALL ON SCHEMA r22b FROM PUBLIC, app_evaluator;
GRANT USAGE ON SCHEMA r22b TO app_evaluator;
GRANT USAGE ON SCHEMA hirearchy TO r22b_membership_owner;

CREATE TABLE r22b.principal_subject_bindings (
  subject_id pg_catalog.uuid PRIMARY KEY,
  principal_id pg_catalog.uuid NOT NULL UNIQUE
    REFERENCES hirearchy.application_principals (id) ON DELETE RESTRICT,
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE r22b.bootstrap_permits (
  permit_digest pg_catalog.text PRIMARY KEY
    CHECK (permit_digest ~ '^[0-9a-f]{64}$'),
  subject_id pg_catalog.uuid NOT NULL,
  organization_id pg_catalog.uuid NOT NULL,
  expires_at pg_catalog.timestamptz NOT NULL,
  consumed_at pg_catalog.timestamptz,
  accepted_principal_id pg_catalog.uuid
    REFERENCES hirearchy.application_principals (id) ON DELETE RESTRICT,
  acceptance_id pg_catalog.uuid,
  accepted_at pg_catalog.timestamptz,
  accepted_membership_version pg_catalog.int8,
  CHECK (
    (consumed_at IS NULL AND accepted_principal_id IS NULL AND acceptance_id IS NULL
      AND accepted_at IS NULL AND accepted_membership_version IS NULL)
    OR
    (consumed_at IS NOT NULL AND accepted_principal_id IS NOT NULL
      AND acceptance_id IS NOT NULL AND accepted_at IS NOT NULL
      AND accepted_membership_version > 0)
  )
);

CREATE TABLE r22b.invitations (
  token_digest pg_catalog.text PRIMARY KEY
    CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  organization_id pg_catalog.uuid NOT NULL
    REFERENCES hirearchy.organizations (id) ON DELETE RESTRICT,
  recipient_subject_id pg_catalog.uuid NOT NULL,
  recipient_email pg_catalog.text NOT NULL
    CHECK (pg_catalog.length(recipient_email) BETWEEN 3 AND 320),
  role pg_catalog.text NOT NULL CHECK (role = 'reviewer'),
  issued_by_principal_id pg_catalog.uuid NOT NULL,
  expires_at pg_catalog.timestamptz NOT NULL,
  consumed_at pg_catalog.timestamptz,
  accepted_principal_id pg_catalog.uuid
    REFERENCES hirearchy.application_principals (id) ON DELETE RESTRICT,
  acceptance_id pg_catalog.uuid,
  accepted_at pg_catalog.timestamptz,
  accepted_membership_version pg_catalog.int8,
  FOREIGN KEY (organization_id, issued_by_principal_id)
    REFERENCES hirearchy.organization_memberships (organization_id, principal_id)
    ON DELETE RESTRICT,
  CHECK (
    (consumed_at IS NULL AND accepted_principal_id IS NULL AND acceptance_id IS NULL
      AND accepted_at IS NULL AND accepted_membership_version IS NULL)
    OR
    (consumed_at IS NOT NULL AND accepted_principal_id IS NOT NULL
      AND acceptance_id IS NOT NULL AND accepted_at IS NOT NULL
      AND accepted_membership_version > 0)
  )
);

ALTER TABLE r22b.principal_subject_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE r22b.principal_subject_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE r22b.bootstrap_permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE r22b.bootstrap_permits FORCE ROW LEVEL SECURITY;
ALTER TABLE r22b.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE r22b.invitations FORCE ROW LEVEL SECURITY;

ALTER TABLE r22b.principal_subject_bindings OWNER TO r22b_membership_owner;
ALTER TABLE r22b.bootstrap_permits OWNER TO r22b_membership_owner;
ALTER TABLE r22b.invitations OWNER TO r22b_membership_owner;

CREATE POLICY r22b_binding_select ON r22b.principal_subject_bindings
  FOR SELECT TO r22b_membership_owner USING (true);
CREATE POLICY r22b_binding_insert ON r22b.principal_subject_bindings
  FOR INSERT TO r22b_membership_owner WITH CHECK (true);
CREATE POLICY r22b_permit_select ON r22b.bootstrap_permits
  FOR SELECT TO r22b_membership_owner USING (true);
CREATE POLICY r22b_permit_update ON r22b.bootstrap_permits
  FOR UPDATE TO r22b_membership_owner USING (true) WITH CHECK (true);
CREATE POLICY r22b_invitation_select ON r22b.invitations
  FOR SELECT TO r22b_membership_owner USING (true);
CREATE POLICY r22b_invitation_update ON r22b.invitations
  FOR UPDATE TO r22b_membership_owner USING (true) WITH CHECK (true);

CREATE POLICY r22b_org_select ON hirearchy.organizations
  FOR SELECT TO r22b_membership_owner USING (true);
CREATE POLICY r22b_org_insert ON hirearchy.organizations
  FOR INSERT TO r22b_membership_owner WITH CHECK (true);
CREATE POLICY r22b_org_update ON hirearchy.organizations
  FOR UPDATE TO r22b_membership_owner USING (true) WITH CHECK (true);
CREATE POLICY r22b_principal_select ON hirearchy.application_principals
  FOR SELECT TO r22b_membership_owner USING (true);
CREATE POLICY r22b_principal_insert ON hirearchy.application_principals
  FOR INSERT TO r22b_membership_owner WITH CHECK (true);
CREATE POLICY r22b_principal_update ON hirearchy.application_principals
  FOR UPDATE TO r22b_membership_owner USING (true) WITH CHECK (true);
CREATE POLICY r22b_membership_select ON hirearchy.organization_memberships
  FOR SELECT TO r22b_membership_owner USING (true);
CREATE POLICY r22b_membership_insert ON hirearchy.organization_memberships
  FOR INSERT TO r22b_membership_owner WITH CHECK (true);
CREATE POLICY r22b_membership_update ON hirearchy.organization_memberships
  FOR UPDATE TO r22b_membership_owner USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON hirearchy.organizations,
  hirearchy.application_principals TO r22b_membership_owner;
GRANT UPDATE (id) ON hirearchy.organizations,
  hirearchy.application_principals TO r22b_membership_owner;
GRANT SELECT, INSERT ON hirearchy.organization_memberships TO r22b_membership_owner;
GRANT UPDATE (status, revoked_at, version)
  ON hirearchy.organization_memberships TO r22b_membership_owner;
GRANT SELECT, INSERT ON r22b.principal_subject_bindings TO r22b_membership_owner;
GRANT SELECT ON r22b.bootstrap_permits, r22b.invitations TO r22b_membership_owner;
GRANT UPDATE (consumed_at, accepted_principal_id, acceptance_id, accepted_at,
  accepted_membership_version) ON r22b.bootstrap_permits, r22b.invitations
  TO r22b_membership_owner;

CREATE FUNCTION r22b.bind_principal(p_subject_id pg_catalog.uuid)
RETURNS pg_catalog.uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_subject_id pg_catalog.uuid;
  v_session_id pg_catalog.uuid;
  v_assurance pg_catalog.text;
  v_principal_id pg_catalog.uuid;
  v_bound_subject_id pg_catalog.uuid;
BEGIN
  v_subject_id := NULLIF(pg_catalog.current_setting('hirearchy.auth_subject_id', true), '')::pg_catalog.uuid;
  v_session_id := NULLIF(pg_catalog.current_setting('hirearchy.auth_session_id', true), '')::pg_catalog.uuid;
  v_assurance := NULLIF(pg_catalog.current_setting('hirearchy.auth_assurance', true), '');
  IF SESSION_USER <> 'app_evaluator'
     OR CURRENT_USER <> 'r22b_membership_owner'
     OR p_subject_id IS NULL
     OR v_subject_id IS DISTINCT FROM p_subject_id
     OR v_session_id IS NULL
     OR v_assurance IS NULL
     OR v_assurance NOT IN ('aal1', 'aal2') THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;

  SELECT binding.principal_id, principal.auth_user_id
  INTO v_principal_id, v_bound_subject_id
  FROM r22b.principal_subject_bindings AS binding
  JOIN hirearchy.application_principals AS principal
    ON principal.id = binding.principal_id
  WHERE binding.subject_id = p_subject_id
  FOR UPDATE OF principal;
  IF FOUND THEN
    IF v_bound_subject_id IS DISTINCT FROM p_subject_id THEN
      RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
    END IF;
    RETURN v_principal_id;
  END IF;

  INSERT INTO hirearchy.application_principals (id, auth_user_id)
  VALUES (pg_catalog.gen_random_uuid(), p_subject_id)
  ON CONFLICT (auth_user_id) DO NOTHING;

  SELECT principal.id, principal.auth_user_id
  INTO v_principal_id, v_bound_subject_id
  FROM hirearchy.application_principals AS principal
  WHERE principal.auth_user_id = p_subject_id
  FOR UPDATE;
  IF NOT FOUND OR v_bound_subject_id IS DISTINCT FROM p_subject_id THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;

  INSERT INTO r22b.principal_subject_bindings (subject_id, principal_id)
  VALUES (p_subject_id, v_principal_id)
  ON CONFLICT (subject_id) DO NOTHING;

  SELECT binding.principal_id, principal.auth_user_id
  INTO v_principal_id, v_bound_subject_id
  FROM r22b.principal_subject_bindings AS binding
  JOIN hirearchy.application_principals AS principal
    ON principal.id = binding.principal_id
  WHERE binding.subject_id = p_subject_id
  FOR UPDATE OF principal;
  IF NOT FOUND OR v_bound_subject_id IS DISTINCT FROM p_subject_id THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;
  RETURN v_principal_id;
END
$function$;

CREATE FUNCTION r22b.bootstrap_organization(p_permit_digest pg_catalog.text)
RETURNS TABLE (
  organization_id pg_catalog.uuid,
  principal_id pg_catalog.uuid,
  role pg_catalog.text,
  acceptance_id pg_catalog.uuid,
  accepted_at pg_catalog.timestamptz,
  membership_version pg_catalog.int8
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_subject_id pg_catalog.uuid;
  v_session_id pg_catalog.uuid;
  v_assurance pg_catalog.text;
  v_actor_id pg_catalog.uuid;
  v_org_id pg_catalog.uuid;
  v_permit_subject pg_catalog.uuid;
  v_permit_org pg_catalog.uuid;
  v_expires_at pg_catalog.timestamptz;
  v_consumed_at pg_catalog.timestamptz;
  v_accepted_principal pg_catalog.uuid;
  v_acceptance_id pg_catalog.uuid;
  v_accepted_at pg_catalog.timestamptz;
  v_accepted_version pg_catalog.int8;
  v_bound_principal pg_catalog.uuid;
  v_bound_subject pg_catalog.uuid;
  v_member_role pg_catalog.text;
  v_member_status pg_catalog.text;
  v_member_revoked_at pg_catalog.timestamptz;
  v_member_version pg_catalog.int8;
  v_created_org pg_catalog.uuid;
BEGIN
  IF SESSION_USER <> 'app_evaluator'
     OR CURRENT_USER <> 'r22b_membership_owner' THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;
  v_subject_id := NULLIF(pg_catalog.current_setting('hirearchy.auth_subject_id', true), '')::pg_catalog.uuid;
  v_session_id := NULLIF(pg_catalog.current_setting('hirearchy.auth_session_id', true), '')::pg_catalog.uuid;
  v_assurance := NULLIF(pg_catalog.current_setting('hirearchy.auth_assurance', true), '');
  v_actor_id := NULLIF(pg_catalog.current_setting('hirearchy.actor_principal_id', true), '')::pg_catalog.uuid;
  v_org_id := NULLIF(pg_catalog.current_setting('hirearchy.organization_id', true), '')::pg_catalog.uuid;
  IF v_subject_id IS NULL OR v_actor_id IS NULL OR v_org_id IS NULL
     OR v_session_id IS NULL OR v_assurance IS NULL
     OR v_assurance NOT IN ('aal1', 'aal2')
     OR p_permit_digest IS NULL OR p_permit_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;

  SELECT permit.subject_id, permit.organization_id, permit.expires_at,
         permit.consumed_at, permit.accepted_principal_id, permit.acceptance_id,
         permit.accepted_at, permit.accepted_membership_version
  INTO v_permit_subject, v_permit_org, v_expires_at, v_consumed_at,
       v_accepted_principal, v_acceptance_id, v_accepted_at, v_accepted_version
  FROM r22b.bootstrap_permits AS permit
  WHERE permit.permit_digest = p_permit_digest
  FOR UPDATE;
  IF NOT FOUND OR v_permit_subject IS DISTINCT FROM v_subject_id
     OR v_permit_org IS DISTINCT FROM v_org_id THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;
  IF v_consumed_at IS NULL THEN
    IF v_expires_at <= pg_catalog.clock_timestamp() THEN
      RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
    END IF;
    INSERT INTO hirearchy.organizations (id)
    VALUES (v_org_id)
    ON CONFLICT (id) DO NOTHING
    RETURNING id INTO v_created_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
    END IF;
  ELSE
    SELECT organization.id INTO v_created_org
    FROM hirearchy.organizations AS organization
    WHERE organization.id = v_org_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT binding.principal_id, principal.auth_user_id
  INTO v_bound_principal, v_bound_subject
  FROM r22b.principal_subject_bindings AS binding
  JOIN hirearchy.application_principals AS principal
    ON principal.id = binding.principal_id
  WHERE binding.subject_id = v_subject_id
  FOR SHARE OF principal;
  IF NOT FOUND OR v_bound_principal IS DISTINCT FROM v_actor_id
     OR v_bound_subject IS DISTINCT FROM v_subject_id THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;

  IF v_consumed_at IS NOT NULL THEN
    SELECT membership.role, membership.status, membership.revoked_at, membership.version
    INTO v_member_role, v_member_status, v_member_revoked_at, v_member_version
    FROM hirearchy.organization_memberships AS membership
    WHERE membership.organization_id = v_org_id
      AND membership.principal_id = v_actor_id
    FOR SHARE;
    IF NOT FOUND OR v_accepted_principal IS DISTINCT FROM v_actor_id
       OR v_member_role IS DISTINCT FROM 'admin'
       OR v_member_status IS DISTINCT FROM 'active'
       OR v_member_revoked_at IS NOT NULL
       OR v_member_version < v_accepted_version THEN
      RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY SELECT v_org_id, v_actor_id, 'admin'::pg_catalog.text,
      v_acceptance_id, v_accepted_at, v_accepted_version;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM hirearchy.organization_memberships AS membership
    WHERE membership.organization_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;

  v_acceptance_id := pg_catalog.gen_random_uuid();
  v_accepted_at := pg_catalog.clock_timestamp();
  v_accepted_version := 1;
  INSERT INTO hirearchy.organization_memberships
    (organization_id, principal_id, role, status, joined_at, revoked_at, version)
  VALUES (v_org_id, v_actor_id, 'admin', 'active', v_accepted_at, NULL, v_accepted_version);

  UPDATE r22b.bootstrap_permits AS permit
  SET consumed_at = v_accepted_at,
      accepted_principal_id = v_actor_id,
      acceptance_id = v_acceptance_id,
      accepted_at = v_accepted_at,
      accepted_membership_version = v_accepted_version
  WHERE permit.permit_digest = p_permit_digest
    AND permit.consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT v_org_id, v_actor_id, 'admin'::pg_catalog.text,
    v_acceptance_id, v_accepted_at, v_accepted_version;
END
$function$;

CREATE FUNCTION r22b.read_membership()
RETURNS TABLE (
  organization_id pg_catalog.uuid,
  principal_id pg_catalog.uuid,
  role pg_catalog.text,
  membership_version pg_catalog.int8
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_subject_id pg_catalog.uuid;
  v_session_id pg_catalog.uuid;
  v_assurance pg_catalog.text;
  v_actor_id pg_catalog.uuid;
  v_org_id pg_catalog.uuid;
  v_org pg_catalog.uuid;
  v_bound_principal pg_catalog.uuid;
  v_bound_subject pg_catalog.uuid;
  v_role pg_catalog.text;
  v_status pg_catalog.text;
  v_revoked_at pg_catalog.timestamptz;
  v_version pg_catalog.int8;
BEGIN
  IF SESSION_USER <> 'app_evaluator'
     OR CURRENT_USER <> 'r22b_membership_owner' THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;
  v_subject_id := NULLIF(pg_catalog.current_setting('hirearchy.auth_subject_id', true), '')::pg_catalog.uuid;
  v_session_id := NULLIF(pg_catalog.current_setting('hirearchy.auth_session_id', true), '')::pg_catalog.uuid;
  v_assurance := NULLIF(pg_catalog.current_setting('hirearchy.auth_assurance', true), '');
  v_actor_id := NULLIF(pg_catalog.current_setting('hirearchy.actor_principal_id', true), '')::pg_catalog.uuid;
  v_org_id := NULLIF(pg_catalog.current_setting('hirearchy.organization_id', true), '')::pg_catalog.uuid;
  IF v_subject_id IS NULL OR v_actor_id IS NULL OR v_org_id IS NULL
     OR v_session_id IS NULL OR v_assurance IS NULL
     OR v_assurance NOT IN ('aal1', 'aal2') THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;

  SELECT organization.id INTO v_org
  FROM hirearchy.organizations AS organization
  WHERE organization.id = v_org_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;
  SELECT binding.principal_id, principal.auth_user_id
  INTO v_bound_principal, v_bound_subject
  FROM r22b.principal_subject_bindings AS binding
  JOIN hirearchy.application_principals AS principal
    ON principal.id = binding.principal_id
  WHERE binding.subject_id = v_subject_id
  FOR SHARE OF principal;
  IF NOT FOUND OR v_bound_principal IS DISTINCT FROM v_actor_id
     OR v_bound_subject IS DISTINCT FROM v_subject_id THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;
  SELECT membership.role, membership.status, membership.revoked_at, membership.version
  INTO v_role, v_status, v_revoked_at, v_version
  FROM hirearchy.organization_memberships AS membership
  WHERE membership.organization_id = v_org_id
    AND membership.principal_id = v_actor_id
  FOR SHARE;
  IF NOT FOUND OR v_status IS DISTINCT FROM 'active' OR v_revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT v_org_id, v_actor_id, v_role, v_version;
END
$function$;

CREATE FUNCTION r22b.accept_invitation(
  p_token_digest pg_catalog.text,
  p_verified_email pg_catalog.text
)
RETURNS TABLE (
  organization_id pg_catalog.uuid,
  principal_id pg_catalog.uuid,
  role pg_catalog.text,
  acceptance_id pg_catalog.uuid,
  accepted_at pg_catalog.timestamptz,
  membership_version pg_catalog.int8
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_subject_id pg_catalog.uuid;
  v_session_id pg_catalog.uuid;
  v_assurance pg_catalog.text;
  v_actor_id pg_catalog.uuid;
  v_org_id pg_catalog.uuid;
  v_org pg_catalog.uuid;
  v_email pg_catalog.text;
  v_bound_principal pg_catalog.uuid;
  v_bound_subject pg_catalog.uuid;
  v_recipient_subject pg_catalog.uuid;
  v_recipient_email pg_catalog.text;
  v_issuer pg_catalog.uuid;
  v_invite_role pg_catalog.text;
  v_expires_at pg_catalog.timestamptz;
  v_consumed_at pg_catalog.timestamptz;
  v_accepted_principal pg_catalog.uuid;
  v_acceptance_id pg_catalog.uuid;
  v_accepted_at pg_catalog.timestamptz;
  v_accepted_version pg_catalog.int8;
  v_issuer_role pg_catalog.text;
  v_issuer_status pg_catalog.text;
  v_issuer_revoked_at pg_catalog.timestamptz;
  v_member_role pg_catalog.text;
  v_member_status pg_catalog.text;
  v_member_revoked_at pg_catalog.timestamptz;
  v_member_version pg_catalog.int8;
BEGIN
  IF SESSION_USER <> 'app_evaluator'
     OR CURRENT_USER <> 'r22b_membership_owner' THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;
  v_subject_id := NULLIF(pg_catalog.current_setting('hirearchy.auth_subject_id', true), '')::pg_catalog.uuid;
  v_session_id := NULLIF(pg_catalog.current_setting('hirearchy.auth_session_id', true), '')::pg_catalog.uuid;
  v_assurance := NULLIF(pg_catalog.current_setting('hirearchy.auth_assurance', true), '');
  v_actor_id := NULLIF(pg_catalog.current_setting('hirearchy.actor_principal_id', true), '')::pg_catalog.uuid;
  v_org_id := NULLIF(pg_catalog.current_setting('hirearchy.organization_id', true), '')::pg_catalog.uuid;
  IF v_subject_id IS NULL OR v_actor_id IS NULL OR v_org_id IS NULL
     OR v_session_id IS NULL OR v_assurance IS NULL
     OR v_assurance NOT IN ('aal1', 'aal2')
     OR p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$'
     OR p_verified_email IS NULL THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;
  v_email := pg_catalog.lower(pg_catalog.btrim(p_verified_email));

  SELECT organization.id INTO v_org
  FROM hirearchy.organizations AS organization
  WHERE organization.id = v_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;
  SELECT binding.principal_id, principal.auth_user_id
  INTO v_bound_principal, v_bound_subject
  FROM r22b.principal_subject_bindings AS binding
  JOIN hirearchy.application_principals AS principal
    ON principal.id = binding.principal_id
  WHERE binding.subject_id = v_subject_id
  FOR SHARE OF principal;
  IF NOT FOUND OR v_bound_principal IS DISTINCT FROM v_actor_id
     OR v_bound_subject IS DISTINCT FROM v_subject_id THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;

  SELECT invitation.recipient_subject_id, invitation.recipient_email,
         invitation.issued_by_principal_id, invitation.role, invitation.expires_at,
         invitation.consumed_at, invitation.accepted_principal_id,
         invitation.acceptance_id, invitation.accepted_at,
         invitation.accepted_membership_version
  INTO v_recipient_subject, v_recipient_email, v_issuer, v_invite_role, v_expires_at,
       v_consumed_at, v_accepted_principal, v_acceptance_id, v_accepted_at,
       v_accepted_version
  FROM r22b.invitations AS invitation
  WHERE invitation.token_digest = p_token_digest
    AND invitation.organization_id = v_org_id
    AND invitation.recipient_subject_id = v_subject_id
    AND invitation.recipient_email = v_email
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;

  SELECT membership.role, membership.status, membership.revoked_at
  INTO v_issuer_role, v_issuer_status, v_issuer_revoked_at
  FROM hirearchy.organization_memberships AS membership
  WHERE membership.organization_id = v_org_id
    AND membership.principal_id = v_issuer
  FOR SHARE;
  IF NOT FOUND OR v_issuer_role IS DISTINCT FROM 'admin'
     OR v_issuer_status IS DISTINCT FROM 'active' OR v_issuer_revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;

  IF v_consumed_at IS NOT NULL THEN
    SELECT membership.role, membership.status, membership.revoked_at, membership.version
    INTO v_member_role, v_member_status, v_member_revoked_at, v_member_version
    FROM hirearchy.organization_memberships AS membership
    WHERE membership.organization_id = v_org_id
      AND membership.principal_id = v_actor_id
    FOR UPDATE;
    IF NOT FOUND OR v_accepted_principal IS DISTINCT FROM v_actor_id
       OR v_member_status IS DISTINCT FROM 'active' OR v_member_revoked_at IS NOT NULL
       OR v_member_version IS DISTINCT FROM v_accepted_version
       OR v_acceptance_id IS NULL OR v_accepted_at IS NULL
       OR v_accepted_version IS NULL THEN
      RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY SELECT v_org_id, v_actor_id, v_invite_role,
      v_acceptance_id, v_accepted_at, v_accepted_version;
    RETURN;
  END IF;

  IF v_expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;

  SELECT membership.role, membership.status, membership.revoked_at, membership.version
  INTO v_member_role, v_member_status, v_member_revoked_at, v_member_version
  FROM hirearchy.organization_memberships AS membership
  WHERE membership.organization_id = v_org_id
    AND membership.principal_id = v_actor_id
  FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;

  v_accepted_version := 1;
  INSERT INTO hirearchy.organization_memberships
    (organization_id, principal_id, role, status, joined_at, revoked_at, version)
  VALUES (
    v_org_id, v_actor_id, v_invite_role, 'active',
    pg_catalog.clock_timestamp(), NULL, v_accepted_version
  );

  v_acceptance_id := pg_catalog.gen_random_uuid();
  v_accepted_at := pg_catalog.clock_timestamp();
  UPDATE r22b.invitations AS invitation
  SET consumed_at = v_accepted_at,
      accepted_principal_id = v_actor_id,
      acceptance_id = v_acceptance_id,
      accepted_at = v_accepted_at,
      accepted_membership_version = v_accepted_version
  WHERE invitation.token_digest = p_token_digest
    AND invitation.consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT v_org_id, v_actor_id, v_invite_role,
    v_acceptance_id, v_accepted_at, v_accepted_version;
END
$function$;

CREATE FUNCTION r22b.revoke_membership(p_target_principal_id pg_catalog.uuid)
RETURNS TABLE (
  organization_id pg_catalog.uuid,
  principal_id pg_catalog.uuid,
  role pg_catalog.text,
  status pg_catalog.text,
  membership_version pg_catalog.int8
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_subject_id pg_catalog.uuid;
  v_session_id pg_catalog.uuid;
  v_assurance pg_catalog.text;
  v_actor_id pg_catalog.uuid;
  v_org_id pg_catalog.uuid;
  v_org pg_catalog.uuid;
  v_bound_principal pg_catalog.uuid;
  v_bound_subject pg_catalog.uuid;
  v_actor_role pg_catalog.text;
  v_actor_status pg_catalog.text;
  v_actor_revoked_at pg_catalog.timestamptz;
  v_target_role pg_catalog.text;
  v_target_status pg_catalog.text;
  v_target_revoked_at pg_catalog.timestamptz;
  v_target_version pg_catalog.int8;
  v_admin_count pg_catalog.int8;
BEGIN
  IF SESSION_USER <> 'app_evaluator'
     OR CURRENT_USER <> 'r22b_membership_owner' THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;
  v_subject_id := NULLIF(pg_catalog.current_setting('hirearchy.auth_subject_id', true), '')::pg_catalog.uuid;
  v_session_id := NULLIF(pg_catalog.current_setting('hirearchy.auth_session_id', true), '')::pg_catalog.uuid;
  v_assurance := NULLIF(pg_catalog.current_setting('hirearchy.auth_assurance', true), '');
  v_actor_id := NULLIF(pg_catalog.current_setting('hirearchy.actor_principal_id', true), '')::pg_catalog.uuid;
  v_org_id := NULLIF(pg_catalog.current_setting('hirearchy.organization_id', true), '')::pg_catalog.uuid;
  IF v_subject_id IS NULL OR v_actor_id IS NULL OR v_org_id IS NULL
     OR v_session_id IS NULL OR v_assurance IS NULL
     OR v_assurance NOT IN ('aal1', 'aal2')
     OR p_target_principal_id IS NULL OR p_target_principal_id = v_actor_id THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;

  SELECT organization.id INTO v_org
  FROM hirearchy.organizations AS organization
  WHERE organization.id = v_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;
  SELECT binding.principal_id, principal.auth_user_id
  INTO v_bound_principal, v_bound_subject
  FROM r22b.principal_subject_bindings AS binding
  JOIN hirearchy.application_principals AS principal
    ON principal.id = binding.principal_id
  WHERE binding.subject_id = v_subject_id
  FOR SHARE OF principal;
  IF NOT FOUND OR v_bound_principal IS DISTINCT FROM v_actor_id
     OR v_bound_subject IS DISTINCT FROM v_subject_id THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;
  SELECT membership.role, membership.status, membership.revoked_at
  INTO v_actor_role, v_actor_status, v_actor_revoked_at
  FROM hirearchy.organization_memberships AS membership
  WHERE membership.organization_id = v_org_id
    AND membership.principal_id = v_actor_id
  FOR UPDATE;
  IF NOT FOUND OR v_actor_role IS DISTINCT FROM 'admin'
     OR v_actor_status IS DISTINCT FROM 'active' OR v_actor_revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;

  SELECT membership.role, membership.status, membership.revoked_at, membership.version
  INTO v_target_role, v_target_status, v_target_revoked_at, v_target_version
  FROM hirearchy.organization_memberships AS membership
  WHERE membership.organization_id = v_org_id
    AND membership.principal_id = p_target_principal_id
  FOR UPDATE;
  IF NOT FOUND OR v_target_status IS DISTINCT FROM 'active'
     OR v_target_revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
  END IF;
  IF v_target_role = 'admin' THEN
    SELECT pg_catalog.count(*) INTO v_admin_count
    FROM hirearchy.organization_memberships AS membership
    WHERE membership.organization_id = v_org_id
      AND membership.role = 'admin'
      AND membership.status = 'active'
      AND membership.revoked_at IS NULL;
    IF v_admin_count <= 1 THEN
      RAISE EXCEPTION 'Membership operation denied' USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE hirearchy.organization_memberships AS membership
  SET status = 'revoked',
      revoked_at = pg_catalog.clock_timestamp(),
      version = membership.version + 1
  WHERE membership.organization_id = v_org_id
    AND membership.principal_id = p_target_principal_id
  RETURNING membership.role, membership.status, membership.version
  INTO v_target_role, v_target_status, v_target_version;
  RETURN QUERY SELECT v_org_id, p_target_principal_id, v_target_role,
    v_target_status, v_target_version;
END
$function$;

ALTER FUNCTION r22b.bind_principal(pg_catalog.uuid) OWNER TO r22b_membership_owner;
ALTER FUNCTION r22b.bootstrap_organization(pg_catalog.text) OWNER TO r22b_membership_owner;
ALTER FUNCTION r22b.read_membership() OWNER TO r22b_membership_owner;
ALTER FUNCTION r22b.accept_invitation(pg_catalog.text, pg_catalog.text) OWNER TO r22b_membership_owner;
ALTER FUNCTION r22b.revoke_membership(pg_catalog.uuid) OWNER TO r22b_membership_owner;

REVOKE ALL ON ALL TABLES IN SCHEMA r22b FROM PUBLIC, app_evaluator;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA r22b FROM PUBLIC, app_evaluator;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA r22b FROM PUBLIC, app_evaluator;
GRANT EXECUTE ON FUNCTION r22b.bind_principal(pg_catalog.uuid) TO app_evaluator;
GRANT EXECUTE ON FUNCTION r22b.bootstrap_organization(pg_catalog.text) TO app_evaluator;
GRANT EXECUTE ON FUNCTION r22b.read_membership() TO app_evaluator;
GRANT EXECUTE ON FUNCTION r22b.accept_invitation(pg_catalog.text, pg_catalog.text) TO app_evaluator;
GRANT EXECUTE ON FUNCTION r22b.revoke_membership(pg_catalog.uuid) TO app_evaluator;

COMMIT;
