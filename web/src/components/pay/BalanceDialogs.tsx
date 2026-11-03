"use client";

/**
 * Spec v7 (§N, G2): the prepaid balance's three dialogs and a provider so
 * any screen can open them — Billing's Balance card, the run buttons' "Add
 * funds" and "Change limit".
 *
 * - P17 Add funds: amount chips ($25 preselected) or Other, then the same
 *   payment form as P1 on a top-up payment; China mode pays with Alipay or
 *   WeChat Pay (no form script).
 * - P18 Auto-reload: toggle, threshold and amount, the consent line.
 * - P19 Spending: monthly spend limit and the balance alert.
 */

import { CheckIcon, AlertCircleIcon, LockIcon, RefreshCwIcon, CreditCardIcon } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import { GatewayError } from "@/lib/api/client";
import { prepaidOf, type BalanceSummary } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { methodLabel, useBillingMethods } from "@/lib/api/usePaymentMethods";
import { useBilling } from "@/lib/billing";
import { chinaPayments } from "@/lib/paymentRegion";

import { AddMethodSheet } from "./AddMethodSheet";
import { CheckoutPane, type ConfirmResult } from "./CheckoutPane";
import { Success, SUCCESS_CLOSE_MS } from "./PaySheet";
import {
  CHARGED_IN_USD,
  DECLINED,
  PAYING,
  TOO_MANY,
  TOPUP_DAILY,
  TOPUP_MIN,
  TOPUP_SMALL_PRINT,
  reloadConsent,
  topupDone,
  topupMax,
} from "./payCopy";
import { SheetFrame, useSheetFrame } from "./SheetFrame";

type Which = "funds" | "reload" | "spending" | null;

const Ctx = createContext<{ open: (w: Exclude<Which, null>) => void }>({ open: () => {} });

/** Open P17, P18 or P19 from anywhere under BalanceDialogsProvider. */
export function useBalanceDialogs(): {
  openAddFunds: () => void;
  openAutoReload: () => void;
  openSpending: () => void;
} {
  const { open } = useContext(Ctx);
  return {
    openAddFunds: () => open("funds"),
    openAutoReload: () => open("reload"),
    openSpending: () => open("spending"),
  };
}

export function BalanceDialogsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [which, setWhich] = useState<Which>(null);
  const close = () => setWhich(null);
  return (
    <Ctx.Provider value={{ open: setWhich }}>
      {children}
      {which === "funds" ? <AddFundsSheet onClose={close} /> : null}
      {which === "reload" ? <AutoReloadDialog onClose={close} /> : null}
      {which === "spending" ? <SpendingDialog onClose={close} /> : null}
    </Ctx.Provider>
  );
}

const CHIPS = [1000, 2500, 5000, 10000];
const MIN = 1000;

