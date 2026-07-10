import { NextResponse } from "next/server";
import {
  isSameOrigin,
  openAIDeviceCookieName,
  openAISessionCookieName,
  revokeOpenAISession,
} from "@/lib/openai-auth";

export const runtime = "nodejs";

/** Clears all OpenAI authorization state for this browser. */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  await revokeOpenAISession();
  const response = NextResponse.json({ connected: false });
  response.cookies.delete(openAISessionCookieName());
  response.cookies.delete(openAIDeviceCookieName());
  return response;
}
