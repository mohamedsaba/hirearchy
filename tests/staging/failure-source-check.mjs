import assert from 'node:assert/strict';
import test from 'node:test';
import { stagingFailureSource } from './browser.mjs';

test('reports a source frame without assertion values or absolute paths', () => {
  let failure;
  try {
    assert.equal('synthetic-private-actual', 'synthetic-private-expected');
  } catch (error) {
    failure = error;
  }
  const source = stagingFailureSource(failure);
  assert.match(source, /^tests\/staging\/failure-source-check\.mjs:\d+:\d+$/);
  assert.doesNotMatch(source, /private|file:|\/home\/|\/tmp\//);
});

test('accepts only staging source frames with bounded line numbers', () => {
  const sourceRoot = new URL('../../', import.meta.url).href;
  const rejected = [
    'file:///private/credentials.mjs:3:4',
    `${sourceRoot}tests/staging/private-token-name.mjs:3:4`,
    `${sourceRoot}tests/staging/token-secret.mjs?token=secret:3:4`,
    `${sourceRoot}tests/staging/../private.mjs:3:4`,
    `${sourceRoot}tests/staging/browser.mjs:1234567:4`,
  ];
  for (const location of rejected) {
    assert.equal(
      stagingFailureSource({ stack: `Error\n    at ${location}` }),
      null,
    );
  }
  assert.equal(
    stagingFailureSource({
      stack: `Error: synthetic-private-message\n    at async checkBrowserAcceptance (${sourceRoot}tests/staging/browser.mjs:123:4)`,
    }),
    'tests/staging/browser.mjs:123:4',
  );
});

test('does not report messages or malformed stacks', () => {
  for (const error of [null, {}, { stack: 7 }, { stack: 'private-message' }]) {
    assert.equal(stagingFailureSource(error), null);
  }
});
