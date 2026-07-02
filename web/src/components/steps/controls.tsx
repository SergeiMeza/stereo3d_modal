/**
 * Tiny shared form primitives for the step panels. NATIVE controls only
 * (<select>, <input type=checkbox|radio|number>): tests inspect .options and
 * jsdom chokes on portal-based pickers — do not swap these for Radix Select.
 */

import type { JSX, ReactNode } from "react";

export const selectClass =
  "rounded-md border border-edge bg-surface-2 px-2 py-1.5 text-sm";

export function Field({
  id,
  label,
  children,
  hint,
}: {
  id: string;
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-fg-muted">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
    </div>
  );
}

export function CheckboxChip({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}): JSX.Element {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-edge bg-surface-2 px-2 py-1">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="accent-primary"
      />
      <span className="text-xs">{label}</span>
    </label>
  );
}
