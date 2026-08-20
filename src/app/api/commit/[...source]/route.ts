import { NextResponse } from "next/server";
import { createCommitAndPush, GitHubError, type CommitFileChange } from "@/lib/github";
import { isRecord, isString } from "@/lib/json";
import { getOpenAIAccess, isSameOrigin } from "@/lib/openai-auth";
import { getGitHubAccessToken } from "@/lib/session";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const COMMIT_SUBJECT_MODEL = "gpt-5.3-codex-spark";
const COMMIT_SUBJECT_FALLBACK_MODEL = process.env.OPENAI_OAUTH_AUTOCOMPLETE_MODEL ?? "gpt-5.6-luna";
const COMMIT_SUBJECT_INSTRUCTIONS = "You generate concise git commit subjects following Naman's style. Write a concise, one-line git commit subject for the following modified files. Output only one line: a lowercase, literal description of the change (e.g. \"update landing hero layout\" or \"fix token expiration check\"). Prefer a short action phrase starting with a verb like \"add\", \"fix\", \"update\", \"remove\", \"make\", \"speed up\". Do not use conventional-commit prefixes like feat: or fix:. Do not use emojis, trailing periods, scopes, quotes, or em dashes. Return only the commit subject.";

type RouteContext = {
  params: Promise<{ source: string[] }>;
};

/** Extracts and cleans the single-line commit subject from the AI response. */
function cleanCommitMessage(value: string, fallback: string): string {
  const line = (value.trim().split("\n").find(Boolean) ?? "").trim();
  const cleaned = line
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/^(?:commit(?:\s+message)?:\s*)/i, "")
    .replace(/[.?!]+$/, "")
    .trim();

  if (!cleaned) return fallback;
  return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}

/** Fallback commit subject when AI generation is unavailable. */
function fallbackCommitSubject(files: CommitFileChange[]): string {
  if (files.length === 1) {
    const fileName = files[0].path.split("/").pop() ?? files[0].path;
    return `update ${fileName}`;
  }
  return `update ${files.length} files`;
}

/** Asks one Codex model for a commit subject. Returns an empty string when that model cannot answer. */
async function requestCommitSubject(access: { accessToken: string; session: { accountId: string } }, model: string, summary: string): Promise<string> {
  const upstream = await fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${access.accessToken}`,
      "chatgpt-account-id": access.session.accountId,
      "Content-Type": "application/json",
      "OpenAI-Beta": "responses=experimental",
    },
    body: JSON.stringify({
      model,
      instructions: COMMIT_SUBJECT_INSTRUCTIONS,
      input: [{ role: "user", content: [{ type: "input_text", text: summary }] }],
      parallel_tool_calls: false,
      reasoning: { effort: "low" },
      service_tier: "priority",
      store: false,
      stream: false,
      tools: [],
    }),
  });

  if (!upstream.ok) return "";

  const payload: unknown = await upstream.json().catch(() => null);
  if (!isRecord(payload) || !Array.isArray(payload.output)) return "";
  return payload.output.flatMap((item) => (
    isRecord(item) && Array.isArray(item.content)
      ? item.content.flatMap((content) => isRecord(content) && content.type === "output_text" && isString(content.text) ? [content.text] : [])
      : []
  )).join("");
}

/** Generates a concise git commit subject following Naman's writing style. */
async function generateCommitSubject(files: CommitFileChange[]): Promise<string> {
  const fallback = fallbackCommitSubject(files);

  let access;
  try {
    access = await getOpenAIAccess();
  } catch {
    return fallback;
  }

  if (!access) return fallback;

  const summary = files
    .map((file) => `File: ${file.path}\nContent preview:\n${file.contents.slice(0, 1_500)}`)
    .join("\n\n---\n\n");

  const models = [COMMIT_SUBJECT_MODEL, COMMIT_SUBJECT_FALLBACK_MODEL].filter((model, index, list) => list.indexOf(model) === index);

  for (const model of models) {
    try {
      const text = await requestCommitSubject(access, model, summary);
      if (text.trim()) return cleanCommitMessage(text, fallback);
    } catch {
      continue;
    }
  }

  return fallback;
}

/** Handles committing modified files to GitHub with automated commit message generation. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });

  const [body, { source }, accessToken] = await Promise.all([
    request.json().catch(() => null),
    context.params,
    getGitHubAccessToken(request),
  ]);

  if (!isRecord(body) || !Array.isArray(body.files) || !body.files.length) {
    return NextResponse.json({ error: "No files provided for commit." }, { status: 400 });
  }

  const files: CommitFileChange[] = [];
  for (const item of body.files) {
    if (!isRecord(item) || !isString(item.path) || !isString(item.contents)) {
      return NextResponse.json({ error: "Invalid file payload format." }, { status: 400 });
    }
    files.push({ contents: item.contents, path: item.path.trim() });
  }

  if (!accessToken) {
    return NextResponse.json({ error: "Sign in with GitHub to commit and push changes." }, { status: 401 });
  }

  const commitMessage = (isString(body.message) && body.message.trim())
    ? body.message.trim()
    : await generateCommitSubject(files);

  try {
    const result = await createCommitAndPush(source, accessToken, files, commitMessage);
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof GitHubError ? error.status : 500;
    const message = error instanceof Error ? error.message : "GitHub could not complete this commit";
    return NextResponse.json({ error: message }, { status });
  }
}
