import { fixedCode } from './demo';

const keywords =
  /('.*?'|`.*?`|\b(?:import|from|export|async|function|const|if|await|return|true|try|finally)\b|\b\d+\b)/g;
function Syntax({ line }: { line: string }) {
  return (
    <>
      {line.split(keywords).map((part, index) =>
        index % 2 === 0 ? (
          part
        ) : (
          <span
            key={index}
            className={/^['`\d]/.test(part) ? 'syntax-value' : 'syntax-keyword'}
          >
            {part}
          </span>
        ),
      )}
    </>
  );
}

export function CodeRows({
  lines = fixedCode,
  start = 1,
  end = 10,
  highlight = 0,
}: {
  lines?: string[];
  start?: number;
  end?: number;
  highlight?: number;
}) {
  return (
    <div className="code-rows">
      {lines.slice(start - 1, end).map((line, index) => {
        const number = start + index;
        return (
          <div
            className={`code-line ${highlight === number ? 'line-selected' : ''}`}
            key={number}
          >
            <span>{number}</span>
            <code>
              <Syntax line={line} />
            </code>
          </div>
        );
      })}
    </div>
  );
}
