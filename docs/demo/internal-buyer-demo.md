# Hirearchy Software: internal buyer demo

**Audience:** founder-led conversations with prospective design partners

**Status:** Script and product scope only. The complete recruiter-to-candidate-to-review runtime is pending integrated CI and visual acceptance. Check the single [release readiness record](../release-readiness.md) before attempting a live walkthrough. Until it is accepted, do not present this flow as a working product demo.

## Product in one minute

Hirearchy gives a candidate a bounded engineering task, records saved work and task activity, and presents the resulting evidence in chronological context for an assigned human reviewer. The reviewer writes and owns the interpretation. Hirearchy does not produce candidate scores, rankings, competence labels, or automatic hiring verdicts.

The intended internal walkthrough uses the approved **Reservation Moves v3** task. Its durable demo profile uses synthetic data; AI assistance, code execution, and email delivery are disabled. The invitation is copied by an authenticated recruiter and expires. This is a product script, not evidence of public deployment, customer use, or release readiness.

## Before a live walkthrough

Use the automated staging fixture after the release readiness record shows that the integrated candidate and reviewer browser journey has passed and been accepted. The app has no self-service signup, first-organization setup, or account recovery flow. The demo needs pre-provisioned synthetic GoTrue identities, application-principal bindings, organization memberships, and one assigned reviewer. Do not create a buyer-facing account by manually copying credentials or tokens into this guide.

Use a fresh synthetic assessment session for each walkthrough. Do not enter real candidate details, source code, credentials, secrets, or customer data. The candidate notice describes recorded data and disabled capabilities; it does not replace approved legal, retention, or external-candidate disclosures.

## One recruiter-to-candidate-to-evaluator walkthrough

### 1. Recruiter prepares and invites

1. Sign in at `/r23/login`, choose the prepared organization at `/r23/organizations`, and open `/r23/organizations/{organizationId}/builder`.
2. Select **Reservation Moves v3**, review the task brief and starter workspace, select the assigned reviewer, then validate and issue the assessment.
3. Create the candidate invitation explicitly. The expiry defaults to seven days and can be set up to 30 days. Copy the confirmed active link from the invitation panel. It is not emailed. Treat the link as a bearer credential; never paste it into slides, notes, chat, screenshots, or test output.

### 2. Candidate works and submits

1. Open the recruiter-copied invitation in a private browser context. The URL uses `/r26/candidate/{sessionId}`; its secret fragment is omitted from this guide.
2. Read the canonical notice and affirmatively consent before activating the workspace:

   > This workspace records saved code, revisions, task activity and submission for your assigned hiring team’s review. This demo uses synthetic data; do not enter secrets or real candidate information. AI assistance and code execution are unavailable in this demo.

   This acknowledgement records consent to the demo notice; it is not proof of understanding or legal compliance.

3. Edit the task files in the browser workspace. Confirm the saved state before continuing, then submit. The submitted workspace becomes read-only. Resume is available through the same active invitation before its expiry; no email reminder or delivery is provided.

### 3. Assigned evaluator reviews evidence

1. Sign in as the assigned reviewer and open `/r27/organizations/{organizationId}/sessions/{sessionId}`.
2. Review the chronological evidence and submitted work. Add factual observations tied to available evidence, then write a human review that cites evidence and records strengths, concerns, and unresolved questions.
3. Save and finalize the review packet. Finalization is retained and immutable. The interface does not calculate a score or choose a hiring outcome. If the recruiter revokes the invitation, candidate access stops while submitted work and reviewer records remain available to authorized reviewers.

These are the intended browser entry points for the integrated flow. Route availability and the full runtime journey remain **pending acceptance**; the readiness record is authoritative for current status.

## Early-adopter approach

The buyer hypothesis is that an engineering manager or technical founder sponsors a pilot and a recruiter operates invitations. This is a segment to investigate, not validated buyer preference. Start with founder-led conversations and a synthetic rehearsal. There is no public self-serve signup, live email, or customer provisioning path.

The public `/contact` page is informational and does not accept or store requests. Opening buyer intake later requires an approved durable PostgreSQL persistence path and an explicit delivery destination; neither is currently wired.

Internal pricing hypothesis only: **US$250 for a fixed 30-day design-partner pilot**, one team, one approved scenario, and up to 10 candidate sessions, credited toward a future small-team plan. Do not publish this price, quote it as an offer, or implement payment. Published competitor attempt prices are not directly comparable; see [competitive positioning](../market/competitive-positioning.md). Hosting, execution, and support costs are unmeasured and must be checked before any pilot is offered. No willingness-to-pay, margin, or customer-interview evidence is claimed.

Do not use real external candidates until the relevant deployment, privacy, retention, support, and security gates are accepted. External code execution remains a separate launch blocker; this demo keeps execution and AI off.

## Five discovery questions

1. How often do you review take-home engineering work, and how much engineering time does a typical review take? Where does review slow down?
2. Which evidence would make a work sample more useful to discuss: the submitted artifact, revisions, task activity, or an ordered timeline? What would not help?
3. Who chooses the assessment, sends invitations, supports candidates, and owns the final evaluation?
4. Where do candidates experience the most friction: setup, time burden, privacy and consent, accessibility, saving and resuming, or uncertainty about what happens next?
5. What budget and approval path would a 30-day, one-scenario pilot require, and what result would justify continuing?

Do not record answers as validation until they come from actual buyer conversations. Do not imply that the proposed pilot price has been tested.

## Presenter disclosures

- This is an internal-demo scope; current release status and accepted evidence live only in [release readiness](../release-readiness.md).
- Use synthetic data only. The current app flow does not provide public account creation, organization provisioning, password recovery, candidate email, or self-serve onboarding.
- AI assistance and code execution are unavailable in this demo. Do not describe hidden AI use, code origin, or candidate competence as inferred facts.
- The reviewer owns interpretation. No candidate score, ranking, automatic pass/reject, or hire recommendation is produced.
- Do not claim a public deployment, production security certification, customer result, ATS integration, or commercial offer without separate verified evidence and approval.
