import { useEffect, useState, type ReactNode } from "react";
import { SearchIcon } from "lucide-react";

import {
  Command as CommandRoot,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { money, words } from "@/lib/format";
import { typeLabel } from "@/lib/labels";
import { paths, useRouter } from "@/lib/router";
import { useServices } from "@/lib/services";
import type { CaseRow } from "@/lib/types";

/**
 * ⌘K search (BL-29 redesign B): a case id jumps to the case, `uid:…` or a
 * bare Firebase uid to the account; anything else searches the cases list
 * (GET /v1/admin/cases?tab=all&q=…, which matches case ids, emails, run ids
 * and Stripe ids). For an email, the account comes from its newest case
 * (GET /v1/admin/cases/{id} carries the uid): the gateway has no account
 * search by email. Recent items are kept per browser.
 */

const RECENT_KEY = "svs-admin.recent";
const CASE_ID = /^CASE-\d{3,}$/i;
const UID = /^[A-Za-z0-9]{20,40}$/;

interface Recent {
  label: string;
  to: string;
}

function readRecent(): Recent[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.slice(0, 5) : [];
  } catch {
    return [];
  }
}

function remember(item: Recent) {
  try {
    const next = [item, ...readRecent().filter((r) => r.to !== item.to)].slice(0, 5);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // private window: no recents
  }
}

const PAGES: Recent[] = [
  { label: "Needs attention", to: paths.overview() },
  { label: "Cases", to: paths.cases() },
  { label: "Accounts", to: paths.accounts() },
  { label: "Disputes", to: paths.disputes() },
  { label: "Grants", to: paths.grants() },
  { label: "Feedback", to: paths.feedback() },
  { label: "Security", to: paths.security() },
];

/**
 * ⌘K / Ctrl+K anywhere in the signed-in console, and "/" outside text
 * fields. Mounted with the shell only (not on the sign-in screen); plain
 * keys typed into a field are never taken.
 */
export function useCommandShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      const combo = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k";
      const slash = e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (!combo && !slash) return;
      // not over another dialog (a money confirm, the decision sheet)
      if (document.querySelector('[role="alertdialog"], [role="dialog"]:not([data-command-dialog])')) return;
      e.preventDefault();
      open();
    };
    // eslint-disable-next-line no-restricted-syntax -- the ⌘K shortcut: shell-only, modifier or "/" outside fields
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
}

/** The header's search field (wide screens) or icon (phones). */
export function SearchButton({ onClick, compact = false }: { onClick: () => void; compact?: boolean }) {
  if (compact) {
    return (
      <Button variant="ghost" size="icon" className="size-11" aria-label="Search" onClick={onClick}>
        <SearchIcon className="size-5" />
      </Button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Search accounts, cases, runs"
      aria-keyshortcuts="Meta+K Control+K"
      className="flex h-9 w-full max-w-[520px] items-center gap-2.5 rounded-lg border border-border bg-secondary px-3 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <SearchIcon className="size-4" aria-hidden />
      <span className="flex-1 text-left">Search accounts, cases, runs</span>
      <Kbd>⌘K</Kbd>
    </button>
  );
}

export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { api } = useServices();
  const { navigate } = useRouter();
  const [q, setQ] = useState("");
  const [cases, setCases] = useState<CaseRow[] | null>(null);
  const [account, setAccount] = useState<{ uid: string; email: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const term = q.trim();

  useEffect(() => {
    if (!open) {
      setQ("");
      setCases(null);
      setAccount(null);
    }
  }, [open]);

  useEffect(() => {
    setCases(null);
    setAccount(null);
    setError(false);
    if (term.length < 3 || CASE_ID.test(term) || term.startsWith("uid:")) return;
    let live = true;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api.listCases({ tab: "all", q: term });
        if (!live) return;
        const rows = (r.cases ?? []).slice(0, 8);
        setCases(rows);
        if (term.includes("@") && rows[0]) {
          const page = await api.getCase(rows[0].id).catch(() => null);
          if (live && page?.case.uid) setAccount({ uid: page.case.uid, email: page.account.email || term });
        }
      } catch {
        if (live) setError(true);
      } finally {
        if (live) setBusy(false);
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [api, term]);

  const go = (item: Recent) => {
    remember(item);
    onOpenChange(false);
    navigate(item.to);
  };

  const recent = term ? [] : readRecent();
  const uid = term.startsWith("uid:") ? term.slice(4).trim() : UID.test(term) ? term : "";
  const caseId = CASE_ID.test(term) ? term.toUpperCase() : "";

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandMenuBody>
        <CommandInput placeholder="Account email or uid, case, run…" aria-label="Search" value={q} onValueChange={setQ} />
        <CommandList>
          {term && !caseId && !uid && !busy && cases !== null && cases.length === 0 && !account && (
            <CommandEmpty>Nothing matches “{term}”.</CommandEmpty>
          )}
          {error && <p className="px-3 py-3 text-sm text-destructive-foreground">Search didn't work. Try again.</p>}
          {caseId && (
            <CommandGroup heading="Case">
              <CommandItem value={`case ${caseId}`} onSelect={() => go({ label: caseId, to: paths.case(caseId) })}>
                Open {caseId}
                <CommandShortcut>↵</CommandShortcut>
              </CommandItem>
            </CommandGroup>
          )}
          {(uid || account) && (
            <CommandGroup heading="Accounts">
              {uid && (
                <CommandItem value={`uid ${uid}`} onSelect={() => go({ label: `Account ${uid}`, to: paths.account(uid) })}>
                  Open the account <span className="font-mono text-xs text-muted-foreground">{uid}</span>
                </CommandItem>
              )}
              {account && (
                <CommandItem value={`account ${account.uid}`} onSelect={() => go({ label: account.email, to: paths.account(account.uid) })}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{account.email}</span>
                    <span className="text-xs text-muted-foreground">from its newest case</span>
                  </span>
                  <CommandShortcut className="font-mono tracking-normal">{account.uid.slice(0, 6)}…</CommandShortcut>
                </CommandItem>
              )}
            </CommandGroup>
          )}
          {busy && (
            <div className="flex justify-center py-3">
              <Spinner label="Searching" />
            </div>
          )}
          {cases && cases.length > 0 && (
            <CommandGroup heading="Cases">
              {cases.map((c) => (
                <CommandItem key={c.id} value={`case ${c.id}`} onSelect={() => go({ label: `${c.id} · ${typeLabel(c.type)}`, to: paths.case(c.id) })}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">
                      <span className="font-mono">{c.id}</span> · {typeLabel(c.type)} · {words(c.reason)}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">{c.email_masked}</span>
                  </span>
                  <CommandShortcut className="font-mono tracking-normal tabular-nums">{money(c.max_refundable_cents ?? c.requested_cents)}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {recent.length > 0 && (
            <CommandGroup heading="Recent">
              {recent.map((r) => (
                <CommandItem key={r.to} value={`recent ${r.to}`} onSelect={() => go(r)}>
                  {r.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {!term && (
            <CommandGroup heading="Go to">
              {PAGES.map((p) => (
                <CommandItem key={p.to} value={`page ${p.label}`} onSelect={() => go(p)}>
                  {p.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>CASE-…, uid:…, an email or a run id</span>
        </div>
      </CommandMenuBody>
    </CommandDialog>
  );
}

/** cmdk's root with server-side matching (we filter on the gateway). */
function CommandMenuBody({ children }: { children: ReactNode }) {
  return (
    <CommandRoot shouldFilter={false} label="Search">
      {children}
    </CommandRoot>
  );
}

