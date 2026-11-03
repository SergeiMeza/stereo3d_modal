"use client";

/**
 * The payment form inside every sheet (spec v6 D1/G2): Checkout Elements
 * on the gateway's Checkout Session — the wallet row (Express Checkout),
 * "or pay another way", the Payment Element, and the Tax ID Element behind
 * "Add business details". Themed from the app's tokens (Appearance API).
 *
 * A render prop hands the sheet a `PayForm` (ready, confirm, selected
 * method) so the sheet owns the one main button and the states.
 *
 * Test mode: a client secret starting `cs_mock_` (the MSW mock gateway)
 * swaps Stripe for a plain stand-in whose confirm asks the mock what
 * happened — the screens and their states run without Stripe.js.
 */

import {
  CheckoutElementsProvider,
  ExpressCheckoutElement,
  PaymentElement,
  TaxIdElement,
  useCheckoutElements,
} from "@stripe/react-stripe-js/checkout";
import type { Appearance } from "@stripe/stripe-js";
import { useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";

import { getStripe } from "@/components/billing/stripeLoader";

import { ADD_BUSINESS, OR_PAY_ANOTHER_WAY, REMOVE_BUSINESS, SAVE_LINE } from "./payCopy";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

export type ConfirmResult =
  | "paid"
  | "processing"
  | "declined"
  | "too_many"
  | "expired"
  | "already_paid"
  /** the browser is on its way to another page (Alipay, a bank) */
  | "redirect";

export interface PayForm {
  ready: boolean;
  /** the method picked in the Payment Element ("card", "alipay", …) */
  selected: string | null;
  /** a sentence the form itself wants shown (field errors) */
  message: string | null;
  confirm: () => Promise<ConfirmResult>;
  /** the wallet row's result (spec B13): true some wallet shows, false
   * none (headset: Pay on another device leads), null not known yet */
  wallets: boolean | null;
  /** the card fields are showing (headset: collapsed under "Pay with a card") */
  cardsOpen: boolean;
  openCards: () => void;
}

/** Test mode: whether the stand-in shows a wallet row. */
let mockWallets = true;
export function setMockWalletsForTests(on: boolean): void {
  mockWallets = on;
}

/** The app's tokens, read once at runtime (globals.css), for Stripe. */
function appearanceFromTokens(big: boolean): Appearance {
  const css =
    typeof window !== "undefined" ? getComputedStyle(document.documentElement) : null;
  const v = (name: string, fallback: string) =>
    css?.getPropertyValue(name).trim() || fallback;
  return {
    theme: "night",
    labels: "above",
    variables: {
      colorPrimary: v("--primary", "#4f8cff"),
      colorBackground: v("--secondary", "#18181d"),
      colorText: v("--foreground", "#e7e7ea"),
      colorTextSecondary: v("--muted-foreground", "#8b8b93"),
      colorDanger: v("--destructive", "#f87171"),
      borderRadius: "10px",
      fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif",
      fontSizeBase: big ? "20px" : "15px",
      spacingUnit: big ? "5px" : "4px",
    },
  };
}

function isMockSecret(secret: string): boolean {
  return secret.startsWith("cs_mock_");
}

export function CheckoutPane({
  clientSecret,
  publishableKey,
  big = false,
  showSaveLine = true,
  returnQuery,
  setup = false,
  collapseCards = false,
  children,
}: {
  clientSecret: string;
  publishableKey?: string;
  /** headset: bigger type and targets */
  big?: boolean;
  /** P2 pays with saved methods: no save line */
  showSaveLine?: boolean;
  /** what P4 needs to know after a redirect: "conversion=…&project=…" or
   * "settle=1" */
  returnQuery?: string;
  /** P15 adds a method: "or add another way", no business details */
  setup?: boolean;
  /** headset (spec B13): wallet row first, card fields under "Pay with a card" */
  collapseCards?: boolean;
  children: (form: PayForm, body: ReactNode) => ReactNode;
}): JSX.Element {
  if (isMockSecret(clientSecret)) {
    return (
      <MockPane clientSecret={clientSecret} showSaveLine={showSaveLine} setup={setup} collapseCards={collapseCards}>
        {children}
      </MockPane>
    );
  }
  return (
    <StripePane
      clientSecret={clientSecret}
      publishableKey={publishableKey ?? process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? ""}
      big={big}
      showSaveLine={showSaveLine}
      returnQuery={returnQuery}
      setup={setup}
      collapseCards={collapseCards}
    >
      {children}
    </StripePane>
  );
}

function StripePane({
  clientSecret,
  publishableKey,
  big,
  showSaveLine,
  returnQuery,
  setup,
  collapseCards,
  children,
}: {
  clientSecret: string;
  publishableKey: string;
  big: boolean;
  showSaveLine: boolean;
  returnQuery?: string;
  setup: boolean;
  collapseCards: boolean;
  children: (form: PayForm, body: ReactNode) => ReactNode;
}): JSX.Element {
  const stripe = useMemo(() => getStripe(publishableKey), [publishableKey]);
  const appearance = useMemo(() => appearanceFromTokens(big), [big]);
  return (
    <CheckoutElementsProvider
      stripe={stripe}
      options={{ clientSecret, elementsOptions: { appearance } }}
    >
      <StripeForm
        big={big}
        showSaveLine={showSaveLine}
        returnQuery={returnQuery}
        setup={setup}
        collapseCards={collapseCards}
      >
        {children}
      </StripeForm>
    </CheckoutElementsProvider>
  );
}

function StripeForm({
  big,
  showSaveLine,
  returnQuery,
  setup,
  collapseCards,
  children,
}: {
  big: boolean;
  showSaveLine: boolean;
  returnQuery?: string;
  setup: boolean;
  collapseCards: boolean;
  children: (form: PayForm, body: ReactNode) => ReactNode;
}): JSX.Element {
  const result = useCheckoutElements();
  const [selected, setSelected] = useState<string | null>(null);
  const [business, setBusiness] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [wallets, setWallets] = useState<boolean | null>(null);
  const [cardsOpen, setCardsOpen] = useState(!collapseCards);
  const ready = result.type === "success";
  // saving isn't offered for Alipay or WeChat Pay (never saved, B6)
  const savable = selected !== "alipay" && selected !== "wechat_pay";

  const form: PayForm = {
    ready,
    selected,
    message,
    wallets,
    cardsOpen,
    openCards: () => setCardsOpen(true),
    confirm: async () => {
      if (result.type !== "success") return "declined";
      setMessage(null);
      const res = await result.checkout.confirm({
        redirect: "if_required",
        returnUrl: `${window.location.origin}/pay/return${returnQuery ? `?${returnQuery}` : ""}`,
      });
      if (res.type === "error") {
        const code = (res.error as { code?: string }).code ?? "";
        if (code.includes("rate_limit") || code === "too_many_attempts") return "too_many";
        if (code.includes("expired")) return "expired";
        setMessage(res.error.message ?? null);
        return "declined";
      }
      const status = (res.session as { status?: { type?: string; paymentStatus?: string } }).status;
      if (status?.paymentStatus === "unpaid" || status?.type === "open") return "processing";
      return "paid";
    },
  };

  const body = (
    <div className="flex flex-col gap-4">
      {result.type === "loading" ? <FormSkeleton /> : null}
      {result.type === "error" ? (
        <p className="text-sm text-red-400">{result.error.message}</p>
      ) : null}
      {ready ? (
        <>
          <ExpressCheckoutElement
            options={
              {
                buttonHeight: big ? 56 : 48,
              } as Parameters<typeof ExpressCheckoutElement>[0]["options"]
            }
            // spec B13: the wallet row says whether any wallet shows here
            onReady={(e) => setWallets(e.availablePaymentMethods !== undefined && e.availablePaymentMethods !== null)}
            onConfirm={async (event) => {
              if (result.type === "success") {
                await result.checkout.confirm({ expressCheckoutConfirmEvent: event });
              }
            }}
          />
          {wallets !== false && cardsOpen ? <Divider setup={setup} /> : null}
          {cardsOpen ? (
            <PaymentElement
              options={{ layout: { type: "tabs" } }}
              onChange={(e) => setSelected(e.value?.type ?? null)}
            />
          ) : wallets !== false ? (
            <CardsToggle big={big} onOpen={() => setCardsOpen(true)} />
          ) : null}
          {!setup && cardsOpen ? (
            <button
              type="button"
              onClick={() => setBusiness((b) => !b)}
              className="w-fit text-sm text-primary hover:underline"
            >
              {business ? REMOVE_BUSINESS : ADD_BUSINESS}
            </button>
          ) : null}
          {business && !setup && cardsOpen ? (
            <TaxIdElement options={{ visibility: "always", fields: { businessName: "always" } }} />
          ) : null}
          {showSaveLine && savable && cardsOpen ? <SaveLine /> : null}
        </>
      ) : null}
    </div>
  );
  return <>{children(form, body)}</>;
}

/** The test-mode stand-in: the same layout, no Stripe. */
function MockPane({
  clientSecret,
  showSaveLine,
  setup = false,
  collapseCards = false,
  children,
}: {
  clientSecret: string;
  showSaveLine: boolean;
  setup?: boolean;
  collapseCards?: boolean;
  children: (form: PayForm, body: ReactNode) => ReactNode;
}): JSX.Element {
  const [selected, setSelected] = useState<string>("card");
  const [business, setBusiness] = useState(false);
  const [wallets] = useState(mockWallets);
  const [cardsOpen, setCardsOpen] = useState(!collapseCards);
  const form: PayForm = {
    ready: true,
    selected,
    message: null,
    wallets,
    cardsOpen,
    openCards: () => setCardsOpen(true),
    confirm: async () => {
      const res = await fetch(
        `${GATEWAY}/__mock__/checkout/${encodeURIComponent(clientSecret)}/confirm`,
        { method: "POST" },
      );
      const { result } = (await res.json()) as { result: ConfirmResult };
      return result;
    },
  };
  const body = (
    <div data-testid="mock-checkout" className="flex flex-col gap-4">
      {wallets ? (
        <div className="flex h-12 items-center justify-center rounded-lg bg-black text-sm font-medium text-white">
          Wallet (test mode)
        </div>
      ) : null}
      {wallets && cardsOpen ? <Divider setup={setup} /> : null}
      {!cardsOpen ? (
        wallets ? <CardsToggle big={collapseCards} onOpen={() => setCardsOpen(true)} /> : null
      ) : (
        <>
        <div role="radiogroup" aria-label="Payment method" className="grid grid-cols-2 gap-2">
          {(setup ? (["card", "paypal"] as const) : (["card", "alipay"] as const)).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={selected === m}
              onClick={() => setSelected(m)}
              className={`h-12 rounded-lg border text-sm ${
                selected === m ? "border-primary bg-primary/10 text-fg" : "border-edge text-fg-muted"
              }`}
            >
              {m === "card" ? "Card" : m === "paypal" ? "PayPal" : "Alipay"}
            </button>
          ))}
        </div>
        {selected === "card" ? (
          <div className="flex h-11 items-center rounded-lg border border-edge bg-surface-2 px-3 font-mono text-sm text-fg-muted">
            4242 4242 4242 4242
          </div>
        ) : null}
        {!setup ? (
          <button
            type="button"
            onClick={() => setBusiness((b) => !b)}
            className="w-fit text-sm text-primary hover:underline"
          >
            {business ? REMOVE_BUSINESS : ADD_BUSINESS}
          </button>
        ) : null}
        {business && !setup ? (
          <div className="flex h-11 items-center rounded-lg border border-edge bg-surface-2 px-3 text-sm text-fg-muted">
            Tax ID
          </div>
        ) : null}
        {showSaveLine && selected !== "alipay" ? <SaveLine /> : null}
        </>
      )}
    </div>
  );
  return <>{children(form, body)}</>;
}

