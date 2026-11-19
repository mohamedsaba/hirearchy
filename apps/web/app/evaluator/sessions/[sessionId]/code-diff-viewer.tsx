'use client';

type DiffRow =
  | Readonly<{
      kind: 'hunk';
      text: string;
    }>
  | Readonly<{
      kind: 'addition' | 'deletion' | 'context' | 'meta';
      oldNum: number | null;
      newNum: number | null;
      sign: string;
      text: string;
    }>;

export function computeDiffStats(diff: string | null | undefined): Readonly<{
  additions: number;
  deletions: number;
}> {
  if (!diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

function parseUnifiedDiff(diff: string): readonly DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const line of diff.split('\n')) {
    if (
      /^={6,}$/.test(line) ||
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      continue;
    }

    const hunkMatch = line.match(
      /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/,
    );
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1], 10);
      newLine = Number.parseInt(hunkMatch[2], 10);
      rows.push({ kind: 'hunk', text: line });
      continue;
    }

    if (line.startsWith('+')) {
      rows.push({
        kind: 'addition',
        oldNum: null,
        newNum: newLine,
        sign: '+',
        text: line.slice(1),
      });
      newLine += 1;
      continue;
    }

    if (line.startsWith('-')) {
      rows.push({
        kind: 'deletion',
        oldNum: oldLine,
        newNum: null,
        sign: '-',
        text: line.slice(1),
      });
      oldLine += 1;
      continue;
    }

    if (line.startsWith('\\')) {
      rows.push({
        kind: 'meta',
        oldNum: null,
        newNum: null,
        sign: ' ',
        text: line,
      });
      continue;
    }

    rows.push({
      kind: 'context',
      oldNum: oldLine,
      newNum: newLine,
      sign: ' ',
      text: line.startsWith(' ') ? line.slice(1) : line,
    });
    oldLine += 1;
    newLine += 1;
  }

  return rows;
}

export const CodeDiffViewer = ({
  diff,
  filePath,
  ariaLabel,
  emptyMessage = 'No net content changes in this file compared to starter.',
}: Readonly<{
  diff: string | null;
  filePath: string;
  ariaLabel?: string;
  emptyMessage?: string;
}>) => {
  const rows = diff ? parseUnifiedDiff(diff) : [];
  const hasChangeRows = rows.some(
    (row) =>
      row.kind === 'addition' || row.kind === 'deletion' || row.kind === 'hunk',
  );

  if (!diff || !hasChangeRows) {
    return (
      <div className="code-viewer-empty">
        <pre
          className="code-diff-pre code-diff-pre-empty"
          tabIndex={0}
          aria-label={ariaLabel ?? `Derived diff for ${filePath}`}
        >
          {emptyMessage}
        </pre>
      </div>
    );
  }

  return (
    <pre
      className="code-diff-pre"
      tabIndex={0}
      aria-label={ariaLabel ?? `Derived diff for ${filePath}`}
    >
      {rows.map((row, index) => {
        if (row.kind === 'hunk') {
          return (
            <span className="code-diff-row is-hunk" key={`hunk-${index}`}>
              <span className="code-diff-num" aria-hidden="true">
                ···
              </span>
              <span className="code-diff-num" aria-hidden="true">
                ···
              </span>
              <code className="code-diff-code">{row.text}</code>
            </span>
          );
        }

        const srPrefix =
          row.kind === 'addition'
            ? 'Added: '
            : row.kind === 'deletion'
              ? 'Removed: '
              : '';

        return (
          <span
            className={`code-diff-row is-${row.kind}`}
            key={`${row.kind}-${index}`}
          >
            <span className="code-diff-num" aria-hidden="true">
              {row.oldNum ?? ''}
            </span>
            <span className="code-diff-num" aria-hidden="true">
              {row.newNum ?? ''}
            </span>
            <code className="code-diff-code">
              {srPrefix ? (
                <span className="visually-hidden">{srPrefix}</span>
              ) : null}
              <span className="code-diff-sign" aria-hidden="true">
                {row.sign}{' '}
              </span>
              {row.text || ' '}
            </code>
          </span>
        );
      })}
    </pre>
  );
};

export const CodeFileViewer = ({
  content,
  ariaLabel,
  emptyMessage,
}: Readonly<{
  content: string | null;
  ariaLabel: string;
  emptyMessage: string;
}>) => {
  if (content === null) {
    return <p className="evaluator-muted-copy">{emptyMessage}</p>;
  }

  const lines = content.split('\n');
  return (
    <pre className="code-file-pre" tabIndex={0} aria-label={ariaLabel}>
      {lines.map((line, index) => (
        <span className="code-file-row" key={index}>
          <span className="code-diff-num" aria-hidden="true">
            {index + 1}
          </span>
          <code className="code-diff-code">{line || ' '}</code>
        </span>
      ))}
    </pre>
  );
};
