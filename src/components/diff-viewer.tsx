"use client";

import type { CodeViewItem, CodeViewLineSelection, CodeViewOptions, FileDiffMetadata } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type { GitStatus, GitStatusEntry } from "@pierre/trees";
import { getFiletypeFromFileName, preloadHighlighter } from "@pierre/diffs";
import { CodeView, WorkerPoolContext } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { Check, ChevronDown, ChevronRight, ClipboardCopy, Columns2, FileText, GitCommitHorizontal, LoaderCircle, Network, PanelLeftClose, PanelLeftOpen, Pencil, Rows3, Sparkles } from "lucide-react";
import dynamic from "next/dynamic";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { configureDiffHighlighting } from "@/lib/diff-highlighting";
import { getDiffWorkerPool } from "@/lib/diff-worker-pool";
import { CallDiffViewer, type CallDiffSelection } from "./call-diff-viewer";
import { RepositoryCompare } from "./repository-compare";
import { RepositorySearch } from "./repository-search";
import type { PullRequestReviewThread, RepositoryFile } from "@/types/github";
import type { ChatMarker, ChatResumeRequest, LocalAnnotationMarker, ProgrammaticSelection } from "./selection-question";

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
  githubConnected: boolean;
  openAIConnected: boolean;
  repositoryRef?: string;
  reviewThreads?: PullRequestReviewThread[];
  source: string[];
};

type CodeLocation = {
  endLineNumber?: number;
  endSide?: "additions" | "deletions";
  id: string;
  lineNumber: number;
  side?: "additions" | "deletions";
};

type InlineCommentMarker = {
  chatId?: string;
  endLine: number;
  id: string;
  lane?: number;
  markerId?: string;
  path: string;
  side: "additions" | "deletions";
  startLine: number;
  tone: "chat" | "github" | "local";
};

type DiffViewerStyle = CSSProperties & { "--diffs-font-size": string };

const EMPTY_FILES: FileDiffMetadata[] = [];
const EMPTY_REPOSITORY_FILES: RepositoryFile[] = [];
const EMPTY_REVIEW_THREADS: PullRequestReviewThread[] = [];
const CALL_FLOW_EAGER_LOAD_LIMIT = 100_000;
// Keep the selected client-side review surface shareable without changing the server route.
const REVIEW_TAB_HASH = { "call-flow": "#call-flow", files: "#files-changed" } as const;
const DEFAULT_CODE_FONT_SIZE = 13;
const MAX_CODE_FONT_SIZE = 24;

type ReviewView = keyof typeof REVIEW_TAB_HASH;

const INLINE_COMMENT_MARKER_CSS = `
  [data-column-number] > .diffs-inline-comment-marker {
    --diffs-inline-comment-color: #3f7199;
    background: var(--diffs-inline-comment-color);
    bottom: 0;
    left: var(--diffs-inline-comment-offset, 0px);
    pointer-events: none;
    position: absolute;
    top: 0;
    width: 3px;
    z-index: 4;
  }

  [data-column-number] > .diffs-inline-comment-marker[data-tone="github"] {
    --diffs-inline-comment-color: #3f7952;
  }

  [data-column-number] > .diffs-inline-comment-marker[data-tone="chat"] {
    --diffs-inline-comment-color: #765da3;
    appearance: none;
    border: 0;
    cursor: pointer;
    padding: 0;
    pointer-events: auto;
  }

  [data-column-number] > .diffs-inline-comment-marker[data-position="start"] {
    top: 50%;
  }

  [data-column-number] > .diffs-inline-comment-marker[data-position="end"] {
    bottom: 50%;
  }
`;

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

/** Creates one vertical marker range, splitting selections that cross diff sides. */
function commentRangeMarkers(id: string, path: string, startLine: number, endLine: number, startSide: "additions" | "deletions" | undefined, endSide: "additions" | "deletions" | undefined, tone: InlineCommentMarker["tone"], chatId?: string, markerId?: string): InlineCommentMarker[] {
  const start = Math.min(startLine, endLine);
  const side = startSide ?? endSide ?? "additions";
  const end = Math.max(startLine, endLine);
  if (!startSide || !endSide || startSide === endSide || start === end) {
    return [{ chatId, endLine: end, id, markerId, path, side, startLine: start, tone }];
  }

  return [
    { chatId, endLine: start, id: `${id}-start`, markerId, path, side: startSide, startLine: start, tone },
    { chatId, endLine: end, id: `${id}-end`, markerId, path, side: endSide, startLine: end, tone },
  ];
}

