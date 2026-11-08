import {
  stagingInvitationAcceptGet,
  stagingInvitationAcceptPost,
} from '../../../../src/staging/browser';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export const GET = stagingInvitationAcceptGet;
export const POST = stagingInvitationAcceptPost;
