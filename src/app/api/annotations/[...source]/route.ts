import { NextResponse } from "next/server";
import { GitHubError, postPullRequestAgentComment } from "@/lib/github";
import { isInteger, isRecord, isString, type JsonValue } from "@/lib/json";
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
function parseLocation(value: JsonValue | undefined): AnnotationLocation | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;

  const { endLineNumber, endSide, id, lineNumber, side } = value;
  if (!isString(id) || !isInteger(lineNumber) || lineNumber < 1) return null;
  if (side !== undefined && side !== "additions" && side !== "deletions") return null;
  if (endSide !== undefined && endSide !== "additions" && endSide !== "deletions") return null;
  if (endLineNumber !== undefined && (!isInteger(endLineNumber) || endLineNumber < 1)) return null;

  return {
    endLineNumber,
    endSide,
    id,
    lineNumber,
    side,
  };
}

/** Validates the exact local annotation that the user explicitly confirmed for GitHub. */
function parseAnnotationComment(value: JsonValue): AnnotationComment | null {
  if (!isRecord(value) || !isString(value.code) || !isString(value.text)) return null;
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
    const generalComment = { body: generalCommentBody(annotation), type: "general" as const };
    let result: { url: string };

    if (isInlineRange && location && firstLine && lastLine) {
      try {
        result = await postPullRequestAgentComment(source, accessToken, {
          body: annotation.text,
          line: lastLine,
          path: location.id,
          side: location.side === "additions" ? "RIGHT" : "LEFT",
          startLine: firstLine === lastLine ? undefined : firstLine,
          startSide: firstLine === lastLine ? undefined : location.side === "additions" ? "RIGHT" : "LEFT",
          type: "line",
        });
      } catch (error) {
        // Stale revisions and invalid diff anchors can reject line comments while a normal PR comment remains valid.
        if (!(error instanceof GitHubError) || ![400, 404, 409, 422].includes(error.status)) throw error;
        result = await postPullRequestAgentComment(source, accessToken, generalComment);
      }
    } else {
      result = await postPullRequestAgentComment(source, accessToken, generalComment);
    }
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof GitHubError ? error.status : 500;
    const message = error instanceof Error ? error.message : "GitHub could not create the annotation comment";
    return NextResponse.json({ error: message }, { status });
  }
}
