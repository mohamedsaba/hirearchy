'use client';

import { useMemo, useState } from 'react';
import {
  detectSyntaxLanguage,
  formatSyntaxLanguageLabel,
  tokenizeCodeLines,
  type SyntaxLanguage,
} from '../../../../../src/hiring/syntax-highlight';

export interface VsCodeFileEntry {
  readonly path: string;
  readonly content: string;
}

interface TreeNode {
  readonly name: string;
  readonly path: string;
  readonly isDir: boolean;
  readonly children: TreeNode[];
}

function buildFileTree(paths: readonly string[]): TreeNode[] {
  type MutableNode = {
    name: string;
    path: string;
    isDir: boolean;
    children: Map<string, MutableNode>;
  };

  const root: Map<string, MutableNode> = new Map();

  for (const rawPath of paths) {
    const clean = rawPath.replace(/^\/+/, '');
    const parts = clean.split('/').filter(Boolean);
    let current = root;
    let accum = '';
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      accum = accum ? `${accum}/${part}` : part;
      const isDir = index < parts.length - 1;
      let existing = current.get(part);
      if (!existing) {
        existing = {
          name: part,
          path: isDir ? `${accum}/` : clean,
          isDir,
          children: new Map(),
        };
        current.set(part, existing);
      }
      current = existing.children;
    }
  }

  function toSortedArray(map: Map<string, MutableNode>): TreeNode[] {
    return Array.from(map.values())
      .map((node) => ({
        name: node.name,
        path: node.path,
        isDir: node.isDir,
        children: toSortedArray(node.children),
      }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  return toSortedArray(root);
}

function getFileBadge(
  filePath: string,
  language: SyntaxLanguage,
): { code: string; tone: string } {
  const lower = filePath.toLowerCase();
  if (language === 'python') return { code: 'PY', tone: 'py' };
  if (language === 'markdown') return { code: 'MD', tone: 'md' };
  if (language === 'json') return { code: 'JSON', tone: 'json' };
  if (language === 'typescript') return { code: 'TS', tone: 'ts' };
  if (language === 'javascript') return { code: 'JS', tone: 'js' };
  if (language === 'yaml') return { code: 'YML', tone: 'yml' };
  if (language === 'shell') return { code: 'SH', tone: 'sh' };
  if (language === 'sql') return { code: 'SQL', tone: 'sql' };
  if (lower.endsWith('.txt')) return { code: 'TXT', tone: 'txt' };
  return { code: 'FILE', tone: 'txt' };
}

export function VsCodeFileInspector({
  files,
  workspaceName = 'candidate-repo',
  activePath,
  onSelectPath,
}: Readonly<{
  files: readonly VsCodeFileEntry[];
  workspaceName?: string;
  activePath?: string;
  onSelectPath?: (path: string) => void;
}>) {
  const [internalSelected, setInternalSelected] = useState<string>(
    files[0]?.path ?? '',
  );
  const [openTabs, setOpenTabs] = useState<string[]>(() =>
    files.slice(0, 5).map((f) => f.path),
  );
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>(
    {},
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [wordWrap, setWordWrap] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [activeLine, setActiveLine] = useState<number>(1);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const selectedPath =
    activePath && files.some((f) => f.path === activePath)
      ? activePath
      : files.some((f) => f.path === internalSelected)
        ? internalSelected
        : (files[0]?.path ?? '');

  const selectedFile =
    files.find((f) => f.path === selectedPath) ?? files[0] ?? null;

  const filteredPaths = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    if (!query) return files.map((f) => f.path);
    return files
      .filter((f) => f.path.toLowerCase().includes(query))
      .map((f) => f.path);
  }, [files, filterText]);

  const tree = useMemo(() => buildFileTree(filteredPaths), [filteredPaths]);

  const effectiveTabs = useMemo(() => {
    const existing = openTabs.filter((tabPath) =>
      files.some((f) => f.path === tabPath),
    );
    if (selectedPath && !existing.includes(selectedPath)) {
      return [...existing, selectedPath];
    }
    return existing.length > 0
      ? existing
      : files.slice(0, 1).map((f) => f.path);
  }, [files, openTabs, selectedPath]);

  const detectedLanguage = useMemo(
    () =>
      selectedFile
        ? detectSyntaxLanguage(selectedFile.path)
        : ('text' as const),
    [selectedFile],
  );

  const tokenizedLines = useMemo(
    () =>
      selectedFile
        ? tokenizeCodeLines(selectedFile.content, detectedLanguage)
        : [],
    [selectedFile, detectedLanguage],
  );

  function selectFile(path: string) {
    setInternalSelected(path);
    setActiveLine(1);
    onSelectPath?.(path);
    setOpenTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
  }

  function closeTab(tabPath: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (effectiveTabs.length <= 1) return;
    const remaining = effectiveTabs.filter((p) => p !== tabPath);
    setOpenTabs(remaining);
    if (tabPath === selectedPath && remaining.length > 0) {
      selectFile(remaining[remaining.length - 1]);
    }
  }

  function toggleDir(dirPath: string) {
    setCollapsedDirs((prev) => ({
      ...prev,
      [dirPath]: !prev[dirPath],
    }));
  }

  async function handleCopy() {
    if (!selectedFile || typeof navigator === 'undefined') return;
    try {
      await navigator.clipboard.writeText(selectedFile.content);
      setCopiedPath(selectedFile.path);
      setTimeout(() => {
        setCopiedPath((prev) => (prev === selectedFile.path ? null : prev));
      }, 1800);
    } catch {
      // Clipboard may be unavailable in restricted contexts.
    }
  }

  function renderTreeNodes(nodes: readonly TreeNode[], depth = 0) {
    return nodes.map((node) => {
      if (node.isDir) {
        const isCollapsed = Boolean(collapsedDirs[node.path]) && !filterText;
        return (
          <div key={node.path} className="hiring-vsc-tree-branch">
            <button
              type="button"
              className="hiring-vsc-tree-dir"
              onClick={() => toggleDir(node.path)}
              aria-expanded={!isCollapsed}
              data-depth={depth}
            >
              <span
                className={`hiring-vsc-chevron${isCollapsed ? '' : ' is-open'}`}
                aria-hidden="true"
              >
                ›
              </span>
              <span className="hiring-vsc-folder-glyph" aria-hidden="true">
                {isCollapsed ? '▸' : '▾'}
              </span>
              <span className="hiring-vsc-tree-name">{node.name}</span>
            </button>
            {!isCollapsed ? (
              <div className="hiring-vsc-tree-children">
                {renderTreeNodes(node.children, depth + 1)}
              </div>
            ) : null}
          </div>
        );
      }

      const lang = detectSyntaxLanguage(node.path);
      const badge = getFileBadge(node.path, lang);
      const isSelected = node.path === selectedPath;

      return (
        <button
          key={node.path}
          type="button"
          className={`hiring-vsc-tree-file${isSelected ? ' is-active' : ''}`}
          onClick={() => selectFile(node.path)}
          aria-current={isSelected ? 'true' : undefined}
          title={node.path}
        >
          <span
            className={`hiring-vsc-ext-badge is-${badge.tone}`}
            aria-hidden="true"
          >
            {badge.code}
          </span>
          <span className="hiring-vsc-tree-name">{node.name}</span>
        </button>
      );
    });
  }

  if (files.length === 0 || !selectedFile) {
    return (
      <div className="hiring-vsc-empty">
        No repository files have been added yet. Generate with Kimi K3.1 Pro or
        pick a catalog scenario to preview the candidate repository.
      </div>
    );
  }

  const breadcrumbs = selectedFile.path.split('/').filter(Boolean);
  const clampedActiveLine = Math.min(activeLine, tokenizedLines.length || 1);

  return (
    <div
      className="hiring-vsc-shell"
      role="region"
      aria-label="Repository file inspector"
    >
      <div className="hiring-vsc-titlebar">
        <div className="hiring-vsc-window-dots" aria-hidden="true">
          <span className="dot-rose" />
          <span className="dot-amber" />
          <span className="dot-mint" />
        </div>
        <span className="hiring-vsc-title">
          {workspaceName} — {files.length}{' '}
          {files.length === 1 ? 'file' : 'files'}
        </span>
        <div className="hiring-vsc-toolbar">
          <button
            type="button"
            className={`hiring-vsc-toolbtn${sidebarOpen ? ' is-pressed' : ''}`}
            onClick={() => setSidebarOpen((prev) => !prev)}
            aria-pressed={sidebarOpen}
            title="Toggle file explorer"
          >
            Explorer
          </button>
          <button
            type="button"
            className={`hiring-vsc-toolbtn${wordWrap ? ' is-pressed' : ''}`}
            onClick={() => setWordWrap((prev) => !prev)}
            aria-pressed={wordWrap}
            title="Toggle word wrap"
          >
            Wrap
          </button>
          <button
            type="button"
            className="hiring-vsc-toolbtn"
            onClick={handleCopy}
            title="Copy file contents"
          >
            {copiedPath === selectedFile.path ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
      </div>

      <div
        className={`hiring-vsc-body${sidebarOpen ? '' : ' is-sidebar-collapsed'}`}
      >
        {sidebarOpen ? (
          <aside className="hiring-vsc-explorer" aria-label="Explorer">
            <div className="hiring-vsc-explorer-head">
              <span>Explorer</span>
              <span>{filteredPaths.length}</span>
            </div>
            {files.length > 3 ? (
              <div className="hiring-vsc-filter">
                <input
                  type="search"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder="Filter files..."
                  aria-label="Filter repository files"
                />
              </div>
            ) : null}
            <div className="hiring-vsc-tree" role="tree">
              {renderTreeNodes(tree)}
            </div>
          </aside>
        ) : null}

        <div className="hiring-vsc-editor-col">
          <div className="hiring-vsc-tabs" role="tablist">
            {effectiveTabs.map((tabPath) => {
              const name = tabPath.split('/').pop() ?? tabPath;
              const lang = detectSyntaxLanguage(tabPath);
              const badge = getFileBadge(tabPath, lang);
              const isActive = tabPath === selectedFile.path;
              return (
                <div
                  key={tabPath}
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={0}
                  className={`hiring-vsc-tab${isActive ? ' is-active' : ''}`}
                  onClick={() => selectFile(tabPath)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectFile(tabPath);
                    }
                  }}
                >
                  <span
                    className={`hiring-vsc-ext-badge is-${badge.tone}`}
                    aria-hidden="true"
                  >
                    {badge.code}
                  </span>
                  <span className="hiring-vsc-tab-label">{name}</span>
                  {effectiveTabs.length > 1 ? (
                    <button
                      type="button"
                      className="hiring-vsc-tab-close"
                      onClick={(e) => closeTab(tabPath, e)}
                      aria-label={`Close ${name}`}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="hiring-vsc-breadcrumb">
            <span>{workspaceName}</span>
            {breadcrumbs.map((segment, index) => (
              <span key={`${segment}-${index}`} className="hiring-vsc-crumb">
                <span className="hiring-vsc-crumb-sep" aria-hidden="true">
                  /
                </span>
                <span
                  className={
                    index === breadcrumbs.length - 1 ? 'is-leaf' : undefined
                  }
                >
                  {segment}
                </span>
              </span>
            ))}
          </div>

          <div
            className={`hiring-vsc-code-scroll${wordWrap ? ' is-wrapped' : ''}`}
          >
            <div className="hiring-vsc-code-lines" role="presentation">
              {tokenizedLines.map((lineTokens, lineIdx) => {
                const lineNum = lineIdx + 1;
                const isActiveLine = lineNum === clampedActiveLine;
                return (
                  <div
                    key={lineNum}
                    className={`hiring-vsc-line${isActiveLine ? ' is-active-line' : ''}`}
                    onClick={() => setActiveLine(lineNum)}
                  >
                    <span className="hiring-vsc-gutter" aria-hidden="true">
                      {lineNum}
                    </span>
                    <span className="hiring-vsc-code-content">
                      {lineTokens.length === 0
                        ? '\u00a0'
                        : lineTokens.map((tok, tokIdx) => (
                            <span key={tokIdx} className={`tok-${tok.kind}`}>
                              {tok.text}
                            </span>
                          ))}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <footer className="hiring-vsc-statusbar">
        <div className="hiring-vsc-status-left">
          <span className="hiring-vsc-status-pill">Candidate Workspace</span>
          <span className="hiring-vsc-status-path">{selectedFile.path}</span>
        </div>
        <div className="hiring-vsc-status-right">
          <span>
            Ln {clampedActiveLine}, {tokenizedLines.length} lines
          </span>
          <span>UTF-8</span>
          <span>{formatSyntaxLanguageLabel(detectedLanguage)}</span>
        </div>
      </footer>
    </div>
  );
}
