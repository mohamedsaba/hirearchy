import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { R23_CSRF_COOKIE } from '../../../../../src/r23-auth/config';
import { r211ReusableProblemApi } from '../../../../../src/r23-auth/server';

export async function loadProblems(organizationId: string, problemId?: string) {
  const jar = await cookies();
  const request = new Request('https://hirearchy-problems.invalid/', {
    headers: { Accept: 'application/json', Cookie: jar.toString() },
  });
  const response = await r211ReusableProblemApi(
    request,
    organizationId,
    problemId ? 'get' : 'list',
    problemId,
  );
  if (response.status === 401) redirect('/r23/login');
  if ([403, 404].includes(response.status)) notFound();
  if (!response.ok) throw new Error('Could not load the saved problems.');
  return { response, csrfToken: jar.get(R23_CSRF_COOKIE)?.value ?? '' };
}
