import type { R27Evidence } from '../../../../database/postgres/r27/contract.mjs';
import type {
  PerformanceFitReport,
  SessionHiringReviewContext,
} from '../hiring/types';
import type { R211AssessmentDraftInput } from '../r211-builder/contract';
import type { R27AiReviewReport } from '../r27-evidence/ai-review-contract';

export const DEMO_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_SESSION_ID = 'sess_demo_maya_lin_01';
export const DEMO_REVIEWER_PRINCIPAL_ID =
  '00000000-0000-4000-8000-000000000010';
export const DEMO_PEER_PRINCIPAL_ID = '00000000-0000-4000-8000-000000000011';
export const DEMO_MANAGER_PRINCIPAL_ID = '00000000-0000-4000-8000-000000000012';

export const DEMO_SCENARIO_TITLE =
  'Reservation Moves v3 — Concurrency & Conflict Resolution';

const STARTER_README = `# A retry moved the booking backwards

Customers can move a booking to another session. Support reports that a failed
move can lose the original place, and an old retry can undo a newer successful
move. Fix the local move service while preserving the documented interfaces.

**Your task:** preserve seats and capacity, and make each accepted move replay
its own original result without moving the current booking again. The supplied
sender models a response lost before or after delivery. Confirmations describe
the accepted move, not necessarily the latest location.

## Public contract

\`move(state, sender, account, reservation, destination, operation, recipient)\`
returns a new dictionary with \`reservation\`, \`from\`, \`to\`, and \`receipt\`.
\`State.transfer(account, reservation, destination)\` returns the original slot.
Transferring directly to the current slot returns that slot without mutation, even
when the slot is full. Keep both signatures and Sender's contract.

1. Every reservation occupies exactly one slot, scoped by \`(account, reservation)\`.
   Slot capacities are global across accounts.
2. All five move arguments after sender must be nonempty strings; whitespace-only
   is invalid. Unknown reservation or destination rejects with ValueError before
   any state change or sender call.
3. A new move to a full destination rejects with ValueError without mutating
   reservation, operation history, or sender.
4. \`(account, reservation, operation)\` identifies one accepted intent and binds its
   original destination and recipient. Conflicting replay rejects safely.
5. Local acceptance commits the seat move and preserves its original confirmation
   before calling \`Sender.deliver\`.
6. Retrying an older accepted operation leaves the current slot alone and returns
   the older operation's original result.
7. Moving to the current slot is an accepted no-op with \`receipt: None\` and zero
   sender calls.
8. Returned result dictionaries must not let callers mutate accepted operation history.
`;

const STARTER_SENDER_PY = `from copy import deepcopy


class Sender:
    """Local upstream contract. Keys bind exact payloads; replay is idempotent.
    timeout_next can be 'before' or 'after' delivery, consumed on first attempt.
    """

    def __init__(self, timeout_next=None):
        self.deliveries = {}
        self.timeout_next = timeout_next
        self.calls = 0

    def deliver(self, key, payload):
        self.calls += 1
        if key in self.deliveries:
            original, receipt = self.deliveries[key]
            if original != payload:
                raise ValueError("Conflicting replay")
            return receipt
        fault, self.timeout_next = self.timeout_next, None
        if fault == "before":
            raise TimeoutError("Response unavailable before delivery")
        receipt = len(self.deliveries) + 1
        self.deliveries[key] = (deepcopy(payload), receipt)
        if fault == "after":
            raise TimeoutError("Response lost after delivery")
        return receipt
`;

const STARTER_STATE_PY = `class State:
    def __init__(self, capacities, reservations):
        self.capacities = dict(capacities)
        self.reservations = dict(reservations)
        self.operations = {}

    def occupancy(self, slot):
        return sum(value == slot for value in self.reservations.values())

    def transfer(self, account, reservation, destination):
        key = (account, reservation)
        source = self.reservations.pop(key)
        if destination not in self.capacities:
            raise ValueError("Unknown destination")
        if self.occupancy(destination) >= self.capacities[destination]:
            raise ValueError("Destination full")
        self.reservations[key] = destination
        return source
`;

const SUBMITTED_STATE_PY = `class State:
    def __init__(self, capacities, reservations):
        self.capacities = dict(capacities)
        self.reservations = dict(reservations)
        self.operations = {}

    def occupancy(self, slot):
        return sum(value == slot for value in self.reservations.values())

    def transfer(self, account, reservation, destination):
        key = (account, reservation)
        if key not in self.reservations:
            raise ValueError("Unknown reservation")
        if destination not in self.capacities:
            raise ValueError("Unknown destination")
        source = self.reservations[key]
        if source == destination:
            return source
        if self.occupancy(destination) >= self.capacities[destination]:
            raise ValueError("Destination full")
        self.reservations[key] = destination
        return source
`;

const STARTER_SERVICE_PY = `def move(state, sender, account, reservation, destination, operation, recipient):
    source = state.transfer(account, reservation, destination)
    payload = {"account": account, "reservation": reservation,
               "from": source, "to": destination, "recipient": recipient}
    receipt = sender.deliver((account, reservation), payload)
    state.operations[(account, reservation, operation)] = payload
    return {"reservation": reservation, "from": source,
            "to": destination, "receipt": receipt}
`;

