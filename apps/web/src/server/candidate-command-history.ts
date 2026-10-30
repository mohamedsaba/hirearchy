import type {
  CommandHistoryEntry,
  CommandPresentationState,
} from '../../app/candidate/[token]/candidate-command-state';
import type { CommandExecResult } from '../sandbox/sandbox';
import { SessionError, type AssessmentSession } from '../sessions/session';
import type { SessionService } from '../sessions/session-service';

export const CANDIDATE_COMMAND_ENTRY_WHITELIST = [
  'id',
  'command',
  'state',
  'result',
  'platformError',
] as const;

export const CANDIDATE_COMMAND_RESULT_WHITELIST = [
  'commandId',
  'exitCode',
  'timedOut',
  'durationMs',
  'stdoutPreview',
  'stdoutBytes',
  'stdoutTruncated',
  'stderrPreview',
  'stderrBytes',
  'stderrTruncated',
] as const;

export type WhitelistedCommandEntryKey =
  (typeof CANDIDATE_COMMAND_ENTRY_WHITELIST)[number];
export type WhitelistedCommandResultKey =
  (typeof CANDIDATE_COMMAND_RESULT_WHITELIST)[number];

export type CandidateHistoryEventLike = Readonly<{
  id?: string;
  sequence?: number;
  type: string;
  timestamp: string;
  payload?: unknown;
}>;

const calculateByteLength = (text: string): number => {
  if (typeof Buffer !== 'undefined') {
    return Buffer.byteLength(text, 'utf-8');
  }
  return new TextEncoder().encode(text).length;
};

export const derivePresentationState = (
  exitCode: number | null,
  timedOut: boolean,
  status?: string | null,
  platformError?: string | null,
): CommandPresentationState => {
  if (platformError) return 'PLATFORM_ERROR';
  if (status === 'PLATFORM_ERROR') return 'PLATFORM_ERROR';
  if (status === 'RUNNING') return 'RUNNING';
  if (status === 'TIMED_OUT' || timedOut) return 'TIMED_OUT';
  if (status === 'COMPLETED_SUCCESS') return 'COMPLETED_SUCCESS';
  if (status === 'COMPLETED_FAILURE') return 'COMPLETED_FAILURE';
  if (exitCode === 0) return 'COMPLETED_SUCCESS';
  if (exitCode !== null && exitCode !== 0) return 'COMPLETED_FAILURE';
  return 'COMPLETED_FAILURE';
};

export const createWhitelistedResult = (
  rawResult: Record<string, unknown>,
): CommandExecResult => {
  const stdoutPreview =
    typeof rawResult.stdoutPreview === 'string'
      ? rawResult.stdoutPreview
      : typeof rawResult.stdout === 'string'
        ? rawResult.stdout
        : '';

  const stdoutBytes =
    typeof rawResult.stdoutBytes === 'number'
      ? rawResult.stdoutBytes
      : typeof rawResult.stdout_bytes === 'number'
        ? rawResult.stdout_bytes
        : calculateByteLength(stdoutPreview);

  const stdoutTruncated = Boolean(
    rawResult.stdoutTruncated ?? rawResult.stdout_truncated ?? false,
  );

  const stderrPreview =
    typeof rawResult.stderrPreview === 'string'
      ? rawResult.stderrPreview
      : typeof rawResult.stderr === 'string'
        ? rawResult.stderr
        : '';

  const stderrBytes =
    typeof rawResult.stderrBytes === 'number'
      ? rawResult.stderrBytes
      : typeof rawResult.stderr_bytes === 'number'
        ? rawResult.stderr_bytes
        : calculateByteLength(stderrPreview);

  const stderrTruncated = Boolean(
    rawResult.stderrTruncated ?? rawResult.stderr_truncated ?? false,
  );

  const durationMs =
    typeof rawResult.durationMs === 'number'
      ? rawResult.durationMs
      : typeof rawResult.duration_ms === 'number'
        ? rawResult.duration_ms
        : 0;

  const timedOut = Boolean(
    rawResult.timedOut ??
    rawResult.timed_out ??
    rawResult.status === 'TIMED_OUT',
  );

  const exitCode =
    typeof rawResult.exitCode === 'number'
      ? rawResult.exitCode
      : typeof rawResult.exit_code === 'number'
        ? rawResult.exit_code
        : null;

  const commandId = String(rawResult.commandId ?? rawResult.command_id ?? '');

  return Object.freeze({
    commandId,
    exitCode,
    timedOut,
    durationMs,
    stdoutPreview,
    stdoutBytes,
    stdoutTruncated,
    stderrPreview,
    stderrBytes,
    stderrTruncated,
  });
};

export const createWhitelistedEntry = ({
  id,
  command,
  state,
  result,
  platformError,
}: {
  id: string;
  command: string;
  state: CommandPresentationState;
  result: CommandExecResult | null;
  platformError?: string | null;
}): CommandHistoryEntry => {
  return Object.freeze({
    id: String(id),
    command: String(command),
    state,
    result: result ? Object.freeze({ ...result }) : null,
    platformError: platformError ? String(platformError) : null,
  });
};

