import { NextResponse } from "next/server";
import { repositoryNotificationChannel, validGitHubWebhookSignature, webhookRepository } from "@/lib/github-webhook";
import { isRecord } from "@/lib/json";
import { notificationForWebhook } from "@/lib/pull-request-notification";
import { realtimeClient, realtimeConfiguration } from "@/lib/realtime";

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const RELEVANT_EVENTS = new Set([
  "check_run", "check_suite", "commit_comment", "create", "delete", "issue_comment", "pull_request",
  "pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "push", "status", "workflow_run",
]);

/** Validates GitHub's signed payload before publishing an invalidation signal. */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const configuration = realtimeConfiguration();
  if (!secret || !configuration) return NextResponse.json({ error: "Webhook is not configured" }, { status: 503 });

  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_PAYLOAD_BYTES) return new Response(null, { status: 413 });
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_PAYLOAD_BYTES) return new Response(null, { status: 413 });
  if (!validGitHubWebhookSignature(body, request.headers.get("x-hub-signature-256"), secret)) return new Response(null, { status: 401 });

  const event = request.headers.get("x-github-event") ?? "";
  if (event === "ping" || !RELEVANT_EVENTS.has(event)) return new Response(null, { status: 204 });

  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(body)); } catch { return new Response(null, { status: 400 }); }
  if (!isRecord(payload) || !isRecord(payload.repository)) return new Response(null, { status: 400 });
  const repository = webhookRepository(payload.repository.full_name);
  if (!repository) return new Response(null, { status: 400 });
  if (event === "issue_comment" && (!isRecord(payload.issue) || !isRecord(payload.issue.pull_request))) return new Response(null, { status: 204 });

  try {
    await realtimeClient(configuration).trigger(repositoryNotificationChannel(repository.owner, repository.repository), "changed", notificationForWebhook(event, payload));
    return new Response(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Could not publish webhook notification" }, { status: 503 });
  }
}
