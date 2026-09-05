"use client";

import type { CodeViewItem, CodeViewLineSelection, FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs";
import { Editor, type EditorChangeEvent, type EditorFactory, type EditorOptions, type EditorType } from "@pierre/diffs/edit";
import type { CodeViewHandle, CodeViewItemEditCompleteHandler, CodeViewReactOptions } from "@pierre/diffs/react";
import type { GitStatus, GitStatusEntry } from "@pierre/trees";
import { getFiletypeFromFileName, preloadHighlighter } from "@pierre/diffs";
import { CodeView, EditProvider, WorkerPoolContext } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { Check, ChevronDown, ChevronRight, ChevronUp, ClipboardCopy, Columns2, FileText, GitCommitHorizontal, LoaderCircle, Network, PanelLeftClose, PanelLeftOpen, Pencil, Rows3, Sparkles } from "lucide-react";
import dynamic from "next/dynamic";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { configureDiffHighlighting } from "@/lib/diff-highlighting";
import { takePreloadedDiff } from "@/lib/diff-preload";
import { getDiffWorkerPool } from "@/lib/diff-worker-pool";
import { CallDiffViewer, type CallDiffSelection } from "./call-diff-viewer";
import { PR_WORKSPACE_REFRESH_EVENT } from "./pull-request-workspace";
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
  pullRequestState?: "closed" | "merged" | "open";
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
// Keep the selected client-side review surface shareable without changing the server route.
const REVIEW_TAB_HASH = { "call-flow": "#call-flow", files: "#files-changed" } as const;
const DEFAULT_CODE_FONT_SIZE = 13;
const MAX_CODE_FONT_SIZE = 24;

type ReviewView = keyof typeof REVIEW_TAB_HASH;

const DIFF_VIEWER_CSS = `
  :host {
    /* Keep changed-line fills, emphasis, gutters, and bars darker from one shared palette. */
    --diffs-addition-color-override: #058f5c;
    --diffs-deletion-color-override: #bd2838;
    --diffs-modified-color-override: #0078bd;
  }

  [data-column-number] > .diffs-inline-comment-marker {
    --diffs-inline-comment-color: #3f7199;
    background: var(--diffs-inline-comment-color);
    /* Match Pierre's top: 0 and height: 100% change bar in this same gutter. */
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

  [data-column-number] > .diffs-inline-comment-marker.diffs-inline-chat-marker-cap {
    overflow: visible;
  }

  [data-column-number] > .diffs-inline-comment-marker.diffs-inline-chat-marker-cap::before {
    background: var(--diffs-inline-comment-color);
    border: 1px solid #a895cc;
    border-radius: 999px;
    content: "";
    height: 14px;
    left: 50%;
    position: absolute;
    top: -6px;
    transform: translateX(-50%);
    width: 14px;
    z-index: 1;
  }

  [data-column-number] > .diffs-inline-comment-marker.diffs-inline-chat-marker-cap::after {
    background: #f2effb;
    clip-path: polygon(0 0, 100% 0, 100% 75%, 58% 75%, 36% 100%, 42% 75%, 0 75%);
    content: "";
    height: 7px;
    left: 50%;
    position: absolute;
    top: -2px;
    transform: translateX(-50%);
    width: 8px;
    z-index: 2;
  }

`;

configureDiffHighlighting();

/** Creates the matching Diffs editor for each file or diff item. */
const createDiffEditor: EditorFactory<undefined, undefined> = (editorType, options, editStateKey) => new Editor(editorType, options, editStateKey);

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

/** Reconstructs file text from Pierre patch line arrays, which keep trailing newlines when present. */
function contentsFromDiffLines(lines: string[]): string {
  if (lines.length === 0) return "";
  return lines.some((line) => line.includes("\n")) ? lines.join("") : `${lines.join("\n")}\n`;
}

/** True when a keyboard event originated in Pierre's shadow-DOM contenteditable surface. */
function isPierreEditorEvent(event: Event): boolean {
  return event.composedPath().some((node) => node instanceof HTMLElement && node.isContentEditable);
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

/** Measures the right edge of Pierre's native change bar so custom markers begin immediately beside it. */
function nativeIndicatorRight(gutter: HTMLElement): number {
  const indicator = window.getComputedStyle(gutter, "::before");
  if (indicator.content === "none") return 0;

  const left = Number.parseFloat(indicator.left);
  const width = Number.parseFloat(indicator.width);
  return Number.isFinite(left) && Number.isFinite(width) ? left + width : 0;
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
  pullRequestState,
  repositoryRef,
  reviewThreads = EMPTY_REVIEW_THREADS,
  source,
}: DiffViewerProps) {
  const repository = defaultBranch !== undefined;
  const isMerged = pullRequestState === "merged";
  const isClosed = pullRequestState === "closed";
  const isCommit = source[2] === "commit";
  const isCompare = source[2] === "compare";
  const isReadOnly = isMerged || isClosed || isCommit || isCompare;
  const callDiffAvailable = source[2] === "compare" || source[2] === "pull";
  const sourceKey = source.join("\0");
  const [parsedFiles, setParsedFiles] = useState<FileDiffMetadata[]>();
  const [repositoryFiles, setRepositoryFiles] = useState<RepositoryFile[]>();
  const [error, setError] = useState("");
  const [split, setSplit] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [expandedContextVersion, setExpandedContextVersion] = useState(0);
  const [hasExpandedContext, setHasExpandedContext] = useState(false);
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
  const [fileVersions, setFileVersions] = useState<Record<string, number>>({});
  const [editedFileCount, setEditedFileCount] = useState(0);
  const [committing, setCommitting] = useState(false);
  const [commitStatus, setCommitStatus] = useState<"committed" | "error" | "">("");
  const [commitError, setCommitError] = useState("");
  const editedFilesRef = useRef<Map<string, string>>(new Map());
  const editBaselinesRef = useRef<Map<string, string>>(new Map());
  const committingRef = useRef(false);
  const commitStatusTimerRef = useRef<number>(0);
  const openChatRef = useRef<(() => void) | null>(null);
  const viewerRef = useRef<CodeViewHandle<undefined, undefined>>(null);
  const expandedContextScrollTopRef = useRef<number | undefined>(undefined);
  const workspaceRef = useRef<HTMLElement>(null);
  const reviewViewRef = useRef(reviewView);
  const callFlowLoaded = loadedCallFlowSource === sourceKey;

  useEffect(() => {
    editedFilesRef.current.clear();
    editBaselinesRef.current.clear();
    setEditedFileCount(0);
    setCommitStatus("");
    setCommitError("");
    setHasExpandedContext(false);
  }, [sourceKey]);

  // A CodeView remount resets Pierre's expanded-hunk state, so restore the user's reading position afterward.
  useEffect(() => {
    const scrollTop = expandedContextScrollTopRef.current;
    if (scrollTop === undefined) return;

    viewerRef.current?.scrollTo({ behavior: "instant", position: scrollTop, type: "position" });
    expandedContextScrollTopRef.current = undefined;
  }, [expandedContextVersion]);

  /** Restores collapsed diff context after the user expanded one or more hidden line ranges. */
  function collapseExpandedContext(): void {
    expandedContextScrollTopRef.current = viewerRef.current?.getInstance()?.getScrollTop();
    setExpandedContextVersion((version) => version + 1);
    setHasExpandedContext(false);
  }

  /** Records or clears a dirty file only when the editor text differs from the last saved baseline. */
  const syncEditedFile = useCallback((path: string, contents: string): void => {
    if (committingRef.current) return;

    const baselines = editBaselinesRef.current;
    const baseline = baselines.get(path);
    if (baseline === undefined) {
      baselines.set(path, contents);
      return;
    }
    if (contents === baseline) editedFilesRef.current.delete(path);
    else editedFilesRef.current.set(path, contents);
    setEditedFileCount(editedFilesRef.current.size);
  }, []);

  /** Commits all live in-memory file edits to GitHub with an auto-generated commit message. */
  const commitChanges = useCallback(async (): Promise<void> => {
    if (committingRef.current || isReadOnly) return;

    const viewer = viewerRef.current;
    if (viewer) {
      const tracked = repository ? (repositoryFiles ?? EMPTY_REPOSITORY_FILES) : (parsedFiles ?? EMPTY_FILES);
      for (const file of tracked) {
        const live = viewer.getEditor(file.name)?.getFile()?.contents;
        if (live === undefined) continue;
        syncEditedFile(file.name, live);
      }
    }

    window.clearTimeout(commitStatusTimerRef.current);
    setCommitStatus("");
    setCommitError("");

    if (editedFilesRef.current.size === 0) {
      setEditedFileCount(0);
      return;
    }
    if (!githubConnected) {
      setCommitStatus("error");
      setCommitError("Sign in needed");
      commitStatusTimerRef.current = window.setTimeout(() => {
        setCommitStatus("");
        setCommitError("");
      }, 2500);
      return;
    }

    committingRef.current = true;
    setCommitting(true);

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

      for (const file of files) editBaselinesRef.current.set(file.path, file.contents);
      if (repository) {
        setRepositoryFiles((prev) => prev?.map((file) => {
          const edited = editedFilesRef.current.get(file.name);
          return edited === undefined ? file : { ...file, contents: edited };
        }));
      }
      setFileVersions((prev) => {
        const next = { ...prev };
        for (const file of files) next[file.path] = (next[file.path] || 0) + 1;
        return next;
      });
      editedFilesRef.current.clear();
      setEditedFileCount(0);
      setCommitStatus("committed");
      if (source[2] === "pull") window.dispatchEvent(new Event(PR_WORKSPACE_REFRESH_EVENT));
      commitStatusTimerRef.current = window.setTimeout(() => setCommitStatus(""), 2000);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Commit failed";
      setCommitStatus("error");
      setCommitError(message.slice(0, 28));
      commitStatusTimerRef.current = window.setTimeout(() => {
        setCommitStatus("");
        setCommitError("");
      }, 3000);
    } finally {
      committingRef.current = false;
      setCommitting(false);
    }
  }, [githubConnected, isReadOnly, parsedFiles, repository, repositoryFiles, source, syncEditedFile]);

  /** Toggles Pierre edit mode. Item `edit`/`version` drive the native multi-line editor. */
  const toggleEditMode = useCallback(() => {
    if (isReadOnly) return;
    setEditMode((mode) => {
      if (mode && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      return !mode;
    });
  }, [isReadOnly]);

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
        if (reviewViewRef.current === "call-flow" || isReadOnly) return;
        event.preventDefault();
        event.stopPropagation();
        toggleEditMode();
        return;
      }

      const target = event.target instanceof HTMLElement ? event.target : null;
      const isInput = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      const isCodeEditor = isPierreEditorEvent(event);

      // Commit shortcut: Command-D / Ctrl-D, Command-Enter / Ctrl-Enter, or c then d chord
      const isCommandCommit = isCommand && (isD || isEnter);
      const now = Date.now();
      const isCSequenceD = !isInput && !isCodeEditor && !isCommand && isD && lastKey.toLowerCase() === "c" && (now - lastKeyTime < 1000);

      if (!isInput && !isCodeEditor && !isCommand && isC) {
        lastKey = "c";
        lastKeyTime = now;
      } else if (!isC) {
        lastKey = "";
      }

      if (isCommandCommit || isCSequenceD) {
        if (reviewViewRef.current === "call-flow" || isReadOnly) return;
        if (isInput && !isCodeEditor) return;
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
  }, [commitChanges, isReadOnly, toggleEditMode]);

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
      const usesOriginalLine = thread.line === undefined;
      const endLine = usesOriginalLine ? thread.originalLine : thread.line;
      if (!endLine) return [];
      // GitHub clears line for outdated threads, leaving their original location in the left diff column.
      const startLine = usesOriginalLine ? thread.originalStartLine ?? endLine : thread.startLine ?? endLine;
      const side = usesOriginalLine || thread.side === "LEFT" ? "deletions" : "additions";
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
    let disposed = false;

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

    /** Transfers a hovered response stream when possible, then falls back to the worker's normal fetch. */
    function startParser(stream?: ReadableStream<Uint8Array>): void {
      const request = { cacheKey: source.join("/"), repository, url: `/api/diff/${path}` };
      if (!stream) {
        worker.postMessage(request);
        return;
      }

      try {
        worker.postMessage({ ...request, stream }, [stream]);
      } catch {
        void stream.cancel().catch(() => {});
        worker.postMessage(request);
      }
    }

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    const preloadedDiff = repository ? null : takePreloadedDiff(source);
    if (preloadedDiff) {
      void preloadedDiff.then((stream) => {
        if (disposed) {
          void stream?.cancel().catch(() => {});
          return;
        }
        startParser(stream ?? undefined);
      });
    } else {
      startParser();
    }

    return () => {
      disposed = true;
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
    function clearRevealedSelection(event: MouseEvent): void {
      if (isPierreEditorEvent(event)) return;
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
      if (editMode) return;
      if (event.target instanceof Element && event.target.closest(".question-panel")) return;
      if (event.deltaY <= 0 || workspace.getBoundingClientRect().top <= 51) return;
      event.preventDefault();
      window.scrollBy({ top: event.deltaY, behavior: "auto" });
    };

    workspace.addEventListener("wheel", revealWorkspace, { capture: true, passive: false });
    return () => workspace.removeEventListener("wheel", revealWorkspace, { capture: true });
  }, [editMode]);

  useEffect(() => {
    if (!editMode) return;
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const top = workspace.getBoundingClientRect().top;
    if (top > 51) window.scrollBy({ top: top - 51, behavior: "auto" });
  }, [editMode]);

  const workerPool = useMemo(() => getDiffWorkerPool(), []);
  // CodeView already retains per-item editors. persistState would restore the shared list scrollTop per file.
  const editorOptions = useMemo<EditorOptions<EditorType, undefined, undefined>>(() => ({}), []);
  const canEdit = editMode && !isReadOnly;
  const loadedDiffFilesRef = useRef(new Map<string, Promise<FileDiffLoadedFiles>>());

  /** Hydrates GitHub patch diffs with full old/new file contents so Pierre can attach its editor. */
  const loadDiffFiles = useCallback(async (fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
    const cacheKey = `${sourceKey}\0${fileDiff.name}\0${fileDiff.prevName ?? ""}\0${fileDiff.type}`;
    const cached = loadedDiffFilesRef.current.get(cacheKey);
    if (cached) return cached;

    const path = source.map(encodeURIComponent).join("/");
    const params = new URLSearchParams({ path: fileDiff.name, type: fileDiff.type });
    if (fileDiff.prevName) params.set("prevPath", fileDiff.prevName);

    const request = fetch(`/api/diff-files/${path}?${params}`).then(async (response): Promise<FileDiffLoadedFiles> => {
      if (!response.ok) {
        // SAFETY: The same-origin diff-files route returns this documented error envelope.
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `Could not load ${fileDiff.name} for editing`);
      }
      // SAFETY: The same-origin diff-files route returns Pierre's loaded old/new file pair.
      return response.json() as Promise<FileDiffLoadedFiles>;
    });
    loadedDiffFilesRef.current.set(cacheKey, request);
    request.catch(() => loadedDiffFilesRef.current.delete(cacheKey));
    return request;
  }, [source, sourceKey]);

  /** Records the current contents reported by a live Diffs editor. */
  const rememberItemEdit = useCallback((event: EditorChangeEvent<EditorType, undefined, undefined>, item: CodeViewItem<undefined>): void => {
    syncEditedFile(item.id, event.file.contents);
  }, [syncEditedFile]);

  /** Accepts Diffs' completed editor state after recording its final file contents. */
  const completeItemEdit = useCallback<CodeViewItemEditCompleteHandler<undefined, undefined>>((event, item) => {
    // Diffs emits a file directly for file edits and the new side for diff edits.
    const file = "file" in event ? event.file : event.newFile;
    if (file) syncEditedFile(item.id, file.contents);
    return "accept";
  }, [syncEditedFile]);

  const items = useMemo<CodeViewItem<undefined>[]>(
    () => repository
      ? codeFiles.map((file) => ({
          id: file.name,
          type: "file" as const,
          file: {
            name: file.name,
            contents: canEdit ? file.contents : (editedFilesRef.current.get(file.name) ?? file.contents),
            cacheKey: `${file.name}:${fileVersions[file.name] ?? 0}`,
          },
          collapsed,
          edit: canEdit,
          version: (fileVersions[file.name] ?? 0) * 4 + (collapsed ? 1 : 0) + (canEdit ? 2 : 0),
        }))
      : diffFiles.map((file) => {
          const version = (fileVersions[file.name] ?? 0) * 4 + (collapsed ? 1 : 0) + (canEdit ? 2 : 0);
          if (canEdit && file.type === "new") {
            return {
              id: file.name,
              type: "file" as const,
              file: {
                name: file.name,
                contents: editedFilesRef.current.get(file.name) ?? contentsFromDiffLines(file.additionLines),
                cacheKey: `${file.name}:${fileVersions[file.name] ?? 0}`,
              },
              collapsed,
              edit: true,
              version,
            };
          }

          return {
            id: file.name,
            type: "diff" as const,
            fileDiff: file,
            collapsed,
            edit: canEdit && file.type !== "deleted",
            version,
          };
        }),
    [canEdit, codeFiles, collapsed, diffFiles, fileVersions, repository],
  );
  const codeViewOptions = useMemo<CodeViewReactOptions<undefined, undefined>>(() => ({
    diffStyle: split ? "split" : "unified",
    diffIndicators: "bars",
    enableLineSelection: repository && (!editMode || isReadOnly),
    loadDiffFiles: repository ? undefined : loadDiffFiles,
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

      // Pierre only exposes expansion through its rendered line type; this keeps the matching collapse control reachable.
      const containsExpandedContext = shadowRoot.querySelector('[data-line-type="context-expanded"]') !== null;
      if (containsExpandedContext) setHasExpandedContext(true);

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
            element.dataset.tone = marker.tone;
            const offset = nativeIndicatorRight(gutter) + (marker.lane ?? 0) * 3;
            element.style.setProperty("--diffs-inline-comment-offset", `${offset}px`);
            if (marker.tone === "chat" && marker.chatId && marker.markerId) {
              element.classList.add("diffs-inline-chat-marker");
              // Only the first segment gets a cap, so a multi-line marker remains one continuous track.
              if (position === "single" || position === "start") element.classList.add("diffs-inline-chat-marker-cap");
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
    },
    useTokenTransformer: true,
    unsafeCSS: DIFF_VIEWER_CSS,
  }), [editMode, inlineCommentMarkersByFile, isReadOnly, loadDiffFiles, repository, resumeChatFromMarker, split]);
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
        {!showingCallDiff && !isReadOnly && (
          <button
            aria-label={`Toggle Edit mode (Command-Shift-E)${editMode ? " - Currently Editing" : ""}`}
            className={`sidebar-bottom-action${editMode ? " active" : ""}`}
            onClick={toggleEditMode}
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
          {!isReadOnly && (
            <button
              aria-busy={committing}
              aria-label="Commit and push changes to GitHub (⌘D / c+d)"
              className={`commit-action${editedFileCount > 0 && !committing && commitStatus === "" ? " ready" : ""}${committing ? " committing" : ""}${commitStatus === "committed" ? " committed" : ""}${commitStatus === "error" ? " error" : ""}`}
              disabled={committing || editedFileCount === 0}
              onClick={() => void commitChanges()}
              title={committing ? "Committing changes…" : editedFileCount === 0 ? "Edit code to commit changes (⌘D / c+d)" : !githubConnected ? "Sign in with GitHub to commit and push" : "Commit and push changes (⌘D)"}
              type="button"
            >
              {committing ? <LoaderCircle className="spinner" size={13} /> : commitStatus === "committed" ? <Check size={13} /> : <GitCommitHorizontal size={13} />}
              <span>{committing ? "Committing" : commitStatus === "committed" ? "Committed" : commitError || "Commit"}</span>
              <kbd className="key-hint">⌘D</kbd>
            </button>
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
          {hasExpandedContext && !editMode && (
            <button aria-label="Collapse expanded diff lines" onClick={collapseExpandedContext} title="Collapse expanded lines" type="button">
              <ChevronUp size={15} /> Collapse lines
            </button>
          )}
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
            <EditProvider createEditor={createDiffEditor}>
              <CodeView
                key={`${sourceKey}:${expandedContextVersion}`}
                ref={viewerRef}
                editorOptions={editorOptions}
                items={items}
                onItemEditChange={rememberItemEdit}
                onItemEditComplete={completeItemEdit}
                onSelectedLinesChange={repository ? rememberRepositorySelection : undefined}
                options={codeViewOptions}
              />
            </EditProvider>
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
