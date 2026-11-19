export type SyntaxLanguage =
  | 'python'
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'markdown'
  | 'yaml'
  | 'shell'
  | 'css'
  | 'sql'
  | 'text';

export type SyntaxTokenKind =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'function'
  | 'type'
  | 'operator'
  | 'property'
  | 'heading'
  | 'punctuation'
  | 'plain';

export interface SyntaxToken {
  readonly kind: SyntaxTokenKind;
  readonly text: string;
}

const LANGUAGE_LABELS: Record<SyntaxLanguage, string> = {
  python: 'Python',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  json: 'JSON',
  markdown: 'Markdown',
  yaml: 'YAML',
  shell: 'Shell',
  css: 'CSS',
  sql: 'SQL',
  text: 'Plain Text',
};

export function detectSyntaxLanguage(filePath: string): SyntaxLanguage {
  const normalized = filePath.trim().toLowerCase();
  const base = normalized.split('/').pop() ?? normalized;

  if (base.endsWith('.py') || base.endsWith('.pyi')) return 'python';
  if (base.endsWith('.ts') || base.endsWith('.tsx')) return 'typescript';
  if (
    base.endsWith('.js') ||
    base.endsWith('.jsx') ||
    base.endsWith('.mjs') ||
    base.endsWith('.cjs')
  ) {
    return 'javascript';
  }
  if (base.endsWith('.json') || base.endsWith('.jsonc')) return 'json';
  if (base.endsWith('.md') || base.endsWith('.mdx')) return 'markdown';
  if (base.endsWith('.yml') || base.endsWith('.yaml')) return 'yaml';
  if (
    base.endsWith('.sh') ||
    base.endsWith('.bash') ||
    base.endsWith('.zsh') ||
    base === 'dockerfile' ||
    base === 'makefile'
  ) {
    return 'shell';
  }
  if (base.endsWith('.css') || base.endsWith('.scss')) return 'css';
  if (base.endsWith('.sql')) return 'sql';
  return 'text';
}

export function formatSyntaxLanguageLabel(language: SyntaxLanguage): string {
  return LANGUAGE_LABELS[language];
}

const PYTHON_KEYWORDS = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
  'match',
  'case',
  'self',
  'cls',
]);

const JS_TS_KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'of',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'yield',
]);

const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'in',
  'do',
  'done',
  'case',
  'esac',
  'while',
  'function',
  'export',
  'local',
  'return',
  'exit',
  'echo',
  'set',
  'true',
  'false',
]);

const SQL_KEYWORDS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'INSERT',
  'INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
  'CREATE',
  'ALTER',
  'DROP',
  'TABLE',
  'INDEX',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'ON',
  'AS',
  'AND',
  'OR',
  'NOT',
  'NULL',
  'TRUE',
  'FALSE',
  'ORDER',
  'BY',
  'GROUP',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'RETURNING',
  'BEGIN',
  'COMMIT',
]);

function pushToken(tokens: SyntaxToken[], kind: SyntaxTokenKind, text: string) {
  if (!text) return;
  const previous = tokens[tokens.length - 1];
  if (previous && previous.kind === kind) {
    tokens[tokens.length - 1] = { kind, text: previous.text + text };
  } else {
    tokens.push({ kind, text });
  }
}

