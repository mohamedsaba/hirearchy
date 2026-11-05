-- Administrator-only precondition; installs no verifier or application access.
BEGIN;
DO $bootstrap$
DECLARE r record;
BEGIN
  SELECT oid, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb,
         rolcreaterole, rolreplication, rolinherit, rolconfig
    INTO r FROM pg_catalog.pg_roles WHERE rolname = 'staging_verifier_owner';
  IF NOT FOUND THEN
    CREATE ROLE staging_verifier_owner NOLOGIN NOSUPERUSER NOBYPASSRLS
      NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
    SELECT oid, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb,
           rolcreaterole, rolreplication, rolinherit, rolconfig
      INTO r FROM pg_catalog.pg_roles WHERE rolname = 'staging_verifier_owner';
  END IF;
  IF r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb
     OR r.rolcreaterole OR r.rolreplication OR r.rolinherit OR r.rolconfig IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setrole = r.oid)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid = r.oid OR member = r.oid)
  THEN
    RAISE EXCEPTION 'staging_verifier_owner has unsafe attributes, settings, or memberships';
  END IF;
END
$bootstrap$;
CREATE EXTENSION IF NOT EXISTS plpython3u;
COMMIT;
