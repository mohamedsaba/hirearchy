-- Run as a database administrator before migrations. This creates no credentials.
BEGIN;

DO $bootstrap$
DECLARE
  role_name text;
  role_oid oid;
  role_state record;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'hirearchy_migrator',
    'app_evaluator',
    'app_candidate_gateway',
    'app_control_worker'
  ] LOOP
    SELECT oid INTO role_oid
    FROM pg_catalog.pg_roles
    WHERE rolname = role_name;

    IF role_oid IS NULL THEN
      EXECUTE pg_catalog.format(
        'CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT',
        role_name
      );
      SELECT oid INTO role_oid
      FROM pg_catalog.pg_roles
      WHERE rolname = role_name;
    END IF;

    SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
           rolreplication, rolinherit
    INTO role_state
    FROM pg_catalog.pg_roles
    WHERE oid = role_oid;

    IF NOT role_state.rolcanlogin
       OR role_state.rolsuper
       OR role_state.rolbypassrls
       OR role_state.rolcreatedb
       OR role_state.rolcreaterole
       OR role_state.rolreplication
       OR role_state.rolinherit THEN
      RAISE EXCEPTION 'Role % has unsafe attributes; review it manually', role_name;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_auth_members
      WHERE roleid = role_oid OR member = role_oid
    ) THEN
      RAISE EXCEPTION 'Role % has memberships; review them manually', role_name;
    END IF;

    EXECUTE pg_catalog.format('ALTER ROLE %I SET search_path = pg_catalog', role_name);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'hirearchy'
  ) THEN
    CREATE SCHEMA hirearchy AUTHORIZATION hirearchy_migrator;
  END IF;

  IF (
    SELECT r.rolname
    FROM pg_catalog.pg_namespace AS n
    JOIN pg_catalog.pg_roles AS r ON r.oid = n.nspowner
    WHERE n.nspname = 'hirearchy'
  ) IS DISTINCT FROM 'hirearchy_migrator' THEN
    RAISE EXCEPTION 'Schema hirearchy must be owned by hirearchy_migrator';
  END IF;
END
$bootstrap$;

REVOKE ALL ON SCHEMA hirearchy FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA hirearchy FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA hirearchy FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hirearchy FROM PUBLIC;
REVOKE ALL ON SCHEMA hirearchy FROM app_evaluator, app_candidate_gateway, app_control_worker;
REVOKE ALL ON ALL TABLES IN SCHEMA hirearchy FROM app_evaluator, app_candidate_gateway, app_control_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA hirearchy FROM app_evaluator, app_candidate_gateway, app_control_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hirearchy FROM app_evaluator, app_candidate_gateway, app_control_worker;

COMMIT;
