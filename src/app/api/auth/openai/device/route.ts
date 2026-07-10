import { NextResponse } from "next/server";
import { isSameOrigin, openAIDeviceCookie, startOpenAIDeviceCode } from "@/lib/openai-auth";

export const runtime = "nodejs";

/** Starts a same-origin OpenAI device authorization request. */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });

  try {
    const device = await startOpenAIDeviceCode();
    const response = NextResponse.json({
      interval: device.interval,
      userCode: device.userCode,
      verificationUrl: device.verificationUrl,
    });
    response.cookies.set(openAIDeviceCookie(device.sealedSession));
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenAI sign-in could not start.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
