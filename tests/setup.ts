import { markApplicationStartupReady } from '../apps/web/src/startup-status';

// Isolate tests from any operator-configured key. This fixed key is synthetic
// test material and must never be used for an application database.
process.env.HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(
  32,
  0x52,
).toString('base64');

// Route tests model an initialized app by default. Startup-failure tests set
// this process-local state explicitly before exercising fail-closed paths.
markApplicationStartupReady();