function tokenizeMarkdownLine(line: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  if (/^\s*#{1,6}\s/.test(line)) {
    tokens.push({ kind: 'heading', text: line });
    return tokens;
  }
  if (/^\s*```/.test(line)) {
    tokens.push({ kind: 'comment', text: line });
    return tokens;
  }
  if (/^\s*>\s?/.test(line)) {
    tokens.push({ kind: 'comment', text: line });
    return tokens;
  }

  let i = 0;
  const listMatch = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)/);
  if (listMatch) {
    pushToken(tokens, 'operator', listMatch[1]);
    i = listMatch[1].length;
  }

  while (i < line.length) {
    if (line[i] === '`') {
      const end = line.indexOf('`', i + 1);
      if (end !== -1) {
        pushToken(tokens, 'string', line.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }
    if (line.startsWith('**', i)) {
      const end = line.indexOf('**', i + 2);
      if (end !== -1) {
        pushToken(tokens, 'keyword', line.slice(i, end + 2));
        i = end + 2;
        continue;
      }
    }
    if (line[i] === '[' && line.indexOf('](', i) !== -1) {
      const closeBracket = line.indexOf('](', i);
      const closeParen = line.indexOf(')', closeBracket + 2);
      if (closeParen !== -1) {
        pushToken(tokens, 'function', line.slice(i, closeBracket + 1));
        pushToken(tokens, 'punctuation', '](');
        pushToken(tokens, 'property', line.slice(closeBracket + 2, closeParen));
        pushToken(tokens, 'punctuation', ')');
        i = closeParen + 1;
        continue;
      }
    }
    const nextSpecial = line.slice(i + 1).search(/[`*[]/);
    const end = nextSpecial === -1 ? line.length : i + 1 + nextSpecial;
    pushToken(tokens, 'plain', line.slice(i, end));
    i = end;
  }

  return tokens;
}

function scanQuoted(line: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === '\\') {
      i += 2;
      continue;
    }
    if (line[i] === quote) {
      return i + 1;
    }
    i += 1;
  }
  return line.length;
}

function getKeywordSet(language: SyntaxLanguage): Set<string> | null {
  switch (language) {
    case 'python':
      return PYTHON_KEYWORDS;
    case 'typescript':
    case 'javascript':
      return JS_TS_KEYWORDS;
    case 'shell':
      return SHELL_KEYWORDS;
    case 'sql':
      return SQL_KEYWORDS;
    case 'json':
      return new Set(['true', 'false', 'null']);
    default:
      return null;
  }
}

export function tokenizeCodeLines(
  source: string,
  language: SyntaxLanguage,
): SyntaxToken[][] {
  const rawLines = source.replace(/\r\n/g, '\n').split('\n');
  if (language === 'text') {
    return rawLines.map((line) =>
      line ? [{ kind: 'plain', text: line }] : [],
    );
  }
  if (language === 'markdown') {
    return rawLines.map(tokenizeMarkdownLine);
  }

  const keywords = getKeywordSet(language);
  const supportsSlashComment =
    language === 'javascript' ||
    language === 'typescript' ||
    language === 'css' ||
    language === 'json';
  const supportsHashComment =
    language === 'python' || language === 'yaml' || language === 'shell';
  const supportsBlockSlashComment =
    language === 'javascript' ||
    language === 'typescript' ||
    language === 'css';
  const supportsPythonTripleQuote = language === 'python';

  let activeBlockTerminator: '*/' | '"""' | "'''" | null = null;

  return rawLines.map((line) => {
    const tokens: SyntaxToken[] = [];
    let i = 0;

    while (i < line.length) {
      if (activeBlockTerminator) {
        const end = line.indexOf(activeBlockTerminator, i);
        const kind: SyntaxTokenKind =
          activeBlockTerminator === '*/' ? 'comment' : 'string';
        if (end === -1) {
          pushToken(tokens, kind, line.slice(i));
          break;
        }
        const closeIndex = end + activeBlockTerminator.length;
        pushToken(tokens, kind, line.slice(i, closeIndex));
        activeBlockTerminator = null;
        i = closeIndex;
        continue;
      }

      if (supportsHashComment && line[i] === '#') {
        pushToken(tokens, 'comment', line.slice(i));
        break;
      }
      if (language === 'sql' && line.startsWith('--', i)) {
        pushToken(tokens, 'comment', line.slice(i));
        break;
      }
      if (supportsSlashComment && line.startsWith('//', i)) {
        pushToken(tokens, 'comment', line.slice(i));
        break;
      }
      if (supportsBlockSlashComment && line.startsWith('/*', i)) {
        const end = line.indexOf('*/', i + 2);
        if (end === -1) {
          pushToken(tokens, 'comment', line.slice(i));
          activeBlockTerminator = '*/';
          break;
        }
        pushToken(tokens, 'comment', line.slice(i, end + 2));
        i = end + 2;
        continue;
      }

      if (
        supportsPythonTripleQuote &&
        (line.startsWith('"""', i) || line.startsWith("'''", i))
      ) {
        const delim = line.startsWith('"""', i) ? '"""' : "'''";
        const end = line.indexOf(delim, i + 3);
        if (end === -1) {
          pushToken(tokens, 'string', line.slice(i));
          activeBlockTerminator = delim;
          break;
        }
        pushToken(tokens, 'string', line.slice(i, end + 3));
        i = end + 3;
        continue;
      }

      if (line[i] === '"' || line[i] === "'" || line[i] === '`') {
        const end = scanQuoted(line, i, line[i]);
        const literal = line.slice(i, end);
        const restAfter = line.slice(end).trimStart();
        const isJsonKey =
          (language === 'json' ||
            language === 'typescript' ||
            language === 'javascript') &&
          line[i] === '"' &&
          restAfter.startsWith(':');
        pushToken(tokens, isJsonKey ? 'property' : 'string', literal);
        i = end;
        continue;
      }

      if (language === 'python' && line[i] === '@' && i === line.search(/\S/)) {
        const match = line.slice(i).match(/^@[A-Za-z_][A-Za-z0-9_.]*/);
        if (match) {
          pushToken(tokens, 'function', match[0]);
          i += match[0].length;
          continue;
        }
      }

      if (/\d/.test(line[i])) {
        const numMatch = line
          .slice(i)
          .match(
            /^(?:0x[0-9a-fA-F_]+|0b[01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)/,
          );
        if (numMatch) {
          pushToken(tokens, 'number', numMatch[0]);
          i += numMatch[0].length;
          continue;
        }
      }

      if (/[A-Za-z_$]/.test(line[i])) {
        const idMatch = line.slice(i).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
        if (idMatch) {
          const word = idMatch[0];
          const nextNonSpace = line
            .slice(i + word.length)
            .match(/^\s*(.)/)?.[1];
          const afterColon =
            language === 'yaml' && line.slice(i + word.length).startsWith(':');
          let kind: SyntaxTokenKind = 'plain';
          if (afterColon) {
            kind = 'property';
          } else if (
            keywords?.has(language === 'sql' ? word.toUpperCase() : word)
          ) {
            kind = 'keyword';
          } else if (nextNonSpace === '(') {
            kind = 'function';
          } else if (/^[A-Z][A-Za-z0-9_]*$/.test(word)) {
            kind = 'type';
          }
          pushToken(tokens, kind, word);
          i += word.length;
          continue;
        }
      }

      if (/[{}()[\],.;:]/.test(line[i])) {
        pushToken(tokens, 'punctuation', line[i]);
        i += 1;
        continue;
      }

      if (/[=<>!+\-*/%&|^~?]/.test(line[i])) {
        pushToken(tokens, 'operator', line[i]);
        i += 1;
        continue;
      }

      const plainMatch = line
        .slice(i)
        .match(/^[^\w\s"'`#/{}()[\],.;:=<>!+\-*&|^~?@]+|^\s+/);
      const chunk = plainMatch ? plainMatch[0] : line[i];
      pushToken(tokens, 'plain', chunk);
      i += chunk.length;
    }

    return tokens;
  });
}
