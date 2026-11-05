"use client";

/**
 * One section's error boundary (owner bug 2026-11-05: a History row the
 * page didn't expect took all of Billing down). A section that throws
 * shows a short line and Try again; the rest of the page stays.
 */

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

export const SECTION_FAILED = "This part couldn't be shown.";

interface Props {
  /** "Payment methods", for the line and the log */
  name: string;
  /** inside a list: the fallback is an <li> */
  listItem?: boolean;
  children: ReactNode;
}

export class SectionBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.name}]`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const Tag = this.props.listItem ? "li" : "div";
    return (
      <Tag
        role="alert"
        data-testid="section-failed"
        className={
          this.props.listItem
            ? "flex items-center gap-3 border-t border-edge py-2.5 text-sm"
            : "flex items-center gap-3 rounded-xl border border-edge bg-surface-1 px-5 py-4 text-sm"
        }
      >
        <span className="text-fg-muted">
          {this.props.name}: {SECTION_FAILED}
        </span>
        <button
          type="button"
          onClick={() => this.setState({ failed: false })}
          className="ml-auto text-primary hover:underline"
        >
          Try again
        </button>
      </Tag>
    );
  }
}
