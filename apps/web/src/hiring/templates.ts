import { normalizeAssessmentTemplate } from '../../../../database/postgres/r211/template.mjs';
import type {
  R211AssessmentDraftInput,
  R211RubricCriterion,
  R211StarterFile,
} from '../r211-builder/contract';
import type { ExperienceLevelId, ProblemStructureId } from './catalogs';

export interface PlatformTemplateDefinition {
  readonly templateId:
    'reservation-moves-v3' | 'webhook-dedup-v1' | 'cache-rate-limiter-v1';
  readonly scenarioId: string;
  readonly scenarioVersion: string;
  readonly title: string;
  readonly summary: string;
  readonly targetRole: string;
  readonly experienceLevel: ExperienceLevelId;
  readonly yearsExperience: number;
  readonly domain: string;
  readonly workKind: string;
  readonly problemStructure: ProblemStructureId;
  readonly skills: readonly string[];
  readonly defaultDurationMinutes: 30 | 45 | 60 | 90;
  readonly buildDraftInput: (options?: {
    durationMinutes?: number;
    integratedAi?: boolean;
  }) => R211AssessmentDraftInput;
}

const WEBHOOK_FILES: readonly R211StarterFile[] = [
  {
    path: 'README.md',
    content: `# Payment Webhook Deduplication & State Ordering

## Background
Our payments service receives asynchronous webhooks from an upstream processor (\`payment.authorized\`, \`payment.settled\`, \`payment.refunded\`). Because network retries occur and webhooks can arrive out of order, handlers must be idempotent and enforce forward-only state transitions.

## Observed Production Issue
1. Duplicate webhook deliveries with the same \`delivery_id\` are crediting or debiting merchant balances more than once.
2. When \`payment.settled\` arrives before \`payment.authorized\`, the handler currently drops it or regresses status when the delayed \`payment.authorized\` event arrives later.

## Your Task
Inspect \`src/models.py\`, \`src/ledger.py\`, and \`src/webhook_handler.py\`, then fix the state transition and deduplication behavior so all tests in \`tests/test_webhooks.py\` pass.
`,
  },
  {
    path: 'src/models.py',
    content: `from dataclasses import dataclass
from typing import Literal

PaymentStatus = Literal["pending", "authorized", "settled", "refunded"]

STATUS_RANK: dict[str, int] = {
    "pending": 0,
    "authorized": 1,
    "settled": 2,
    "refunded": 3,
}


@dataclass
class PaymentRecord:
    payment_id: str
    amount_cents: int
    status: PaymentStatus = "pending"
    settled_cents: int = 0
    refunded_cents: int = 0
`,
  },
  {
    path: 'src/ledger.py',
    content: `from src.models import PaymentRecord


class MerchantLedger:
    def __init__(self) -> None:
        self.payments: dict[str, PaymentRecord] = {}
        self.processed_deliveries: set[str] = set()
        self.balance_cents: int = 0

    def get_or_create(self, payment_id: str, amount_cents: int) -> PaymentRecord:
        if payment_id not in self.payments:
            self.payments[payment_id] = PaymentRecord(
                payment_id=payment_id,
                amount_cents=amount_cents,
            )
        return self.payments[payment_id]
`,
  },
  {
    path: 'src/webhook_handler.py',
    content: `from typing import TypedDict

from src.ledger import MerchantLedger
from src.models import STATUS_RANK


class WebhookEvent(TypedDict):
    delivery_id: str
    payment_id: str
    event_type: str
    amount_cents: int


EVENT_TO_STATUS = {
    "payment.authorized": "authorized",
    "payment.settled": "settled",
    "payment.refunded": "refunded",
}


def handle_webhook(ledger: MerchantLedger, event: WebhookEvent) -> str:
    payment = ledger.get_or_create(event["payment_id"], event["amount_cents"])
    target_status = EVENT_TO_STATUS.get(event["event_type"])
    if target_status is None:
        raise ValueError(f"Unsupported event type: {event['event_type']}")

    # BUG: does not deduplicate delivery_id or guard out-of-order transitions
    if target_status == "settled":
        ledger.balance_cents += event["amount_cents"]
        payment.settled_cents += event["amount_cents"]
    elif target_status == "refunded":
        ledger.balance_cents -= event["amount_cents"]
        payment.refunded_cents += event["amount_cents"]

    payment.status = target_status  # type: ignore[assignment]
    return payment.status
`,
  },
  {
    path: 'tests/test_webhooks.py',
    content: `from src.ledger import MerchantLedger
from src.webhook_handler import handle_webhook


def test_duplicate_delivery_is_idempotent() -> None:
    ledger = MerchantLedger()
    event = {
        "delivery_id": "deliv_100",
        "payment_id": "pay_1",
        "event_type": "payment.settled",
        "amount_cents": 5000,
    }
    handle_webhook(ledger, event)
    handle_webhook(ledger, event)
    assert ledger.balance_cents == 5000
    assert ledger.payments["pay_1"].settled_cents == 5000


def test_out_of_order_authorized_after_settled_does_not_regress() -> None:
    ledger = MerchantLedger()
    handle_webhook(
        ledger,
        {
            "delivery_id": "deliv_201",
            "payment_id": "pay_2",
            "event_type": "payment.settled",
            "amount_cents": 8000,
        },
    )
    handle_webhook(
        ledger,
        {
            "delivery_id": "deliv_202",
            "payment_id": "pay_2",
            "event_type": "payment.authorized",
            "amount_cents": 8000,
        },
    )
    assert ledger.payments["pay_2"].status == "settled"
    assert ledger.balance_cents == 8000


def test_refund_after_settled_balances_correctly() -> None:
    ledger = MerchantLedger()
    handle_webhook(
        ledger,
        {
            "delivery_id": "deliv_301",
            "payment_id": "pay_3",
            "event_type": "payment.settled",
            "amount_cents": 3000,
        },
    )
    handle_webhook(
        ledger,
        {
            "delivery_id": "deliv_302",
            "payment_id": "pay_3",
            "event_type": "payment.refunded",
            "amount_cents": 3000,
        },
    )
    handle_webhook(
        ledger,
        {
            "delivery_id": "deliv_302",
            "payment_id": "pay_3",
            "event_type": "payment.refunded",
            "amount_cents": 3000,
        },
    )
    assert ledger.payments["pay_3"].status == "refunded"
    assert ledger.balance_cents == 0
`,
  },
];

