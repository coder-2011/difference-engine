import { NextResponse } from "next/server";
import { getDiffResponse, GitHubError } from "@/lib/github";
import { getGitHubAccessToken } from "@/lib/session";

type RouteContext = {
  params: Promise<{ source: string[] }>;
};

/** Proxies GitHub's raw diff stream while keeping private-repository tokens server-side. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const [{ source }, accessToken] = await Promise.all([context.params, getGitHubAccessToken(request)]);

  try {
    return await getDiffResponse(source, accessToken);
  } catch (error) {
    const status = error instanceof GitHubError ? error.status : 500;
    const message = error instanceof Error ? error.message : "The diff could not be loaded";
    return NextResponse.json({ error: message }, { status });
  }
}
