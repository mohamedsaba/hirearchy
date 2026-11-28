import { createHmac, randomBytes } from 'node:crypto';
import * as http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { proxy } from '../../apps/web/proxy';
import {
  decryptWebhookSecret,
  deliverWebhookRequest,
  encryptWebhookSecret,
  formatSlackBlockKitPayload,
  generateWebhookSecret,
  signWebhookPayload,
  validateWebhookTargetUrl,
  WebhookSsrfBlockedError,
} from '../../apps/web/src/hiring/webhooks';
import {
  buildPublicMarketingProof,
  type ProductIntelligenceReport,
} from '../../apps/web/src/telemetry/catalog';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function makeBaseIntelligenceReport(
  overrides: Partial<ProductIntelligenceReport['marketingProof']> = {},
): ProductIntelligenceReport {
  return {
    windowDays: 90,
    generatedAt: '2026-11-27T17:00:00.000Z',
    marketingProof: {
      totalOrganizations: 8,
      activeOrganizations: 6,
      totalSessionsIssued: 40,
      sessionsStarted: 30,
      sessionsSubmitted: 24,
      candidateStartRatePct: 75,
      candidateCompletionRatePct: 80,
      medianCandidateMinutes: 41.5,
      medianReviewTurnaroundHours: 5.2,
      decisionsPublished: 18,
      acceptanceRatePct: 55,
      aiAssistantEnabledPct: 30,
      candidateSatisfactionAvg: 4.7,
      candidateFairnessPositivePct: 92,
      totalCandidateFeedback: 20,
      ...overrides,
    },
    acquisitionChannels: [],
    hiringFunnel: {
      orgsCreated: 6,
      assessmentsAuthored: 12,
      invitesIssued: 40,
      candidatesOpened: 35,
      candidatesStarted: 30,
      candidatesRanCode: 28,
      candidatesSubmitted: 24,
      decisionsPublished: 18,
      handoffsCompleted: 8,
    },
    assessmentHealth: [],
    aiPerformance: {
      generateStarted: 10,
      generateCompleted: 9,
      generateFailed: 1,
      successRatePct: 90,
      medianLatencyMs: 5000,
      p95LatencyMs: 8000,
      problemsSaved: 8,
      aiProblemsIssued: 12,
      avgAiQualityRating: 4.5,
      aiFeedbackCount: 4,
      advisoryReviewOpened: 10,
    },
    monetization: {
      planDistribution: { none: 1, per_candidate: 2, pro: 2, ultra: 3 },
      planGateHits: 3,
      upgradePageVisits: 6,
      planUpgrades: 2,
      slotAddons: 1,
    },
    uxFriction: {
      topErrors: [],
      topRoutes: [],
      themeSplit: { light: 20, dark: 10 },
      clientErrorCount: 0,
      p95ApiDurationMs: 140,
    },
    recentFeedback: [],
  };
}

describe('public marketing proof privacy threshold gate', () => {
  it('stays in benchmark fallback mode when HIREARCHY_PUBLIC_PROOF_LIVE is false or report is null', () => {
    expect(buildPublicMarketingProof(null, true)).toEqual({
      live: false,
      windowDays: 90,
      metrics: {
        candidateCompletionRatePct: null,
        candidateFairnessPositivePct: null,
        candidateSatisfactionAvg: null,
        medianReviewTurnaroundHours: null,
        medianCandidateMinutes: null,
        activeOrganizations: 0,
        sessionsStarted: 0,
        sessionsSubmitted: 0,
        totalCandidateFeedback: 0,
        decisionsPublished: 0,
      },
    });

    const report = makeBaseIntelligenceReport();
    const disabled = buildPublicMarketingProof(report, false);
    expect(disabled.live).toBe(false);
    expect(disabled.metrics.candidateCompletionRatePct).toBeNull();
    expect(disabled.metrics.candidateFairnessPositivePct).toBeNull();
    expect(disabled.metrics.medianReviewTurnaroundHours).toBeNull();
    expect(disabled.metrics.medianCandidateMinutes).toBeNull();
  });

  it('requires >= 5 active orgs, >= 25 started, and >= 15 submitted before turning live', () => {
    const lowOrgs = buildPublicMarketingProof(
      makeBaseIntelligenceReport({ activeOrganizations: 4 }),
      true,
    );
    expect(lowOrgs.live).toBe(false);
    expect(lowOrgs.metrics.candidateCompletionRatePct).toBeNull();

    const lowStarted = buildPublicMarketingProof(
      makeBaseIntelligenceReport({ sessionsStarted: 24 }),
      true,
    );
    expect(lowStarted.live).toBe(false);

    const lowSubmitted = buildPublicMarketingProof(
      makeBaseIntelligenceReport({ sessionsSubmitted: 14 }),
      true,
    );
    expect(lowSubmitted.live).toBe(false);
  });

  it('gates individual metrics on feedback >= 15 and decisions >= 15 when globally live', () => {
    const partial = buildPublicMarketingProof(
      makeBaseIntelligenceReport({
        totalCandidateFeedback: 14,
        decisionsPublished: 10,
      }),
      true,
    );
    expect(partial.live).toBe(true);
    expect(partial.metrics.candidateCompletionRatePct).toBe(80);
    expect(partial.metrics.medianCandidateMinutes).toBe(41.5);
    expect(partial.metrics.candidateFairnessPositivePct).toBeNull();
    expect(partial.metrics.candidateSatisfactionAvg).toBeNull();
    expect(partial.metrics.medianReviewTurnaroundHours).toBeNull();

    const full = buildPublicMarketingProof(makeBaseIntelligenceReport(), true);
    expect(full.live).toBe(true);
    expect(full.metrics.candidateFairnessPositivePct).toBe(92);
    expect(full.metrics.candidateSatisfactionAvg).toBe(4.7);
    expect(full.metrics.medianReviewTurnaroundHours).toBe(5.2);
  });
});

