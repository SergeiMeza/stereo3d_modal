/**
 * PageHeader — the slim header row every workspace page opens with: the
 * page title (text-sm font-semibold, the Cut page's "Scene cuts" style),
 * optional inline meta (version/duration chips), a one-line muted
 * description, and right-aligned actions (Save/Reset, the ⓘ Tips/Guide
 * drawer trigger). One convention for all six pages.
 */

import type { JSX, ReactNode } from "react";

export function PageHeader({
  title,
  description,
  meta,
  actions,
}: {
  title: string;
  /** One-line muted description; truncates rather than wrapping the row. */
  description?: ReactNode;
  /** Inline chips right after the title (Cut's version/duration/dirty). */
  meta?: ReactNode;
  /** Right-aligned controls. */
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header
      data-testid="page-header"
      className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1"
    >
      <h2 className="text-sm font-semibold text-fg">{title}</h2>
      {meta}
      {description ? (
        <p className="min-w-0 flex-1 truncate text-xs text-fg-muted">
          {description}
        </p>
      ) : null}
      {actions ? (
        <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
