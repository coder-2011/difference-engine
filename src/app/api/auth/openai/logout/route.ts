import { NextResponse } from "next/server";
import {
  isSameOrigin,
  OPENAI_DEVICE_COOKIE,
  OPENAI_SESSION_COOKIE,
  revokeOpenAISession,
} from "@/lib/openai-auth";

/** Clears all OpenAI authorization state for this browser. */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });

  await revokeOpenAISession();
  const response = NextResponse.json({ connected: false });
  response.cookies.delete(OPENAI_SESSION_COOKIE);
  response.cookies.delete(OPENAI_DEVICE_COOKIE);
  return response;
}
