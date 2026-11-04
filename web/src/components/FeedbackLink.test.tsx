/**
 * In-app feedback (owner 2026-11-04): the dialog posts to POST
 * /v1/feedback with the page's context; a failure keeps the text.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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

import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { FeedbackLink, pageContext } from "./FeedbackLink";

vi.mock("next/navigation", () => ({ usePathname: () => "/projects/abc123" }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
  window.sessionStorage.clear();
});
afterAll(() => server.close());

function open() {
  render(
    <AuthProvider>
      <FeedbackLink />
    </AuthProvider>,
  );
  fireEvent.click(screen.getByTestId("feedback-open"));
}

describe("feedback in the app", () => {
  it("page context: route, project and run ids", () => {
    expect(pageContext("/projects/p1", "?run=c9", "")).toEqual({
      route: "/projects/p1",
      project_id: "p1",
      run_id: "c9",
    });
    expect(pageContext("/pricing", "", "")).toEqual({ route: "/pricing" });
  });

  it("sends kind, message, email, consent and the page, signed in", async () => {
    open();
    fireEvent.click(await screen.findByTestId("feedback-kind-problem"));
    fireEvent.change(screen.getByTestId("feedback-message"), {
      target: { value: "The preview stalls" },
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId("feedback-email") as HTMLInputElement).value,
      ).toBe("dev@example.com"),
    );
    fireEvent.click(screen.getByTestId("feedback-send"));
    expect(
      await screen.findByText("Thanks, we read every message."),
    ).toBeTruthy();
    const sent = mockDb.feedback.at(-1)!;
    expect(sent.signed_in).toBe(true);
    expect(sent.body).toMatchObject({
      kind: "problem",
      message: "The preview stalls",
      email: "dev@example.com",
      ok_to_contact: true,
      context: { route: "/projects/abc123", project_id: "abc123" },
    });
    expect((sent.body.context as { locale?: string }).locale).toBeTruthy();
  });

  it("a 429 keeps the text and points to support", async () => {
    mockDb.nextFeedbackStatus = 429;
    open();
    fireEvent.change(await screen.findByTestId("feedback-message"), {
      target: { value: "Keep me" },
    });
    fireEvent.click(screen.getByTestId("feedback-send"));
    expect((await screen.findByTestId("feedback-error")).textContent).toBe(
      "Couldn't send. You can also write to support@spatial-ai-labs.com",
    );
    expect(
      (screen.getByTestId("feedback-message") as HTMLTextAreaElement).value,
    ).toBe("Keep me");
    expect(mockDb.feedback).toHaveLength(0);
  });
});
