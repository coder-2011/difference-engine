"use client";

import { getFiletypeFromFileName, getSharedHighlighter } from "@pierre/diffs";
import { Check, ClipboardCopy, CornerDownLeft, GitFork, Github, GripHorizontal, MessageSquarePlus, Minus, Paperclip, Plus, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import type { CSSProperties } from "react";
import { ChangeEvent, DragEvent, FormEvent, Fragment, PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GitHubMarkdown } from "@/components/github-markdown";
import { OpenAIConnection } from "@/components/openai-connection";
import { isInteger, isRecord, isString, type JsonValue } from "@/lib/json";
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  MAX_CHAT_HISTORY_TURNS,
  type ChatTurn,
} from "@/types/chat";

const DEFAULT_QUESTION = "What does this code do?";
const DEFAULT_CHAT_FONT_SIZE = 12;
const DEFAULT_CHAT_ZOOM = 100;
const CHAT_ZOOM_PRESETS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500] as const;
const CHAT_ZOOM_STORAGE_KEY = "diffs:chat-zoom";
const LEGACY_CHAT_FONT_SIZE_STORAGE_KEY = "diffs:chat-font-size";
const LEGACY_MAX_CHAT_FONT_SIZE = 22;
const LEGACY_MIN_CHAT_FONT_SIZE = 10;
const MAX_PRIOR_HIGHLIGHTS = 3;
const MIN_PANEL_HEIGHT = 120;
const MIN_PANEL_WIDTH = 300;
const STREAM_CHARS_PER_FRAME = 18;
const RESIZE_DIRECTIONS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;

type Point = {
  x: number;
  y: number;
};

type CodeSelection = Point & {
  location?: CodeSelectionLocation;
  range?: Range;
  text: string;
};

export type CodeSelectionLocation = {
  endLineNumber?: number;
  endSide?: "additions" | "deletions";
  id: string;
  lineNumber: number;
  side?: "additions" | "deletions";
};

type Annotation = {
  id: string;
  selection: CodeSelection;
  text: string;
};

type AnnotationStore = {
  annotations: Annotation[];
  source: string;
};

export type LocalAnnotationMarker = Pick<Annotation, "id"> & {
  location?: CodeSelectionLocation;
};

export type ChatMarker = {
  chatId: string;
  id: string;
  location: CodeSelectionLocation;
};

export type ChatResumeRequest = {
  chatId: string;
  markerId: string;
  sequence: number;
};

type StoredAnnotation = Omit<Annotation, "selection"> & {
  selection: Pick<CodeSelection, "location" | "text">;
};

type AnnotationDraft = Point & {
  selection: CodeSelection;
  text: string;
};

type ChatSession = {
  draft: string;
  id: string;
  markers: Array<{ id: string; selection: CodeSelection }>;
  priorHighlights: string[];
  selection: SelectionState;
  suggestion: string;
  turns: ChatTurn[];
};

type SelectionRequest = {
  chatId: string;
  selection: CodeSelection;
  sequence: number;
};

type ModelAnnotation = {
  code: string;
  line: number;
  path: string;
  text: string;
};

type SelectionState = CodeSelection & {
  open: boolean;
};

type DragState = Point & {
  left: number;
  lastTime: number;
  lastX: number;
  lastY: number;
  top: number;
  velocityX: number;
  velocityY: number;
};

type ResizeDirection = typeof RESIZE_DIRECTIONS[number];

type ResizeState = Point & {
  direction: ResizeDirection;
  height: number;
  left: number;
  top: number;
  width: number;
};

type ChatPanelStyle = CSSProperties & { "--chat-font-size": string };

export type ProgrammaticSelection = Point & {
  location: CodeSelectionLocation;
  text: string;
};

type SelectionQuestionProps = {
  aiEnabled: boolean;
  annotationContainerKey?: string;
  annotationPaths: string[];
  githubConnected: boolean;
  onAnnotationsChange?: (annotations: LocalAnnotationMarker[]) => void;
  onChatMarkersChange?: (markers: ChatMarker[]) => void;
  programmaticSelection?: ProgrammaticSelection;
  onRevealSelection: (location: CodeSelectionLocation) => void;
  resumeChat?: ChatResumeRequest;
  source: string[];
};

type UploadedAttachment = {
  data: string;
  name: string;
  type: string;
};

type QueuedQuestion = {
  attachments: File[];
  id: number;
  priorHighlights: string[];
  question: string;
  selection: SelectionState;
};

type SubmitQuestion = (
  value: string,
  questionAttachments: File[],
  questionSelection?: SelectionState | null,
  questionPriorHighlights?: string[],
) => Promise<void>;

type AskDiffsPanelProps = {
  annotationPaths: string[];
  chat: ChatSession;
  chatZoom: number;
  isActive: boolean;
  onChatChange: (chat: ChatSession) => void;
  onChatZoomChange: (zoom: number) => void;
  onClose: (chat: ChatSession) => void;
  onFocus: () => void;
  onFork: (chat: ChatSession) => void;
  onMarkersChange: (chatId: string, markers: ChatSession["markers"]) => void;
  onModelAnnotation: (annotation: Partial<ModelAnnotation>) => void;
  onShowSelection: (selection: CodeSelection) => void;
  selectionRequest?: SelectionRequest;
  source: string[];
  stackIndex: number;
};

type PromptPreviewProps = {
  question: string;
};

type SelectedSnippetProps = {
  codeSelection: CodeSelection;
  onShow: (selection: CodeSelection) => void;
};

