import {
  stagingRecoverGet,
  stagingRecoverPost,
} from '../../../src/staging/browser';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export const GET = (request: Request) => stagingRecoverGet(request);
export const POST = stagingRecoverPost;
