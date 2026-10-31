import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function fixture(revisions = ["owner/repo:A:A", "owner/repo:A:A"]) {
  const calls = [];
  let cancelled = false;
  class GitHubError extends Error { constructor(message, status) { super(message); this.status = status; } }
  const modules = {
    "next/server": { NextResponse: { json: Response.json } },
    "@/lib/github": {
      GitHubError,
      async getPullRequestRevision(_source, token) {
        calls.push(["revision", token]);
        const value = revisions.shift();
        if (typeof value !== "string") throw new GitHubError("GitHub rate limit exceeded", 429);
        return value;
      },
      async getDiffResponse(_source, token, etag) {
        calls.push(["diff", token, etag]);
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "text/plain" } });
      },
    },
    "@/lib/session": { async getGitHubAccessToken() { return "token"; } },
  };
  const exports = {};
  const source = readFileSync(new URL("../src/app/api/diff/[...source]/route.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(output, { exports, require: (name) => modules[name], URL, Response, Error });
  return { calls, cancelled: () => cancelled, run: (path, source) => exports.GET(new Request(`https://example.test${path}`), { params: Promise.resolve({ source }) }) };
}
const pull = ["owner", "repo", "pull", "1"];

test("verified preload brackets the PR diff response and returns its revision", async () => {
  const app = fixture();
  const response = await app.run("/api/diff/owner/repo/pull/1?preload=1", pull);
  assert.deepEqual(app.calls, [["revision", "token"], ["diff", "token", undefined], ["revision", "token"]]);
  assert.equal(response.headers.get("x-diff-revision"), "owner/repo:A:A");
  await response.body.cancel();
});

test("changed revisions discard the speculative diff", async () => {
  const app = fixture(["owner/repo:A:A", "owner/repo:B:B"]);
  const response = await app.run("/api/diff/owner/repo/pull/1?preload=1", pull);
  assert.equal(response.status, 409);
  assert.equal(app.cancelled(), true);
});

test("a failed revision check after obtaining the diff cancels it", async () => {
  const app = fixture(["owner/repo:A:A", null]);
  const response = await app.run("/api/diff/owner/repo/pull/1?preload=1", pull);
  assert.equal(response.status, 429);
  assert.equal(app.cancelled(), true);
});

test("a rate-limited preload leaves the ordinary diff route available", async () => {
  const app = fixture([null]);
  const preload = await app.run("/api/diff/owner/repo/pull/1?preload=1", pull);
  assert.equal(preload.status, 429);
  assert.deepEqual(app.calls, [["revision", "token"]]);
  const fallback = await app.run("/api/diff/owner/repo/pull/1", pull);
  assert.equal(fallback.status, 200);
  assert.deepEqual(app.calls, [["revision", "token"], ["diff", "token", undefined]]);
  await fallback.body.cancel();
});

test("ordinary PR and non-PR fetches never require metadata checks", async () => {
  for (const source of [pull, ["owner", "repo", "commit", "a"]]) {
    const app = fixture([null]);
    const response = await app.run("/api/diff/owner/repo/item", source);
    assert.equal(response.status, 200);
    assert.deepEqual(app.calls, [["diff", "token", undefined]]);
    await response.body.cancel();
  }
});
