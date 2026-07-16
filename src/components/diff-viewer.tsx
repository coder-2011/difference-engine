"use client";

import type { CodeViewDiffItem, CodeViewHandle, FileDiffMetadata } from "@pierre/diffs/react";
import type { GitStatus, GitStatusEntry } from "@pierre/trees";
import { getFiletypeFromFileName, preloadHighlighter } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { ChevronDown, ChevronRight, Columns2, FileText, LoaderCircle, PanelLeftClose, PanelLeftOpen, Rows3 } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Keep the Markdown chat bundle out of reviews that have no OpenAI session.
const SelectionQuestion = dynamic(
  () => import("./selection-question").then((module) => module.SelectionQuestion),
  { ssr: false },
);

type DiffViewerProps = {
  additions?: number;
  changedFiles?: number;
  deletions?: number;
  openAIConnected: boolean;
  source: string[];
};

const EMPTY_FILES: FileDiffMetadata[] = [];

/** Maps Diffs' change vocabulary onto Trees' git-status vocabulary. */
function gitStatusForFile(file: FileDiffMetadata): GitStatus {
  if (file.type === "new") return "added";
  if (file.type === "deleted") return "deleted";
  if (file.type.startsWith("rename")) return "renamed";
  return "modified";
}

/** Fetches, parses, navigates, and renders the full GitHub patch. */
export function DiffViewer({ additions, changedFiles, deletions, openAIConnected, source }: DiffViewerProps) {
  const [parsedFiles, setParsedFiles] = useState<FileDiffMetadata[]>();
  const [error, setError] = useState("");
  const [split, setSplit] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const viewerRef = useRef<CodeViewHandle<undefined>>(null);
  const workspaceRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const worker = new Worker(new URL("../workers/parse-diff.worker.ts", import.meta.url));
    const path = source.map(encodeURIComponent).join("/");
    let cancelled = false;

    /** Preloads every file grammar so the viewer's first visible render is syntax-highlighted. */
    async function showParsedFiles(files: FileDiffMetadata[]): Promise<void> {
      const langs = [...new Set(files.map((file) => file.lang ?? getFiletypeFromFileName(file.name)))];
      try {
        await preloadHighlighter({ langs, preferredHighlighter: "shiki-wasm", themes: ["pierre-dark"] });
      } catch {
        // CodeView still renders plain code if a grammar fails to preload.
      }
      if (!cancelled) setParsedFiles(files);
    }

    /** Receives parsed files without blocking the main browser thread. */
    function handleMessage(event: MessageEvent<{ error?: string; files?: FileDiffMetadata[] }>): void {
      if (event.data.error) {
        setError(event.data.error);
      } else {
        void showParsedFiles(event.data.files ?? []);
      }
    }

    /** Reports worker failures that occur before a structured response is available. */
    function handleError(): void {
      setError("The diff could not be parsed");
    }

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.postMessage({ cacheKey: source.join("/"), url: `/api/diff/${path}` });

    return () => {
      cancelled = true;
      worker.terminate();
    };
  }, [source]);

  const files = parsedFiles ?? EMPTY_FILES;
  const paths = useMemo(() => files.map((file) => file.name), [files]);
  const gitStatus = useMemo<GitStatusEntry[]>(
    () => files.map((file) => ({ path: file.name, status: gitStatusForFile(file) })),
    [files],
  );

  /** Moves the virtualized code view to the file chosen in the tree. */
  const selectFile = useCallback((selectedPaths: readonly string[]) => {
    const path = selectedPaths.at(-1);
    if (!path) return;
    viewerRef.current?.scrollTo({ type: "item", id: path, align: "start", behavior: "smooth" });
  }, []);

  const { model } = useFileTree({
    paths,
    gitStatus,
    initialExpansion: "open",
    onSelectionChange: selectFile,
    density: "compact",
    flattenEmptyDirectories: true,
  });

  // useFileTree creates its model once, so populate it after the worker returns.
  useEffect(() => {
    model.resetPaths(paths);
    model.setGitStatus(gitStatus);
    if (paths[0]) model.getItem(paths[0])?.select();
  }, [gitStatus, model, paths]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;

    /** Hands downward wheel movement to the page until the review header is above the diff. */
    const revealWorkspace = (event: WheelEvent): void => {
      if (event.deltaY <= 0 || workspace.getBoundingClientRect().top <= 51) return;
      event.preventDefault();
      window.scrollBy({ top: event.deltaY, behavior: "auto" });
    };

    workspace.addEventListener("wheel", revealWorkspace, { capture: true, passive: false });
    return () => workspace.removeEventListener("wheel", revealWorkspace, { capture: true });
  }, []);

  const items = useMemo<CodeViewDiffItem[]>(
    () => files.map((file) => ({ id: file.name, type: "diff", fileDiff: file, collapsed, version: collapsed ? 1 : 0 })),
    [collapsed, files],
  );
  const displayedFileCount = Math.max(changedFiles ?? 0, files.length);

  if (error) {
    return <div className="diff-error"><strong>Couldn’t load this diff</strong><span>{error}</span></div>;
  }

  if (!parsedFiles) {
    return <div className="diff-loading"><LoaderCircle className="spinner" size={20} /><strong>Fetching diff</strong><span>Streaming the patch from GitHub…</span></div>;
  }

  return (
    <section className="diff-workspace" ref={workspaceRef}>
      <div className="viewer-toolbar">
        <div className="change-stats">
          <span><FileText size={13} /> {displayedFileCount} files</span>
          {additions !== undefined && <span className="additions">+{additions.toLocaleString()}</span>}
          {deletions !== undefined && <span className="deletions">−{deletions.toLocaleString()}</span>}
        </div>
        <div className="viewer-actions">
          <button onClick={() => setSidebarOpen((open) => !open)} title="Toggle file tree">
            {sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </button>
          <button onClick={() => setCollapsed((value) => !value)}>
            {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
            {collapsed ? "Expand" : "Collapse"}
          </button>
          <div className="segmented-control">
            <button className={!split ? "active" : ""} onClick={() => setSplit(false)} title="Unified view"><Rows3 size={14} /></button>
            <button className={split ? "active" : ""} onClick={() => setSplit(true)} title="Split view"><Columns2 size={14} /></button>
          </div>
        </div>
      </div>

      <div className={`viewer-body ${sidebarOpen ? "" : "sidebar-closed"}`}>
        {sidebarOpen && (
          <aside className="file-sidebar">
            <div className="file-sidebar-title">Changed files <span>{files.length}</span></div>
            <FileTree model={model} aria-label="Changed files" />
          </aside>
        )}
        <div className="code-view-shell" data-diff-selection-root>
          <CodeView
            ref={viewerRef}
            items={items}
            options={{
              diffStyle: split ? "split" : "unified",
              diffIndicators: "bars",
              hunkSeparators: "line-info",
              lineDiffType: "word-alt",
              overflow: "scroll",
              preferredHighlighter: "shiki-wasm",
              stickyHeaders: true,
              theme: "pierre-dark",
              themeType: "dark",
            }}
          />
          {openAIConnected && <SelectionQuestion source={source} />}
        </div>
      </div>
    </section>
  );
}
