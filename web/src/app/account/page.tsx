import AccountScreen from "@/components/auth/AccountScreen";
import { RequireAuth } from "@/components/auth/RequireAuth";

export default function AccountPage() {
  return (
    <RequireAuth>
      <AccountScreen />
    </RequireAuth>
  );
}