export const projectCommandHistoryFromEvents = (
  events: readonly CandidateHistoryEventLike[],
): readonly CommandHistoryEntry[] => {
  if (!events || events.length === 0) {
    return [];
  }

  const sortedEvents = [...events].sort((left, right) => {
    if (
      typeof left.sequence === 'number' &&
      typeof right.sequence === 'number'
    ) {
      return left.sequence - right.sequence;
    }
    const leftTime = Date.parse(left.timestamp) || 0;
    const rightTime = Date.parse(right.timestamp) || 0;
    return leftTime - rightTime;
  });

  type MutableEntry = {
    id: string;
    command: string;
    state: CommandPresentationState;
    result: CommandExecResult | null;
    platformError: string | null;
  };

  const entries: MutableEntry[] = [];
  const startedIndexByCommandId = new Map<string, number>();

  for (const event of sortedEvents) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const eventType = String(event.type);

    if (
      eventType === 'terminal.command.executed' ||
      eventType === 'TERMINAL_COMMAND_EXECUTED'
    ) {
      const commandId = String(
        payload.commandId ?? payload.command_id ?? payload.id ?? event.id,
      );
      const command = String(payload.command ?? '');
      const exitCode =
        typeof payload.exitCode === 'number'
          ? payload.exitCode
          : typeof payload.exit_code === 'number'
            ? payload.exit_code
            : null;
      const timedOut = Boolean(
        payload.timedOut ?? payload.timed_out ?? payload.status === 'TIMED_OUT',
      );
      const platformError = payload.platformError
        ? String(payload.platformError)
        : null;
      const state = derivePresentationState(
        exitCode,
        timedOut,
        typeof payload.status === 'string' ? payload.status : null,
        platformError,
      );

      const result =
        state === 'PLATFORM_ERROR' && !payload.stdout && !payload.stdoutPreview
          ? null
          : createWhitelistedResult({
              ...payload,
              commandId,
              exitCode,
              timedOut,
            });

      entries.push({
        id: commandId,
        command,
        state,
        result,
        platformError,
      });
    } else if (event.type === 'COMMAND_STARTED') {
      const commandId = String(payload.commandId ?? event.id);
      const command = String(payload.command ?? '');
      const entryIndex = entries.length;
      startedIndexByCommandId.set(commandId, entryIndex);
      entries.push({
        id: commandId,
        command,
        state: 'RUNNING',
        result: null,
        platformError: null,
      });
    } else if (event.type === 'COMMAND_FINISHED') {
      const commandId = String(payload.commandId ?? '');
      const exitCode =
        typeof payload.exitCode === 'number' ? payload.exitCode : null;
      const timedOut = Boolean(payload.timedOut);
      const state = derivePresentationState(exitCode, timedOut);

      const result = createWhitelistedResult({
        ...payload,
        commandId,
        exitCode,
        timedOut,
      });

      const existingIndex = startedIndexByCommandId.get(commandId);
      if (existingIndex !== undefined) {
        const existing = entries[existingIndex];
        entries[existingIndex] = {
          ...existing,
          state,
          result,
          platformError: null,
        };
      } else {
        const command =
          typeof payload.command === 'string'
            ? payload.command
            : '(unknown command)';
        entries.push({
          id: commandId || event.id || 'unknown',
          command,
          state,
          result,
          platformError: null,
        });
      }
    }
  }

  // Commands that started but never recorded a finished event on server
  // represent interrupted executions that must fail safely rather than
  // inventing fictitious results or staying indefinitely RUNNING.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.state === 'RUNNING' && !entry.result) {
      entries[i] = {
        ...entry,
        state: 'PLATFORM_ERROR',
        platformError: 'Command execution did not complete.',
      };
    }
  }

  return entries.map((entry) =>
    createWhitelistedEntry({
      id: entry.id,
      command: entry.command,
      state: entry.state,
      result: entry.result,
      platformError: entry.platformError,
    }),
  );
};

export const getCandidateCommandHistory = (
  sessionService: SessionService,
  candidateToken: string,
  session?: AssessmentSession,
): readonly CommandHistoryEntry[] => {
  const currentSession =
    session ?? sessionService.getCandidateSession(candidateToken);

  // Pre-start (CREATED) sessions must return none
  if (currentSession.status === 'CREATED') {
    return [];
  }

  // If terminal is explicitly disabled, return none
  if (currentSession.terminalEnabled === false) {
    return [];
  }

  try {
    const events = sessionService.getSessionEvents(candidateToken);
    return projectCommandHistoryFromEvents(events);
  } catch (error) {
    if (error instanceof SessionError && error.code === 'SESSION_NOT_FOUND') {
      throw error;
    }
    return [];
  }
};
