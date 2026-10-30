CREATE TABLE hirearchy.organizations (
  id uuid PRIMARY KEY
);

CREATE TABLE hirearchy.application_principals (
  id uuid PRIMARY KEY,
  -- The managed Auth FK is deferred until its target schema and grants are verified.
  auth_user_id uuid UNIQUE
);

CREATE TABLE hirearchy.organization_memberships (
  organization_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  role text NOT NULL,
  status text NOT NULL,
  joined_at timestamptz NOT NULL,
  revoked_at timestamptz,
  version bigint NOT NULL CHECK (version > 0),
  PRIMARY KEY (organization_id, principal_id),
  FOREIGN KEY (organization_id)
    REFERENCES hirearchy.organizations (id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id)
    REFERENCES hirearchy.application_principals (id) ON DELETE RESTRICT
);

CREATE INDEX organization_memberships_principal_organization_idx
  ON hirearchy.organization_memberships (principal_id, organization_id);

CREATE TABLE hirearchy.assessment_sessions (
  id text PRIMARY KEY,
  organization_id uuid NOT NULL,
  issuer_principal_id uuid NOT NULL,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id)
    REFERENCES hirearchy.organizations (id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, issuer_principal_id)
    REFERENCES hirearchy.organization_memberships (organization_id, principal_id)
    ON DELETE RESTRICT
);

CREATE FUNCTION hirearchy.reject_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, hirearchy, pg_temp
AS $function$
DECLARE
  column_name text;
BEGIN
  FOREACH column_name IN ARRAY TG_ARGV LOOP
    IF (pg_catalog.to_jsonb(OLD) -> column_name)
       IS DISTINCT FROM (pg_catalog.to_jsonb(NEW) -> column_name) THEN
      RAISE EXCEPTION 'Immutable ownership field changed' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END
$function$;

CREATE FUNCTION hirearchy.reject_principal_rebinding()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, hirearchy, pg_temp
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR (
       NEW.auth_user_id IS NOT NULL
       AND NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id
     ) THEN
    RAISE EXCEPTION 'Immutable principal identity changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER organizations_id_immutable
  BEFORE UPDATE OF id ON hirearchy.organizations
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_immutable_columns('id');

CREATE TRIGGER principals_identity_immutable
  BEFORE UPDATE OF id, auth_user_id ON hirearchy.application_principals
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_principal_rebinding();

CREATE TRIGGER memberships_owner_immutable
  BEFORE UPDATE OF organization_id, principal_id ON hirearchy.organization_memberships
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_immutable_columns('organization_id', 'principal_id');

CREATE TRIGGER sessions_owner_immutable
  BEFORE UPDATE OF id, organization_id, issuer_principal_id ON hirearchy.assessment_sessions
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_immutable_columns('id', 'organization_id', 'issuer_principal_id');

REVOKE ALL ON FUNCTION hirearchy.reject_immutable_columns() FROM PUBLIC;
REVOKE ALL ON FUNCTION hirearchy.reject_principal_rebinding() FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA hirearchy FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA hirearchy FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hirearchy FROM PUBLIC;
REVOKE ALL ON SCHEMA hirearchy FROM PUBLIC;
REVOKE ALL ON SCHEMA hirearchy FROM app_evaluator, app_candidate_gateway, app_control_worker;
REVOKE ALL ON ALL TABLES IN SCHEMA hirearchy FROM app_evaluator, app_candidate_gateway, app_control_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA hirearchy FROM app_evaluator, app_candidate_gateway, app_control_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hirearchy FROM app_evaluator, app_candidate_gateway, app_control_worker;

ALTER DEFAULT PRIVILEGES FOR ROLE hirearchy_migrator
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE hirearchy_migrator
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE hirearchy_migrator
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;

ALTER TABLE hirearchy.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.application_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.application_principals FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.organization_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.assessment_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hirearchy.assessment_sessions FORCE ROW LEVEL SECURITY;
