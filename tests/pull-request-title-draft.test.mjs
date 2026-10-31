import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { draftStatus } from "../src/lib/pull-request-draft.ts";

function fixture() {
  const state = [];
  let index = 0;
  const live = { workspace: { details: { title: "Original" } }, publish() {} };
  const requests = [];
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: { useState(initial) { const slot = index++; if (!(slot in state)) state[slot] = initial; return [state[slot], (value) => { state[slot] = value; }]; } },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "lucide-react": { Pencil() {} },
    "@/components/pull-request-live": { usePullRequestLive: () => live },
    "@/lib/pull-request-draft": { draftStatus },
  };
  const source = readFileSync(new URL("../src/components/pull-request-title.tsx", import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(output, { exports, require: (name) => modules[name], document: {}, fetch: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({}) };
  } });
  const render = () => { index = 0; return exports.PullRequestTitle({ initialTitle: "Original", source: ["owner", "repo", "pull", "1"] }); };
  const edit = () => { render().props.children.props.onClick(); return render(); };
  const blur = (form) => form.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null });
  return { blur, edit, live, render, requests };
}

test("blurring an untouched editor after a remote title change does not save", () => {
  const app = fixture();
  app.edit();
  app.live.workspace.details.title = "Remote";
  app.blur(app.render());
  assert.equal(app.requests.length, 0);
  assert.equal(app.render().type, "h1");
});

test("a remote title change keeps a local draft and prevents blur or form submission", () => {
  const app = fixture();
  app.edit().props.children[0].props.onChange({ target: { value: "Local" } });
  app.live.workspace.details.title = "Remote";
  const form = app.render();
  app.blur(form);
  form.props.onSubmit({ preventDefault() {} });
  assert.equal(app.requests.length, 0);
  assert.equal(app.render().props.children[0].props.value, "Local");
  assert.equal(app.render().props.children[1].props.disabled, true);
  assert.ok(app.render().props.children.some((child) => child?.props?.role === "alert"));
});

test("a changed title saves when the remote value is unchanged", () => {
  const app = fixture();
  app.edit().props.children[0].props.onChange({ target: { value: "Local" } });
  app.render().props.onSubmit({ preventDefault() {} });
  assert.deepEqual(app.requests, [{ action: "edit-title", expected: "Original", title: "Local" }]);
});