type SyntaxSnippetProps = {
  active: boolean;
  className?: string;
  codeSelection: CodeSelection;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

type AnnotationSnippetProps = {
  codeSelection: CodeSelection;
};

type SnippetToken = {
  color?: string;
  content: string;
};

type SnippetHighlight = {
  language: string;
  source: string;
  tokens: SnippetToken[][];
};

/** Builds a GitHub-style patch fragment from one copied annotation. */
function annotationDiff(code: string, location?: CodeSelectionLocation): string[] {
  const lines = code.split("\n");
  if (!location) return lines;

  const selectionStaysOnOneSide = !location.endSide || location.endSide === location.side;
  const side = selectionStaysOnOneSide ? location.side : undefined;
  const prefix = side === "additions" ? "+" : side === "deletions" ? "-" : " ";
  const oldRange = side === "additions" ? `${location.lineNumber},0` : `${location.lineNumber},${lines.length}`;
  const newRange = side === "deletions" ? `${location.lineNumber},0` : `${location.lineNumber},${lines.length}`;

  return [
    `diff --git a/${location.id} b/${location.id}`,
    `--- a/${location.id}`,
    `+++ b/${location.id}`,
    `@@ -${oldRange} +${newRange} @@`,
    ...lines.map((line) => `${prefix}${line}`),
  ];
}

/** Wraps copied code in a fence longer than any backtick run it contains. */
function annotationCodeFence(language: string, lines: string[]): string[] {
  let fenceLength = 3;

  for (const match of lines.join("\n").matchAll(/`+/g)) {
    fenceLength = Math.max(fenceLength, match[0].length + 1);
  }

  const fence = "`".repeat(fenceLength);
  return [`${fence}${language}`, ...lines, fence];
}

/** Formats annotations as GitHub-style patches plus language-tagged source blocks. */
function formattedAnnotations(annotations: Annotation[]): string {
  return annotations.map((annotation) => {
    const location = annotation.selection.location;
    const side = location?.side ? ` (${location.side})` : "";
    const hasRange = location && location.endLineNumber !== undefined
      && (location.endLineNumber !== location.lineNumber || location.endSide !== location.side);
    const end = hasRange ? `-${location.endLineNumber}${location.endSide ? ` (${location.endSide})` : ""}` : "";
    const reference = location ? `\`${location.id}:${location.lineNumber}${side}${end}\` ` : "";
    // Continuations must remain part of their source-anchored list item.
    const text = annotation.text.replace(/\r?\n/g, "\n  ");
    const code = annotation.selection.text.replace(/\r?\n/g, "\n");
    const diffLines = annotationCodeFence("diff", annotationDiff(code, location)).map((line) => `  ${line}`);
    const language = location ? getFiletypeFromFileName(location.id) : "text";
    const copiedLines = annotationCodeFence(language, code.split("\n")).map((line) => `  ${line}`);
    return [`- ${reference}${text}`, "", ...diffLines, "", ...copiedLines].join("\n");
  }).join("\n");
}

/** Builds a source-specific browser key so notes never leak into another review. */
function annotationStorageKey(sourceKey: string): string {
  return `diffs:annotations:${sourceKey}`;
}

/** Parses one persisted annotation location before returning it to the live code-selection model. */
function storedLocation(value: JsonValue | undefined): CodeSelectionLocation | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;

  const endLineNumber = value.endLineNumber;
  const endSide = value.endSide;
  const id = value.id;
  const lineNumber = value.lineNumber;
  const side = value.side;
  if (!isString(id) || !isInteger(lineNumber)) return null;
  if (side !== undefined && side !== "additions" && side !== "deletions") return null;
  if (endSide !== undefined && endSide !== "additions" && endSide !== "deletions") return null;
  if (endLineNumber !== undefined && !isInteger(endLineNumber)) return null;

  return { endLineNumber, endSide, id, lineNumber, side };
}

/** Restores serializable annotations while intentionally leaving stale DOM ranges behind. */
function storedAnnotations(sourceKey: string): Annotation[] {
  try {
    const stored: JsonValue = JSON.parse(window.localStorage.getItem(annotationStorageKey(sourceKey)) ?? "[]");
    if (!Array.isArray(stored)) return [];

    return stored.flatMap((value: JsonValue): Annotation[] => {
      if (!isRecord(value) || !isString(value.id) || !isString(value.text) || !isRecord(value.selection) || !isString(value.selection.text)) return [];
      const location = storedLocation(value.selection.location);
      if (location === null) return [];

      return [{
        id: value.id,
        selection: { location, text: value.selection.text, x: 0, y: 0 },
        text: value.text,
      }];
    });
  } catch {
    return [];
  }
}

/** Saves only durable annotation data, never a browser Range that cannot survive a reload. */
function storeAnnotations(sourceKey: string, annotations: Annotation[]): void {
  const stored: StoredAnnotation[] = annotations.map(({ id, selection, text }) => ({
    id,
    selection: { location: selection.location, text: selection.text },
    text,
  }));

  try {
    if (stored.length) window.localStorage.setItem(annotationStorageKey(sourceKey), JSON.stringify(stored));
    else window.localStorage.removeItem(annotationStorageKey(sourceKey));
  } catch {
    // The note remains usable for this page when browser storage is unavailable.
  }
}

/** Recognizes a usable positive percentage from browser storage or the zoom editor. */
function isChatZoom(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Finds the adjacent explicit zoom preset while preserving a manually entered percentage. */
function adjacentChatZoom(zoom: number, direction: -1 | 1): number {
  if (direction === 1) {
    for (const preset of CHAT_ZOOM_PRESETS) {
      if (preset > zoom) return preset;
    }
    return zoom;
  }

  for (let index = CHAT_ZOOM_PRESETS.length - 1; index >= 0; index -= 1) {
    if (CHAT_ZOOM_PRESETS[index] < zoom) return CHAT_ZOOM_PRESETS[index];
  }
  return zoom;
}

/** Converts a retired pixel preference to its closest supported percentage. */
function nearestChatZoom(zoom: number): number {
  let nearest: number = CHAT_ZOOM_PRESETS[0];
  for (const preset of CHAT_ZOOM_PRESETS) {
    if (Math.abs(preset - zoom) < Math.abs(nearest - zoom)) nearest = preset;
  }
  return nearest;
}

/** Restores a valid user-wide Ask Diffs zoom, converting the prior pixel preference once. */
function storedChatZoom(): number {
  try {
    const stored = Number(window.localStorage.getItem(CHAT_ZOOM_STORAGE_KEY));
    if (isChatZoom(stored)) return stored;

    const legacySize = Number(window.localStorage.getItem(LEGACY_CHAT_FONT_SIZE_STORAGE_KEY));
    if (Number.isInteger(legacySize) && legacySize >= LEGACY_MIN_CHAT_FONT_SIZE && legacySize <= LEGACY_MAX_CHAT_FONT_SIZE) {
      return nearestChatZoom((legacySize / DEFAULT_CHAT_FONT_SIZE) * DEFAULT_CHAT_ZOOM);
    }
  } catch {
    // The default remains available when browser storage is unavailable.
  }
  return DEFAULT_CHAT_ZOOM;
}

/** Saves the user-wide Ask Diffs zoom while allowing the panel to work without storage. */
function storeChatZoom(zoom: number): void {
  try {
    window.localStorage.setItem(CHAT_ZOOM_STORAGE_KEY, String(zoom));
  } catch {
    // The current chat stays resized when browser storage is unavailable.
  }
}

/** Renders a readable prompt preview that expands only when it exceeds two lines. */
function PromptPreview({ question }: PromptPreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const promptRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const prompt = promptRef.current;
    if (!prompt || expanded) return;
    setTruncated(prompt.scrollHeight > prompt.clientHeight);
  }, [expanded, question]);

  return (
    <div className="asked-question-wrap">
      <div className={`asked-question chat-markdown${expanded ? " expanded" : ""}`} ref={promptRef}>
        <GitHubMarkdown>{question}</GitHubMarkdown>
      </div>
      {truncated && (
        <button className="asked-question-toggle" onClick={() => setExpanded((current) => !current)} type="button">
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** Returns the actual range inside Pierre's shadow root instead of the document-level host boundary. */
function selectedRange(browserSelection: Selection, origin?: EventTarget): Range | undefined {
  const originNode = origin instanceof Node ? origin : undefined;
  const anchorRoot = browserSelection.anchorNode?.getRootNode();
  const originRoot = originNode?.getRootNode();
  const root = anchorRoot instanceof ShadowRoot ? anchorRoot : originRoot;
  if (!(root instanceof ShadowRoot)) {
    return browserSelection.rangeCount ? browserSelection.getRangeAt(0).cloneRange() : undefined;
  }

  const composedRange = browserSelection.getComposedRanges({ shadowRoots: [root] })[0];
  if (!composedRange) return undefined;

  const range = document.createRange();
  range.setStart(composedRange.startContainer, composedRange.startOffset);
  range.setEnd(composedRange.endContainer, composedRange.endOffset);
  return range;
}

/** Extracts Pierre's stable file and line coordinates from a browser text range. */
function selectionLocation(range: Range): CodeSelectionLocation | undefined {
  const root = range.startContainer.getRootNode();
  const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const endElement = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
  const line = element?.closest("[data-line]");
  let endLine = endElement?.closest("[data-line]");
  const id = root instanceof ShadowRoot ? root.querySelector("[data-title]")?.textContent?.trim() : "";
  // A missing data-line attribute must not coerce to line zero.
  const lineAttribute = line?.getAttribute("data-line");
  if (!id || !isString(lineAttribute)) return undefined;

  // Only a range ending before the line's content excludes that line.
  if (range.endOffset === 0 && endLine) {
    const lineStart = document.createRange();
    lineStart.selectNodeContents(endLine);
    lineStart.collapse(true);
    if (range.compareBoundaryPoints(Range.START_TO_END, lineStart) === 0) {
      const lineRoot = root instanceof ShadowRoot ? root : document;
      const lines = Array.from(lineRoot.querySelectorAll("[data-line]"));
      const endIndex = lines.indexOf(endLine);
      if (endIndex > 0) endLine = lines[endIndex - 1];
    }
  }

  const lineNumber = Number(lineAttribute);
  if (!Number.isInteger(lineNumber)) return undefined;

  const endLineAttribute = endLine?.getAttribute("data-line");
  const endLineNumber = isString(endLineAttribute) ? Number(endLineAttribute) : undefined;
  const lineType = line?.getAttribute("data-line-type");
  const endLineType = endLine?.getAttribute("data-line-type");
  const side = lineType === "change-addition" ? "additions" : lineType === "change-deletion" ? "deletions" : undefined;
  const endSide = endLineType === "change-addition" ? "additions" : endLineType === "change-deletion" ? "deletions" : undefined;
  return {
    endLineNumber: Number.isInteger(endLineNumber) ? endLineNumber : undefined,
    endSide,
    id,
    lineNumber,
    side,
  };
}

/** Renders plain code until hover or focus requests cached Pierre syntax tokens. */
function SyntaxSnippet({ active, className, codeSelection, onMouseEnter, onMouseLeave }: SyntaxSnippetProps) {
  const [highlighted, setHighlighted] = useState<SnippetHighlight>();
  const language = codeSelection.location ? getFiletypeFromFileName(codeSelection.location.id) : undefined;
  const tokens = highlighted && highlighted.language === language && highlighted.source === codeSelection.text
    ? highlighted.tokens
    : undefined;

  useEffect(() => {
    if (!active || !language || tokens) return;

    let cancelled = false;
    void getSharedHighlighter({
      langs: [language],
      preferredHighlighter: "shiki-wasm",
      themes: ["pierre-dark"],
    }).then((highlighter) => highlighter.codeToTokens(codeSelection.text, {
      lang: language,
      theme: "pierre-dark",
    })).then((result) => {
      if (!cancelled) setHighlighted({ language, source: codeSelection.text, tokens: result.tokens });
    }).catch(() => {
      // The plain snippet remains usable if this file's grammar cannot load.
    });

    return () => {
      cancelled = true;
    };
  }, [active, codeSelection.text, language, tokens]);

  return (
    <span className={className} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      {active && tokens
        ? tokens.map((line, lineIndex) => (
            <Fragment key={lineIndex}>
              {line.map((token, tokenIndex) => (
                <span key={tokenIndex} style={{ color: token.color }}>{token.content}</span>
              ))}
              {lineIndex < tokens.length - 1 ? "\n" : null}
            </Fragment>
          ))
        : codeSelection.text}
    </span>
  );
}

/** Lazily applies Pierre's syntax colors while a saved selection is hovered or focused. */
function SelectedSnippet({ codeSelection, onShow }: SelectedSnippetProps) {
  const [active, setActive] = useState(false);

  /** Returns to plain text when the pointer leaves the saved selection. */
  function stopHighlighting(): void {
    setActive(false);
  }

  /** Reveals the source and preserves syntax colors for pointer clicks that do not focus buttons. */
  function showSnippet(): void {
    setActive(true);
    onShow(codeSelection);
  }

  return (
    <button
      className="selected-snippet-item"
      onBlur={() => setActive(false)}
      onClick={showSnippet}
      onFocus={() => setActive(true)}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={stopHighlighting}
      title="Show this code in the diff"
      type="button"
    >
      <SyntaxSnippet active={active} codeSelection={codeSelection} />
    </button>
  );
}

/** Shows syntax colors for a compact annotation snippet only while the pointer is over it. */
function AnnotationSnippet({ codeSelection }: AnnotationSnippetProps) {
  const [active, setActive] = useState(false);

  return (
    <SyntaxSnippet
      active={active}
      className="annotation-code"
      codeSelection={codeSelection}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
    />
  );
}

/** Shows the in-progress reply without re-parsing its growing Markdown document every frame. */
function StreamingAnswer({ answer }: { answer: string }) {
  return <div className="chat-streaming-answer">{answer}<span aria-hidden="true" className="chat-streaming-caret" /></div>;
}

/** Gives each source range one stable identity within a purple chat marker track. */
function chatMarkerLocationKey(location: CodeSelectionLocation): string {
  return [
    location.id,
    location.lineNumber,
    location.endLineNumber ?? location.lineNumber,
    location.side ?? "",
    location.endSide ?? location.side ?? "",
  ].join("\0");
}

/** Renders one independent Ask Diffs conversation, including its own request and queue state. */
function AskDiffsPanel({ annotationPaths, chat, chatZoom, isActive, onChatChange, onChatZoomChange, onClose, onFocus, onFork, onMarkersChange, onModelAnnotation, onShowSelection, selectionRequest, source, stackIndex }: AskDiffsPanelProps) {
  const [selection, setSelection] = useState<SelectionState>(chat.selection);
  const [question, setQuestion] = useState(chat.draft);
  const [turns, setTurns] = useState<ChatTurn[]>(chat.turns);
  const [loading, setLoading] = useState(false);
  const [suggestion, setSuggestion] = useState(chat.suggestion);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [queuedQuestions, setQueuedQuestions] = useState<QueuedQuestion[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [openAIError, setOpenAIError] = useState("");
  const [chatZoomInput, setChatZoomInput] = useState(String(chatZoom));
  const [markers, setMarkers] = useState<ChatSession["markers"]>(chat.markers);
  const [priorHighlights, setPriorHighlights] = useState(chat.priorHighlights);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const draggedPanelRef = useRef<HTMLElement | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const momentumFrameRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const followsConversationRef = useRef(true);
  const dragDepthRef = useRef(0);
  const queuedQuestionsRef = useRef<QueuedQuestion[]>([]);
  const queuedQuestionCounterRef = useRef(0);
  const submitQuestionRef = useRef<SubmitQuestion | undefined>(undefined);
  const lastSelectionRequestRef = useRef<number | undefined>(undefined);
  const conversationActive = Boolean(turns.length || loading);
  const chatFontSize = (DEFAULT_CHAT_FONT_SIZE * chatZoom) / DEFAULT_CHAT_ZOOM;

  /** Captures the durable pieces of this panel for forks and purple-marker resumes. */
  const snapshot = useCallback((): ChatSession => ({
    draft: question,
    id: chat.id,
    markers,
    priorHighlights,
    selection,
    suggestion,
    turns,
  }), [chat.id, markers, priorHighlights, question, selection, suggestion, turns]);

  useEffect(() => {
    onChatChange(snapshot());
  }, [onChatChange, snapshot]);

  useEffect(() => {
    onMarkersChange(chat.id, markers);
  }, [chat.id, markers, onMarkersChange]);

  useEffect(() => {
    setChatZoomInput(String(chatZoom));
  }, [chatZoom]);

  useEffect(() => {
    if (!selectionRequest || selectionRequest.chatId !== chat.id || lastSelectionRequestRef.current === selectionRequest.sequence) return;

    lastSelectionRequestRef.current = selectionRequest.sequence;
    const previousHighlight = selection.text.trim();
    if (previousHighlight && previousHighlight !== selectionRequest.selection.text) {
      setPriorHighlights((current) => [...current.filter((highlight) => highlight !== previousHighlight), previousHighlight].slice(-MAX_PRIOR_HIGHLIGHTS));
    }
    setSelection({ ...selectionRequest.selection, open: true });
    followsConversationRef.current = true;
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [chat.id, selection, selectionRequest]);

  useEffect(() => {
    return () => {
      requestRef.current?.abort();
      window.cancelAnimationFrame(momentumFrameRef.current);
    };
  }, []);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation && followsConversationRef.current) conversation.scrollTop = conversation.scrollHeight;
  }, [loading, turns]);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation) return;
    const scroller = conversation;

    /** Remembers whether the reader wants incoming text to keep following the bottom. */
    function updateFollowState(): void {
      const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      followsConversationRef.current = distanceFromBottom < 24;
    }

    /** Stops automatic scrolling before an upward wheel gesture. */
    function stopFollowingOnWheel(event: WheelEvent): void {
      if (event.deltaY < 0) followsConversationRef.current = false;
    }

    /** Lets direct scrolling take precedence over incoming streamed text. */
    function stopFollowingOnPointer(): void {
      followsConversationRef.current = false;
    }

    updateFollowState();
    scroller.addEventListener("pointerdown", stopFollowingOnPointer, { passive: true });
    scroller.addEventListener("scroll", updateFollowState, { passive: true });
    scroller.addEventListener("wheel", stopFollowingOnWheel, { passive: true });
    return () => {
      scroller.removeEventListener("pointerdown", stopFollowingOnPointer);
      scroller.removeEventListener("scroll", updateFollowState);
      scroller.removeEventListener("wheel", stopFollowingOnWheel);
    };
  }, [conversationActive]);

  /** Adds a purple marker only after this panel actually asks about selected code. */
  function trackQuestionSelection(codeSelection: SelectionState): void {
    if (!codeSelection.text || !codeSelection.location) return;

    const locationKey = chatMarkerLocationKey(codeSelection.location);
    setMarkers((current) => {
      if (current.some((marker) => marker.selection.location && chatMarkerLocationKey(marker.selection.location) === locationKey)) return current;

      const markerId = `chat-marker-${chat.id}-${current.length + 1}`;
      return [...current, { id: markerId, selection: codeSelection }];
    });
  }

  /** Drops queued prompts whenever their selected-code context is discarded. */
  function clearQueuedQuestions(): void {
    queuedQuestionsRef.current = [];
    setQueuedQuestions([]);
  }

  /** Holds a submitted prompt until this panel's active answer has finished streaming. */
  function queueQuestion(value: string): void {
    const queuedQuestion = value.trim();
    if (!queuedQuestion) return;

    queuedQuestionCounterRef.current += 1;
    const next = [...queuedQuestionsRef.current, {
      attachments: [...attachments],
      id: queuedQuestionCounterRef.current,
      priorHighlights: [...priorHighlights],
      question: queuedQuestion,
      selection,
    }];
    queuedQuestionsRef.current = next;
    setQueuedQuestions(next);
    setQuestion("");
    setAttachments([]);
    setAttachmentError("");
  }

  /** Places this panel fully within the viewport after a drag or resize. */
  function placePanel(panel: HTMLElement, left: number, top: number): Point {
    const maxX = Math.max(window.innerWidth - panel.offsetWidth - 8, 8);
    const maxY = Math.max(window.innerHeight - panel.offsetHeight - 8, 8);
    const x = Math.min(Math.max(left, 8), maxX);
    const y = Math.min(Math.max(top, 8), maxY);
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    return { x, y };
  }

  /** Continues a released drag with friction until the panel naturally comes to rest. */
  function continueMomentum(panel: HTMLElement, velocityX: number, velocityY: number): void {
    if (Math.hypot(velocityX, velocityY) < 0.12) return;

    let lastTime = performance.now();
    const move = (time: number): void => {
      const elapsed = Math.min(time - lastTime, 32);
      lastTime = time;
      velocityX *= Math.pow(0.88, elapsed / 16);
      velocityY *= Math.pow(0.88, elapsed / 16);
      const requestedX = panel.offsetLeft + velocityX * elapsed;
      const requestedY = panel.offsetTop + velocityY * elapsed;
      const position = placePanel(panel, requestedX, requestedY);

      if (position.x !== requestedX) velocityX = 0;
      if (position.y !== requestedY) velocityY = 0;
      if (Math.hypot(velocityX, velocityY) >= 0.02) momentumFrameRef.current = window.requestAnimationFrame(move);
    };

    momentumFrameRef.current = window.requestAnimationFrame(move);
  }

  /** Starts moving only this panel from its current rendered position. */
  function startDragging(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.target instanceof Element && event.target.closest("button")) return;
    const panel = event.currentTarget.closest<HTMLElement>(".question-panel");
    if (!panel) return;

    const rect = panel.getBoundingClientRect();
    window.cancelAnimationFrame(momentumFrameRef.current);
    draggedPanelRef.current = panel;
    dragRef.current = {
      lastTime: performance.now(),
      lastX: event.clientX,
      lastY: event.clientY,
      left: rect.left,
      top: rect.top,
      velocityX: 0,
      velocityY: 0,
      x: event.clientX,
      y: event.clientY,
    };
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  /** Updates this panel's position while its header has pointer capture. */
  function movePanel(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    const panel = draggedPanelRef.current;
    if (!drag || !panel) return;

    const time = performance.now();
    const elapsed = Math.max(time - drag.lastTime, 1);
    drag.velocityX = (event.clientX - drag.lastX) / elapsed;
    drag.velocityY = (event.clientY - drag.lastY) / elapsed;
    drag.lastTime = time;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    placePanel(panel, drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
  }

  /** Releases a panel drag and starts momentum when appropriate. */
  function stopDragging(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    const panel = draggedPanelRef.current;
    dragRef.current = null;
    draggedPanelRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag && panel && event.type !== "pointercancel") continueMomentum(panel, drag.velocityX, drag.velocityY);
  }

  /** Starts an edge or corner resize while preserving the opposite panel edge. */
  function startResizing(event: ReactPointerEvent<HTMLDivElement>, direction: ResizeDirection): void {
    const panel = panelRef.current;
    if (!panel) return;

    const rect = panel.getBoundingClientRect();
    window.cancelAnimationFrame(momentumFrameRef.current);
    resizeRef.current = {
      direction,
      height: rect.height,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      x: event.clientX,
      y: event.clientY,
    };
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  /** Applies the current resize gesture without letting the panel leave the viewport. */
  function resizePanel(event: ReactPointerEvent<HTMLDivElement>): void {
    const resize = resizeRef.current;
    const panel = panelRef.current;
    if (!resize || !panel) return;

    const right = resize.left + resize.width;
    const bottom = resize.top + resize.height;
    const resizesWest = resize.direction.includes("w");
    const resizesEast = resize.direction.includes("e");
    const resizesNorth = resize.direction.includes("n");
    const resizesSouth = resize.direction.includes("s");
    const width = resizesWest
      ? Math.min(right - 8, Math.max(MIN_PANEL_WIDTH, resize.width + resize.x - event.clientX))
      : resizesEast
        ? Math.min(window.innerWidth - resize.left - 8, Math.max(MIN_PANEL_WIDTH, resize.width + event.clientX - resize.x))
        : resize.width;
    const height = resizesNorth
      ? Math.min(bottom - 8, Math.max(MIN_PANEL_HEIGHT, resize.height + resize.y - event.clientY))
      : resizesSouth
        ? Math.min(window.innerHeight - resize.top - 8, Math.max(MIN_PANEL_HEIGHT, resize.height + event.clientY - resize.y))
        : resize.height;
    const left = resizesWest ? right - width : resize.left;
    const top = resizesNorth ? bottom - height : resize.top;

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
  }

  /** Releases the current resize pointer capture. */
  function stopResizing(event: ReactPointerEvent<HTMLDivElement>): void {
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  /** Converts one pending browser file to the data URL accepted by the model request. */
  function encodeAttachment(file: File): Promise<UploadedAttachment> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (!isString(reader.result)) {
          reject(new Error("The file could not be read."));
          return;
        }
        resolve({ data: reader.result, name: file.name, type: file.type });
      };
      reader.onerror = () => reject(new Error("The file could not be read."));
      reader.readAsDataURL(file);
    });
  }

  /** Adds dropped or picked files while enforcing this panel's attachment budget. */
  function addAttachments(files: File[]): void {
    const uniqueFiles = files.filter((file) => !attachments.some((current) => (
      current.lastModified === file.lastModified && current.name === file.name && current.size === file.size
    )));
    const nextAttachments = [...attachments, ...uniqueFiles];
    const totalBytes = nextAttachments.reduce((total, file) => total + file.size, 0);

    if (nextAttachments.length > MAX_CHAT_ATTACHMENTS) {
      setAttachmentError(`Attach up to ${MAX_CHAT_ATTACHMENTS} files at once.`);
      return;
    }
    if (uniqueFiles.some((file) => file.size > MAX_CHAT_ATTACHMENT_BYTES) || totalBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
      setAttachmentError("Attachments can be up to 8 MB each and 16 MB together.");
      return;
    }

    setAttachmentError("");
    setAttachments(nextAttachments);
  }

  /** Removes one pending attachment before its question is sent. */
  function removeAttachment(index: number): void {
    setAttachments((current) => current.filter((_, currentIndex) => currentIndex !== index));
    setAttachmentError("");
  }

  /** Adds files selected through this panel's native file picker. */
  function selectAttachments(event: ChangeEvent<HTMLInputElement>): void {
    addAttachments(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  /** Shows the drop target only while files are over this panel. */
  function beginFileDrag(event: DragEvent<HTMLElement>): void {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  }

  /** Hides the drop target once all file drag enters have left this panel. */
  function endFileDrag(event: DragEvent<HTMLElement>): void {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(dragDepthRef.current - 1, 0);
    if (!dragDepthRef.current) setIsDraggingFiles(false);
  }

  /** Attaches files dropped over this panel. */
  function dropAttachments(event: DragEvent<HTMLElement>): void {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    addAttachments(Array.from(event.dataTransfer.files));
  }

  /** Sends one question against this panel's captured code selection, history, and attachments. */
  async function submitQuestion(
    value: string,
    questionAttachments: File[],
    questionSelection: SelectionState | null = selection,
    questionPriorHighlights: string[] = priorHighlights,
  ): Promise<void> {
    const submittedQuestion = value.trim();
    if (!questionSelection || !submittedQuestion || requestRef.current) return;
    trackQuestionSelection(questionSelection);
    const selectedCode = questionSelection.text;

    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setSuggestion("");
    let pendingDelta = "";
    let flushFrame: number | undefined;
    let resolveDrain: (() => void) | undefined;
    let startedTurn = false;
    let streamedSuggestion = "";

    /** Reveals one small answer batch on the next paint, not on an independent timer. */
    function flushDelta(): void {
      flushFrame = undefined;
      if (controller.signal.aborted) pendingDelta = "";
      if (!pendingDelta) {
        resolveDrain?.();
        resolveDrain = undefined;
        return;
      }

      const text = pendingDelta.slice(0, STREAM_CHARS_PER_FRAME);
      pendingDelta = pendingDelta.slice(text.length);
      setTurns((current) => current.map((turn, index) => (
        index === current.length - 1 ? { ...turn, answer: turn.answer + text } : turn
      )));
      if (pendingDelta) flushFrame = window.requestAnimationFrame(flushDelta);
      else {
        resolveDrain?.();
        resolveDrain = undefined;
      }
    }

    /** Buffers irregular model deltas behind the steady visible reveal. */
    function queueDelta(text: string): void {
      pendingDelta += text;
      if (flushFrame === undefined) flushFrame = window.requestAnimationFrame(flushDelta);
    }

    /** Waits for the visible answer to catch up before ending the loading state. */
    function drainDeltas(): Promise<void> {
      if (!pendingDelta && flushFrame === undefined) return Promise.resolve();

      return new Promise((resolve) => {
        resolveDrain = resolve;
        if (flushFrame === undefined) flushFrame = window.requestAnimationFrame(flushDelta);
      });
    }

    try {
      const uploadedAttachments = await Promise.all(questionAttachments.map(encodeAttachment));
      if (controller.signal.aborted) return;
      const attachmentNames = uploadedAttachments.map((attachment) => attachment.name);
      setTurns((current) => [...current, { answer: "", attachments: attachmentNames, question: submittedQuestion }]);
      startedTurn = true;
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          annotationPaths,
          attachments: uploadedAttachments,
          fullHistory: turns,
          history: turns.slice(-MAX_CHAT_HISTORY_TURNS),
          question: submittedQuestion,
          priorHighlights: questionPriorHighlights,
          selection: selectedCode,
          source,
        }),
      });
      if (!response.ok || !response.body) {
        const body: unknown = await response.json();
        const message = isRecord(body) && isString(body.error) ? body.error : "No answer was returned.";
        if (response.status === 401) setOpenAIError(message);
        throw new Error(message);
      }

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) return;
        buffer += value ?? "";
        if (done) buffer += "\n";
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line) continue;
          const event: unknown = JSON.parse(line);
          if (!isRecord(event)) continue;
          if (event.type === "delta" && isString(event.text)) queueDelta(event.text);
          if (event.type === "suggestion" && isString(event.text)) streamedSuggestion = event.text;
          if (event.type === "annotation" && isRecord(event.annotation)) {
            // SAFETY: addModelAnnotation validates each untyped field before creating a source annotation.
            onModelAnnotation(event.annotation as Partial<ModelAnnotation>);
          }
          if (event.type === "error") throw new Error(isString(event.message) ? event.message : "No answer was returned.");
        }

        if (done) break;
      }
      await drainDeltas();
      if (controller.signal.aborted) return;
      if (streamedSuggestion) setSuggestion(streamedSuggestion);
    } catch (error) {
      if (controller.signal.aborted) {
        if (flushFrame !== undefined) window.cancelAnimationFrame(flushFrame);
        return;
      }
      await drainDeltas();
      if (!controller.signal.aborted && startedTurn) {
        const message = error instanceof Error ? error.message : "The question could not be answered. Please try again.";
        setTurns((current) => current.map((turn, index) => (
          index === current.length - 1 ? { ...turn, answer: turn.answer || message } : turn
        )));
      }
      if (!controller.signal.aborted && !startedTurn) setAttachmentError("The attachment could not be read. Try it again.");
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    submitQuestionRef.current = submitQuestion;
  });

  useEffect(() => {
    if (loading || requestRef.current) return;

    const [nextQuestion, ...remainingQuestions] = queuedQuestionsRef.current;
    if (!nextQuestion) return;

    queuedQuestionsRef.current = remainingQuestions;
    setQueuedQuestions(remainingQuestions);
    void submitQuestionRef.current?.(nextQuestion.question, nextQuestion.attachments, nextQuestion.selection, nextQuestion.priorHighlights);
  }, [loading, queuedQuestions]);

  /** Submits the current textarea value or queues it behind this panel's response. */
  function askQuestion(event: FormEvent): void {
    event.preventDefault();
    const submittedQuestion = question.trim();
    if (!submittedQuestion) return;

    if (loading || requestRef.current) {
      queueQuestion(submittedQuestion);
      return;
    }

    const questionAttachments = attachments;
    const questionSelection = selection;
    const questionPriorHighlights = [...priorHighlights];
    setQuestion("");
    setAttachments([]);
    setAttachmentError("");
    void submitQuestion(submittedQuestion, questionAttachments, questionSelection, questionPriorHighlights);
  }

  /** Updates the shared zoom setting and the local editable percentage together. */
  function setChatZoomValue(zoom: number): void {
    onChatZoomChange(zoom);
    setChatZoomInput(String(zoom));
  }

  /** Moves this panel's shared percentage to an adjacent explicit preset. */
  function adjustChatZoom(direction: -1 | 1): void {
    const typedZoom = Number(chatZoomInput);
    const currentZoom = isChatZoom(typedZoom) ? typedZoom : chatZoom;
    setChatZoomValue(adjacentChatZoom(currentZoom, direction));
  }

  /** Commits a manually entered positive percentage or restores the last valid one. */
  function commitChatZoom(): void {
    const typedZoom = Number(chatZoomInput);
    if (!isChatZoom(typedZoom)) {
      setChatZoomInput(String(chatZoom));
      return;
    }
    setChatZoomValue(typedZoom);
  }

  /** Fills the panel's placeholder and keeps the input ready for editing. */
  function fillPlaceholder(): void {
    const placeholder = turns.length ? suggestion : DEFAULT_QUESTION;
    if (!placeholder) return;
    setQuestion(placeholder);
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(placeholder.length, placeholder.length);
    }, 0);
  }

  /** Formats a compact file size for an attachment chip. */
  function attachmentSize(size: number): string {
    return size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  /** Closes only this panel while retaining its latest marker-backed snapshot. */
  function closePanel(): void {
    requestRef.current?.abort();
    requestRef.current = null;
    window.cancelAnimationFrame(momentumFrameRef.current);
    clearQueuedQuestions();
    onClose(snapshot());
  }

  /** Forks the visible conversation into a new independently streamed panel. */
  function forkPanel(): void {
    onFork(snapshot());
  }

  const suggestedQuestion = turns.length ? suggestion : DEFAULT_QUESTION;
  const isGeneratingSuggestion = Boolean(turns.length && loading && !suggestion);
  const panelStyle: ChatPanelStyle = {
    "--chat-font-size": `${chatFontSize}px`,
    bottom: `${16 + stackIndex * 24}px`,
    right: `${16 + stackIndex * 24}px`,
  };
  const canDecreaseChatZoom = adjacentChatZoom(chatZoom, -1) !== chatZoom;
  const canIncreaseChatZoom = adjacentChatZoom(chatZoom, 1) !== chatZoom;
  const attachmentPickerId = `chat-attachment-picker-${chat.id}`;

  return (
    <aside
      ref={panelRef}
      aria-label={selection.text ? "Ask about selected code" : "Ask Diffs"}
      className={`question-panel${isActive ? " active" : ""}${isDraggingFiles ? " dragging-files" : ""}`}
      onDragEnter={beginFileDrag}
      onDragLeave={endFileDrag}
      onDragOver={(event) => event.preventDefault()}
      onDrop={dropAttachments}
      onPointerDown={onFocus}
      style={panelStyle}
    >
      <div
        className="question-panel-header"
        onPointerCancel={stopDragging}
        onPointerDown={startDragging}
        onPointerMove={movePanel}
        onPointerUp={stopDragging}
      >
        <span className="question-panel-title"><Sparkles size={14} /><span>Ask Diffs</span><GripHorizontal className="drag-hint" size={13} /></span>
        <span className="question-panel-header-actions">
          <button aria-label="Fork chat" onClick={forkPanel} title="Fork chat" type="button"><GitFork size={14} /></button>
          <button aria-label="Close" onClick={closePanel} type="button"><X size={15} /></button>
        </span>
      </div>

      {openAIError && (
        <div className="openai-session-error" role="alert">
          <div>
            <strong>OpenAI signed out</strong>
            <span>{openAIError}</span>
          </div>
          <OpenAIConnection compact initiallyConnected={false} />
        </div>
      )}

      {selection.text && (
        <div className="selected-snippet">
          <SelectedSnippet codeSelection={selection} onShow={onShowSelection} />
        </div>
      )}

      {(turns.length > 0 || queuedQuestions.length > 0 || loading) && (
        <div className="conversation" ref={conversationRef}>
          {turns.map((turn, index) => (
            <article className="chat-turn" key={`${turn.question}-${index}`}>
              <PromptPreview question={turn.question} />
              {turn.attachments?.length ? <span className="asked-attachments">{turn.attachments.join(", ")}</span> : null}
              <div className="chat-turn-divider" />
              {turn.answer
                ? index === turns.length - 1 && loading
                  ? <StreamingAnswer answer={turn.answer} />
                  : <div className="chat-markdown"><GitHubMarkdown>{turn.answer}</GitHubMarkdown></div>
                : <div aria-label="Loading response" className="chat-loading-wave" role="status"><span /><span /><span /></div>}
            </article>
          ))}
          {queuedQuestions.map((queuedQuestion) => (
            <article className="chat-turn queued-chat-turn" key={queuedQuestion.id}>
              <div className="queued-question">{queuedQuestion.question}</div>
            </article>
          ))}
        </div>
      )}

      <form onSubmit={askQuestion}>
        {attachments.length > 0 && (
          <div className="attachment-list">
            {attachments.map((attachment, index) => (
              <span className="attachment-chip" key={`${attachment.name}-${attachment.lastModified}`}>
                <Paperclip size={11} />
                <span>{attachment.name}</span>
                <small>{attachmentSize(attachment.size)}</small>
                <button aria-label={`Remove ${attachment.name}`} onClick={() => removeAttachment(index)} type="button"><X size={11} /></button>
              </span>
            ))}
          </div>
        )}
        {attachmentError && <p className="attachment-error">{attachmentError}</p>}
        <div className="question-input">
          {!question && !isGeneratingSuggestion && suggestedQuestion && (
            <span aria-hidden="true" className="question-suggestion">
              <span>{suggestedQuestion}</span>
              <kbd><b>⇥</b> Tab</kbd>
            </span>
          )}
          <textarea
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Tab" && !question && !isGeneratingSuggestion && suggestedQuestion) {
                event.preventDefault();
                fillPlaceholder();
              } else if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            ref={inputRef}
            rows={2}
            value={question}
          />
        </div>
        <div aria-label="Chat text size" className="chat-zoom-controls">
          <button aria-label="Decrease chat text size" disabled={!canDecreaseChatZoom} onClick={() => adjustChatZoom(-1)} type="button"><Minus size={12} /></button>
          <input
            aria-label="Chat zoom percentage"
            className="chat-zoom-value"
            inputMode="decimal"
            onBlur={commitChatZoom}
            onChange={(event) => setChatZoomInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              commitChatZoom();
              event.currentTarget.blur();
            }}
            type="text"
            value={chatZoomInput}
          />
          <span aria-hidden="true" className="chat-zoom-unit">%</span>
          <button aria-label="Increase chat text size" disabled={!canIncreaseChatZoom} onClick={() => adjustChatZoom(1)} type="button"><Plus size={12} /></button>
        </div>
        <input accept="image/*,application/pdf,text/*,.csv,.ts,.tsx,.js,.jsx,.json,.md,.py" className="attachment-picker" id={attachmentPickerId} multiple onChange={selectAttachments} type="file" />
        <label aria-label="Attach files" className="attach-file" htmlFor={attachmentPickerId}><Paperclip size={14} /></label>
        <button className="ask-submit" disabled={!question.trim()}><span>Ask</span><CornerDownLeft size={13} /></button>
      </form>
      <div aria-hidden="true" className="question-panel-resize-handles">
        {RESIZE_DIRECTIONS.map((direction) => (
          <div
            className="question-panel-resize"
            data-direction={direction}
            key={direction}
            onPointerCancel={stopResizing}
            onPointerDown={(event) => startResizing(event, direction)}
            onPointerMove={resizePanel}
            onPointerUp={stopResizing}
          />
        ))}
      </div>
    </aside>
  );
}

