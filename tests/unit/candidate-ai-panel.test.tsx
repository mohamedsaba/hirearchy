import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  CandidateAiPanel,
  insertTerminalReference,
  resolveAttachablePaths,
  toggleAttachedPath,
  TERMINAL_REFERENCE,
} from '../../apps/web/app/candidate/[token]/candidate-ai-panel';
import {
  beginSubmission,
  buildAiInteractionPayload,
  INITIAL_CANDIDATE_AI_STATE,
  MAXIMUM_PROMPT_CHARS,
  resolveSubmissionNetworkError,
  resolveSubmissionResult,
  retryRequest,
  setPromptText,
  startNewRequest,
} from '../../apps/web/app/candidate/[token]/candidate-ai-state';
import {
  MAXIMUM_AI_CONTEXT_ATTACHMENTS,
  MAXIMUM_PROMPT_LENGTH,
} from '../../apps/web/src/ai/ai-interaction';

const activePanel = (initialState = INITIAL_CANDIDATE_AI_STATE) =>
  renderToStaticMarkup(
    <CandidateAiPanel
      activeFilePath="inventory/cache.py"
      aiCapability={{ enabled: true, includesWorkspaceContext: false }}
      initialState={initialState}
      sessionStatus="ACTIVE"
      token="test-token"
    />,
  );

const completedState = {
  ...INITIAL_CANDIDATE_AI_STATE,
  conversation: [
    {
      requestId: 'client_req_1',
      prompt: 'Explain the cache boundary',
      context: [{ filePath: 'inventory/cache.py' }],
      status: 'completed' as const,
      responseText: 'The cache is keyed per request.',
    },
  ],
  submissionState: 'completed' as const,
  clientRequestId: 'client_req_1',
};

