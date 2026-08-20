import { NextResponse } from "next/server";
import { GitHubError, getPullRequestWorkspace, performPullRequestAction } from "@/lib/github";
import { isNumber, isRecord, isString, type JsonValue } from "@/lib/json";
import { isSameOrigin } from "@/lib/openai-auth";
import { getGitHubAccessToken } from "@/lib/session";
import type { PullRequestAction } from "@/types/github";

type RouteContext = {
  params: Promise<{ source: string[] }>;
};

/** Validates the small, explicit mutation payload accepted by the pull-request action route. */
function parsePullRequestAction(value: JsonValue): PullRequestAction | null {
  if (!isRecord(value) || !isString(value.action)) return null;

  if (value.action === "comment" && isString(value.body)) {
    return { action: "comment", body: value.body };
  }

  if (value.action === "reply" && isString(value.body) && isNumber(value.commentId)) {
    return { action: "reply", body: value.body, commentId: value.commentId };
  }

  if (value.action === "close") return { action: "close" };

  if (value.action === "edit-title" && isString(value.title)) {
    return { action: "edit-title", title: value.title };
  }

  if (value.action === "rename-branch" && isString(value.name)) {
    return { action: "rename-branch", name: value.name };
  }

  if (value.action === "edit-body" && isString(value.body)) {
    return { action: "edit-body", body: value.body };
  }

  if (value.action === "ready") return { action: "ready" };

  if (
    value.action === "review"
    && isString(value.body)
    && (value.event === "APPROVE" || value.event === "COMMENT" || value.event === "REQUEST_CHANGES")
  ) {
    return { action: "review", body: value.body, event: value.event };
  }

  if (value.action === "resolve-thread" && isString(value.threadId)) {
    return { action: "resolve-thread", threadId: value.threadId };
  }

  if (value.action === "unresolve-thread" && isString(value.threadId)) {
    return { action: "unresolve-thread", threadId: value.threadId };
  }

  if (value.action === "merge" && (value.method === "merge" || value.method === "rebase" || value.method === "squash")) {
    return { action: "merge", method: value.method };
  }

  return null;
}

/** Returns the current GitHub-backed PR conversation without mutating it. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const [{ source }, accessToken] = await Promise.all([context.params, getGitHubAccessToken(request)]);

  try {
    return NextResponse.json({ workspace: await getPullRequestWorkspace(source, accessToken) });
  } catch (error) {
    const status = error instanceof GitHubError ? error.status : 500;
    const message = error instanceof Error ? error.message : "The pull request could not be loaded";
    return NextResponse.json({ error: message }, { status });
  }
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
