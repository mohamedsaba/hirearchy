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

On a Linux host with Docker and Node.js 22 or later, prepare from the repository root:

```sh
npm ci
docker build -t hirearchy-staging-postgres-local:latest database/postgres/staging
docker pull supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b
npx playwright install chromium
npm run build
npm run demo:staging
```

Before a founder presentation, rehearse the retained lifecycle with `npm run test:staging:presentation`. It provisions a fresh synthetic organization, exercises recruiter authoring and issue, candidate consent/save/submit, assigned evaluator evidence and human review in a real browser, then sends SIGTERM and verifies cleanup of only the run-owned containers, volumes, network, and presenter credential file. It does not print or screenshot passwords or candidate invitation tokens.

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

## Outreach drafts — not sent

Use only after the founder authorizes outreach. No real prospects have been selected or contacted, and no prospect list has been collected.

**Email subject:** How does your team review engineering work samples?

**Email draft:**

> Hi [Name],
>
> I’m exploring how engineering teams review work samples and what evidence helps reviewers discuss a submission. Would you be open to a 10–15 minute discovery conversation about your current process? This is research only, not a product offer or pilot. If you’re not interested, I won’t follow up.
>
> [Founder name]

**Direct-message draft:** “I’m researching how engineering teams review work samples. Would you be open to a 10–15 minute conversation about your current process? This is discovery only, not a product offer.”

Do not add an invented customer result, promise, deadline, or price. No real outreach has been sent.

## Intake handling for operators

When Stage A is explicitly activated, the early-access form collects a name, work email, company/team, role, team size, selected challenge, and optional note. It stores requests on the application data volume for manual operator review; it sends no email and creates no account or pilot. The stored record excludes client IP and browser user-agent. Forwarded-IP headers are ignored for rate limiting; all visitors share a five-request/15-minute bucket per app process. The current deployment is not public, and acceptance checks use synthetic values only.

Use the host-only operator commands in the [`deploy/staging` runbook](../../deploy/staging/README.md). Export and deletion default to count-only dry runs. An applied export writes to a new mode-0600 file in a private directory outside the intake volume. Deletion requires an exact request ID or explicit UTC cutoff, an explicit apply flag, and a mode-0600 ID-only receipt outside the backed-up volume. Reapply that receipt to a restored copy before intake resumes. A live-store deletion is not complete while any export or backup copy still contains the request. No automatic retention schedule or numeric period is approved.

Do not use real buyer or candidate details in a rehearsal. The `/contact` page is informational and does not store messages. Founder and legal review must approve the privacy notice, retention period, deletion-request owner, backup expiry, and public activation before actual intake begins.