const RATE_LIMITER_FILES: readonly R211StarterFile[] = [
  {
    path: 'README.md',
    content: `# Sliding-Window Rate Limiter & Cache Staleness

## Background
An internal API gateway enforces per-tenant sliding-window rate limits and caches tenant tier configuration locally for fast lookups.

## Observed Production Issue
1. \`SlidingWindowLimiter.allow\` does not evict expired timestamps accurately at window boundaries, causing false rejections after idle periods and failing to count concurrent hits at the same timestamp.
2. \`TierPolicyCache\` serves stale tenant limits after \`invalidate(tenant_id)\` or TTL expiration when \`ttl_seconds == 0\` or clock advances exactly to the expiry boundary.

## Your Task
Fix \`src/limiter.py\` and \`src/cache.py\` without modifying the clock interface in \`src/clock.py\`. Verify edge cases with \`tests/test_limiter.py\`.
`,
  },
  {
    path: 'src/clock.py',
    content: `class ManualClock:
    def __init__(self, initial: float = 0.0) -> None:
        self._now = initial

    def now(self) -> float:
        return self._now

    def advance(self, seconds: float) -> float:
        self._now += seconds
        return self._now
`,
  },
  {
    path: 'src/cache.py',
    content: `from dataclasses import dataclass
from typing import Callable

from src.clock import ManualClock


@dataclass
class CacheEntry:
    limit: int
    expires_at: float


class TierPolicyCache:
    def __init__(
        self,
        clock: ManualClock,
        loader: Callable[[str], int],
        ttl_seconds: float = 60.0,
    ) -> None:
        self.clock = clock
        self.loader = loader
        self.ttl_seconds = ttl_seconds
        self._entries: dict[str, CacheEntry] = {}

    def get_limit(self, tenant_id: str) -> int:
        now = self.clock.now()
        entry = self._entries.get(tenant_id)
        # BUG: <= vs < expiry and ignores ttl_seconds <= 0
        if entry is not None and now <= entry.expires_at:
            return entry.limit
        limit = self.loader(tenant_id)
        self._entries[tenant_id] = CacheEntry(
            limit=limit,
            expires_at=now + self.ttl_seconds,
        )
        return limit

    def invalidate(self, tenant_id: str) -> None:
        # BUG: leaves stale entry when called
        pass
`,
  },
  {
    path: 'src/limiter.py',
    content: `from collections import deque

from src.cache import TierPolicyCache
from src.clock import ManualClock


class SlidingWindowLimiter:
    def __init__(
        self,
        clock: ManualClock,
        policy_cache: TierPolicyCache,
        window_seconds: float = 10.0,
    ) -> None:
        self.clock = clock
        self.policy_cache = policy_cache
        self.window_seconds = window_seconds
        self._requests: dict[str, deque[float]] = {}

    def allow(self, tenant_id: str) -> bool:
        now = self.clock.now()
        limit = self.policy_cache.get_limit(tenant_id)
        if limit <= 0:
            return False

        bucket = self._requests.setdefault(tenant_id, deque())
        cutoff = now - self.window_seconds
        # BUG: off-by-one eviction and counts dropped requests into bucket
        while bucket and bucket[0] < cutoff:
            bucket.popleft()

        bucket.append(now)
        return len(bucket) <= limit
`,
  },
  {
    path: 'tests/test_limiter.py',
    content: `from src.cache import TierPolicyCache
from src.clock import ManualClock
from src.limiter import SlidingWindowLimiter


def test_boundary_eviction_and_rejected_requests_do_not_consume_quota() -> None:
    clock = ManualClock(100.0)
    cache = TierPolicyCache(clock, lambda _tid: 2, ttl_seconds=60.0)
    limiter = SlidingWindowLimiter(clock, cache, window_seconds=10.0)

    assert limiter.allow("t1") is True
    assert limiter.allow("t1") is True
    assert limiter.allow("t1") is False

    # Exactly 10 seconds later, earliest hits at t=100.0 expire
    clock.advance(10.0)
    assert limiter.allow("t1") is True


def test_policy_invalidation_and_ttl_expiry_refresh() -> None:
    clock = ManualClock(0.0)
    tiers = {"t1": 1}
    cache = TierPolicyCache(clock, lambda tid: tiers[tid], ttl_seconds=30.0)
    limiter = SlidingWindowLimiter(clock, cache, window_seconds=10.0)

    assert limiter.allow("t1") is True
    assert limiter.allow("t1") is False

    tiers["t1"] = 3
    cache.invalidate("t1")
    assert limiter.allow("t1") is True

    clock.advance(30.0)
    tiers["t1"] = 0
    assert limiter.allow("t1") is False
`,
  },
];

