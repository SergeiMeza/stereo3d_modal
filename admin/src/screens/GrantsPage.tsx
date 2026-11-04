import { useState } from "react";

import { PageHeader, Panel } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Field, FieldControl, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { paths, useRouter } from "@/lib/router";

/**
 * Grants (Money): Pro, Business or Studio given by us. Grants are made and
 * revoked on an account (gateway 00106); the gateway has no list of every
 * grant yet, so this page opens the account to grant on.
 */
export function GrantsPage() {
  const { navigate } = useRouter();
  const [uid, setUid] = useState("");
  return (
    <>
      <PageHeader title="Grants">
        <span className="text-sm text-muted-foreground">Pro, Business or Studio given by us, until a date, with a reason</span>
      </PageHeader>
      <Panel title="Grant or revoke on an account">
        <form
          className="flex flex-wrap items-end gap-2 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (uid.trim()) navigate(paths.account(uid.trim()));
          }}
        >
          <Field className="max-w-90">
            <FieldLabel>Firebase UID</FieldLabel>
            <FieldControl>
              <Input value={uid} onChange={(e) => setUid(e.target.value)} />
            </FieldControl>
            <FieldDescription>Or press ⌘K and search for the case or the account.</FieldDescription>
          </Field>
          <Button type="submit" variant="default" disabled={!uid.trim()}>
            Open the account
          </Button>
        </form>
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
          The account page lists its grants and promotional re-grants, with Grant, Revoke and Restore. A list of every grant
          across accounts needs a gateway endpoint that doesn't exist yet.
        </p>
      </Panel>
    </>
  );
}
