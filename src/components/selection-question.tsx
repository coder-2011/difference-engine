"use client";

import { getFiletypeFromFileName, getSharedHighlighter } from "@pierre/diffs";
import { ClipboardCopy, CornerDownLeft, GripHorizontal, MessageSquarePlus, Paperclip, Plus, Sparkles, X } from "lucide-react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { ChangeEvent, DragEvent, FormEvent, Fragment, PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
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

type CodeSelectionLocation = {
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

type AnnotationDraft = Point & {
  selection: CodeSelection;
  text: string;
};

type SelectionState = CodeSelection & {
  context: CodeSelection[];
  open: boolean;
  pending?: CodeSelection;
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

type SelectionQuestionProps = {
  onRevealSelection: (location: CodeSelectionLocation) => void;
  source: string[];
};

type UploadedAttachment = {
  data: string;
  name: string;
  type: string;
};

type PromptPreviewProps = {
  question: string;
};

type SelectedSnippetProps = {
  codeSelection: CodeSelection;
  onShow: (selection: CodeSelection) => void;
};

type SnippetToken = {
  color?: string;
  content: string;
};

/** Formats source-anchored annotations as Markdown ready to paste into a review. */
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
    return `- ${reference}${text}`;
  }).join("\n");
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
  const endLine = endElement?.closest("[data-line]");
  const id = root instanceof ShadowRoot ? root.querySelector("[data-title]")?.textContent?.trim() : "";
  // A missing data-line attribute must not coerce to line zero.
  const lineAttribute = line?.getAttribute("data-line");
  if (!id || typeof lineAttribute !== "string") return undefined;

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

/** Lazily applies Pierre's syntax colors while a saved selection is hovered or focused. */
function SelectedSnippet({ codeSelection, onShow }: SelectedSnippetProps) {
  const [active, setActive] = useState(false);
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

  /** Returns to plain text after hover unless the click left this button focused. */
  function stopHighlighting(event: ReactMouseEvent<HTMLButtonElement>): void {
    if (document.activeElement !== event.currentTarget) setActive(false);
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
    </button>
  );
}