const SUBMITTED_SERVICE_PY = `def _require_nonempty(value, field_name):
    if not isinstance(value, str) or value.strip() == "":
        raise ValueError(f"Invalid {field_name}: must be a nonempty string")


def move(state, sender, account, reservation, destination, operation, recipient):
    _require_nonempty(account, "account")
    _require_nonempty(reservation, "reservation")
    _require_nonempty(destination, "destination")
    _require_nonempty(operation, "operation")
    _require_nonempty(recipient, "recipient")

    op_key = (account, reservation, operation)
    existing = state.operations.get(op_key)
    if existing is not None:
        if (
            existing["destination"] != destination
            or existing["recipient"] != recipient
        ):
            raise ValueError("Conflicting operation replay")
        if existing["is_noop"]:
            return {
                "reservation": reservation,
                "from": existing["from"],
                "to": existing["to"],
                "receipt": None,
            }
        if existing["receipt"] is None:
            existing["receipt"] = sender.deliver(op_key, dict(existing["payload"]))
        return {
            "reservation": reservation,
            "from": existing["from"],
            "to": existing["to"],
            "receipt": existing["receipt"],
        }

    source = state.transfer(account, reservation, destination)
    if source == destination:
        state.operations[op_key] = {
            "destination": destination,
            "recipient": recipient,
            "from": source,
            "to": destination,
            "is_noop": True,
            "receipt": None,
            "payload": None,
        }
        return {
            "reservation": reservation,
            "from": source,
            "to": destination,
            "receipt": None,
        }

    payload = {
        "account": account,
        "reservation": reservation,
        "from": source,
        "to": destination,
        "recipient": recipient,
    }
    record = {
        "destination": destination,
        "recipient": recipient,
        "from": source,
        "to": destination,
        "is_noop": False,
        "receipt": None,
        "payload": dict(payload),
    }
    state.operations[op_key] = record
    receipt = sender.deliver(op_key, dict(payload))
    record["receipt"] = receipt
    return {
        "reservation": reservation,
        "from": source,
        "to": destination,
        "receipt": receipt,
    }
`;

const STARTER_TEST_MOVES_PY = `from copy import deepcopy
import pytest
from src.state import State
from src.sender import Sender
from src.service import move


def setup():
    return State({"A": 2, "B": 1, "C": 2}, {("acct", "r1"): "A"}), Sender()


def test_full_destination_preserves_original_seat_and_does_not_consume_intent():
    state, sender = setup()
    state.reservations[("other", "r2")] = "B"
    with pytest.raises(ValueError):
        move(state, sender, "acct", "r1", "B", "first", "Ada")
    state.transfer("other", "r2", "C")
    result = move(state, sender, "acct", "r1", "B", "first", "Ada")
    assert result == {"reservation": "r1", "from": "A", "to": "B", "receipt": 1}


def test_ambiguous_confirmation_keeps_local_acceptance_and_replays_original():
    state, sender = setup()
    sender.timeout_next = "after"
    with pytest.raises(TimeoutError):
        move(state, sender, "acct", "r1", "B", "first", "Ada")
    assert state.reservations[("acct", "r1")] == "B"
    second = move(state, sender, "acct", "r1", "C", "second", "Grace")
    assert second["from"] == "B" and second["to"] == "C"
    first = move(state, sender, "acct", "r1", "B", "first", "Ada")
    assert first["from"] == "A" and first["to"] == "B"
    assert state.reservations[("acct", "r1")] == "C"
`;

const ADDED_EDGE_CASES_TEST_PY = `import pytest
from src.state import State
from src.sender import Sender
from src.service import move


def test_timeout_before_delivery_still_delivers_on_replay_after_later_move():
    state = State({"A": 2, "B": 2, "C": 2}, {("acct", "r1"): "A"})
    sender = Sender(timeout_next="before")

    with pytest.raises(TimeoutError):
        move(state, sender, "acct", "r1", "B", "op-1", "Ada")

    assert state.reservations[("acct", "r1")] == "B"
    second = move(state, sender, "acct", "r1", "C", "op-2", "Grace")
    assert second["to"] == "C"

    replayed = move(state, sender, "acct", "r1", "B", "op-1", "Ada")
    assert replayed["from"] == "A"
    assert replayed["to"] == "B"
    assert replayed["receipt"] == 2
    assert state.reservations[("acct", "r1")] == "C"


def test_noop_replay_remains_safe_when_slot_becomes_full_later():
    state = State({"A": 1, "B": 1}, {("acct", "r1"): "A"})
    sender = Sender()

    noop = move(state, sender, "acct", "r1", "A", "stay", "Ada")
    assert noop == {"reservation": "r1", "from": "A", "to": "A", "receipt": None}
    assert sender.calls == 0

    move(state, sender, "acct", "r1", "B", "move-b", "Ada")
    state.reservations[("other", "r2")] = "A"

    assert move(state, sender, "acct", "r1", "A", "stay", "Ada") == noop
    assert state.reservations[("acct", "r1")] == "B"


def test_returned_receipt_dict_is_isolated_from_operation_history():
    state = State({"A": 2, "B": 2}, {("acct", "r1"): "A"})
    sender = Sender()

    res = move(state, sender, "acct", "r1", "B", "op-1", "Ada")
    res["to"] = "corrupted"
    replay = move(state, sender, "acct", "r1", "B", "op-1", "Ada")
    assert replay["to"] == "B"
`;

const DEMO_SNAPSHOT_TEXT = JSON.stringify({
  scenario: {
    id: 'reservation-moves',
    version: '3',
    title: DEMO_SCENARIO_TITLE,
    brief: STARTER_README,
    primaryFilePath: 'src/service.py',
    acceptanceCriteria: [
      'A rejected move preserves the original booking and capacity without consuming the operation key.',
      'Local acceptance commits the seat move and preserves its original confirmation before calling Sender.deliver.',
      'Retries preserve each accepted move, replay its original receipt, and never undo later moves.',
      'Moving to the current slot is an accepted no-op with zero sender calls.',
    ],
  },
});

const DIGESTS = {
  snapshot: '8f4b7e2c1a09d44f9b73e15c6d28a49c0e1b7f82a34d5e6f708192a3b4c5d6e7',
  starterWorkspace:
    'c1e172b193fd0c5e78f81ef5bf74ea95a07b6be3215829d5fa8e5116423b0694',
  submittedWorkspace:
    '4b9e22d8a17f5c3e084b61d9f2a3e7c5801d4f6a29c8e1b73f5062819a4c3d2e',
  submittedManifest:
    '9a21f4c7e8b301d5a6f289c4e7b103d85a6f2c9e14b708d3a5c2f6e901b4d7a8',
  starterSender:
    '1111111111111111111111111111111111111111111111111111111111111111',
  starterState:
    '2222222222222222222222222222222222222222222222222222222222222222',
  submittedState:
    '222222222222222222222222222222222222222222222222222222222222aaaa',
  starterService:
    '3333333333333333333333333333333333333333333333333333333333333333',
  submittedService:
    '333333333333333333333333333333333333333333333333333333333333bbbb',
  starterTests:
    '4444444444444444444444444444444444444444444444444444444444444444',
  addedEdgeTests:
    '555555555555555555555555555555555555555555555555555555555555cccc',
};

