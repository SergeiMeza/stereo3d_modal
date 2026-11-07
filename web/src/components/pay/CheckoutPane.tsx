"use client";

/**
 * The payment form inside every sheet (spec v6 D1/G2): Checkout Elements
 * on the gateway's Checkout Session — the wallet row (Express Checkout),
 * "or pay another way" and the Payment Element. Themed from the app's
 * tokens (Appearance API). Owner 2026-11-05: no tax ID or business name
 * here; they go in Business details after paying (the plan welcome links
 * there), and the sessions no longer collect them.
 *
 * Business and Studio too (owner 2026-11-05): only what's needed to charge
 * and work out tax — the method, and the country (and postal code where
 * Stripe asks, US and CA) that the Payment Element collects itself with
 * billing_address_collection "auto". The full address, company name and
 * tax ID go in Business details after paying.
 *
 * A render prop hands the sheet a `PayForm` (ready, confirm, selected
 * method) so the sheet owns the one main button and the states.
 *
 * Local currency (owner 2026-11-07, Option B): every payment session
 * allows Stripe's Adaptive Pricing, so the customer sees and pays the
 * amount in their own currency where Stripe offers it, and the Currency
 * Selector above the wallet row lets them keep US dollars. Adding a
 * method (setup) has no amount, so neither is there.
 *
 * Wallets (BUX-03): the Express Checkout row confirms with redirect
 * "if_required", so Apple Pay, Google Pay and Link finish in the sheet;
 * the sheet gets the result through onWallet and runs it through the same
 * paying → handle() path as the main button. One confirm at a time.
 *
 * Test mode: a client secret starting `cs_mock_` (the MSW mock gateway)
 * swaps Stripe for a plain stand-in whose confirm asks the mock what
 * happened — the screens and their states run without Stripe.js.
 */

import { appStore } from "@/lib/state/stores";
import { checkoutEmailAtom } from "./payAtoms";
import {
  CheckoutElementsProvider,
  CurrencySelectorElement,
  ExpressCheckoutElement,
  PaymentElement,
  useCheckoutElements,
} from "@stripe/react-stripe-js/checkout";
import type { Appearance } from "@stripe/stripe-js";
import { useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import { getStripe } from "@/components/billing/stripeLoader";
import { useT } from "@/lib/i18n/I18nProvider";

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

/** BUX-03: a wallet payment started; the promise is its result. */
export type WalletHandler = (result: Promise<ConfirmResult>) => void;

/** Shares one confirm at a time: a second call while one runs gets the
 * same answer instead of confirming again. */
function useOneConfirm(): {
  busy: () => boolean;
  run: (go: () => Promise<ConfirmResult>) => Promise<ConfirmResult>;
} {
  const inflight = useRef<Promise<ConfirmResult> | null>(null);
  return {
    busy: () => inflight.current !== null,
    run: (go) => {
      if (inflight.current) return inflight.current;
      const p = go().finally(() => {
        inflight.current = null;
      });
      inflight.current = p;
      return p;
    },
  };
}

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

/** Stripe Checkout's session status (open, expired, complete). */
export interface SessionStatus {
  type?: string;
  paymentStatus?: string;
}

const SESSION_GONE =
  /expired|no longer (?:active|available|valid|open)|not (?:active|open)|inactive|(?:was|been|is) cancel+ed|session (?:was |has been |is )?cancel+ed/i;
const SESSION_DONE =
  /already (?:been )?(?:paid|completed?)|(?:session|payment) (?:was |has been |is )?(?:already )?completed?\b/i;

/** A confirm that came back with the session paid, unpaid or expired. */
export function confirmSuccessResult(status: SessionStatus | undefined): ConfirmResult {
  if (status?.type === "expired") return "expired";
  if (status?.paymentStatus === "unpaid" || status?.type === "open") return "processing";
  return "paid";
}

/** A confirm that failed. An expired, canceled or completed session is
 * never a decline (staging 2026-11-05: a session that expired as Pay was
 * pressed left the sheet on "Paying…"): expired shows Start again,
 * completed reads as paid. Stripe's Checkout errors carry only `code:
 * "paymentFailed"` or null, so the session's own status and the message
 * decide. */
export function confirmErrorResult(
  error: { code?: string | null; message?: string },
  now?: SessionStatus,
): ConfirmResult {
  if (now?.type === "expired") return "expired";
  if (now?.type === "complete") return now.paymentStatus === "unpaid" ? "processing" : "already_paid";
  const code = error.code ?? "";
  const msg = error.message ?? "";
  if (code.includes("rate_limit") || code === "too_many_attempts") return "too_many";
  if (code !== "paymentFailed") {
    if (code.includes("expired") || code.includes("cancel") || SESSION_GONE.test(msg)) return "expired";
    if (code.includes("complete") || SESSION_DONE.test(msg)) return "already_paid";
  }
  return "declined";
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
  onWallet,
  children,
}: {
  clientSecret: string;
  publishableKey?: string;
  /** BUX-03: the wallet row's payment, for the sheet's paying state and
   * result; without it a wallet leaves for the session's return page */
  onWallet?: WalletHandler;
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
      <MockPane
        clientSecret={clientSecret}
        showSaveLine={showSaveLine}
        setup={setup}
        collapseCards={collapseCards}
        onWallet={onWallet}
      >
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
      onWallet={onWallet}
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
  onWallet,
  children,
}: {
  clientSecret: string;
  publishableKey: string;
  big: boolean;
  showSaveLine: boolean;
  returnQuery?: string;
  setup: boolean;
  collapseCards: boolean;
  onWallet?: WalletHandler;
  children: (form: PayForm, body: ReactNode) => ReactNode;
}): JSX.Element {
  const stripe = useMemo(() => getStripe(publishableKey), [publishableKey]);
  const appearance = useMemo(() => appearanceFromTokens(big), [big]);
  return (
    <CheckoutElementsProvider
      stripe={stripe}
      options={{
        clientSecret,
        elementsOptions: { appearance },
        // owner 2026-11-07: the local price where Stripe offers one
        ...(setup ? {} : { adaptivePricing: { allowed: true } }),
      }}
    >
      <StripeForm
        big={big}
        showSaveLine={showSaveLine}
        returnQuery={returnQuery}
        setup={setup}
        collapseCards={collapseCards}
        onWallet={onWallet}
      >
        {children}
      </StripeForm>
    </CheckoutElementsProvider>
  );
}