/** P17 Add funds. */
export function AddFundsSheet({ onClose }: { onClose: () => void }): JSX.Element {
  const gateway = useGateway();
  const billing = useBilling();
  const big = useSheetFrame() === "headset";
  const prepaid = prepaidOf(billing.status);
  const first = prepaid?.never_topped_up !== false;
  const [chip, setChip] = useState<number | "other">(2500);
  const [other, setOther] = useState("");
  const amount = chip === "other" ? Math.round(Number(other || "0")) * 100 : chip;
  const [session, setSession] = useState<
    | { kind: "none" }
    | { kind: "loading" }
    | { kind: "ready"; secret: string; publishableKey?: string; amount: number; notice?: string }
    | { kind: "paying"; secret: string; publishableKey?: string; amount: number }
    | { kind: "done"; text: string }
    | { kind: "error"; text: string }
  >({ kind: "none" });
  const [china, setChina] = useState<{ qr?: string } | null>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);

  const invalid =
    chip === "other" && other !== "" && amount < MIN ? TOPUP_MIN : null;

  // one top-up payment per amount; a new amount opens a new one
  useEffect(() => {
    if (chinaPayments() || invalid || amount < MIN) return;
    let live = true;
    const t = setTimeout(() => {
      setSession({ kind: "loading" });
      gateway.topUp(amount).then(
        (r) =>
          live &&
          setSession(
            r.checkout
              ? { kind: "ready", secret: r.checkout.client_secret, publishableKey: r.publishable_key, amount }
              : { kind: "error", text: "Payment isn't available in this region yet." },
          ),
        (e: unknown) => {
          if (!live) return;
          const g = e instanceof GatewayError ? e : null;
          const max = typeof g?.details?.max === "number" ? g.details.max : first ? 10000 : 50000;
          setSession({
            kind: "error",
            text:
              g?.code === "amount_out_of_range"
                ? amount < MIN
                  ? TOPUP_MIN
                  : topupMax(max, first)
                : g?.code === "topup_daily_cap"
                  ? TOPUP_DAILY
                  : "Payment isn't available in this region yet.",
          });
        },
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [gateway, amount, invalid, first]);

  useEffect(
    () => () => {
      if (closing.current) clearTimeout(closing.current);
    },
    [],
  );

  async function finish(added: number): Promise<void> {
    const s = await billing.refresh();
    const bal = prepaidOf(s)?.balance_cents ?? (prepaid?.balance_cents ?? 0) + added;
    setSession({ kind: "done", text: topupDone(added, bal) });
    closing.current = setTimeout(onClose, SUCCESS_CLOSE_MS);
  }

  function handle(r: ConfirmResult, s: { secret: string; publishableKey?: string; amount: number }): void {
    if (r === "paid" || r === "already_paid") return void finish(s.amount);
    if (r === "redirect") return;
    setSession({ kind: "ready", ...s, notice: r === "too_many" ? TOO_MANY : DECLINED });
  }

  const header = (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between rounded-lg border border-edge px-3 py-2.5 text-sm">
        <span className="text-fg-muted">Balance</span>
        <span data-testid="funds-balance" className="font-semibold tabular-nums text-fg">
          {formatCents(prepaid?.balance_cents ?? 0)}
        </span>
      </div>
      <div role="radiogroup" aria-label="Amount" className="grid grid-cols-5 gap-2">
        {[...CHIPS, "other" as const].map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={chip === c}
            onClick={() => setChip(c)}
            className={`h-12 rounded-lg border text-sm font-semibold tabular-nums transition-colors ${
              chip === c ? "border-primary bg-primary/10 text-fg" : "border-edge text-fg-muted hover:text-fg"
            }`}
          >
            {c === "other" ? "Other" : `$${c / 100}`}
          </button>
        ))}
      </div>
      {chip === "other" ? (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-muted">Amount</span>
          <span className="flex h-11 items-center rounded-lg border border-edge bg-surface-2 px-3">
            <span className="text-fg-muted">$</span>
            <input
              inputMode="numeric"
              aria-label="Amount"
              value={other}
              onChange={(e) => setOther(e.target.value.replace(/[^0-9]/g, ""))}
              className="w-full bg-transparent px-1 text-sm text-fg tabular-nums outline-none"
            />
          </span>
        </label>
      ) : null}
      {invalid ? <ErrorLine text={invalid} /> : null}
    </div>
  );

  if (session.kind === "done") {
    return (
      <SheetFrame open onClose={onClose} testId="add-funds-sheet" title="Add funds">
        <Success text={session.text} />
      </SheetFrame>
    );
  }

  if (chinaPayments()) {
    return (
      <SheetFrame
        open
        onClose={onClose}
        testId="add-funds-sheet"
        title="Add funds"
        footer={
          <div className="flex flex-col gap-2">
            <p className="text-xs text-fg-muted">{CHARGED_IN_USD}</p>
            <Button
              size="lg"
              className="h-12 w-full"
              disabled={amount < MIN}
              onClick={async () => {
                const r = await gateway.topUp(amount, "alipay").catch(() => null);
                if (r?.redirect_url) window.location.assign(r.redirect_url);
              }}
            >
              Alipay
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="h-12 w-full"
              disabled={amount < MIN}
              onClick={async () => {
                const r = await gateway.topUp(amount, "wechat_pay").catch(() => null);
                if (r?.qr_image_url) setChina({ qr: r.qr_image_url });
              }}
            >
              WeChat Pay
            </Button>
            <p className="text-center text-xs text-fg-muted">{TOPUP_SMALL_PRINT}</p>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          {header}
          {china?.qr ? (
            <div className="flex flex-col items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={china.qr} alt="" className="size-[200px] rounded-lg bg-white p-3" />
              <p className="text-sm text-fg tabular-nums">Scan with WeChat to pay {formatCents(amount)}</p>
            </div>
          ) : null}
        </div>
      </SheetFrame>
    );
  }

  const ready = session.kind === "ready" || session.kind === "paying" ? session : null;
  const paying = session.kind === "paying";
  const footer = (form?: { ready: boolean; confirm: () => Promise<ConfirmResult> }) => (
    <div className="flex flex-col gap-3">
      <p className="flex items-center gap-2 rounded-lg border border-edge/70 px-3 py-2 text-xs text-fg-muted">
        {CHARGED_IN_USD}
      </p>
      <Button
        size="lg"
        data-testid="add-funds-main"
        className={`w-full tabular-nums ${big ? "h-14 text-xl" : "h-12 text-base"}`}
        disabled={!form?.ready || paying || !ready || ready.amount !== amount || invalid !== null}
        onClick={async () => {
          if (!ready || !form) return;
          const s = { secret: ready.secret, publishableKey: ready.publishableKey, amount: ready.amount };
          setSession({ kind: "paying", ...s });
          handle(await form.confirm(), s);
        }}
      >
        {paying ? (
          PAYING
        ) : (
          <>
            <LockIcon className="size-4" aria-hidden />
            Add {formatCents(amount >= MIN ? amount : 0)}
          </>
        )}
      </Button>
      <p className="text-center text-xs text-fg-muted">{TOPUP_SMALL_PRINT}</p>
    </div>
  );

  if (!ready) {
    return (
      <SheetFrame open onClose={onClose} testId="add-funds-sheet" title="Add funds" footer={footer()}>
        <div className="flex flex-col gap-4">
          {header}
          {session.kind === "error" ? (
            <ErrorLine text={session.text} />
          ) : session.kind === "loading" ? (
            <div data-testid="pay-skeleton" className="h-40 animate-pulse rounded-lg bg-surface-2" />
          ) : null}
        </div>
      </SheetFrame>
    );
  }
  return (
    <CheckoutPane clientSecret={ready.secret} publishableKey={ready.publishableKey} big={big} returnQuery="topup=1">
      {(form, body) => (
        <SheetFrame open onClose={onClose} locked={paying} testId="add-funds-sheet" title="Add funds" footer={footer(form)}>
          <div className={`flex flex-col gap-4 ${paying ? "pointer-events-none opacity-60" : ""}`}>
            {header}
            {body}
            {session.kind === "ready" && session.notice ? <ErrorLine text={session.notice} /> : null}
          </div>
        </SheetFrame>
      )}
    </CheckoutPane>
  );
}

function ErrorLine({ text }: { text: string }): JSX.Element {
  return (
    <p
      data-testid="funds-error"
      className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200"
    >
      <AlertCircleIcon className="size-4 shrink-0" aria-hidden />
      {text}
    </p>
  );
}

function SavedLine({ text }: { text: string }): JSX.Element {
  return (
    <p className="flex h-12 items-center justify-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-sm text-emerald-200">
      <CheckIcon className="size-4" aria-hidden />
      {text}
    </p>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <label className="flex items-center justify-between gap-3 text-sm text-fg">
      {label}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => onChange(!on)}
        className={`relative h-6 w-10 rounded-full transition-colors ${on ? "bg-primary" : "bg-surface-2 ring-1 ring-edge"}`}
      >
        <span className={`absolute top-0.5 size-5 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
      </button>
    </label>
  );
}

function Money({
  label,
  value,
  onChange,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
}): JSX.Element {
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="text-xs text-fg-muted">{label}</span>
      <span
        className={`flex h-10 items-center rounded-lg border bg-surface-2 px-3 ${invalid ? "border-red-400" : "border-edge"}`}
      >
        <span className="text-fg-muted">$</span>
        <input
          inputMode="decimal"
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
          className="w-full bg-transparent px-1 text-sm text-fg tabular-nums outline-none"
        />
      </span>
    </label>
  );
}

const cents = (v: string) => Math.round(Number(v || "0") * 100);
const dollars = (c: number) => (c / 100).toFixed(2);

/** P18 Auto-reload. */
export function AutoReloadDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const gateway = useGateway();
  const billing = useBilling();
  const { list } = useBillingMethods();
  const prepaid = prepaidOf(billing.status);
  const ar = prepaid?.auto_reload ?? { enabled: false, below_cents: 1000, add_cents: 2500 };
  // "Set up" and "Edit" both open it switched on
  const [on, setOn] = useState(true);
  const [below, setBelow] = useState(dollars(ar.below_cents));
  const [add, setAdd] = useState(dollars(ar.add_cents));
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const methods = list?.methods ?? null;
  const def = methods?.find((m) => m.is_default) ?? methods?.[0];
  const noMethod = methods !== null && methods.length === 0;

  const addC = cents(add);
  const belowC = cents(below);
  const invalid = on
    ? addC < 1000
      ? "Add at least $10."
      : addC < belowC
        ? `Add at least as much as the threshold (${formatCents(belowC)}).`
        : null
    : null;

  async function save(): Promise<void> {
    if (invalid) return setError(invalid);
    setState("saving");
    setError(null);
    try {
      await gateway.saveBalanceSettings({ auto_reload: { enabled: on, below_cents: belowC, add_cents: addC } });
      await billing.refresh();
      setState("saved");
      setTimeout(onClose, SUCCESS_CLOSE_MS);
    } catch (e) {
      setState("idle");
      const code = e instanceof GatewayError ? e.code : "";
      setError(
        code === "auto_reload_blocked"
          ? "Auto-reload can't be turned on while we check a payment."
          : code === "method_needed"
            ? "Save a payment method to use auto-reload."
            : "Couldn't save that. Try again.",
      );
    }
  }

  return (
    <SheetFrame
      open
      onClose={onClose}
      locked={state === "saving"}
      testId="auto-reload-dialog"
      title="Auto-reload"
      footer={
        noMethod ? (
          <Button size="lg" className="h-12 w-full" onClick={() => setAdding(true)}>
            Add payment method
          </Button>
        ) : state === "saved" ? (
          <SavedLine text={on ? "Auto-reload is on." : "Saved."} />
        ) : (
          <Button size="lg" data-testid="auto-reload-save" className="h-12 w-full" disabled={state === "saving"} onClick={() => void save()}>
            {state === "saving" ? "Saving…" : "Save"}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <Toggle label="Auto-reload" on={on && !noMethod} onChange={setOn} />
        {noMethod ? (
          <p className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-fg">
            <CreditCardIcon className="size-4 text-primary" aria-hidden />
            Save a payment method to use auto-reload.
          </p>
        ) : on ? (
          <>
            <div className="flex gap-3">
              <Money label="When my balance drops below" value={below} onChange={setBelow} />
              <Money label="Add" value={add} onChange={setAdd} invalid={invalid !== null && error !== null} />
            </div>
            {error ? <ErrorLine text={error} /> : null}
            <p data-testid="reload-consent" className="flex gap-2 rounded-lg border border-edge/70 px-3 py-2 text-xs text-fg-muted">
              <RefreshCwIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {reloadConsent(def ? methodLabel(def) : null, addC, belowC)}
            </p>
          </>
        ) : error ? (
          <ErrorLine text={error} />
        ) : null}
      </div>
      {adding ? (
        <AddMethodSheet
          first
          onClose={(saved) => {
            setAdding(false);
            if (saved) void billing.refresh();
          }}
        />
      ) : null}
    </SheetFrame>
  );
}

/** P19 Spending: monthly spend limit and the balance alert. */
export function SpendingDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const gateway = useGateway();
  const billing = useBilling();
  const prepaid: BalanceSummary | null = prepaidOf(billing.status);
  const [limitOn, setLimitOn] = useState((prepaid?.spend_limit_cents ?? null) !== null);
  const [limit, setLimit] = useState(String(Math.round((prepaid?.spend_limit_cents ?? 10000) / 100)));
  const [alert, setAlert] = useState(dollars(prepaid?.low_balance_cents ?? 500));
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    setState("saving");
    setError(null);
    try {
      await gateway.saveBalanceSettings({
        spend_limit_cents: limitOn ? cents(limit) : null,
        low_balance_cents: cents(alert),
      });
      await billing.refresh();
      setState("saved");
      setTimeout(onClose, SUCCESS_CLOSE_MS);
    } catch {
      setState("idle");
      setError("Couldn't save that. Try again.");
    }
  }

  return (
    <SheetFrame
      open
      onClose={onClose}
      locked={state === "saving"}
      testId="spending-dialog"
      title="Spending"
      footer={
        state === "saved" ? (
          <SavedLine text="Saved." />
        ) : (
          <div className="flex flex-col gap-2">
            {error ? <ErrorLine text={error} /> : null}
            <Button size="lg" data-testid="spending-save" className="h-12 w-full" disabled={state === "saving"} onClick={() => void save()}>
              {state === "saving" ? "Saving…" : "Save"}
            </Button>
          </div>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <Toggle label="Monthly spend limit" on={limitOn} onChange={setLimitOn} />
        {limitOn ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-end gap-2">
              <Money label="Monthly spend limit" value={limit} onChange={setLimit} />
              <span className="pb-2.5 text-xs text-fg-muted tabular-nums">
                a month · {formatCents(prepaid?.month_spent_cents ?? 0)} used
              </span>
            </div>
            <p className="text-xs text-fg-muted">
              Runs stop when this month&apos;s spending reaches it. Resets on the 1st (UTC).
            </p>
          </div>
        ) : null}
        <div className="border-t border-edge pt-4">
          <Money label="Email me when my balance drops below" value={alert} onChange={setAlert} />
        </div>
      </div>
    </SheetFrame>
  );
}

