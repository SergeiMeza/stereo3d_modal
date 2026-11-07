"use client";

/**
 * One section's error boundary (owner bug 2026-11-05: a History row the
 * page didn't expect took all of Billing down). A section that throws
 * shows a short line and Try again; the rest of the page stays.
 */

import { Component } from "react";
import type { ErrorInfo, JSX, ReactNode } from "react";

import { useT } from "@/lib/i18n/I18nProvider";

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
    return (
      <SectionFailed
        name={this.props.name}
        listItem={this.props.listItem}
        onRetry={() => this.setState({ failed: false })}
      />
    );
  }
}

/** The fallback line (a function component, for the translator). */
function SectionFailed({
  name,
  listItem,
  onRetry,
}: {
  name: string;
  listItem?: boolean;
  onRetry: () => void;
}): JSX.Element {
  const t = useT();
  const Tag = listItem ? "li" : "div";
  return (
    <Tag
      role="alert"
      data-testid="section-failed"
      className={
        listItem
          ? "flex items-center gap-3 border-t border-edge py-2.5 text-sm"
          : "flex items-center gap-3 rounded-xl border border-edge bg-surface-1 px-5 py-4 text-sm"
      }
    >
      <span className="text-fg-muted">{t("common.sectionBoundary.failed", { name })}</span>
      <button type="button" onClick={onRetry} className="ms-auto text-primary hover:underline">
        {t("common.sectionBoundary.tryAgain")}
      </button>
    </Tag>
  );
}
