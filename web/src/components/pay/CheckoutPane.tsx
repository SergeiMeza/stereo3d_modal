"use client";

/**
 * The payment form inside every sheet (spec v6 D1/G2): Checkout Elements
 * on the gateway's Checkout Session — the wallet row (Express Checkout),
 * "or pay another way", the Payment Element, and the Tax ID Element behind
 * "Add business details". Themed from the app's tokens (Appearance API).
 *
 * Business and Studio (gateway 00105): the session requires a billing
 * address, so the pane shows Stripe's Billing Address Element (wired into
 * the session), and the optional business name and tax ID right away.
 * QA 2026-11-05: the address comes first, above the payment fields, is
 * prefilled from the saved business details, and `revealMissing` scrolls
 * to it and focuses it when the sheet's button is pressed too early.
 *
 * A render prop hands the sheet a `PayForm` (ready, confirm, selected
 * method) so the sheet owns the one main button and the states.
 *
 * Test mode: a client secret starting `cs_mock_` (the MSW mock gateway)
 * swaps Stripe for a plain stand-in whose confirm asks the mock what
 * happened — the screens and their states run without Stripe.js.
 */

import {
  BillingAddressElement,
  CheckoutElementsProvider,
  ExpressCheckoutElement,
  PaymentElement,
  TaxIdElement,
  useCheckoutElements,
} from "@stripe/react-stripe-js/checkout";
import type { Appearance, StripeAddressElement } from "@stripe/stripe-js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import { getStripe } from "@/components/billing/stripeLoader";
import type { CompanyAddress } from "@/lib/api/types";

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
  /** the required billing address is filled in (true when none is asked) */
  addressComplete: boolean;
  /** an asked-for address that isn't complete: scroll to it, focus its
   * first field and say true; otherwise false */
  revealMissing: () => boolean;
}

/** A saved address to start the billing address with. */
export interface PrefillAddress {
  name?: string | null;
  address: CompanyAddress;
}

/** A saved address worth prefilling: a country and a street at least. */
export function usablePrefill(p: PrefillAddress | null | undefined): PrefillAddress | null {
  if (!p?.address?.country || !p.address.line1?.trim()) return null;
  return p;
}

