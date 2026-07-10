import "server-only";

import { cookies } from "next/headers";
import { isRecord, type JsonRecord } from "@/lib/json";
import type { OpenAIDeviceCode } from "@/types/openai";

const CLIENT_ID = process.env.OPENAI_OAUTH_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = (process.env.OPENAI_OAUTH_ISSUER ?? "https://auth.openai.com").replace(/\/$/, "");
export const OPENAI_SESSION_COOKIE = "diffs-openai-session";
export const OPENAI_DEVICE_COOKIE = "diffs-openai-device";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const DEVICE_MAX_AGE = 15 * 60;
const COOKIE_OPTIONS = {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
} as const;

type StoredOpenAISession = {
  accountId: string;
  refreshToken: string;
  version: 1;
};

type StoredDeviceSession = {
  deviceAuthId: string;
  expiresAt: number;
  interval: number;
  userCode: string;
  version: 1;
};

type TokenPayload = {
  access_token?: unknown;
  id_token?: unknown;
  refresh_token?: unknown;
};

type OpenAIAccess = {
  accessToken: string;
  session: StoredOpenAISession;
};

type OpenAIDeviceAuthorization = OpenAIDeviceCode & { sealedSession: string };

type OpenAIDevicePoll =
  | { pending: true }
  | { pending: false; sealedSession: string };

