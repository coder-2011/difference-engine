import { NextResponse } from "next/server";
import { GitHubError, verifyPullRequestAccess } from "@/lib/github";
import { repositoryNotificationChannel, webhookRepository } from "@/lib/github-webhook";
import { isSameOrigin } from "@/lib/openai-auth";
import { realtimeClient, realtimeConfiguration } from "@/lib/realtime";
import { getGitHubAccessToken } from "@/lib/session";

type RouteContext = { params: Promise<{ source: string[] }> };

/** Restricts private channel requests to a single well-formed PR URL. */
function channelForSource(source: string[]): string | undefined {
  const repository = webhookRepository(`${source[0] ?? ""}/${source[1] ?? ""}`);
  if (!repository || source.length < 4 || source[2] !== "pull" || !/^[1-9]\d*$/.test(source[3])) return undefined;
  return repositoryNotificationChannel(repository.owner, repository.repository);
}

/** Returns only the public connection settings; subscribing still requires authorization. */
export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { source } = await context.params;
  const channel = channelForSource(source);
  const configuration = realtimeConfiguration();
  if (!channel) return new Response(null, { status: 400 });
  if (!configuration) return new Response(null, { status: 503 });
  return NextResponse.json({ channel, cluster: configuration.cluster, key: configuration.key }, { headers: { "Cache-Control": "no-store" } });
}

/** Authorizes the private repository channel only after GitHub confirms the viewer can read the PR. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  if (!isSameOrigin(request)) return new Response(null, { status: 403 });
  const { source } = await context.params;
  const channel = channelForSource(source);
  const configuration = realtimeConfiguration();
  if (!channel) return new Response(null, { status: 400 });
  if (!configuration) return new Response(null, { status: 503 });

  const form = await request.formData().catch(() => null);
  const socket = form?.get("socket_id");
  if (typeof socket !== "string" || !/^\d{1,20}\.\d{1,20}$/.test(socket) || form?.get("channel_name") !== channel) return new Response(null, { status: 400 });

  try {
    const token = await getGitHubAccessToken(request);
    await verifyPullRequestAccess(source, token);
    return NextResponse.json(realtimeClient(configuration).authorizeChannel(socket, channel), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof GitHubError && error.status < 500 ? error.status : 503;
    return new Response(null, { status });
  }
}
