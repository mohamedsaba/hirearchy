import { isValidElement, type ReactNode } from 'react';

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

export type ScenarioBriefWorkspaceContext = Readonly<{
  filePaths?: readonly string[];
  testsRunnable?: boolean;
  integratedAiEnabled?: boolean;
}>;

export function reconcileScenarioBriefForWorkspace(
  markdown: string,
  context?: ScenarioBriefWorkspaceContext,
): string {
  if (!context) return markdown;
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const hasReadme =
    !context.filePaths ||
    context.filePaths.some((filePath) =>
      /(?:^|\/)README(?:\.[^/]+)?$/i.test(filePath.trim()),
    );
  const testsDisabled = context.testsRunnable === false;

  const adjustedLines: string[] = [];
  let inFence = false;
  let fenceBuffer: string[] = [];

  for (const line of lines) {
    if (isFence(line)) {
      if (!inFence) {
        inFence = true;
        fenceBuffer = [line];
      } else {
        inFence = false;
        const body = fenceBuffer.slice(1).join('\n');
        if (
          testsDisabled &&
          /^\s*(?:python3?\s+-m\s+pytest|pytest|npm\s+test|pnpm\s+test|npx\s+vitest|yarn\s+test)\b/im.test(
            body,
          )
        ) {
          adjustedLines.push(
            '_In-workspace test execution is disabled for this assessment. Verify your changes directly against the acceptance criteria._',
          );
        } else {
          adjustedLines.push(...fenceBuffer, line);
        }
        fenceBuffer = [];
      }
      continue;
    }

    if (inFence) {
      fenceBuffer.push(line);
      continue;
    }

    let nextLine = line;
    if (!hasReadme) {
      nextLine = nextLine
        .replace(
          /\b(?:document|note|explain|add)\b[^.?!\n]*`?README(?:\.md)?`?[^.?!\n]*(?:\.|(?=\n|$))/gi,
          'Note key design trade-offs in a brief code comment.',
        )
        .replace(/\bin\s+`?README(?:\.md)?`?/gi, 'in a brief code comment')
        .replace(/`?README\.md`?/g, 'code comments');
    }

    if (testsDisabled) {
      nextLine = nextLine
        .replace(
          /\bRun\s+`(?:python3?\s+-m\s+)?pytest[^`]*`/gi,
          'Review your changes against the acceptance criteria (in-workspace test execution is disabled)',
        )
        .replace(
          /\b(?:run|execute)\s+`?(?:python3?\s+-m\s+pytest|pytest|npm\s+test|vitest)`?/gi,
          'verify behavior against the acceptance criteria (test runner disabled)',
        );
    }

    adjustedLines.push(nextLine);
  }

  if (inFence && fenceBuffer.length > 0) {
    adjustedLines.push(...fenceBuffer);
  }

  return adjustedLines.join('\n');
}

export function ScenarioBrief({
  markdown,
  workspaceContext,
  afterIntro,
  collapseAfterIntro = false,
}: Readonly<{
  markdown: string;
  workspaceContext?: ScenarioBriefWorkspaceContext;
  afterIntro?: ReactNode;
  collapseAfterIntro?: boolean;
}>) {
  const reconciled = reconcileScenarioBriefForWorkspace(
    markdown,
    workspaceContext,
  );
  const lines = reconciled.replace(/\r\n?/g, '\n').split('\n');
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

  if (!afterIntro && !collapseAfterIntro) {
    return <div className="software-scenario-brief">{blocks}</div>;
  }

  const introHeading =
    isValidElement(blocks[0]) && blocks[0].type === 'h2' ? 1 : 0;
  let introEnd = introHeading;
  for (const block of blocks.slice(introHeading, introHeading + 2)) {
    if (!isValidElement(block) || block.type !== 'p') break;
    introEnd += 1;
  }
  return (
    <>
      <div className="software-scenario-brief">{blocks.slice(0, introEnd)}</div>
      {afterIntro}
      {collapseAfterIntro && introEnd > 0 && introEnd < blocks.length ? (
        <details className="software-scenario-brief-disclosure">
          <summary>Read full brief</summary>
          <div className="software-scenario-brief">
            {blocks.slice(introEnd)}
          </div>
        </details>
      ) : (
        <div className="software-scenario-brief">{blocks.slice(introEnd)}</div>
      )}
    </>
  );
}