describe('C6 candidate integrated AI experience', () => {
  it('frames Weft as a text-only assistant with honest capability limits', () => {
    const html = activePanel();

    expect(html).toContain('Weft');
    expect(html).toContain('Your engineering assistant');
    expect(html).toContain(
      'Weft provides text suggestions. You edit files and run commands.',
    );
    expect(html).toContain('Unsaved editor edits are not included.');
    expect(html).toContain('for="candidate-ai-prompt"');
    expect(html).toContain('>Send request</button>');
    expect(html).toContain('aria-describedby="candidate-ai-context"');
    expect(html).not.toContain('score');
    expect(html).not.toContain('cheat');
  });

  it('offers no write, run, or upload affordance', () => {
    const html = activePanel();

    expect(html).not.toContain('type="file"');
    expect(html).not.toContain('<input type="submit"');
    expect(html).not.toContain('formAction');
    expect(html).not.toContain('method="post"');
  });

  it('keeps the composer mounted after a completed response', () => {
    const html = activePanel(completedState);

    expect(html).toContain('id="candidate-ai-prompt"');
    expect(html).toContain('>Send request</button>');
    expect(html).not.toContain('>New request</button>');
    expect(html).toContain('The cache is keyed per request.');
    expect(html).toContain('Sent with this message: inventory/cache.py.');
  });

  it('starts a new client identity on the next submission while keeping the typed prompt', () => {
    const next = startNewRequest(completedState);
    const retyped = setPromptText(next, 'Now the eviction policy');
    const admission = beginSubmission(retyped, [], 'client_req_2');

    expect(next.submissionState).toBe('idle');
    expect(next.clientRequestId).toBeNull();
    expect(retyped.prompt).toBe('Now the eviction policy');
    expect(admission?.requestId).toBe('client_req_2');
    expect(admission?.nextState.conversation).toHaveLength(2);
  });

  it('starts a new identity with a preserved prompt from any finished request', () => {
    const finished = [
      completedState,
      {
        ...completedState,
        submissionState: 'failed' as const,
        clientRequestId: 'client_req_failed',
      },
      {
        ...completedState,
        submissionState: 'ambiguous' as const,
        clientRequestId: 'client_req_ambiguous',
      },
    ];

    for (const state of finished) {
      const typed = setPromptText(state, 'Typed while a result was on screen');
      const prepared = setPromptText(startNewRequest(typed), typed.prompt);
      const admission = beginSubmission(prepared, []);

      expect(prepared.submissionState).toBe('idle');
      expect(prepared.clientRequestId).toBeNull();
      expect(prepared.prompt).toBe('Typed while a result was on screen');
      expect(admission?.requestId).toContain('client_req_');
      expect(admission?.requestId).not.toBe(typed.clientRequestId);
    }
  });

  it('defaults to the active file as the single reused attachment', () => {
    const html = activePanel();

    expect(html).toContain('inventory/cache.py');
    expect(html).toContain('1 of 3 files attached');
    expect(html).toContain('Remove inventory/cache.py from context');
    expect(html).toContain('Only the file paths above are sent.');
    expect(html).toContain('Unsaved editor edits are not included.');
  });

  it('shows no attachment when no active file exists', () => {
    const html = renderToStaticMarkup(
      <CandidateAiPanel
        aiCapability={{ enabled: true, includesWorkspaceContext: false }}
        sessionStatus="ACTIVE"
        token="test-token"
      />,
    );

    expect(html).toContain('No files attached');
    expect(html).toContain('Attach files below if you want Weft to read them.');
  });

  it('claims recorded test checks only when the capability includes workspace context', () => {
    const withWorkspaceContext = renderToStaticMarkup(
      <CandidateAiPanel
        activeFilePath="inventory/cache.py"
        aiCapability={{ enabled: true, includesWorkspaceContext: true }}
        sessionStatus="ACTIVE"
        token="test-token"
      />,
    );
    const withoutWorkspaceContext = activePanel();

    expect(withWorkspaceContext).toContain(
      'Recent recorded test checks are already included',
    );
    expect(withWorkspaceContext).toContain(
      'the recorded command, its exit code, and output previews',
    );
    expect(withWorkspaceContext).toContain(
      'Saved file contents and the published task brief are sent',
    );
    expect(withoutWorkspaceContext).toContain(
      'Recorded test checks are not included in this configuration.',
    );
    expect(withoutWorkspaceContext).not.toContain(
      'Recent recorded test checks are already included',
    );
  });

  it('never implies live terminal access and references recorded checks instead', () => {
    const html = activePanel();

    expect(html).toContain('@terminal');
    expect(html.toLowerCase()).not.toContain('live terminal');
    expect(html.toLowerCase()).not.toContain('run a command');
    expect(html.toLowerCase()).not.toContain('read your terminal');
    expect(insertTerminalReference('What failed?')).toBe(
      'What failed? @terminal ',
    );
    expect(insertTerminalReference('')).toBe('@terminal ');
    expect(insertTerminalReference(`already ${TERMINAL_REFERENCE} there`)).toBe(
      `already ${TERMINAL_REFERENCE} there`,
    );
  });

  it('picks only attachable workspace files and honours the attachment cap', () => {
    const paths = resolveAttachablePaths([
      { path: 'inventory/cache.py', isDirectory: false },
      { path: 'inventory', isDirectory: true },
      { path: '/etc/passwd', isDirectory: false },
      { path: '../outside.ts', isDirectory: false },
      { path: 'inventory\\windows.ts', isDirectory: false },
      { path: 'inventory/cache.py', isDirectory: false },
    ]);

    expect(paths).toEqual(['inventory/cache.py']);

    let attachments: readonly string[] = ['a.ts'];
    attachments = toggleAttachedPath(attachments, 'b.ts');
    attachments = toggleAttachedPath(attachments, 'c.ts');
    attachments = toggleAttachedPath(attachments, 'd.ts');

    expect(attachments).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(attachments).toHaveLength(MAXIMUM_AI_CONTEXT_ATTACHMENTS);
    expect(toggleAttachedPath(attachments, 'a.ts')).toEqual(['b.ts', 'c.ts']);
  });

  it('uses a native details picker with labelled checkboxes and no upload input', () => {
    const html = renderToStaticMarkup(
      <CandidateAiPanel
        activeFilePath="inventory/cache.py"
        aiCapability={{ enabled: true, includesWorkspaceContext: true }}
        sessionStatus="ACTIVE"
        token="test-token"
        workspaceFiles={[
          { path: 'inventory/cache.py', isDirectory: false },
          { path: 'inventory/store.py', isDirectory: false },
          { path: 'inventory', isDirectory: true },
        ]}
      />,
    );

    expect(html).toContain('<details class="weft-ai-picker">');
    expect(html).toContain('Choose workspace files to include');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('value="inventory/store.py"');
    expect(html).toContain('for="weft-ai-file-1"');
    expect(html).not.toContain('value="inventory"');
    expect(html).not.toContain('type="file"');
  });

  it('discloses exactly what each request sends', () => {
    const html = activePanel();

    expect(html).toContain('What is sent with each request');
    expect(html).toContain('Assessment metadata is included.');
    expect(html).toContain('<details class="weft-ai-context"');
    expect(html).toContain('summary class="weft-ai-context-summary"');
  });

  it('does not expose a composer when projected AI capability is unavailable', () => {
    const html = renderToStaticMarkup(
      <CandidateAiPanel
        activeFilePath="inventory/cache.py"
        aiCapability={{ enabled: true, includesWorkspaceContext: false }}
        canUseAi={false}
        sessionStatus="ACTIVE"
        token="test-token"
      />,
    );

    expect(html).toContain(
      'AI is unavailable while the assessment is not active.',
    );
    expect(html).not.toContain('id="candidate-ai-prompt"');
  });

  it('shows the projected deadline reason without changing server session truth', () => {
    const html = renderToStaticMarkup(
      <CandidateAiPanel
        aiCapability={{ enabled: true, includesWorkspaceContext: false }}
        canUseAi={false}
        sessionStatus="ACTIVE"
        token="test-token"
        unavailableMessage="The assessment time limit has been reached. AI is unavailable."
      />,
    );

    expect(html).toContain(
      'The assessment time limit has been reached. AI is unavailable.',
    );
  });

  it('renders session-finality state truthfully', () => {
    const html = renderToStaticMarkup(
      <CandidateAiPanel
        aiCapability={{ enabled: true, includesWorkspaceContext: false }}
        sessionStatus="SUBMITTED"
        token="test-token"
      />,
    );

    expect(html).toContain(
      'Assessment submitted. Integrated AI assistance is closed.',
    );
    expect(html).not.toContain('id="candidate-ai-prompt"');
  });

  it('rejects an empty prompt before request admission', () => {
    expect(beginSubmission(INITIAL_CANDIDATE_AI_STATE, [])).toBeNull();
    expect(
      beginSubmission(setPromptText(INITIAL_CANDIDATE_AI_STATE, '  '), []),
    ).toBeNull();
  });

  it('captures prompt and active-file context under one stable request identity', () => {
    const state = setPromptText(
      INITIAL_CANDIDATE_AI_STATE,
      'Inspect cache behavior',
    );
    const admission = beginSubmission(
      state,
      [{ filePath: 'inventory/cache.py' }],
      'client_req_1',
    );

    expect(admission?.nextState.conversation).toEqual([
      {
        requestId: 'client_req_1',
        prompt: 'Inspect cache behavior',
        context: [{ filePath: 'inventory/cache.py' }],
        status: 'submitting',
      },
    ]);
    expect(
      buildAiInteractionPayload(state, 'client_req_1', [
        { filePath: 'inventory/cache.py' },
      ]),
    ).toEqual({
      clientRequestId: 'client_req_1',
      candidatePromptText: 'Inspect cache behavior',
      candidateContext: [{ filePath: 'inventory/cache.py' }],
    });
  });

  it('prevents duplicate admission while a request is in flight', () => {
    const submitted = beginSubmission(
      setPromptText(INITIAL_CANDIDATE_AI_STATE, 'One request'),
      [],
      'client_req_1',
    )?.nextState;

    expect(submitted).toBeDefined();
    expect(beginSubmission(submitted!, [])).toBeNull();
  });

  it('associates response with its own prompt and preserves prior history', () => {
    const first = beginSubmission(
      setPromptText(INITIAL_CANDIDATE_AI_STATE, 'First prompt'),
      [{ filePath: 'one.ts' }],
      'client_req_1',
    )!;
    const firstDone = resolveSubmissionResult(first.nextState, 200, {
      status: 'COMPLETED',
      responseText: 'First answer',
    });
    const second = beginSubmission(
      setPromptText(startNewRequest(firstDone), 'Second prompt'),
      [{ filePath: 'two.ts' }],
      'client_req_2',
    )!;
    const secondDone = resolveSubmissionResult(second.nextState, 200, {
      status: 'COMPLETED',
      responseText: 'Second answer',
    });

    expect(secondDone.conversation).toEqual([
      expect.objectContaining({
        prompt: 'First prompt',
        responseText: 'First answer',
      }),
      expect.objectContaining({
        prompt: 'Second prompt',
        responseText: 'Second answer',
      }),
    ]);
  });

  it('keeps prompt and conversation after provider or network failures', () => {
    const admitted = beginSubmission(
      setPromptText(INITIAL_CANDIDATE_AI_STATE, 'Preserve this prompt'),
      [],
      'client_req_1',
    )!;
    const providerFailure = resolveSubmissionResult(
      admitted.nextState,
      500,
      null,
    );
    const networkFailure = resolveSubmissionNetworkError(admitted.nextState);

    expect(providerFailure.prompt).toBe('Preserve this prompt');
    expect(providerFailure.conversation[0]).toMatchObject({ status: 'failed' });
    expect(networkFailure.errorMessage).toBe(
      'Hirearchy Software could not reach AI. Try again.',
    );
  });

  it('treats a completed response without text as a platform failure', () => {
    const admitted = beginSubmission(
      setPromptText(INITIAL_CANDIDATE_AI_STATE, 'Malformed result'),
      [],
    )!;
    const state = resolveSubmissionResult(admitted.nextState, 200, {
      status: 'COMPLETED',
    });

    expect(state.errorMessage).toBe(
      'Hirearchy Software received an incomplete AI result. Try again.',
    );
  });

  it('maps deadline, inactive-session, and cancelled responses truthfully', () => {
    const admitted = beginSubmission(
      setPromptText(INITIAL_CANDIDATE_AI_STATE, 'Finality'),
      [],
    )!;

    expect(
      resolveSubmissionResult(admitted.nextState, 409, {
        error: { code: 'SESSION_DEADLINE_EXCEEDED' },
      }).errorMessage,
    ).toContain('time limit');
    expect(
      resolveSubmissionResult(admitted.nextState, 409, {
        error: { code: 'SESSION_NOT_ACTIVE' },
      }).errorMessage,
    ).toContain('no longer active');
    expect(
      resolveSubmissionResult(admitted.nextState, 409, {
        error: { code: 'SESSION_FINALIZATION_STARTED' },
      }).errorMessage,
    ).toContain('finalization has started');
    expect(
      resolveSubmissionResult(admitted.nextState, 200, {
        status: 'CANCELLED',
        terminalReason: 'session_ended',
      }).errorMessage,
    ).toContain('no longer active');
  });

  it('keeps failure recovery explicit and never auto-retries', () => {
    const admitted = beginSubmission(
      setPromptText(INITIAL_CANDIDATE_AI_STATE, 'Retry prompt'),
      [],
      'client_req_1',
    )!;
    const failed = resolveSubmissionResult(admitted.nextState, 500, null);
    const ambiguous = resolveSubmissionResult(admitted.nextState, 200, {
      status: 'DISPATCH_STARTED',
    });

    const failedHtml = activePanel(failed);
    expect(failedHtml).toContain('>Retry request</button>');
    expect(failedHtml).toContain('>Edit this message</button>');
    expect(failedHtml).toContain('Retry prompt');
    expect(failedHtml).toContain('id="candidate-ai-prompt"');

    const ambiguousHtml = activePanel(ambiguous);
    expect(ambiguousHtml).toContain(
      'This request may already be in progress. Hirearchy Software will not send it again automatically.',
    );
    expect(ambiguousHtml).toContain('>Dismiss and edit</button>');
    expect(ambiguousHtml).not.toContain('>Retry request</button>');
  });

  it('uses a fresh identity only after explicit retry', () => {
    const admitted = beginSubmission(
      setPromptText(INITIAL_CANDIDATE_AI_STATE, 'Retry prompt'),
      [],
      'client_req_1',
    )!;
    const failed = resolveSubmissionResult(admitted.nextState, 500, null);
    const retried = retryRequest(failed);
    const retry = beginSubmission(retried, [], 'client_req_2');

    expect(retried.prompt).toBe('Retry prompt');
    expect(retry?.requestId).toBe('client_req_2');
    expect(retry?.nextState.conversation).toHaveLength(2);
  });

  it('renders response text safely and avoids noisy live conversation semantics', () => {
    const html = activePanel({
      ...INITIAL_CANDIDATE_AI_STATE,
      conversation: [
        {
          requestId: 'client_req_1',
          prompt: '<img src=x>',
          context: [],
          status: 'completed',
          responseText: '<script>alert(1)</script>',
        },
      ],
      submissionState: 'completed',
      clientRequestId: 'client_req_1',
    });

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('aria-label="AI conversation"');
    expect(html).not.toContain('aria-live=');
  });

  it('marks only the in-flight request as pending', () => {
    const html = activePanel({
      ...INITIAL_CANDIDATE_AI_STATE,
      conversation: [
        {
          requestId: 'client_req_1',
          prompt: 'Working',
          context: [],
          status: 'submitting',
        },
        {
          requestId: 'client_req_2',
          prompt: 'Earlier',
          context: [],
          status: 'completed',
          responseText: 'Answer',
        },
      ],
      submissionState: 'submitting',
      clientRequestId: 'client_req_1',
    });

    expect(
      html.match(/Weft is preparing a response for this request\./g),
    ).toHaveLength(1);
    expect(html).toContain('role="status"');
    expect(html).toContain('Answer');
  });

  it('exposes the conversation log as a scrollable region', () => {
    const html = activePanel(completedState);

    expect(html).toContain('class="ai-conversation weft-ai-log"');
    expect(html).toContain('tabindex="0"');
  });

  it('keeps the local-only refresh boundary and source prompt limit visible', () => {
    const html = activePanel();

    expect(html).toContain('refreshing does not restore it.');
    expect(MAXIMUM_PROMPT_CHARS).toBe(MAXIMUM_PROMPT_LENGTH);
    expect(html).toContain(`maxLength="${MAXIMUM_PROMPT_LENGTH}"`);
  });
});
