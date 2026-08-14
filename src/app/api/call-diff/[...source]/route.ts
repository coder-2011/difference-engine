import { NextResponse } from "next/server";
import { getCallDiffDocument } from "@/lib/call-diff";
import { GitHubError } from "@/lib/github";
import { getGitHubAccessToken } from "@/lib/session";

type RouteContext = {
  params: Promise<{ source: string[] }>;
};

/** Returns the lazy, bounded call-flow analysis while keeping any GitHub token on the server. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const [{ source }, accessToken] = await Promise.all([context.params, getGitHubAccessToken(request)]);

  try {
    return NextResponse.json(await getCallDiffDocument(source, accessToken));
  } catch (error) {
    const status = error instanceof GitHubError ? error.status : 500;
    const message = error instanceof Error ? error.message : "The call flow could not be loaded";
    return NextResponse.json({ error: message }, { status });
  }
}
