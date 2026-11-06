import type { ReactNode } from "react";

import { alertText } from "./DisputesAlert";
import { useAttention } from "../lib/attention";
import { Link, paths, type Route } from "../lib/router";
import { cn } from "../lib/utils";

/**
 * The console's navigation (BL-29 redesign B, IA in Main): Needs attention
 * on top, then Support, Money, Product and System. Badges only where
 * something is waiting: red = money or a deadline at risk, amber = due
 * today, grey = informational, blue = the total that needs you today.
 */

type Tone = "blue" | "red" | "amber" | "grey";

interface Item {
  route: Route["name"][];
  to: string;
  label: string;
  badge?: { n: number; tone: Tone; text: string } | null;
  dot?: { text: string } | null;
}

const BADGE: Record<Tone, string> = {
  blue: "bg-primary text-primary-foreground",
  red: "bg-destructive-bg text-destructive-foreground",
  amber: "bg-warning-bg text-warning-foreground",
  grey: "bg-neutral-bg text-neutral-foreground",
};

export function useNavGroups(): { name: string; items: Item[] }[] {
  const a = useAttention();
  const counts = a.cases?.counts;
  const due = counts ? counts.overdue + counts.due_today : 0;
  const needs = a.lanes.filter((l) => l.lane !== "week").length;
  const disputes = a.alert ? a.alert.disputes + a.alert.efws : 0;
  return [
    {
      name: "",
      items: [
        {
          route: ["overview"],
          to: paths.overview(),
          label: "Needs attention",
          badge: needs ? { n: needs, tone: "blue", text: `${needs} need you today` } : null,
        },
      ],
    },
    {
      name: "Support",
      items: [
        {
          route: ["cases", "case"],
          to: paths.cases(),
          label: "Cases",
          badge: due
            ? {
                n: due,
                tone: counts && counts.overdue > 0 ? "red" : "amber",
                text: [counts?.overdue ? `${counts.overdue} overdue` : "", counts?.due_today ? `${counts.due_today} due today` : ""]
                  .filter(Boolean)
                  .join(", "),
              }
            : null,
          dot: a.failedRefunds ? { text: `${a.failedRefunds} failed ${a.failedRefunds === 1 ? "refund" : "refunds"}` } : null,
        },
        { route: ["accounts", "account"], to: paths.accounts(), label: "Accounts" },
        { route: ["deletions"], to: paths.deletions(), label: "Deletions" },
        {
          route: ["feedback"],
          to: paths.feedback(),
          label: "Feedback",
          badge: a.feedbackNew ? { n: a.feedbackNew, tone: "grey", text: `${a.feedbackNew} new` } : null,
        },
      ],
    },
    {
      name: "Money",
      items: [
        {
          route: ["disputes"],
          to: paths.disputes(),
          label: "Disputes",
          badge: disputes && a.alert ? { n: disputes, tone: "red", text: alertText(a.alert) } : null,
        },
        { route: ["grants"], to: paths.grants(), label: "Grants" },
        { route: ["plans"], to: paths.plans(), label: "Plans surfaces" },
      ],
    },
    { name: "Product", items: [{ route: ["onboarding"], to: paths.onboarding(), label: "Onboarding" }] },
    {
      name: "System",
      items: [
        { route: ["security"], to: paths.security(), label: "Security" },
        { route: ["mails"], to: paths.mails(), label: "Mail previews" },
        { route: ["policy"], to: paths.policy(), label: "Policy" },
      ],
    },
  ];
}

export const PAGE_TITLES: Partial<Record<Route["name"], string>> = {
  overview: "Needs attention",
  cases: "Cases",
  case: "Case",
  accounts: "Accounts",
  account: "Account",
  feedback: "Feedback",
  disputes: "Disputes",
  grants: "Grants",
  deletions: "Deletions",
  plans: "Plans surfaces",
  onboarding: "Onboarding",
  security: "Security",
  mails: "Mail previews",
  policy: "Policy",
};

export function NavList({ route, onNavigate, big = false }: { route: Route; onNavigate?: () => void; big?: boolean }) {
  const groups = useNavGroups();
  return (
    <nav aria-label="Sections" className="flex flex-col gap-2.5">
      {groups.map((g) => (
        <div key={g.name || "top"} className="flex flex-col gap-px">
          {g.name && (
            <span className="px-2 pt-1.5 pb-0.5 text-2xs font-semibold tracking-[0.06em] text-muted-foreground uppercase">{g.name}</span>
          )}
          {g.items.map((it) => {
            const active = it.route.includes(route.name);
            return (
              <Link
                key={it.to}
                to={it.to}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-md px-2 text-sm text-foreground-2 hover:bg-accent/60 hover:text-foreground",
                  big ? "min-h-11 text-base" : "h-7.5",
                  active && "bg-accent font-semibold text-foreground shadow-[inset_2px_0_0_var(--ring)]",
                )}
              >
                <span>{it.label}</span>
                <Badges badge={it.badge} dot={it.dot} />
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function Badges({ badge, dot }: { badge?: Item["badge"]; dot?: Item["dot"] }): ReactNode {
  if (!badge && !dot) return null;
  return (
    <span className="flex items-center gap-1.5">
      {dot && (
        <span className="size-1.75 rounded-full bg-destructive" title={dot.text}>
          <span className="sr-only">, {dot.text}</span>
        </span>
      )}
      {badge && (
        <span className={cn("rounded-sm px-1.5 font-mono text-2xs font-medium tabular-nums", BADGE[badge.tone])} title={badge.text}>
          <span aria-hidden="true">{badge.n}</span>
          <span className="sr-only">: {badge.text}</span>
        </span>
      )}
    </span>
  );
}