export const SAMPLE_CANDIDATE_DRAFT: R211AssessmentDraftInput = {
  templateId: 'reservation-moves-v3',
  title: DEMO_SCENARIO_TITLE,
  brief: STARTER_README,
  expectedBehavior: [
    'Preserve booking capacity and accepted move history without mutating state on error.',
    'Replay each accepted move idempotently without undoing later moves.',
  ],
  acceptanceCriteria: [
    'A rejected move preserves the original booking and capacity.',
    'Retries preserve each accepted move and do not undo later moves.',
    'Same-slot moves record an accepted no-op without calling Sender.deliver.',
  ],
  primaryFilePath: 'src/service.py',
  starterFiles: [
    { path: 'src/sender.py', content: STARTER_SENDER_PY },
    { path: 'src/service.py', content: STARTER_SERVICE_PY },
    { path: 'src/state.py', content: STARTER_STATE_PY },
    { path: 'tests/test_moves.py', content: STARTER_TEST_MOVES_PY },
  ],
  durationMinutes: 45,
  terminalEnabled: true,
  integratedAi: true,
  rubric: [
    {
      id: 'correctness',
      label: 'State & Idempotency Correctness',
      description:
        'Preserves slot capacity, commits intent prior to delivery, and replays historical receipts safely.',
      weight: 60,
      applicability: {
        kind: 'always',
        rule: 'Applies to all candidate submissions.',
      },
    },
    {
      id: 'verification',
      label: 'Verification & Edge-Case Discipline',
      description:
        'Validates boundary inputs, timeout fault recovery, and isolation of returned objects.',
      weight: 40,
      applicability: {
        kind: 'always',
        rule: 'Applies to all candidate submissions.',
      },
    },
  ],
};

