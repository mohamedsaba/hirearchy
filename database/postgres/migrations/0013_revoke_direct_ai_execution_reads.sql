-- Migration 0013: remove direct evaluator and worker reads from AI/execution evidence.
-- These runtime roles cannot establish reviewer identity from caller-settable GUCs.

DROP POLICY IF EXISTS r212_evaluator_ai_interactions_select
  ON hirearchy.candidate_ai_interactions;
DROP POLICY IF EXISTS r212_control_worker_ai_interactions_select
  ON hirearchy.candidate_ai_interactions;
REVOKE ALL ON TABLE hirearchy.candidate_ai_interactions
  FROM app_evaluator, app_control_worker;

DROP POLICY IF EXISTS r213_evaluator_execution_select
  ON hirearchy.candidate_execution_operations;
DROP POLICY IF EXISTS r213_control_worker_execution_select
  ON hirearchy.candidate_execution_operations;
REVOKE ALL ON TABLE hirearchy.candidate_execution_operations
  FROM app_evaluator, app_control_worker;

-- Restore the foundation's default-deny schema contract. Candidate gateway access
-- and the r23_session_owner definer path remain unchanged.
REVOKE ALL ON SCHEMA hirearchy FROM app_evaluator, app_control_worker;
