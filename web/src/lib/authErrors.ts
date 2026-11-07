/**
 * Customer copy on an error (owner 2026-11-07): sign-in and account errors
 * are thrown deep in lib code with no translator at hand, so they carry
 * their message key and values. The message stays English (logs, tests);
 * a screen shows errorText(e, t) in the reader's language.
 */

import { EN, type Tr, type Values } from "@/lib/i18n/t";

/** Values, or values worked out in the reader's language (lists of names). */
export type KeyedValues = Values | ((t: Tr) => Values);

interface Keyed {
  i18nKey?: unknown;
  i18nValues?: KeyedValues;
}

function valuesFor(v: KeyedValues | undefined, t: Tr): Values | undefined {
  return typeof v === "function" ? v(t) : v;
}

/** Tag an error with its message key (and values). */
export function keyed<E extends Error>(err: E, key: string, values?: KeyedValues): E {
  Object.assign(err, { i18nKey: key, i18nValues: values });
  return err;
}

/** A plain Error with an English message from a key, tagged with the key. */
export function keyedError(key: string, values?: KeyedValues): Error {
  return keyed(new Error(EN(key, valuesFor(values, EN))), key, values);
}

/** The English message for a key (for a subclass's super()). */
export function enText(key: string, values?: KeyedValues): string {
  return EN(key, valuesFor(values, EN));
}

/** Carry `from`'s key (if any) over to `to`. */
export function copyKey<E extends Error>(to: E, from: unknown): E {
  const k = from as Keyed | null;
  if (k && typeof k === "object" && typeof k.i18nKey === "string") keyed(to, k.i18nKey, k.i18nValues);
  return to;
}

/** What to show for an error: its key in the reader's language, else its
 * message (the gateway's own words), else the fallback key's message. */
export function errorText(e: unknown, t: Tr = EN, fallbackKey?: string): string {
  const k = e as Keyed | null;
  if (k && typeof k === "object" && typeof k.i18nKey === "string") return t(k.i18nKey, valuesFor(k.i18nValues, t));
  if (e instanceof Error) return e.message;
  return fallbackKey ? t(fallbackKey) : "";
}
