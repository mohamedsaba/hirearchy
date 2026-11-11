import assert from 'node:assert/strict';
import { loadPlaywright } from '../r25/browser-issuance-check.mjs';

const origin = new URL(
  process.env.FOUNDER_UAT_CSS_ORIGIN ?? 'http://127.0.0.1:3000',
);
const profile = process.env.FOUNDER_UAT_CSS_PROFILE ?? 'founder-uat';
assert(
  origin.protocol === 'http:' &&
    ['127.0.0.1', 'localhost'].includes(origin.hostname) &&
    origin.pathname === '/' &&
    !origin.search &&
    !origin.hash,
  'The CSS delivery check only runs against a loopback application origin.',
);
assert(
  profile === 'founder-uat' || profile === 'staging-authenticated',
  'The CSS delivery check requires an explicit supported runtime profile.',
);

const { chromium } = loadPlaywright();
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  ...(process.env.R23_CHROMIUM_PATH
    ? { executablePath: process.env.R23_CHROMIUM_PATH }
    : {}),
});

const failures = [];
const consoleErrors = [];
const contexts = [];
const expectedDocumentRejections = [];

function recordExpectedDocumentRejection(response) {
  assert(
    response.request().isNavigationRequest(),
    'Expected an account-form document response.',
  );
  expectedDocumentRejections.push({
    url: response.url(),
    status: response.status(),
    statusText: response.statusText(),
  });
}

async function openPage(path) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  contexts.push(context);
  const page = await context.newPage();
  const assets = [];
  page.on('response', (response) => {
    if (/\.(?:css|woff2?|js)(?:\?|$)/i.test(response.url())) {
      assets.push({
        status: response.status(),
        contentType: response.headers()['content-type'] ?? '',
        url: response.url(),
      });
    }
  });
  page.on('requestfailed', (request) => {
    if (/\.(?:css|woff2?|js)(?:\?|$)/i.test(request.url())) {
      failures.push(
        `${path}: ${request.url()} (${request.failure()?.errorText})`,
      );
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push({
        path,
        text: message.text(),
        url: message.location().url || page.url(),
      });
    }
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(`${path}: ${error.message}`);
  });
  const response = await page.goto(new URL(path, origin).href, {
    waitUntil: 'networkidle',
  });
  assert(response, `${path} did not return a document response.`);
  if (path === '/r23/signup' && profile === 'staging-authenticated') {
    assert.equal(
      response.status(),
      403,
      `${path} must remain gated in staging.`,
    );
    recordExpectedDocumentRejection(response);
  } else {
    assert.equal(
      response.status(),
      200,
      `${path} returned an unexpected status.`,
    );
  }
  return { page, response, assets };
}