/** Returns the visual segment that a marker contributes to one rendered line. */
function markerPosition(marker: InlineCommentMarker, lineNumber: number): "end" | "middle" | "single" | "start" | null {
  if (lineNumber < marker.startLine || lineNumber > marker.endLine) return null;
  if (marker.startLine === marker.endLine) return "single";
  if (lineNumber === marker.startLine) return "start";
  if (lineNumber === marker.endLine) return "end";
  return "middle";
}

/** Packs only overlapping ranges into adjacent gutter lanes, keeping unrelated markers close to the code. */
function assignMarkerLanes(markers: InlineCommentMarker[]): InlineCommentMarker[] {
  const laneEndsBySide = new Map<InlineCommentMarker["side"], number[]>();
  return [...markers]
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)
    .map((marker) => {
      const laneEnds = laneEndsBySide.get(marker.side) ?? [];
      const reusableLane = laneEnds.findIndex((endLine) => endLine < marker.startLine);
      const lane = reusableLane === -1 ? laneEnds.length : reusableLane;
      laneEnds[lane] = marker.endLine;
      laneEndsBySide.set(marker.side, laneEnds);
      return { ...marker, lane };
    });
}

/** Maps tab fragments and existing source-line fragments onto a review tab. */
function reviewViewFromHash(hash: string): ReviewView {
  return hash === REVIEW_TAB_HASH["call-flow"] ? "call-flow" : "files";
}

