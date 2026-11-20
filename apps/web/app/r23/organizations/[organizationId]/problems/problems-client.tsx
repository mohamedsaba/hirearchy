'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type {
  R211ReusableProblem,
  R211ReusableProblemContent,
  R211AssessmentDraft,
  R211StarterFile,
  R211RubricCriterion,
} from '../../../../../src/r211-builder/contract';
import './problems.css';

async function problemRequest<T>(
  path: string,
  method = 'GET',
  csrfToken?: string,
  body?: object,
): Promise<T> {
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(csrfToken !== undefined
        ? { 'x-csrf-token': csrfToken, 'Content-Type': 'application/json' }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 409)
    throw new Error(
      'Another recruiter changed this problem. Reload the page to review the latest version before trying again.',
    );
  if (!response.ok) {
    const data = await response.json();
    throw new Error(
      data.error?.message ?? 'Could not complete the problem request.',
    );
  }
  return response.json();
}

export function BuilderProblemActions({
  organizationId,
  csrfToken,
  content,
}: {
  organizationId: string;
  csrfToken: string;
  content: R211ReusableProblemContent;
}) {
  const router = useRouter();
  const [navigating, startTransition] = useTransition();
  const workspace = `/r23/organizations/${encodeURIComponent(organizationId)}`;
  const api = `/r23/api/organizations/${encodeURIComponent(organizationId)}/problems`;
  const [problems, setProblems] = useState<R211ReusableProblem[] | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const perform = async (action: 'save' | 'list' | 'reuse') => {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      if (action === 'save') {
        await problemRequest(api, 'POST', csrfToken, { content });
        setMessage('Problem saved for reuse.');
        setProblems(null);
        setSelected('');
      } else if (action === 'list') {
        const result = await problemRequest<{
          problems: R211ReusableProblem[];
        }>(api);
        setProblems(result.problems);
        setSelected('');
      } else {
        const { draft } = await problemRequest<{ draft: R211AssessmentDraft }>(
          api + '/' + encodeURIComponent(selected) + '/reuse',
          'POST',
          csrfToken,
          {},
        );
        startTransition(() =>
          router.push(
            `${workspace}/builder?${new URLSearchParams({ definitionId: draft.definitionId })}`,
          ),
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not complete the problem request.',
      );
    } finally {
      setBusy(false);
    }
  };
  const pending = busy || navigating;
  return (
    <section aria-label="Reusable problems">
      <div className="problem-library-actions">
        <button
          type="button"
          className="button button-secondary"
          disabled={pending}
          onClick={() => void perform('save')}
        >
          Save for reuse
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={pending}
          onClick={() => void perform('list')}
        >
          Start from saved problem
        </button>
        <Link href={workspace + '/problems'}>Manage problems</Link>
      </div>
      {problems &&
        (problems.length ? (
          <>
            <label htmlFor="saved-problem-picker">Saved problem</label>{' '}
            <select
              id="saved-problem-picker"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={pending}
            >
              <option value="">Choose a problem</option>
              {problems.map((problem) => (
                <option key={problem.id} value={problem.id}>
                  {problem.content.title}
                </option>
              ))}
            </select>
            <p>
              Save any changes you want to keep in this draft before opening the
              new one.
            </p>
            <button
              className="button button-primary"
              type="button"
              disabled={pending || !selected}
              onClick={() => void perform('reuse')}
            >
              Create draft
            </button>
          </>
        ) : (
          <p>No saved problems yet.</p>
        ))}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

const updateItem = <T,>(items: readonly T[], index: number, value: T) =>
  items.map((item, i) => (i === index ? value : item));
function TextList({
  label,
  values,
  onChange,
}: {
  label: string;
  values: readonly string[];
  onChange: (values: string[]) => void;
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      {values.map((value, i) => (
        <div key={i}>
          <label>
            {label} {i + 1}
            <textarea
              value={value}
              onChange={(e) => onChange(updateItem(values, i, e.target.value))}
            />
          </label>
          <button
            type="button"
            disabled={values.length === 1}
            onClick={() => onChange(values.filter((_, j) => j !== i))}
          >
            Remove item {i + 1}
          </button>
        </div>
      ))}
      <div>
        <button type="button" onClick={() => onChange([...values, ''])}>
          Add item
        </button>
      </div>
    </fieldset>
  );
}

export function ProblemEditor({
  problem,
  csrfToken,
}: {
  problem: R211ReusableProblem;
  csrfToken: string;
}) {
  const [saved, setSaved] = useState(problem);
  const [content, setContent] = useState(problem.content);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const set = <K extends keyof R211ReusableProblemContent>(
    key: K,
    value: R211ReusableProblemContent[K],
  ) => setContent((old) => ({ ...old, [key]: value }));
  const changeFile = (i: number, patch: Partial<R211StarterFile>) =>
    set(
      'starterFiles',
      updateItem(content.starterFiles, i, {
        ...content.starterFiles[i],
        ...patch,
      }),
    );
  const changeRubric = (i: number, patch: Partial<R211RubricCriterion>) =>
    set(
      'rubric',
      updateItem(content.rubric, i, { ...content.rubric[i], ...patch }),
    );
  const save = async (deleting: boolean) => {
    setBusy(true);
    setError('');
    setMessage('');
    const org = encodeURIComponent(saved.organizationId);
    const path = `/r23/api/organizations/${org}/problems/${encodeURIComponent(saved.id)}`;
    try {
      const expectedVersion = saved.version;
      if (deleting) {
        await problemRequest(path, 'DELETE', csrfToken, { expectedVersion });
        window.location.replace(`/r23/organizations/${org}/problems`);
      } else {
        const result = await problemRequest<{ problem: R211ReusableProblem }>(
          path,
          'PATCH',
          csrfToken,
          { expectedVersion, content },
        );
        setSaved(result.problem);
        setContent(result.problem.content);
        setMessage('Changes saved.');
        setConfirmDelete(false);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not complete the problem request.',
      );
    } finally {
      setBusy(false);
    }
  };
  const approved = content.templateId === 'reservation-moves-v3';
  const task = approved ? saved.content : content;
  return (
    <>
      <header>
        <h1>{saved.content.title}</h1>
        <span>Version {saved.version}</span>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save(false);
        }}
      >
        <fieldset disabled={busy}>
          <legend>Problem settings</legend>
          <label>
            Template
            <select
              value={content.templateId ?? 'custom'}
              onChange={(e) =>
                set(
                  'templateId',
                  e.target.value as R211AssessmentDraft['templateId'],
                )
              }
            >
              <option value="custom">Custom</option>
              <option value="reservation-moves-v3">Reservation Moves v3</option>
            </select>
          </label>
          <label>
            Duration (minutes)
            <select
              value={content.durationMinutes}
              onChange={(e) => set('durationMinutes', Number(e.target.value))}
            >
              {[30, 45, 60, 90].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={content.terminalEnabled}
              onChange={(e) => set('terminalEnabled', e.target.checked)}
            />
            Terminal enabled
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={content.integratedAi}
              onChange={(e) => set('integratedAi', e.target.checked)}
            />
            Integrated AI
          </label>
        </fieldset>
        {approved && (
          <p>
            The approved Reservation Moves template supplies the task, starter
            files and rubric. Select Custom to edit these fields.
          </p>
        )}
        {(!approved || saved.content.templateId === 'reservation-moves-v3') && (
          <fieldset disabled={busy || approved}>
            <legend>Task content</legend>
            <label>
              Title
              <input
                name="title"
                value={task.title}
                onChange={(e) => set('title', e.target.value)}
              />
            </label>
            <label>
              Brief
              <textarea
                rows={6}
                value={task.brief}
                onChange={(e) => set('brief', e.target.value)}
              />
            </label>
            <TextList
              label="Expected behavior"
              values={task.expectedBehavior}
              onChange={(v) => set('expectedBehavior', v)}
            />
            <TextList
              label="Acceptance criteria"
              values={task.acceptanceCriteria}
              onChange={(v) => set('acceptanceCriteria', v)}
            />
            <label>
              Primary file path
              <input
                value={task.primaryFilePath}
                onChange={(e) => set('primaryFilePath', e.target.value)}
              />
            </label>
            <fieldset>
              <legend>Starter files</legend>
              {task.starterFiles.map((file, i) => (
                <fieldset key={i}>
                  <legend>File {i + 1}</legend>
                  <label>
                    Path
                    <input
                      value={file.path}
                      onChange={(e) => changeFile(i, { path: e.target.value })}
                    />
                  </label>
                  <label>
                    File content
                    <textarea
                      rows={6}
                      spellCheck={false}
                      value={file.content}
                      onChange={(e) =>
                        changeFile(i, { content: e.target.value })
                      }
                    />
                  </label>
                  <button
                    type="button"
                    disabled={task.starterFiles.length === 1}
                    onClick={() =>
                      set(
                        'starterFiles',
                        content.starterFiles.filter((_, j) => j !== i),
                      )
                    }
                  >
                    Remove file
                  </button>
                </fieldset>
              ))}
              <div>
                <button
                  type="button"
                  onClick={() =>
                    set('starterFiles', [
                      ...content.starterFiles,
                      { path: '', content: '' },
                    ])
                  }
                >
                  Add starter file
                </button>
              </div>
            </fieldset>
            <fieldset>
              <legend>Rubric</legend>
              {task.rubric.map((criterion, i) => (
                <fieldset key={i}>
                  <legend>Criterion {i + 1}</legend>
                  <label>
                    Criterion ID
                    <input
                      value={criterion.id}
                      onChange={(e) => changeRubric(i, { id: e.target.value })}
                    />
                  </label>
                  <label>
                    Label
                    <input
                      value={criterion.label}
                      onChange={(e) =>
                        changeRubric(i, { label: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Description
                    <textarea
                      value={criterion.description}
                      onChange={(e) =>
                        changeRubric(i, { description: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Weight
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={criterion.weight}
                      onChange={(e) =>
                        changeRubric(i, { weight: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label>
                    Applicability
                    <select
                      value={criterion.applicability.kind}
                      onChange={(e) =>
                        changeRubric(i, {
                          applicability: {
                            ...criterion.applicability,
                            kind: e.target
                              .value as R211RubricCriterion['applicability']['kind'],
                          },
                        })
                      }
                    >
                      <option value="always">Always</option>
                      <option value="recorded_integrated_ai_interaction">
                        Recorded integrated AI interaction
                      </option>
                    </select>
                  </label>
                  <label>
                    Applicability rule
                    <textarea
                      value={criterion.applicability.rule}
                      onChange={(e) =>
                        changeRubric(i, {
                          applicability: {
                            ...criterion.applicability,
                            rule: e.target.value,
                          },
                        })
                      }
                    />
                  </label>
                  <button
                    type="button"
                    disabled={task.rubric.length === 1}
                    onClick={() =>
                      set(
                        'rubric',
                        content.rubric.filter((_, j) => j !== i),
                      )
                    }
                  >
                    Remove criterion
                  </button>
                </fieldset>
              ))}
              <div>
                <button
                  type="button"
                  onClick={() =>
                    set('rubric', [
                      ...content.rubric,
                      {
                        id: '',
                        label: '',
                        description: '',
                        weight: 0,
                        applicability: { kind: 'always', rule: '' },
                      },
                    ])
                  }
                >
                  Add criterion
                </button>
              </div>
            </fieldset>
          </fieldset>
        )}
        <div>
          <button
            className="button button-primary"
            disabled={busy}
            type="submit"
          >
            Save changes
          </button>
        </div>
      </form>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      <section className="problem-delete">
        {confirmDelete ? (
          <>
            <p>Delete this saved problem from the organization library?</p>
            <div className="problem-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => void save(true)}
              >
                Confirm deletion
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            Delete problem
          </button>
        )}
      </section>
    </>
  );
}
