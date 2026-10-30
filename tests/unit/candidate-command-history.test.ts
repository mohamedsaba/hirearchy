import { describe, expect, it } from 'vitest';

import {
  CANDIDATE_COMMAND_ENTRY_WHITELIST,
  CANDIDATE_COMMAND_RESULT_WHITELIST,
  projectCommandHistoryFromEvents,
} from '../../apps/web/src/server/candidate-command-history';
import type { SessionEvent } from '../../apps/web/src/events/session-event';

describe('Candidate Command History Projection & Whitelist Enforcement', () => {
  it('enforces strict field whitelist and never leaks evaluator, rubric, or server secrets', () => {
    const events: SessionEvent[] = [
      {
        id: 'evt_started_1',
        sessionId: 'sess_secret_123',
        sequence: 1,
        type: 'COMMAND_STARTED',
        timestamp: '2026-10-23T10:00:00.000Z',
        source: 'server',
        payload: {
          commandId: 'cmd_1',
          command: 'pytest tests/test_bookings.py',
          cwd: '/workspace',
          // Malicious / internal evaluator leak injection:
          evaluatorNote: 'Candidate took too long to read instructions',
          rubricScore: 4.5,
          hiddenTestWeights: { test_a: 10 },
          serverEnv: { API_KEY: 'sk-secret' },
        } as unknown as SessionEvent['payload'],
      },
      {
        id: 'evt_finished_1',
        sessionId: 'sess_secret_123',
        sequence: 2,
        type: 'COMMAND_FINISHED',
        timestamp: '2026-10-23T10:00:01.000Z',
        source: 'server',
        payload: {
          commandId: 'cmd_1',
          exitCode: 0,
          timedOut: false,
          durationMs: 450,
          stdoutPreview: '2 passed in 0.45s',
          stdoutBytes: 17,
          stdoutTruncated: false,
          stderrPreview: '',
          stderrBytes: 0,
          stderrTruncated: false,
          // Extra unwhitelisted metadata:
          verificationGrade: 'PASS',
          containerId: 'container_abc_456',
          hostIp: '10.0.0.1',
        } as unknown as SessionEvent['payload'],
      },
    ];

    const history = projectCommandHistoryFromEvents(events);

    expect(history).toHaveLength(1);
    const [entry] = history;

    // Verify top-level keys match CANDIDATE_COMMAND_ENTRY_WHITELIST exactly
    expect(Object.keys(entry).sort()).toEqual(
      [...CANDIDATE_COMMAND_ENTRY_WHITELIST].sort(),
    );

    expect(entry.id).toBe('cmd_1');
    expect(entry.command).toBe('pytest tests/test_bookings.py');
    expect(entry.state).toBe('COMPLETED_SUCCESS');
    expect(entry.platformError).toBeNull();
    expect(entry.result).not.toBeNull();

    // Verify result keys match CANDIDATE_COMMAND_RESULT_WHITELIST exactly
    const result = entry.result!;
    expect(Object.keys(result).sort()).toEqual(
      [...CANDIDATE_COMMAND_RESULT_WHITELIST].sort(),
    );

    // Verify expected whitelisted values
    expect(result.commandId).toBe('cmd_1');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBe(450);
    expect(result.stdoutPreview).toBe('2 passed in 0.45s');
    expect(result.stdoutBytes).toBe(17);
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrPreview).toBe('');
    expect(result.stderrBytes).toBe(0);
    expect(result.stderrTruncated).toBe(false);

    // Explicit negative assertions: no leaked evaluator/internal fields
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('Candidate took too long');
    expect(serialized).not.toContain('rubricScore');
    expect(serialized).not.toContain('hiddenTestWeights');
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('verificationGrade');
    expect(serialized).not.toContain('container_abc_456');
    expect(serialized).not.toContain('10.0.0.1');
    expect(serialized).not.toContain('/workspace');
    expect(serialized).not.toContain('sess_secret_123');
  });

  it('preserves chronological execution order across multiple commands', () => {
    const events: SessionEvent[] = [
      {
        id: 'evt_1',
        sessionId: 'sess_1',
        sequence: 1,
        type: 'COMMAND_STARTED',
        timestamp: '2026-10-23T10:00:00.000Z',
        source: 'server',
        payload: { commandId: 'c1', command: 'git status', cwd: '/workspace' },
      },
      {
        id: 'evt_2',
        sessionId: 'sess_1',
        sequence: 2,
        type: 'COMMAND_FINISHED',
        timestamp: '2026-10-23T10:00:00.200Z',
        source: 'server',
        payload: {
          commandId: 'c1',
          exitCode: 0,
          timedOut: false,
          durationMs: 200,
          stdoutPreview: 'On branch main\nnothing to commit',
          stdoutBytes: 32,
          stdoutTruncated: false,
          stderrPreview: '',
          stderrBytes: 0,
          stderrTruncated: false,
        },
      },
      {
        id: 'evt_3',
        sessionId: 'sess_1',
        sequence: 3,
        type: 'COMMAND_STARTED',
        timestamp: '2026-10-23T10:01:00.000Z',
        source: 'server',
        payload: { commandId: 'c2', command: 'pytest', cwd: '/workspace' },
      },
      {
        id: 'evt_4',
        sessionId: 'sess_1',
        sequence: 4,
        type: 'COMMAND_FINISHED',
        timestamp: '2026-10-23T10:01:01.500Z',
        source: 'server',
        payload: {
          commandId: 'c2',
          exitCode: 1,
          timedOut: false,
          durationMs: 1500,
          stdoutPreview: '1 failed, 1 passed',
          stdoutBytes: 18,
          stdoutTruncated: false,
          stderrPreview: '',
          stderrBytes: 0,
          stderrTruncated: false,
        },
      },
      {
        id: 'evt_5',
        sessionId: 'sess_1',
        sequence: 5,
        type: 'COMMAND_STARTED',
        timestamp: '2026-10-23T10:02:00.000Z',
        source: 'server',
        payload: {
          commandId: 'c3',
          command: 'python -m service',
          cwd: '/workspace',
        },
      },
      {
        id: 'evt_6',
        sessionId: 'sess_1',
        sequence: 6,
        type: 'COMMAND_FINISHED',
        timestamp: '2026-10-23T10:02:05.000Z',
        source: 'server',
        payload: {
          commandId: 'c3',
          exitCode: null,
          timedOut: true,
          durationMs: 5000,
          stdoutPreview: '',
          stdoutBytes: 0,
          stdoutTruncated: false,
          stderrPreview: 'Timeout exceeded',
          stderrBytes: 16,
          stderrTruncated: false,
        },
      },
    ];

    const history = projectCommandHistoryFromEvents(events);

    expect(history).toHaveLength(3);
    expect(history.map((e) => e.command)).toEqual([
      'git status',
      'pytest',
      'python -m service',
    ]);
    expect(history.map((e) => e.state)).toEqual([
      'COMPLETED_SUCCESS',
      'COMPLETED_FAILURE',
      'TIMED_OUT',
    ]);
  });

  it('accurately preserves stdout and stderr truncation markers and byte counts', () => {
    const events: SessionEvent[] = [
      {
        id: 'evt_1',
        sessionId: 'sess_1',
        sequence: 1,
        type: 'COMMAND_STARTED',
        timestamp: '2026-10-23T10:00:00.000Z',
        source: 'server',
        payload: {
          commandId: 'c_trunc',
          command: 'cat massive.log',
          cwd: '/workspace',
        },
      },
      {
        id: 'evt_2',
        sessionId: 'sess_1',
        sequence: 2,
        type: 'COMMAND_FINISHED',
        timestamp: '2026-10-23T10:00:01.000Z',
        source: 'server',
        payload: {
          commandId: 'c_trunc',
          exitCode: 0,
          timedOut: false,
          durationMs: 800,
          stdoutPreview: 'Log header\n... [truncated] ...\nLog tail',
          stdoutBytes: 154820,
          stdoutTruncated: true,
          stderrPreview: 'Warning: buffer full\n... [truncated]',
          stderrBytes: 24500,
          stderrTruncated: true,
        },
      },
    ];

    const [entry] = projectCommandHistoryFromEvents(events);

    expect(entry.result?.stdoutTruncated).toBe(true);
    expect(entry.result?.stdoutBytes).toBe(154820);
    expect(entry.result?.stdoutPreview).toBe(
      'Log header\n... [truncated] ...\nLog tail',
    );
    expect(entry.result?.stderrTruncated).toBe(true);
    expect(entry.result?.stderrBytes).toBe(24500);
    expect(entry.result?.stderrPreview).toBe(
      'Warning: buffer full\n... [truncated]',
    );
  });

  it('correctly handles direct terminal.command.executed events with varied outcomes', () => {
    const events = [
      {
        id: 'evt_t1',
        sessionId: 'sess_direct',
        sequence: 1,
        type: 'terminal.command.executed',
        timestamp: '2026-10-23T10:00:00.000Z',
        source: 'server',
        payload: {
          commandId: 'c_direct_ok',
          command: 'pytest',
          exitCode: 0,
          durationMs: 310,
          stdoutPreview: 'All tests passed',
          stdoutBytes: 16,
          stdoutTruncated: false,
          stderrPreview: '',
          stderrBytes: 0,
          stderrTruncated: false,
          timedOut: false,
        },
      },
      {
        id: 'evt_t2',
        sessionId: 'sess_direct',
        sequence: 2,
        type: 'terminal.command.executed',
        timestamp: '2026-10-23T10:01:00.000Z',
        source: 'server',
        payload: {
          commandId: 'c_direct_fail',
          command: 'flake8',
          exitCode: 2,
          durationMs: 120,
          stdoutPreview: '',
          stdoutBytes: 0,
          stdoutTruncated: false,
          stderrPreview: 'SyntaxError: invalid syntax',
          stderrBytes: 27,
          stderrTruncated: false,
          timedOut: false,
        },
      },
      {
        id: 'evt_t3',
        sessionId: 'sess_direct',
        sequence: 3,
        type: 'terminal.command.executed',
        timestamp: '2026-10-23T10:02:00.000Z',
        source: 'server',
        payload: {
          commandId: 'c_direct_timeout',
          command: 'sleep 100',
          exitCode: null,
          durationMs: 30000,
          stdoutPreview: '',
          stdoutBytes: 0,
          stdoutTruncated: false,
          stderrPreview: '',
          stderrBytes: 0,
          stderrTruncated: false,
          timedOut: true,
        },
      },
    ] as unknown as SessionEvent[];

    const history = projectCommandHistoryFromEvents(events);

    expect(history).toHaveLength(3);
    expect(history[0].state).toBe('COMPLETED_SUCCESS');
    expect(history[1].state).toBe('COMPLETED_FAILURE');
    expect(history[1].result?.exitCode).toBe(2);
    expect(history[2].state).toBe('TIMED_OUT');
    expect(history[2].result?.timedOut).toBe(true);
  });

  it('safely marks interrupted commands without finished events as PLATFORM_ERROR rather than inventing outcomes', () => {
    const events: SessionEvent[] = [
      {
        id: 'evt_started_orphan',
        sessionId: 'sess_crashed',
        sequence: 1,
        type: 'COMMAND_STARTED',
        timestamp: '2026-10-23T10:00:00.000Z',
        source: 'server',
        payload: {
          commandId: 'cmd_crashed',
          command: 'python run_forever.py',
          cwd: '/workspace',
        },
      },
    ];

    const [entry] = projectCommandHistoryFromEvents(events);

    expect(entry.id).toBe('cmd_crashed');
    expect(entry.command).toBe('python run_forever.py');
    expect(entry.state).toBe('PLATFORM_ERROR');
    expect(entry.platformError).toBe('Command execution did not complete.');
    expect(entry.result).toBeNull();
  });

  it('ignores non-command events and returns empty array when no commands were executed', () => {
    const events: SessionEvent[] = [
      {
        id: 'evt_ws',
        sessionId: 'sess_1',
        sequence: 1,
        type: 'WORKSPACE_CHANGED',
        timestamp: '2026-10-23T10:00:00.000Z',
        source: 'server',
        payload: {
          changeId: 'chg_1',
          origin: 'browser_save',
          beforeTree: '',
          afterTree: '',
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
        },
      },
    ];

    expect(projectCommandHistoryFromEvents(events)).toEqual([]);
    expect(projectCommandHistoryFromEvents([])).toEqual([]);
  });
});
