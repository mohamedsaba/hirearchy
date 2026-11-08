# Hirearchy Software: internal buyer demo

**Audience:** founder-led discovery conversations. **Status:** local synthetic demo instructions; not a hosted pilot.

## Start the local demo

From the repository root on a Linux host with Docker and Node.js 22 or later:

```sh
npm ci
docker build -t hirearchy-staging-postgres-local:latest database/postgres/staging
docker pull supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b
npx playwright install chromium
npm run build
npm run demo:staging
```

For a full retained-demo rehearsal, run `npm run test:staging:presentation` after these prerequisites. It provisions a fresh synthetic organization, performs the recruiter, candidate, and evaluator flow in a browser, then sends SIGTERM and verifies cleanup of only that run's containers, volumes, and network. It does not print or screenshot invitation tokens or passwords.

The existing staging integration provisioner starts disposable PostgreSQL and GoTrue services, creates a fresh synthetic organization and real authenticated recruiter/reviewer identities through the supported setup path, installs the API, and starts the local app. It does not write candidate, assessment, timeline, or review fixture rows directly. The app uses the authenticated staging profile on loopback; do not change its runtime flags or expose its port externally.

When ready, the process prints a local app URL and the path to a private presenter file under `.data/`. The file has mode `0600` inside a mode `0700` directory. Open it locally for the random password, synthetic recruiter/reviewer emails, organization ID, and entry points. Do not copy its contents into documentation, slides, logs, screenshots, or chat. The credentials and organization are freshly generated for each run.

The process stays active while presenting. Press Enter, Ctrl-C, or send SIGTERM to run the same `finally` cleanup path. It removes the disposable containers, volumes, and network owned by that run; release/recovery artifacts remain under `.data/`, while the presenter credential file is removed. Do not delete recovery artifacts as routine cleanup.

## Safe entry points

- Recruiter sign-in: `{appUrl}/r23/login`
- Assessment builder: `{appUrl}/r23/organizations/{organizationId}/builder`
- Evaluator sign-in: `{appUrl}/r23/login`
- Assigned-session review: `{appUrl}/r27/organizations/{organizationId}/sessions/{sessionId}`

Sign in as recruiter, create and issue a Reservation Moves v3 task, assign the synthetic reviewer, then issue an invitation to a synthetic candidate such as `Demo Candidate` / `candidate@hirearchy.test`. Copy the invitation only into a private browser context. The candidate is an invitation bearer, not a pre-created user. Have them read the consent notice, save a code revision, and submit. Sign in as the assigned reviewer to inspect the submitted evidence and write a human-owned review. Never edit the database during the presentation.

The walkthrough and discovery questions are in [buyer demo and discovery notes](../product/buyer-demo-and-discovery.md).

## Boundaries

- Use synthetic names, emails, code, and task data only.
- Candidate email delivery, public signup, AI provider calls, live code execution, and external candidate activation are disabled.
- The demo is local and temporary, not public hosting or proof of production readiness.
- Treat an invitation URL as a bearer credential; never include it in a screenshot or shared notes.
- Review [release readiness](../release-readiness.md) for current operational evidence before discussing hosted access.
