'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { assessmentChoiceDescriptions } from './assessment-choice-content';
import './assessment-choice.css';

type AssessmentChoiceOption = Readonly<{
  id: string;
  label: string;
  group?: string;
  disabled?: boolean;
}>;

export const AssessmentChoice = ({
  id,
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
}: Readonly<{
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly AssessmentChoiceOption[];
  placeholder?: string;
  disabled?: boolean;
}>) => {
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedIndex = options.findIndex((option) => option.id === value);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const activeOption = options[activeIndex];
  const selectedOption = options[selectedIndex];
  const isOpen = open && !disabled;
  const optionIndexes = new Map(
    options.map((option, index) => [option.id, index]),
  );
  const groups = options.reduce<AssessmentChoiceOption[][]>(
    (result, option) => {
      const previous = result.at(-1);
      if (previous && previous[0]?.group === option.group)
        previous.push(option);
      else result.push([option]);
      return result;
    },
    [],
  );

  useEffect(() => {
    if (!isOpen) return;
    listRef.current?.focus();
    const closeOutside = (event: PointerEvent | FocusEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('focusin', closeOutside);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('focusin', closeOutside);
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      listRef.current
        ?.querySelector<HTMLElement>('[data-active="true"]')
        ?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [activeIndex, isOpen]);

  const openAt = (index = selectedIndex < 0 ? 0 : selectedIndex) => {
    setActiveIndex(index);
    setOpen(true);
  };

  const choose = (option: AssessmentChoiceOption) => {
    if (option.disabled) return;
    onChange(option.id);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (isOpen) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index =
        event.key === 'ArrowDown'
          ? selectedIndex < 0
            ? 0
            : (selectedIndex + 1) % options.length
          : selectedIndex < 0
            ? options.length - 1
            : (selectedIndex - 1 + options.length) % options.length;
      openAt(index);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      openAt(event.key === 'Home' ? 0 : options.length - 1);
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(
        (activeIndex + direction + options.length) % options.length,
      );
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? 0 : options.length - 1);
      setOpen(true);
      return;
    }
    if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && activeOption) {
      event.preventDefault();
      if (!activeOption.disabled) {
        choose(activeOption);
      }
    }
  };

  return (
    <div className="assessment-choice" ref={rootRef}>
      <button
        ref={triggerRef}
        id={id}
        className="assessment-choice-trigger"
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => (isOpen ? setOpen(false) : openAt())}
        onKeyDown={onTriggerKeyDown}
      >
        <span>
          {selectedOption?.label ??
            placeholder ??
            `Choose ${label.toLowerCase()}`}
        </span>
        <span className="assessment-choice-chevron" aria-hidden="true" />
      </button>
      {isOpen && (
        <div className="assessment-choice-popover">
          <div
            className="assessment-choice-list"
            id={listId}
            role="listbox"
            aria-label={label}
            aria-activedescendant={
              activeOption ? `${listId}-${activeIndex}` : undefined
            }
            tabIndex={-1}
            ref={listRef}
            onKeyDown={onListKeyDown}
          >
            {groups.map((group, groupIndex) => (
              <div
                key={`${group[0]?.group ?? 'options'}-${groupIndex}`}
                role={group[0]?.group ? 'group' : undefined}
                aria-label={group[0]?.group}
              >
                {group[0]?.group && (
                  <p className="assessment-choice-group-label">
                    {group[0].group}
                  </p>
                )}
                {group.map((option) => {
                  const optionIndex = optionIndexes.get(option.id) ?? 0;
                  const isDisabled = Boolean(option.disabled);
                  return (
                    <div
                      key={option.id}
                      id={`${listId}-${optionIndex}`}
                      className="assessment-choice-option"
                      role="option"
                      aria-selected={option.id === value}
                      aria-disabled={isDisabled ? 'true' : undefined}
                      data-active={optionIndex === activeIndex || undefined}
                      data-disabled={isDisabled || undefined}
                      aria-describedby={
                        optionIndex === activeIndex &&
                        assessmentChoiceDescriptions[option.id]
                          ? `${listId}-brief`
                          : undefined
                      }
                      onPointerMove={() => setActiveIndex(optionIndex)}
                      onClick={() => {
                        if (!isDisabled) choose(option);
                      }}
                    >
                      <span>{option.label}</span>
                      {option.id === value && (
                        <span aria-hidden="true">Selected</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {activeOption && assessmentChoiceDescriptions[activeOption.id] && (
            <p className="assessment-choice-brief" id={`${listId}-brief`}>
              {assessmentChoiceDescriptions[activeOption.id]}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
