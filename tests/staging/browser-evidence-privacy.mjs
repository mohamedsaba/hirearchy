import { chmod, lstat, mkdir, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const CANDIDATE_INVITATION_MASK_SELECTOR =
  '[data-testid="candidate-invitation-link"], [data-testid="candidate-workspace-link"]';

export const APPROVED_BROWSER_EVIDENCE_FILES = Object.freeze([
  '01-recruiter-invitation.png',
  '02-candidate-prestart.png',
  '03-candidate-saved-desktop.png',
  '04-candidate-saved-tablet.png',
  '05-candidate-saved-mobile.png',
  '06-candidate-submitted.png',
  '07-evaluator-chronology.png',
  '08-evaluator-finalized-review.png',
]);

const approvedMaskSelectors = new Set([CANDIDATE_INVITATION_MASK_SELECTOR]);
const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const forbiddenPatterns = [
  /-----BEGIN\s+(?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED)\s+)?PRIVATE KEY-----/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)(?:\+[a-z0-9._-]+)?:\/\/[^\s"'<>]+/i,
  /(?:[?#&](?:access_token|refresh_token|token(?:_hash)?|code)=|\/r23\/auth\/(?:recover|recovery|reset)(?:[/?#]|$)|\b(?:password[\s_-]*recovery|recovery[\s_-]*(?:token|code)|reset[\s_-]*password)\s*[:=])/i,
];

function stringValues(values) {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values.filter((value) => typeof value === 'string' && value.length > 0),
    ),
  ];
}

function renderedValues(surface) {
  return [
    { value: surface.text, maskSelector: null },
    ...surface.urls,
    ...surface.fields,
  ];
}

export function assertNoSensitiveScreenshotContent(
  surface,
  { protectedValues = [], maskableValues = [], maskSelectors = [] } = {},
) {
  if (
    !surface ||
    typeof surface.text !== 'string' ||
    !Array.isArray(surface.fields) ||
    !Array.isArray(surface.urls) ||
    surface.fields.some(
      (field) =>
        !field ||
        typeof field.value !== 'string' ||
        (field.maskSelector !== null && typeof field.maskSelector !== 'string'),
    ) ||
    surface.urls.some(
      (url) =>
        !url ||
        typeof url.value !== 'string' ||
        (url.maskSelector !== null && typeof url.maskSelector !== 'string'),
    )
  ) {
    throw new Error(
      'Screenshot privacy inspection could not read the rendered surface.',
    );
  }

  if (
    !Array.isArray(maskSelectors) ||
    maskSelectors.some((selector) => !approvedMaskSelectors.has(selector))
  ) {
    throw new Error(
      'Screenshot privacy inspection received an unapproved mask.',
    );
  }

  const values = renderedValues(surface);
  const text = values.map((item) => item.value).join('\n');
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(text)) {
      throw new Error(
        'Screenshot privacy inspection found credential-like content.',
      );
    }
  }

  const maskableSet = new Set(stringValues(maskableValues));
  for (const protectedValue of stringValues(protectedValues)) {
    for (const item of values) {
      if (item.value.includes(protectedValue)) {
        throw new Error(
          'Screenshot privacy inspection found a protected value.',
        );
      }
    }
  }
  for (const maskableValue of maskableSet) {
    for (const item of values) {
      if (
        item.value.includes(maskableValue) &&
        (!item.maskSelector || !maskSelectors.includes(item.maskSelector))
      ) {
        throw new Error(
          'Screenshot privacy inspection found an unmasked invitation value.',
        );
      }
    }
  }
}

export async function prepareBrowserEvidenceDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Browser evidence directory is not a regular directory.');
  }
  await chmod(directory, 0o700);
  const entries = await readdir(directory);
  if (entries.length !== 0) {
    throw new Error('Browser evidence directory must be empty before capture.');
  }
}

async function assertPngFile(path) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Browser evidence must contain regular PNG files only.');
  }
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(pngSignature.length);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== pngSignature.length || !header.equals(pngSignature)) {
      throw new Error(
        'Browser evidence contains a file without a PNG signature.',
      );
    }
  } finally {
    await handle.close();
  }
}

export async function assertBrowserEvidenceDirectory(directory) {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Browser evidence directory is not a regular directory.');
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const actualNames = entries.map((entry) => entry.name).sort();
  const expectedNames = [...APPROVED_BROWSER_EVIDENCE_FILES].sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      'Browser evidence directory does not contain exactly eight approved PNGs.',
    );
  }
  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new Error('Browser evidence must contain regular PNG files only.');
    }
    await assertPngFile(join(directory, entry.name));
  }
}