/** Detects code selections and presents a movable, multi-turn code conversation. */
export function SelectionQuestion({ aiEnabled, annotationContainerKey, annotationPaths, githubConnected, onAnnotationsChange, onChatMarkersChange, onRevealSelection, programmaticSelection, resumeChat, source }: SelectionQuestionProps) {
  const sourceKey = JSON.stringify(source);
  const router = useRouter();
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [chatZoom, setChatZoom] = useState(storedChatZoom);
  const [annotationStore, setAnnotationStore] = useState<AnnotationStore>();
  const annotations = annotationStore?.source === sourceKey ? annotationStore.annotations : [];
  const [annotationDraft, setAnnotationDraft] = useState<AnnotationDraft | null>(null);
  const [pendingSelection, setPendingSelection] = useState<CodeSelection | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [annotationSidebar, setAnnotationSidebar] = useState<HTMLElement | null>(null);
  const [githubAnnotationConfirmation, setGithubAnnotationConfirmation] = useState<string>();
  const [githubAnnotationError, setGithubAnnotationError] = useState("");
  const [githubAnnotationPending, setGithubAnnotationPending] = useState<string>();
  const [chatMarkers, setChatMarkers] = useState<ChatMarker[]>([]);
  const [openChatIds, setOpenChatIds] = useState<string[]>([]);
  const [activeChatId, setActiveChatId] = useState<string>();
  const [selectionRequest, setSelectionRequest] = useState<SelectionRequest>();
  const annotationInputRef = useRef<HTMLTextAreaElement>(null);
  const draggedPanelRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const momentumFrameRef = useRef(0);
  const annotationCounterRef = useRef(0);
  const activeChatIdRef = useRef<string | undefined>(undefined);
  const openChatIdsRef = useRef<string[]>([]);
  const chatCounterRef = useRef(0);
  const chatSessionsRef = useRef(new Map<string, ChatSession>());
  const lastResumedChatSequenceRef = useRef<number | undefined>(undefined);
  const selectionRequestCounterRef = useRef(0);

  /** Updates the active review's notes without letting a source transition persist an empty list. */
  function updateAnnotations(update: (current: Annotation[]) => Annotation[]): void {
    setAnnotationStore((current) => {
      const currentAnnotations = current?.source === sourceKey ? current.annotations : storedAnnotations(sourceKey);
      const next = update(currentAnnotations);
      storeAnnotations(sourceKey, next);
      return { annotations: next, source: sourceKey };
    });
  }

  /** Stores one panel snapshot without making streamed tokens rerender the surrounding diff. */
  const updateChatSession = useCallback((chat: ChatSession): void => {
    chatSessionsRef.current.set(chat.id, chat);
  }, []);

  /** Exposes only durable source locations for this chat's purple gutter markers. */
  const updateChatMarkers = useCallback((chatId: string, markers: ChatSession["markers"]): void => {
    const nextMarkers = markers.flatMap(({ id, selection }) => (
      selection.location ? [{ chatId, id, location: selection.location }] : []
    ));
    setChatMarkers((current) => [...current.filter((marker) => marker.chatId !== chatId), ...nextMarkers]);
  }, []);

  /** Records the currently focused panel so explicit adds never change another chat's context. */
  function focusChat(chatId: string): void {
    activeChatIdRef.current = chatId;
    setActiveChatId(chatId);
  }

  /** Opens a blank panel or a forked snapshot without closing any current conversation. */
  function openChat(seed?: ChatSession): void {
    chatCounterRef.current += 1;
    const id = `chat-${chatCounterRef.current}`;
    const chat: ChatSession = seed
      ? { ...seed, id, markers: [] }
      : {
        draft: "",
        id,
        markers: [],
        priorHighlights: [],
        selection: { open: true, text: "", x: 0, y: 0 },
        suggestion: "",
        turns: [],
    };
    chatSessionsRef.current.set(id, chat);
    const nextChatIds = [...openChatIdsRef.current, id];
    openChatIdsRef.current = nextChatIds;
    setOpenChatIds(nextChatIds);
    focusChat(id);
    setPendingSelection(null);
    setSelection(null);
  }

  /** Opens an explicitly selected range as an independent new conversation. */
  function openPanel(codeSelection: CodeSelection | null = selection): void {
    if (!codeSelection) return;
    openChat({
      draft: "",
      id: "",
      markers: [],
      priorHighlights: [],
      selection: { ...codeSelection, open: true },
      suggestion: "",
      turns: [],
    });
  }

  /** Delivers an explicitly accepted highlighted range to the focused panel only. */
  function addPendingSelection(codeSelection: CodeSelection): void {
    const chatId = activeChatIdRef.current;
    if (!chatId) return;

    selectionRequestCounterRef.current += 1;
    setSelectionRequest({ chatId, selection: codeSelection, sequence: selectionRequestCounterRef.current });
    setPendingSelection(null);
    setSelection(null);
  }

  /** Retains a closed panel's current state so its purple marker can resume it later. */
  function closeChat(chat: ChatSession): void {
    chatSessionsRef.current.set(chat.id, chat);
    const nextChatIds = openChatIdsRef.current.filter((id) => id !== chat.id);
    openChatIdsRef.current = nextChatIds;
    setOpenChatIds(nextChatIds);
    if (activeChatIdRef.current !== chat.id) return;

    const nextActiveChatId = nextChatIds.at(-1);
    activeChatIdRef.current = nextActiveChatId;
    setActiveChatId(nextActiveChatId);
  }

  /** Keeps an existing marker-backed chat visible without duplicating its history. */
  function reopenChat(chat: ChatSession): void {
    if (!openChatIdsRef.current.includes(chat.id)) {
      const nextChatIds = [...openChatIdsRef.current, chat.id];
      openChatIdsRef.current = nextChatIds;
      setOpenChatIds(nextChatIds);
    }
    focusChat(chat.id);
    setPendingSelection(null);
    setSelection(null);
  }

  useEffect(() => {
    // Notes and open chats belong to the current repository view and cannot be reused against a new source.
    const frame = window.requestAnimationFrame(() => {
      setSelection(null);
      setPendingSelection(null);
      setSelectionRequest(undefined);
      const restoredAnnotations = storedAnnotations(sourceKey);
      annotationCounterRef.current = restoredAnnotations.reduce((highest, annotation) => {
        const suffix = Number(annotation.id.replace("annotation-", ""));
        return Number.isInteger(suffix) ? Math.max(highest, suffix) : highest;
      }, 0);
      setAnnotationStore({ annotations: restoredAnnotations, source: sourceKey });
      setAnnotationDraft(null);
      setCopyStatus("");
      setGithubAnnotationConfirmation(undefined);
      setGithubAnnotationError("");
      setGithubAnnotationPending(undefined);
      activeChatIdRef.current = undefined;
      openChatIdsRef.current = [];
      chatCounterRef.current = 0;
      chatSessionsRef.current.clear();
      setOpenChatIds([]);
      setActiveChatId(undefined);
      setChatMarkers([]);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [sourceKey]);

  useEffect(() => {
    // Save only the state restored for this source, never the empty state between reviews.
    if (annotationStore?.source !== sourceKey) return;
    storeAnnotations(sourceKey, annotationStore.annotations);
  }, [annotationStore, sourceKey]);

  useEffect(() => {
    // Zoom is a user preference, unlike the PR-specific conversation and annotations above.
    storeChatZoom(chatZoom);
  }, [chatZoom]);

  useEffect(() => {
    // The visible review tab owns the sidebar, so resolve its portal target only after that tab commits.
    const frame = window.requestAnimationFrame(() => {
      setAnnotationSidebar(document.querySelector<HTMLElement>(".file-sidebar:not([hidden]) .annotation-sidebar"));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [annotationContainerKey, sourceKey]);

  useEffect(() => {
    // The diff gutter needs only durable source locations, never the selected DOM range.
    onAnnotationsChange?.(annotations.map(({ id, selection }) => ({ id, location: selection.location })));
  }, [annotations, onAnnotationsChange]);

  useEffect(() => {
    // Marker state is separate from annotations because its click target resumes a chat instead of opening a note.
    onChatMarkersChange?.(chatMarkers);
  }, [chatMarkers, onChatMarkersChange]);

  useEffect(() => {
    if (!resumeChat || lastResumedChatSequenceRef.current === resumeChat.sequence) return;

    const chat = chatSessionsRef.current.get(resumeChat.chatId);
    const marker = chat?.markers.find((candidate) => candidate.id === resumeChat.markerId);
    if (!chat || !marker) return;

    lastResumedChatSequenceRef.current = resumeChat.sequence;
    reopenChat(chat);
  }, [resumeChat]);

  useEffect(() => {
    if (!programmaticSelection) return;
    // A Call Flow node stays pending until the user explicitly adds it to the focused open chat.
    if (openChatIdsRef.current.length) {
      setPendingSelection(programmaticSelection);
      return;
    }
    setPendingSelection(null);
    setSelection({ ...programmaticSelection, open: false });
  }, [programmaticSelection]);

  useEffect(() => {
    /** Captures a non-empty diff selection while retaining the current chat's open state. */
    function captureSelection(pointer?: Point, origin?: EventTarget): void {
      const browserSelection = window.getSelection();
      const range = browserSelection ? selectedRange(browserSelection, origin) : undefined;
      const text = range?.toString().trim() ?? "";
      const node = range?.startContainer;
      const element = node instanceof Element ? node : node?.parentElement;
      const root = node?.getRootNode();
      // Diffs can render code in either ordinary DOM or an open shadow tree.
      const selectionElement = root instanceof ShadowRoot ? root.host : element;
      const insideDiff = selectionElement?.closest("[data-diff-selection-root]");

      if (!text || !insideDiff || !range) {
        setPendingSelection(null);
        setSelection(null);
        return;
      }

      const rect = range.getBoundingClientRect();
      const triggerAnchor = pointer ?? (rect.width || rect.height ? { x: rect.right, y: rect.top } : null);
      if (!triggerAnchor) {
        setPendingSelection(null);
        setSelection(null);
        return;
      }

      const maxX = Math.max(window.innerWidth - 238, 8);
      // Keep the contextual controls clear of the persistent bottom-left actions.
      const maxY = Math.max(window.innerHeight - 86, 8);
      const preferredY = triggerAnchor.y + 10 <= maxY ? triggerAnchor.y + 10 : triggerAnchor.y - 41;
      const x = Math.min(Math.max(triggerAnchor.x + 10, 8), maxX);
      const y = Math.min(Math.max(preferredY, 8), maxY);
      const nextSelection = { location: selectionLocation(range), range, text, x, y };
      // A chat keeps its current model context until the user explicitly adds this range.
      if (openChatIdsRef.current.length) {
        setPendingSelection(nextSelection);
        return;
      }
      setPendingSelection(null);
      setSelection({ ...nextSelection, open: false });
    }

    /** Uses the pointer release point after the browser finalizes its selection range. */
    function captureAfterMouseUp(event: MouseEvent): void {
      // A purple gutter marker resumes its existing chat instead of becoming a fresh code selection.
      if (event.composedPath().some((target) => target instanceof Element && target.classList.contains("diffs-inline-chat-marker"))) return;
      if (event.target instanceof Element && event.target.closest(".ai-chat-actions, .annotation-list, .selection-actions, .annotation-composer, .question-panel, .call-diff-viewer")) return;
      const pointer = { x: event.clientX, y: event.clientY };
      const origin = event.composedPath()[0];
      window.requestAnimationFrame(() => captureSelection(pointer, origin));
    }

    /** Captures keyboard-created code selections while ignoring typing inside the chat or annotation composer. */
    function captureAfterKeyUp(event: KeyboardEvent): void {
      if (event.target instanceof Element && event.target.closest(".ai-chat-actions, .annotation-composer, .annotation-list, .question-panel, .selection-actions")) return;
      captureSelection(undefined, event.composedPath()[0]);
    }

    document.addEventListener("keyup", captureAfterKeyUp, true);
    document.addEventListener("mouseup", captureAfterMouseUp, true);
    return () => {
      document.removeEventListener("keyup", captureAfterKeyUp, true);
      document.removeEventListener("mouseup", captureAfterMouseUp, true);
    };
  }, []);

  useEffect(() => {
    /** Enlarges only chat text when Command-Plus originates inside the Ask Diffs panel. */
    function increaseChatFont(event: KeyboardEvent): void {
      const target = event.target;
      const isChatTarget = target instanceof Element && Boolean(target.closest(".question-panel"));
      const isCommandPlus = event.metaKey && !event.altKey && !event.ctrlKey && (event.key === "+" || event.key === "=");

      if (!isCommandPlus || !isChatTarget) return;
      event.preventDefault();
      setChatZoom((zoom) => adjacentChatZoom(zoom, 1));
    }

    window.addEventListener("keydown", increaseChatFont);
    return () => window.removeEventListener("keydown", increaseChatFont);
  }, []);

  /** Opens a compact composer for a note attached to the current highlighted code. */
  function openAnnotationComposer(codeSelection: CodeSelection): void {
    const x = Math.min(codeSelection.x, Math.max(window.innerWidth - 288, 8));
    const y = Math.min(codeSelection.y, Math.max(window.innerHeight - 112, 8));
    setAnnotationDraft({ selection: codeSelection, text: "", x, y });
    window.setTimeout(() => annotationInputRef.current?.focus(), 0);
  }

  /** Adds one non-empty annotation while retaining the exact code range it describes. */
  function addAnnotation(codeSelection: CodeSelection, value: string): void {
    const text = value.trim();
    if (!text) return;

    annotationCounterRef.current += 1;
    const annotation = {
      id: `annotation-${annotationCounterRef.current}`,
      selection: codeSelection,
      text,
    };
    updateAnnotations((current) => {
      const next = [...current, annotation];
      return next;
    });
  }

  /** Stores a source-validated annotation emitted by Ask Diffs without requiring an active selection. */
  function addModelAnnotation(annotation: Partial<ModelAnnotation>): void {
    const path = isString(annotation.path) ? annotation.path.trim() : "";
    const line = annotation.line;
    const text = isString(annotation.text) ? annotation.text.trim() : "";
    if (!path || !isString(annotation.code) || !isInteger(line) || line < 1 || !text) return;

    addAnnotation({ location: { id: path, lineNumber: line }, text: annotation.code, x: 0, y: 0 }, text);
  }

  /** Saves the manual annotation draft and returns the selection controls to their normal state. */
  function saveAnnotation(event: FormEvent): void {
    event.preventDefault();
    if (!annotationDraft) return;

    addAnnotation(annotationDraft.selection, annotationDraft.text);
    setAnnotationDraft(null);
  }

  /** Removes an annotation without changing the underlying highlighted code selection. */
  function removeAnnotation(annotationId: string): void {
    updateAnnotations((current) => {
      const next = current.filter((annotation) => annotation.id !== annotationId);
      return next;
    });
  }

  /** Arms one annotation for GitHub, then posts it only after the user confirms with the checkmark. */
  async function postAnnotationToGitHub(annotation: Annotation): Promise<void> {
    const isPullRequest = source[2] === "pull" && /^\d+$/.test(source[3] ?? "");
    if (!isPullRequest || githubAnnotationPending) return;
    if (!githubConnected) {
      setGithubAnnotationError("Sign in with GitHub from the page header to post annotations.");
      return;
    }

    if (githubAnnotationConfirmation !== annotation.id) {
      setGithubAnnotationConfirmation(annotation.id);
      setGithubAnnotationError("");
      return;
    }

    setGithubAnnotationPending(annotation.id);
    setGithubAnnotationError("");
    try {
      const path = source.map(encodeURIComponent).join("/");
      const response = await fetch(`/api/annotations/${path}`, {
        body: JSON.stringify({
          code: annotation.selection.text,
          location: annotation.selection.location,
          text: annotation.text,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      // SAFETY: The same-origin annotation route returns this documented result envelope.
      const result = await response.json() as { error?: string; url?: string };
      if (!response.ok || !result.url) throw new Error(result.error ?? "GitHub could not create the comment.");

      removeAnnotation(annotation.id);
      setGithubAnnotationConfirmation(undefined);
      router.refresh();
    } catch (error) {
      setGithubAnnotationConfirmation(undefined);
      setGithubAnnotationError(error instanceof Error ? error.message : "GitHub could not create the comment.");
    } finally {
      setGithubAnnotationPending(undefined);
    }
  }

  /** Copies every source reference, selected code block, and annotation in one Markdown-ready clipboard payload. */
  async function copyAnnotations(): Promise<void> {
    if (!annotations.length) return;

    const copiedText = formattedAnnotations(annotations);
    try {
      await navigator.clipboard.writeText(copiedText);
    } catch {
      // This preserves copying in browser contexts that deny the asynchronous Clipboard API.
      const clipboardFallback = document.createElement("textarea");
      clipboardFallback.value = copiedText;
      clipboardFallback.style.position = "fixed";
      document.body.append(clipboardFallback);
      clipboardFallback.select();
      const copied = document.execCommand("copy");
      clipboardFallback.remove();
      if (!copied) {
        setCopyStatus("Copy failed");
        return;
      }
    }

    setCopyStatus("Copied");
    window.setTimeout(() => setCopyStatus(""), 1_200);
  }

  /** Scrolls back to a saved code range and highlights it again in the diff. */
  function showSelection(codeSelection: CodeSelection): void {
    const range = codeSelection.range;
    const node = range?.startContainer;
    const element = node instanceof Element ? node : node?.parentElement;
    if (range && element?.isConnected) {
      const browserSelection = window.getSelection();
      browserSelection?.removeAllRanges();
      browserSelection?.addRange(range.cloneRange());
    }
    if (codeSelection.location) onRevealSelection(codeSelection.location);
    else element?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  }

  /** Places a movable panel inside the viewport and retains an annotation composer position through draft rerenders. */
  function placePanel(panel: HTMLElement, left: number, top: number): Point {
    const maxX = Math.max(window.innerWidth - panel.offsetWidth - 8, 8);
    const maxY = Math.max(window.innerHeight - panel.offsetHeight - 8, 8);
    const x = Math.min(Math.max(left, 8), maxX);
    const y = Math.min(Math.max(top, 8), maxY);
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    if (panel.classList.contains("annotation-composer")) {
      setAnnotationDraft((current) => {
        if (!current || (current.x === x && current.y === y)) return current;
        return { ...current, x, y };
      });
    }
    return { x, y };
  }

  /** Continues a released drag with friction until the panel naturally comes to rest. */
  function continueMomentum(panel: HTMLElement, velocityX: number, velocityY: number): void {
    if (Math.hypot(velocityX, velocityY) < 0.12) return;

    let lastTime = performance.now();
    const move = (time: number): void => {
      const elapsed = Math.min(time - lastTime, 32);
      lastTime = time;
      velocityX *= Math.pow(0.88, elapsed / 16);
      velocityY *= Math.pow(0.88, elapsed / 16);
      const requestedX = panel.offsetLeft + velocityX * elapsed;
      const requestedY = panel.offsetTop + velocityY * elapsed;
      const position = placePanel(panel, requestedX, requestedY);

      if (position.x !== requestedX) velocityX = 0;
      if (position.y !== requestedY) velocityY = 0;
      if (Math.hypot(velocityX, velocityY) >= 0.02) {
        momentumFrameRef.current = window.requestAnimationFrame(move);
      }
    };

    momentumFrameRef.current = window.requestAnimationFrame(move);
  }

  /** Starts moving the panel from its current rendered position. */
  function startDragging(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.target instanceof Element && event.target.closest("button")) return;
    const panel = event.currentTarget.closest<HTMLElement>(".question-panel, .annotation-composer");
    if (!panel) return;

    const rect = panel.getBoundingClientRect();
    window.cancelAnimationFrame(momentumFrameRef.current);
    draggedPanelRef.current = panel;
    dragRef.current = {
      lastTime: performance.now(),
      lastX: event.clientX,
      lastY: event.clientY,
      left: rect.left,
      top: rect.top,
      velocityX: 0,
      velocityY: 0,
      x: event.clientX,
      y: event.clientY,
    };
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  /** Keeps the dragged panel fully inside the current viewport. */
  function movePanel(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    const panel = draggedPanelRef.current;
    if (!drag || !panel) return;

    const time = performance.now();
    const elapsed = Math.max(time - drag.lastTime, 1);
    drag.velocityX = (event.clientX - drag.lastX) / elapsed;
    drag.velocityY = (event.clientY - drag.lastY) / elapsed;
    drag.lastTime = time;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    placePanel(panel, drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
  }

  /** Ends panel movement and releases pointer capture. */
  function stopDragging(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    const panel = draggedPanelRef.current;
    dragRef.current = null;
    draggedPanelRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag && panel && event.type !== "pointercancel") continueMomentum(panel, drag.velocityX, drag.velocityY);
  }

  const triggerSelection = pendingSelection ?? selection;
  const hasOpenChat = openChatIds.length > 0;
  const isPullRequest = source[2] === "pull" && /^\d+$/.test(source[3] ?? "");
  const annotationList = annotations.length > 0 && (
    <div className="annotation-list">
      <div className="annotation-list-title">
        <span>Annotations <b>{annotations.length}</b></span>
        <button aria-label={copyStatus === "Copied" ? "Annotations copied" : "Copy annotations"} className={`annotation-copy${copyStatus === "Copied" ? " copied" : ""}`} onClick={() => void copyAnnotations()} title={copyStatus === "Copied" ? "Annotations copied" : "Copy annotations"} type="button">
          {copyStatus === "Copied" ? <Check size={13} /> : <ClipboardCopy size={13} />}
        </button>
      </div>
      {annotations.map((annotation) => (
        <div className="annotation-item" key={annotation.id}>
          <button className="annotation-open" onClick={() => showSelection(annotation.selection)} type="button">
            <span className="annotation-location">
              {annotation.selection.location
                ? `${annotation.selection.location.id}:${annotation.selection.location.lineNumber}`
                : "Selected code"}
            </span>
            <AnnotationSnippet codeSelection={annotation.selection} />
            <span className="annotation-text">{annotation.text}</span>
          </button>
          <button aria-label="Remove annotation" className="annotation-remove" onClick={() => removeAnnotation(annotation.id)} type="button"><X size={12} /></button>
          <button
            aria-label={githubAnnotationConfirmation === annotation.id ? "Confirm posting local annotation to GitHub" : "Post local annotation to GitHub"}
            aria-pressed={githubAnnotationConfirmation === annotation.id}
            className={`annotation-github${githubAnnotationConfirmation === annotation.id ? " confirming" : ""}`}
            disabled={!isPullRequest || Boolean(githubAnnotationPending)}
            onClick={() => void postAnnotationToGitHub(annotation)}
            title={!isPullRequest ? "GitHub comments are available only on pull requests" : !githubConnected ? "Sign in with GitHub from the page header to post annotations" : githubAnnotationConfirmation === annotation.id ? "Click again to post this annotation as a GitHub comment" : "Post this local annotation as a GitHub pull request comment"}
            type="button"
          >
            {githubAnnotationConfirmation === annotation.id ? <Check size={10} /> : <Github size={10} />}
          </button>
        </div>
      ))}
      {githubAnnotationError && <span aria-live="polite" className="annotation-github-status">{githubAnnotationError}</span>}
      {copyStatus === "Copy failed" && <span aria-live="polite" className="annotation-copy-status">{copyStatus}</span>}
    </div>
  );

  return (
    <>
      {annotationList && annotationSidebar && createPortal(annotationList, annotationSidebar)}

      {aiEnabled && (
        <div className="ai-chat-actions">
          <button aria-label="Open Ask Diffs" className="ai-chat-launch" onClick={() => openChat()} type="button">
            <Sparkles size={14} /> <span>Ask Diffs</span>
          </button>
          {!annotationSidebar && <button aria-label={copyStatus === "Copied" ? "Annotations copied" : "Copy Annotations"} className={`copy-annotations${copyStatus === "Copied" ? " copied" : ""}`} disabled={!annotations.length} onClick={() => void copyAnnotations()} type="button">
            {copyStatus === "Copied" ? <Check size={14} /> : <ClipboardCopy size={14} />} <span>Copy Annotations</span>
          </button>}
        </div>
      )}

      {triggerSelection && !annotationDraft && (
        <div className="selection-actions" style={{ left: triggerSelection.x, top: triggerSelection.y }}>
          <button className="selection-trigger" onMouseDown={(event) => event.preventDefault()} onClick={() => openAnnotationComposer(triggerSelection)} type="button">
            <MessageSquarePlus size={13} /> <span>Annotate</span>
          </button>
          {aiEnabled && (
            <button className="selection-trigger" onMouseDown={(event) => event.preventDefault()} onClick={hasOpenChat ? () => addPendingSelection(triggerSelection) : () => openPanel(triggerSelection)} type="button">
              <Plus size={13} /> <span>{hasOpenChat ? "Add to chat" : "Ask Diffs"}</span>
            </button>
          )}
        </div>
      )}

      {annotationDraft && (
        <form className="annotation-composer" onSubmit={saveAnnotation} style={{ left: annotationDraft.x, top: annotationDraft.y }}>
          <div
            className="annotation-composer-header"
            onPointerCancel={stopDragging}
            onPointerDown={startDragging}
            onPointerMove={movePanel}
            onPointerUp={stopDragging}
            title="Drag to move annotation composer"
          >
            <span><GripHorizontal className="drag-hint" size={13} /></span>
          </div>
          <textarea
            aria-label="Annotation"
            onChange={(event) => setAnnotationDraft((current) => current ? { ...current, text: event.target.value } : current)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !event.metaKey || !annotationDraft.text.trim()) return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
            placeholder="Add a short annotation"
            ref={annotationInputRef}
            rows={2}
            value={annotationDraft.text}
          />
          <div className="annotation-composer-actions">
            <button onClick={() => setAnnotationDraft(null)} type="button">Cancel</button>
            <button disabled={!annotationDraft.text.trim()} type="submit">Add annotation</button>
          </div>
        </form>
      )}

      {openChatIds.map((chatId, index) => {
        const chat = chatSessionsRef.current.get(chatId);
        if (!chat) return null;

        return (
          <AskDiffsPanel
            annotationPaths={annotationPaths}
            chat={chat}
            chatZoom={chatZoom}
            isActive={chat.id === activeChatId}
            key={chat.id}
            onChatChange={updateChatSession}
            onChatZoomChange={setChatZoom}
            onClose={closeChat}
            onFocus={() => focusChat(chat.id)}
            onFork={openChat}
            onMarkersChange={updateChatMarkers}
            onModelAnnotation={addModelAnnotation}
            onShowSelection={showSelection}
            selectionRequest={selectionRequest}
            source={source}
            stackIndex={index}
          />
        );
      })}
    </>
  );
}