/** Fetches, parses, navigates, and renders the full GitHub patch. */
export function DiffViewer({
  additions,
  changedFiles,
  defaultBranch,
  deletions,
  filePath,
  githubConnected,
  openAIConnected,
  repositoryRef,
  reviewThreads = EMPTY_REVIEW_THREADS,
  source,
}: DiffViewerProps) {
  const repository = defaultBranch !== undefined;
  const callDiffAvailable = source[2] === "compare" || source[2] === "pull";
  const sourceKey = source.join("\0");
  const changedLineCount = additions !== undefined && deletions !== undefined ? additions + deletions : undefined;
  // Background analysis stays bounded by the PR's known changed-line total.
  const eagerCallFlow = callDiffAvailable && changedLineCount !== undefined && changedLineCount <= CALL_FLOW_EAGER_LOAD_LIMIT;
  const [parsedFiles, setParsedFiles] = useState<FileDiffMetadata[]>();
  const [repositoryFiles, setRepositoryFiles] = useState<RepositoryFile[]>();
  const [error, setError] = useState("");
  const [split, setSplit] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [codeFontSize, setCodeFontSize] = useState(DEFAULT_CODE_FONT_SIZE);
  const [rawDiffCopyStatus, setRawDiffCopyStatus] = useState("");
  const [reviewView, setReviewView] = useState<ReviewView>("files");
  // Retain completed analysis for the current source without carrying it to the next review.
  const [loadedCallFlowSource, setLoadedCallFlowSource] = useState<string>();
  const [callFlowSelection, setCallFlowSelection] = useState<ProgrammaticSelection>();
  const [localAnnotations, setLocalAnnotations] = useState<LocalAnnotationMarker[]>([]);
  const [chatMarkers, setChatMarkers] = useState<ChatMarker[]>([]);
  const [resumeChat, setResumeChat] = useState<ChatResumeRequest>();
  const [editMode, setEditMode] = useState(false);
  const [editedFileCount, setEditedFileCount] = useState(0);
  const [committing, setCommitting] = useState(false);
  const [commitStatus, setCommitStatus] = useState("");
  const editedFilesRef = useRef<Map<string, string>>(new Map());
  const openChatRef = useRef<(() => void) | null>(null);
  const viewerRef = useRef<CodeViewHandle<undefined>>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const reviewViewRef = useRef(reviewView);
  const callFlowLoaded = eagerCallFlow || loadedCallFlowSource === sourceKey;

  /** Commits all live in-memory file edits to GitHub with an auto-generated commit message. */
  const commitChanges = useCallback(async (): Promise<void> => {
    if (committing) return;
    if (editedFilesRef.current.size === 0) {
      setCommitStatus("No changes");
      window.setTimeout(() => setCommitStatus(""), 2000);
      return;
    }
    if (!githubConnected) {
      setCommitStatus("Sign in needed");
      window.setTimeout(() => setCommitStatus(""), 2500);
      return;
    }

    setCommitting(true);
    setCommitStatus("Committing…");

    const files = Array.from(editedFilesRef.current.entries()).map(([path, contents]) => ({
      contents,
      path,
    }));

    const path = source.map(encodeURIComponent).join("/");
    try {
      const response = await fetch(`/api/commit/${path}`, {
        body: JSON.stringify({ files }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || "Commit failed");
      }

      setCommitStatus("Committed!");
      editedFilesRef.current.clear();
      setEditedFileCount(0);
      window.setTimeout(() => setCommitStatus(""), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Commit failed";
      setCommitStatus(message.slice(0, 20));
      window.setTimeout(() => setCommitStatus(""), 3000);
    } finally {
      setCommitting(false);
    }
  }, [committing, githubConnected, source]);

  useEffect(() => {
    let lastKey = "";
    let lastKeyTime = 0;

    /** Handles global keyboard shortcuts for editing (Cmd-Shift-E) and committing (Cmd-D / c+d). */
    const handleKeyDown = (event: KeyboardEvent): void => {
      const isCommand = event.metaKey || event.ctrlKey;
      const isE = event.key === "e" || event.key === "E" || event.code === "KeyE";
      const isD = event.key === "d" || event.key === "D" || event.code === "KeyD";
      const isC = event.key === "c" || event.key === "C" || event.code === "KeyC";
      const isEnter = event.key === "Enter" || event.code === "Enter";

      // Toggle edit mode with Command-Shift-E or Ctrl-Shift-E
      if (isCommand && event.shiftKey && isE) {
        if (reviewViewRef.current === "call-flow") return;
        event.preventDefault();
        event.stopPropagation();
        setEditMode((mode) => {
          if (mode && document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
          return !mode;
        });
        return;
      }

      const target = event.target instanceof HTMLElement ? event.target : null;
      const isInput = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      const isCodeLine = target?.dataset?.editable === "true";

      // Commit shortcut: Command-D / Ctrl-D, Command-Enter / Ctrl-Enter, or c then d chord
      const isCommandCommit = isCommand && (isD || isEnter);
      const now = Date.now();
      const isCSequenceD = !isInput && !isCodeLine && !isCommand && isD && lastKey.toLowerCase() === "c" && (now - lastKeyTime < 1000);

      if (!isInput && !isCodeLine && !isCommand && isC) {
        lastKey = "c";
        lastKeyTime = now;
      } else if (!isC) {
        lastKey = "";
      }

      if (isCommandCommit || isCSequenceD) {
        if (reviewViewRef.current === "call-flow") return;
        event.preventDefault();
        event.stopPropagation();
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        void commitChanges();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [commitChanges]);

  /** Mounts the Call Flow view once so a request can survive a later tab switch. */
  const loadCallFlow = useCallback(() => {
    setLoadedCallFlowSource(sourceKey);
  }, [sourceKey]);

  /** Sends a gutter-marker click back to the chat component with a fresh sequence each time. */
  const resumeChatFromMarker = useCallback((chatId: string, markerId: string) => {
    setResumeChat((current) => ({ chatId, markerId, sequence: (current?.sequence ?? 0) + 1 }));
  }, []);

  /** Selects a review tab and records it without triggering browser anchor scrolling. */
  const selectReviewView = useCallback((view: ReviewView) => {
    if (view === "call-flow") loadCallFlow();
    setReviewView(view);

    const hash = REVIEW_TAB_HASH[view];
    if (window.location.hash !== hash) window.history.pushState(window.history.state, "", hash);
  }, [loadCallFlow]);

  const inlineCommentMarkers = useMemo(() => {
    const localMarkers = localAnnotations.flatMap(({ id, location }) => {
      if (!location) return [];
      return commentRangeMarkers(
        `annotation-${id}`,
        location.id,
        location.lineNumber,
        location.endLineNumber ?? location.lineNumber,
        location.side,
        location.endSide,
        "local",
      );
    });
    const githubMarkers = reviewThreads.flatMap((thread, index) => {
      const endLine = thread.line ?? thread.originalLine;
      if (!endLine) return [];
      const startLine = thread.startLine ?? thread.originalStartLine ?? endLine;
      const side = thread.side === "LEFT" ? "deletions" : "additions";
      return commentRangeMarkers(`review-${thread.id ?? index}`, thread.path, startLine, endLine, side, side, "github");
    });
    const chatRangeMarkers = chatMarkers.flatMap((marker) => commentRangeMarkers(
      `chat-${marker.id}`,
      marker.location.id,
      marker.location.lineNumber,
      marker.location.endLineNumber ?? marker.location.lineNumber,
      marker.location.side,
      marker.location.endSide,
      "chat",
      marker.chatId,
      marker.id,
    ));
    return [...localMarkers, ...githubMarkers, ...chatRangeMarkers];
  }, [chatMarkers, localAnnotations, reviewThreads]);

  const inlineCommentMarkersByFile = useMemo(() => {
    const markersByFile = new Map<string, InlineCommentMarker[]>();
    for (const marker of inlineCommentMarkers) {
      const markers = markersByFile.get(marker.path) ?? [];
      markers.push(marker);
      markersByFile.set(marker.path, markers);
    }
    for (const [path, markers] of markersByFile) {
      markersByFile.set(path, assignMarkerLanes(markers));
    }
    return markersByFile;
  }, [inlineCommentMarkers]);

  // FileTree retains its first callback, so keep the current tab in a ref for its selection handler.
  useEffect(() => {
    reviewViewRef.current = reviewView;
  }, [reviewView]);

  useEffect(() => {
    if (!callDiffAvailable) return;

    /** Restores a tab from a shared URL and follows browser back and forward navigation. */
    function syncReviewView(): void {
      const view = reviewViewFromHash(window.location.hash);
      if (view === "call-flow") loadCallFlow();
      setReviewView(view);
    }

    if (!window.location.hash) window.history.replaceState(window.history.state, "", REVIEW_TAB_HASH.files);
    syncReviewView();
    window.addEventListener("hashchange", syncReviewView);
    return () => window.removeEventListener("hashchange", syncReviewView);
  }, [callDiffAvailable, loadCallFlow]);

  useEffect(() => {
    // DiffPage keys this viewer by source, so a worker always starts from the initial empty state.
    const worker = new Worker(new URL("../workers/parse-diff.worker.ts", import.meta.url));
    const path = source.map(encodeURIComponent).join("/");
    const preloadedLanguages = new Set<string>();

    /** Starts grammar preloads across all unique languages present in parsed files. */
    function preloadInitialGrammar<T extends { lang?: FileDiffMetadata["lang"]; name: string }>(files: T[]): void {
      const newLangs = files
        .map((file) => file.lang ?? getFiletypeFromFileName(file.name))
        .filter((lang): lang is string => Boolean(lang) && !preloadedLanguages.has(lang));

      if (!newLangs.length) return;
      for (const lang of newLangs) preloadedLanguages.add(lang);

      void preloadHighlighter({
        langs: newLangs,
        preferredHighlighter: "shiki-js",
        themes: ["pierre-dark"],
      }).catch(() => {
        // CodeView still renders plain code if an optional grammar cannot preload.
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
      selectReviewView("files");
      window.requestAnimationFrame(selectCode);
      return;
    }
    selectCode();
  }, [reviewView, selectReviewView]);

  useEffect(() => {
    /** Clears the temporary annotation focus when the user clicks anywhere else. */
    function clearRevealedSelection(): void {
      viewerRef.current?.clearSelectedLines();
    }

    document.addEventListener("click", clearRevealedSelection, true);
    return () => document.removeEventListener("click", clearRevealedSelection, true);
  }, []);

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

  /** Moves the active review to a selected file from the persistent file tree. */
  const selectFile = useCallback((selectedPaths: readonly string[]) => {
    const path = selectedPaths.at(-1);
    if (!path) return;

    if (reviewViewRef.current === "call-flow") {
      const card = Array.from(document.querySelectorAll<HTMLElement>("[data-call-diff-file]")).find((element) => element.dataset.callDiffFile === path);
      card?.scrollIntoView({ block: "start", behavior: "smooth" });
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
    // Do not turn Files Changed's initial file into a Call Flow filter while the patch streams.
    if (reviewViewRef.current === "files" && selectedPath) model.getItem(selectedPath)?.select();
  }, [filePath, gitStatus, model, paths]);

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

  const workerPool = useMemo(() => getDiffWorkerPool(), []);

  const items = useMemo<CodeViewItem[]>(
    () => repository
      ? codeFiles.map((file) => ({ id: file.name, type: "file", file, collapsed, version: collapsed ? 1 : 0 }))
      : diffFiles.map((file) => ({ id: file.name, type: "diff", fileDiff: file, collapsed, version: collapsed ? 1 : 0 })),
    [codeFiles, collapsed, diffFiles, repository],
  );
  const codeViewOptions = useMemo<CodeViewOptions<undefined>>(() => ({
    diffStyle: split ? "split" : "unified",
    diffIndicators: "bars",
    enableLineSelection: repository && !editMode,
    // Keep even one unchanged line behind the same user-controlled expander.
    collapsedContextThreshold: 0,
    // A clicked unchanged-lines separator should reveal its entire collapsed range.
    expansionLineCount: Number.POSITIVE_INFINITY,
    hunkSeparators: "line-info",
    lineDiffType: "word-alt",
    overflow: "scroll",
    preferredHighlighter: "shiki-js",
    stickyHeaders: true,
    theme: "pierre-dark",
    themeType: "dark",
    onPostRender: (node, _instance, phase, context) => {
      if (phase === "unmount") return;

      const shadowRoot = node.shadowRoot;
      if (!shadowRoot) return;

      shadowRoot.querySelectorAll(".diffs-inline-comment-marker").forEach((marker) => marker.remove());
      const markers = inlineCommentMarkersByFile.get(context.item.id);
      if (markers?.length) {
        const gutters = [...shadowRoot.querySelectorAll<HTMLElement>("[data-column-number]")];
        for (const marker of markers) {
          for (const gutter of gutters) {
            const lineNumber = Number(gutter.dataset.columnNumber);
            const position = markerPosition(marker, lineNumber);
            if (!position || Number.isNaN(lineNumber)) continue;

            const lineType = gutter.dataset.lineType;
            const column = gutter.closest("[data-code]");
            const side = lineType === "change-deletion" || column?.hasAttribute("data-deletions") ? "deletions" : marker.side;
            if (side !== marker.side) continue;

            const element = document.createElement(marker.tone === "chat" ? "button" : "span");
            element.className = "diffs-inline-comment-marker";
            element.dataset.position = position;
            element.dataset.tone = marker.tone;
            element.style.setProperty("--diffs-inline-comment-offset", `${(marker.lane ?? 0) * 3}px`);
            if (marker.tone === "chat" && marker.chatId && marker.markerId) {
              element.classList.add("diffs-inline-chat-marker");
              element.setAttribute("aria-label", "Resume Ask Diffs chat");
              if (element instanceof HTMLButtonElement) element.type = "button";
              element.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                resumeChatFromMarker(marker.chatId!, marker.markerId!);
              });
            }
            gutter.append(element);
          }
        }
      }

      // Configure in-place editing on code lines when editMode is active
      const lineElements = [...shadowRoot.querySelectorAll<HTMLElement>("[data-content] > [data-line], [data-code] [data-line]")];
      for (const line of lineElements) {
        if (editMode) {
          const isDeletion = line.dataset.lineType === "deletion" || Boolean(line.closest("[data-deletions]"));
          if (!isDeletion) {
            line.contentEditable = "plaintext-only";
            line.spellcheck = false;
            line.dataset.editable = "true";

            line.oninput = () => {
              const filePath = context.item.id;
              let allLines: string[];
              if (repository) {
                allLines = [...shadowRoot.querySelectorAll<HTMLElement>("[data-content] > [data-line]")].map((el) => el.innerText.replace(/\r?\n$/, ""));
              } else if (split) {
                allLines = [...shadowRoot.querySelectorAll<HTMLElement>("[data-additions] [data-content] > [data-line]")].map((el) => el.innerText.replace(/\r?\n$/, ""));
              } else {
                allLines = [...shadowRoot.querySelectorAll<HTMLElement>("[data-unified] [data-content] > [data-line]")]
                  .filter((el) => el.dataset.lineType !== "deletion")
                  .map((el) => el.innerText.replace(/\r?\n$/, ""));
              }
              const currentContent = allLines.join("\n");
              editedFilesRef.current.set(filePath, currentContent);
              setEditedFileCount(editedFilesRef.current.size);
            };

            line.onkeydown = (event) => {
              const isCommand = event.metaKey || event.ctrlKey;
              const isCommandShiftE = isCommand && event.shiftKey && (event.key === "e" || event.key === "E" || event.code === "KeyE");
              const isCommandCommit = isCommand && (event.key === "d" || event.key === "D" || event.code === "KeyD" || event.key === "Enter" || event.code === "Enter");
              if (!isCommandShiftE && !isCommandCommit) {
                event.stopPropagation();
              }
            };
          } else {
            line.contentEditable = "false";
            delete line.dataset.editable;
            line.oninput = null;
            line.onkeydown = null;
          }
        } else {
          line.contentEditable = "false";
          delete line.dataset.editable;
          line.oninput = null;
          line.onkeydown = null;
        }
      }
    },
    // Pierre renders separators in a shadow root, so make each hidden range's disclosure state explicit there.
    unsafeCSS: `
      [data-expand-index] [data-expand-button] [data-icon] { display: none; }
      [data-expand-index] [data-expand-button]::before {
        content: "▸";
        transition: transform 100ms ease-out;
      }
      [data-expand-index] [data-expand-button]:active::before { transform: rotate(90deg); }
      [data-editable="true"] {
        cursor: text !important;
        outline: none;
      }
      [data-editable="true"]:hover {
        background: rgba(255, 255, 255, 0.04);
      }
      [data-editable="true"]:focus {
        background: rgba(88, 166, 255, 0.09);
        box-shadow: inset 2px 0 0 #58a6ff;
      }
      ${INLINE_COMMENT_MARKER_CSS}
    `,
  }), [editMode, inlineCommentMarkersByFile, repository, resumeChatFromMarker, split]);
  const displayedFileCount = Math.max(changedFiles ?? 0, files.length);
  const showingCallDiff = callDiffAvailable && reviewView === "call-flow";
  const workspaceClass = `diff-workspace${callDiffAvailable ? " has-review-tabs" : ""}`;

  const reviewTabs = callDiffAvailable && (
    <div aria-label="Review view" className="review-tabs" role="tablist">
      <button aria-controls="files-review" aria-selected={!showingCallDiff} id="files-review-tab" onClick={() => selectReviewView("files")} role="tab" type="button"><FileText size={13} /> Files changed</button>
      <button aria-controls="call-flow-review" aria-selected={showingCallDiff} id="call-flow-review-tab" onClick={() => selectReviewView("call-flow")} onFocus={loadCallFlow} onPointerEnter={loadCallFlow} role="tab" type="button"><Network size={13} /> Call flow</button>
    </div>
  );
  const fileSidebar = (
    <aside className="file-sidebar" hidden={!sidebarOpen}>
      <div className="file-sidebar-title">{repository ? "Files" : "Changed files"} <span>{files.length}</span></div>
      <FileTree model={model} aria-label={repository ? "Files" : "Changed files"} />
      <div className="annotation-sidebar" />
      <div className={`sidebar-bottom-bar${showingCallDiff ? " single-action" : ""}`}>
        <button
          aria-label="Open Ask Diffs"
          className="sidebar-bottom-action ask-diffs-btn"
          onClick={() => openChatRef.current?.()}
          type="button"
        >
          <Sparkles size={13} />
          <span>Ask Diffs</span>
        </button>
        {!showingCallDiff && (
          <button
            aria-label={`Toggle Edit mode (Command-Shift-E)${editMode ? " - Currently Editing" : ""}`}
            className={`sidebar-bottom-action edit-mode-btn${editMode ? " active" : ""}`}
            onClick={() => setEditMode((mode) => !mode)}
            type="button"
          >
            <Pencil size={13} />
            <span>{editMode ? "Editing" : "Edit"}</span>
            <kbd className="key-hint">⌘⇧E</kbd>
          </button>
        )}
      </div>
    </aside>
  );
  // Keep bounded Call Flow analysis alive behind Files Changed's streaming state.
  const callFlowPanel = callFlowLoaded && (
    <div aria-labelledby="call-flow-review-tab" className={`call-flow-body ${sidebarOpen ? "" : "sidebar-closed"}`} hidden={!showingCallDiff} id="call-flow-review" role="tabpanel">
      {showingCallDiff && fileSidebar}
      <CallDiffViewer key={sourceKey} onSelect={openAIConnected ? selectCallFlowNode : undefined} onToggleSidebar={() => setSidebarOpen((open) => !open)} sidebarOpen={sidebarOpen} source={source} />
    </div>
  );

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
    return <section className={workspaceClass}>{reviewTabs}{callFlowPanel}<div className="diff-error" id="files-review" role="tabpanel"><strong>Couldn’t load this {repository ? "repository" : "diff"}</strong><span>{error}</span></div></section>;
  }

  if (!showingCallDiff && (repository ? !repositoryFiles : !parsedFiles)) {
    return <section className={workspaceClass}>{reviewTabs}{callFlowPanel}<div className="diff-loading" id="files-review" role="tabpanel"><LoaderCircle className="spinner" size={20} /><strong>Fetching {repository ? "repository" : "diff"}</strong><span>{repository ? "Loading files from GitHub…" : "Streaming the patch from GitHub…"}</span></div></section>;
  }

  const codeViewStyle: DiffViewerStyle = { "--diffs-font-size": `${codeFontSize}px` };

  return (
    <section className={workspaceClass} ref={workspaceRef}>
      {reviewTabs}
      {callFlowPanel}
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
          <button
            aria-label="Commit and push changes to GitHub (⌘D / c+d)"
            className={`commit-action${committing ? " committing" : ""}${commitStatus === "Committed!" ? " committed" : ""}`}
            disabled={editedFileCount === 0 || committing}
            onClick={() => void commitChanges()}
            title={editedFileCount === 0 ? "Edit code to commit changes (⌘D / c+d)" : !githubConnected ? "Sign in with GitHub to commit and push" : `Commit and push ${editedFileCount} modified ${editedFileCount === 1 ? "file" : "files"} (⌘D)`}
            type="button"
          >
            {committing ? <LoaderCircle className="spinner" size={13} /> : commitStatus === "Committed!" ? <Check size={13} /> : <GitCommitHorizontal size={13} />}
            <span>{commitStatus || (editedFileCount > 0 ? `Commit (${editedFileCount})` : "Commit")}</span>
            <kbd className="key-hint">⌘D</kbd>
          </button>
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
        {fileSidebar}
        <div
          className="code-view-shell"
          data-diff-selection-root
          style={codeViewStyle}
        >
          <WorkerPoolContext.Provider value={workerPool}>
            <CodeView
              ref={viewerRef}
              items={items}
              onSelectedLinesChange={repository ? rememberRepositorySelection : undefined}
              options={codeViewOptions}
            />
          </WorkerPoolContext.Provider>
        </div>
      </div>
      </>}
      <SelectionQuestion
        aiEnabled={openAIConnected}
        annotationContainerKey={`${reviewView}-${sidebarOpen}`}
        annotationPaths={paths}
        githubConnected={githubConnected}
        onAnnotationsChange={setLocalAnnotations}
        onChatMarkersChange={setChatMarkers}
        onRegisterOpenChat={(fn) => {
          openChatRef.current = fn;
        }}
        onRevealSelection={revealSelection}
        programmaticSelection={callFlowSelection}
        resumeChat={resumeChat}
        source={source}
      />
    </section>
  );
}
