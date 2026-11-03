import { describe, expect, it, vi } from "vitest";

import { apiError, fakeFetch, GATEWAY } from "../test/harness";
import { AdminApi, ApiError } from "./api";

function make(routes: Parameters<typeof fakeFetch>[0]) {
  const { fetch, calls } = fakeFetch(routes);
  let n = 0;
  const getToken = vi.fn(async (force?: boolean) => (force ? `fresh-${++n}` : "stale"));
  const onSessionProblem = vi.fn();
  const api = new AdminApi({ baseUrl: GATEWAY + "/", getToken, onSessionProblem, fetchImpl: fetch });
  return { api, calls, getToken, onSessionProblem };
}

describe("AdminApi", () => {
  it("sends the bearer token, no cookies, and the filters as a query", async () => {
    const { api, calls } = make({ "GET /v1/admin/cases": () => ({ json: { cases: [], counts: { open: 0, overdue: 0, due_today: 0 } } }) });
    await api.listCases({ tab: "waiting", type: "efw", reason: "", q: " pi_123 " });
    expect(calls[0].url).toBe(`${GATEWAY}/v1/admin/cases?tab=waiting&type=efw&q=pi_123`);
    expect(calls[0].headers.Authorization).toBe("Bearer stale");
  });

  it("parses gateway errors into ApiError with code and details", async () => {
    const { api } = make({
      "POST /v1/admin/cases/CASE-1/actions": () =>
        apiError(409, "amount_changed", "The amount changed to $3.00.", { max_refundable_cents: 300 }),
    });
    const err = await api.caseAction("CASE-1", { action: "approve", expected_max_cents: 500 }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("amount_changed");
    expect(err.details).toEqual({ max_refundable_cents: 300 });
  });

  it("retries once with a fresh token on invalid_token", async () => {
    let first = true;
    const { api, getToken, onSessionProblem } = make({
      "GET /v1/admin/policy": ({ headers }) => {
        if (first) {
          first = false;
          return apiError(401, "invalid_token", "expired");
        }
        expect(headers.Authorization).toBe("Bearer fresh-1");
        return { json: { policy: {}, edit_in: "config/refund_policy_test" } };
      },
    });
    const res = await api.policy();
    expect(res.edit_in).toBe("config/refund_policy_test");
    expect(getToken).toHaveBeenCalledWith(true);
    expect(onSessionProblem).not.toHaveBeenCalled();
  });

  it("calls the session over when the fresh token is refused too", async () => {
    const { api, onSessionProblem } = make({ "GET /v1/admin/policy": () => apiError(401, "invalid_token", "expired") });
    await expect(api.policy()).rejects.toMatchObject({ code: "invalid_token" });
    expect(onSessionProblem).toHaveBeenCalledWith("invalid_token");
  });

  it("does not retry reauth_required: the console asks the owner instead", async () => {
    const { api, calls, onSessionProblem } = make({
      "POST /v1/admin/cases/CASE-1/actions": () => apiError(401, "reauth_required", "sign in again"),
    });
    await expect(api.caseAction("CASE-1", { action: "approve" })).rejects.toMatchObject({ code: "reauth_required" });
    expect(calls).toHaveLength(1);
    expect(onSessionProblem).not.toHaveBeenCalled();
  });

  it.each(["no_access", "mfa_required"])("reports %s as a session problem", async (code) => {
    const { api, onSessionProblem } = make({ "GET /v1/admin/policy": () => apiError(403, code, "nope") });
    await expect(api.policy()).rejects.toMatchObject({ code });
    expect(onSessionProblem).toHaveBeenCalledWith(code);
  });

  it("downloads the disputes CSV as a blob", async () => {
    const { api, calls } = make({ "GET /v1/admin/disputes/summary": () => ({ text: "month,charges\n2026-11,3\n" }) });
    const blob = await api.disputesCsv(12);
    expect(await blob.text()).toContain("2026-11,3");
    expect(calls[0].url).toContain("months=12&format=csv");
  });

  it("encodes ids in paths", async () => {
    const { api, calls } = make({ "GET /v1/admin/accounts/a%2Fb": () => ({ json: {} }) });
    await api.getAccount("a/b");
    expect(calls[0].path).toBe("/v1/admin/accounts/a%2Fb");
  });
});
