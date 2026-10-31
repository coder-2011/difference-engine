import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return nextResolve(pathToFileURL(resolve(root, "src", `${specifier.slice(2)}.ts`)).href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".ts")) {
      return {
        format: "module",
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText,
      };
    }
    return nextLoad(url, context);
  },
});
const { getPullRequestWorkspace } = await import("../src/lib/github.ts");

const pull = {
  number: 123, state: "open", merged: false, locked: false, draft: false,
  head: { sha: "head", ref: "branch", label: "owner:branch" },
  base: { sha: "base", label: "owner:main" },
  user: { login: "author", avatar_url: "" }, title: "title", body: "description",
  additions: 1, deletions: 0, changed_files: 1,
};
const comment = (id, body) => ({
  id, body, created_at: `2024-01-0${id}T00:00:00Z`, updated_at: `2024-01-0${id}T00:00:00Z`,
  user: { login: "author", avatar_url: "" },
});
const ok = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", ...headers } });

await test("public discussion pages retain pagination across cached, revalidated, and rate-limited requests", async () => {
  const calls = [];
  const first = "/repos/owner/cache/pulls/123";
  const comments = "/repos/owner/cache/issues/123/comments?per_page=100&sort=created&direction=asc";
  const next = `${comments}&page=2`;
  let text = "before";
  let limited = false;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    const validator = new Headers(init.headers).get("if-none-match");
    calls.push({ path, validator });
    if (limited && (path === comments || path === next)) return new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403 });
    if (path === first) return ok(pull, { ETag: '"pull"' });
    if (path === comments) {
      const etag = `"${text}"`;
      if (validator === etag) return new Response(null, { status: 304 });
      return ok([comment(1, text)], { ETag: etag, Link: `<https://api.github.com${next}>; rel="next"` });
    }
    if (path === next) return validator === '"page2"'
      ? new Response(null, { status: 304 })
      : ok([comment(2, "second")], { ETag: '"page2"' });
    if (path.includes("/actions/runs")) return ok({ workflow_runs: [] }, { ETag: '"other"' });
    return ok([], { ETag: '"other"' });
  };
  const source = ["owner", "cache", "pull", "123"];
  let workspace = await getPullRequestWorkspace(source);
  assert.deepEqual(workspace.comments.map((item) => item.body), ["before", "second"]);
  assert.equal(calls.length, 10);
  calls.length = 0;
  workspace = await getPullRequestWorkspace(source);
  assert.deepEqual(workspace.comments.map((item) => item.body), ["before", "second"]);
  assert.deepEqual(calls.map(({ path }) => path), [first]);
  calls.length = 0;
  workspace = await getPullRequestWorkspace(source, undefined, true);
  assert.deepEqual(workspace.comments.map((item) => item.body), ["before", "second"]);
  assert.equal(calls.find(({ path }) => path === comments)?.validator, '"before"');
  assert.equal(calls.find(({ path }) => path === next)?.validator, '"page2"');
  text = "after";
  workspace = await getPullRequestWorkspace(source, undefined, true);
  assert.deepEqual(workspace.comments.map((item) => item.body), ["after", "second"]);
  limited = true;
  workspace = await getPullRequestWorkspace(source, undefined, true);
  assert.deepEqual(workspace.comments.map((item) => item.body), ["after", "second"]);
});

