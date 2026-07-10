import { NextResponse } from "next/server";
import {
  isSameOrigin,
  OPENAI_DEVICE_COOKIE,
  openAISessionCookie,
  pollOpenAIDeviceCode,
} from "@/lib/openai-auth";

export const runtime = "nodejs";

/** Polls one device authorization attempt and creates a session after approval. */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });

  try {
    const result = await pollOpenAIDeviceCode();
    if (result.pending) return NextResponse.json({ pending: true }, { status: 202 });

    const response = NextResponse.json(result.connection);
    response.cookies.set(openAISessionCookie(result.sealedSession));
    response.cookies.delete(OPENAI_DEVICE_COOKIE);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenAI sign-in could not finish.";
    const retryable = message === "fetch failed" || /\(5\d\d\)/.test(message);
    return NextResponse.json({ error: message }, { status: retryable ? 503 : 400 });
  }
}
