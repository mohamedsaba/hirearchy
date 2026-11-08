import assert from 'node:assert/strict';
import test from 'node:test';
import { readBrowserCsrf } from './browser.mjs';

test('browser CSRF lookup requires the exact app host, root path and Secure cookie', async () => {
  const valid = {
    name: '__Host-r23-csrf',
    value: 'synthetic-valid-csrf',
    domain: '127.0.0.1',
    path: '/',
    secure: true,
  };
  const cookies = [
    { ...valid, domain: 'other.invalid', value: 'synthetic-other-host' },
    { ...valid, secure: false, value: 'synthetic-insecure' },
    { ...valid, path: '/other', value: 'synthetic-other-path' },
    { ...valid, name: 'other-cookie', value: 'synthetic-other-name' },
    valid,
  ];
  const context = {
    async cookies(...urls) {
      assert.deepEqual(
        urls,
        [],
        'Secure loopback cookies require an unfiltered read',
      );
      return cookies;
    },
  };
  assert.equal(
    await readBrowserCsrf(context, 'http://127.0.0.1:3005'),
    valid.value,
  );
  await assert.rejects(readBrowserCsrf(context, 'http://localhost:3005'), {
    code: 'ERR_ASSERTION',
  });
});
