import './ai-primitives.css';

export type CommonThreadSparkStatus = 'active' | 'completing' | 'idle';

export interface CommonThreadSparkProps {
  readonly compact?: boolean;
  readonly status?: CommonThreadSparkStatus;
  readonly className?: string;
  readonly label?: string;
}

/**
 * Common Thread geometric spark/orb combining Hirearchy's three weave nodes
 * with an organic starburst and calm completion settle to a mint check.
 */
export function CommonThreadSpark({
  compact = false,
  status = 'active',
  className = '',
  label,
}: CommonThreadSparkProps) {
  const size = compact ? 16 : 28;
  const classes = [
    'ct-ai-spark',
    `ct-ai-spark--${status}`,
    compact ? 'ct-ai-spark--compact' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={classes}
      data-status={status}
      data-compact={compact ? 'true' : 'false'}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 28 28"
        fill="none"
        className="ct-ai-spark-svg"
        aria-hidden="true"
      >
        {status === 'completing' ? (
          <>
            <circle
              className="ct-ai-spark-check-ring"
              cx="14"
              cy="14"
              r="10.5"
              strokeWidth="1.5"
            />
            <path
              className="ct-ai-spark-check"
              d="M9.5 14.3L12.6 17.4L18.8 11.1"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <>
            <circle
              className="ct-ai-spark-halo"
              cx="14"
              cy="14"
              r="11"
              strokeWidth="1.25"
              strokeDasharray="3 2.5"
            />
            <path
              className="ct-ai-spark-star"
              d="M14 5.2C14.7 10.1 17.9 13.3 22.8 14C17.9 14.7 14.7 17.9 14 22.8C13.3 17.9 10.1 14.7 5.2 14C10.1 13.3 13.3 10.1 14 5.2Z"
            />
            <circle
              className="ct-ai-spark-node ct-ai-spark-node--1"
              cx="7.2"
              cy="7.2"
              r="1.6"
            />
            <circle
              className="ct-ai-spark-node ct-ai-spark-node--2"
              cx="20.8"
              cy="7.2"
              r="1.6"
            />
            <circle
              className="ct-ai-spark-node ct-ai-spark-node--3"
              cx="14"
              cy="22.8"
              r="1.6"
            />
          </>
        )}
      </svg>
    </span>
  );
}