describe('webhooks crypto, SSRF protection, signing & delivery', () => {
  const masterKey = randomBytes(32);

  it('encrypts and decrypts webhook signing secrets scoped to organizationId AAD', () => {
    const orgA = '11111111-1111-4111-8111-111111111111';
    const orgB = '22222222-2222-4222-8222-222222222222';
    const generated = generateWebhookSecret(orgA, masterKey);
    expect(generated.plaintext).toMatch(/^whsec_/);
    expect(generated.prefix.length).toBeLessThanOrEqual(16);

    const roundTrip = decryptWebhookSecret(
      orgA,
      generated.ciphertext,
      masterKey,
    );
    expect(roundTrip).toBe(generated.plaintext);

    expect(() =>
      decryptWebhookSecret(orgB, generated.ciphertext, masterKey),
    ).toThrow();

    const explicit = encryptWebhookSecret(orgA, 'whsec_custom', masterKey);
    expect(decryptWebhookSecret(orgA, explicit, masterKey)).toBe(
      'whsec_custom',
    );
  });

  it('blocks SSRF targets including private IPv4, link-local metadata, IPv6 ULA, and non-HTTPS', () => {
    for (const badUrl of [
      'http://hooks.example.com/webhook',
      'https://127.0.0.1/hook',
      'https://10.0.0.5/hook',
      'https://172.16.4.2/hook',
      'https://192.168.1.10/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/hook',
      'https://[fc00::1]/hook',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://user:pass@hooks.example.com/hook',
    ]) {
      expect(() => validateWebhookTargetUrl(badUrl)).toThrow(
        WebhookSsrfBlockedError,
      );
    }

    expect(
      validateWebhookTargetUrl('https://hooks.slack.com/services/T00/B00/XXX')
        .hostname,
    ).toBe('hooks.slack.com');
  });

  it('formats Slack Block Kit payloads under 150 KB', () => {
    const slack = formatSlackBlockKitPayload(
      'verdict.published',
      {
        organizationId: '11111111-1111-4111-8111-111111111111',
        organizationName: 'Acme Corp',
        sessionId: 'sess_abc123',
        scenarioTitle: 'Reservation Moves v3',
        targetRole: 'Senior Backend Engineer',
        decision: 'accepted',
        nextStageLabel: 'Managerial Interview',
      },
      'https://app.hirearchy.test',
    );
    expect(slack.text).toContain('Verdict published (accepted)');
    expect(Array.isArray(slack.blocks)).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(slack), 'utf8'),
    ).toBeLessThanOrEqual(150 * 1024);
  });

  it('delivers signed JSON webhook payloads with valid HMAC-SHA256 headers and fails closed on SSRF', async () => {
    const blocked = await deliverWebhookRequest({
      targetUrl: 'https://169.254.169.254/latest/meta-data',
      payloadMode: 'json',
      signingSecret: 'whsec_test',
      eventId: '00000000-0000-4000-8000-000000000001',
      eventType: 'candidate.submitted',
      payload: { sessionId: 'sess_1' },
    });
    expect(blocked.status).toBe('blocked_ssrf');

    let receivedHeaders: http.IncomingHttpHeaders = {};
    let receivedBody = '';
    const server = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8');
        res.statusCode = 200;
        res.end('ok');
      });
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, '127.0.0.1', resolveListen),
    );

    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('No address');
      vi.stubEnv('HIREARCHY_ALLOW_LOOPBACK_WEBHOOKS', 'true');

      const secret = 'whsec_integration_secret';
      const delivery = await deliverWebhookRequest({
        targetUrl: `http://127.0.0.1:${addr.port}/hook`,
        payloadMode: 'json',
        signingSecret: secret,
        eventId: '00000000-0000-4000-8000-000000000002',
        eventType: 'candidate.started',
        payload: { sessionId: 'sess_loopback', organizationName: 'Test Org' },
      });

      expect(delivery.status).toBe('delivered');
      expect(delivery.httpStatus).toBe(200);
      expect(receivedHeaders['x-hirearchy-event']).toBe('candidate.started');
      expect(receivedHeaders['x-hirearchy-delivery']).toBe(
        '00000000-0000-4000-8000-000000000002',
      );
      const ts = Number(receivedHeaders['x-hirearchy-timestamp']);
      const expectedSig = `v0=${createHmac('sha256', secret)
        .update(`v0:${ts}:${receivedBody}`, 'utf8')
        .digest('hex')}`;
      expect(receivedHeaders['x-hirearchy-signature']).toBe(expectedSig);
      expect(signWebhookPayload(secret, ts, receivedBody)).toBe(expectedSig);
    } finally {
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    }
  });
});

