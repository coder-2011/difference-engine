import { NextResponse } from "next/server";
import { GitHubError, postPullRequestAgentComment } from "@/lib/github";
import { isRecord } from "@/lib/json";
import { isSameOrigin } from "@/lib/openai-auth";
import { getGitHubAccessToken } from "@/lib/session";

type RouteContext = {
  params: Promise<{ source: string[] }>;
};

type AnnotationLocation = {
  endLineNumber?: number;
  endSide?: "additions" | "deletions";
  id: string;
  lineNumber: number;
  side?: "additions" | "deletions";
};

type AnnotationComment = {
  code: string;
  location?: AnnotationLocation;
  text: string;
};

/** Parses the durable source location stored with a local annotation. */
function parseLocation(value: unknown): AnnotationLocation | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;

  const { endLineNumber, endSide, id, lineNumber, side } = value;
  if (typeof id !== "string" || typeof lineNumber !== "number" || !Number.isInteger(lineNumber) || lineNumber < 1) return null;
  if (side !== undefined && side !== "additions" && side !== "deletions") return null;
  if (endSide !== undefined && endSide !== "additions" && endSide !== "deletions") return null;
  if (endLineNumber !== undefined && (typeof endLineNumber !== "number" || !Number.isInteger(endLineNumber) || endLineNumber < 1)) return null;

  return {
    endLineNumber,
    endSide: endSide as AnnotationLocation["endSide"],
    id,
    lineNumber,
    side: side as AnnotationLocation["side"],
  };
}

/** Validates the exact local annotation that the user explicitly confirmed for GitHub. */
function parseAnnotationComment(value: unknown): AnnotationComment | null {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.text !== "string") return null;
  const location = parseLocation(value.location);
  if (location === null) return null;
  return { code: value.code, location, text: value.text };
}

/** Turns an unanchorable annotation into a normal PR comment without losing its source context. */
function generalCommentBody(annotation: AnnotationComment): string {
  const location = annotation.location;
  const endLine = location?.endLineNumber ?? location?.lineNumber;
  const reference = location ? `\`${location.id}:${location.lineNumber}${endLine && endLine !== location.lineNumber ? `-${endLine}` : ""}\`` : "Selected code";
  const code = annotation.code.trim();
  return code ? `${annotation.text.trim()}\n\n${reference}\n\n\`\`\`\n${code}\n\`\`\`` : `${annotation.text.trim()}\n\n${reference}`;
}

/** Promotes one confirmed local annotation to its GitHub inline or fallback PR comment. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });

  const [body, { source }, accessToken] = await Promise.all([
    request.json().catch(() => null),
    context.params,
    getGitHubAccessToken(request),
  ]);
  const annotation = parseAnnotationComment(body);
  const isPullRequest = source[2] === "pull" && /^\d+$/.test(source[3] ?? "");
  if (!annotation || !annotation.text.trim() || !isPullRequest) {
    return NextResponse.json({ error: "Invalid annotation comment" }, { status: 400 });
  }

  try {
    const location = annotation.location;
    const endLine = location?.endLineNumber ?? location?.lineNumber;
    const firstLine = location && endLine ? Math.min(location.lineNumber, endLine) : undefined;
    const lastLine = location && endLine ? Math.max(location.lineNumber, endLine) : undefined;
    const isInlineRange = Boolean(location?.side && firstLine && lastLine && (firstLine === lastLine || location.endSide === location.side));
    const result = isInlineRange && location && firstLine && lastLine
      ? await postPullRequestAgentComment(source, accessToken, {
        body: annotation.text,
        line: lastLine,
        path: location.id,
        side: location.side === "additions" ? "RIGHT" : "LEFT",
        startLine: firstLine === lastLine ? undefined : firstLine,
        startSide: firstLine === lastLine ? undefined : location.side === "additions" ? "RIGHT" : "LEFT",
        type: "line",
      })
      : await postPullRequestAgentComment(source, accessToken, { body: generalCommentBody(annotation), type: "general" });
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof GitHubError ? error.status : 500;
    const message = error instanceof Error ? error.message : "GitHub could not create the annotation comment";
    return NextResponse.json({ error: message }, { status });
  }
}
