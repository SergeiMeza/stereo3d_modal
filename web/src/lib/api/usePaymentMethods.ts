"use client";

/**
 * GET /v1/billing/methods (S3D-60/62): the saved payment methods,
 * read-only. null until it answers (or when it fails).
 */

import { useEffect, useState } from "react";

import type { SavedMethod } from "@/lib/api/types";
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
  if (m.type === "card") return card ?? "Card";
  const name = TYPE_NAMES[m.type] ?? m.type;
  const detail = card ?? (m.email ? shortEmail(m.email) : null);
  return detail ? `${name} · ${detail}` : name;
}

/** "name@…" — enough to recognise it. */
function shortEmail(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? `${email.slice(0, at)}@…` : email;
}
