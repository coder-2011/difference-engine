"use client";

import { getFiletypeFromFileName, getSharedHighlighter } from "@pierre/diffs";
import { Check, ClipboardCopy, CornerDownLeft, Github, GripHorizontal, MessageSquarePlus, Minus, Paperclip, Plus, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import type { CSSProperties } from "react";
import { ChangeEvent, DragEvent, FormEvent, Fragment, PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GitHubMarkdown } from "@/components/github-markdown";
import { OpenAIConnection } from "@/components/openai-connection";
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  MAX_CHAT_HISTORY_TURNS,
  type ChatTurn,
} from "@/types/chat";

const DEFAULT_QUESTION = "What does this code do?";
const DEFAULT_CHAT_FONT_SIZE = 12;
const MAX_CHAT_FONT_SIZE = 22;
const MIN_CHAT_FONT_SIZE = 10;
const CHAT_FONT_SIZE_STORAGE_KEY = "diffs:chat-font-size";
const MAX_PRIOR_HIGHLIGHTS = 3;
const MIN_PANEL_HEIGHT = 120;
const MIN_PANEL_WIDTH = 300;
const STREAM_CHARS_PER_TICK = 24;
const STREAM_RENDER_INTERVAL = 24;
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

export type ProgrammaticSelection = Point & {
  location: CodeSelectionLocation;
  text: string;
};

