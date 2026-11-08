import { z } from 'zod';
import {
  checkRateLimit,
  saveEarlyAccessRecord,
  type EarlyAccessSubmissionInput,
} from '../../../src/early-access/store';

const earlyAccessSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  email: z
    .string()
    .trim()
    .email('Please provide a valid email address')
    .max(254),
  company: z.string().trim().min(1, 'Company name is required').max(160),
  teamSize: z.enum(['1-10', '11-50', '51-200', '201+'], {
    message: 'Please select an engineering team size',
  }),
  role: z.string().trim().min(1, 'Your role is required').max(120),
  primaryChallenge: z.enum(
    [
      'leetcode_fatigue',
      'ai_authenticity_uncertainty',
      'evaluator_time_cost',
      'unrealistic_assessments',
      'other',
    ],
    {
      message: 'Please select your primary evaluation challenge',
    },
  ),
  notes: z.string().trim().max(2000).optional(),
});

export async function POST(request: Request) {
  // Check Origin/Host consistency
  const origin = request.headers.get('origin');
  const host = request.headers.get('host') ?? new URL(request.url).host;
  let sameHost = false;

  try {
    if (origin) {
      const source = new URL(origin);
      sameHost =
        source.origin === origin &&
        source.host === host &&
        ['http:', 'https:'].includes(source.protocol);
    } else {
      // In same-origin server-rendered navigations or scripts without origin header
      sameHost = true;
    }
  } catch {
    sameHost = false;
  }

  if (!sameHost || request.headers.get('sec-fetch-site') === 'cross-site') {
    return Response.json(
      { error: 'Please submit your request from the Hirearchy application.' },
      { status: 403 },
    );
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return Response.json(
      { error: 'Invalid content type. Expected application/json.' },
      { status: 415 },
    );
  }

  // Extract client IP for rate limiting
  const forwardedFor = request.headers.get('x-forwarded-for');
  const clientIp = forwardedFor
    ? forwardedFor.split(',')[0].trim()
    : '127.0.0.1';

  const rateLimit = checkRateLimit(clientIp);
  if (!rateLimit.allowed) {
    return Response.json(
      {
        error: `Too many submissions. Please wait ${rateLimit.retryAfterSeconds || 60} seconds before trying again.`,
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(rateLimit.retryAfterSeconds || 60),
        },
      },
    );
  }

  // Read and bound payload
  let rawBody: unknown;
  try {
    const text = await request.text();
    if (text.length > 32000) {
      return Response.json(
        { error: 'Payload exceeds size limit.' },
        { status: 413 },
      );
    }
    rawBody = JSON.parse(text);
  } catch {
    return Response.json({ error: 'Malformed JSON payload.' }, { status: 400 });
  }

  const parseResult = earlyAccessSchema.safeParse(rawBody);
  if (!parseResult.success) {
    const fieldErrors = parseResult.error.flatten().fieldErrors;
    return Response.json(
      {
        error: 'Validation failed. Please review your submission fields.',
        details: fieldErrors,
      },
      { status: 400 },
    );
  }

  const data = parseResult.data;
  const input: EarlyAccessSubmissionInput = {
    name: data.name,
    email: data.email,
    company: data.company,
    teamSize: data.teamSize,
    role: data.role,
    primaryChallenge: data.primaryChallenge,
    notes: data.notes,
  };

  try {
    const record = await saveEarlyAccessRecord(input);
    return Response.json(
      {
        ok: true,
        submissionId: record.id,
        receivedAt: record.receivedAt,
        company: record.company,
        message:
          'Your request was recorded. No email was sent; an authorized operator can review it on the application host.',
      },
      { status: 201 },
    );
  } catch (error) {
    console.error('Failed to save early access request:', error);
    return Response.json(
      { error: 'Failed to record your request. Please try again later.' },
      { status: 500 },
    );
  }
}
