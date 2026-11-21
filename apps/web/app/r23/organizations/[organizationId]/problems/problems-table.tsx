import Link from 'next/link';
import type { R211ReusableProblem } from '../../../../../src/r211-builder/contract';
export function ProblemsTable({
  workspace,
  problems,
}: {
  workspace: string;
  problems: R211ReusableProblem[];
}) {
  return problems.length ? (
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
                href={workspace + '/problems/' + encodeURIComponent(problem.id)}
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
  );
}
