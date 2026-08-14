import { NextResponse } from "next/server";
import { getDiffResponse, GitHubError } from "@/lib/github";
import { getGitHubAccessToken } from "@/lib/session";

type RouteContext = {
  params: Promise<{ source: string[] }>;
};

/** Proxies a GitHub diff or repository snapshot while keeping private-repository tokens server-side. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const [{ source }, accessToken] = await Promise.all([context.params, getGitHubAccessToken(request)]);

  try {
    const response = await getDiffResponse(source, accessToken);
    if (accessToken) return response;

    const headers = new Headers(response.headers);
    // Public revisions can reuse the completed GitHub stream without sharing authenticated diffs.
    headers.set("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    return new Response(response.body, { headers });
  } catch (error) {
    const status = error instanceof GitHubError ? error.status : 500;
    const message = error instanceof Error ? error.message : "The diff could not be loaded";
    return NextResponse.json({ error: message }, { status });
  }
}