export const DEMO_R27_EVIDENCE: R27Evidence = {
  permission: 'assigned_reviewer',
  reviewer: {
    subjectId: 'demo-reviewer',
    principalId: DEMO_REVIEWER_PRINCIPAL_ID,
  },
  organizationId: DEMO_ORGANIZATION_ID,
  sessionId: DEMO_SESSION_ID,
  assignment: {
    id: 'assign_demo_maya_01',
    version: '1',
    assignedAt: '2026-11-18T09:50:00.000Z',
  },
  scenario: {
    id: 'reservation-moves',
    version: '3',
    title: DEMO_SCENARIO_TITLE,
    snapshotText: DEMO_SNAPSHOT_TEXT,
    snapshotDigest: DIGESTS.snapshot,
    starterFiles: {
      'src/sender.py': STARTER_SENDER_PY,
      'src/service.py': STARTER_SERVICE_PY,
      'src/state.py': STARTER_STATE_PY,
      'tests/test_moves.py': STARTER_TEST_MOVES_PY,
    },
  },
  status: 'SUBMITTED',
  createdAt: '2026-11-18T09:55:00.000Z',
  activatedAt: '2026-11-18T10:00:00.000Z',
  submittedAt: '2026-11-18T10:38:15.000Z',
  closureReason: 'candidate_submission',
  submission: {
    submittedAt: '2026-11-18T10:38:15.000Z',
    closureReason: 'candidate_submission',
    workspaceDigest: DIGESTS.submittedWorkspace,
    manifestDigest: DIGESTS.submittedManifest,
    files: [
      {
        path: 'src/sender.py',
        content: STARTER_SENDER_PY,
        version: '1',
        digest: DIGESTS.starterSender,
      },
      {
        path: 'src/state.py',
        content: SUBMITTED_STATE_PY,
        version: '3',
        digest: DIGESTS.submittedState,
      },
      {
        path: 'src/service.py',
        content: SUBMITTED_SERVICE_PY,
        version: '5',
        digest: DIGESTS.submittedService,
      },
      {
        path: 'tests/test_moves.py',
        content: STARTER_TEST_MOVES_PY,
        version: '1',
        digest: DIGESTS.starterTests,
      },
      {
        path: 'tests/test_concurrency_edge_cases.py',
        content: ADDED_EDGE_CASES_TEST_PY,
        version: '2',
        digest: DIGESTS.addedEdgeTests,
      },
    ],
  },
  revisions: [
    {
      path: 'src/sender.py',
      version: '1',
      digest: DIGESTS.starterSender,
      content: STARTER_SENDER_PY,
      source: 'starter',
    },
    {
      path: 'src/state.py',
      version: '1',
      digest: DIGESTS.starterState,
      content: STARTER_STATE_PY,
      source: 'starter',
    },
    {
      path: 'src/service.py',
      version: '1',
      digest: DIGESTS.starterService,
      content: STARTER_SERVICE_PY,
      source: 'starter',
    },
    {
      path: 'tests/test_moves.py',
      version: '1',
      digest: DIGESTS.starterTests,
      content: STARTER_TEST_MOVES_PY,
      source: 'starter',
    },
    {
      path: 'src/state.py',
      version: '2',
      digest:
        '222222222222222222222222222222222222222222222222222222222222a111',
      content: null,
      source: 'event_metadata',
    },
    {
      path: 'src/service.py',
      version: '3',
      digest:
        '333333333333333333333333333333333333333333333333333333333333b222',
      content: null,
      source: 'event_metadata',
    },
    {
      path: 'src/service.py',
      version: '4',
      digest:
        '333333333333333333333333333333333333333333333333333333333333b333',
      content: null,
      source: 'event_metadata',
    },
    {
      path: 'src/sender.py',
      version: '1',
      digest: DIGESTS.starterSender,
      content: STARTER_SENDER_PY,
      source: 'submitted',
    },
    {
      path: 'src/state.py',
      version: '3',
      digest: DIGESTS.submittedState,
      content: SUBMITTED_STATE_PY,
      source: 'submitted',
    },
    {
      path: 'src/service.py',
      version: '5',
      digest: DIGESTS.submittedService,
      content: SUBMITTED_SERVICE_PY,
      source: 'submitted',
    },
    {
      path: 'tests/test_moves.py',
      version: '1',
      digest: DIGESTS.starterTests,
      content: STARTER_TEST_MOVES_PY,
      source: 'submitted',
    },
    {
      path: 'tests/test_concurrency_edge_cases.py',
      version: '2',
      digest: DIGESTS.addedEdgeTests,
      content: ADDED_EDGE_CASES_TEST_PY,
      source: 'submitted',
    },
  ],
  events: [
    {
      sequence: '1',
      type: 'SESSION_ACTIVATED',
      timestamp: '2026-11-18T10:00:00.000Z',
      payload: {
        consentVersion: 'candidate-data-v1',
        durationSeconds: 2700,
      },
      provenance: 'hirearchy.candidate_session_events',
    },
    {
      sequence: '2',
      type: 'WORKSPACE_CHANGED',
      timestamp: '2026-11-18T10:04:12.000Z',
      payload: {
        path: 'src/state.py',
        version: '2',
        digest:
          '222222222222222222222222222222222222222222222222222222222222a111',
      },
      provenance: 'hirearchy.candidate_session_events',
    },
    {
      sequence: '3',
      type: 'AI_REQUEST_STARTED',
      timestamp: '2026-11-18T10:08:20.000Z',
      payload: {
        interactionId: 'ai_demo_01',
        promptChars: 174,
      },
      provenance: 'hirearchy.candidate_session_events',
    },
    {
      sequence: '4',
      type: 'AI_RESPONSE_COMPLETED',
      timestamp: '2026-11-18T10:08:24.000Z',
      payload: {
        interactionId: 'ai_demo_01',
        durationMs: 3640,
      },
      provenance: 'hirearchy.candidate_session_events',
    },
    {
      sequence: '5',
      type: 'EXECUTION_REQUESTED',
      timestamp: '2026-11-18T10:12:05.000Z',
      payload: {
        operationId: 'exec_demo_01',
        recipeId: 'pytest-local-v1',
      },
      provenance: 'hirearchy.candidate_session_events',
    },
    {
      sequence: '6',
      type: 'EXECUTION_COMPLETED',
      timestamp: '2026-11-18T10:12:08.000Z',
      payload: {
        operationId: 'exec_demo_01',
        exitCode: 1,
      },
      provenance: 'hirearchy.candidate_session_events',
    },
    {
      sequence: '7',
      type: 'WORKSPACE_CHANGED',
      timestamp: '2026-11-18T10:17:40.000Z',
      payload: {
        path: 'src/state.py',
        version: '3',
        digest: DIGESTS.submittedState,
      },
      provenance: 'hirearchy.candidate_session_events',
    },
    {
      sequence: '8',
      type: 'WORKSPACE_CHANGED',
      timestamp: '2026-11-18T10:22:15.000Z',
      payload: {
        path: 'src/service.py',
        version: '3',
        digest:
          '333333333333333333333333333333333333333333333333333333333333b222',
      },
      provenance: 'hirearchy.candidate_session_events',
    },
    {
      sequence: '9',
      type: 'EXECUTION_REQUESTED',
      timestamp: '2026-11-18T10:24:30.000Z',
      payload: {
        operationId: 'exec_demo_02',
        recipeId: 'pytest-local-v1',
      },
      provenance: 'hirearchy.candidate_session_events',
    },
    {
      sequence: '10',
      type: 'EXECUTION_COMPLETED',
      timestamp: '2026-11-18T10:24:33.000Z',
      payload: {
        operationId: 'exec_demo_02',
        exitCode: 1,
      },
      provenance: 'hirearchy.candidate_session_events',
    },
    {
      sequence: '11',
      type: 'AI_REQUEST_STARTED',
      timestamp: '2026-11-18T10:27:10.000Z',
      payload: {
        interactionId: 'ai_demo_02',
        promptChars: 149,
      },
      provenance: 'hirearchy.candidate_session_events',
    },
    {
      sequence: '12',
      type: 'AI_RESPONSE_COMPLETED',
      timestamp: '2026-11-18T10:27:14.000Z',
      payload: {
        interactionId: 'ai_demo_02',
        durationMs: 3910,
      },
      provenance: 'hirearchy.candidate_session_events',
    },
    {
      sequence: '13',
      type: 'WORKSPACE_CHANGED',
      timestamp: '2026-11-18T10:30:45.000Z',
      payload: {
        path: 'src/service.py',
        version: '4',
        digest:
          '333333333333333333333333333333333333333333333333333333333333b333',
      },
      provenance: 'hirearchy.candidate_session_events',
    },
    {
      sequence: '14',
      type: 'WORKSPACE_CHANGED',
      timestamp: '2026-11-18T10:34:10.000Z',
      payload: {
        path: 'tests/test_concurrency_edge_cases.py',
        version: '2',
        digest: DIGESTS.addedEdgeTests,
      },
      provenance: 'hirearchy.candidate_session_events',
    },
    {
      sequence: '15',
      type: 'WORKSPACE_CHANGED',
      timestamp: '2026-11-18T10:35:50.000Z',
      payload: {
        path: 'src/service.py',
        version: '5',
        digest: DIGESTS.submittedService,
      },
      provenance: 'hirearchy.candidate_session_events',
    },
    {
      sequence: '16',
      type: 'EXECUTION_REQUESTED',
      timestamp: '2026-11-18T10:36:40.000Z',
      payload: {
        operationId: 'exec_demo_03',
        recipeId: 'pytest-local-v1',
      },
      provenance: 'hirearchy.candidate_session_events',
    },
    {
      sequence: '17',
      type: 'EXECUTION_COMPLETED',
      timestamp: '2026-11-18T10:36:43.000Z',
      payload: {
        operationId: 'exec_demo_03',
        exitCode: 0,
      },
      provenance: 'hirearchy.candidate_session_events',
    },
    {
      sequence: '18',
      type: 'SESSION_SUBMITTED',
      timestamp: '2026-11-18T10:38:15.000Z',
      payload: {
        closureReason: 'candidate_submission',
        workspaceDigest: DIGESTS.submittedWorkspace,
      },
      provenance: 'hirearchy.candidate_session_events',
    },
  ],
  aiInteractions: [
    {
      interactionId: 'ai_demo_01',
      requestId: 'req_ai_demo_01',
      sequenceStart: '3',
      sequenceCompleted: '4',
      candidatePrompt:
        'In State.transfer, if we avoid popping before validating capacity, should transferring to the exact same slot short-circuit before the occupancy >= capacity check?',
      assistantResponse:
        'Yes. Because the reservation already occupies that slot, moving to its current slot adds zero net occupancy. Short-circuiting `source == destination` before the capacity check ensures same-slot transfers succeed even when the slot is at full capacity.',
      status: 'COMPLETED',
      failureReason: null,
      errorMessage: null,
      providerId: 'workspace-assistant',
      modelId: 'hirearchy-workspace-assistant-v1',
      createdAt: '2026-11-18T10:08:20.000Z',
      completedAt: '2026-11-18T10:08:24.000Z',
    },
    {
      interactionId: 'ai_demo_02',
      requestId: 'req_ai_demo_02',
      sequenceStart: '11',
      sequenceCompleted: '12',
      candidatePrompt:
        'If Sender.deliver raises TimeoutError("before") on attempt 1 and a later operation moves the booking to C, what key should replay of op 1 pass to Sender?',
      assistantResponse:
        'Use the operation identity `(account, reservation, operation)` rather than `(account, reservation)` so historical confirmations never collide with later moves. Storing the frozen payload before calling `sender.deliver` lets a replay deliver the original confirmation safely.',
      status: 'COMPLETED',
      failureReason: null,
      errorMessage: null,
      providerId: 'workspace-assistant',
      modelId: 'hirearchy-workspace-assistant-v1',
      createdAt: '2026-11-18T10:27:10.000Z',
      completedAt: '2026-11-18T10:27:14.000Z',
    },
  ],
  executions: [
    {
      organizationId: DEMO_ORGANIZATION_ID,
      sessionId: DEMO_SESSION_ID,
      operationId: 'exec_demo_01',
      requestId: 'req_exec_01',
      sequenceStart: '5',
      sequenceCompleted: '6',
      workspaceDigest: DIGESTS.starterWorkspace,
      workspaceVersion: '2',
      recipeId: 'pytest-local-v1',
      recipeVersion: '1',
      recipeDigest: 'recipe_pytest_v1_digest',
      generation: 1,
      fence: 1,
      status: 'COMPLETED',
      exitCode: 1,
      stdout:
        'F.F\nFAILED tests/test_moves.py::test_full_destination_preserves_original_seat_and_does_not_consume_intent\nFAILED tests/test_moves.py::test_ambiguous_confirmation_keeps_local_acceptance_and_replays_original\n2 failed, 1 passed in 0.14s\n',
      stderr: '',
      stdoutDigest: 'stdout_exec_01',
      stderrDigest: 'stderr_empty',
      truncatedStdout: false,
      truncatedStderr: false,
      durationMs: 2840,
      failureReason: null,
      errorMessage: null,
      cleanupStatus: 'CLEAN',
      isUnknown: false,
      provenance: 'restricted-executor-sample',
      isSynthetic: true,
      createdAt: '2026-11-18T10:12:05.000Z',
      completedAt: '2026-11-18T10:12:08.000Z',
    },
    {
      organizationId: DEMO_ORGANIZATION_ID,
      sessionId: DEMO_SESSION_ID,
      operationId: 'exec_demo_02',
      requestId: 'req_exec_02',
      sequenceStart: '9',
      sequenceCompleted: '10',
      workspaceDigest:
        '333333333333333333333333333333333333333333333333333333333333b222',
      workspaceVersion: '4',
      recipeId: 'pytest-local-v1',
      recipeVersion: '1',
      recipeDigest: 'recipe_pytest_v1_digest',
      generation: 1,
      fence: 2,
      status: 'COMPLETED',
      exitCode: 1,
      stdout:
        '..F\nFAILED tests/test_moves.py::test_ambiguous_confirmation_keeps_local_acceptance_and_replays_original - KeyError: pending receipt not re-delivered on replay\n1 failed, 2 passed in 0.11s\n',
      stderr: '',
      stdoutDigest: 'stdout_exec_02',
      stderrDigest: 'stderr_empty',
      truncatedStdout: false,
      truncatedStderr: false,
      durationMs: 2410,
      failureReason: null,
      errorMessage: null,
      cleanupStatus: 'CLEAN',
      isUnknown: false,
      provenance: 'restricted-executor-sample',
      isSynthetic: true,
      createdAt: '2026-11-18T10:24:30.000Z',
      completedAt: '2026-11-18T10:24:33.000Z',
    },
    {
      organizationId: DEMO_ORGANIZATION_ID,
      sessionId: DEMO_SESSION_ID,
      operationId: 'exec_demo_03',
      requestId: 'req_exec_03',
      sequenceStart: '16',
      sequenceCompleted: '17',
      workspaceDigest: DIGESTS.submittedWorkspace,
      workspaceVersion: '8',
      recipeId: 'pytest-local-v1',
      recipeVersion: '1',
      recipeDigest: 'recipe_pytest_v1_digest',
      generation: 1,
      fence: 3,
      status: 'COMPLETED',
      exitCode: 0,
      stdout:
        '......\n6 passed in 0.09s (2 starter + 3 candidate edge-case regression tests + 1 state conservation check)\n',
      stderr: '',
      stdoutDigest: 'stdout_exec_03',
      stderrDigest: 'stderr_empty',
      truncatedStdout: false,
      truncatedStderr: false,
      durationMs: 2190,
      failureReason: null,
      errorMessage: null,
      cleanupStatus: 'CLEAN',
      isUnknown: false,
      provenance: 'restricted-executor-sample',
      isSynthetic: true,
      createdAt: '2026-11-18T10:36:40.000Z',
      completedAt: '2026-11-18T10:36:43.000Z',
    },
  ],
  pagination: {
    limit: 100,
    nextAfterSequence: null,
  },
  availability: {
    terminal: 'available',
    ai: 'available',
    verification: 'unavailable',
    history: 'metadata_only',
    limitations: [
      'Sample interactive session using pre-captured chronological diffs, test runs, and neutral workspace AI exchanges.',
    ],
  },
};

