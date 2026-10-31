-- Run as a database administrator. This creates no credentials or access grants.
-- Execute as one statement so an unsafe existing role rolls back all changes.
DO $bootstrap$
DECLARE
  role_name pg_catalog.text;
  expected_login pg_catalog.bool;
  role_state record;
BEGIN
  FOR role_name, expected_login IN
    SELECT * FROM (VALUES
      ('r23_gateway', true),
      ('r23_session_owner', false),
      ('staging_verifier_owner', false)
    ) AS required_roles(name, can_login)
  LOOP
    SELECT oid, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb,
           rolcreaterole, rolreplication, rolinherit, rolconfig
      INTO role_state
      FROM pg_catalog.pg_roles
      WHERE rolname = role_name;

    IF NOT FOUND THEN
      EXECUTE pg_catalog.format(
        'CREATE ROLE %I %s NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT',
        role_name,
        CASE WHEN expected_login THEN 'LOGIN' ELSE 'NOLOGIN' END
      );
      SELECT oid, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb,
             rolcreaterole, rolreplication, rolinherit, rolconfig
        INTO role_state
        FROM pg_catalog.pg_roles
        WHERE rolname = role_name;
    END IF;

    IF role_state.rolcanlogin IS DISTINCT FROM expected_login
       OR role_state.rolsuper OR role_state.rolbypassrls
       OR role_state.rolcreatedb OR role_state.rolcreaterole
       OR role_state.rolreplication OR role_state.rolinherit
       OR role_state.rolconfig IS NOT NULL
       OR EXISTS (
         SELECT 1 FROM pg_catalog.pg_db_role_setting
         WHERE setrole = role_state.oid
       )
       OR EXISTS (
         SELECT 1 FROM pg_catalog.pg_auth_members
         WHERE roleid = role_state.oid OR member = role_state.oid
       ) THEN
      RAISE EXCEPTION 'Internal role % is unsafe; review it manually', role_name;
    END IF;
  END LOOP;
END
$bootstrap$;
