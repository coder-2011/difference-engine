"use client";

import type { CodeViewItem } from "@pierre/diffs";
import { Editor, type EditorOptions } from "@pierre/diffs/edit";
import { parsePatchFiles } from "@pierre/diffs";
import { CodeView, EditProvider, WorkerPoolContext, type CodeViewHandle, type CodeViewReactOptions, type CreateEditor } from "@pierre/diffs/react";
import { useEffect, useMemo, useRef } from "react";
import { getDiffWorkerPool } from "@/lib/diff-worker-pool";

const PATCH = [
  "diff --git a/src/sample.ts b/src/sample.ts",
  "index 1111111..2222222 100644",
  "--- a/src/sample.ts",
  "+++ b/src/sample.ts",
  "@@ -5,3 +5,3 @@ export function alpha() {",
  " const keepA = 1;",
  "-const removed = 2;",
  "+const added = 2;",
  " const keepB = 3;",
  "@@ -20,2 +20,3 @@ export function beta() {",
  " const tailA = 10;",
  "+const tailNew = 11;",
  " const tailB = 12;",
].join("\n");

const createDiffEditor: CreateEditor<undefined> = (options: EditorOptions<undefined>) => new Editor(options);

export default function TestExpandPage() {
  const viewerRef = useRef<CodeViewHandle<undefined>>(null);
  const workerPool = useMemo(() => getDiffWorkerPool(), []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const instance = (viewerRef.current as { getInstance?: () => unknown } | null)?.getInstance?.();
      console.log("[test] instance:", instance == null ? "null" : "present");
      // SAFETY: diagnostic page only.
      const container = document.querySelector("main > div:last-of-type > div") as HTMLElement | null;
      console.log("[test] container children:", container?.childElementCount, "shadow:", container?.shadowRoot != null);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, []);
  const items = useMemo<CodeViewItem[]>(() => {
    const [parsed] = parsePatchFiles(PATCH, "test", true);
    return parsed.files.map((file) => ({
      id: file.name,
      type: "diff" as const,
      fileDiff: file,
      collapsed: false,
    }));
  }, []);
  const options = useMemo<CodeViewReactOptions<undefined>>(() => ({
    diffStyle: "split",
    diffIndicators: "bars",
    collapsedContextThreshold: 0,
    expansionLineCount: Number.POSITIVE_INFINITY,
    hunkSeparators: "line-info",
    lineDiffType: "word-alt",
    overflow: "scroll",
    preferredHighlighter: "shiki-js",
    stickyHeaders: true,
    theme: "pierre-dark",
    themeType: "dark",
    loadDiffFiles: async () => ({
      oldFile: { name: "src/sample.ts", contents: Array.from({ length: 30 }, (_, i) => `const filler${i} = ${i};`).join("\n") },
      newFile: { name: "src/sample.ts", contents: Array.from({ length: 31 }, (_, i) => `const filler${i} = ${i};`).join("\n") },
    }),
    unsafeCSS: `
      [data-expand-index] [data-expand-button] [data-icon] { display: none; }
      [data-expand-index] [data-expand-button]::before {
        content: "▸";
        font-size: 20px;
        line-height: 1;
        transition: transform 100ms ease-out;
      }
    `,
  }), []);

  return (
    <main style={{ background: "#000", color: "#fff", minHeight: "100vh" }}>
      <button
        id="expand-first"
        onClick={() => {
          const root = document.querySelector("diffs-container");
          const button = root?.shadowRoot?.querySelector("[data-expand-button]");
          if (button instanceof HTMLElement) {
            const nested = button.shadowRoot ?? null;
            (nested ?? button).dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
          }
        }}
        type="button"
      >
        expand first separator
      </button>
      <div data-count-before id="count" />
      <div style={{ "--diffs-font-size": "13px" } as React.CSSProperties}>
        <WorkerPoolContext.Provider value={workerPool}>
          <EditProvider createEditor={createDiffEditor}>
            <CodeView ref={viewerRef} items={items} options={options} />
          </EditProvider>
        </WorkerPoolContext.Provider>
      </div>
    </main>
  );
}
