import Link from 'next/link';
import type { R211ReusableProblem } from '../../../../../src/r211-builder/contract';
import { loadProblems } from './load-problems';
import './problems.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Problems' };
export default async function ProblemsPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const workspace = `/r23/organizations/${encodeURIComponent(organizationId)}`;
  const { response } = await loadProblems(organizationId);
  const { problems }: { problems: R211ReusableProblem[] } =
    await response.json();
  return (
    <main className="problems-page">
      <Link href={workspace}>Organization workspace</Link>
      <header>
        <h1>Problems</h1>
        <Link className="button button-primary" href={workspace + '/builder'}>
          Create a problem
        </Link>
      </header>
      {problems.length ? (
        <table aria-label="Saved problems">
          <thead>
            <tr>
              <th scope="col">Problem</th>
              <th scope="col">Duration</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {problems.map((problem) => (
              <tr key={problem.id}>
                <th scope="row">
                  <Link
                    href={
                      workspace + '/problems/' + encodeURIComponent(problem.id)
                    }
                  >
                    {problem.content.title}
                  </Link>
                </th>
                <td>{problem.content.durationMinutes} min</td>
                <td>
                  <time dateTime={problem.updatedAt}>
                    {problem.updatedAt.slice(0, 10)}
                  </time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>
          No saved problems yet. Choose <strong>Save for reuse</strong> when
          authoring an assessment to add one here.
        </p>
      )}
    </main>
  );
}
