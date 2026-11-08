/**
 * Which way this browser reaches the gateway (BL-34), after Heiki's rules
 * (calorie-tracker ADR-0129 §1 and §9, GatewayRoute.swift).
 *
 * Two routes: `direct` (NEXT_PUBLIC_GATEWAY_URL) and `cn_relay` (the cn.
 * host, lib/region.ts). Mainland China can't reach the direct host, and a
 * blocked host there doesn't refuse, it says nothing, so a visitor Vercel
 * doesn't place in CN would otherwise wait on requests that never answer.
 *
 * The rules:
 * - Before the first gateway request of a page load, `prepare()` asks
 *   `/health` on the remembered route (else `direct`) with a 5 s timeout,
 *   then on the other route. The first that answers is used.
 * - Only a connection failure moves the route: DNS, TLS, refused, reset,
 *   or the timeout before any answer. An HTTP status, 4xx and 5xx
 *   included, is an answer and never moves it. Being offline isn't a
 *   reason either: no other host would do better.
 * - `cn_relay` is remembered in localStorage (`direct` is the default, so
 *   remembering it is remembering nothing). Storage may be blocked; then
 *   the route lasts as long as the page.
 * - Someone on `cn_relay` by this choice asks `direct` again every 6 h
 *   (`recheckDirect()`); a 200 sends the next page load back to `direct`.
 *   This page keeps its route: switching it would sign the person out in
 *   the middle of what they're doing (lib/auth.tsx follows the route).
 * - A failed request asks again (`reportFailure()`), at most once a minute.
 * - Only visitors outside China mode choose. China mode by the country
 *   header (src/proxy.ts) is the relay, as before, and `?region=cn` /
 *   `?region=global` pin `cn_relay` / `direct` for testing: a pinned route
 *   is never probed and never moves.
 *
 * Pure logic with its effects passed in, so tests drive it without a
 * browser; lib/region.ts holds the page's instance.
 */

export type RouteName = "direct" | "cn_relay";

export const ROUTE_STORAGE_KEY = "s3d-gateway-route";
/** How long a probe waits on one host before trying the other. */
export const PROBE_TIMEOUT_MS = 5_000;
/** The 6-hourly look at `direct` waits longer: nobody waits on it. */
export const RECHECK_TIMEOUT_MS = 10_000;
/** How long someone stays on the relay before `direct` is asked again. */
export const DIRECT_RECHECK_MS = 6 * 60 * 60 * 1000;
/** A failed request asks for a route again at most this often. */
export const REPROBE_MIN_GAP_MS = 60_000;

/** What localStorage keeps (only ever the relay). */
interface Remembered {
  route: "cn_relay";
  /** ms since epoch: when `direct` was last asked */
  directCheckedAt: number;
}

export interface RouteDeps {
  /** Off: the route is the region's, as before BL-34 (tests, the mock
   * gateway, the kill switch). */
  enabled(): boolean;
  /** The region from the country header or a pin (lib/region.ts). */
  home(): "cn" | "global";
  /** A `?region=` pin is in force. */
  pinned(): boolean;
  hosts(): { direct: string; cnRelay: string };
  fetch: typeof fetch;
  storage(): Storage | null;
  now(): number;
  /** False when the browser knows it's offline. */
  online(): boolean;
}

/** Whether a fetch failure says the host can't be reached: a TypeError
 * (DNS, TLS, refused, reset, CORS) or a timeout. A caller's own abort is
 * not one, and an HTTP status never reaches here (fetch resolves). */
export function isConnectionFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError";
}

