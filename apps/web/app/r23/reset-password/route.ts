import {
  stagingResetPasswordGet,
  stagingResetPasswordPost,
} from '../../../src/staging/browser';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export const GET = stagingResetPasswordGet;
export const POST = stagingResetPasswordPost;
