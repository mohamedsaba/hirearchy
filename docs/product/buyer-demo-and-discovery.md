# Buyer demo and discovery notes

**Status:** Internal founder guide; hypotheses are not customer validation. **Product:** Hirearchy Software. **Demo:** Reservation Moves v3, synthetic local data only.

## Positioning to test

Hirearchy gives engineering reviewers a chronological record of a candidate's saved work and task activity, so they can inspect evidence and write their own review. It does not produce a candidate score or hiring recommendation.

Ask whether this evidence-led review solves a real gap in the team's current work-sample process. Do not claim faster review, better prediction, lower bias, market traction, or customer outcomes.

## Ideal customer hypothesis

- Engineering teams with recurring backend or platform hiring and a small reviewer group.
- A technical hiring manager or engineering leader owns assessment quality; a staff engineer or recruiter coordinates the work.
- The problem to test is the effort required to reconstruct submitted work and discuss it consistently.
- Start with one role and the approved Reservation Moves v3 scenario.

This segment and problem are unvalidated. No customer interviews, active pilots, or willingness-to-pay results are claimed.

## Repeatable synthetic demo

Run from the repository root on a host with the required Docker images and Node dependencies:

```sh
node scripts/test-staging-integration.mjs --presentation
```

The command uses the existing disposable PostgreSQL/GoTrue provisioner and starts the authenticated local app only after real identity, organization, and API provisioning. It generates a fresh synthetic recruiter and evaluator with a shared random password, then writes the credentials and organization ID to a private local presenter file. The app prints only a loopback URL and the path to that file; it does not print passwords or candidate invitation tokens.

Open the protected presenter file locally to get the login details and entry points. Sign in at `/r23/login`; open the builder at `/r23/organizations/{organizationId}/builder`. Create a new Reservation Moves v3 assessment and invitation in the UI using synthetic candidate details, for example `Demo Candidate` and `candidate@hirearchy.test`. Copy the invitation only into a private browser context. The candidate uses the invitation link; there is no candidate account. After submission, the assigned evaluator signs in and opens the session from the organization’s review list or `/r27/organizations/{organizationId}/sessions/{sessionId}`.

The process stays running for the presenter until Enter, Ctrl-C, or SIGTERM. The existing `finally` path stops the app and removes only the disposable containers, volumes, and network created by this run. Its release/recovery artifacts remain under `.data/`; the temporary presenter credentials file is removed when the process stops. Restart the command for a fresh synthetic organization and assessment. Do not make direct database edits during the presentation.

The demo is local and synthetic, not a hosted pilot. SMTP, public signup, live AI calls, live candidate code execution, and external candidate activation remain disabled. No real buyer or candidate data may be entered. Avoid putting passwords, candidate links, or tokens in slides, chat, notes, screenshots, or command output.

## 12–15 minute live script

| Time      | Screen and action                                                                                                                                                                                     | Buyer point                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 0–1 min   | Ask how reviewers currently inspect work samples and where they lose context.                                                                                                                         | Introduce the workflow problem as a question, not an asserted market fact.                                                   |
| 1–4 min   | Recruiter opens the builder, selects Reservation Moves v3, reviews its instructions, assigns the synthetic evaluator, validates and issues the task, then creates the synthetic candidate invitation. | A bounded engineering task and reviewer are set up in the authenticated app. Invitation copying is manual; no email is sent. |
| 4–7 min   | Candidate opens the invitation in a private browser context, reads the notice, consents, changes a task file, saves, refreshes to confirm the saved revision, then submits.                           | Show explicit candidate consent, saved work and durable submission. Do not describe an execution or test run as performed.   |
| 7–11 min  | Evaluator opens the assigned session, follows the timeline and source evidence, adds a factual observation linked to an available event or revision, writes and finalizes a human review.             | The evaluator interprets the evidence; the application does not score or choose an outcome.                                  |
| 11–13 min | Restate limitations and ask which evidence would change the team's debrief.                                                                                                                           | Invite specific workflow feedback; do not promise savings or outcomes.                                                       |
| 13–15 min | Ask about the team's next hiring cycle, ownership, privacy review, and adoption requirements.                                                                                                         | Agree a discovery follow-up only if the buyer chooses one.                                                                   |

The live task uses a real authorized browser/API journey. It does not pre-seed candidate evidence or a review record. Use any candidate invitation link only in the private presentation browser and discard it when the rehearsal ends.

## Discovery questions

1. Walk me through your current technical work-sample review, from choosing a task to the hiring debrief.
2. What takes the most reviewer time, and how do you know?
3. Which parts of a submission do reviewers need to inspect together: final code, saved revisions, task activity, or something else?
4. Where do reviewers disagree, and how is supporting evidence recorded today?
5. What burden or privacy concerns would make a take-home task inappropriate for your candidates?
6. Who would operate the task and support a candidate? What security, accessibility, retention, or integration requirements would they have?
7. How many relevant hires do you expect in the next six months, and what current process would a pilot need to complement?
8. What budget and approval path applies to a small, supervised pilot? What evidence would justify paying for it?

Avoid leading questions that assume review is slow or that a recorded timeline improves hiring. Record buyer responses as evidence only after actual conversations.

## Pilot and pricing hypothesis

For discovery only, test a supervised 30-day pilot for one team, one approved scenario, up to 10 candidate sessions, and onboarding for one recruiter plus two evaluators. An initial **US$250 total** is an internal price hypothesis, not an offer or validated willingness to pay. Hosting, support, candidate assistance, and privacy-operation costs have not been measured. Do not quote or charge this price until the founder approves the hosted workflow, privacy/legal materials, support ownership, and cost model.

## Outreach positioning

Suggested one-line opener for a founder-led conversation: “We’re exploring a work-sample review workflow that lets an engineering evaluator inspect saved revisions and task activity before writing a human-owned review; would you show me how your team handles that today?”

This is copy for possible founder use, not authorization to contact anyone. No real outreach has been sent.

## Intake handling for operators

The public early-access form collects name, work email, company/team, role, team size, selected challenge, and optional note. It stores requests on the application data volume. Requests remain there until an authorized operator deletes them; there is no automatic expiry or approved deletion-request process. The current form sends no email and creates no account or pilot. Operators can review the JSON without editing database records:

```sh
docker compose -f deploy/staging/docker-compose.preview.yml exec -T web node --experimental-strip-types scripts/export-early-access-requests.mjs
```

Run this from the repository root with the same Compose environment/project options used to start the preview. The command reads the configured `EARLY_ACCESS_STORAGE_PATH`, writes JSON to stdout, and does not create an absent request file. Treat the output as personal information; if saving it, use an access-restricted local destination. Corrupt or unreadable storage returns an error rather than an empty list. The preview uses one app process for file-backed storage; do not run multiple app replicas against the same JSON file.

The `/contact` page is informational only and does not store messages. Direct buyers to the early-access form for an interest request; the founder must review and approve the privacy notice and retention/deletion process before public intake is enabled.
