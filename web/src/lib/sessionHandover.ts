/**
 * BL-34 gap 3: keep someone signed in when their browser moves to the cn.
 * route (the direct host stopped answering, or China mode by country or
 * pin) while the Firebase SDK holds their sign-in.
 *
 * The SDK user's refresh token goes to the gateway's /v1/auth/refresh on
 * the routed host (lib/gatewayAuth.ts gatewayAdoptRefreshToken); the
 * answer becomes the gateway session, stored exactly as an email-code
 * sign-in stores it, and the SDK is then signed out on this device only
 * (a local sign-out revokes nothing). A refresh that fails leaves things
 * as they were before BL-34: no session here, the email-code sign-in, and
 * the SDK's own sign-in untouched for when the direct host answers again.
 *
 * China mode never loads the SDK, so when this page hasn't loaded it the
 * user is read from where the SDK keeps it (IndexedDB, else localStorage;
 * the same record since SDK v9), and signing out removes that record.
 * Tokens are never logged; nothing is stored beyond the gateway session.
 */

import { firebaseConfig, loadedFirebaseAuth } from "@/lib/firebase";
import { gatewayAdoptRefreshToken, gatewaySession } from "@/lib/gatewayAuth";

export interface HandoverUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  refreshToken: string;
}

export interface HandoverDeps {
  /** The SDK's signed-in user, or null. */
  firebaseUser(): Promise<HandoverUser | null>;
  /** Signs the SDK out on this device. */
  signOutFirebase(): Promise<void>;
}

/**
 * - `kept`: a gateway session was already there (nothing done);
 * - `adopted`: the SDK's sign-in is now the gateway session;
 * - `none`: nobody signed in through the SDK;
 * - `failed`: the gateway refused the refresh or couldn't be reached.
 */
export type HandoverOutcome = "kept" | "adopted" | "none" | "failed";

let inflight: Promise<HandoverOutcome> | null = null;

/** Hands the SDK's sign-in over to the gateway session, once at a time. */
export function handOverFirebaseSession(
  deps: HandoverDeps = browserHandoverDeps,
): Promise<HandoverOutcome> {
  inflight ??= handOver(deps).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function handOver(deps: HandoverDeps): Promise<HandoverOutcome> {
  if (gatewaySession() !== null) return "kept";
  let user: HandoverUser | null;
  try {
    user = await deps.firebaseUser();
  } catch {
    user = null;
  }
  if (user === null || user.refreshToken === "") return "none";
  try {
    const session = await gatewayAdoptRefreshToken(user.refreshToken, user);
    if (session === null) return "kept";
  } catch {
    return "failed";
  }
  try {
    await deps.signOutFirebase();
  } catch {
    // the gateway session stands; the SDK's copy is simply left behind
  }
  return "adopted";
}

// ------------------------------------------------- the SDK's own record

const IDB_NAME = "firebaseLocalStorageDb";
const IDB_STORE = "firebaseLocalStorage";
const IDB_WAIT_MS = 2_000;

function userKey(): string {
  return `firebase:authUser:${firebaseConfig().apiKey}:[DEFAULT]`;
}

/** The user in the SDK's stored JSON (User.toJSON()). */
export function parseStoredUser(value: unknown): HandoverUser | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const sts = v.stsTokenManager as Record<string, unknown> | undefined;
  const refreshToken = sts?.refreshToken;
  if (typeof v.uid !== "string" || v.uid === "") return null;
  if (typeof refreshToken !== "string" || refreshToken === "") return null;
  return {
    uid: v.uid,
    email: typeof v.email === "string" ? v.email : null,
    displayName: typeof v.displayName === "string" ? v.displayName : null,
    refreshToken,
  };
}

/** Opens the SDK's database only when it exists (never creates it). */
function openSdkDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (db: IDBDatabase | null) => {
      if (done) {
        db?.close();
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve(db);
    };
    const timer = setTimeout(() => finish(null), IDB_WAIT_MS);
    try {
      if (typeof indexedDB === "undefined") return finish(null);
      const req = indexedDB.open(IDB_NAME);
      req.onupgradeneeded = () => {
        // it didn't exist: don't leave an empty one behind for the SDK
        req.transaction?.abort();
      };
      req.onsuccess = () => {
        const db = req.result;
        finish(db.objectStoreNames.contains(IDB_STORE) ? db : (db.close(), null));
      };
      req.onerror = () => finish(null);
      req.onblocked = () => finish(null);
    } catch {
      finish(null);
    }
  });
}

function idbRequest<T>(make: (store: IDBObjectStore) => IDBRequest<T>, db: IDBDatabase, mode: IDBTransactionMode): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const req = make(db.transaction(IDB_STORE, mode).objectStore(IDB_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readStoredUser(): Promise<HandoverUser | null> {
  const key = userKey();
  const db = await openSdkDatabase();
  if (db !== null) {
    try {
      const row = await idbRequest<{ value?: unknown } | undefined>((s) => s.get(key), db, "readonly");
      const user = parseStoredUser(row?.value);
      if (user !== null) return user;
    } finally {
      db.close();
    }
  }
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : parseStoredUser(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function removeStoredUser(): Promise<void> {
  const key = userKey();
  const db = await openSdkDatabase();
  if (db !== null) {
    try {
      await idbRequest((s) => s.delete(key), db, "readwrite");
    } finally {
      db.close();
    }
  }
  try {
    window.localStorage.removeItem(key);
  } catch {
    // storage blocked
  }
}

const browserHandoverDeps: HandoverDeps = {
  async firebaseUser() {
    const loaded = loadedFirebaseAuth();
    if (loaded !== null) {
      const u = (await loaded).currentUser;
      if (u !== null && u.refreshToken !== "") {
        return { uid: u.uid, email: u.email, displayName: u.displayName, refreshToken: u.refreshToken };
      }
    }
    // not loaded here (China mode), or still restoring its session
    return readStoredUser();
  },
  async signOutFirebase() {
    await removeStoredUser();
    const loaded = loadedFirebaseAuth();
    if (loaded === null) return;
    const auth = await loaded;
    const { signOut } = await import("firebase/auth");
    await signOut(auth);
  },
};