export const DEMO_AI_REVIEW_REPORT: R27AiReviewReport = {
  sessionId: DEMO_SESSION_ID,
  organizationId: DEMO_ORGANIZATION_ID,
  score: 91,
  verdict: 'accept',
  verdictLabel: 'Should Accept',
  confidenceLabel: 'High Confidence',
  headline:
    'Resolved capacity preservation, operation-scoped idempotency, and timeout replay safety with added regression tests',
  rationale:
    'Across 38 minutes and 6 saved checkpoints, the candidate fixed State.transfer to validate before mutating reservations, separated operation-scoped keys from seat state in src/service.py, verified timeout replay edge cases with 3 new tests in tests/test_concurrency_edge_cases.py, and exited 0 on the final pytest run. Advisory only — human evaluator owns the hiring decision.',
  strengths: [
    'Fixed State.transfer in src/state.py to check key existence, destination validity, and capacity before mutating reservations, plus short-circuited same-slot transfers.',
    'Persisted accepted operation intent in state.operations before invoking sender.deliver so TimeoutError("before") and TimeoutError("after") stay recoverable without undoing later moves.',
    'Added 3 targeted edge-case tests in tests/test_concurrency_edge_cases.py covering timeout-before-delivery replay, full-slot no-op immutability, and dict copy isolation.',
    'Progressed cleanly from initial failing pytest baseline (exit 1) to full passing verification (exit 0) across 3 recorded runs.',
  ],
  weaknesses: [
    'Operation history grows unbounded in-memory for long-lived processes (acceptable per local task scope, worth probing in architecture debrief).',
  ],
  evidenceHighlights: [
    {
      label: 'Workspace Diff Footprint',
      detail:
        '3 of 5 files changed (+103 / -14 lines across src/state.py, src/service.py, and tests/test_concurrency_edge_cases.py).',
    },
    {
      label: 'Chronology & Checkpoints',
      detail:
        '18 session events (6 workspace saves) over 38m, finalized via explicit candidate submission.',
    },
    {
      label: 'Verification & AI Signals',
      detail:
        '3 execution runs recorded (fail -> partial -> pass exit 0) · 2 neutral AI assistant exchanges.',
    },
  ],
  timingInsights: [
    '00:00–04:12 — Diagnosed State.transfer pop-before-validate bug and saved initial capacity guard.',
    '08:20–12:08 — Verified same-slot no-op semantics and ran baseline pytest reproduction (exit 1).',
    '17:40–30:45 — Refactored src/service.py to commit operation intent prior to Sender.deliver and key by (account, reservation, operation).',
    '34:10–38:15 — Added tests/test_concurrency_edge_cases.py, confirmed exit 0, and submitted.',
  ],
  requirementBreakdown: [
    {
      requirement: 'Reject unknown or full destinations safely',
      status: 'met',
      evidence:
        'src/state.py validates key presence, capacity key, and occupancy before mutating reservations.',
    },
    {
      requirement: 'Operation-scoped idempotent replay & conflict detection',
      status: 'met',
      evidence:
        'src/service.py binds (account, reservation, operation) to destination/recipient and returns fresh result copies.',
    },
    {
      requirement: 'Ambiguous timeout recovery without regressing later moves',
      status: 'met',
      evidence:
        'Pending receipt is persisted prior to sender.deliver and re-delivered with original payload on replay.',
    },
  ],
  verificationQuestions: [
    {
      question:
        'In src/service.py, why did you key Sender.deliver by (account, reservation, operation) instead of (account, reservation)?',
      focus: 'Idempotency key scoping and cross-operation isolation',
    },
    {
      question:
        'What happens in production if two concurrent threads execute move() for the same reservation without an external lock?',
      focus: 'Concurrency model and transactional boundary trade-offs',
    },
    {
      question:
        'Why did you choose to persist state.operations before calling sender.deliver rather than after?',
      focus: 'Crash/timeout recovery semantics',
    },
  ],
  metrics: {
    submittedFilesCount: 5,
    modifiedFilesCount: 3,
    linesAdded: 103,
    linesRemoved: 14,
    timelineEventsCount: 18,
    saveEventsCount: 6,
  },
  provider: {
    providerId: 'preview',
    modelId: 'hirearchy-evidence-preview-v1',
    label: 'Advisory AI · Evidence Preview (Sandbox)',
    mode: 'evidence_preview',
  },
  generatedAt: '2026-11-18T10:39:00.000Z',
};

