'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { useId } from 'react';

export function PolicySwitch({
  checked,
  onChange,
  disabled = false,
  label = 'AI Assistant',
  description,
  name,
  id,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  label?: string;
  description?: string;
  name?: string;
  id?: string;
}) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const reduced = useReducedMotion();
  return (
    <label
      htmlFor={controlId}
      className={`editorial-policy flex items-center justify-between gap-5 rounded-2xl border border-cream/[0.12] bg-plum-elevated p-5 text-cream ${disabled ? 'cursor-default opacity-70' : 'cursor-pointer'}`}
    >
      <span className="min-w-0">
        <span className="block text-sm font-semibold">
          {label}: {checked ? 'Allowed & Logged' : 'Disabled'}
        </span>
        <span
          className="mt-1 block max-w-[54ch] text-xs leading-relaxed text-cream/70"
          id={`${controlId}-help`}
        >
          {description ??
            (checked
              ? 'Candidate-facing rule: the integrated assistant is available. Prompts, responses and supplied context are recorded for human review. AI use carries no automatic judgment.'
              : 'Candidate-facing rule: the integrated assistant is unavailable for this task. This setting does not monitor activity outside the workspace.')}
        </span>
      </span>
      <span className="relative shrink-0">
        <input
          id={controlId}
          name={name}
          type="checkbox"
          role="switch"
          aria-label={label}
          aria-describedby={`${controlId}-help`}
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
        />
        <span
          className={`flex h-7 w-12 items-center rounded-full p-1 transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-mint ${checked ? 'bg-mint' : 'bg-cream/20'}`}
          aria-hidden="true"
        >
          <motion.span
            className="block h-5 w-5 rounded-full bg-plum shadow-sm"
            animate={{ x: checked ? 20 : 0 }}
            transition={reduced ? { duration: 0 } : undefined}
          />
        </span>
      </span>
    </label>
  );
}

export function ChoicePills({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: readonly { id: string; label: string; disabled?: boolean }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const groupName = useId();
  return (
    <fieldset
      className="editorial-pills m-0 min-w-0 border-0 p-0"
      disabled={disabled}
    >
      <legend className="mb-3 text-xs font-medium text-cream/70">
        {label}
      </legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <label
            key={option.id}
            className="relative cursor-pointer has-[:disabled]:cursor-default has-[:disabled]:opacity-50"
          >
            <input
              className="peer sr-only"
              type="radio"
              name={groupName}
              value={option.id}
              checked={option.id === value}
              disabled={option.disabled}
              onChange={() => onChange(option.id)}
            />
            <span className="block rounded-full border border-cream/[0.12] bg-plum px-4 py-2 text-xs text-cream transition-colors peer-checked:border-mint peer-checked:bg-mint peer-checked:text-plum peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-mint">
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
