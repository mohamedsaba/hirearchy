// The Node.js fixture in Hirearchy-landing/app/software/demo-model.ts.
export const sourcePath = 'src/fulfil-order.ts';
export const repoFiles = [
  sourcePath,
  'src/services.ts',
  'tests/fulfil-order.test.ts',
  'README.md',
];
export const originalCode = [
  "import { redis, fulfil } from './services';",
  '',
  'export async function fulfilOrder(orderId: string) {',
  '  const key = `order:${orderId}:lock`;',
  "  if (await redis.get(key)) return { status: 'busy' };",
  '',
  "  await redis.set(key, 'locked');",
  '  await fulfil(orderId);',
  '  await redis.del(key);',
  '}',
];
export const fixedCode = [
  "import { randomUUID } from 'node:crypto';",
  "import { redis, fulfil, RELEASE_IF_OWNED } from './services';",
  '',
  'export async function fulfilOrder(orderId: string) {',
  '  const key = `order:${orderId}:lock`;',
  '  const token = randomUUID();',
  '  const acquired = await redis.set(key, token, { NX: true, PX: 5000 });',
  "  if (!acquired) return { status: 'busy' };",
  '',
  '  try {',
  '    await fulfil(orderId);',
  '  } finally {',
  '    await redis.eval(RELEASE_IF_OWNED, { keys: [key], arguments: [token] });',
  '  }',
  '}',
];

export const prompt = 'Best way to guard atomic lock release with TTL?';
export const checks = [
  'Concurrent workers fulfil once',
  'Crashed worker lock expires',
  'Expired worker cannot release a newer lock',
];
export const milestones = [
  {
    time: '01:10',
    title: 'Repo Explored',
    kind: 'REPOSITORY',
    detail: 'Opened the fulfilment service and reviewed the incident brief.',
    icon: 'folder',
  },
  {
    time: '04:20',
    title: 'Tests Failed',
    kind: 'TEST RUN',
    detail:
      'The concurrency check recorded two fulfilment calls for one order.',
    icon: 'terminal',
  },
  {
    time: '08:15',
    title: 'AI Prompt Logged',
    kind: 'AI INTERACTION',
    detail: prompt,
    icon: 'spark',
  },
  {
    time: '12:00',
    title: 'Edge Cases Verified',
    kind: 'TEST RUN',
    detail:
      'Three checks passed across concurrency, lock expiry and safe release.',
    icon: 'check',
  },
] as const;