export const DEMO_PERFORMANCE_FIT_REPORT: PerformanceFitReport = {
  overallFitVerdict: 'strong_fit',
  fitHeadline:
    'Strong backend correctness & idempotency reasoning verified by progressive test runs',
  whyGoodOrBadFit:
    'Maya diagnosed the state-mutation-before-validation defect early, separated historical confirmation records from live seat state, and independently authored edge-case tests for before/after delivery timeouts and dict aliasing.',
  requirementAssessment: [
    {
      requirement: 'Seat & capacity conservation under failure',
      status: 'demonstrated',
      evidence:
        'State.transfer validates key, destination, and occupancy before mutation; same-slot no-ops bypass capacity rejection.',
    },
    {
      requirement: 'Idempotent replay & conflict protection',
      status: 'demonstrated',
      evidence:
        'move() keys operations by (account, reservation, operation) and raises ValueError on mismatched destination or recipient.',
    },
    {
      requirement: 'Fault tolerance on ambiguous upstream timeouts',
      status: 'demonstrated',
      evidence:
        'Accepted intent is committed before Sender.deliver and replayed with its original payload if receipt was None.',
    },
    {
      requirement: 'Distributed locking / multi-process persistence',
      status: 'not_assessed',
      evidence:
        'Task contract specifies single-process sequential calls; discuss database row locking or optimistic versioning in live debrief.',
    },
  ],
  strengths: [
    'Clean separation between state invariants (src/state.py) and upstream delivery idempotency (src/service.py).',
    'Proactive defensive copying on returned dicts and stored payloads to prevent caller aliasing bugs.',
    'Methodical red-to-green verification progression across 3 sandbox runs.',
  ],
  weaknessesAndRisks: [
    'In-memory state.operations dictionary has no eviction/TTL policy for high-throughput services.',
  ],
  clearlyDemonstrated: [
    'Atomic pre-validation before state mutation',
    'Idempotent operation key design and timeout replay handling',
    'Self-authored edge-case unit tests',
  ],
  unclearOrNotAssessed: [
    'Concurrency control under parallel workers (SELECT FOR UPDATE vs CAS)',
    'Operation log compaction / bounded retention strategies',
  ],
  suggestedNextInterviewQuestions: [
    'If this move service backed PostgreSQL across multiple API pods, how would you adapt your state.operations and State.transfer ordering?',
    'Walk through how you handled a TimeoutError occurring after Sender.deliver recorded delivery vs before delivery.',
    'How would you bound the memory footprint of state.operations over millions of bookings without breaking idempotency?',
  ],
  provider: {
    modelId: 'hirearchy-evidence-preview-v1',
    mode: 'evidence_summary',
    generatedAt: '2026-11-18T10:42:00.000Z',
  },
};

