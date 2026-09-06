/** Derives the key that protects GitHub credentials stored in an Eve session. */
async function getEncryptionKey(): Promise<CryptoKey> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required for GitHub repository access.");

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encodes bytes in the URL-safe form accepted by Eve's string-only session attributes. */
function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

/** Decodes one URL-safe session attribute segment into a copied byte array. */
function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(value, "base64url");
  const copy = new Uint8Array(decoded.length);
  copy.set(decoded);
  return copy;
}

/** Encrypts the short-lived GitHub token before Eve persists its session auth attributes. */
export async function sealGitHubAccessToken(accessToken: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(accessToken);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await getEncryptionKey(), plaintext);
  return `${encodeBase64Url(iv)}.${encodeBase64Url(new Uint8Array(ciphertext))}`;
}

/** Decrypts a session attribute and treats malformed or rotated credentials as unavailable. */
export async function unsealGitHubAccessToken(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;

  try {
    const [encodedIv, encodedCiphertext] = value.split(".");
    if (!encodedIv || !encodedCiphertext) return undefined;

    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decodeBase64Url(encodedIv) },
      await getEncryptionKey(),
      decodeBase64Url(encodedCiphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return undefined;
  }
}
