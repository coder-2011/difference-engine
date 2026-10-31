export type PullRequestNotification = { pullNumber?: number };

const PULL_REQUEST_EVENTS = new Set([
  "pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pullNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function notificationForWebhook(event: string, payload: unknown): PullRequestNotification {
  const key = event === "issue_comment" ? "issue" : PULL_REQUEST_EVENTS.has(event) ? "pull_request" : undefined;
  const number = key ? pullNumber(record(record(payload)?.[key])?.number) : undefined;
  return number === undefined ? {} : { pullNumber: number };
}

export function notificationAffectsPullRequest(notification: unknown, currentNumber: number): boolean {
  const number = pullNumber(record(notification)?.pullNumber);
  return number === undefined || !Number.isSafeInteger(currentNumber) || currentNumber <= 0 || number === currentNumber;
}
