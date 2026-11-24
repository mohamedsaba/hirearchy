'use client';

import { useId, useMemo, useState } from 'react';
import { IconCode, IconFileCode, IconFolder, IconX } from '@tabler/icons-react';
import {
  detectSyntaxLanguage,
  formatSyntaxLanguageLabel,
  tokenizeCodeLines,
} from '../../../../../src/hiring/syntax-highlight';

type PreviewFile = Readonly<{ path: string; content: string }>;

function FilesTree({
  files,
  activePath,
  prefix = '',
  select,
}: {
  files: readonly PreviewFile[];
  activePath: string;
  prefix?: string;
  select: (path: string) => void;
}) {
  const folders = new Map<string, PreviewFile[]>();
  const leafFiles: PreviewFile[] = [];
  for (const file of files) {
    const relative = file.path.slice(prefix.length);
    const separator = relative.indexOf('/');
    if (separator === -1) {
      leafFiles.push(file);
    } else {
      const folder = relative.slice(0, separator);
      const entries = folders.get(folder) ?? [];
      entries.push(file);
      folders.set(folder, entries);
    }
  }

  return (
    <ul className="software-repo-tree">
      {[...folders]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entries]) => (
          <li key={name}>
            <details open>
              <summary title={prefix + name}>
                <IconFolder size={15} aria-hidden="true" />
                <span>{name}</span>
              </summary>
              <FilesTree
                files={entries}
                activePath={activePath}
                prefix={`${prefix}${name}/`}
                select={select}
              />
            </details>
          </li>
        ))}
      {leafFiles.map((file) => (
        <li key={file.path}>
          <button
            type="button"
            className="software-repo-file"
            aria-current={file.path === activePath ? 'true' : undefined}
            title={file.path}
            onClick={() => select(file.path)}
          >
            <IconFileCode size={15} aria-hidden="true" />
            <span>{file.path.slice(prefix.length)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function RepositoryInspector({
  files,
  workspaceName,
  activePath,
  onSelectPath,
  label = 'Repository preview',
}: {
  files: readonly PreviewFile[];
  workspaceName: string;
  activePath?: string;
  onSelectPath?: (path: string) => void;
  label?: string;
}) {
  const inputId = useId();
  const [selectedPath, setSelectedPath] = useState('');
  const changePath = onSelectPath ?? setSelectedPath;
  const [filter, setFilter] = useState('');
  const [wrap, setWrap] = useState(false);
  const [opened, setOpened] = useState<string[]>([]);
  const [copyMessage, setCopyMessage] = useState('');
  const selected =
    files.find((file) => file.path === (activePath ?? selectedPath)) ??
    files[0];
  const language = detectSyntaxLanguage(selected?.path ?? '');
  const lines = useMemo(
    () => tokenizeCodeLines(selected?.content ?? '', language),
    [selected?.content, language],
  );

  if (!selected)
    return (
      <p className="hiring-muted-copy">This problem has no starter files.</p>
    );

  const availablePaths = new Set(files.map((file) => file.path));
  const tabs = [
    ...new Set([
      ...opened.filter((path) => availablePaths.has(path)),
      selected.path,
    ]),
  ];
  const visibleFiles = files.filter((file) =>
    file.path.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  function select(path: string) {
    if (!availablePaths.has(path)) return;
    changePath(path);
    setOpened([...new Set([...tabs, path])]);
    setCopyMessage('');
  }

  function close(path: string) {
    const remaining = tabs.filter((tab) => tab !== path);
    if (remaining.length === 0) return;
    setOpened(remaining);
    if (path === selected?.path) {
      changePath(remaining[Math.max(0, tabs.indexOf(path) - 1)]);
      setCopyMessage('');
    }
  }

  async function copyFile() {
    try {
      await navigator.clipboard.writeText(selected?.content ?? '');
      setCopyMessage('Copied');
    } catch {
      setCopyMessage('Clipboard unavailable');
    }
  }

  return (
    <section className="software-repository" aria-label={label}>
      <header className="software-repo-bar">
        <div className="software-repo-name">
          <IconCode size={18} aria-hidden="true" />
          <strong>{workspaceName}</strong>
        </div>
        <div className="software-repo-actions">
          <button
            type="button"
            aria-pressed={wrap}
            onClick={() => setWrap(!wrap)}
          >
            Wrap lines
          </button>
          <button type="button" onClick={() => void copyFile()}>
            Copy file
          </button>
          {copyMessage ? <span role="status">{copyMessage}</span> : null}
        </div>
      </header>
      <label className="software-repo-mobile-file" htmlFor={inputId}>
        File
        <select
          id={inputId}
          value={selected.path}
          onChange={(event) => select(event.target.value)}
        >
          {files.map((file) => (
            <option key={file.path} value={file.path}>
              {file.path}
            </option>
          ))}
        </select>
      </label>
      <div className="software-repo-body">
        <aside className="software-repo-files" aria-label="Repository files">
          <h3>
            Files <span>{files.length}</span>
          </h3>
          <input
            type="search"
            aria-label="Filter repository files"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find a file"
          />
          {visibleFiles.length ? (
            <FilesTree
              files={visibleFiles}
              activePath={selected.path}
              select={select}
            />
          ) : (
            <p role="status">No matching files.</p>
          )}
        </aside>
        <div className="software-repo-editor">
          <div
            className="software-repo-tabs"
            role="group"
            aria-label="Open files"
          >
            {tabs.map((path) => (
              <div
                className="software-repo-tab"
                data-selected={path === selected.path}
                key={path}
              >
                <button
                  type="button"
                  title={path}
                  aria-current={path === selected.path ? 'true' : undefined}
                  onClick={() => select(path)}
                >
                  {path.split('/').at(-1)}
                </button>
                {tabs.length > 1 ? (
                  <button
                    type="button"
                    className="software-repo-close"
                    aria-label={`Close ${path}`}
                    onClick={() => close(path)}
                  >
                    <IconX size={14} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <div className="software-repo-path">{selected.path}</div>
          <div
            className="software-repo-code"
            role="region"
            aria-label={`Contents of ${selected.path}`}
            tabIndex={0}
            data-wrap={wrap}
          >
            {lines.map((line, index) => (
              <div className="software-repo-line" key={index}>
                <span aria-hidden="true">{index + 1}</span>
                <code>
                  {line.length
                    ? line.map((token, tokenIndex) => (
                        <span key={tokenIndex} className={`tok-${token.kind}`}>
                          {token.text}
                        </span>
                      ))
                    : '\u00a0'}
                </code>
              </div>
            ))}
          </div>
          <footer className="software-repo-status">
            <span>Read only</span>
            <span>
              {formatSyntaxLanguageLabel(language)} · {lines.length}{' '}
              {lines.length === 1 ? 'line' : 'lines'}
            </span>
          </footer>
        </div>
      </div>
    </section>
  );
}