/** Bring a block into view inside the sheet's scrolling body. */
function scrollToBlock(el: HTMLElement | null): void {
  el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
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
  billingAddress = false,
  prefillAddress = null,
  children,
}: {
  clientSecret: string;
  publishableKey?: string;
  /** Business/Studio: the session requires a billing address, and offers
   * the business name and tax ID */
  billingAddress?: boolean;
  /** the saved business address the billing address starts with */
  prefillAddress?: PrefillAddress | null;
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
        billingAddress={billingAddress}
        prefillAddress={prefillAddress}
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
      billingAddress={billingAddress}
      prefillAddress={prefillAddress}
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
  billingAddress,
  prefillAddress,
  children,
}: {
  clientSecret: string;
  publishableKey: string;
  big: boolean;
  showSaveLine: boolean;
  returnQuery?: string;
  setup: boolean;
  collapseCards: boolean;
  billingAddress: boolean;
  prefillAddress: PrefillAddress | null;
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
        billingAddress={billingAddress}
        prefillAddress={prefillAddress}
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
  billingAddress,
  prefillAddress,
  children,
}: {
  big: boolean;
  showSaveLine: boolean;
  /** unused: the gateway's session carries the return address */
  returnQuery?: string;
  setup: boolean;
  collapseCards: boolean;
  billingAddress: boolean;
  prefillAddress: PrefillAddress | null;
  children: (form: PayForm, body: ReactNode) => ReactNode;
}): JSX.Element {
  const result = useCheckoutElements();
  const [selected, setSelected] = useState<string | null>(null);
  const [business, setBusiness] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [wallets, setWallets] = useState<boolean | null>(null);
  const [cardsOpen, setCardsOpen] = useState(!collapseCards);
  // the Billing Address Element's own "complete" (null until it reports)
  const [addressDone, setAddressDone] = useState<boolean | null>(null);
  // nodes in state, not refs: the sheet's button reads them from `form`
  const [addressBlock, setAddressBlock] = useState<HTMLDivElement | null>(null);
  const [addressEl, setAddressEl] = useState<StripeAddressElement | null>(null);
  const prefilled = useRef(false);
  const ready = result.type === "success";
  const checkout = result.type === "success" ? result.checkout : null;
  const prefill = usablePrefill(prefillAddress);

  // QA 2026-11-05: start the address from the saved business details when
  // the session has none of its own (Stripe fills it from the customer)
  useEffect(() => {
    if (!checkout || !billingAddress || !prefill || prefilled.current) return;
    prefilled.current = true;
    if (checkout.billingAddress?.address?.line1) return;
    const a = prefill.address;
    void checkout
      .updateBillingAddress({
        name: prefill.name ?? null,
        address: {
          country: a.country,
          line1: a.line1 ?? null,
          line2: a.line2 ?? null,
          city: a.city ?? null,
          postal_code: a.postal_code ?? null,
          state: a.state ?? null,
        },
      })
      .catch(() => undefined);
  }, [checkout, billingAddress, prefill]);

  const sessionAddress = checkout?.billingAddress?.address;
  const addressComplete =
    !billingAddress || (addressDone ?? Boolean(sessionAddress?.country && sessionAddress.line1));
  // saving isn't offered for Alipay or WeChat Pay (never saved, B6)
  const savable = selected !== "alipay" && selected !== "wechat_pay";

  const form: PayForm = {
    ready,
    selected,
    message,
    wallets,
    cardsOpen,
    openCards: () => setCardsOpen(true),
    addressComplete,
    revealMissing: () => {
      if (addressComplete) return false;
      setCardsOpen(true);
      scrollToBlock(addressBlock);
      addressEl?.focus();
      return true;
    },
    confirm: async () => {
      if (result.type !== "success") return "declined";
      setMessage(null);
      // No returnUrl: the gateway sets return_url on every session, and
      // Stripe refuses a confirm that passes one too (IntegrationError,
      // thrown before any request; the sheet hung on "Paying…").
      let res: Awaited<ReturnType<typeof result.checkout.confirm>>;
      try {
        res = await result.checkout.confirm({ redirect: "if_required" });
      } catch (e) {
        setMessage(e instanceof Error && e.message ? e.message : null);
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
        if (outcome === "declined") setMessage(res.error.message ?? null);
        return outcome;
      }
      return confirmSuccessResult((res.session as { status?: SessionStatus }).status);
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
          {billingAddress && cardsOpen ? (
            // gateway 00105: required; the element writes it into the
            // session. QA 2026-11-05: first, so it's never below the fold
            <div ref={setAddressBlock} data-testid="billing-address" className="flex flex-col gap-2 scroll-mt-4">
              <p className="text-sm font-medium text-fg">Billing address</p>
              <BillingAddressElement
                onChange={(e) => setAddressDone(e.complete)}
                onReady={setAddressEl}
              />
            </div>
          ) : null}
          {cardsOpen ? (
            <PaymentElement
              options={{ layout: { type: "tabs" } }}
              onChange={(e) => setSelected(e.value?.type ?? null)}
            />
          ) : wallets !== false ? (
            <CardsToggle big={big} onOpen={() => setCardsOpen(true)} />
          ) : null}
          {!setup && !billingAddress && cardsOpen ? (
            <button
              type="button"
              onClick={() => setBusiness((b) => !b)}
              className="w-fit text-sm text-primary hover:underline"
            >
              {business ? REMOVE_BUSINESS : ADD_BUSINESS}
            </button>
          ) : null}
          {(billingAddress || business) && !setup && cardsOpen ? (
            // the session's optional business name and tax ID
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
  billingAddress = false,
  prefillAddress = null,
  children,
}: {
  clientSecret: string;
  showSaveLine: boolean;
  setup?: boolean;
  collapseCards?: boolean;
  billingAddress?: boolean;
  prefillAddress?: PrefillAddress | null;
  children: (form: PayForm, body: ReactNode) => ReactNode;
}): JSX.Element {
  const [selected, setSelected] = useState<string>("card");
  const [address, setAddress] = useState(() => {
    const a = usablePrefill(prefillAddress)?.address;
    return { country: a?.country ?? "US", line1: a?.line1 ?? "", city: a?.city ?? "", postal_code: a?.postal_code ?? "" };
  });
  const [message, setMessage] = useState<string | null>(null);
  const [addressBlock, setAddressBlock] = useState<HTMLFieldSetElement | null>(null);
  // the saved details may land after the pane: fill an untouched address once
  const mockPrefill = usablePrefill(prefillAddress)?.address ?? null;
  const mockPrefilled = useRef(mockPrefill !== null);
  useEffect(() => {
    if (!mockPrefill || mockPrefilled.current) return;
    mockPrefilled.current = true;
    setAddress((cur) =>
      cur.line1 || cur.city || cur.postal_code
        ? cur
        : { country: mockPrefill.country, line1: mockPrefill.line1 ?? "", city: mockPrefill.city ?? "", postal_code: mockPrefill.postal_code ?? "" },
    );
  }, [mockPrefill]);
  const addressDone = !billingAddress || (address.line1.trim() !== "" && address.city.trim() !== "" && address.postal_code.trim() !== "");
  const [business, setBusiness] = useState(false);
  const [wallets] = useState(mockWallets);
  const [cardsOpen, setCardsOpen] = useState(!collapseCards);
  const form: PayForm = {
    ready: true,
    selected,
    message,
    wallets,
    cardsOpen,
    openCards: () => setCardsOpen(true),
    addressComplete: addressDone,
    revealMissing: () => {
      if (addressDone) return false;
      setCardsOpen(true);
      scrollToBlock(addressBlock);
      const empty = Array.from(addressBlock?.querySelectorAll("input") ?? []).find((i) => i.value.trim() === "");
      empty?.focus();
      return true;
    },
    confirm: async () => {
      // like Stripe: the session won't confirm without its billing address
      if (!addressDone) {
        setMessage("Enter your billing address.");
        return "declined";
      }
      setMessage(null);
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
        {billingAddress ? (
          <fieldset ref={setAddressBlock} data-testid="mock-billing-address" className="flex flex-col gap-2">
            <legend className="mb-1 text-sm text-fg">Billing address</legend>
            {(
              [
                ["line1", "Address"],
                ["city", "City"],
                ["postal_code", "Postal code"],
              ] as const
            ).map(([k, label]) => (
              <input
                key={k}
                aria-label={label}
                placeholder={label}
                value={address[k]}
                onChange={(e) => setAddress({ ...address, [k]: e.target.value })}
                className="h-11 rounded-lg border border-edge bg-surface-2 px-3 text-sm text-fg"
              />
            ))}
          </fieldset>
        ) : null}
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
        {!setup && !billingAddress ? (
          <button
            type="button"
            onClick={() => setBusiness((b) => !b)}
            className="w-fit text-sm text-primary hover:underline"
          >
            {business ? REMOVE_BUSINESS : ADD_BUSINESS}
          </button>
        ) : null}
        {(business || billingAddress) && !setup ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex h-11 items-center rounded-lg border border-edge bg-surface-2 px-3 text-sm text-fg-muted">
              Business name (optional)
            </div>
            <div className="flex h-11 items-center rounded-lg border border-edge bg-surface-2 px-3 text-sm text-fg-muted">
              Tax ID (optional)
            </div>
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