/** Sends JSON to one OpenAI endpoint with the shared request policy. */
function postJson(path: string, body: JsonRecord, signal?: AbortSignal): Promise<Response> {
  return fetch(`${ISSUER}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

/** Converts bytes into the URL-safe encoding used by sealed cookies. */
function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

/** Converts a URL-safe string back into bytes. */
function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(value, "base64url");
  const copy = new Uint8Array(decoded.length);
  copy.set(decoded);
  return copy;
}

/** Derives one AES key from the application's existing Auth.js secret. */
async function getEncryptionKey(): Promise<CryptoKey> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required for OpenAI sign-in.");

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypts authenticated session data before it is stored in a cookie. */
async function seal(value: JsonRecord): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await getEncryptionKey(), plaintext);
  return `${encodeBase64Url(iv)}.${encodeBase64Url(new Uint8Array(ciphertext))}`;
}

/** Decrypts a sealed cookie and rejects altered or malformed values. */
async function unseal(value: string | undefined): Promise<JsonRecord | undefined> {
  if (!value) return undefined;

  try {
    const [encodedIv, encodedCiphertext] = value.split(".");
    if (!encodedIv || !encodedCiphertext) return undefined;

    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decodeBase64Url(encodedIv) },
      await getEncryptionKey(),
      decodeBase64Url(encodedCiphertext),
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Reads unverified claims from a token received directly from OpenAI over TLS. */
function parseJwtClaims(token: string): JsonRecord | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Extracts the ChatGPT workspace account id carried by OpenAI's ID token. */
function getAccountId(claims: JsonRecord): string | undefined {
  const auth = claims["https://api.openai.com/auth"];
  if (!isRecord(auth)) return undefined;
  return typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
}

/** Validates the token response and builds the minimal encrypted session. */
function sessionFromTokens(payload: TokenPayload, fallbackSession?: StoredOpenAISession): OpenAIAccess {
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  const idToken = typeof payload.id_token === "string" ? payload.id_token : "";
  const refreshToken = typeof payload.refresh_token === "string"
    ? payload.refresh_token
    : fallbackSession?.refreshToken;
  const claims = parseJwtClaims(idToken);
  const accountId = (claims ? getAccountId(claims) : undefined) ?? fallbackSession?.accountId;

  if (!accessToken || !refreshToken || !accountId) {
    throw new Error("OpenAI returned an incomplete authorization session.");
  }

  return {
    accessToken,
    session: {
      accountId,
      refreshToken,
      version: 1,
    },
  };
}

/** Parses and validates the encrypted long-lived OpenAI session. */
async function readStoredSession(): Promise<StoredOpenAISession | undefined> {
  const store = await cookies();
  const session = await unseal(store.get(OPENAI_SESSION_COOKIE)?.value);
  if (
    session?.version !== 1 ||
    typeof session.accountId !== "string" ||
    typeof session.refreshToken !== "string"
  ) return undefined;

  return {
    accountId: session.accountId,
    refreshToken: session.refreshToken,
    version: 1,
  };
}

/** Parses and validates the encrypted short-lived device authorization state. */
async function readStoredDevice(): Promise<StoredDeviceSession | undefined> {
  const store = await cookies();
  const session = await unseal(store.get(OPENAI_DEVICE_COOKIE)?.value);
  if (
    session?.version !== 1 ||
    typeof session.deviceAuthId !== "string" ||
    typeof session.userCode !== "string" ||
    typeof session.interval !== "number" ||
    typeof session.expiresAt !== "number" ||
    session.expiresAt <= Date.now()
  ) return undefined;

  return {
    deviceAuthId: session.deviceAuthId,
    expiresAt: session.expiresAt,
    interval: session.interval,
    userCode: session.userCode,
    version: 1,
  };
}

/** Starts OpenAI's short-lived device authorization flow. */
export async function startOpenAIDeviceCode(): Promise<OpenAIDeviceAuthorization> {
  const response = await postJson("/api/accounts/deviceauth/usercode", { client_id: CLIENT_ID });

  if (!response.ok) throw new Error(`OpenAI device authorization failed (${response.status}).`);

  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error("OpenAI returned an invalid device authorization response.");

  const deviceAuthId = typeof payload.device_auth_id === "string" ? payload.device_auth_id : "";
  const userCode = typeof payload.user_code === "string"
    ? payload.user_code
    : typeof payload.usercode === "string" ? payload.usercode : "";
  const parsedInterval = typeof payload.interval === "string" ? Number(payload.interval) : payload.interval;
  const interval = typeof parsedInterval === "number" && Number.isFinite(parsedInterval)
    ? Math.max(2, parsedInterval)
    : 5;

  if (!deviceAuthId || !userCode) throw new Error("OpenAI did not return a device code.");

  const sealedSession = await seal({
    deviceAuthId,
    expiresAt: Date.now() + DEVICE_MAX_AGE * 1_000,
    interval,
    userCode,
    version: 1,
  });

  return {
    interval,
    sealedSession,
    userCode,
    verificationUrl: `${ISSUER}/codex/device`,
  };
}

/** Polls once for device approval and exchanges an approved code for tokens. */
export async function pollOpenAIDeviceCode(): Promise<OpenAIDevicePoll> {
  const device = await readStoredDevice();
  if (!device) throw new Error("This OpenAI sign-in request expired. Start again.");

  const pollResponse = await postJson("/api/accounts/deviceauth/token", {
    device_auth_id: device.deviceAuthId,
    user_code: device.userCode,
  });

  if (pollResponse.status === 403 || pollResponse.status === 404) return { pending: true };
  if (!pollResponse.ok) throw new Error(`OpenAI sign-in failed (${pollResponse.status}).`);

  const approval: unknown = await pollResponse.json();
  if (!isRecord(approval)) throw new Error("OpenAI returned an invalid approval response.");

  const authorizationCode = typeof approval.authorization_code === "string" ? approval.authorization_code : "";
  const codeVerifier = typeof approval.code_verifier === "string" ? approval.code_verifier : "";
  if (!authorizationCode || !codeVerifier) throw new Error("OpenAI returned an incomplete approval response.");

  const tokenResponse = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: `${ISSUER}/deviceauth/callback`,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenResponse.ok) throw new Error(`OpenAI token exchange failed (${tokenResponse.status}).`);

  const access = sessionFromTokens(await tokenResponse.json() as TokenPayload);
  const sealedSession = await seal(access.session);

  return {
    pending: false,
    sealedSession,
  };
}

/** Returns the public connection status without exposing any credential material. */
export async function isOpenAIConnected(): Promise<boolean> {
  return Boolean(await readStoredSession());
}

/** Refreshes the current OpenAI session and returns a short-lived access token. */
export async function getOpenAIAccess(): Promise<OpenAIAccess | undefined> {
  const session = await readStoredSession();
  if (!session) return undefined;

  const response = await postJson("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: CLIENT_ID,
    scope: "openid profile email offline_access",
  });

  if (response.status >= 500) throw new Error(`OpenAI token refresh failed (${response.status}).`);
  if (!response.ok) return undefined;
  const access = sessionFromTokens(await response.json() as TokenPayload, session);
  const store = await cookies();
  // Persist rotation at the refresh boundary so later repository or model failures cannot lose it.
  store.set(openAISessionCookie(await seal(access.session)));
  return access;
}

/** Best-effort revokes the refresh token before local logout. */
export async function revokeOpenAISession(): Promise<void> {
  const session = await readStoredSession();
  if (!session) return;

  try {
    await postJson("/oauth/revoke", {
      token: session.refreshToken,
      token_type_hint: "refresh_token",
      client_id: CLIENT_ID,
    }, AbortSignal.timeout(5_000));
  } catch {
    // Local logout must still succeed when OpenAI is temporarily unreachable.
  }
}

/** Verifies that a state-changing API request came from this same web origin. */
export function isSameOrigin(request: Request): boolean {
  return request.headers.get("origin") === new URL(request.url).origin;
}

/** Builds one encrypted OpenAI cookie with the shared security policy. */
function openAICookie(name: string, value: string, maxAge: number) {
  return { ...COOKIE_OPTIONS, name, value, maxAge };
}

/** Returns consistent secure options for the long-lived OpenAI session cookie. */
export function openAISessionCookie(value: string) {
  return openAICookie(OPENAI_SESSION_COOKIE, value, SESSION_MAX_AGE);
}

/** Returns consistent secure options for the temporary device-flow cookie. */
export function openAIDeviceCookie(value: string) {
  return openAICookie(OPENAI_DEVICE_COOKIE, value, DEVICE_MAX_AGE);
}
