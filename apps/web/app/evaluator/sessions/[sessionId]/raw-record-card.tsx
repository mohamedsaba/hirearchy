import type { ReconstructionItem } from '../../../../src/evidence/chronological-reconstruction';

export const RawRecordCard = ({
  item,
}: Readonly<{ item: ReconstructionItem }>) => {
  const records =
    item.kind === 'COMMAND_EXECUTION'
      ? [item.rawStartedEvent, item.rawFinishedEvent].filter(
          (event) => event !== undefined,
        )
      : item.kind === 'WORKSPACE_CHANGE' ||
          item.kind === 'WORKSPACE_GAP' ||
          item.kind === 'SANDBOX_CLEANUP_FAILURE'
        ? [item.rawEvent]
        : [];

  if (records.length === 0) return null;

  return (
    <article className="raw-record-card">
      <p className="activity-label">Recorded platform data</p>
      {records.map((record) => (
        <pre
          key={record.id}
          tabIndex={0}
          aria-label={`Recorded platform data for event ${record.id}`}
        >
          {JSON.stringify(record, null, 2)}
        </pre>
      ))}
    </article>
  );
};
