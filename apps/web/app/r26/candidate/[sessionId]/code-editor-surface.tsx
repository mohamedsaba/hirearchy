'use client';

import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';

function fileExtensions(path: string) {
  if (path.endsWith('.py')) return [python()];
  if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(path)) {
    return [javascript({ jsx: path.endsWith('x') })];
  }
  return [];
}

export interface CodeEditorSurfaceProps {
  readonly path: string;
  readonly value: string;
  readonly theme: 'light' | 'dark';
  readonly editable: boolean;
  readonly readOnly: boolean;
  readonly lineWrap: boolean;
  readonly fontSizePx: number;
  readonly onChange: (content: string) => void;
}

export function CodeEditorSurface({
  path,
  value,
  theme,
  editable,
  readOnly,
  lineWrap,
  fontSizePx,
  onChange,
}: CodeEditorSurfaceProps) {
  return (
    <CodeMirror
      aria-label="Edit file"
      theme={theme}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: true,
      }}
      className="r26-code-mirror"
      editable={editable}
      extensions={[
        ...fileExtensions(path),
        ...(lineWrap ? [EditorView.lineWrapping] : []),
        EditorView.theme({
          '&': { fontSize: `${fontSizePx}px` },
          '.cm-scroller': { fontSize: `${fontSizePx}px` },
          '.cm-content': { fontSize: `${fontSizePx}px` },
        }),
        EditorView.contentAttributes.of({
          'aria-label': 'Edit file',
          'aria-readonly': readOnly ? 'true' : 'false',
          spellcheck: 'false',
        }),
      ]}
      onCreateEditor={(view) => {
        if (view.scrollDOM) {
          view.scrollDOM.setAttribute('tabindex', '0');
          view.scrollDOM.setAttribute('role', 'region');
          view.scrollDOM.setAttribute(
            'aria-label',
            'Code editor scrollable area',
          );
        }
      }}
      onChange={onChange}
      readOnly={readOnly}
      value={value}
    />
  );
}
