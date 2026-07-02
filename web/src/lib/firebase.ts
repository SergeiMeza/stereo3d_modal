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
 * another project. Analytics is deliberately not wired (measurementId is
 * carried but unused) to keep the bundle lean.
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
  measurementId: "G-JSPE16JSLY",
} as const;

export function firebaseConfig() {
  return {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? DEFAULT_CONFIG.apiKey,
    authDomain:
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? DEFAULT_CONFIG.authDomain,
    projectId:
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? DEFAULT_CONFIG.projectId,
    storageBucket:
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ??
      DEFAULT_CONFIG.storageBucket,
    messagingSenderId:
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ??
      DEFAULT_CONFIG.messagingSenderId,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? DEFAULT_CONFIG.appId,
    measurementId:
      process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID ??
      DEFAULT_CONFIG.measurementId,
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

export function getFirebaseAuth(): Promise<Auth> {
  authPromise ??= (async () => {
    const app = await getFirebaseApp();
    const { getAuth } = await import("firebase/auth");
    return getAuth(app);
  })();
  return authPromise;
}
