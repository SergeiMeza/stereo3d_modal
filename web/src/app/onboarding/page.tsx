import { redirect } from "next/navigation";

// spec v6 G: the onboarding wall is gone; old links land on Billing
export default function OnboardingPage(): never {
  redirect("/account/billing");
}