/** Detects code selections and presents a movable, multi-turn code conversation. */
export function SelectionQuestion({ onRevealSelection, source }: SelectionQuestionProps) {
  const sourceKey = source.join("/");
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [suggestion, setSuggestion] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [openAIError, setOpenAIError] = useState("");
  const [chatFontSize, setChatFontSize] = useState(DEFAULT_CHAT_FONT_SIZE);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationDraft, setAnnotationDraft] = useState<AnnotationDraft | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const annotationInputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const momentumFrameRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const followsConversationRef = useRef(true);
  const dragDepthRef = useRef(0);
  const annotationCounterRef = useRef(0);

  useEffect(() => {
    // Notes and active requests belong to the current repository view and cannot be reused against a new source.
    requestRef.current?.abort();
    requestRef.current = null;
    setLoading(false);
    setSelection(null);
    setQuestion("");
    setTurns([]);
    setSuggestion("");
    setAttachments([]);
    setAttachmentError("");
    setAnnotations([]);
    setAnnotationDraft(null);
    setCopyStatus("");
  }, [sourceKey]);

  useEffect(() => {
    /** Captures a non-empty selection only when it originated inside the diff renderer. */
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
        setSelection((current) => {
          if (!current?.open) return null;
          return current.pending ? { ...current, pending: undefined } : current;
        });
        return;
      }

      const rect = range.getBoundingClientRect();
      const triggerAnchor = pointer ?? (rect.width || rect.height ? { x: rect.right, y: rect.top } : null);
      if (!triggerAnchor) return setSelection(null);

      const maxX = Math.max(window.innerWidth - 238, 8);
      const maxY = Math.max(window.innerHeight - 39, 8);
      const preferredY = triggerAnchor.y + 10 <= maxY ? triggerAnchor.y + 10 : triggerAnchor.y - 41;
      const x = Math.min(Math.max(triggerAnchor.x + 10, 8), maxX);
      const y = Math.min(Math.max(preferredY, 8), maxY);
      const nextSelection = { location: selectionLocation(range), range, text, x, y };
      setSelection((current) => current?.open
        ? { ...current, pending: nextSelection }
        : { ...nextSelection, context: [nextSelection], open: false });
    }

    /** Uses the pointer release point after the browser finalizes its selection range. */
    function captureAfterMouseUp(event: MouseEvent): void {
      if (event.target instanceof Element && event.target.closest(".ai-chat-actions, .selection-actions, .annotation-composer, .question-panel")) return;
      const pointer = { x: event.clientX, y: event.clientY };
      const origin = event.composedPath()[0];
      window.requestAnimationFrame(() => captureSelection(pointer, origin));
    }

    /** Captures keyboard-created code selections while ignoring typing inside the chat or annotation composer. */
    function captureAfterKeyUp(event: KeyboardEvent): void {
      if (event.target instanceof Element && event.target.closest(".annotation-composer, .question-panel")) return;
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
  }, [Boolean(turns.length || loading)]);

  /** Opens a draft question for the first selected code block without sending it. */
  function openPanel(): void {
    followsConversationRef.current = true;
    setSelection((current) => current && { ...current, open: true });
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  /** Adds the newest highlighted block to the active task without sending it. */
  function addSelectionToTask(): void {
    setSelection((current) => {
      if (!current?.open || !current.pending) return current;
      return { ...current, context: [...current.context, current.pending], pending: undefined };
    });
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  /** Opens an empty repository chat without sending a question. */
  function openChat(): void {
    followsConversationRef.current = true;
    setSelection({ context: [], open: true, text: "", x: 0, y: 0 });
    window.setTimeout(() => inputRef.current?.focus(), 0);
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
    setAnnotations((current) => [...current, {
      id: `annotation-${annotationCounterRef.current}`,
      selection: codeSelection,
      text,
    }]);
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
    setAnnotations((current) => current.filter((annotation) => annotation.id !== annotationId));
  }

  /** Copies every source reference and annotation in one Markdown-ready clipboard payload. */
  async function copyAnnotations(): Promise<void> {
    if (!annotations.length) return;

    try {
      await navigator.clipboard.writeText(formattedAnnotations(annotations));
      setCopyStatus("Copied");
      window.setTimeout(() => setCopyStatus(""), 2_000);
    } catch {
      setCopyStatus("Copy failed");
    }
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

  /** Closes the panel and clears conversation state tied to the old selection. */
  function closePanel(): void {
    // Aborting prevents a completed request from leaking into the next code selection.
    requestRef.current?.abort();
    requestRef.current = null;
    window.cancelAnimationFrame(momentumFrameRef.current);
    followsConversationRef.current = true;
    setSelection(null);
    setQuestion("");
    setTurns([]);
    setLoading(false);
    setSuggestion("");
    setAttachments([]);
    setAttachmentError("");
  }

  /** Places the panel inside the viewport and returns its clamped coordinates. */
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
  function continueMomentum(velocityX: number, velocityY: number): void {
    const panel = panelRef.current;
    if (!panel || Math.hypot(velocityX, velocityY) < 0.12) return;

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
    const panel = panelRef.current;
    if (!panel) return;

    const rect = panel.getBoundingClientRect();
    window.cancelAnimationFrame(momentumFrameRef.current);
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
    const panel = panelRef.current;
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
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag && event.type !== "pointercancel") continueMomentum(drag.velocityX, drag.velocityY);
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

  /** Sends one question plus prior turns and any new attachments to the repository-aware model endpoint. */
  async function submitQuestion(value: string): Promise<void> {
    const submittedQuestion = value.trim();
    if (!selection || !submittedQuestion || requestRef.current) return;
    const taskContext = selection.context.map((codeSelection) => codeSelection.text).join("\n\n");
    // An automatic note needs one unambiguous source range; multi-selection tasks remain manually annotatable.
    const annotationSelection = selection.context.length === 1 ? selection.context[0] : undefined;

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
      const uploadedAttachments = await Promise.all(attachments.map(encodeAttachment));
      // Closing the panel can abort while FileReader is still resolving an attachment.
      if (controller.signal.aborted) return;
      const attachmentNames = uploadedAttachments.map((attachment) => attachment.name);
      setQuestion("");
      setAttachments([]);
      setAttachmentError("");
      setTurns((current) => [...current, {
        answer: "",
        attachments: attachmentNames,
        question: submittedQuestion,
        selection: taskContext,
      }]);
      startedTurn = true;
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          attachments: uploadedAttachments,
          history: turns.slice(-MAX_CHAT_HISTORY_TURNS),
          question: submittedQuestion,
          annotationSelection: annotationSelection?.text,
          selection: taskContext,
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
          const event = JSON.parse(line) as { message?: string; text?: string; type?: string };
          if (event.type === "delta" && event.text) queueDelta(event.text);
          if (event.type === "suggestion" && event.text) streamedSuggestion = event.text;
          if (event.type === "annotation" && event.text && annotationSelection) addAnnotation(annotationSelection, event.text);
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

  /** Submits the current textarea value without a page navigation. */
  function askQuestion(event: FormEvent): void {
    event.preventDefault();
    void submitQuestion(question);
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

  const triggerSelection = selection?.open ? selection.pending : selection;
  const addsToTask = Boolean(selection?.open && selection.pending);
  const suggestedQuestion = turns.length ? suggestion : DEFAULT_QUESTION;
  const isGeneratingSuggestion = Boolean(turns.length && loading && !suggestion);

  return (
    <>
      {!selection?.open && (
        <div className="ai-chat-actions">
          <button aria-label="Open Ask Diffs" className="ai-chat-launch" onClick={openChat} type="button">
            <Sparkles size={14} /> Ask Diffs
          </button>
          <button className="copy-annotations" disabled={!annotations.length} onClick={() => void copyAnnotations()} type="button">
            <ClipboardCopy size={14} /> Copy Annotations
          </button>
          {copyStatus && <span aria-live="polite" className="annotation-copy-status">{copyStatus}</span>}
        </div>
      )}

      {triggerSelection && !annotationDraft && (
        <div className="selection-actions" style={{ left: triggerSelection.x, top: triggerSelection.y }}>
          <button className="selection-trigger" onMouseDown={(event) => event.preventDefault()} onClick={addsToTask ? addSelectionToTask : openPanel} type="button">
            <Plus size={13} /> {addsToTask ? "Add to task" : "Ask Diffs"}
          </button>
          <button className="selection-trigger" onMouseDown={(event) => event.preventDefault()} onClick={() => openAnnotationComposer(triggerSelection)} type="button">
            <MessageSquarePlus size={13} /> Annotate
          </button>
        </div>
      )}

      {annotationDraft && (
        <form
          className="annotation-composer"
          onSubmit={saveAnnotation}
          style={{ left: annotationDraft.x, top: annotationDraft.y }}
        >
          <textarea
            aria-label="Annotation"
            onChange={(event) => setAnnotationDraft((current) => current ? { ...current, text: event.target.value } : current)}
            placeholder="Add a short annotation"
            ref={annotationInputRef}
            rows={3}
            value={annotationDraft.text}
          />
          <div>
            <button onClick={() => setAnnotationDraft(null)} type="button">Cancel</button>
            <button disabled={!annotationDraft.text.trim()} type="submit">Add annotation</button>
          </div>
        </form>
      )}

      {selection?.open && (
        <aside
          ref={panelRef}
          className={`question-panel${isDraggingFiles ? " dragging-files" : ""}`}
          aria-label={selection.context.length ? "Ask about selected code" : "Ask Diffs"}
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
            <span><Sparkles size={14} /> Ask Diffs <GripHorizontal className="drag-hint" size={13} /></span>
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

          {selection.context.length > 0 && (
            <div className="selected-snippet">
              {selection.context.map((codeSelection, index) => (
                <SelectedSnippet
                  codeSelection={codeSelection}
                  key={`${codeSelection.text}-${index}`}
                  onShow={showSelection}
                />
              ))}
            </div>
          )}

          {annotations.length > 0 && (
            <div className="annotation-list">
              <div className="annotation-list-title">Annotations <span>{annotations.length}</span></div>
              {annotations.map((annotation) => (
                <div className="annotation-item" key={annotation.id}>
                  <button onClick={() => showSelection(annotation.selection)} type="button">
                    {annotation.text}
                  </button>
                  <button aria-label="Remove annotation" onClick={() => removeAnnotation(annotation.id)} type="button"><X size={12} /></button>
                </div>
              ))}
            </div>
          )}

          {(turns.length > 0 || loading) && (
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
            <button className="ask-submit" disabled={loading || !question.trim()}>
              {loading ? "Thinking…" : <><span>Ask</span><CornerDownLeft size={13} /></>}
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
