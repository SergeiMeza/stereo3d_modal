/**
 * A message with markup in it (owner 2026-11-07): links and emphasis stay
 * inside the sentence so translators can move them. In en.json:
 *   "terms": "By signing in you accept the <terms>Terms of Use</terms>."
 * and in the component:
 *   rich(t, "auth.terms", { terms: (c) => <Link href="/terms">{c}</Link> })
 * Values ({name}) work as in t(). A tag the code doesn't pass reads as
 * its text; a broken message reads as the English one.
 */

import { IntlMessageFormat } from "intl-messageformat";
import { Fragment, type ReactNode } from "react";

import en from "../../../messages/en.json";

import type { Messages, Tr, Values } from "./t";

type Tag = (chunks: ReactNode) => ReactNode;

function lookup(messages: Messages | undefined, key: string): string | undefined {
  let cur: string | Messages | undefined = messages;
  for (const part of key.split(".")) {
    if (cur === undefined || typeof cur === "string") return undefined;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

function format(text: string, tag: string, tags: Record<string, Tag>, values?: Values): ReactNode {
  const fmt = new IntlMessageFormat(text, tag);
  const wrapped: Record<string, unknown> = { ...values };
  for (const [name, fn] of Object.entries(tags)) {
    wrapped[name] = (chunks: ReactNode[]) => fn(chunks.map((c, i) => <Fragment key={i}>{c}</Fragment>));
  }
  const out = fmt.format(wrapped as Record<string, string>);
  return Array.isArray(out) ? out.map((part, i) => <Fragment key={i}>{part as ReactNode}</Fragment>) : (out as ReactNode);
}

/** The message's own language when it has the key, else English. */
export function rich(t: Tr, key: string, tags: Record<string, Tag>, values?: Values): ReactNode {
  const own = t.messages ? lookup(t.messages, key) : undefined;
  if (own !== undefined) {
    try {
      return format(own, t.intl, tags, values);
    } catch {
      // a broken translation reads in English
    }
  }
  const base = lookup(en as Messages, key);
  if (base === undefined) return t(key, values);
  return format(base, "en-US", tags, values);
}