type SelectionQuestionProps = {
  aiEnabled: boolean;
  annotationContainerKey?: string;
  annotationPaths: string[];
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

/** Restores serializable annotations while intentionally leaving stale DOM ranges behind. */
function storedAnnotations(sourceKey: string): Annotation[] {
  try {
    const stored = JSON.parse(window.localStorage.getItem(annotationStorageKey(sourceKey)) ?? "[]") as unknown;
    if (!Array.isArray(stored)) return [];

    return stored.flatMap((value): Annotation[] => {
      if (!value || typeof value !== "object") return [];

      const annotation = value as Partial<StoredAnnotation>;
      const selection = annotation.selection;
      const location = selection?.location;
      if (typeof annotation.id !== "string" || typeof annotation.text !== "string" || typeof selection?.text !== "string") return [];
      if (location && (typeof location.id !== "string" || typeof location.lineNumber !== "number")) return [];

      return [{
        id: annotation.id,
        selection: { location, text: selection.text, x: 0, y: 0 },
        text: annotation.text,
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

/** Restores a valid user-wide Ask Diffs text size without trusting stale browser data. */
function storedChatFontSize(): number {
  try {
    const stored = Number(window.localStorage.getItem(CHAT_FONT_SIZE_STORAGE_KEY));
    if (!Number.isInteger(stored) || stored < MIN_CHAT_FONT_SIZE || stored > MAX_CHAT_FONT_SIZE) return DEFAULT_CHAT_FONT_SIZE;
    return stored;
  } catch {
    return DEFAULT_CHAT_FONT_SIZE;
  }
}

/** Saves the user-wide Ask Diffs text size while allowing the panel to work without storage. */
function storeChatFontSize(size: number): void {
  try {
    window.localStorage.setItem(CHAT_FONT_SIZE_STORAGE_KEY, String(size));
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
  if (!id || typeof lineAttribute !== "string") return undefined;

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
  const endLineNumber = typeof endLineAttribute === "string" ? Number(endLineAttribute) : undefined;
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
  const [tokens, setTokens] = useState<SnippetToken[][]>();

  useEffect(() => {
    if (!active || tokens || !codeSelection.location) return;

    let cancelled = false;
    const language = getFiletypeFromFileName(codeSelection.location.id);
    void getSharedHighlighter({
      langs: [language],
      preferredHighlighter: "shiki-wasm",
      themes: ["pierre-dark"],
    }).then((highlighter) => highlighter.codeToTokens(codeSelection.text, {
      lang: language,
      theme: "pierre-dark",
    })).then((result) => {
      if (!cancelled) setTokens(result.tokens);
    }).catch(() => {
      // The plain snippet remains usable if this file's grammar cannot load.
    });

    return () => {
      cancelled = true;
    };
  }, [active, codeSelection.location, codeSelection.text, tokens]);

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

/** Detects code selections and presents a movable, multi-turn code conversation. */
export function SelectionQuestion({ aiEnabled, annotationContainerKey, annotationPaths, onAnnotationsChange, onChatMarkersChange, onRevealSelection, programmaticSelection, resumeChat, source }: SelectionQuestionProps) {
  const sourceKey = JSON.stringify(source);
  const router = useRouter();
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [suggestion, setSuggestion] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [queuedQuestions, setQueuedQuestions] = useState<QueuedQuestion[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [openAIError, setOpenAIError] = useState("");
  const [chatFontSize, setChatFontSize] = useState(storedChatFontSize);
  // Keep the user-visible scale anchored to the default Ask Diffs text size.
  const chatZoomPercent = Math.round((chatFontSize / DEFAULT_CHAT_FONT_SIZE) * 100);
  const conversationActive = Boolean(turns.length || loading);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationStorageSource, setAnnotationStorageSource] = useState<string>();
  const [annotationDraft, setAnnotationDraft] = useState<AnnotationDraft | null>(null);
  const [pendingSelection, setPendingSelection] = useState<CodeSelection | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [annotationSidebar, setAnnotationSidebar] = useState<HTMLElement | null>(null);
  const [githubAnnotationConfirmation, setGithubAnnotationConfirmation] = useState<string>();
  const [githubAnnotationError, setGithubAnnotationError] = useState("");
  const [githubAnnotationPending, setGithubAnnotationPending] = useState<string>();
  const [chatMarkers, setChatMarkers] = useState<ChatMarker[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const annotationInputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const draggedPanelRef = useRef<HTMLElement | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const momentumFrameRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const chatOpenRef = useRef(false);
  const chatSelectionRangeRef = useRef<Range | undefined>(undefined);
  const activeChatSelectionRef = useRef<CodeSelection | undefined>(undefined);
  const priorHighlightsRef = useRef<string[]>([]);
  const followsConversationRef = useRef(true);
  const dragDepthRef = useRef(0);
  const annotationCounterRef = useRef(0);
  const activeChatIdRef = useRef<string | undefined>(undefined);
  const chatCounterRef = useRef(0);
  const chatSessionsRef = useRef(new Map<string, ChatSession>());
  // A parent-held resume request must restore its chat once even if that restore rerenders this component.
  const lastResumedChatSequenceRef = useRef<number | undefined>(undefined);
  const queuedQuestionsRef = useRef<QueuedQuestion[]>([]);
  const queuedQuestionCounterRef = useRef(0);
  // The queue effect must always submit through the handler from the current render.
  const submitQuestionRef = useRef<SubmitQuestion | undefined>(undefined);

  /** Drops queued prompts whenever their selected-code context is discarded. */
  function clearQueuedQuestions(): void {
    queuedQuestionsRef.current = [];
    setQueuedQuestions([]);
  }

  /** Gives each selected source range one stable marker identity within its chat. */
  function chatMarkerLocationKey(location: CodeSelectionLocation): string {
    return [
      location.id,
      location.lineNumber,
      location.endLineNumber ?? location.lineNumber,
      location.side ?? "",
      location.endSide ?? location.side ?? "",
    ].join("\0");
  }

  /** Saves the visible chat state so its purple source marker can reopen the same conversation. */
  const saveActiveChat = useCallback((): void => {
    const chatId = activeChatIdRef.current;
    const chat = chatId ? chatSessionsRef.current.get(chatId) : undefined;
    if (!chat) return;

    chat.draft = question;
    chat.priorHighlights = [...priorHighlightsRef.current];
    chat.selection = selection ?? chat.selection;
    chat.suggestion = suggestion;
    chat.turns = turns;
  }, [question, selection, suggestion, turns]);

  /** Starts a track lazily and adds a purple marker only after selected code is actually asked about. */
  function trackQuestionSelection(codeSelection: SelectionState): void {
    if (!codeSelection.text || !codeSelection.location) return;

    let chatId = activeChatIdRef.current;
    let chat = chatId ? chatSessionsRef.current.get(chatId) : undefined;
    if (!chat) {
      chatCounterRef.current += 1;
      chatId = `chat-${chatCounterRef.current}`;
      chat = {
        draft: question,
        id: chatId,
        markers: [],
        priorHighlights: [...priorHighlightsRef.current],
        selection: codeSelection,
        suggestion,
        turns,
      };
      chatSessionsRef.current.set(chatId, chat);
      activeChatIdRef.current = chatId;
    }

    chat.selection = codeSelection;
    const locationKey = chatMarkerLocationKey(codeSelection.location);
    if (chat.markers.some((marker) => marker.selection.location && chatMarkerLocationKey(marker.selection.location) === locationKey)) return;

    const markerId = `chat-marker-${chat.id}-${chat.markers.length + 1}`;
    chat.markers.push({ id: markerId, selection: codeSelection });
    setChatMarkers((current) => [...current, { chatId: chat.id, id: markerId, location: codeSelection.location! }]);
  }

  /** Holds a submitted prompt until the active answer has finished streaming. */
  function queueQuestion(value: string): void {
    const question = value.trim();
    if (!question || !selection) return;

    queuedQuestionCounterRef.current += 1;
    const next = [...queuedQuestionsRef.current, {
      attachments: [...attachments],
      id: queuedQuestionCounterRef.current,
      priorHighlights: [...priorHighlightsRef.current],
      question,
      selection,
    }];
    queuedQuestionsRef.current = next;
    setQueuedQuestions(next);
    setQuestion("");
    setAttachments([]);
    setAttachmentError("");
  }

  useEffect(() => {
    // Notes and active requests belong to the current repository view and cannot be reused against a new source.
    requestRef.current?.abort();
    requestRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      setLoading(false);
      setSelection(null);
      setPendingSelection(null);
      setQuestion("");
      setTurns([]);
      setSuggestion("");
      setAttachments([]);
      clearQueuedQuestions();
      queuedQuestionCounterRef.current = 0;
      setAttachmentError("");
      const restoredAnnotations = storedAnnotations(sourceKey);
      annotationCounterRef.current = restoredAnnotations.reduce((highest, annotation) => {
        const suffix = Number(annotation.id.replace("annotation-", ""));
        return Number.isInteger(suffix) ? Math.max(highest, suffix) : highest;
      }, 0);
      setAnnotations(restoredAnnotations);
      setAnnotationStorageSource(sourceKey);
      setAnnotationDraft(null);
      setCopyStatus("");
      setGithubAnnotationConfirmation(undefined);
      setGithubAnnotationError("");
      setGithubAnnotationPending(undefined);
      activeChatIdRef.current = undefined;
      chatCounterRef.current = 0;
      chatSessionsRef.current.clear();
      setChatMarkers([]);
      activeChatSelectionRef.current = undefined;
      chatOpenRef.current = false;
      priorHighlightsRef.current = [];
    });

    return () => window.cancelAnimationFrame(frame);
  }, [sourceKey]);

  useEffect(() => {
    // Do not let the initial empty render erase annotations before this source has restored them.
    if (annotationStorageSource !== sourceKey) return;
    storeAnnotations(sourceKey, annotations);
  }, [annotationStorageSource, annotations, sourceKey]);

  useEffect(() => {
    // Zoom is a user preference, unlike the PR-specific conversation and annotations above.
    storeChatFontSize(chatFontSize);
  }, [chatFontSize]);

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
    // Keep the active conversation current without rerendering the durable gutter marker list for every streamed token.
    saveActiveChat();
  }, [saveActiveChat]);

  useEffect(() => {
    if (!resumeChat || lastResumedChatSequenceRef.current === resumeChat.sequence) return;

    const chat = chatSessionsRef.current.get(resumeChat.chatId);
    const marker = chat?.markers.find((candidate) => candidate.id === resumeChat.markerId);
    if (!chat || !marker) return;

    // Preserve a currently open track before the clicked marker switches back to another one.
    lastResumedChatSequenceRef.current = resumeChat.sequence;
    saveActiveChat();
    requestRef.current?.abort();
    requestRef.current = null;
    activeChatIdRef.current = chat.id;
    chatOpenRef.current = true;
    followsConversationRef.current = true;
    priorHighlightsRef.current = [...chat.priorHighlights];
    setPendingSelection(null);
    setSelection({ ...marker.selection, open: true });
    setQuestion(chat.draft);
    setTurns(chat.turns);
    setLoading(false);
    setSuggestion(chat.suggestion);
    setAttachments([]);
    clearQueuedQuestions();
    setAttachmentError("");
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [resumeChat, saveActiveChat]);

  useEffect(() => {
    if (!programmaticSelection) return;
    // A Call Flow node stays pending until the user explicitly adds it to an open chat.
    if (chatOpenRef.current) {
      setPendingSelection(programmaticSelection);
      return;
    }
    setPendingSelection(null);
    setSelection({ ...programmaticSelection, open: false });
  }, [programmaticSelection]);

  useEffect(() => {
    if (!selection?.open) {
      chatSelectionRangeRef.current = undefined;
      return;
    }
    if (
      chatSelectionRangeRef.current === selection.range
      && activeChatSelectionRef.current?.text === selection.text
      && activeChatSelectionRef.current?.location?.id === selection.location?.id
      && activeChatSelectionRef.current?.location?.lineNumber === selection.location?.lineNumber
    ) return;

    const priorHighlight = activeChatSelectionRef.current?.text.trim();
    // Keep earlier highlights private until the next question directly refers to one.
    if (priorHighlight && priorHighlight !== selection.text) {
      priorHighlightsRef.current = [...priorHighlightsRef.current.filter((highlight) => highlight !== priorHighlight), priorHighlight]
        .slice(-MAX_PRIOR_HIGHLIGHTS);
    }
    // The new range applies to future prompts while visible answers keep their original request context.
    chatSelectionRangeRef.current = selection.range;
    activeChatSelectionRef.current = selection;
  }, [selection]);

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
        setSelection((current) => current?.open ? current : null);
        return;
      }

      const rect = range.getBoundingClientRect();
      const triggerAnchor = pointer ?? (rect.width || rect.height ? { x: rect.right, y: rect.top } : null);
      if (!triggerAnchor) {
        setPendingSelection(null);
        setSelection((current) => current?.open ? current : null);
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
      if (chatOpenRef.current) {
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
      setChatFontSize((size) => Math.min(size + 1, MAX_CHAT_FONT_SIZE));
    }

    window.addEventListener("keydown", increaseChatFont);
    return () => window.removeEventListener("keydown", increaseChatFont);
  }, []);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation && followsConversationRef.current) {
      conversation.scrollTop = conversation.scrollHeight;
    }
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

    /** Stops bottom-following before an upward wheel gesture can be overwritten by the next token. */
    function stopFollowingOnWheel(event: WheelEvent): void {
      if (event.deltaY < 0) followsConversationRef.current = false;
    }

    /** Gives touch and scrollbar gestures control before incoming text can move the viewport. */
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

  /** Opens a draft question for the first selected code block without sending it. */
  function openPanel(): void {
    chatOpenRef.current = true;
    followsConversationRef.current = true;
    setPendingSelection(null);
    setSelection((current) => current && { ...current, open: true });
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  /** Starts a fresh empty repository chat without sending a question. */
  function openChat(): void {
    requestRef.current?.abort();
    requestRef.current = null;
    followsConversationRef.current = true;
    chatOpenRef.current = true;
    activeChatIdRef.current = undefined;
    chatSelectionRangeRef.current = undefined;
    activeChatSelectionRef.current = undefined;
    priorHighlightsRef.current = [];
    setQuestion("");
    setTurns([]);
    setLoading(false);
    setSuggestion("");
    setAttachments([]);
    clearQueuedQuestions();
    setAttachmentError("");
    setPendingSelection(null);
    setSelection({ open: true, text: "", x: 0, y: 0 });
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  /** Adds the pending highlighted range to the open chat without clearing its conversation. */
  function addPendingSelection(): void {
    if (!pendingSelection) return;
    chatOpenRef.current = true;
    setPendingSelection(null);
    setSelection({ ...pendingSelection, open: true });
  }

  /** Opens a compact composer for a note attached to the current highlighted code. */
  function openAnnotationComposer(codeSelection: CodeSelection): void {
    const x = Math.min(codeSelection.x, Math.max(window.innerWidth - 328, 8));
    const y = Math.min(codeSelection.y, Math.max(window.innerHeight - 144, 8));
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
    setAnnotations((current) => {
      const next = [...current, annotation];
      storeAnnotations(sourceKey, next);
      return next;
    });
  }

  /** Stores a source-validated annotation emitted by Ask Diffs without requiring an active selection. */
  function addModelAnnotation(annotation: Partial<ModelAnnotation>): void {
    const path = typeof annotation.path === "string" ? annotation.path.trim() : "";
    const line = annotation.line;
    const text = typeof annotation.text === "string" ? annotation.text.trim() : "";
    if (!path || typeof annotation.code !== "string" || typeof line !== "number" || !Number.isInteger(line) || line < 1 || !text) return;

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
    setAnnotations((current) => {
      const next = current.filter((annotation) => annotation.id !== annotationId);
      storeAnnotations(sourceKey, next);
      return next;
    });
  }

  /** Arms one annotation for GitHub, then posts it only after the user confirms with the checkmark. */
  async function postAnnotationToGitHub(annotation: Annotation): Promise<void> {
    const isPullRequest = source[2] === "pull" && /^\d+$/.test(source[3] ?? "");
    if (!isPullRequest || githubAnnotationPending) return;

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
    window.setTimeout(() => setCopyStatus(""), 2_000);
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

  /** Closes the panel while preserving its marker-backed conversation for a later marker click. */
  function closePanel(): void {
    saveActiveChat();
    // Aborting prevents a completed request from leaking into the next code selection.
    requestRef.current?.abort();
    requestRef.current = null;
    window.cancelAnimationFrame(momentumFrameRef.current);
    followsConversationRef.current = true;
    chatOpenRef.current = false;
    setSelection(null);
    setPendingSelection(null);
    setQuestion("");
    setTurns([]);
    setLoading(false);
    setSuggestion("");
    setAttachments([]);
    clearQueuedQuestions();
    setAttachmentError("");
    activeChatIdRef.current = undefined;
    activeChatSelectionRef.current = undefined;
    priorHighlightsRef.current = [];
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
    if ((event.target as Element).closest("button")) return;
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

  /** Starts a resize while preserving the opposite edge of the panel. */
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

  /** Applies pointer movement to the selected edges without letting the panel leave the viewport. */
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

  /** Ends an edge or corner resize and returns pointer control to the rest of the panel. */
  function stopResizing(event: ReactPointerEvent<HTMLDivElement>): void {
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  /** Converts one pending browser file to the data URL accepted by the model request. */
  function encodeAttachment(file: File): Promise<UploadedAttachment> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== "string") {
          reject(new Error("The file could not be read."));
          return;
        }
        resolve({ data: reader.result, name: file.name, type: file.type });
      };
      reader.onerror = () => reject(new Error("The file could not be read."));
      reader.readAsDataURL(file);
    });
  }

  /** Adds dropped or picked files while enforcing the chat attachment budget. */
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

  /** Removes one pending attachment before the question is sent. */
  function removeAttachment(index: number): void {
    setAttachments((current) => current.filter((_, currentIndex) => currentIndex !== index));
    setAttachmentError("");
  }

  /** Adds files selected through the native file picker. */
  function selectAttachments(event: ChangeEvent<HTMLInputElement>): void {
    addAttachments(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  /** Shows the drop target only while files are being dragged over the chat panel. */
  function beginFileDrag(event: DragEvent<HTMLElement>): void {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  }

  /** Hides the drop target after the drag leaves the chat panel. */
  function endFileDrag(event: DragEvent<HTMLElement>): void {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(dragDepthRef.current - 1, 0);
    if (!dragDepthRef.current) setIsDraggingFiles(false);
  }

  /** Attaches files dropped anywhere over the open chat panel. */
  function dropAttachments(event: DragEvent<HTMLElement>): void {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    addAttachments(Array.from(event.dataTransfer.files));
  }

  /** Sends one question against its captured code selection, history, and attachments. */
  async function submitQuestion(
    value: string,
    questionAttachments: File[],
    questionSelection: SelectionState | null = selection,
    questionPriorHighlights: string[] = priorHighlightsRef.current,
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
    let flushTimer = 0;
    let resolveDrain: (() => void) | undefined;
    let startedTurn = false;
    let streamedSuggestion = "";

    /** Reveals one small text batch, then keeps draining at a stable visual cadence. */
    function flushDelta(): void {
      if (flushTimer) window.clearTimeout(flushTimer);
      flushTimer = 0;
      // Closing a task discards its buffered tail before a later task can receive it.
      if (controller.signal.aborted) pendingDelta = "";
      if (!pendingDelta) {
        resolveDrain?.();
        resolveDrain = undefined;
        return;
      }

      const text = pendingDelta.slice(0, STREAM_CHARS_PER_TICK);
      pendingDelta = pendingDelta.slice(text.length);
      setTurns((current) => current.map((turn, index) => (
        index === current.length - 1 ? { ...turn, answer: turn.answer + text } : turn
      )));
      if (pendingDelta) {
        flushTimer = window.setTimeout(flushDelta, STREAM_RENDER_INTERVAL);
      } else {
        resolveDrain?.();
        resolveDrain = undefined;
      }
    }

    /** Buffers irregular model deltas behind the steady visible reveal. */
    function queueDelta(text: string): void {
      pendingDelta += text;
      if (!flushTimer) flushTimer = window.setTimeout(flushDelta, STREAM_RENDER_INTERVAL);
    }

    /** Waits for the visible answer to catch up before ending the loading state. */
    function drainDeltas(): Promise<void> {
      if (!pendingDelta && !flushTimer) return Promise.resolve();

      return new Promise((resolve) => {
        resolveDrain = resolve;
        if (!flushTimer) flushTimer = window.setTimeout(flushDelta, STREAM_RENDER_INTERVAL);
      });
    }

    try {
      const uploadedAttachments = await Promise.all(questionAttachments.map(encodeAttachment));
      // Closing the panel can abort while FileReader is still resolving an attachment.
      if (controller.signal.aborted) return;
      const attachmentNames = uploadedAttachments.map((attachment) => attachment.name);
      setTurns((current) => [...current, {
        answer: "",
        attachments: attachmentNames,
        question: submittedQuestion,
      }]);
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
        const body = (await response.json()) as { error?: string };
        const message = body.error ?? "No answer was returned.";
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
          const event = JSON.parse(line) as { annotation?: Partial<ModelAnnotation>; message?: string; text?: string; type?: string };
          if (event.type === "delta" && event.text) queueDelta(event.text);
          if (event.type === "suggestion" && event.text) streamedSuggestion = event.text;
          if (event.type === "annotation" && event.annotation) addModelAnnotation(event.annotation);
          if (event.type === "error") throw new Error(event.message);
        }

        if (done) break;
      }
      await drainDeltas();
      if (controller.signal.aborted) return;
      if (streamedSuggestion) setSuggestion(streamedSuggestion);
    } catch (error) {
      if (controller.signal.aborted) {
        window.clearTimeout(flushTimer);
        return;
      }
      await drainDeltas();
      if (!controller.signal.aborted && startedTurn) {
        const message = error instanceof Error ? error.message : "The question could not be answered. Please try again.";
        setTurns((current) => current.map((turn, index) => (
          index === current.length - 1
            ? { ...turn, answer: turn.answer || message }
            : turn
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
    // Start exactly one queued question after the active stream has fully settled.
    if (loading || requestRef.current) return;

    const [nextQuestion, ...remainingQuestions] = queuedQuestionsRef.current;
    if (!nextQuestion) return;

    queuedQuestionsRef.current = remainingQuestions;
    setQueuedQuestions(remainingQuestions);
    void submitQuestionRef.current?.(nextQuestion.question, nextQuestion.attachments, nextQuestion.selection, nextQuestion.priorHighlights);
  }, [loading, queuedQuestions]);

  /** Submits the current textarea value without a page navigation. */
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
    const questionPriorHighlights = [...priorHighlightsRef.current];
    setQuestion("");
    setAttachments([]);
    setAttachmentError("");
    void submitQuestion(submittedQuestion, questionAttachments, questionSelection, questionPriorHighlights);
  }

  /** Changes only the Ask Diffs text scale within its readable bounds. */
  function adjustChatFontSize(amount: number): void {
    setChatFontSize((size) => Math.min(MAX_CHAT_FONT_SIZE, Math.max(MIN_CHAT_FONT_SIZE, size + amount)));
  }

  /** Fills the visible placeholder and leaves the cursor ready to edit it. */
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

  const triggerSelection = selection?.open ? pendingSelection : selection;
  const suggestedQuestion = turns.length ? suggestion : DEFAULT_QUESTION;
  const isGeneratingSuggestion = Boolean(turns.length && loading && !suggestion);
  const canPostAnnotationsToGitHub = source[2] === "pull" && /^\d+$/.test(source[3] ?? "");
  const annotationList = annotations.length > 0 && (
    <div className="annotation-list">
      <div className="annotation-list-title">
        <span>Annotations <b>{annotations.length}</b></span>
        <button aria-label="Copy annotations" className="annotation-copy" onClick={() => void copyAnnotations()} title="Copy annotations" type="button"><ClipboardCopy size={13} /></button>
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
            aria-label={githubAnnotationConfirmation === annotation.id ? "Post annotation to GitHub" : "Prepare annotation for GitHub"}
            aria-pressed={githubAnnotationConfirmation === annotation.id}
            className={`annotation-github${githubAnnotationConfirmation === annotation.id ? " confirming" : ""}`}
            disabled={!canPostAnnotationsToGitHub || Boolean(githubAnnotationPending)}
            onClick={() => void postAnnotationToGitHub(annotation)}
            title={!canPostAnnotationsToGitHub ? "GitHub comments are available only on pull requests" : "Post this annotation to GitHub"}
            type="button"
          >
            {githubAnnotationConfirmation === annotation.id ? <Check size={15} /> : <Github size={15} />}
          </button>
        </div>
      ))}
      {githubAnnotationError && <span aria-live="polite" className="annotation-github-status">{githubAnnotationError}</span>}
      {copyStatus && <span aria-live="polite" className="annotation-copy-status">{copyStatus}</span>}
    </div>
  );

  return (
    <>
      {annotationList && annotationSidebar && createPortal(annotationList, annotationSidebar)}

      {!selection?.open && aiEnabled && (
        <div className="ai-chat-actions">
          <button aria-label="Open Ask Diffs" className="ai-chat-launch" onClick={openChat} type="button">
            <Sparkles size={14} /> <span>Ask Diffs</span>
          </button>
          {!annotationSidebar && <button aria-label={copyStatus === "Copied" ? "Annotations copied" : "Copy Annotations"} className={`copy-annotations${copyStatus === "Copied" ? " copied" : ""}`} disabled={!annotations.length} onClick={() => void copyAnnotations()} type="button">
            {copyStatus === "Copied" ? <Check size={14} /> : <ClipboardCopy size={14} />} <span>Copy Annotations</span>
          </button>}
        </div>
      )}

      {triggerSelection && !annotationDraft && (
        <div className="selection-actions" style={{ left: triggerSelection.x, top: triggerSelection.y }}>
          {selection?.open && (
            <button className="selection-trigger" onMouseDown={(event) => event.preventDefault()} onClick={() => openAnnotationComposer(triggerSelection)} type="button">
              <MessageSquarePlus size={13} /> <span>Annotate</span>
            </button>
          )}
          {aiEnabled && (
            <button className="selection-trigger" onMouseDown={(event) => event.preventDefault()} onClick={selection?.open ? addPendingSelection : openPanel} type="button">
              <Plus size={13} /> <span>{selection?.open ? "Add to chat" : "Ask Diffs"}</span>
            </button>
          )}
          {!selection?.open && (
            <button className="selection-trigger" onMouseDown={(event) => event.preventDefault()} onClick={() => openAnnotationComposer(triggerSelection)} type="button">
              <MessageSquarePlus size={13} /> <span>Annotate</span>
            </button>
          )}
        </div>
      )}

      {annotationDraft && (
        <form
          className="annotation-composer"
          onSubmit={saveAnnotation}
          style={{ left: annotationDraft.x, top: annotationDraft.y }}
        >
          <div
            className="annotation-composer-header"
            onPointerDown={startDragging}
            onPointerMove={movePanel}
            onPointerUp={stopDragging}
            onPointerCancel={stopDragging}
            title="Drag to move annotation composer"
          >
            <span><span>Annotation</span><GripHorizontal className="drag-hint" size={13} /></span>
          </div>
          <textarea
            aria-label="Annotation"
            onChange={(event) => setAnnotationDraft((current) => current ? { ...current, text: event.target.value } : current)}
            onKeyDown={(event) => {
              // Command-Enter saves the note without preventing ordinary multiline editing.
              if (event.key !== "Enter" || !event.metaKey || !annotationDraft.text.trim()) return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
            placeholder="Add a short annotation"
            ref={annotationInputRef}
            rows={3}
            value={annotationDraft.text}
          />
          <div className="annotation-composer-actions">
            <button onClick={() => setAnnotationDraft(null)} type="button">Cancel</button>
            <button disabled={!annotationDraft.text.trim()} type="submit">Add annotation</button>
          </div>
        </form>
      )}

      {selection?.open && (
        <aside
          ref={panelRef}
          className={`question-panel${isDraggingFiles ? " dragging-files" : ""}`}
          aria-label={selection.text ? "Ask about selected code" : "Ask Diffs"}
          onDragEnter={beginFileDrag}
          onDragLeave={endFileDrag}
          onDragOver={(event) => event.preventDefault()}
          onDrop={dropAttachments}
          style={{ "--chat-font-size": `${chatFontSize}px` } as CSSProperties}
        >
          <div
            className="question-panel-header"
            onPointerDown={startDragging}
            onPointerMove={movePanel}
            onPointerUp={stopDragging}
            onPointerCancel={stopDragging}
          >
            <span className="question-panel-title"><Sparkles size={14} /><span>Ask Diffs</span><GripHorizontal className="drag-hint" size={13} /></span>
            <button aria-label="Close" onClick={closePanel}><X size={15} /></button>
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
              <SelectedSnippet codeSelection={selection} onShow={showSelection} />
            </div>
          )}

          {(turns.length > 0 || queuedQuestions.length > 0 || loading) && (
            <div className="conversation" ref={conversationRef}>
              {turns.map((turn, index) => (
                <article className="chat-turn" key={`${turn.question}-${index}`}>
                  <PromptPreview question={turn.question} />
                  {turn.attachments?.length ? (
                    <span className="asked-attachments">{turn.attachments.join(", ")}</span>
                  ) : null}
                  <div className="chat-turn-divider" />
                  {turn.answer
                    ? <div className="chat-markdown"><GitHubMarkdown>{turn.answer}</GitHubMarkdown></div>
                    : (
                      <div aria-label="Loading response" className="chat-loading-wave" role="status">
                        <span />
                        <span />
                        <span />
                      </div>
                    )}
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
            <div aria-label="Chat text size" className="chat-zoom-controls">
              <button aria-label="Decrease chat text size" disabled={chatFontSize === MIN_CHAT_FONT_SIZE} onClick={() => adjustChatFontSize(-1)} type="button"><Minus size={12} /></button>
              <span aria-live="polite" className="chat-zoom-value">{chatZoomPercent}%</span>
              <button aria-label="Increase chat text size" disabled={chatFontSize === MAX_CHAT_FONT_SIZE} onClick={() => adjustChatFontSize(1)} type="button"><Plus size={12} /></button>
            </div>
            <div className="question-input">
              {!question && !isGeneratingSuggestion && suggestedQuestion && (
                <span className="question-suggestion" aria-hidden="true">
                  <span>{suggestedQuestion}</span>
                  <kbd><b>⇥</b> Tab</kbd>
                </span>
              )}
              <textarea
                ref={inputRef}
                value={question}
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
                rows={2}
              />
            </div>
            <input
              accept="image/*,application/pdf,text/*,.csv,.ts,.tsx,.js,.jsx,.json,.md,.py"
              className="attachment-picker"
              id="chat-attachment-picker"
              multiple
              onChange={selectAttachments}
              type="file"
            />
            <label aria-label="Attach files" className="attach-file" htmlFor="chat-attachment-picker">
              <Paperclip size={14} />
            </label>
            <button className="ask-submit" disabled={!question.trim()}>
              <span>Ask</span><CornerDownLeft size={13} />
            </button>
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
      )}
    </>
  );
}
