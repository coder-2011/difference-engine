import { isRecord, isString, type JsonRecord } from "@/lib/json";

type OpenAIAccessCredential = {
  accessToken: string;
  accountId: string;
};

/** Converts bytes into the URL-safe representation used by the temporary browser credential. */
function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

/** Restores a copied byte array from one URL-safe credential segment. */
function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(value, "base64url");
  const copy = new Uint8Array(decoded.length);
  copy.set(decoded);
  return copy;
}

/** Derives the application key that keeps the browser-forwarded Eve credential opaque. */
async function getEncryptionKey(): Promise<CryptoKey> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required for OpenAI sign-in.");

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypts a short-lived OpenAI access credential before it passes through the browser. */
async function seal(value: JsonRecord): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await getEncryptionKey(), plaintext);
  return `${encodeBase64Url(iv)}.${encodeBase64Url(new Uint8Array(ciphertext))}`;
}

/** Decrypts one credential envelope and rejects altered or malformed values. */
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

/** Encrypts the refreshed OpenAI access token and account id for one Eve request. */
export async function sealEveOpenAIAccess(accessToken: string, accountId: string): Promise<string> {
  return seal({ accessToken, accountId });
}

/** Reads an opaque Eve credential without exposing its OpenAI token to the model. */
export async function unsealEveOpenAIAccess(value: string | undefined): Promise<OpenAIAccessCredential | undefined> {
  const credential = await unseal(value);
  if (!credential || !isString(credential.accessToken) || !isString(credential.accountId)) return undefined;

  return { accessToken: credential.accessToken, accountId: credential.accountId };
}
