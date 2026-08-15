import { NextResponse } from "next/server";
import { getCallDiffDocument } from "@/lib/call-diff";
import { GitHubError } from "@/lib/github";
import { getGitHubAccessToken } from "@/lib/session";

// calldiff uses native Tree-sitter bindings and cannot run in the Edge runtime.
export const runtime = "nodejs";

// Vercel functions reserve writable storage for /tmp, while calldiff caches optional grammars on disk.
if (process.env.VERCEL && !process.env.CALLDIFF_GRAMMAR_CACHE) {
  process.env.CALLDIFF_GRAMMAR_CACHE = "/tmp/calldiff-grammars";
}

type RouteContext = {
  params: Promise<{ source: string[] }>;
};

/** Returns the lazy, bounded call-flow analysis while keeping any GitHub token on the server. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const [{ source }, accessToken] = await Promise.all([context.params, getGitHubAccessToken(request)]);

  try {
    const document = await getCallDiffDocument(source, accessToken);
    // Public revisions can share a brief edge cache, while private GitHub responses stay per-session.
    return NextResponse.json(document, accessToken ? undefined : {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" },
    });
  } catch (error) {
    const status = error instanceof GitHubError ? error.status : 500;
    const message = error instanceof Error ? error.message : "The call flow could not be loaded";
    return NextResponse.json({ error: message }, { status });
  }
}
