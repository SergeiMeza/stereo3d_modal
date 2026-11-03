"use client";

/**
 * GET /v1/billing/methods (S3D-60/62): the saved payment methods,
 * read-only. null until it answers (or when it fails).
 */

import { useCallback, useEffect, useState } from "react";

import type { BillingMethods, SavedMethod } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";

export function usePaymentMethods(): SavedMethod[] | null {
  const gateway = useGateway();
  const [methods, setMethods] = useState<SavedMethod[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    gateway.getPaymentMethods().then(
      (m) => {
        if (!cancelled) setMethods(m.methods);
      },
      () => {
        if (!cancelled) setMethods(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [gateway]);
  return methods;
}

/** spec v6.2 P10: the methods with their limit, and a way to replace the
 * list with what a change returned (or reload it). */
export function useBillingMethods(): {
  list: BillingMethods | null;
  error: boolean;
  set: (m: BillingMethods) => void;
  reload: () => Promise<void>;
} {
  const gateway = useGateway();
  const [list, setList] = useState<BillingMethods | null>(null);
  const [error, setError] = useState(false);
  const reload = useCallback(async () => {
    try {
      setList(await gateway.getPaymentMethods());
      setError(false);
    } catch {
      setError(true);
    }
  }, [gateway]);
  useEffect(() => {
    let live = true;
    gateway.getPaymentMethods().then(
      (m) => live && setList(m),
      () => live && setError(true),
    );
    return () => {
      live = false;
    };
  }, [gateway]);
  return { list, error, set: setList, reload };
}

/** A card past its expiry month. */
export function isExpired(m: SavedMethod, now = new Date()): boolean {
  if (!m.exp_month || !m.exp_year) return false;
  return m.exp_year < now.getFullYear() || (m.exp_year === now.getFullYear() && m.exp_month < now.getMonth() + 1);
}

const TYPE_NAMES: Record<string, string> = {
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
  link: "Link",
  paypal: "PayPal",
  cashapp: "Cash App",
  klarna: "Klarna",
  alipay: "Alipay",
  wechat_pay: "WeChat Pay",
};

function brandName(brand: string): string {
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

/** "Visa •••• 4242", "Apple Pay · Visa •••• 4242", "PayPal · name@…" */
export function methodLabel(m: SavedMethod): string {
  const card = m.brand && m.last4 ? `${brandName(m.brand)} •••• ${m.last4}` : null;
  if (m.type === "card" && m.wallet) {
    const wallet = { apple_pay: "Apple Pay", google_pay: "Google Pay", link: "Link" }[m.wallet];
    return card ? `${wallet} · ${card}` : wallet;
  }
  if (m.type === "card") return card ?? "Card";
  const name = TYPE_NAMES[m.type] ?? m.type;
  const detail = card ?? (m.email ? shortEmail(m.email) : null);
  return detail ? `${name} · ${detail}` : name;
}

/** "j•••@gmail.com" (spec v6 P10) — enough to recognise it. */
function shortEmail(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? `${email.charAt(0)}•••${email.slice(at)}` : email;
}
