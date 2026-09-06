import { NextResponse } from "next/server";
import { sealEveOpenAIAccess } from "@/lib/eve-openai-credential";
import {
  getOpenAIAccess,
  isSameOrigin,
  OPENAI_SESSION_COOKIE,
} from "@/lib/openai-auth";

/** Refreshes the normal OpenAI login and returns an opaque credential for one Eve request. */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });

  try {
    const access = await getOpenAIAccess();
    if (access) {
      return NextResponse.json({
        credential: await sealEveOpenAIAccess(access.accessToken, access.session.accountId),
      });
    }

    const response = NextResponse.json({ error: "Connect OpenAI before asking about code." }, { status: 401 });
    response.cookies.delete(OPENAI_SESSION_COOKIE);
    return response;
  } catch {
    return NextResponse.json({ error: "OpenAI is temporarily unavailable. Try again." }, { status: 503 });
  }
}
