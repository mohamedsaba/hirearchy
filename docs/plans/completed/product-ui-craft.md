# Hirearchy Software interface refresh

Use the live Hirearchy homepage and Software page as the visual reference. Bring their plum, mint, paper surfaces, and DM Sans hierarchy to the authenticated journey. Keep the existing route and data contracts and the human review workflow.

1. Sign in, account creation and recovery, workspace selection.
2. Assessments and team settings, followed by authoring, validation, issuance and session details.
3. Candidate brief and consent, coding workspace, and submitted state.
4. Evaluator summary, chronological evidence, and human review.

Walk the local Reservation Moves journey before and after the changes. Cover mobile, tablet, and desktop widths and test long data, keyboard navigation, work submission and review finalization. Exercise account and recovery screens through the existing disposable browser checks.

## Shipped in the local review checkout

- Unified the product masthead, account forms, and workspace colors using the [Hirearchy site](https://www.hirearchy.io/) and its [Software page](https://www.hirearchy.io/products/software) as references.
- Gave candidate invitations their own layout and made technical references expandable.
- Gave the pre-start brief a full reading column on tablets. Kept the mobile toolbar compact and restored native list semantics for nested workspace files.
- Put the timeline first in the reviewer summary and the human packet first in Review. The optional advisory report opens in a disclosure and reflows at narrow widths.

## Verification

- `npm run verify` passed, including formatting, lint, typechecking, 1,237 Vitest checks, executor checks, and the production build. Vitest skipped 13 checks.
- `npm run test:staging:presentation` passed with the narrow layout and advisory preview checks.
- The local Reservation Moves v3 journey was checked at 320, 390, 768, 1024, and 1440 pixels. The reviewed states had zero horizontal page overflows and zero axe WCAG A/AA violations at the checked desktop and phone sizes.
- Account creation, recovery, invitations, and workspace entry were exercised in the disposable onboarding flow on Chromium and WebKit over local HTTPS. Sign-in and workspace selection were also checked in Firefox at 320 pixels.
