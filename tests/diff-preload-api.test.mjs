import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function fixture(revisions = ["owner/repo:A:A", "owner/repo:A:A"], hooks = {}) {
  const calls = [];
  let cancelled = false;
  class GitHubError extends Error { constructor(message, status) { super(message); this.status = status; } }
  const modules = {
    "next/server": { NextResponse: { json: Response.json } },
    "@/lib/github": {
      GitHubError,
      async getPullRequestRevision(_source, token, signal) {
        calls.push(["revision", token]);
        await hooks.revision?.(calls.length, signal);
        const value = revisions.shift();
        if (typeof value !== "string") throw new GitHubError("GitHub rate limit exceeded", 429);
        return value;
      },
      async getDiffResponse(_source, token, etag, signal) {
        calls.push(["diff", token, etag]);
        const result = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "text/plain" } });
        await hooks.diff?.(signal);
        return result;
      },
    },
    "@/lib/session": { async getGitHubAccessToken() { return "token"; } },
  };
  const exports = {};
  const source = readFileSync(new URL("../src/app/api/diff/[...source]/route.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(output, { exports, require: (name) => modules[name], URL, Response, Error });
  return { calls, cancelled: () => cancelled, run: (path, source, signal) => exports.GET(new Request(`https://example.test${path}`, { signal }), { params: Promise.resolve({ source }) }) };
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

for (const stage of ["first revision", "diff", "second revision"]) {
  test(`aborting during ${stage} stops the remaining speculative work`, async () => {
    const controller = new AbortController();
    let entered;
    let release;
    let passedSignal;
    const started = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const pause = async (signal) => { passedSignal = signal; entered(); await gate; };
    const app = fixture(undefined, {
      revision: async (count, signal) => {
        if ((stage === "first revision" && count === 1) || (stage === "second revision" && count === 3)) await pause(signal);
      },
      diff: async (signal) => { if (stage === "diff") await pause(signal); },
    });
    const pending = app.run("/api/diff/owner/repo/pull/1?preload=1", pull, controller.signal);
    await started;
    controller.abort();
    release();
    const response = await pending;
    assert.equal(response.status, 499);
    assert.equal(passedSignal.aborted, true);
    assert.equal(app.calls.length, stage === "first revision" ? 1 : stage === "diff" ? 2 : 3);
    assert.equal(app.cancelled(), stage !== "first revision");
  });
}

test("aborting just after diff acquisition prevents the second revision request", async () => {
  const controller = new AbortController();
  const app = fixture(undefined, { diff: async () => controller.abort() });
  const response = await app.run("/api/diff/owner/repo/pull/1?preload=1", pull, controller.signal);
  assert.equal(response.status, 499);
  assert.deepEqual(app.calls, [["revision", "token"], ["diff", "token", undefined]]);
  assert.equal(app.cancelled(), true);
});
