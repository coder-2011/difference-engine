import { NextResponse } from "next/server";
import { listOpenPullRequestPage } from "@/lib/github";
import { getGitHubAccessToken } from "@/lib/session";

/** Returns the next small page of the signed-in user's open pull request inbox. */
export async function GET(request: Request): Promise<Response> {
  const accessToken = await getGitHubAccessToken(request);
  if (!accessToken) return NextResponse.json({ error: "Sign in to load more pull requests" }, { status: 401 });

  const after = new URL(request.url).searchParams.get("after");
  if (after && after.length > 1_024) {
    return NextResponse.json({ error: "The pull request cursor is invalid" }, { status: 400 });
  }

  try {
    const page = await listOpenPullRequestPage(accessToken, after);
    return NextResponse.json(page, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Pull requests could not be loaded" }, { status: 502 });
  }
}
