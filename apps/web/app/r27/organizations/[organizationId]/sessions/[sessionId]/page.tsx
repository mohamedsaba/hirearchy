import '../../../../../evaluator/sessions/[sessionId]/task-review.css';

import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { EvaluatorExperience } from '../../../../../evaluator/sessions/[sessionId]/evaluator-experience';
import { r27EvidenceApiGet } from '../../../../../../src/r23-auth/server';
import { r27IsEnabled } from '../../../../../../src/r27-evidence/config';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export default async function R27EvidencePage({
  params,
}: {
  params: Promise<{ organizationId: string; sessionId: string }>;
}) {
  if (!r27IsEnabled()) notFound();
  const { organizationId, sessionId } = await params;
  const incomingHeaders = await headers();
  const request = new Request('https://r27-page.invalid/', {
    headers: {
      Accept: 'application/json',
      Cookie: incomingHeaders.get('cookie') ?? '',
    },
  });

  const response = await r27EvidenceApiGet(request, organizationId, sessionId);
  if ([401, 403, 404].includes(response.status)) notFound();
  if (!response.ok)
    throw new Error('Submitted evidence is temporarily unavailable.');
  const evidence = await response.json();

  return (
    <main
      className="software-product evaluator-review-shell"
      style={{ width: '100%', maxWidth: 'none', margin: 0, padding: 0 }}
    >
      <h1 className="visually-hidden">Evaluator review</h1>
      <EvaluatorExperience
        sessionId={sessionId}
        readOnly
        r27Evidence={evidence}
      />
    </main>
  );
}
