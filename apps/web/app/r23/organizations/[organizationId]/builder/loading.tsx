import { CommonThreadLoader } from '../../../../_components/common-thread-loader';

export default function BuilderLoading() {
  return (
    <div
      style={{
        padding: 'clamp(1.5rem, 3vw, 2.5rem)',
        display: 'grid',
        gap: '1.25rem',
        maxWidth: '72rem',
        margin: '0 auto',
      }}
    >
      <CommonThreadLoader label="Loading assessment studio…" />
      <div className="ct-skeleton ct-skeleton-title" />
      <div className="ct-skeleton ct-skeleton-card" />
    </div>
  );
}