function readRemembered(storage: Storage | null): Remembered | null {
  try {
    const raw = storage?.getItem(ROUTE_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Remembered>;
    if (v.route !== "cn_relay") return null;
    return {
      route: "cn_relay",
      directCheckedAt: typeof v.directCheckedAt === "number" ? v.directCheckedAt : 0,
    };
  } catch {
    return null;
  }
}

function writeRemembered(storage: Storage | null, value: Remembered | null): void {
  try {
    if (value === null) storage?.removeItem(ROUTE_STORAGE_KEY);
    else storage?.setItem(ROUTE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // storage blocked or full: the route lasts as long as the page
  }
}

type Reach = "answered" | "unreachable" | "offline";

export class GatewayRoute {
  /** This page's choice; undefined until read from storage. */
  private remembered: Remembered | null | undefined;
  private probed = false;
  private probing: Promise<void> | null = null;
  private lastReport = Number.NEGATIVE_INFINITY;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: RouteDeps) {}

  /** Whether this visitor's route is chosen by reachability. */
  private auto(): boolean {
    return this.deps.enabled() && this.deps.home() === "global" && !this.deps.pinned();
  }

  private state(): Remembered | null {
    if (this.remembered === undefined) this.remembered = readRemembered(this.deps.storage());
    return this.remembered;
  }

  /** The route the next request takes. */
  current(): RouteName {
    if (!this.auto()) return this.deps.home() === "cn" ? "cn_relay" : "direct";
    return this.state()?.route ?? "direct";
  }

  /** Whether `prepare()` has settled for this page load. */
  get settled(): boolean {
    return !this.auto() || this.probed;
  }

  baseUrl(route: RouteName = this.current()): string {
    const hosts = this.deps.hosts();
    return route === "cn_relay" ? hosts.cnRelay : hosts.direct;
  }

  /** Called whenever `current()` changes; returns unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  // ------------------------------------------------------------ probing

  /** Settles the route once per page load, before the first request.
   * Concurrent callers share one probe. A pinned route, China mode by
   * country and a disabled route resolve at once. */
  prepare(): Promise<void> {
    if (this.settled) return Promise.resolve();
    this.probing ??= this.probe().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  private async probe(): Promise<void> {
    // Offline: no host would do better; the next request asks again.
    if (!this.deps.online()) return;
    const first = this.current();
    const order: RouteName[] = first === "direct" ? ["direct", "cn_relay"] : ["cn_relay", "direct"];
    for (const route of order) {
      const r = await this.reach(route, PROBE_TIMEOUT_MS);
      if (r === "answered") {
        this.succeeded(route);
        this.probed = true;
        return;
      }
      if (r === "offline") return;
    }
    // Nothing answered in time: the remembered route stands for this page.
    this.probed = true;
  }

  /** One `/health`. `no-cors`: any answer, whatever its status or CORS
   * headers, proves the host is there. */
  private async reach(route: RouteName, timeoutMs: number): Promise<Reach> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await this.deps.fetch(`${this.baseUrl(route)}/health`, {
        mode: "no-cors",
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      });
      return "answered";
    } catch {
      // a fetch only throws before an answer: the connection, or our timeout
      return this.deps.online() ? "unreachable" : "offline";
    } finally {
      clearTimeout(timer);
    }
  }

  /** A host answered: remember it when that's a change. */
  private succeeded(route: RouteName): void {
    if (!this.auto()) return;
    const before = this.current();
    if (route === "direct") {
      if (this.state() !== null) {
        this.remembered = null;
        writeRemembered(this.deps.storage(), null);
      }
    } else if (this.state()?.route !== "cn_relay") {
      // direct was just asked (and didn't answer): the 6 h starts now
      this.remembered = { route: "cn_relay", directCheckedAt: this.deps.now() };
      writeRemembered(this.deps.storage(), this.remembered);
    }
    if (this.current() !== before) this.emit();
  }

  /** A real request failed. A connection failure asks for a route again
   * (the current one first, so a blip stays where it is), at most once a
   * minute; anything else, and an offline browser, changes nothing. */
  reportFailure(error: unknown): void {
    if (!this.auto() || !isConnectionFailure(error) || !this.deps.online()) return;
    const now = this.deps.now();
    if (now - this.lastReport < REPROBE_MIN_GAP_MS) return;
    this.lastReport = now;
    if (this.probing !== null) return;
    this.probed = false;
    void this.prepare();
  }

  // ----------------------------------------------------- back to direct

  /** Whether `direct` is due another look: on the relay by this choice
   * for longer than DIRECT_RECHECK_MS. */
  isDirectRecheckDue(): boolean {
    if (!this.auto()) return false;
    const s = readRemembered(this.deps.storage()) ?? this.state();
    if (s?.route !== "cn_relay") return false;
    return this.deps.now() - s.directCheckedAt >= DIRECT_RECHECK_MS;
  }

  /** Asks `direct` whether it answers 200 now; if it does, the next page
   * load starts there (this one keeps its route). True when it moved. */
  async recheckDirect(): Promise<boolean> {
    if (!this.isDirectRecheckDue()) return false;
    const checked: Remembered = { route: "cn_relay", directCheckedAt: this.deps.now() };
    if (this.remembered?.route === "cn_relay") this.remembered = checked;
    writeRemembered(this.deps.storage(), checked);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RECHECK_TIMEOUT_MS);
    let ok = false;
    try {
      const res = await this.deps.fetch(`${this.baseUrl("direct")}/health`, {
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      });
      ok = res.status === 200;
    } catch {
      ok = false;
    } finally {
      clearTimeout(timer);
    }
    // only if nothing pinned a route meanwhile
    if (!ok || !this.auto()) return false;
    writeRemembered(this.deps.storage(), null);
    return true;
  }
}
