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
    return specifier.startsWith("@/") ? nextResolve(pathToFileURL(resolve(root, "src", `${specifier.slice(2)}.ts`)).href, context) : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText };
  },
});
const { getDiffResponse, getPullRequestRevision } = await import("../src/lib/github.ts");
const source = ["owner", "repo", "pull", "1"];

await test("revision reads pass the speculative signal to GitHub", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const controller = new AbortController();
  let observed;
  globalThis.fetch = async (_url, init) => { observed = init.signal; return Response.json({ base: { sha: "a" }, head: { sha: "b" } }); };
  assert.equal(await getPullRequestRevision(source, "token", controller.signal), "owner/repo:a:b");
  assert.equal(observed, controller.signal);
});

await test("aborting the original GitHub diff cancels its independent fetch", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const controller = new AbortController();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.signal, controller.signal);
    entered();
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  };
  const pending = getDiffResponse(source, "token", undefined, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

await test("aborting a public web fallback cancels its independent fetch", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const controller = new AbortController();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const signals = [];
  globalThis.fetch = async (url, init) => {
    signals.push(init.signal);
    if (new URL(url).hostname === "api.github.com") return new Response(null, { status: 403 });
    entered();
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  };
  const pending = getDiffResponse(source, undefined, undefined, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal === controller.signal));
});

await test("aborting an oversized private diff cancels its page fetch and stops pagination", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const controller = new AbortController();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, signal: init.signal });
    if (parsed.hostname === "github.com") return new Response(null, { status: 404 });
    if (!parsed.pathname.endsWith("/files")) return new Response(null, { status: 406 });
    if (parsed.searchParams.get("page") === "1") return Response.json(Array.from({ length: 100 }, (_, i) => ({ filename: `file${i}`, status: "modified" })));
    entered();
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  };
  const pending = getDiffResponse(source, "token", undefined, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls.length, 4);
  assert.ok(calls.every(({ signal }) => signal === controller.signal));
});

await test("ordinary diff requests do not acquire a speculative abort signal", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let hasSignal;
  globalThis.fetch = async (_url, init) => { hasSignal = "signal" in init; return new Response("patch"); };
  const response = await getDiffResponse(source, "token");
  assert.equal(hasSignal, false);
  await response.body.cancel();
});
