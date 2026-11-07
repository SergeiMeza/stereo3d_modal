/**
 * Auth surface tests. Vitest runs in mock auth mode (NEXT_PUBLIC_AUTH_MODE
 * unset), so nothing here ever loads the Firebase SDK — these cover the
 * mock-mode contracts every other screen leans on: the landing CTA, the
 * mocked /signin, RequireAuth passing through, and the account profile.
 */

import { scheduledLine } from "@/lib/accountDeletion";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { http, HttpResponse } from "msw";

import Home from "@/app/page";
import AccountScreen from "@/components/auth/AccountScreen";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { DUES_LINE } from "@/components/pay/DeleteDues";
import SignInScreen from "@/components/auth/SignInScreen";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace,
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/projects",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup(); // vitest runs with globals:false, so RTL auto-cleanup is off
  vi.restoreAllMocks();
  replace.mockClear();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

function renderWithAuth(ui: React.ReactElement) {
  return render(
    <AuthProvider>
      <BillingProvider>{ui}</BillingProvider>
    </AuthProvider>,
  );
}

describe("landing page", () => {
  it("shows the pitch and the CTA into /projects (mock user is signed in)", () => {
    renderWithAuth(<Home />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Turn any video into lifelike 3D",
    );
    for (const cta of screen.getAllByRole("link", { name: "Make your first 3D video" })) {
      expect(cta.getAttribute("href")).toBe("/projects");
    }
    // "How it looks": the new app's screens as tabs
    for (const screenName of ["Projects", "Make 3D", "Progress", "Files"]) {
      expect(screen.getByRole("tab", { name: screenName })).toBeTruthy();
    }
  });

  it("switches the screenshot when a tab is clicked", () => {
    renderWithAuth(<Home />);
    // Make 3D opens first
    expect(screen.getByRole("tab", { name: "Make 3D" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByRole("tabpanel").querySelector("img")?.getAttribute("src"),
    ).toContain("%2Flanding%2Fui%2Ffiles.webp");
    // S3D-01: the landing never offers Classic
    expect(document.body.textContent).not.toMatch(/Classic/);
    // no technical terms on the landing page (S3D-36), no top-bottom (S3D-08)
    expect(document.body.textContent).not.toMatch(
      /inpainting|video-native model|depth map|top-bottom|splat|gaussian/i,
    );
  });
});

describe("SignInScreen (mock mode)", () => {
  it("explains auth is mocked and offers a plain Continue into /projects", () => {
    renderWithAuth(<SignInScreen />);
    expect(
      screen.getByText("Auth is mocked in this environment."),
    ).toBeTruthy();
    const cta = screen.getByRole("link", { name: "Continue" });
    expect(cta.getAttribute("href")).toBe("/projects");
  });
});

describe("RequireAuth (mock mode)", () => {
  it("renders children immediately without redirecting", () => {
    renderWithAuth(
      <RequireAuth>
        <p>guarded content</p>
      </RequireAuth>,
    );
    expect(screen.getByText("guarded content")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("AccountScreen billing (mock mode)", () => {
  it("points to Billing for the card and purchase history (S3D-57)", () => {
    renderWithAuth(<AccountScreen />);
    expect(
      screen.getByRole("link", { name: "Billing" }).getAttribute("href"),
    ).toBe("/account/billing");
    expect(screen.queryByTestId("card-on-file")).toBeNull();
  });
});

describe("AccountScreen (mock mode)", () => {
  it("renders the mock user's profile fields", () => {
    renderWithAuth(<AccountScreen />);
    expect(screen.getByText("dev@example.com")).toBeTruthy();
    expect(screen.getByText("dev-user")).toBeTruthy();
    expect(screen.getByText("Email")).toBeTruthy(); // "password" provider badge
    const nameInput = screen.getByLabelText("Display name") as HTMLInputElement;
    expect(nameInput.value).toBe("Dev User");
  });

  it("copies the UID to the clipboard from the Copy ID button", async () => {
    // fireEvent, not userEvent: userEvent.setup() installs its own
    // navigator.clipboard stub, which would clobber this spy
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderWithAuth(<AccountScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Copy ID" }));

    expect(writeText).toHaveBeenCalledWith("dev-user");
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

});

describe("AccountScreen delete (mock mode)", () => {
  /** owner 2026-11-06: the button waits for the plan to be known */
  async function typeDeleteAndConfirm() {
    fireEvent.change(screen.getByLabelText(/Type DELETE/), {
      target: { value: "DELETE" },
    });
    const button = screen.getByRole("button", { name: "Delete account" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
  }

  function settleAllRuns() {
    for (const c of mockDb.conversions.values()) {
      if (["created", "paid", "processing"].includes(c.state))
        c.state = "canceled";
    }
  }

  it("deletes through the gateway: says when (48 hours), then signs out (gateway 00166)", async () => {
    settleAllRuns();
    renderWithAuth(<AccountScreen />);
    await typeDeleteAndConfirm();
    const line = await screen.findByTestId("deletion-scheduled-line");
    const after = mockDb.billing.accountDeletion!.delete_after;
    expect(new Date(after).getTime() - Date.now()).toBeGreaterThan(47 * 3_600_000);
    expect(line.textContent).toBe(scheduledLine(after));
    expect(line.textContent).toMatch(/^Your account will be deleted on .+\. You can still change your mind: sign in before then\.$/);
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  // 2026-10-27: a deleted account kept a $3.33 charge nobody could settle.
  it("refuses while a charge is unpaid and says how much", async () => {
    settleAllRuns();
    mockDb.billing.unpaid.push({
      conversion_id: "c00000000333",
      step: "depth_preview",
      amount_cents: 333,
      currency: "usd",
      needs_action: false,
    });
    renderWithAuth(<AccountScreen />);
    await typeDeleteAndConfirm();
    // P13: the dues notice with Pay $3.33 (the settle sheet), not a dead end
    expect(await screen.findByTestId("delete-dues")).toBeTruthy();
    expect(screen.getByText(DUES_LINE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pay $3.33" })).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  // gateway 00081: a cash balance is refunded first, then the account goes
  it("with a balance: says only that it's lost; no refund wording, no Refund and delete (policy 2026-11-07)", async () => {
    settleAllRuns();
    mockDb.billing.prepaid.balance_cents = 1250;
    mockDb.billing.prepaid.topups = 1;
    const bodies: unknown[] = [];
    server.events.on("request:start", async ({ request }) => {
      if (request.url.endsWith("/v1/account/delete")) bodies.push(await request.clone().json());
    });
    renderWithAuth(<AccountScreen />);
    const lost = await screen.findByTestId("delete-balance-lost");
    expect(lost.textContent).toBe("Your unspent balance of $12.50 will be lost when your account is deleted.");
    expect(within(lost).queryByRole("link")).toBeNull();
    expect(screen.getByText("Danger zone").closest("section")!.textContent).not.toMatch(/refund/i);
    expect(screen.queryByRole("button", { name: /refund/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/We return|returning your|Refund and delete|Delete and refund/);
    await typeDeleteAndConfirm();
    // the new gateway: deletion is scheduled as for anyone else
    expect(await screen.findByTestId("deletion-scheduled-line")).toBeTruthy();
    expect(mockDb.billing.deletionPending).toBeFalsy();
    // the loss line was on screen: an older gateway's confirmation goes along
    expect(bodies).toEqual([{ balance_confirmed: true }]);
    server.events.removeAllListeners();
  });

  it("an older gateway (balance refunded first): its 409 shows the loss line, and Delete again goes ahead", async () => {
    settleAllRuns();
    // a gateway before the policy, and a page that didn't know the balance
    const bodies: { balance_confirmed?: boolean }[] = [];
    server.use(
      http.post(/\/v1\/account\/delete$/, async ({ request }) => {
        const body = (await request.json()) as { balance_confirmed?: boolean };
        bodies.push(body);
        if (!body.balance_confirmed)
          return HttpResponse.json(
            { success: false, error: "balance_remaining", message: "refund first", details: { cents: 1250 } },
            { status: 409 },
          );
        return HttpResponse.json({ deleted: false, deletion_pending: true, case_id: "case_1", refund_cents: 1250 }, { status: 202 });
      }),
    );
    renderWithAuth(<AccountScreen />);
    await typeDeleteAndConfirm();
    const lost = await screen.findByTestId("delete-balance-lost");
    expect(lost.textContent).toContain("Your unspent balance of $12.50 will be lost");
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(bodies).toEqual([{}, { balance_confirmed: true }]);
  });
});

describe("AccountScreen delete: a renewing plan is cancelled first (owner 2026-11-06)", () => {
  afterEach(() => {
    delete (globalThis as { __mockDb?: typeof mockDb }).__mockDb;
  });

  const END = "2026-12-06T00:00:00Z";
  const END_TEXT = new Date(END).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  function teamPlan(plan: "business" | "studio", extra: Record<string, unknown> = {}): void {
    mockDb.billing.plan = {
      plan,
      name: plan === "studio" ? "Studio" : "Business",
      status: "active",
      active: true,
      monthly_cents: plan === "studio" ? 99900 : 29900,
      credit_cents: 40000,
      credit_left_cents: 40000,
      cancel_at_period_end: false,
      current_period_end: END,
      ...extra,
    } as never;
  }

  function webPro(extra: Record<string, unknown> = {}): void {
    mockDb.billing.plan = {
      plan: "pro",
      plan_id: "pro_monthly",
      name: "Pro Monthly",
      status: "active",
      active: true,
      monthly_cents: 899,
      cancel_at_period_end: false,
      current_period_end: END,
      ...extra,
    } as never;
    proStatus({ pro: true, known: true, source: "plan", plan_id: "pro_monthly", via: "pro_monthly", scheduled_change: null });
  }

  /** Mock mode reads Pro from the mock gateway's state. */
  function proStatus(status: NonNullable<typeof mockDb.proStatus>): void {
    mockDb.proStatus = status;
    (globalThis as { __mockDb?: typeof mockDb }).__mockDb = mockDb;
  }

  async function expectCancelFirst(): Promise<void> {
    const box = await screen.findByTestId("delete-plan-renewing");
    expect(box.textContent).toContain(`Cancel your plan first. It stays valid until ${END_TEXT}.`);
    expect(within(box).getByRole("link", { name: "Cancel plan" }).getAttribute("href")).toBe(
      "/account/billing?cancel=1",
    );
    // no delete on offer
    expect(screen.queryByLabelText(/Type DELETE/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete account" })).toBeNull();
  }

  /** Waits for the plan to be known, then reads the notice. */
  async function readyLine(): Promise<HTMLElement | null> {
    const button = screen.getByRole("button", { name: "Delete account" }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText(/Type DELETE/), { target: { value: "DELETE" } });
    await waitFor(() => expect(button.disabled).toBe(false));
    return screen.queryByTestId("delete-plan-line");
  }

  it.each([
    ["Studio", () => teamPlan("studio")],
    ["Business", () => teamPlan("business")],
    ["web Pro", () => webPro()],
    ["a plan with a step-down waiting", () => teamPlan("studio", { scheduled_change: { to: "business", effective_at: "2027-01-10T00:00:00Z" } })],
  ])("%s still renewing: cancel first, no delete", async (_name, setUp) => {
    setUp();
    renderWithAuth(<AccountScreen />);
    await expectCancelFirst();
  });

  it.each([
    ["Studio", () => teamPlan("studio", { cancel_at_period_end: true })],
    ["Pro", () => webPro({ cancel_at_period_end: true })],
    // gateway 00138 records a cancel as a change to pay per video
    ["Business", () => teamPlan("business", { scheduled_change: { to: "pay_per_video", effective_at: END } })],
  ])("a cancelled %s plan stays valid and can be restored; delete goes ahead", async (name, setUp) => {
    setUp();
    settleRuns();
    renderWithAuth(<AccountScreen />);
    expect((await readyLine())?.textContent).toBe(
      `Your ${name} plan stays valid until ${END_TEXT}. If you sign up again with this email, you can restore it.`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    await screen.findByTestId("deletion-scheduled");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  it("the gateway's 409 plan_renewing turns the confirmation into cancel first", async () => {
    settleRuns();
    renderWithAuth(<AccountScreen />);
    expect(await readyLine()).toBeNull();
    // the plan started renewing after the page loaded
    teamPlan("business");
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    await expectCancelFirst();
    expect(replace).not.toHaveBeenCalled();
  });

  it("App Store Pro: cancel it with Apple", async () => {
    proStatus({ pro: true, known: true, source: "app_store", scheduled_change: null });
    renderWithAuth(<AccountScreen />);
    expect((await readyLine())?.textContent).toBe(
      "Pro from the App Store renews through Apple. Cancel it in your Apple ID settings.",
    );
  });

  it("no plan: nothing", async () => {
    renderWithAuth(<AccountScreen />);
    expect(await readyLine()).toBeNull();
    expect(screen.queryByTestId("delete-plan-renewing")).toBeNull();
  });

  it("the button waits while the plan is still loading", async () => {
    let answer: () => void = () => {};
    const gate = new Promise<void>((r) => (answer = r));
    server.use(
      http.get(/\/v1\/billing$/, async () => {
        await gate;
        return undefined;
      }),
    );
    teamPlan("business", { cancel_at_period_end: true });
    renderWithAuth(<AccountScreen />);
    fireEvent.change(screen.getByLabelText(/Type DELETE/), { target: { value: "DELETE" } });
    const button = screen.getByRole("button", { name: "Delete account" }) as HTMLButtonElement;
    await new Promise((r) => setTimeout(r, 100));
    expect(button.disabled).toBe(true);
    expect(screen.queryByTestId("delete-plan-line")).toBeNull();
    answer();
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(screen.getByTestId("delete-plan-line").textContent).toContain("Your Business plan stays valid until");
  });

  function settleRuns(): void {
    for (const c of mockDb.conversions.values()) {
      if (["created", "paid", "processing"].includes(c.state)) c.state = "canceled";
    }
  }
});