const DEFAULT_RUBRIC: readonly R211RubricCriterion[] = [
  {
    id: 'correctness',
    label: 'Core correctness & invariants',
    description:
      'Handles state transitions, deduplication, and edge-case boundaries accurately.',
    weight: 60,
    applicability: {
      kind: 'always',
      rule: 'Applies to all candidate submissions.',
    },
  },
  {
    id: 'verification',
    label: 'Testing & verification discipline',
    description:
      'Verifies edge cases cleanly with minimal regressions to surrounding code.',
    weight: 40,
    applicability: {
      kind: 'always',
      rule: 'Applies to all candidate submissions.',
    },
  },
];

export const PLATFORM_TEMPLATES: readonly PlatformTemplateDefinition[] = [
  {
    templateId: 'reservation-moves-v3',
    scenarioId: 'reservation-moves',
    scenarioVersion: 'v3',
    title: 'Reservation Moves',
    summary:
      'Fix capacity preservation and idempotent move replay across a multi-file Python booking service.',
    targetRole: 'Backend Engineer',
    experienceLevel: 'mid',
    yearsExperience: 3,
    domain: 'travel',
    workKind: 'incident',
    problemStructure: 'multi_file',
    skills: ['Python', 'Concurrency & Idempotency', 'Testing & Debugging'],
    defaultDurationMinutes: 60,
    buildDraftInput: (options) => {
      const normalized = normalizeAssessmentTemplate({
        templateId: 'reservation-moves-v3',
        title: '',
        brief: '',
        expectedBehavior: [],
        acceptanceCriteria: [],
        primaryFilePath: '',
        starterFiles: [],
        rubric: [],
        durationMinutes: options?.durationMinutes ?? 60,
        terminalEnabled: true,
        integratedAi: Boolean(options?.integratedAi),
      });
      return {
        templateId: 'reservation-moves-v3',
        title: normalized.title,
        brief: normalized.brief,
        expectedBehavior: normalized.expectedBehavior,
        acceptanceCriteria: normalized.acceptanceCriteria,
        primaryFilePath: normalized.primaryFilePath,
        starterFiles: normalized.starterFiles,
        durationMinutes: normalized.durationMinutes,
        terminalEnabled: true,
        integratedAi: Boolean(options?.integratedAi),
        rubric: normalized.rubric,
      };
    },
  },
  {
    templateId: 'webhook-dedup-v1',
    scenarioId: 'webhook-dedup',
    scenarioVersion: 'v1',
    title: 'Payment Webhook Deduplication',
    summary:
      'Prevent duplicate ledger updates and out-of-order state regressions in an asynchronous payment webhook handler.',
    targetRole: 'Backend Engineer',
    experienceLevel: 'senior',
    yearsExperience: 5,
    domain: 'fintech',
    workKind: 'integration',
    problemStructure: 'multi_file',
    skills: [
      'Python',
      'REST APIs',
      'Concurrency & Idempotency',
      'Testing & Debugging',
    ],
    defaultDurationMinutes: 45,
    buildDraftInput: (options) => ({
      templateId: 'webhook-dedup-v1',
      title: 'Payment Webhook Deduplication',
      brief:
        'Our payments service receives asynchronous webhooks from an upstream processor. Fix duplicate delivery handling and enforce forward-only state transitions in src/webhook_handler.py and src/ledger.py so all verification tests pass.',
      expectedBehavior: [
        'Each delivery_id is processed at most once without double-crediting or double-refunding balances.',
        'Out-of-order events never regress payment status from a higher rank to a lower rank.',
        'Ledger balances remain accurate across settled and refunded transitions.',
      ],
      acceptanceCriteria: [
        'Duplicate delivery_id events leave ledger balance and payment totals unchanged.',
        'A delayed payment.authorized arriving after payment.settled preserves settled state.',
        'All unit tests in tests/test_webhooks.py pass without modifying test assertions.',
      ],
      primaryFilePath: 'src/webhook_handler.py',
      starterFiles: [...WEBHOOK_FILES],
      durationMinutes: options?.durationMinutes ?? 45,
      terminalEnabled: true,
      integratedAi: Boolean(options?.integratedAi),
      rubric: [...DEFAULT_RUBRIC],
    }),
  },
  {
    templateId: 'cache-rate-limiter-v1',
    scenarioId: 'cache-rate-limiter',
    scenarioVersion: 'v1',
    title: 'Sliding-Window Rate Limiter & Cache Staleness',
    summary:
      'Resolve off-by-one window eviction, rejected-request quota pollution, and stale TTL invalidation.',
    targetRole: 'Platform / Cloud Engineer',
    experienceLevel: 'mid',
    yearsExperience: 4,
    domain: 'developer-tools',
    workKind: 'incident',
    problemStructure: 'multi_file',
    skills: [
      'Python',
      'Caching & Performance',
      'System Design',
      'Testing & Debugging',
    ],
    defaultDurationMinutes: 45,
    buildDraftInput: (options) => ({
      templateId: 'cache-rate-limiter-v1',
      title: 'Sliding-Window Rate Limiter & Cache Staleness',
      brief:
        'An API gateway rate limiter is miscounting requests at window boundaries and serving stale tenant tier policies after invalidation. Fix src/limiter.py and src/cache.py so boundary eviction and policy invalidation behave deterministically.',
      expectedBehavior: [
        'Timestamps older than or equal to now - window_seconds are evicted before evaluating capacity.',
        'Rejected requests do not append entries to the tenant sliding-window bucket.',
        'Explicit cache invalidation and TTL expiration immediately load fresh tenant limits.',
      ],
      acceptanceCriteria: [
        'Requests at exact boundary now - window_seconds are evicted properly.',
        'Repeated blocked requests do not keep extending the cooldown window.',
        'TierPolicyCache.invalidate drops cached tenant entries and respects TTL boundary.',
      ],
      primaryFilePath: 'src/limiter.py',
      starterFiles: [...RATE_LIMITER_FILES],
      durationMinutes: options?.durationMinutes ?? 45,
      terminalEnabled: true,
      integratedAi: Boolean(options?.integratedAi),
      rubric: [...DEFAULT_RUBRIC],
    }),
  },
];

export function getPlatformTemplate(
  templateId: string,
): PlatformTemplateDefinition | null {
  return (
    PLATFORM_TEMPLATES.find((item) => item.templateId === templateId) ?? null
  );
}

export function serializePlatformTemplates() {
  return PLATFORM_TEMPLATES.map((tpl) => ({
    templateId: tpl.templateId,
    scenarioId: tpl.scenarioId,
    scenarioVersion: tpl.scenarioVersion,
    title: tpl.title,
    summary: tpl.summary,
    targetRole: tpl.targetRole,
    experienceLevel: tpl.experienceLevel,
    yearsExperience: tpl.yearsExperience,
    domain: tpl.domain,
    workKind: tpl.workKind,
    problemStructure: tpl.problemStructure,
    skills: tpl.skills,
    defaultDurationMinutes: tpl.defaultDurationMinutes,
    baseDraft: tpl.buildDraftInput({
      durationMinutes: tpl.defaultDurationMinutes,
      integratedAi: false,
    }),
  }));
}
