import "server-only";
import { headers } from "next/headers";
import { getToken } from "next-auth/jwt";

/** Decrypts only the current request's Auth.js token on the server. */
export async function getGitHubAccessToken(request?: Request): Promise<string | undefined> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return undefined;

  const requestHeaders = request?.headers ?? new Headers(await headers());
  const token = await getToken({
    req: { headers: requestHeaders },
    secret,
    secureCookie: process.env.NODE_ENV === "production",
  });

  return typeof token?.accessToken === "string" ? token.accessToken : undefined;
}
