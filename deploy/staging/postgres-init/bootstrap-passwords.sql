\set ON_ERROR_STOP on
ALTER ROLE hirearchy_migrator PASSWORD :'migrator_password';
ALTER ROLE r23_gateway PASSWORD :'gateway_password';
ALTER ROLE app_candidate_gateway PASSWORD :'candidate_password';
ALTER ROLE app_evaluator PASSWORD :'evaluator_password';
ALTER ROLE app_control_worker PASSWORD :'control_password';
