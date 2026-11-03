import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmailCodeStep } from "@/components/auth/SignInScreen";
import { EmailCodeError } from "@/lib/emailCode";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => cleanup());

function setup(over: Partial<Parameters<typeof EmailCodeStep>[0]> = {}) {
  const props = {
    email: "a@example.com",
    resendAt: Date.now() + 30_000,
    linking: null,
    onResend: vi.fn(async () => true),
    onVerify: vi.fn(async () => {}),
    onBack: vi.fn(),
    ...over,
  };
  render(<EmailCodeStep {...props} />);
  return props;
}

const input = () => screen.getByLabelText("Sign-in code") as HTMLInputElement;

describe("EmailCodeStep", () => {
  it("submits on the sixth digit", async () => {
    const p = setup();
    fireEvent.change(input(), { target: { value: "12345" } });
    expect(p.onVerify).not.toHaveBeenCalled();
    fireEvent.change(input(), { target: { value: "123456" } });
    await waitFor(() => expect(p.onVerify).toHaveBeenCalledWith("123456"));
  });

  it("takes a pasted code with spaces", async () => {
    const p = setup();
    fireEvent.paste(input(), { clipboardData: { getData: () => "Code: 123 456" } });
    await waitFor(() => expect(p.onVerify).toHaveBeenCalledWith("123456"));
  });

  it("ignores letters a keyboard sends", () => {
    setup();
    fireEvent.change(input(), { target: { value: "12ab" } });
    expect(input().value).toBe("12");
  });

  it("says how many tries are left and clears the slots", async () => {
    setup({
      onVerify: vi.fn(async () => {
        throw new EmailCodeError("code_invalid", "That code isn't right.", 400, null, 1);
      }),
    });
    fireEvent.change(input(), { target: { value: "000000" } });
    expect((await screen.findByRole("alert")).textContent).toBe("That code isn't right. 1 try left.");
    expect(input().value).toBe("");
  });

  it("unlocks Send a new code after the wait", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const p = setup({ resendAt: Date.now() + 2_000 });
      const resend = screen.getByTestId("code-resend") as HTMLButtonElement;
      expect(resend.disabled).toBe(true);
      expect(resend.textContent).toMatch(/in 0:0\d/);
      vi.advanceTimersByTime(2_600);
      await waitFor(() => expect(resend.disabled).toBe(false));
      fireEvent.click(resend);
      await waitFor(() => expect(p.onResend).toHaveBeenCalled());
    } finally {
      vi.useRealTimers();
    }
  });

  it("says what gets linked", () => {
    setup({ linking: { email: "a@example.com", providerId: "apple.com" } });
    expect(screen.getByTestId("code-linking").textContent).toContain("Apple will be added");
  });
});
