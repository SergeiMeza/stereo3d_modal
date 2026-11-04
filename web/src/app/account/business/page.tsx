import { RequireAuth } from "@/components/auth/RequireAuth";
import { BusinessSetup } from "@/components/business/BusinessSetup";

export const metadata = { title: "Set up Business or Studio · Spatial Video Studio" };

export default function BusinessSetupPage() {
  return (
    <RequireAuth>
      <BusinessSetup />
    </RequireAuth>
  );
}
