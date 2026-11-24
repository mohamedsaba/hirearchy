import { CommonThreadLoader } from '../_components/common-thread-loader';

export default function CandidatePortalLoading() {
  return (
    <div
      style={{
        minHeight: '70dvh',
        display: 'grid',
        placeItems: 'center',
        padding: '2rem',
      }}
    >
      <div
        style={{ display: 'grid', gap: '1.25rem', width: 'min(40rem, 100%)' }}
      >
        <CommonThreadLoader label="Loading your assessments…" />
        <div className="ct-skeleton ct-skeleton-card" />
        <div className="ct-skeleton ct-skeleton-card" />
      </div>
    </div>
  );
}
