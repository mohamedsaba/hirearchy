import {
  stagingVerifyEmailGet,
  stagingVerifyEmailPost,
} from '../../../src/staging/browser';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export const GET = stagingVerifyEmailGet;
export const POST = stagingVerifyEmailPost;
