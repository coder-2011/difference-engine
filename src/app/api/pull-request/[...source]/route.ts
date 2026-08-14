import { NextResponse } from "next/server";
import { GitHubError, performPullRequestAction } from "@/lib/github";
import { isRecord } from "@/lib/json";
import { isSameOrigin } from "@/lib/openai-auth";
import { getGitHubAccessToken } from "@/lib/session";
import type { PullRequestAction, PullRequestMergeMethod, PullRequestReviewEvent } from "@/types/github";

type RouteContext = {
  params: Promise<{ source: string[] }>;
};

/** Validates the small, explicit mutation payload accepted by the pull-request action route. */
function parsePullRequestAction(value: unknown): PullRequestAction | null {
  if (!isRecord(value) || typeof value.action !== "string") return null;

  if (value.action === "comment" && typeof value.body === "string") {
    return { action: "comment", body: value.body };
  }

  if (value.action === "reply" && typeof value.body === "string" && typeof value.commentId === "number") {
    return { action: "reply", body: value.body, commentId: value.commentId };
  }

  if (value.action === "close") return { action: "close" };

  if (value.action === "edit-title" && typeof value.title === "string") {
    return { action: "edit-title", title: value.title };
  }

  if (value.action === "edit-body" && typeof value.body === "string") {
    return { action: "edit-body", body: value.body };
  }

  if (value.action === "ready") return { action: "ready" };

  if (
    value.action === "review"
    && typeof value.body === "string"
    && (value.event === "APPROVE" || value.event === "COMMENT" || value.event === "REQUEST_CHANGES")
  ) {
    return { action: "review", body: value.body, event: value.event as PullRequestReviewEvent };
  }

  if (value.action === "resolve-thread" && typeof value.threadId === "string") {
    return { action: "resolve-thread", threadId: value.threadId };
  }

  if (value.action === "unresolve-thread" && typeof value.threadId === "string") {
    return { action: "unresolve-thread", threadId: value.threadId };
  }

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
