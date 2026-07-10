import "server-only";

import { cookies } from "next/headers";

const CLIENT_ID = process.env.OPENAI_OAUTH_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = (process.env.OPENAI_OAUTH_ISSUER ?? "https://auth.openai.com").replace(/\/$/, "");
const SESSION_COOKIE = "diffs-openai-session";
const DEVICE_COOKIE = "diffs-openai-device";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const DEVICE_MAX_AGE = 15 * 60;

type JsonRecord = Record<string, unknown>;

type StoredOpenAISession = {
  accountId: string;
  email?: string;
  name?: string;
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

export type OpenAIConnection = {
  connected: boolean;
  email?: string;
  name?: string;
};

export type OpenAIAccess = {
  accessToken: string;
  session: StoredOpenAISession;
};

export type OpenAIDeviceCode = {
  interval: number;
  sealedSession: string;
  userCode: string;
  verificationUrl: string;
};

export type OpenAIDevicePoll =
  | { pending: true }
  | { pending: false; sealedSession: string; connection: OpenAIConnection };

/** Returns true only for non-array objects. */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
function sessionFromTokens(payload: TokenPayload, fallbackRefreshToken?: string): OpenAIAccess {
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  const idToken = typeof payload.id_token === "string" ? payload.id_token : "";
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : fallbackRefreshToken;
  const claims = parseJwtClaims(idToken);
  const accountId = claims ? getAccountId(claims) : undefined;

  if (!accessToken || !refreshToken || !accountId) {
    throw new Error("OpenAI returned an incomplete authorization session.");
  }

  return {
    accessToken,
    session: {
      accountId,
      email: claims && typeof claims.email === "string" ? claims.email : undefined,
      name: claims && typeof claims.name === "string" ? claims.name : undefined,
      refreshToken,
      version: 1,
    },
  };
}

/** Parses and validates the encrypted long-lived OpenAI session. */
async function readStoredSession(value: string | undefined): Promise<StoredOpenAISession | undefined> {
  const session = await unseal(value);
  if (
    session?.version !== 1 ||
    typeof session.accountId !== "string" ||
    typeof session.refreshToken !== "string"
  ) return undefined;

  return {
    accountId: session.accountId,
    email: typeof session.email === "string" ? session.email : undefined,
    name: typeof session.name === "string" ? session.name : undefined,
    refreshToken: session.refreshToken,
    version: 1,
  };
}

/** Parses and validates the encrypted short-lived device authorization state. */
async function readStoredDevice(value: string | undefined): Promise<StoredDeviceSession | undefined> {
  const session = await unseal(value);
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
export async function startOpenAIDeviceCode(): Promise<OpenAIDeviceCode> {
  const response = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    cache: "no-store",
  });

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
export async function pollOpenAIDeviceCode(cookieValue: string | undefined): Promise<OpenAIDevicePoll> {
  const device = await readStoredDevice(cookieValue);
  if (!device) throw new Error("This OpenAI sign-in request expired. Start again.");

  const pollResponse = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
    cache: "no-store",
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
    cache: "no-store",
  });

  if (!tokenResponse.ok) throw new Error(`OpenAI token exchange failed (${tokenResponse.status}).`);

  const access = sessionFromTokens(await tokenResponse.json() as TokenPayload);
  const sealedSession = await seal(access.session);

  return {
    pending: false,
    sealedSession,
    connection: {
      connected: true,
      email: access.session.email,
      name: access.session.name,
    },
  };
}

/** Returns the public connection status without exposing any credential material. */
export async function getOpenAIConnection(): Promise<OpenAIConnection> {
  const store = await cookies();
  const session = await readStoredSession(store.get(SESSION_COOKIE)?.value);
  return session
    ? { connected: true, email: session.email, name: session.name }
    : { connected: false };
}

/** Refreshes the current OpenAI session and returns a short-lived access token. */
export async function getOpenAIAccess(): Promise<OpenAIAccess | undefined> {
  const store = await cookies();
  const session = await readStoredSession(store.get(SESSION_COOKIE)?.value);
  if (!session) return undefined;

  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: CLIENT_ID,
      scope: "openid profile email offline_access",
    }),
    cache: "no-store",
  });

  if (response.status >= 500) throw new Error(`OpenAI token refresh failed (${response.status}).`);
  if (!response.ok) return undefined;
  return sessionFromTokens(await response.json() as TokenPayload, session.refreshToken);
}

/** Best-effort revokes the refresh token before local logout. */
export async function revokeOpenAISession(): Promise<void> {
  const store = await cookies();
  const session = await readStoredSession(store.get(SESSION_COOKIE)?.value);
  if (!session) return;

  try {
    await fetch(`${ISSUER}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: session.refreshToken,
        token_type_hint: "refresh_token",
        client_id: CLIENT_ID,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Local logout must still succeed when OpenAI is temporarily unreachable.
  }
}

/** Encrypts a refreshed session for the response cookie. */
export async function sealOpenAISession(session: StoredOpenAISession): Promise<string> {
  return seal(session);
}

/** Verifies that a state-changing API request came from this same web origin. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return Boolean(origin && origin === new URL(request.url).origin);
}

/** Returns consistent secure options for the long-lived OpenAI session cookie. */
export function openAISessionCookie(value: string) {
  return {
    name: SESSION_COOKIE,
    value,
    httpOnly: true,
    maxAge: SESSION_MAX_AGE,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}

/** Returns consistent secure options for the temporary device-flow cookie. */
export function openAIDeviceCookie(value: string) {
  return {
    name: DEVICE_COOKIE,
    value,
    httpOnly: true,
    maxAge: DEVICE_MAX_AGE,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}

/** Returns the temporary device cookie name for route-level reads and deletion. */
export function openAIDeviceCookieName(): string {
  return DEVICE_COOKIE;
}

/** Returns the session cookie name for route-level deletion. */
export function openAISessionCookieName(): string {
  return SESSION_COOKIE;
}
