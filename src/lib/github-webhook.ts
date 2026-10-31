import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Verifies GitHub's signature against the exact bytes received from the webhook. */
export function validGitHubWebhookSignature(body: Uint8Array, signature: string | null, secret: string): boolean {
  if (!secret || !signature || !/^sha256=[a-f\d]{64}$/i.test(signature)) return false;
  const actual = Buffer.from(signature.slice(7), "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(actual, expected);
}

/** Gives each repository an opaque, case-insensitive private notification channel. */
export function repositoryNotificationChannel(owner: string, repository: string): string {
  const identity = `${owner.toLowerCase()}/${repository.toLowerCase()}`;
  return `private-diffs-${createHash("sha256").update(identity).digest("hex")}`;
}

const REPOSITORY_NAME = /^[a-z\d](?:[a-z\d-]{0,38})$/i;
const REPOSITORY_PART = /^[a-z\d_.-]{1,100}$/i;

/** Accepts only canonical repository names that can be safely mapped to a channel. */
export function webhookRepository(value: unknown): { owner: string; repository: string } | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split("/");
  if (parts.length !== 2 || !REPOSITORY_NAME.test(parts[0]) || !REPOSITORY_PART.test(parts[1]) || parts[1] === "." || parts[1] === "..") return undefined;
  return { owner: parts[0], repository: parts[1] };
}
