/**
 * The console's Content Security Policy (spec M1), built from the gateway
 * origin so connect-src names exactly one gateway.
 *
 * Beyond the spec's `default-src 'self'; script-src 'self'; connect-src
 * <gateway>; img-src 'self' data:; frame-ancestors 'none'`, Firebase Auth's
 * Google popup needs:
 * - script-src https://apis.google.com (the SDK loads gapi for the popup);
 * - frame-src the Firebase auth domain (its hidden /__/auth/iframe);
 * - connect-src identitytoolkit and securetoken (sign-in and token refresh).
 */

export const FIREBASE_AUTH_DOMAIN = "spatial-video-studio.firebaseapp.com";

export function gatewayOrigin(url: string): string {
  return new URL(url).origin;
}

export interface CspOptions {
  gateways: string[];
  /** frame-ancestors only works as a header, never in a meta tag. */
  forHeader: boolean;
}

export function buildCsp({ gateways, forHeader }: CspOptions): string {
  const connect = [
    "'self'",
    ...gateways.map(gatewayOrigin),
    "https://identitytoolkit.googleapis.com",
    "https://securetoken.googleapis.com",
  ];
  const parts = [
    "default-src 'self'",
    "script-src 'self' https://apis.google.com",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect.join(" ")}`,
    `frame-src https://${FIREBASE_AUTH_DOMAIN} https://accounts.google.com`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  if (forHeader) parts.push("frame-ancestors 'none'");
  return parts.join("; ");
}
