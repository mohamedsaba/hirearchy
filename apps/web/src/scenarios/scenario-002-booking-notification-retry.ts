import {
  defaultAiCapabilitySnapshot,
  type AiCapabilitySnapshot,
} from '../ai/ai-interaction';
import type { ScenarioSnapshot } from './slice-one-scenario';

export const scenario002AiCapability: AiCapabilitySnapshot = {
  ...defaultAiCapabilitySnapshot,
};

export const scenario002: ScenarioSnapshot = {
  id: 'scenario-002-booking-notification-retry',
  version: '1.0.0',
  durationSeconds: 3600,
  title: 'The second confirmation',
  brief: [
    'North Pier Ferries runs two island routes from a small terminal on the coast. On busy mornings, the operations desk has received a few reports from passengers who saw more than one booking confirmation for what they understood to be one checkout.',
    '',
    'The payment provider may retry a checkout notification when it does not receive an acknowledgement promptly. The operations desk has not yet been able to reproduce the pattern consistently, and the point where the second confirmation is introduced is still unclear.',
    '',
    'You are joining the service team for a focused investigation. Explore the repository, make a change that addresses the reported behavior, and verify it while preserving normal bookings for separate checkouts.',
    '',
    'The workspace contains a small Flask service backed by SQLite. Run `pytest` from the repository root. The service is available at `http://127.0.0.1:8000` inside the workspace.',
    '',
    'There is more than one reasonable implementation path. Use the evidence in the repository and tests to guide your work, and submit when you are ready.',
  ].join('\n'),
  acceptanceCriteria: [
    'Repeated delivery of the same provider checkout does not create duplicate booking or confirmation records.',
    'A distinct provider checkout for the same passenger can still create a separate booking and confirmation.',
    'Invalid confirmation input does not create a booking.',
    'The supplied verification suite passes after the change.',
  ],
  filePath: 'bookings/service.py',
  originalContent: '',
  type: 'multi_file',
  imageName: 'hirearchy-scenario-002:v1.0.0',
  evaluationContext: {
    schemaVersion: 1,
    version: '1.0.0',
    purpose:
      'Present recorded work and verification related to North Pier booking confirmation delivery while keeping task outcome separate from evaluator judgment.',
    evidenceAreas: [
      {
        id: 'booking-confirmation-change',
        title: 'Booking confirmation changes',
        description:
          'Workspace and submitted-state records related to provider confirmation handling.',
        selectors: [
          {
            kind: 'workspace_path_prefix',
            prefixes: ['bookings/', 'app.py', 'tests/'],
          },
          {
            kind: 'submitted_path_prefix',
            prefixes: ['bookings/', 'app.py', 'tests/'],
          },
        ],
      },
      {
        id: 'recorded-verification',
        title: 'Recorded verification',
        description:
          'Authoritative test summaries recorded in the assessment environment.',
        selectors: [{ kind: 'verification_result' }],
      },
    ],
    systemInvariants: [
      'Separate provider checkouts represent separate booking requests.',
      'The provider may retry delivery when it does not receive a prompt acknowledgement.',
    ],
    verificationTargets: [
      'Whether repeated delivery of one provider checkout is represented in recorded verification.',
      'Whether separate checkouts remain represented in recorded verification.',
      'Whether invalid input is covered by recorded verification.',
    ],
    interpretationWarnings: [
      'Related evidence identifies recorded activity associated with a scenario area; it does not establish task success or candidate competence.',
      'A failing test or command can be valid investigative activity and is not a candidate verdict.',
      'Not observed means Hirearchy Software recorded no evidence of that activity in the captured assessment environment. It does not mean the candidate lacks the underlying capability.',
    ],
    reviewPolicy: [
      'Final automated verification alone is not a hiring decision for this assessment. Engineering review is required before technical rejection.',
    ],
  },
};