/** Headset: the card fields wait under "Pay with a card" (spec B13). */
function CardsToggle({ big, onOpen }: { big: boolean; onOpen: () => void }): JSX.Element {
  return (
    <button
      type="button"
      data-testid="pay-with-card"
      onClick={onOpen}
      className={`w-full rounded-lg border border-edge text-fg hover:bg-surface-2 ${big ? "h-14 text-xl" : "h-12 text-sm"}`}
    >
      Pay with a card
    </button>
  );
}

function Divider({ setup = false }: { setup?: boolean }): JSX.Element {
  return (
    <div className="flex items-center gap-3 text-xs text-fg-muted">
      <span className="h-px flex-1 bg-edge" />
      {setup ? "or add another way" : OR_PAY_ANOTHER_WAY}
      <span className="h-px flex-1 bg-edge" />
    </div>
  );
}

function SaveLine(): JSX.Element {
  return (
    <p data-testid="pay-save-line" className="text-xs text-fg-muted">
      {SAVE_LINE}
    </p>
  );
}

function FormSkeleton(): JSX.Element {
  return (
    <div data-testid="pay-skeleton" className="flex animate-pulse flex-col gap-3">
      <div className="h-12 rounded-lg bg-surface-2" />
      <div className="h-3 w-1/3 self-center rounded bg-surface-2" />
      <div className="h-11 rounded-lg bg-surface-2" />
      <div className="grid grid-cols-2 gap-3">
        <div className="h-11 rounded-lg bg-surface-2" />
        <div className="h-11 rounded-lg bg-surface-2" />
      </div>
    </div>
  );
}
