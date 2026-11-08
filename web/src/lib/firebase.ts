/**
 * Lazy Firebase bootstrap. The SDK is only ever loaded via dynamic import
 * from here, so mock-mode builds and tests never pull firebase into the
 * bundle — callers must go through these promises, never import
 * "firebase/app" or "firebase/auth" statically (types are fine).
 *
 * The spatial-video-studio web config is hardcoded as the default: it is
 * public by design (Firebase web configs are not secrets) and hardcoding
 * keeps Vercel setup to a single env (NEXT_PUBLIC_AUTH_MODE=firebase).
 * NEXT_PUBLIC_FIREBASE_* envs override individual fields when pointing at
 * another project. No Google/Firebase Analytics (owner 2026-11-04): only
 * authentication is loaded here.
 */

import type { FirebaseApp } from "firebase/app";
import type { Auth } from "firebase/auth";

const DEFAULT_CONFIG = {
  apiKey: "AIzaSyCZcwCfTeRhsLjmPHXUPMEU7xNUserJESQ",
  authDomain: "spatial-video-studio.firebaseapp.com",
  projectId: "spatial-video-studio",
  storageBucket: "spatial-video-studio.firebasestorage.app",
  messagingSenderId: "151335782809",
  appId: "1:151335782809:web:3bc67dc51717ad72a76b08",
} as const;

/** NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN, or "self": this site's own host, whose
 * /__/auth/* next.config.ts proxies to the Firebase handler (BL-15). */
function authDomain(): string {
  const v = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
  if (v === "self") {
    return typeof window !== "undefined"
      ? window.location.host
      : DEFAULT_CONFIG.authDomain;
  }
  return v ?? DEFAULT_CONFIG.authDomain;
}

export function firebaseConfig() {
  return {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? DEFAULT_CONFIG.apiKey,
    authDomain: authDomain(),
    projectId:
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? DEFAULT_CONFIG.projectId,
    storageBucket:
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ??
      DEFAULT_CONFIG.storageBucket,
    messagingSenderId:
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ??
      DEFAULT_CONFIG.messagingSenderId,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? DEFAULT_CONFIG.appId,
  };
}

let appPromise: Promise<FirebaseApp> | null = null;

export function getFirebaseApp(): Promise<FirebaseApp> {
  appPromise ??= (async () => {
    const { getApp, getApps, initializeApp } = await import("firebase/app");
    return getApps().length > 0 ? getApp() : initializeApp(firebaseConfig());
  })();
  return appPromise;
}

let authPromise: Promise<Auth> | null = null;

/** The Auth instance when this page already loaded the SDK, else null:
 * never loads it (China mode keeps the SDK out, lib/sessionHandover.ts). */
export function loadedFirebaseAuth(): Promise<Auth> | null {
  return authPromise;
}

/** Owner bug 2026-11-05: the persistence and the popup/redirect resolver
 * spelled out (what getAuth picks in a browser), so a redirect's answer
 * survives Safari's storage rules: IndexedDB first, then localStorage. */
export function getFirebaseAuth(): Promise<Auth> {
  authPromise ??= (async () => {
    const app = await getFirebaseApp();
    const {
      browserLocalPersistence,
      browserPopupRedirectResolver,
      getAuth,
      indexedDBLocalPersistence,
      initializeAuth,
    } = await import("firebase/auth");
    try {
      return initializeAuth(app, {
        persistence: [indexedDBLocalPersistence, browserLocalPersistence],
        popupRedirectResolver: browserPopupRedirectResolver,
      });
    } catch {
      // already initialized (a hot reload): the same instance
      return getAuth(app);
    }
  })();
  return authPromise;
}
