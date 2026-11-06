/**
 * /reset-password: old password-reset mails still land somewhere useful
 * (owner 2026-11-06: the web signs in by email code only; an account that
 * had a password signs in by code to the same account). A permanent
 * redirect to /signin, without the mail's ?oob= code.
 */

import { permanentRedirect } from "next/navigation";

export default function ResetPasswordRedirect(): never {
  permanentRedirect("/signin");
}
