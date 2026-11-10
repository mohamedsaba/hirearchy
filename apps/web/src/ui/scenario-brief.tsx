import type { ReactNode } from 'react';

type ListMarker = Readonly<{
  kind: 'ordered' | 'unordered';
  number: number;
  text: string;
}>;

function listMarker(line: string): ListMarker | null {
  const ordered = /^ {0,3}(\d+)\.\s+(.+)$/.exec(line);
  if (ordered) {
    return {
      kind: 'ordered',
      number: Number(ordered[1]),
      text: ordered[2],
    };
  }
  const unordered = /^ {0,3}-\s+(.+)$/.exec(line);
  return unordered
    ? { kind: 'unordered', number: 1, text: unordered[1] }
    : null;
}

function isFence(line: string): boolean {
  return /^ {0,3}```(?:[A-Za-z0-9_-]+)?\s*$/.test(line);
}

function isBlockStart(line: string): boolean {
  return (
    /^ {0,3}#{1,3}\s+/.test(line) || isFence(line) || listMarker(line) !== null
  );
}

function renderInline(text: string): ReactNode[] {
  const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+?\*\*|\*[^*\n]+?\*)/g;
  const nodes: ReactNode[] = [];
  let offset = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index;
    if (index > offset) nodes.push(text.slice(offset, index));

    if (token.startsWith('`')) {
      nodes.push(<code key={index}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={index}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={index}>{token.slice(1, -1)}</em>);
    }
    offset = index + token.length;
  }

  if (offset < text.length) nodes.push(text.slice(offset));
  return nodes;
}

function heading(line: string, key: string): ReactNode | null {
  const match = /^ {0,3}(#{1,3})\s+(.+?)\s*$/.exec(line);
  if (!match) return null;

  const content = renderInline(match[2]);
  if (match[1].length === 1) return <h2 key={key}>{content}</h2>;
  if (match[1].length === 2) return <h3 key={key}>{content}</h3>;
  return <h4 key={key}>{content}</h4>;
}

export function ScenarioBrief({ markdown }: Readonly<{ markdown: string }>) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (isFence(line)) {
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length && !/^ {0,3}```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre key={`code-${index}`} tabIndex={0} aria-label="Task brief code">
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const renderedHeading = heading(line, `heading-${index}`);
    if (renderedHeading) {
      blocks.push(renderedHeading);
      index += 1;
      continue;
    }

    const firstMarker = listMarker(line);
    if (firstMarker) {
      const items: string[] = [];
      const start = firstMarker.number;
      const kind = firstMarker.kind;

      while (index < lines.length) {
        const marker = listMarker(lines[index]);
        if (!marker || marker.kind !== kind) break;
        const itemLines = [marker.text];
        index += 1;

        while (index < lines.length) {
          const continuation = lines[index];
          if (
            !continuation.trim() ||
            listMarker(continuation) ||
            isBlockStart(continuation)
          ) {
            break;
          }
          itemLines.push(continuation.trim());
          index += 1;
        }
        items.push(itemLines.join(' '));
      }

      const renderedItems = items.map((item, itemIndex) => (
        <li key={`${index}-${itemIndex}`}>{renderInline(item)}</li>
      ));
      blocks.push(
        kind === 'ordered' ? (
          <ol key={`list-${index}`} start={start === 1 ? undefined : start}>
            {renderedItems}
          </ol>
        ) : (
          <ul key={`list-${index}`}>{renderedItems}</ul>
        ),
      );
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isBlockStart(lines[index])
    ) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push(
      <p key={`paragraph-${index}`}>
        {renderInline(paragraphLines.join(' '))}
      </p>,
    );
  }

  return <div className="software-scenario-brief">{blocks}</div>;
}
