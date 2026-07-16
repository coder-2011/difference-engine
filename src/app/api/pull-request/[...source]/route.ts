import { NextResponse } from "next/server";
import { GitHubError, performPullRequestAction } from "@/lib/github";
import { isRecord } from "@/lib/json";
import { isSameOrigin } from "@/lib/openai-auth";
import { getGitHubAccessToken } from "@/lib/session";
import type { PullRequestAction, PullRequestMergeMethod } from "@/types/github";

type RouteContext = {
  params: Promise<{ source: string[] }>;
};

/** Validates the small, explicit mutation payload accepted by the pull-request action route. */
function parsePullRequestAction(value: unknown): PullRequestAction | null {
  if (!isRecord(value) || typeof value.action !== "string") return null;

  if (value.action === "comment" && typeof value.body === "string") {
    return { action: "comment", body: value.body };
  }

  if (value.action === "close") return { action: "close" };

  if (value.action === "ready") return { action: "ready" };

  if (value.action === "merge" && (value.method === "merge" || value.method === "rebase" || value.method === "squash")) {
    return { action: "merge", method: value.method as PullRequestMergeMethod };
  }

  return null;
}

/** Proxies one validated PR mutation to GitHub and returns the refreshed canonical workspace. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });

  const [body, { source }, accessToken] = await Promise.all([
    request.json().catch(() => null),
    context.params,
    getGitHubAccessToken(request),
  ]);
  const action = parsePullRequestAction(body);

  if (!action) return NextResponse.json({ error: "Invalid pull request action" }, { status: 400 });

  try {
    return NextResponse.json(await performPullRequestAction(source, accessToken, action));
  } catch (error) {
    const status = error instanceof GitHubError ? error.status : 500;
    const message = error instanceof Error ? error.message : "GitHub could not complete this action";
    return NextResponse.json({ error: message }, { status });
  }
}