async function assertStyled(
  { page, response, assets },
  path,
  checkLinks = true,
) {
  assert.match(
    response.headers()['content-type'] ?? '',
    /text\/html/i,
    `${path} did not deliver HTML.`,
  );
  const style = await page.evaluate(() => {
    const main = document.querySelector('main');
    const heading = main?.querySelector('h1');
    const field = main?.querySelector('input:not([type="hidden"])');
    const button = main?.querySelector('button');
    const link = [...(main?.querySelectorAll('a') ?? [])].find(
      (element) => !element.classList.contains('software-wordmark'),
    );
    const read = (element) => {
      if (!element) return null;
      const computed = getComputedStyle(element);
      return {
        color: computed.color,
        background: computed.backgroundColor,
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        borderRadius: computed.borderRadius,
        textDecoration: computed.textDecorationLine,
      };
    };
    return {
      brand: Object.fromEntries(
        ['plum', 'lilac', 'mint'].map((name) => [
          name,
          main
            ? getComputedStyle(main)
                .getPropertyValue(`--software-${name}`)
                .trim()
            : '',
        ]),
      ),
      styleSheets: [...document.styleSheets].map((sheet) => sheet.href),
      headingCount: main?.querySelectorAll('h1').length ?? 0,
      main: read(main),
      heading: read(heading),
      field: read(field),
      button: read(button),
      link: read(link),
      fontsReady: document.fonts.status,
    };
  });

  assert(style.styleSheets.some(Boolean), `${path} has no browser stylesheet.`);
  assert.deepEqual(
    style.brand,
    { plum: '#291e36', lilac: '#ebe5f2', mint: '#b0f0ce' },
    `${path} must retain Hirearchy Software's established brand palette.`,
  );
  assert.deepEqual(
    assets.filter((asset) => asset.status >= 400),
    [],
    `${path} CSS, font, or JavaScript assets returned an HTTP error.`,
  );
  assert.equal(
    style.headingCount,
    1,
    `${path} must have one visible page heading.`,
  );
  assert(
    assets.some(
      (asset) =>
        asset.status === 200 &&
        /text\/css/i.test(asset.contentType) &&
        new URL(asset.url).origin === origin.origin,
    ),
    `${path} did not load a same-origin CSS response in the browser: ${JSON.stringify(assets)}`,
  );
  if (new URL(page.url()).pathname !== '/r23/login') {
    const csp = response.headers()['content-security-policy'] ?? '';
    for (const policy of [
      "default-src 'none'",
      "style-src 'self'",
      "font-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ]) {
      assert(
        csp.includes(policy),
        `${path} is missing CSP directive ${policy}.`,
      );
    }
    assert(!csp.includes('unsafe-inline'), `${path} weakens inline-style CSP.`);
    assert(
      assets.some(
        (asset) =>
          asset.status === 200 &&
          new URL(asset.url).pathname === '/software-ui.css' &&
          /text\/css/i.test(asset.contentType),
      ),
      `${path} did not load the shared same-origin software stylesheet.`,
    );
    assert(
      assets.some(
        (asset) =>
          asset.status === 200 &&
          new URL(asset.url).pathname === '/fonts/dm-sans-latin.woff2' &&
          /font|woff/i.test(asset.contentType),
      ),
      `${path} did not load the shared same-origin DM Sans font.`,
    );
  }
  assert(
    style.main &&
      style.main.background !== 'rgba(0, 0, 0, 0)' &&
      /dm\s*sans/i.test(style.main.fontFamily),
    `${path} main surface lacks authored background or DM Sans: ${JSON.stringify(style.main)}`,
  );
  assert(
    style.heading &&
      /dm\s*sans/i.test(style.heading.fontFamily) &&
      style.heading.color !== 'rgb(0, 0, 0)' &&
      Number.parseFloat(style.heading.fontSize) > 20,
    `${path} heading lacks authored typography: ${JSON.stringify(style.heading)}`,
  );
  if (style.field) {
    assert(
      Number.parseFloat(style.field.borderRadius) > 0 &&
        style.field.fontFamily !== '"Times New Roman"',
      `${path} field uses browser-default styling: ${JSON.stringify(style.field)}`,
    );
  }
  if (style.button) {
    assert(
      style.button.background !== 'rgba(0, 0, 0, 0)' &&
        style.button.fontFamily !== '"Times New Roman"',
      `${path} button uses browser-default styling: ${JSON.stringify(style.button)}`,
    );
  }
  if (checkLinks && style.link) {
    assert(
      style.link.color !== 'rgb(0, 0, 238)' &&
        /dm\s*sans/i.test(style.link.fontFamily),
      `${path} link uses browser-default styling: ${JSON.stringify(style.link)}`,
    );
  }

  return style;
}

async function postEmptyForm(page, action) {
  const form = page.locator(`form[action="${action}"]`);
  await form.waitFor({ state: 'visible' });
  await form.evaluate((element) => {
    element.noValidate = true;
  });
  const response = await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    form.locator('button[type="submit"]').click(),
  ]).then(([navigation]) => navigation);
  assert(
    response && response.status() >= 400 && response.status() < 500,
    `${action} invalid form submission must be rejected without mutation.`,
  );
  recordExpectedDocumentRejection(response);
  return response;
}

async function postInvalidForm(page, action, fields) {
  await page.evaluate(
    ({ formAction, values }) => {
      const form = document.createElement('form');
      form.id = 'css-delivery-invalid-post';
      form.method = 'post';
      form.action = formAction;
      for (const [name, value] of Object.entries(values)) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.append(input);
      }
      const button = document.createElement('button');
      button.type = 'submit';
      button.textContent = 'Submit invalid test data';
      form.append(button);
      document.body.append(form);
    },
    { formAction: action, values: fields },
  );
  const form = page.locator('#css-delivery-invalid-post');
  const response = await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    form.locator('button').click(),
  ]).then(([navigation]) => navigation);
  assert(
    response && response.status() >= 400 && response.status() < 500,
    `${action} invalid form submission must be rejected without mutation.`,
  );
  recordExpectedDocumentRejection(response);
  return response;
}

