import { describe, expect, it } from 'vitest';

import { renderSoftwareDocument } from '../../apps/web/src/ui/software-document';

describe('Software HTML document shell', () => {
  it('escapes the title and avoids duplicate page headings', () => {
    const fallbackHeading = renderSoftwareDocument(
      '<script>alert(1)</script>',
      '<p>Continue to sign in.</p>',
    );

    expect(fallbackHeading).toContain(
      '<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>',
    );
    expect(fallbackHeading).toContain(
      '<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1>',
    );
    expect(fallbackHeading.match(/<h1(?:\s|>)/gi)).toHaveLength(1);

    const existingHeading = renderSoftwareDocument(
      'Sign in to Hirearchy',
      '<h1>Sign in to Hirearchy Software.</h1>',
    );
    expect(existingHeading).toContain(
      '<h1>Sign in to Hirearchy Software.</h1>',
    );
    expect(existingHeading.match(/<h1(?:\s|>)/gi)).toHaveLength(1);
    expect(existingHeading).not.toContain('<h1>Sign in to Hirearchy</h1>');
  });
});
