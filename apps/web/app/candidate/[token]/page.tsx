import { notFound } from 'next/navigation';

import { SessionError } from '../../../src/sessions/session';
import { getSessionService } from '../../../src/sessions/session-service';
import { toCandidateSessionView } from '../../../src/sessions/candidate-session-view';
import { getCandidateCommandHistory } from '../../../src/server/candidate-command-history';
import { CandidateWorkspace } from './candidate-workspace';

export const dynamic = 'force-dynamic';

type CandidatePageProps = Readonly<{
  params: Promise<{ token: string }>;
}>;

const CandidatePage = async ({ params }: CandidatePageProps) => {
  const { token } = await params;
  const sessionService = getSessionService();
  let session;

  try {
    session = sessionService.getCandidateSession(token);
  } catch (error) {
    if (error instanceof SessionError && error.code === 'SESSION_NOT_FOUND') {
      notFound();
    }

    throw error;
  }

  const initialCommands = getCandidateCommandHistory(
    sessionService,
    token,
    session,
  );

  return (
    <CandidateWorkspace
      initialCommands={initialCommands}
      initialSession={toCandidateSessionView(session, sessionService.now())}
      token={token}
    />
  );
};

export default CandidatePage;
