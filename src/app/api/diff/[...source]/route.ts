import { NextResponse } from "next/server";
import { getDiffResponse, getPullRequestRevision, GitHubError } from "@/lib/github";
import { getGitHubAccessToken } from "@/lib/session";

type RouteContext = {
  params: Promise<{ source: string[] }>;
};

/** Proxies a GitHub diff or repository snapshot while keeping private-repository tokens server-side. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const [{ source }, accessToken] = await Promise.all([context.params, getGitHubAccessToken(request)]);

  let preloaded: Response | undefined;
  try {
    if (source[2] === "pull" && new URL(request.url).searchParams.get("preload") === "1") {
      const before = await getPullRequestRevision(source, accessToken);
      preloaded = await getDiffResponse(source, accessToken);
      const after = await getPullRequestRevision(source, accessToken);
      if (before !== after || request.signal.aborted) {
        void preloaded.body?.cancel().catch(() => {});
        return new Response(null, { status: 409 });
      }
      preloaded.headers.set("X-Diff-Revision", before);
      return preloaded;
    }
    return await getDiffResponse(source, accessToken, request.headers.get("if-none-match") ?? undefined);
  } catch (error) {
    void preloaded?.body?.cancel().catch(() => {});
    const status = error instanceof GitHubError ? error.status : 500;
    const message = error instanceof Error ? error.message : "The diff could not be loaded";
    return NextResponse.json({ error: message }, { status });
  }
}