export function buildSampleHiringReviewContext(options?: {
  organizationId?: string;
  organizationName?: string;
  currentPrincipalId?: string;
}): SessionHiringReviewContext {
  const organizationId = options?.organizationId ?? DEMO_ORGANIZATION_ID;
  const organizationName =
    options?.organizationName ?? 'Northstar Systems (Interactive Demo)';
  const currentPrincipalId =
    options?.currentPrincipalId ?? DEMO_REVIEWER_PRINCIPAL_ID;

  return {
    organizationId,
    organizationName,
    sessionId: DEMO_SESSION_ID,
    scenarioTitle: DEMO_SCENARIO_TITLE,
    currentPrincipalId,
    currentRole: 'cto',
    isOwner: true,
    canPublishDecision: true,
    plan: {
      planTier: 'ultra',
      candidateCreditsPurchased: 25,
      candidateCreditsUsed: 4,
      candidateCreditsRemaining: 21,
      creditedEmails: [],
      updatedAt: '2026-11-18T09:00:00.000Z',
    },
    targetRole: 'Senior Backend Engineer',
    experienceLevel: 'senior',
    skills: [
      'Python',
      'Concurrency & Idempotency',
      'Testing & Debugging',
      'API Contracts',
    ],
    candidateEmail: null,
    candidateName: 'Maya Lin',
    candidateCode: 'HRC-DEMO01',
    decision: null,
    secondOpinions: [
      {
        id: 'opinion_demo_01',
        sessionId: DEMO_SESSION_ID,
        requestedByPrincipalId: currentPrincipalId,
        requestedByName: 'Samira Chen (VP Engineering)',
        requestedReviewerPrincipalId: DEMO_PEER_PRINCIPAL_ID,
        requestedReviewerName: 'Alex Rivera (Staff Engineer)',
        requestNote:
          'Please verify how she handles TimeoutError("before") followed by a newer move to C.',
        requestContext: {
          evaluatorStrengths: [
            'Isolated state validation cleanly before mutating reservations.',
          ],
          evaluatorWeaknesses: [
            'Check whether operation history grows unbounded.',
          ],
        },
        responseNote:
          'Confirmed in src/service.py lines 33–55: state.operations persists the frozen payload before sender.deliver, and replay re-delivers using op_key without touching the current slot in C. Recommend advancing to architecture debrief.',
        verdict: 'approve',
        status: 'completed',
        createdAt: '2026-11-18T10:40:00.000Z',
        respondedAt: '2026-11-18T10:48:00.000Z',
      },
    ],
    teamMembers: [
      {
        principalId: currentPrincipalId,
        displayName: 'Samira Chen (You)',
        email: 'samira@northstar-demo.invalid',
        role: 'cto',
        isOwner: true,
      },
      {
        principalId: DEMO_PEER_PRINCIPAL_ID,
        displayName: 'Alex Rivera',
        email: 'alex@northstar-demo.invalid',
        role: 'reviewer',
        isOwner: false,
      },
      {
        principalId: DEMO_MANAGER_PRINCIPAL_ID,
        displayName: 'Jordan Patel',
        email: 'jordan@northstar-demo.invalid',
        role: 'recruiter',
        isOwner: false,
      },
    ],
    initialAiReview: DEMO_AI_REVIEW_REPORT,
  };
}

export const DEMO_HIRING_REVIEW_CONTEXT: SessionHiringReviewContext =
  buildSampleHiringReviewContext();

export interface PublicDossierEvidenceSummary {
  readonly durationMinutes: number | null;
  readonly filesModified: number;
  readonly totalFiles: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly saveCheckpointsCount: number;
  readonly executionRunsPassed: number;
  readonly executionRunsTotal: number;
  readonly aiInteractionsCount: number;
}

export interface PublicDossierView {
  readonly isDemo: boolean;
  readonly organizationName: string;
  readonly visibilityMode: 'redacted' | 'named';
  readonly candidateDisplay: string;
  readonly candidateCode: string | null;
  readonly headlineRole: string | null;
  readonly locationLabel: string | null;
  readonly targetRole: string;
  readonly experienceLevel: string;
  readonly skills: readonly string[];
  readonly scenarioTitle: string;
  readonly decision: 'accepted' | 'rejected';
  readonly nextStageLabel: string | null;
  readonly decidedByName: string;
  readonly publishedAt: string;
  readonly expiresAt: string | null;
  readonly candidateStrengths: readonly string[];
  readonly candidateWeaknesses: readonly string[];
  readonly candidateFeedbackNote: string;
  readonly includeAiAdvisory: boolean;
  readonly includeVerificationQuestions: boolean;
  readonly evidenceSummary: PublicDossierEvidenceSummary;
  readonly performanceReport: PerformanceFitReport | null;
  readonly peerVerdictsSummary: readonly {
    readonly reviewerName: string;
    readonly verdict: 'approve' | 'comment' | 'request_changes';
    readonly responseNote: string | null;
  }[];
}

