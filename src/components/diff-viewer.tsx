"use client";

import type { CodeViewItem, CodeViewLineSelection, CodeViewOptions, FileDiffMetadata } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type { GitStatus, GitStatusEntry } from "@pierre/trees";
import { getFiletypeFromFileName, preloadHighlighter } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { ChevronDown, ChevronRight, ClipboardCopy, Columns2, FileText, LoaderCircle, Network, PanelLeftClose, PanelLeftOpen, Rows3 } from "lucide-react";
import dynamic from "next/dynamic";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { configureDiffHighlighting } from "@/lib/diff-highlighting";
import { CallDiffViewer, type CallDiffSelection } from "./call-diff-viewer";
import { RepositoryCompare } from "./repository-compare";
import { RepositorySearch } from "./repository-search";
import type { RepositoryFile } from "@/types/github";
import type { ProgrammaticSelection } from "./selection-question";

// Keep the Markdown chat bundle out of reviews that have no OpenAI session.
const SelectionQuestion = dynamic(
  () => import("./selection-question").then((module) => module.SelectionQuestion),
  { ssr: false },
);

type DiffViewerProps = {
  additions?: number;
  changedFiles?: number;
  defaultBranch?: string;
  deletions?: number;
  filePath?: string;
  openAIConnected: boolean;
  repositoryRef?: string;
  source: string[];
};

type CodeLocation = {
  endLineNumber?: number;
  endSide?: "additions" | "deletions";
  id: string;
  lineNumber: number;
  side?: "additions" | "deletions";
};

const EMPTY_FILES: FileDiffMetadata[] = [];
const EMPTY_REPOSITORY_FILES: RepositoryFile[] = [];
const DEFAULT_CODE_FONT_SIZE = 13;
const MAX_CODE_FONT_SIZE = 24;

configureDiffHighlighting();

/** Maps Diffs' change vocabulary onto Trees' git-status vocabulary. */
function gitStatusForFile(file: FileDiffMetadata): GitStatus {
  if (file.type === "new") return "added";
  if (file.type === "deleted") return "deleted";
  if (file.type.startsWith("rename")) return "renamed";
  return "modified";
}

