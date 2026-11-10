import { describe, expect, it } from 'vitest';

import { resolveOrgDisplay } from '../../apps/web/src/r23-auth/server';

const organizationId = '10000000-0000-4000-8000-0000000000a1';

describe('organization display metadata', () => {
  it('uses persisted display names even when no slug is available', () => {
    expect(
      resolveOrgDisplay(organizationId, { displayName: 'Founder Team' }),
    ).toEqual({
      name: 'Founder Team',
      slug: '10000000',
    });
  });

  it('preserves persisted organization name and slug', () => {
    expect(
      resolveOrgDisplay(organizationId, {
        organizationName: 'Historical Team',
        organizationSlug: 'historical-team',
      }),
    ).toEqual({
      name: 'Historical Team',
      slug: 'historical-team',
    });
  });

  it('derives a factual neutral name regardless of role', () => {
    expect(resolveOrgDisplay(organizationId, { role: 'admin' })).toEqual({
      name: 'Organization 10000000',
      slug: '10000000',
    });
  });
});
