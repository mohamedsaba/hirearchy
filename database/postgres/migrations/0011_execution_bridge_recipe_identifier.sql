-- Migration 0011: Execution Bridge Recipe Identifier Update
-- Additive migration: allows dot-delimited recipe identifiers (such as reservation-moves.pytest) in candidate_execution_operations
-- and allows recording factual execution provenance upon completion or failure.

ALTER TABLE hirearchy.candidate_execution_operations
  DROP CONSTRAINT IF EXISTS candidate_execution_operations_recipe_id_check;

ALTER TABLE hirearchy.candidate_execution_operations
  ADD CONSTRAINT candidate_execution_operations_recipe_id_check
  CHECK (recipe_id ~ '^[A-Za-z0-9._-]{1,128}$');

DROP TRIGGER IF EXISTS candidate_execution_operations_immutable_keys ON hirearchy.candidate_execution_operations;

CREATE TRIGGER candidate_execution_operations_immutable_keys
  BEFORE UPDATE OF organization_id, session_id, operation_id, request_id, sequence_start, workspace_digest, workspace_version, recipe_id, recipe_version, recipe_digest, generation, fence, created_at
  ON hirearchy.candidate_execution_operations
  FOR EACH ROW EXECUTE FUNCTION hirearchy.reject_immutable_columns(
    'organization_id', 'session_id', 'operation_id', 'request_id', 'sequence_start', 'workspace_digest', 'workspace_version', 'recipe_id', 'recipe_version', 'recipe_digest', 'generation', 'fence', 'created_at'
  );
