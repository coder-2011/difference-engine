import assert from "node:assert/strict";
import test from "node:test";

const { cancelPullRequestDiffPreload, preloadPullRequestDiff, takePreloadedDiff } = await import("../src/lib/diff-preload.ts");
const source = ["owner", "repo", "pull", "1"];
const path = "/owner/repo/pull/1";
const endpoint = "/api/diff/owner/repo/pull/1?preload=1";

async function withGlobals(fetch, run, timers = globalThis) {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = timers;
  globalThis.fetch = fetch;
  try { await run(); } finally { globalThis.window = previousWindow; globalThis.fetch = previousFetch; }
}

test("verified preload carries the PR revision and original diff stream", async () => {
  const requests = [];
  const patch = new ReadableStream({});
  await withGlobals(async (url) => {
    requests.push(url);
    return new Response(patch, { headers: { "X-Diff-Revision": "owner/repo:A:A" } });
  }, async () => {
    preloadPullRequestDiff(path);
    const result = await takePreloadedDiff(source);
    assert.equal(result.revision, "owner/repo:A:A");
    assert.equal(result.stream, patch);
    await result.stream.cancel();
  });
  assert.deepEqual(requests, [endpoint]);
});

test("failed verification falls back to the normal parser fetch", async () => {
  await withGlobals(async () => new Response(null, { status: 429 }), async () => {
    preloadPullRequestDiff(path);
    assert.equal(await takePreloadedDiff(source), null);
  });
});

test("a response without its verified revision discards the body", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await withGlobals(async () => new Response(body), async () => {
    preloadPullRequestDiff(path);
    assert.equal(await takePreloadedDiff(source), null);
    assert.equal(cancelled, true);
  });
});

test("taking an unresolved preload keeps its timeout and cancels a late response", async () => {
  let timeout;
  let finish;
  let signal;
  let cancelled = false;
  const delays = [];
  const pending = new Promise((resolve) => { finish = resolve; });
  const timers = { setTimeout(fn, delay) { timeout = fn; delays.push(delay); return delays.length; }, clearTimeout() {} };
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await withGlobals((_url, options) => { signal = options.signal; return pending; }, async () => {
    preloadPullRequestDiff(path);
    const result = takePreloadedDiff(source);
    assert.deepEqual(delays, [15_000, 300]);
    timeout();
    assert.equal(signal.aborted, true);
    finish(new Response(body, { headers: { "X-Diff-Revision": "owner/repo:A:A" } }));
    assert.equal(await result, null);
    assert.equal(cancelled, true);
  }, timers);
});

test("a completed handoff clears both timeouts without aborting the stream", async () => {
  const delays = [];
  const cleared = [];
  let signal;
  const timers = { setTimeout(_fn, delay) { delays.push(delay); return delays.length; }, clearTimeout(id) { cleared.push(id); } };
  const body = new ReadableStream({});
  await withGlobals(async (_url, options) => {
    signal = options.signal;
    return new Response(body, { headers: { "X-Diff-Revision": "owner/repo:A:A" } });
  }, async () => {
    preloadPullRequestDiff(path);
    const result = await takePreloadedDiff(source);
    assert.deepEqual(delays, [15_000, 300]);
    assert.deepEqual(cleared, [1, 2]);
    assert.equal(signal.aborted, false);
    assert.equal(result.stream, body);
    await result.stream.cancel();
  }, timers);
});

test("cancelling a hover discards a late response body", async () => {
  let finish;
  let cancelled = false;
  const pending = new Promise((resolve) => { finish = resolve; });
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await withGlobals(() => pending, async () => {
    preloadPullRequestDiff(path);
    cancelPullRequestDiffPreload(path);
    assert.equal(takePreloadedDiff(source), null);
    finish(new Response(body, { headers: { "X-Diff-Revision": "owner/repo:A:A" } }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
  });
});