/** Parses the standard GitHub single-line or line-range hash. */
function lineRangeFromHash(hash: string): { end: number; start: number } | null {
  const match = hash.match(/^#L([1-9]\d*)(?:-L([1-9]\d*))?$/);
  if (!match) return null;

  const start = Number(match[1]);
  const end = Math.max(start, Number(match[2] ?? start));
  return { end, start };
}

/** Formats one repository file and selected range as a shareable viewer URL. */
function repositoryFileUrl(source: string[], repositoryRef: string, filePath: string, start?: number, end?: number): string {
  const repository = source.slice(0, 2).map(encodeURIComponent).join("/");
  const path = filePath.split("/").map(encodeURIComponent).join("/");
  const lineHash = start ? `#L${start}${end && end !== start ? `-L${end}` : ""}` : "";
  return `/${repository}/blob/${encodeURIComponent(repositoryRef)}/${path}${lineHash}`;
}

/** Fetches, parses, navigates, and renders the full GitHub patch. */
export function DiffViewer({
  additions,
  changedFiles,
  defaultBranch,
  deletions,
  filePath,
  openAIConnected,
  repositoryRef,
  source,
}: DiffViewerProps) {
  const repository = defaultBranch !== undefined;
  const callDiffAvailable = source[2] === "compare" || source[2] === "pull";
  const [parsedFiles, setParsedFiles] = useState<FileDiffMetadata[]>();
  const [repositoryFiles, setRepositoryFiles] = useState<RepositoryFile[]>();
  const [error, setError] = useState("");
  const [split, setSplit] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [codeFontSize, setCodeFontSize] = useState(DEFAULT_CODE_FONT_SIZE);
  const [rawDiffCopyStatus, setRawDiffCopyStatus] = useState("");
  const [reviewView, setReviewView] = useState<"call-flow" | "files">("files");
  // Retain completed analysis for the current source without carrying it to the next review.
  const [loadedCallFlowSource, setLoadedCallFlowSource] = useState<string>();
  const [callFlowFile, setCallFlowFile] = useState<string>();
  const [callFlowSelection, setCallFlowSelection] = useState<ProgrammaticSelection>();
  const viewerRef = useRef<CodeViewHandle<undefined>>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const reviewViewRef = useRef(reviewView);
  const sourceKey = source.join("\0");
  const callFlowLoaded = loadedCallFlowSource === sourceKey;

  // FileTree retains its first callback, so keep the current tab in a ref for its selection handler.
  useEffect(() => {
    reviewViewRef.current = reviewView;
  }, [reviewView]);

  // A file selected in one review must never constrain Call Flow in the next review.
  useEffect(() => {
    setCallFlowFile(undefined);
  }, [sourceKey]);

  useEffect(() => {
    const worker = new Worker(new URL("../workers/parse-diff.worker.ts", import.meta.url));
    const path = source.map(encodeURIComponent).join("/");
    let grammarPreloadStarted = false;

    setError("");
    setParsedFiles(undefined);
    setRepositoryFiles(undefined);

    /** Starts the first needed grammar load without delaying already-parsed files. */
    function preloadInitialGrammar<T extends { lang?: FileDiffMetadata["lang"]; name: string }>(files: T[]): void {
      if (grammarPreloadStarted) return;

      const target = (filePath ? files.find((file) => file.name === filePath) : undefined) ?? files[0];
      if (!target) return;

      grammarPreloadStarted = true;
      void preloadHighlighter({
        langs: [target.lang ?? getFiletypeFromFileName(target.name)],
        preferredHighlighter: "shiki-wasm",
        themes: ["pierre-dark"],
      }).catch(() => {
        // CodeView still renders plain code if the initial grammar cannot preload.
      });
    }

    /** Appends source-ordered streamed diff files and completes an empty patch. */
    function appendParsedFiles(files: FileDiffMetadata[], complete: boolean): void {
      if (files.length) {
        preloadInitialGrammar(files);
        setParsedFiles((previous) => previous === undefined ? files : [...previous, ...files]);
        return;
      }

      if (complete) setParsedFiles((previous) => previous ?? []);
    }

    /** Receives parsed files without blocking the main browser thread. */
    function handleMessage(event: MessageEvent<{ complete?: boolean; error?: string; files?: FileDiffMetadata[]; repositoryFiles?: RepositoryFile[] }>): void {
      if (event.data.error) {
        setError(event.data.error);
      } else if (repository) {
        const files = event.data.repositoryFiles ?? [];
        preloadInitialGrammar(files);
        setRepositoryFiles(files);
      } else {
        appendParsedFiles(event.data.files ?? [], event.data.complete ?? false);
      }
    }

    /** Reports worker failures that occur before a structured response is available. */
    function handleError(): void {
      setError("The diff could not be parsed");
    }

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.postMessage({ cacheKey: source.join("/"), repository, url: `/api/diff/${path}` });

    return () => {
      worker.terminate();
    };
  }, [filePath, repository, source]);

  const diffFiles = parsedFiles ?? EMPTY_FILES;
  const codeFiles = repositoryFiles ?? EMPTY_REPOSITORY_FILES;
  const files = repository ? codeFiles : diffFiles;
  const paths = useMemo(() => files.map((file) => file.name), [files]);
  const gitStatus = useMemo<GitStatusEntry[]>(
    () => repository ? [] : diffFiles.map((file) => ({ path: file.name, status: gitStatusForFile(file) })),
    [diffFiles, repository],
  );

  /** Selects and centers a saved code line even after virtualization replaced its DOM nodes. */
  const revealSelection = useCallback((location: CodeLocation) => {
    /** Reveals a saved Call Flow reference in Files Changed after the selected tab has mounted. */
    function selectCode(): void {
      const end = location.endLineNumber ?? location.lineNumber;
      const range = { start: location.lineNumber, end, side: location.side, endSide: location.endSide ?? location.side };
      viewerRef.current?.setSelectedLines({ id: location.id, range });
      viewerRef.current?.scrollTo({ type: "line", ...location, align: "center", behavior: "smooth" });
    }

    if (reviewView === "call-flow") {
      setReviewView("files");
      window.requestAnimationFrame(selectCode);
      return;
    }
    selectCode();
  }, [reviewView]);

  /** Converts one Call Flow click into the same source-anchored selection used by Ask Diffs. */
  const selectCallFlowNode = useCallback((selection: CallDiffSelection) => {
    setCallFlowSelection({
      location: { id: selection.file, lineNumber: selection.line },
      text: selection.text,
      x: selection.x,
      y: selection.y,
    });
  }, []);

  /** Opens a repository search result and writes its file and line into the URL. */
  const revealRepositoryResult = useCallback((result: { lineNumber?: number; path: string }) => {
    if (!repositoryRef) return;

    if (result.lineNumber) {
      revealSelection({ id: result.path, lineNumber: result.lineNumber });
    } else {
      viewerRef.current?.scrollTo({ type: "item", id: result.path, align: "start", behavior: "smooth" });
    }

    const nextUrl = repositoryFileUrl(source, repositoryRef, result.path, result.lineNumber);
    window.history.replaceState(window.history.state, "", nextUrl);
  }, [repositoryRef, revealSelection, source]);

  /** Keeps a user-selected repository line range in the browser's shareable URL. */
  const rememberRepositorySelection = useCallback((selection: CodeViewLineSelection | null) => {
    if (!repositoryRef || !selection) return;

    const nextUrl = repositoryFileUrl(
      source,
      repositoryRef,
      selection.id,
      selection.range.start,
      selection.range.end,
    );
    window.history.replaceState(window.history.state, "", nextUrl);
  }, [repositoryRef, source]);

  /** Moves Files Changed to a selected file or narrows Call Flow to paths that touch it. */
  const selectFile = useCallback((selectedPaths: readonly string[]) => {
    const path = selectedPaths.at(-1);
    if (!path) return;

    if (reviewViewRef.current === "call-flow") {
      setCallFlowFile(path);
      return;
    }

    viewerRef.current?.scrollTo({ type: "item", id: path, align: "start", behavior: "smooth" });
  }, []);

  useEffect(() => {
    /** Enlarges code only when the keyboard focus is outside the Ask Diffs panel. */
    function increaseCodeFont(event: KeyboardEvent): void {
      const target = event.target;
      const isChatTarget = target instanceof Element && Boolean(target.closest(".question-panel"));
      const isCommandPlus = event.metaKey && !event.altKey && !event.ctrlKey && (event.key === "+" || event.key === "=");

      if (!isCommandPlus || isChatTarget) return;
      event.preventDefault();
      setCodeFontSize((size) => Math.min(size + 1, MAX_CODE_FONT_SIZE));
    }

    window.addEventListener("keydown", increaseCodeFont);
    return () => window.removeEventListener("keydown", increaseCodeFont);
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
    const selectedPath = filePath && paths.includes(filePath) ? filePath : paths[0];
    if (selectedPath) model.getItem(selectedPath)?.select();
  }, [filePath, gitStatus, model, paths]);

  useEffect(() => {
    if (reviewView !== "files" || !callFlowFile) return;

    // CodeView remounts after changing tabs, so wait for its virtualized items before navigating.
    const frame = window.requestAnimationFrame(() => {
      viewerRef.current?.scrollTo({ type: "item", id: callFlowFile, align: "start", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [callFlowFile, reviewView]);

  useEffect(() => {
    if (!repositoryFiles || !filePath) return;

    const file = repositoryFiles.find((candidate) => candidate.name === filePath);
    if (!file) return;

    const lineRange = lineRangeFromHash(window.location.hash);
    // CodeView installs its virtualized items in a layout effect, so navigate on the next frame.
    const frame = window.requestAnimationFrame(() => {
      if (!lineRange) {
        viewerRef.current?.scrollTo({ type: "item", id: filePath, align: "start" });
        return;
      }

      const lines = file.contents.split("\n");
      // Pierre does not render the empty segment after a trailing newline.
      const lineCount = Math.max(1, lines.length - Number(file.contents.endsWith("\n")));
      const start = Math.min(lineRange.start, lineCount);
      const end = Math.min(Math.max(start, lineRange.end), lineCount);
      revealSelection({ endLineNumber: end, id: filePath, lineNumber: start });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [filePath, repositoryFiles, revealSelection]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;

    /** Hands downward wheel movement to the page until the review header is above the diff. */
    const revealWorkspace = (event: WheelEvent): void => {
      if (event.target instanceof Element && event.target.closest(".question-panel")) return;
      if (event.deltaY <= 0 || workspace.getBoundingClientRect().top <= 51) return;
      event.preventDefault();
      window.scrollBy({ top: event.deltaY, behavior: "auto" });
    };

    workspace.addEventListener("wheel", revealWorkspace, { capture: true, passive: false });
    return () => workspace.removeEventListener("wheel", revealWorkspace, { capture: true });
  }, []);

  const items = useMemo<CodeViewItem[]>(
    () => repository
      ? codeFiles.map((file) => ({ id: file.name, type: "file", file, collapsed, version: collapsed ? 1 : 0 }))
      : diffFiles.map((file) => ({ id: file.name, type: "diff", fileDiff: file, collapsed, version: collapsed ? 1 : 0 })),
    [codeFiles, collapsed, diffFiles, repository],
  );
  const codeViewOptions = useMemo<CodeViewOptions<undefined>>(() => ({
    diffStyle: split ? "split" : "unified",
    diffIndicators: "bars",
    enableLineSelection: repository,
    // A clicked unchanged-lines separator should reveal its entire collapsed range.
    expansionLineCount: Number.POSITIVE_INFINITY,
    hunkSeparators: "line-info",
    lineDiffType: "word-alt",
    overflow: "scroll",
    preferredHighlighter: "shiki-wasm",
    stickyHeaders: true,
    theme: "pierre-dark",
    themeType: "dark",
    // Pierre renders separators in a shadow root, so make each hidden range's disclosure state explicit there.
    unsafeCSS: `
      [data-expand-index] [data-expand-button] [data-icon] { display: none; }
      [data-expand-index] [data-expand-button]::before {
        content: "▸";
        transition: transform 100ms ease-out;
      }
      [data-expand-index] [data-expand-button]:active::before { transform: rotate(90deg); }
    `,
  }), [repository, split]);
  const displayedFileCount = Math.max(changedFiles ?? 0, files.length);
  const showingCallDiff = callDiffAvailable && reviewView === "call-flow";
  const workspaceClass = `diff-workspace${callDiffAvailable ? " has-review-tabs" : ""}`;

  const reviewTabs = callDiffAvailable && (
    <div aria-label="Review view" className="review-tabs" role="tablist">
      <button aria-controls="files-review" aria-selected={!showingCallDiff} id="files-review-tab" onClick={() => setReviewView("files")} role="tab" type="button"><FileText size={13} /> Files changed</button>
      <button aria-controls="call-flow-review" aria-selected={showingCallDiff} id="call-flow-review-tab" onClick={() => { setLoadedCallFlowSource(sourceKey); setReviewView("call-flow"); }} role="tab" type="button"><Network size={13} /> Call flow</button>
    </div>
  );
  const fileSidebar = (
    <aside className="file-sidebar">
      <div className="file-sidebar-title">{repository ? "Files" : "Changed files"} <span>{files.length}</span></div>
      <FileTree model={model} aria-label={repository ? "Files" : "Changed files"} />
    </aside>
  );

  /** Restores the unfiltered Call Flow view and lets the same file be selected again. */
  function clearCallFlowFile(): void {
    if (callFlowFile) model.getItem(callFlowFile)?.deselect();
    setCallFlowFile(undefined);
  }

  /** Fetches and copies the unparsed GitHub patch as plain text. */
  async function copyRawDiff(): Promise<void> {
    const path = source.map(encodeURIComponent).join("/");

    try {
      const response = await fetch(`/api/diff/${path}`);
      if (!response.ok) throw new Error("The diff could not be loaded");

      await navigator.clipboard.writeText(await response.text());
      setRawDiffCopyStatus("Copied");
      window.setTimeout(() => setRawDiffCopyStatus(""), 2_000);
    } catch {
      setRawDiffCopyStatus("Copy failed");
    }
  }

  if (error && !showingCallDiff) {
    return <section className={workspaceClass}>{reviewTabs}<div className="diff-error" id="files-review" role="tabpanel"><strong>Couldn’t load this {repository ? "repository" : "diff"}</strong><span>{error}</span></div></section>;
  }

  if (!showingCallDiff && (repository ? !repositoryFiles : !parsedFiles)) {
    return <section className={workspaceClass}>{reviewTabs}<div className="diff-loading" id="files-review" role="tabpanel"><LoaderCircle className="spinner" size={20} /><strong>Fetching {repository ? "repository" : "diff"}</strong><span>{repository ? "Loading files from GitHub…" : "Streaming the patch from GitHub…"}</span></div></section>;
  }

  return (
    <section className={workspaceClass} ref={workspaceRef}>
      {reviewTabs}
      {callFlowLoaded && (
        <div aria-labelledby="call-flow-review-tab" className={`viewer-body call-flow-body ${sidebarOpen ? "" : "sidebar-closed"}`} hidden={!showingCallDiff} id="call-flow-review" role="tabpanel">
          {showingCallDiff && sidebarOpen && fileSidebar}
          <CallDiffViewer activeFile={callFlowFile} additions={additions} changedFiles={changedFiles} deletions={deletions} onClearFile={clearCallFlowFile} onSelect={openAIConnected ? selectCallFlowNode : undefined} onToggleSidebar={() => setSidebarOpen((open) => !open)} sidebarOpen={sidebarOpen} source={source} />
        </div>
      )}
      {!showingCallDiff && <>
      <div className="viewer-toolbar">
        <div className="change-stats">
          <span><FileText size={13} /> {displayedFileCount} files</span>
          {additions !== undefined && <span className="additions">+{additions.toLocaleString()}</span>}
          {deletions !== undefined && <span className="deletions">−{deletions.toLocaleString()}</span>}
        </div>
        <div className="viewer-actions">
          {repository && repositoryRef && defaultBranch && (
            <div className="repository-tools">
              <RepositorySearch files={codeFiles} onOpenResult={revealRepositoryResult} />
              <RepositoryCompare currentRef={repositoryRef} defaultBranch={defaultBranch} repository={source.slice(0, 2).join("/")} />
            </div>
          )}
          {!repository && (
            <button aria-label="Copy raw diff as plain text" onClick={() => void copyRawDiff()} title="Copy raw diff">
              <ClipboardCopy size={14} /> {rawDiffCopyStatus || "Copy raw diff"}
            </button>
          )}
          <button className="sidebar-toggle" onClick={() => setSidebarOpen((open) => !open)} title="Toggle file tree">
            {sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </button>
          <button className="collapse-toggle" onClick={() => setCollapsed((value) => !value)}>
            {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
            {collapsed ? "Expand" : "Collapse"}
          </button>
          {!repository && (
            <div className="segmented-control">
              <button className={!split ? "active" : ""} onClick={() => setSplit(false)} title="Unified view"><Rows3 size={14} /></button>
              <button className={split ? "active" : ""} onClick={() => setSplit(true)} title="Split view"><Columns2 size={14} /></button>
            </div>
          )}
        </div>
      </div>

      <div aria-labelledby="files-review-tab" className={`viewer-body ${sidebarOpen ? "" : "sidebar-closed"}`} id="files-review" role="tabpanel">
        {sidebarOpen && fileSidebar}
        <div
          className="code-view-shell"
          data-diff-selection-root
          style={{ "--diffs-font-size": `${codeFontSize}px` } as CSSProperties}
        >
          <CodeView
            ref={viewerRef}
            items={items}
            onSelectedLinesChange={repository ? rememberRepositorySelection : undefined}
            options={codeViewOptions}
          />
        </div>
      </div>
      </>}
      {openAIConnected && <SelectionQuestion onRevealSelection={revealSelection} programmaticSelection={callFlowSelection} source={source} />}
    </section>
  );
}
