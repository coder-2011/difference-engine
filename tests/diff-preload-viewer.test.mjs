import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function fixture({ preload, initial = "owner/repo:B:B", latest = initial }) {
  const source = readFileSync(new URL("../src/components/diff-viewer.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("diff-viewer.tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "useEffect"
        && node.arguments[0]?.getText(file).includes("preloadedLanguages")) effect = node.arguments[0].getText(file);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(effect);
  effect = effect.replace('new URL("../workers/parse-diff.worker.ts", import.meta.url)', '"parse-diff.worker.js"');
  const workers = [];
  class Worker {
    listeners = {};
    constructor() { workers.push(this); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    postMessage(message) { this.request = message; }
    terminate() { this.terminated = true; }
  }
  const globals = {
    Worker, takePreloadedDiff: () => preload,
    getFiletypeFromFileName: () => undefined, preloadHighlighter: async () => {},
    setParsedFiles() {}, setInitialDiffComplete() {}, setRepositoryFiles() {}, setError() {},
  };
  const program = `let repository = false, initialRevisionRef = { current: ${JSON.stringify(initial)} }, latestRevisionRef = { current: ${JSON.stringify(latest)} };
    let source = ["owner", "repo", "pull", "1"]; const effect = ${effect}; globalThis.mount = () => effect();`;
  const code = ts.transpileModule(program, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, globals);
  return { mount: globals.mount, workers };
}

test("preload A is discarded when the page shows revision B", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const app = fixture({ preload: Promise.resolve({ stream, revision: "owner/repo:A:A" }) });
  app.mount();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(app.workers[0].request.cacheKey, "owner/repo:B:B");
  assert.equal(app.workers[0].request.stream, undefined);
});

test("matching verified preload is transferred to the parser", async () => {
  const stream = new ReadableStream({});
  const app = fixture({ preload: Promise.resolve({ stream, revision: "owner/repo:B:B" }) });
  app.mount();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.workers[0].request.stream, stream);
  await stream.cancel();
});

test("a failed preload falls back to the ordinary diff fetch", async () => {
  const app = fixture({ preload: Promise.resolve(null) });
  app.mount();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.workers[0].request.stream, undefined);
  assert.equal(app.workers[0].request.url, "/api/diff/owner/repo/pull/1");
});

test("unmount cancels a preload that resolves later", async () => {
  let resolve;
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const app = fixture({ preload: new Promise((done) => { resolve = done; }) });
  const unmount = app.mount();
  unmount();
  resolve({ stream, revision: "owner/repo:B:B" });
  await new Promise((done) => setImmediate(done));
  assert.equal(cancelled, true);
  assert.equal(app.workers[0].terminated, true);
  assert.equal(app.workers[0].request, undefined);
});

test("a preload is discarded when a live update has already changed the page revision", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const app = fixture({ initial: "owner/repo:A:A", latest: "owner/repo:B:B", preload: Promise.resolve({ stream, revision: "owner/repo:A:A" }) });
  app.mount();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(app.workers[0].request.stream, undefined);
});
