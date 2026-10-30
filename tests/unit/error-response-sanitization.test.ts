import { afterEach, describe, expect, it, vi } from 'vitest';

import { errorResponse } from '../../apps/web/src/http/error-response';

describe('error response operational logging', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not log or return untrusted exception details', async () => {
    const secretDetails =
      'sqlite:///private/path?key=synthetic-secret; provider=https://example.invalid/token';
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = errorResponse(new Error(secretDetails));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain(secretDetails);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      'Unexpected request failure [INTERNAL_ERROR]',
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(secretDetails);
  });
});
