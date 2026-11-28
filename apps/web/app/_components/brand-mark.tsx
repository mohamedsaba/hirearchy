export function BrandMark({
  size = 22,
  className = '',
}: Readonly<{ size?: number; className?: string }>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={
        className ? `software-brand-mark ${className}` : 'software-brand-mark'
      }
    >
      <rect width="64" height="64" rx="16" fill="#211426" />
      <rect
        x="0.75"
        y="0.75"
        width="62.5"
        height="62.5"
        rx="15.25"
        stroke="#f5efe6"
        strokeOpacity="0.16"
        strokeWidth="1.5"
      />
      <rect x="17.5" y="15.5" width="7.5" height="33" rx="2.6" fill="#f5efe6" />
      <rect x="39" y="15.5" width="7.5" height="33" rx="2.6" fill="#f5efe6" />
      <path
        d="M 21 28.5 H 30.5 C 35.8 28.5 39 25.3 39 20 H 42 V 44 H 39 C 39 38.7 35.8 35.5 30.5 35.5 H 21 Z"
        fill="#f5efe6"
      />
      <rect x="26" y="29.8" width="12" height="4.4" rx="2.2" fill="#8ee3b8" />
    </svg>
  );
}