try {
  const entryPath = profile === 'founder-uat' ? '/' : '/r23/login';
  const entry = await openPage(entryPath);
  if (profile === 'founder-uat') {
    assert.equal(
      new URL(entry.page.url()).pathname,
      '/r23/login',
      'Founder UAT home must send the browser to login.',
    );
  }
  await assertStyled(entry, `${entryPath} entry state`);

  const routes = [
    '/r23/signup',
    '/r23/verify-email',
    '/r23/verify-email?email=css-check@example.invalid',
    '/r23/recover',
    '/r23/reset-password',
    '/r23/reset-password?error=expired',
    '/r23/reset-password?error=password',
  ];
  for (const route of routes) {
    const result = await openPage(route);
    await assertStyled(result, route);
  }
  await assertStyled(entry, '/r23/login navigation styles');

  const signup = await openPage('/r23/signup');
  await assertStyled(signup, '/r23/signup before invalid POST');
  if (profile === 'founder-uat') {
    await signup.page
      .locator('form[action="/r23/signup"] input[name="email"]')
      .fill('invalid');
    await signup.page
      .locator('form[action="/r23/signup"] input[name="password"]')
      .fill('short');
    await signup.page.locator('form[action="/r23/signup"]').evaluate((form) => {
      form.noValidate = true;
    });
    const signupResponse = await Promise.all([
      signup.page.waitForNavigation({ waitUntil: 'networkidle' }),
      signup.page
        .locator('form[action="/r23/signup"] button[type="submit"]')
        .click(),
    ]).then(([navigation]) => navigation);
    assert(
      signupResponse &&
        signupResponse.status() >= 400 &&
        signupResponse.status() < 500,
      'Invalid signup input must be rejected before any account is created.',
    );
    recordExpectedDocumentRejection(signupResponse);
    await assertStyled(
      { ...signup, response: signupResponse },
      '/r23/signup invalid POST response',
    );
  }

  const recover = await openPage('/r23/recover');
  await assertStyled(recover, '/r23/recover before invalid POST');
  const recoverResponse = await postEmptyForm(recover.page, '/r23/recover');
  await assertStyled(
    { ...recover, response: recoverResponse },
    '/r23/recover invalid POST response',
  );

  const verify = await openPage('/r23/verify-email');
  await assertStyled(verify, '/r23/verify-email before invalid POST');
  const verifyResponse = await postInvalidForm(
    verify.page,
    '/r23/verify-email',
    {
      token: '',
      type: 'signup',
    },
  );
  await assertStyled(
    { ...verify, response: verifyResponse },
    '/r23/verify-email invalid POST response',
  );

  const reset = await openPage('/r23/reset-password');
  await assertStyled(reset, '/r23/reset-password before invalid POST');
  const resetResponse = await postInvalidForm(
    reset.page,
    '/r23/reset-password',
    {
      token: '',
      password: '',
    },
  );
  await assertStyled(
    { ...reset, response: resetResponse },
    '/r23/reset-password invalid POST response',
  );

  assert.deepEqual(
    failures,
    [],
    'CSS, font, or JavaScript assets failed to load.',
  );
  const unexpectedConsoleErrors = consoleErrors.filter((error) => {
    const expectedText = expectedDocumentRejections.some(
      (rejection) =>
        rejection.url === error.url &&
        error.text ===
          `Failed to load resource: the server responded with a status of ${rejection.status} (${rejection.statusText})`,
    );
    return !expectedText;
  });
  assert.deepEqual(
    unexpectedConsoleErrors,
    [],
    'The browser logged errors outside the exact expected 4xx document responses.',
  );
  console.log(
    `${profile} CSS delivery passed at ${origin.origin}: login, account/error GET states, and supported invalid form POST responses.`,
  );
} finally {
  await Promise.all(contexts.map((context) => context.close().catch(() => {})));
  await browser.close().catch(() => {});
}
