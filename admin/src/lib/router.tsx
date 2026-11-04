import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

/** A tiny history router. */

export type Route =
  | { name: "overview" }
  | { name: "grants" }
  | { name: "cases" }
  | { name: "case"; id: string }
  | { name: "accounts" }
  | { name: "account"; uid: string }
  | { name: "disputes" }
  | { name: "onboarding" }
  | { name: "plans" }
  | { name: "feedback" }
  | { name: "mails" }
  | { name: "policy" }
  | { name: "security" }
  | { name: "not_found" };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split(/[?#]/)[0].split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { name: "overview" };
  const [a, b] = parts;
  if (a === "overview" && parts.length === 1) return { name: "overview" };
  if (a === "grants" && parts.length === 1) return { name: "grants" };
  if (a === "cases" && parts.length === 1) return { name: "cases" };
  if (a === "cases" && parts.length === 2 && b) return { name: "case", id: b };
  if (a === "accounts" && parts.length === 1) return { name: "accounts" };
  if (a === "accounts" && parts.length === 2 && b) return { name: "account", uid: b };
  if (a === "disputes" && parts.length === 1) return { name: "disputes" };
  if (a === "onboarding" && parts.length === 1) return { name: "onboarding" };
  if (a === "plans" && parts.length === 1) return { name: "plans" };
  if (a === "feedback" && parts.length === 1) return { name: "feedback" };
  if (a === "mails" && parts.length === 1) return { name: "mails" };
  if (a === "policy" && parts.length === 1) return { name: "policy" };
  if (a === "security" && parts.length === 1) return { name: "security" };
  return { name: "not_found" };
}

export const paths = {
  overview: () => "/",
  grants: () => "/grants",
  cases: () => "/cases",
  case: (id: string, opts?: { decide?: boolean }) => `/cases/${encodeURIComponent(id)}${opts?.decide ? "?decide=1" : ""}`,
  accounts: () => "/accounts",
  account: (uid: string) => `/accounts/${encodeURIComponent(uid)}`,
  disputes: () => "/disputes",
  onboarding: () => "/onboarding",
  plans: () => "/plans",
  feedback: () => "/feedback",
  mails: () => "/mails",
  policy: () => "/policy",
  security: () => "/security",
};

interface RouterValue {
  route: Route;
  /** the query string of the current path, e.g. ?decide=1 */
  search: URLSearchParams;
  navigate: (to: string) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({
  children,
  initialPath,
}: {
  children: ReactNode;
  initialPath?: string;
}) {
  const [path, setPath] = useState(
    () => initialPath ?? window.location.pathname + window.location.search,
  );
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    if (to !== window.location.pathname + window.location.search) window.history.pushState(null, "", to);
    setPath(to);
    window.scrollTo?.(0, 0);
  }, []);
  const value = useMemo(
    () => ({ route: parseRoute(path), search: new URLSearchParams(path.split("?")[1] ?? ""), navigate }),
    [path, navigate],
  );
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const v = useContext(RouterContext);
  if (!v) throw new Error("useRouter outside RouterProvider");
  return v;
}

export function Link({
  to,
  children,
  onClick: onClickProp,
  ...rest
}: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { navigate } = useRouter();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClickProp?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} {...rest} onClick={onClick}>
      {children}
    </a>
  );
}
