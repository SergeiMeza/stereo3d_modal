import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appIntroParams } from "@/components/appIntro/OpenWebAppButton";
import * as analytics from "@/lib/analytics";

import AppIntroPage, { generateMetadata } from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/app",
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("/app (WEB-02): the apps' introduction to the web app", () => {
  it("has its title and canonical, and names no price", async () => {
    const meta = await generateMetadata();
    expect(meta.title).toBe("Lifelike 3D on the web");
    expect(meta.alternates?.canonical).toBe("/app");
    expect(String(meta.description)).not.toContain("$");
  });

  it("introduces, with one button to / and no way to pay", async () => {
    const { container } = render(await AppIntroPage());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Make your videos 3D in the browser",
    );
    expect(screen.getByTestId("app-intro-loop")).toBeTruthy();
    expect(screen.getByText(/Your videos play in 3D in full screen/)).toBeTruthy();
    expect(screen.getByText(/choose 3D side by side/)).toBeTruthy();
    expect(
      screen.getByText("Sign in with the same account you use in the Spatial Video Studio app."),
    ).toBeTruthy();

    const links = [...container.querySelectorAll("a")];
    const home = links.filter((a) => a.getAttribute("href") === "/");
    expect(home).toHaveLength(1);
    expect(home[0].textContent).toBe("Open the web app");
    expect(
      links.filter((a) => /^\/(pricing|plans|pro|pay)(\/|$|\?)/.test(a.getAttribute("href") ?? "")),
    ).toEqual([]);

    const text = container.textContent ?? "";
    expect(text).not.toContain("$");
    expect(text).not.toMatch(/subscription|\btier\b|\bcase\b/i);
  });

  it("the button's event carries the app's utm_content and utm_term", async () => {
    const track = vi.spyOn(analytics, "track").mockImplementation(() => {});
    window.history.replaceState(
      null,
      "",
      "/app?utm_source=spatial-video-studio-app&utm_medium=app&utm_campaign=cloud_to_web&utm_content=settings&utm_term=ios-10.6.0",
    );
    render(await AppIntroPage());
    fireEvent.click(screen.getByRole("link", { name: "Open the web app" }));
    expect(track).toHaveBeenCalledWith("app_intro_open_click", {
      utm_content: "settings",
      utm_term: "ios-10.6.0",
    });
  });

  it("leaves out utm values that aren't there", () => {
    expect(appIntroParams("")).toEqual({});
    expect(appIntroParams("?utm_content=whats_new")).toEqual({ utm_content: "whats_new" });
  });
});
