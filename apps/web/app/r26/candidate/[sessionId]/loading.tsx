import { CommonThreadLoader } from '../../../_components/common-thread-loader';

export default function CandidateWorkspaceLoading() {
  return (
    <div
      style={{
        minHeight: '80dvh',
        display: 'grid',
        placeItems: 'center',
        padding: '2rem',
      }}
    >
      <CommonThreadLoader
        stages={[
          'Verifying workspace access…',
          'Restoring saved files & tests…',
        ]}
      />
    </div>
  );
}
