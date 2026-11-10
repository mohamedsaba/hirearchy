import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AssessmentReviewerOptions } from '../../apps/web/app/r23/organizations/[organizationId]/builder/assessment-builder-client';

describe('assessment builder reviewer options', () => {
  it('renders recognizable member metadata while keeping the principal ID as value', () => {
    const principalId = 'b9284bf7-7518-4fdd-a57e-ffed93b5eea8';
    const html = renderToStaticMarkup(
      <select aria-label="Reviewer">
        <AssessmentReviewerOptions
          reviewers={[
            {
              principalId,
              role: 'reviewer',
              displayName: 'Terry Reviewer',
              email: 'terry@example.test',
            },
            {
              principalId: 'c68471b5-e80a-4d63-a321-24bb67d6a6a8',
              role: 'reviewer',
            },
          ]}
        />
      </select>,
    );

    expect(html).toContain(
      `<option value="${principalId}">Terry Reviewer · terry@example.test (reviewer)</option>`,
    );
    expect(html).toContain(
      '<option value="c68471b5-e80a-4d63-a321-24bb67d6a6a8">c68471b5-e80a-4d63-a321-24bb67d6a6a8 (reviewer)</option>',
    );
  });
});
