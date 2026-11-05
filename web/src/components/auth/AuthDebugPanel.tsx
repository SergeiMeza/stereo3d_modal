"use client";

/**
 * ?authdebug=1 (owner bug 2026-11-05, staging and tests only, never in a
 * production build): what the redirect settle saw, readable on a phone.
 * Only a uid prefix, never a token.
 */

import { useSyncExternalStore } from "react";
import type { JSX } from "react";

import { AUTH_DEBUG_ALLOWED, authDebugAtom } from "@/lib/authRedirect";
import { useAppAtomValue } from "@/lib/state/stores";

const noSubscribe = () => () => {};

function askedFor(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("authdebug") === "1";
  } catch {
    return false;
  }
}

export function AuthDebugPanel(): JSX.Element | null {
  const on = useSyncExternalStore(noSubscribe, askedFor, () => false);
  const d = useAppAtomValue(authDebugAtom);
  if (!AUTH_DEBUG_ALLOWED || !on) return null;
  const rows: [string, string][] = [
    ["stored intent", d.intent ?? "none"],
    ["pending redirect", d.pending ? "yes" : "no"],
    ["result read", d.ran ? "yes" : "no"],
    ["outcome", d.outcome ?? "—"],
    ["signed-in user", d.currentUser === null ? "—" : d.currentUser ? "yes" : "no"],
    ["authDomain", d.authDomain ?? "—"],
    ["page host", d.host ?? "—"],
    ["time", d.at ?? "—"],
  ];
  return (
    <aside
      data-testid="auth-debug"
      className="mx-2 mb-2 rounded-lg border border-amber-400/60 bg-surface-1/95 p-3 font-mono text-xs text-fg shadow-lg"
    >
      <p className="mb-1 font-semibold text-amber-300">Sign-in debug (staging)</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-muted">{k}</dt>
            <dd className="break-all">{v}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