describe('proxy allowlisting for Phase 2 launch maturity routes', () => {
  it('allows public preview marketing routes while blocking org/admin endpoints', () => {
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'public-preview');
    for (const path of [
      '/demo',
      '/trust',
      '/dossier/demo',
      '/api/marketing-proof',
    ]) {
      expect(
        proxy(new NextRequest(`http://localhost${path}`)).headers.get(
          'x-middleware-next',
        ),
        `GET ${path} in public-preview`,
      ).toBe('1');
    }
    expect(
      proxy(
        new NextRequest('http://localhost/api/intelligence/action', {
          method: 'POST',
        }),
      ).status,
    ).toBe(404);
  });

  it('enforces hiring platform and founder UAT gating on new routes', () => {
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'staging-authenticated');
    vi.stubEnv('HIREARCHY_HIRING_PLATFORM_ENABLED', 'true');

    const orgId = '11111111-1111-4111-8111-111111111111';
    for (const [method, path] of [
      ['GET', '/demo'],
      ['GET', '/trust'],
      ['GET', '/dossier/some-token'],
      ['GET', '/api/marketing-proof'],
      ['GET', `/r23/organizations/${orgId}/sample-review`],
      ['GET', `/r23/organizations/${orgId}/builder/candidate-preview`],
      ['GET', `/r23/api/organizations/${orgId}/hiring/webhooks`],
      ['POST', `/r23/api/organizations/${orgId}/hiring/webhooks`],
      ['GET', `/r23/api/organizations/${orgId}/hiring/dossiers`],
      ['POST', `/r23/api/organizations/${orgId}/hiring/dossiers`],
      ['GET', `/r23/api/organizations/${orgId}/hiring/health`],
      ['GET', `/r23/api/organizations/${orgId}/hiring/nudges`],
      ['POST', `/r23/api/organizations/${orgId}/hiring/nudges`],
    ] as const) {
      expect(
        proxy(
          new NextRequest(`http://localhost${path}`, { method }),
        ).headers.get('x-middleware-next'),
        `${method} ${path} in hiring platform`,
      ).toBe('1');
    }

    expect(
      proxy(
        new NextRequest('http://localhost/api/intelligence/action', {
          method: 'POST',
        }),
      ).status,
    ).toBe(503);
  });
});

describe('PostgreSQL migration 0023 and install-api.sql security invariants', () => {
  it('enforces RLS, REVOKEs, no hirearchy functions, and valid SQL expressions', () => {
    const migrationSql = readFileSync(
      resolve('database/postgres/migrations/0023_launch_maturity.sql'),
      'utf8',
    );
    for (const table of [
      'hirearchy.dossier_share_links',
      'hirearchy.organization_webhooks',
      'hirearchy.webhook_deliveries',
      'hirearchy.organization_nudges',
    ]) {
      expect(migrationSql).toContain(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
      );
      expect(migrationSql).toContain(
        `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`,
      );
    }
    expect(migrationSql).toContain(
      'FROM PUBLIC, app_evaluator, app_candidate_gateway, app_control_worker',
    );
    expect(migrationSql).toContain('FROM r23_gateway');
    expect(migrationSql).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i);

    const installSql = readFileSync(
      resolve('database/postgres/staging/install-api.sql'),
      'utf8',
    );
    expect(installSql).not.toMatch(/pg_catalog\.(?:LEAST|GREATEST)\s*\(/i);
    expect(installSql).not.toMatch(
      /\bo\.created_at|\borganizations\.created_at/i,
    );
    expect(installSql).toContain(
      'GRANT EXECUTE ON FUNCTION staging.hiring_dossier_share_resolve(pg_catalog.text) TO r23_gateway;',
    );
    expect(installSql).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+staging\.(?:hiring_dossier_|hiring_webhook_|hiring_org_|webhook_|telemetry_lifecycle_|telemetry_update_nudge)[\s\S]*?TO\s+app_candidate_gateway/i,
    );
  });
});