export const DEMO_PUBLIC_DOSSIER: PublicDossierView = {
  isDemo: true,
  organizationName: 'Northstar Systems (Demo)',
  visibilityMode: 'redacted',
  candidateDisplay: 'Maya L.',
  candidateCode: 'HRC-DEMO01',
  headlineRole: 'Senior Backend Engineer',
  locationLabel: null,
  targetRole: 'Senior Backend Engineer',
  experienceLevel: 'senior',
  skills: [
    'Python',
    'Concurrency & Idempotency',
    'Testing & Debugging',
    'API Contracts',
  ],
  scenarioTitle: DEMO_SCENARIO_TITLE,
  decision: 'accepted',
  nextStageLabel: 'Architecture & Systems Debrief',
  decidedByName: 'Samira Chen (VP Engineering)',
  publishedAt: '2026-11-18T10:52:00.000Z',
  expiresAt: null,
  candidateStrengths: [
    'Fixed seat capacity conservation in State.transfer before any reservation mutation.',
    'Separated operation-scoped confirmation records from current booking location so historical retries never regress newer moves.',
    'Authored 3 targeted edge-case tests in tests/test_concurrency_edge_cases.py and verified red-to-green exit 0.',
  ],
  candidateWeaknesses: [
    'Explore bounded retention / compaction strategies for operation logs in distributed storage.',
  ],
  candidateFeedbackNote:
    'Clear, disciplined state modeling and thorough edge-case coverage around ambiguous delivery timeouts and no-op capacity boundaries. Excited to discuss distributed concurrency in the next interview.',
  includeAiAdvisory: true,
  includeVerificationQuestions: true,
  evidenceSummary: {
    durationMinutes: 38,
    filesModified: 3,
    totalFiles: 5,
    linesAdded: 103,
    linesRemoved: 14,
    saveCheckpointsCount: 6,
    executionRunsPassed: 1,
    executionRunsTotal: 3,
    aiInteractionsCount: 2,
  },
  performanceReport: DEMO_PERFORMANCE_FIT_REPORT,
  peerVerdictsSummary: [
    {
      reviewerName: 'Alex Rivera (Staff Engineer)',
      verdict: 'approve',
      responseNote:
        'Verified TimeoutError("before") replay safety in src/service.py; clean state separation.',
    },
  ],
};

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/**
 * Strictly projects only allowlisted, zero-PII fields from `staging.hiring_dossier_share_resolve`.
 */
export function normalizeResolvedDossier(
  raw: unknown,
): PublicDossierView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const candidate =
    obj.candidate &&
    typeof obj.candidate === 'object' &&
    !Array.isArray(obj.candidate)
      ? (obj.candidate as Record<string, unknown>)
      : {};
  const decisionObj =
    obj.decision &&
    typeof obj.decision === 'object' &&
    !Array.isArray(obj.decision)
      ? (obj.decision as Record<string, unknown>)
      : {};
  const summaryObj =
    obj.evidenceSummary &&
    typeof obj.evidenceSummary === 'object' &&
    !Array.isArray(obj.evidenceSummary)
      ? (obj.evidenceSummary as Record<string, unknown>)
      : {};

  const visibilityMode = obj.visibilityMode === 'named' ? 'named' : 'redacted';
  const decisionValue =
    decisionObj.decision === 'rejected' ? 'rejected' : 'accepted';
  const includeAiAdvisory = obj.includeAiAdvisory !== false;
  const includeVerificationQuestions =
    obj.includeVerificationQuestions !== false;

  const candidateCode = asString(candidate.candidateCode) || null;
  const rawDisplayName = asString(candidate.displayName);
  const candidateDisplay =
    rawDisplayName ||
    (candidateCode ? `Candidate ${candidateCode}` : 'Candidate');

  const locationLabel =
    visibilityMode === 'named'
      ? [asString(candidate.locationCity), asString(candidate.locationCountry)]
          .filter(Boolean)
          .join(', ') || null
      : null;

  const rawReport =
    includeAiAdvisory &&
    obj.performanceReport &&
    typeof obj.performanceReport === 'object' &&
    !Array.isArray(obj.performanceReport)
      ? (obj.performanceReport as PerformanceFitReport)
      : null;

  const performanceReport: PerformanceFitReport | null = rawReport
    ? {
        ...rawReport,
        suggestedNextInterviewQuestions: includeVerificationQuestions
          ? Array.isArray(rawReport.suggestedNextInterviewQuestions)
            ? rawReport.suggestedNextInterviewQuestions
            : []
          : [],
      }
    : null;

  return {
    isDemo: false,
    organizationName: asString(obj.organizationName, 'Engineering Team'),
    visibilityMode,
    candidateDisplay,
    candidateCode,
    headlineRole:
      visibilityMode === 'named'
        ? asString(candidate.headlineRole) || null
        : null,
    locationLabel,
    targetRole: asString(obj.targetRole, 'Software Engineer'),
    experienceLevel: asString(obj.experienceLevel, 'mid'),
    skills: asStringArray(obj.skills),
    scenarioTitle: asString(obj.scenarioTitle, 'Engineering Assessment'),
    decision: decisionValue,
    nextStageLabel: asString(decisionObj.nextStageLabel) || null,
    decidedByName: asString(decisionObj.decidedByName, 'Hiring Team'),
    publishedAt: asString(decisionObj.publishedAt, new Date().toISOString()),
    expiresAt: asString(obj.expiresAt) || null,
    candidateStrengths: asStringArray(decisionObj.candidateStrengths),
    candidateWeaknesses: asStringArray(decisionObj.candidateWeaknesses),
    candidateFeedbackNote: asString(decisionObj.candidateFeedbackNote),
    includeAiAdvisory,
    includeVerificationQuestions,
    evidenceSummary: {
      durationMinutes: asNumberOrNull(summaryObj.durationMinutes),
      filesModified:
        asNumberOrNull(summaryObj.filesChanged) ??
        asNumberOrNull(summaryObj.filesModified) ??
        0,
      totalFiles: asNumberOrNull(summaryObj.totalFiles) ?? 0,
      linesAdded: asNumberOrNull(summaryObj.linesAdded) ?? 0,
      linesRemoved: asNumberOrNull(summaryObj.linesRemoved) ?? 0,
      saveCheckpointsCount: asNumberOrNull(summaryObj.revisionCount) ?? 0,
      executionRunsPassed: asNumberOrNull(summaryObj.executionRunsPassed) ?? 0,
      executionRunsTotal: asNumberOrNull(summaryObj.executionRunsTotal) ?? 0,
      aiInteractionsCount: asNumberOrNull(summaryObj.aiInteractionsCount) ?? 0,
    },
    performanceReport,
    peerVerdictsSummary: [],
  };
}
