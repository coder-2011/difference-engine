import { NextResponse } from "next/server";
import { getLoadedDiffFiles, GitHubError } from "@/lib/github";
import { isString } from "@/lib/json";
import { getGitHubAccessToken } from "@/lib/session";

type RouteContext = {
  params: Promise<{ source: string[] }>;
};

/** Loads both file sides for a patch-parsed GitHub diff so Pierre can enter edit mode. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  const prevPath = url.searchParams.get("prevPath") ?? undefined;
  const changeType = url.searchParams.get("type") ?? "change";

  if (!isString(path) || !path.trim()) {
    return NextResponse.json({ error: "A file path is required" }, { status: 400 });
  }

  const [{ source }, accessToken] = await Promise.all([context.params, getGitHubAccessToken(request)]);

  try {
    return NextResponse.json(await getLoadedDiffFiles(source, accessToken, {
      changeType,
      path,
      prevPath,
    }));
  } catch (error) {
    const status = error instanceof GitHubError ? error.status : 500;
    const message = error instanceof Error ? error.message : "The file could not be loaded";
    return NextResponse.json({ error: message }, { status });
  }
}