function StripeForm({
  big,
  showSaveLine,
  setup,
  collapseCards,
  onWallet,
  children,
}: {
  big: boolean;
  showSaveLine: boolean;
  /** unused: the gateway's session carries the return address */
  returnQuery?: string;
  setup: boolean;
  collapseCards: boolean;
  onWallet?: WalletHandler;
  children: (form: PayForm, body: ReactNode) => ReactNode;
}): JSX.Element {
  const t = useT();
  const result = useCheckoutElements();
  const one = useOneConfirm();
  const [selected, setSelected] = useState<string | null>(null);
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
    confirm: () => one.run(() => confirmWith({})),
  };

  type ConfirmArgs = NonNullable<Parameters<Extract<typeof result, { type: "success" }>["checkout"]["confirm"]>[0]>;
  /** One confirm, card or wallet; a wallet's decline reads as a wallet's. */
  async function confirmWith(extra: ConfirmArgs, wallet = false): Promise<ConfirmResult> {
    if (result.type !== "success") return "declined";
    setMessage(null);
    // No returnUrl: the gateway sets return_url on every session, and
    // Stripe refuses a confirm that passes one too (IntegrationError,
    // thrown before any request; the sheet hung on "Paying…").
    // redirect "if_required": only a redirect-based method (a bank, Alipay)
    // leaves the page; cards and wallets answer here.
    let res: Awaited<ReturnType<typeof result.checkout.confirm>>;
    try {
      res = await result.checkout.confirm({ ...extra, redirect: "if_required" });
    } catch (e) {
      setMessage(wallet ? t("pay.copy.walletDeclined") : e instanceof Error && e.message ? e.message : null);
      return "declined";
    }
    if (res.type === "error") {
      let now: SessionStatus | undefined;
      try {
        now = (result.checkout as { getSession?: () => { status?: SessionStatus } }).getSession?.()?.status;
      } catch {
        now = undefined;
      }
      const outcome = confirmErrorResult(res.error, now);
      if (outcome === "declined") setMessage(wallet ? t("pay.copy.walletDeclined") : (res.error.message ?? null));
      return outcome;
    }
    // gateway 00152: the plan's email prompt starts from the session's email
    const paidEmail = (res.session as { email?: string | null }).email;
    appStore.set(checkoutEmailAtom, typeof paidEmail === "string" && paidEmail ? paidEmail : null);
    return confirmSuccessResult((res.session as { status?: SessionStatus }).status);
  }

  const body = (
    <div className="flex flex-col gap-4 cramped:gap-3">
      {result.type === "loading" ? <FormSkeleton /> : null}
      {result.type === "error" ? (
        <p className="text-sm text-red-400">{result.error.message}</p>
      ) : null}
      {ready ? (
        <>
          {/* the customer can keep US dollars (no amount when adding a method) */}
          {setup ? null : (
            <div data-testid="pay-currency-selector">
              <CurrencySelectorElement />
            </div>
          )}
          <ExpressCheckoutElement
            options={
              {
                buttonHeight: big ? 56 : 48,
              } as Parameters<typeof ExpressCheckoutElement>[0]["options"]
            }
            // spec B13: the wallet row says whether any wallet shows here
            onReady={(e) => setWallets(e.availablePaymentMethods !== undefined && e.availablePaymentMethods !== null)}
            onConfirm={(event) => {
              // BUX-03: one payment at a time; a second wallet tap fails in
              // the wallet's own sheet
              if (result.type !== "success" || one.busy()) {
                event.paymentFailed({ reason: "fail" });
                return;
              }
              // no handler: Stripe's default, the session's return page
              if (!onWallet) {
                void result.checkout.confirm({ expressCheckoutConfirmEvent: event });
                return;
              }
              onWallet(one.run(() => confirmWith({ expressCheckoutConfirmEvent: event }, true)));
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
  onWallet,
  children,
}: {
  clientSecret: string;
  showSaveLine: boolean;
  setup?: boolean;
  collapseCards?: boolean;
  onWallet?: WalletHandler;
  children: (form: PayForm, body: ReactNode) => ReactNode;
}): JSX.Element {
  const t = useT();
  const one = useOneConfirm();
  const [selected, setSelected] = useState<string>("card");
  const [message, setMessage] = useState<string | null>(null);
  // like Stripe's card form: the country, and a postal code for US and CA
  // (shown only; the stand-in doesn't check them)
  const [country, setCountry] = useState("US");
  const [postal, setPostal] = useState("");
  const needsPostal = country === "US" || country === "CA";
  const [wallets] = useState(mockWallets);
  const [cardsOpen, setCardsOpen] = useState(!collapseCards);
  const form: PayForm = {
    ready: true,
    selected,
    message,
    wallets,
    cardsOpen,
    openCards: () => setCardsOpen(true),
    confirm: () => one.run(() => mockConfirm(false)),
  };
  async function mockConfirm(wallet: boolean): Promise<ConfirmResult> {
    setMessage(null);
    const res = await fetch(
      `${GATEWAY}/__mock__/checkout/${encodeURIComponent(clientSecret)}/confirm`,
      { method: "POST" },
    ).catch(() => null);
    const result = res ? ((await res.json()) as { result: ConfirmResult }).result : "declined";
    if (wallet && result === "declined") setMessage(t("pay.copy.walletDeclined"));
    return result;
  }
  const body = (
    <div data-testid="mock-checkout" className="flex flex-col gap-4 cramped:gap-3">
      {wallets ? (
        <button
          type="button"
          data-testid="mock-wallet"
          // like the wallet sheet: a second tap while one runs does nothing
          onClick={() => {
            if (!onWallet || one.busy()) return;
            onWallet(one.run(() => mockConfirm(true)));
          }}
          className="flex h-12 items-center justify-center rounded-lg bg-black text-sm font-medium text-white"
        >
          Wallet (test mode)
        </button>
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
        {selected === "card" ? (
          <div data-testid="mock-card-country" className="grid gap-2 sm:grid-cols-2">
            <select
              aria-label="Country"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="h-11 rounded-lg border border-edge bg-surface-2 px-3 text-sm text-fg"
            >
              {(["US", "CA", "GB", "JP", "DE"] as const).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {needsPostal ? (
              <input
                aria-label="ZIP"
                placeholder="ZIP"
                value={postal}
                onChange={(e) => setPostal(e.target.value)}
                className="h-11 rounded-lg border border-edge bg-surface-2 px-3 text-sm text-fg"
              />
            ) : null}
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
  const t = useT();
  return (
    <button
      type="button"
      data-testid="pay-with-card"
      onClick={onOpen}
      className={`w-full rounded-lg border border-edge text-fg hover:bg-surface-2 ${big ? "h-14 text-xl" : "h-12 text-sm"}`}
    >
      {t("pay.checkout.payWithCard")}
    </button>
  );
}

function Divider({ setup = false }: { setup?: boolean }): JSX.Element {
  const t = useT();
  return (
    <div className="flex items-center gap-3 text-xs text-fg-muted">
      <span className="h-px flex-1 bg-edge" />
      {setup ? t("pay.checkout.orAddAnotherWay") : t("pay.copy.orPayAnotherWay")}
      <span className="h-px flex-1 bg-edge" />
    </div>
  );
}

function SaveLine(): JSX.Element {
  const t = useT();
  return (
    <p data-testid="pay-save-line" className="text-xs text-fg-muted">
      {t("pay.copy.saveLine")}
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
