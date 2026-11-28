import { Easing, interpolate } from 'remotion';
import kimiReviewRaw from './data/kimi-real-review.json';

export const FPS = 60;

export const COLORS = {
  // Common Thread Brand Palette
  plumDeep: '#190f22',
  plum: '#211426',
  plumMid: '#2d1e38',
  plumSoft: '#3b2949',
  plumLine: '#4a3859',
  paper: '#f5efe6',
  paperElevated: '#fffdf9',
  paperSubtle: '#eee7dd',
  lilac: '#ebe5f2',
  lilacDeep: '#dcd2e8',
  mint: '#b0f0ce',
  mintStrong: '#8ee3b8',
  mintDeep: '#2f6f54',
  mintInk: '#174834',
  coral: '#ff9b88',
  purple: '#bb98f4',
  ink: '#24182b',
  inkSoft: '#4c3e56',
  muted: '#6d5e75',
  onPlum: '#f5efe6',
  onPlumMuted: '#c5b8d0',
  onPlumFaint: '#8f7e9e',
  border: '#ddd3c8',
  borderStrong: '#bfb2c9',
  // Semantic observable states (never brand accents)
  pass: '#166534',
  passBg: '#ecfdf3',
  passBorder: '#bbf7d0',
  passDark: '#7ee6b0',
  fail: '#b42318',
  failBg: '#fef2f2',
  failBorder: '#fecaca',
  failDark: '#ff8a80',
  warn: '#854d0e',
  warnBg: '#fefce8',
  warnBorder: '#fde68a',
} as const;

// Architectural easing curves: crisp, mechanical-yet-human, ZERO bouncy spring gimmicks
export const EASE_EDITORIAL = Easing.bezier(0.22, 1, 0.36, 1);
export const EASE_CAMERA = Easing.bezier(0.42, 0.0, 0.18, 1);
export const EASE_SMOOTH = Easing.bezier(0.35, 0.05, 0.25, 1);
export const EASE_EXIT = Easing.bezier(0.4, 0, 1, 1);

export function prog(
  t: number,
  start: number,
  end: number,
  easing: (x: number) => number = EASE_EDITORIAL,
): number {
  if (end <= start) return t >= start ? 1 : 0;
  return interpolate(t, [start, end], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing,
  });
}

export function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}

export interface KimiRealReview {
  score: number;
  verdict: string;
  confidenceLabel: string;
  headline: string;
  rationale: string;
  strengths: string[];
  weaknesses: string[];
  timingInsights: string[];
  fitHeadline: string;
  nextInterviewQuestions: string[];
}

export const KIMI_REVIEW: KimiRealReview = kimiReviewRaw as KimiRealReview;

export const SCENARIO = {
  title: 'Payment Webhook Deduplication',
  role: 'Senior Backend Engineer',
  level: 'Senior (5+ yrs)',
  stack: 'Python · Concurrency & Idempotency',
  duration: '60 min',
  candidateName: 'Elena Vance',
  candidateCode: 'HRC-8492',
  candidateEmail: 'elena.vance@northline.dev',
  evaluatorName: 'Sam Rivera',
  evaluatorRole: 'Staff Engineer',
  peerName: 'Jordan Lee',
  peerRole: 'Principal Backend',
  managerName: 'Maya Chen',
  managerRole: 'VP of Engineering',
  primaryFile: 'src/webhook_handler.py',
} as const;

export const CHRONOLOGY_EVENTS = [
  {
    seq: 1,
    offset: '00:00',
    delta: 'Start',
    title: 'Session activated',
    detail: 'Opened Payment Webhook Deduplication · 4 files',
    kind: 'neutral' as const,
  },
  {
    seq: 2,
    offset: '03:12',
    delta: 'Δ 3m 12s',
    title: 'Ran pytest tests/test_webhooks.py',
    detail: '2 failed, 1 passed — duplicate credit & state regression',
    kind: 'fail' as const,
  },
  {
    seq: 3,
    offset: '06:48',
    delta: 'Δ 3m 36s',
    title: 'Workspace AI query logged',
    detail: 'Asked about idempotent out-of-order status semantics',
    kind: 'ai' as const,
  },
  {
    seq: 4,
    offset: '11:05',
    delta: 'Δ 4m 17s',
    title: 'Saved src/webhook_handler.py (v2)',
    detail: '+14 / -4 · delivery_id set & STATUS_RANK monotonic guard',
    kind: 'save' as const,
  },
  {
    seq: 5,
    offset: '13:19',
    delta: 'Δ 2m 14s',
    title: 'Ran pytest tests/test_webhooks.py',
    detail: '4 passed in 0.14s · Exit code 0',
    kind: 'pass' as const,
  },
  {
    seq: 6,
    offset: '14:22',
    delta: 'Δ 1m 03s',
    title: 'Work submitted',
    detail: 'Immutable snapshot & provenance digest sealed',
    kind: 'submit' as const,
  },
] as const;

// Exact realistic Python starter vs fixed lines for src/webhook_handler.py
export const CODE_HEADER_LINES = [
  { num: 108, text: 'EVENT_TO_STATUS = {' },
  { num: 109, text: '    "payment.authorized": "authorized",' },
  { num: 110, text: '    "payment.settled": "settled",' },
  { num: 111, text: '    "payment.refunded": "refunded",' },
  { num: 112, text: '}' },
  { num: 113, text: '' },
  {
    num: 114,
    text: 'def handle_webhook(ledger: MerchantLedger, event: WebhookEvent) -> str:',
  },
];

export const CODE_ADDED_DEDUPE = [
  '    delivery_id = event["delivery_id"]',
  '    if delivery_id in ledger.processed_deliveries:',
  '        existing = ledger.payments.get(event["payment_id"])',
  '        return existing.status if existing else "pending"',
];

export const CODE_MIDDLE_LINES = [
  '    payment = ledger.get_or_create(event["payment_id"], event["amount_cents"])',
  '    target = EVENT_TO_STATUS.get(event["event_type"])',
  '    if target is None:',
  '        raise ValueError(f"Unsupported event: {event[\'event_type\']}")',
];

export const CODE_ADDED_GUARD = [
  '    ledger.processed_deliveries.add(delivery_id)',
  '    if STATUS_RANK[target] <= STATUS_RANK[payment.status]:',
  '        return payment.status',
];

export const CODE_FOOTER_LINES = [
  '    if target == "settled":',
  '        ledger.balance_cents += event["amount_cents"]',
  '        payment.settled_cents += event["amount_cents"]',
  '    elif target == "refunded":',
  '        ledger.balance_cents -= event["amount_cents"]',
  '        payment.refunded_cents += event["amount_cents"]',
  '    payment.status = target',
  '    return payment.status',
];
