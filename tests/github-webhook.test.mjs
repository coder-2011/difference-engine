import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { repositoryNotificationChannel, validGitHubWebhookSignature, webhookRepository } from "../src/lib/github-webhook.ts";

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
