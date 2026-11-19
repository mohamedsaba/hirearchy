import { afterEach, describe, expect, it } from 'vitest';

import {
  detectSyntaxLanguage,
  formatSyntaxLanguageLabel,
  tokenizeCodeLines,
} from '../../apps/web/src/hiring/syntax-highlight';
import { renderSoftwareDocument } from '../../apps/web/src/ui/software-document';

const ORIGINAL_HIRING_FLAG = process.env.HIREARCHY_HIRING_PLATFORM_ENABLED;

afterEach(() => {
  if (ORIGINAL_HIRING_FLAG === undefined) {
    delete process.env.HIREARCHY_HIRING_PLATFORM_ENABLED;
  } else {
    process.env.HIREARCHY_HIRING_PLATFORM_ENABLED = ORIGINAL_HIRING_FLAG;
  }
});

describe('VS Code syntax highlighter', () => {
  it('detects languages from file paths and returns readable labels', () => {
    expect(detectSyntaxLanguage('app/moves.py')).toBe('python');
    expect(formatSyntaxLanguageLabel('python')).toBe('Python');

    expect(detectSyntaxLanguage('src/client.tsx')).toBe('typescript');
    expect(detectSyntaxLanguage('scripts/run.mjs')).toBe('javascript');
    expect(detectSyntaxLanguage('fixtures/sample.json')).toBe('json');
    expect(detectSyntaxLanguage('README.md')).toBe('markdown');
    expect(detectSyntaxLanguage('config/settings.yaml')).toBe('yaml');
    expect(detectSyntaxLanguage('Dockerfile')).toBe('shell');
    expect(detectSyntaxLanguage('styles/main.css')).toBe('css');
    expect(detectSyntaxLanguage('db/schema.sql')).toBe('sql');
    expect(detectSyntaxLanguage('NOTES.txt')).toBe('text');
  });

  it('losslessly tokenizes multi-language code with accurate token kinds', () => {
    const pySource = [
      '"""Multi-line',
      'docstring."""',
      '# Check idempotency',
      '@staticmethod',
      'def apply_move(amount: int) -> int:',
      '    return amount + 42',
    ].join('\n');

    const pyTokens = tokenizeCodeLines(pySource, 'python');
    expect(pyTokens).toHaveLength(6);
    expect(
      pyTokens.map((line) => line.map((t) => t.text).join('')).join('\n'),
    ).toBe(pySource);
    expect(pyTokens[0].every((t) => t.kind === 'string')).toBe(true);
    expect(pyTokens[1].every((t) => t.kind === 'string')).toBe(true);
    expect(pyTokens[2].every((t) => t.kind === 'comment')).toBe(true);
    expect(pyTokens[3][0]).toEqual({ kind: 'function', text: '@staticmethod' });
    expect(pyTokens[4]).toContainEqual({ kind: 'keyword', text: 'def' });
    expect(pyTokens[5]).toContainEqual({ kind: 'keyword', text: 'return' });
    expect(pyTokens[5]).toContainEqual({ kind: 'number', text: '42' });

    const jsonSource =
      '{\n  "status": "ok",\n  "count": 3,\n  "active": true\n}';
    const jsonTokens = tokenizeCodeLines(jsonSource, 'json');
    expect(
      jsonTokens.map((line) => line.map((t) => t.text).join('')).join('\n'),
    ).toBe(jsonSource);
    expect(jsonTokens[1]).toContainEqual({
      kind: 'property',
      text: '"status"',
    });
    expect(jsonTokens[1]).toContainEqual({ kind: 'string', text: '"ok"' });
    expect(jsonTokens[2]).toContainEqual({ kind: 'number', text: '3' });
    expect(jsonTokens[3]).toContainEqual({ kind: 'keyword', text: 'true' });

    const mdSource = '# Overview\nUse `pytest` for **unit tests**.';
    const mdTokens = tokenizeCodeLines(mdSource, 'markdown');
    expect(mdTokens[0][0]).toEqual({ kind: 'heading', text: '# Overview' });
    expect(mdTokens[1]).toContainEqual({ kind: 'string', text: '`pytest`' });
    expect(mdTokens[1]).toContainEqual({
      kind: 'keyword',
      text: '**unit tests**',
    });

    const tsSource =
      '/* block\ncomment */\nconst state: SessionState = init(); // ok';
    const tsTokens = tokenizeCodeLines(tsSource, 'typescript');
    expect(
      tsTokens.map((line) => line.map((t) => t.text).join('')).join('\n'),
    ).toBe(tsSource);
    expect(tsTokens[0][0].kind).toBe('comment');
    expect(tsTokens[1][0].kind).toBe('comment');
    expect(tsTokens[2]).toContainEqual({ kind: 'keyword', text: 'const' });
    expect(tsTokens[2]).toContainEqual({ kind: 'type', text: 'SessionState' });
    expect(tsTokens[2]).toContainEqual({ kind: 'function', text: 'init' });
    expect(tsTokens[2]).toContainEqual({ kind: 'comment', text: '// ok' });
  });
});

describe('renderSoftwareDocument dual-theme and CSP compliance', () => {
  it('defaults to clean light document and emits data-theme="dark" when dark', () => {
    delete process.env.HIREARCHY_HIRING_PLATFORM_ENABLED;
    const lightHtml = renderSoftwareDocument(
      'Workspace',
      '<h1>Assessments</h1>',
    );
    expect(lightHtml).toContain('<html lang="en">');
    expect(lightHtml).not.toContain('data-theme="dark"');

    const darkHtml = renderSoftwareDocument(
      'Workspace',
      '<h1>Assessments</h1>',
      undefined,
      'dark',
    );
    expect(darkHtml).toContain('<html lang="en" data-theme="dark">');
  });

  it('renders a CSP-safe /api/theme POST toggle form without inline script or style', () => {
    process.env.HIREARCHY_HIRING_PLATFORM_ENABLED = 'true';
    const html = renderSoftwareDocument('Team & Plan', '<h1>Team</h1>', {
      organizationId: 'org-1',
      organizationName: 'Acme Corp',
      email: 'owner@acme.test',
      role: 'cto',
      csrf: 'csrf-token',
      active: 'settings',
      theme: 'dark',
      currentPath: '/r23/organizations/org-1/settings',
    });

    expect(html).toContain('<html lang="en" data-theme="dark">');
    expect(html).toContain('action="/api/theme" method="post"');
    expect(html).toContain('name="theme" value="light"');
    expect(html).toContain(
      'name="next" value="/r23/organizations/org-1/settings"',
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\sstyle=/i);
  });
});
