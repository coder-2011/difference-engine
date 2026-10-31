import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { repositoryNotificationChannel, validGitHubWebhookSignature, webhookRepository } from "../src/lib/github-webhook.ts";
import { notificationAffectsPullRequest, notificationForWebhook } from "../src/lib/pull-request-notification.ts";

test("verifies GitHub's published signature against the raw payload", () => {
  const body = Buffer.from("Hello, World!");
  const secret = "It's a Secret to Everybody";
  const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
  assert.equal(validGitHubWebhookSignature(body, signature, secret), true);
  assert.equal(validGitHubWebhookSignature(Buffer.from("Hello, world!"), signature, secret), false);
  assert.equal(validGitHubWebhookSignature(body, signature, "wrong"), false);
  assert.equal(validGitHubWebhookSignature(body, "sha256=ff", secret), false);
  assert.equal(validGitHubWebhookSignature(body, null, secret), false);
  assert.equal(validGitHubWebhookSignature(body, signature, ""), false);
  const unicode = Buffer.from('{"text":"café"}');
  const digest = createHmac("sha256", secret).update(unicode).digest("hex");
  assert.equal(validGitHubWebhookSignature(unicode, `sha256=${digest}`, secret), true);
});

test("maps only well-formed repository names to stable private channels", () => {
  assert.deepEqual(webhookRepository("Coder-2011/Example.repo"), { owner: "Coder-2011", repository: "Example.repo" });
  assert.equal(repositoryNotificationChannel("Coder-2011", "Example.repo"), repositoryNotificationChannel("coder-2011", "example.REPO"));
  assert.notEqual(repositoryNotificationChannel("a-b", "c"), repositoryNotificationChannel("a", "b-c"));
  for (const invalid of ["a/b/c", "../repo", "a/..", "a/", "/repo", "a/repo%2fother", 123]) assert.equal(webhookRepository(invalid), undefined);
});

test("PR events notify only the identified pull request", () => {
  for (const event of ["pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread"]) {
    const notification = notificationForWebhook(event, { pull_request: { number: 268 } });
    assert.deepEqual(notification, { pullNumber: 268 });
    assert.equal(notificationAffectsPullRequest(notification, 268), true);
    assert.equal(notificationAffectsPullRequest(notification, 267), false);
  }
  assert.deepEqual(notificationForWebhook("issue_comment", { issue: { number: 268, pull_request: {} } }), { pullNumber: 268 });
});

test("repository events and malformed payloads refresh every pull request", () => {
  for (const event of ["push", "check_run", "check_suite", "status", "workflow_run", "unknown"]) {
    const notification = notificationForWebhook(event, { pull_request: { number: 268 }, pull_requests: [{ number: 268 }] });
    assert.deepEqual(notification, {});
    assert.equal(notificationAffectsPullRequest(notification, 267), true);
  }
  for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "268", null]) {
    const notification = notificationForWebhook("pull_request", { pull_request: { number } });
    assert.deepEqual(notification, {});
    assert.equal(notificationAffectsPullRequest({ pullNumber: number }, 267), true);
  }
  for (const malformed of [null, [], "changed", {}, { pull_request: [] }, { pull_request: {} }]) {
    assert.deepEqual(notificationForWebhook("pull_request", malformed), {});
    assert.equal(notificationAffectsPullRequest(malformed, 267), true);
  }
  assert.equal(notificationAffectsPullRequest({ pullNumber: 268 }, NaN), true);
});
