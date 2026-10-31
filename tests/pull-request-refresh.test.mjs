import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

test("visible fallback checks revalidate GitHub discussion pages", async () => {
  const effects = [];
  const requests = [];
  const listeners = new Map();
  const workspace = { comments: [], commits: [], mergeMethods: [], reviewThreads: [], state: "closed", timelineEvents: [], workflowRuns: [] };
  const document = { visibilityState: "visible", addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener() {} };
  let interval;
  const window = {
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener() {},
    setInterval: (fn, ms) => { assert.equal(ms, 30_000); interval = fn; return 1; }, clearInterval() {},
  };
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: {
      useCallback: (fn) => fn, useEffect: (fn) => effects.push(fn), useMemo: (fn) => fn(),
      useRef: (current) => ({ current }), useState: (value) => [typeof value === "function" ? value() : value, () => {}],
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "next/image": { default() {} },
    "lucide-react": new Proxy({}, { get: () => () => {} }),
    "@/components/pull-request-live": { usePullRequestLive: () => null },
    "@/components/github-markdown": { GitHubMarkdown() {} },
    "@/components/pull-request-review-thread": { PullRequestReviewThread() {} },
    "@/lib/pull-request-notification": { notificationAffectsPullRequest: () => true },
    "@/lib/pull-request-draft": { draftStatus() {} },
  };
  const exports = {};
  const source = readFileSync(new URL("../src/components/pull-request-workspace.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(code, { exports, require: (name) => modules[name], document, window, fetch: async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({ workspace }) };
  } });
  exports.PullRequestWorkspace({ source: ["owner", "repo", "pull", "1"], workspace });
  const pollEffect = effects.find((effect) => effect.toString().includes("setInterval(poll"));
  assert.ok(pollEffect);
  pollEffect();

  for (const check of [interval, () => listeners.get("visibilitychange")(), () => listeners.get("pageshow")({ persisted: true }), () => listeners.get("online")()]) {
    check();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(requests, Array(4).fill("/api/pull-request/owner/repo/pull/1?fresh=1"));
  document.visibilityState = "hidden";
  interval();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 4);
  document.visibilityState = "visible";
  listeners.get("visibilitychange")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1), "/api/pull-request/owner/repo/pull/1?fresh=1");
  assert.equal(requests.length, 5);
});
