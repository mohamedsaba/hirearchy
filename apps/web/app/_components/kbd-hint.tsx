import type { ReactNode } from 'react';

export interface KbdHintProps {
  readonly keys?: string | readonly string[];
  readonly label?: string;
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * Token-styled physical keycap hint chip (JetBrains Mono, tabular-nums).
 */
export function KbdHint({
  keys,
  label,
  className = '',
  children,
}: KbdHintProps) {
  if (Array.isArray(keys)) {
    return (
      <span
        className={className ? `ct-kbd-group ${className}` : 'ct-kbd-group'}
        aria-label={label}
      >
        {keys.map((keyCap, index) => (
          <kbd key={`${keyCap}-${index}`} className="ct-kbd">
            {keyCap}
          </kbd>
        ))}
      </span>
    );
  }

  return (
    <kbd
      className={className ? `ct-kbd ${className}` : 'ct-kbd'}
      aria-label={label}
    >
      {children ?? keys}
    </kbd>
  );
}
