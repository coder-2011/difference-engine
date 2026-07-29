import { NextResponse } from "next/server";
import {
  getOpenAIAccess,
  isSameOrigin,
  OPENAI_SESSION_COOKIE,
} from "@/lib/openai-auth";

/** Validates the stored OpenAI refresh session when the site opens or refreshes. */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });

  try {
    const connected = Boolean(await getOpenAIAccess());
    const response = NextResponse.json({ connected });
    if (!connected) response.cookies.delete(OPENAI_SESSION_COOKIE);
    return response;
  } catch {
    return NextResponse.json({ error: "OpenAI connection could not be checked." }, { status: 503 });
  }
}
