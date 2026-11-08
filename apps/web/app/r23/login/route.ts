import { r23LoginGet, r23LoginPost } from '../../../src/r23-auth/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export const GET = r23LoginGet;
export const POST = r23LoginPost;
