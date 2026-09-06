import { getToken } from "next-auth/jwt";

type GitHubSession = {
  accessToken: string;
  userId: string;
};

/** Decrypts the current Auth.js request cookie for Eve's authenticated channel. */
export async function getGitHubSession(request: Request): Promise<GitHubSession | undefined> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return undefined;

  const token = await getToken({
    req: { headers: request.headers },
    secret,
    secureCookie: process.env.NODE_ENV === "production",
  });
  const accessToken = typeof token?.accessToken === "string" ? token.accessToken : undefined;
  const userId = typeof token?.sub === "string" ? token.sub : undefined;

  return accessToken && userId ? { accessToken, userId } : undefined;
}
