import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as json from "../src/lib/json.ts";

const require = createRequire(import.meta.url);
const githubSource = readFileSync(new URL("../src/lib/github.ts", import.meta.url), "utf8");
const githubModule = ts.transpileModule(githubSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const routeSource = readFileSync(new URL("../src/app/api/pull-request/[...source]/route.ts", import.meta.url), "utf8");
const routeModule = ts.transpileModule(routeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

function loadGitHub() {
  const exports = {};
  const loaded = { exports };
  const localRequire = (name) => name === "@/lib/json" ? json
    : name === "@/lib/call-diff-files" ? {}
      : require(name);
  new Function("exports", "require", "module", githubModule)(exports, localRequire, loaded);
  return loaded.exports;
}

function mockGitHub(t) {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const pr = {
    number: 1, state: "open", merged: false, locked: false, draft: false,
    title: "Current title", body: "Current body", additions: 1, deletions: 0, changed_files: 1,
    head: { sha: "head", ref: "current-branch", label: "owner:current-branch", repo: { full_name: "owner/repo" } },
    base: { sha: "base", label: "owner:main" }, user: { login: "author", avatar_url: "" },
  };
  const mutations = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const method = options.method ?? "GET";
    if (path === "/graphql") {
      return Response.json({ data: { repository: {
        viewerPermission: "WRITE", mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true,
        pullRequest: { id: "id", mergeStateStatus: "CLEAN", viewerCanClose: true, viewerCanUpdate: true,
          reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      } } });
    }
    if (method === "PATCH" || path.endsWith("/rename")) {
      const body = JSON.parse(options.body);
      mutations.push({ path, method, body });
      if ("title" in body) pr.title = body.title;
      if ("body" in body) pr.body = body.body;
      if ("new_name" in body) pr.head.ref = body.new_name;
      return Response.json({});
    }
    if (path === "/repos/owner/repo/pulls/1") return Response.json(pr);
    if (path.endsWith("/actions/runs")) return Response.json({ workflow_runs: [] });
    return Response.json([]);
  };
  return { mutations, pr };
}

function loadRoute(actions) {
  const exports = {};
  const loaded = { exports };
  const modules = {
    "next/server": { NextResponse: { json: Response.json } },
    "@/lib/github": { GitHubError: class extends Error {}, performPullRequestAction: async (_source, _token, action) => { actions.push(action); return {}; } },
    "@/lib/json": json,
    "@/lib/openai-auth": { isSameOrigin: () => true },
    "@/lib/session": { getGitHubAccessToken: async () => "token" },
  };
  new Function("exports", "require", "module", routeModule)(exports, (name) => modules[name], loaded);
  return loaded.exports;
}

for (const [action, key, current, replacement] of [
  ["edit-title", "title", "Current title", "Updated title"],
  ["edit-body", "body", "Current body", "Updated body"],
  ["rename-branch", "name", "current-branch", "updated-branch"],
]) {
  test(`${action} rejects a stale base before sending a GitHub mutation`, async (t) => {
    const { mutations } = mockGitHub(t);
    const { performPullRequestAction } = loadGitHub();
    await assert.rejects(
      performPullRequestAction(["owner", "repo", "pull", "1"], "token", { action, [key]: replacement, expected: "stale" }),
      (error) => error.status === 409 && /changed on GitHub/.test(error.message),
    );
    assert.deepEqual(mutations, []);
  });

  test(`${action} sends a GitHub mutation for the current base`, async (t) => {
    const { mutations } = mockGitHub(t);
    const { performPullRequestAction } = loadGitHub();
    await performPullRequestAction(["owner", "repo", "pull", "1"], "token", { action, [key]: replacement, expected: current });
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].body[action === "rename-branch" ? "new_name" : key], replacement);
  });

  test(`${action} requires the editor's base value at the API boundary`, async () => {
    const actions = [];
    const { POST } = loadRoute(actions);
    const context = { params: Promise.resolve({ source: ["owner", "repo", "pull", "1"] }) };
    const request = (value) => new Request("http://localhost/api/pull-request/owner/repo/pull/1", { method: "POST", body: JSON.stringify(value) });
    const outdated = await POST(request({ action, [key]: replacement }), context);
    assert.equal(outdated.status, 400);
    assert.match((await outdated.json()).error, /Copy your draft.*reload/);
    assert.equal((await POST(request({ action, [key]: replacement, expected: current }), context)).status, 200);
    assert.deepEqual(actions, [{ action, [key]: replacement, expected: current }]);
  });
}

test("an empty body draft matches GitHub's null description", async (t) => {
  const { mutations, pr } = mockGitHub(t);
  pr.body = null;
  const { performPullRequestAction } = loadGitHub();
  await performPullRequestAction(["owner", "repo", "pull", "1"], "token", { action: "edit-body", body: "New", expected: "" });
  assert.deepEqual(mutations[0].body, { body: "New" });
});