await test("a forced refresh does not join an older request or let it replace newer data", async () => {
  const source = ["owner", "race", "pull", "123"];
  const comments = "/repos/owner/race/issues/123/comments?per_page=100&sort=created&direction=asc";
  let count = 0;
  let release;
  let signal;
  const started = new Promise((resolve) => { signal = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    if (path === "/repos/owner/race/pulls/123") return ok(pull, { ETag: '"pull"' });
    if (path === comments) {
      count += 1;
      if (count === 1) {
        signal();
        await held;
        return ok([comment(1, "old")], { ETag: '"old"' });
      }
      return ok([comment(1, "new")], { ETag: '"new"' });
    }
    if (path.includes("/actions/runs")) return ok({ workflow_runs: [] }, { ETag: '"other"' });
    return ok([], { ETag: '"other"' });
  };
  const oldWorkspace = getPullRequestWorkspace(source);
  await started;
  const currentWorkspace = await getPullRequestWorkspace(source, undefined, true);
  assert.deepEqual(currentWorkspace.comments.map((item) => item.body), ["new"]);
  release();
  assert.deepEqual((await oldWorkspace).comments.map((item) => item.body), ["old"]);
  assert.deepEqual((await getPullRequestWorkspace(source)).comments.map((item) => item.body), ["new"]);
  assert.equal(count, 2);
});

await test("a delayed 304 cannot replace a newer page in the cache", async () => {
  const source = ["owner", "race304", "pull", "123"];
  const comments = "/repos/owner/race304/issues/123/comments?per_page=100&sort=created&direction=asc";
  let count = 0;
  let release;
  let signal;
  const started = new Promise((resolve) => { signal = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    if (path === "/repos/owner/race304/pulls/123") return ok(pull, { ETag: '"pull"' });
    if (path === comments) {
      count += 1;
      if (count === 1) return ok([comment(1, "before")], { ETag: '"before"' });
      if (count === 2) {
        signal();
        await held;
        return new Response(null, { status: 304 });
      }
      return ok([comment(1, "after")], { ETag: '"after"' });
    }
    if (path.includes("/actions/runs")) return ok({ workflow_runs: [] }, { ETag: '"other"' });
    return ok([], { ETag: '"other"' });
  };
  assert.deepEqual((await getPullRequestWorkspace(source)).comments.map((item) => item.body), ["before"]);
  const oldWorkspace = getPullRequestWorkspace(source, undefined, true);
  await started;
  assert.deepEqual((await getPullRequestWorkspace(source, undefined, true)).comments.map((item) => item.body), ["after"]);
  release();
  assert.deepEqual((await oldWorkspace).comments.map((item) => item.body), ["before"]);
  assert.deepEqual((await getPullRequestWorkspace(source)).comments.map((item) => item.body), ["after"]);
  assert.equal(count, 3);
});

await test("authenticated conversation updates remain separate from public and other viewers", async () => {
  const source = ["owner", "identities", "pull", "123"];
  const comments = "/repos/owner/identities/issues/123/comments?per_page=100&sort=created&direction=asc";
  const calls = [];
  let aBody = "a-before";
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    const headers = new Headers(init.headers);
    const authorization = headers.get("authorization");
    calls.push({ authorization, path, validator: headers.get("if-none-match") });
    if (path === "/graphql") return ok({ data: { repository: null } });
    if (path === "/repos/owner/identities/pulls/123") return ok(pull, { ETag: '"pull"' });
    if (path === comments) {
      const text = authorization === "Bearer viewer-a" ? aBody : authorization === "Bearer viewer-b" ? "b" : "public";
      return ok([comment(1, text)], { ETag: `"${text}"` });
    }
    if (path.includes("/actions/runs")) return ok({ workflow_runs: [] }, { ETag: '"other"' });
    return ok([], { ETag: '"other"' });
  };
  assert.deepEqual((await getPullRequestWorkspace(source)).comments.map((item) => item.body), ["public"]);
  assert.deepEqual((await getPullRequestWorkspace(source, "viewer-a")).comments.map((item) => item.body), ["a-before"]);
  assert.deepEqual((await getPullRequestWorkspace(source, "viewer-b")).comments.map((item) => item.body), ["b"]);
  aBody = "a-after";
  assert.deepEqual((await getPullRequestWorkspace(source, "viewer-a")).comments.map((item) => item.body), ["a-after"]);
  assert.equal(calls.filter(({ path, authorization }) => path === comments && authorization === "Bearer viewer-a").at(-1)?.validator, '"a-before"');
  assert.deepEqual((await getPullRequestWorkspace(source)).comments.map((item) => item.body), ["public"]);
});

await test("oversized pages replace neither newer nor older cached results", async () => {
  const source = ["owner", "oversized", "pull", "123"];
  const comments = "/repos/owner/oversized/issues/123/comments?per_page=100&sort=created&direction=asc";
  const oversized = "x".repeat(1_000_001);
  const validators = [];
  let release;
  let signal;
  const started = new Promise((resolve) => { signal = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    if (path === "/repos/owner/oversized/pulls/123") return ok(pull, { ETag: '"pull"' });
    if (path === comments) {
      validators.push(new Headers(init.headers).get("if-none-match"));
      if (validators.length === 1) return ok([comment(1, "before")], { ETag: '"before"' });
      if (validators.length === 2) {
        signal();
        await held;
        return new Response(null, { status: 304 });
      }
      return ok([comment(1, oversized)], { ETag: '"oversized"' });
    }
    if (path.includes("/actions/runs")) return ok({ workflow_runs: [] }, { ETag: '"other"' });
    return ok([], { ETag: '"other"' });
  };
  assert.equal((await getPullRequestWorkspace(source)).comments[0]?.body, "before");
  const oldWorkspace = getPullRequestWorkspace(source, undefined, true);
  await started;
  assert.equal((await getPullRequestWorkspace(source, undefined, true)).comments[0]?.body.length, oversized.length);
  release();
  assert.equal((await oldWorkspace).comments[0]?.body, "before");
  assert.equal((await getPullRequestWorkspace(source)).comments[0]?.body.length, oversized.length);
  assert.equal((await getPullRequestWorkspace(source)).comments[0]?.body.length, oversized.length);
  assert.deepEqual(validators, [null, '"before"', '"before"', null, null]);
});

await test("forced refresh evicts an old page even when the in-flight limit is full", async () => {
  const source = ["owner", "full", "pull", "123"];
  const comments = "/repos/owner/full/issues/123/comments?per_page=100&sort=created&direction=asc";
  const validators = [];
  const held = [];
  let oversized = false;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    if (path.includes("/held-")) return new Promise((_, reject) => held.push(reject));
    if (path === "/repos/owner/full/pulls/123") return ok(pull, { ETag: '"pull"' });
    if (path === comments) {
      validators.push(new Headers(init.headers).get("if-none-match"));
      return ok([comment(1, oversized ? "x".repeat(1_000_001) : "before")], { ETag: oversized ? '"oversized"' : '"before"' });
    }
    if (path.includes("/actions/runs")) return ok({ workflow_runs: [] }, { ETag: '"other"' });
    return ok([], { ETag: '"other"' });
  };
  assert.equal((await getPullRequestWorkspace(source)).comments[0]?.body, "before");
  const requests = Array.from({ length: 300 }, (_, index) =>
    getPullRequestWorkspace(["owner", `held-${index}`, "pull", "123"]).catch(() => {}),
  );
  try {
    assert.equal(held.length, 300);
    oversized = true;
    assert.equal((await getPullRequestWorkspace(source, undefined, true)).comments[0]?.body.length, 1_000_001);
    assert.equal((await getPullRequestWorkspace(source)).comments[0]?.body.length, 1_000_001);
    assert.deepEqual(validators, [null, '"before"', null]);
  } finally {
    for (const reject of held) reject(new Error("finished"));
    await Promise.all(requests);
  }
});
