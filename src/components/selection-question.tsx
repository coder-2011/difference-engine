"use client";

import { CornerDownLeft, GripHorizontal, Paperclip, Plus, Sparkles, X } from "lucide-react";
import { ChangeEvent, DragEvent, FormEvent, PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { GitHubMarkdown } from "@/components/github-markdown";
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  MAX_CHAT_HISTORY_TURNS,
  type ChatTurn,
} from "@/types/chat";

const DEFAULT_QUESTION = "What does this code do?";

type Point = {
  x: number;
  y: number;
};

type CodeSelection = Point & {
  text: string;
};

type SelectionState = CodeSelection & {
  context: string[];
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

type ResizeState = Point & {
  height: number;
  maxHeight: number;
  maxWidth: number;
  minHeight: number;
  width: number;
};

type SelectionQuestionProps = {
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

/** Renders a readable prompt preview that expands only when it exceeds two lines. */
function PromptPreview({ question }: PromptPreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const promptRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const prompt = promptRef.current;
    if (!prompt || expanded) return;
    setTruncated(prompt.scrollHeight > prompt.clientHeight);
  }, [expanded, question]);

  return (
    <div className="asked-question-wrap">
      <span className={`asked-question${expanded ? " expanded" : ""}`} ref={promptRef}>{question}</span>
      {truncated && (
        <button className="asked-question-toggle" onClick={() => setExpanded((current) => !current)} type="button">
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** Detects code selections and presents a movable, multi-turn code conversation. */
export function SelectionQuestion({ source }: SelectionQuestionProps) {
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [suggestion, setSuggestion] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const momentumFrameRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const followsConversationRef = useRef(true);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    /** Captures a non-empty selection only when it originated inside the diff renderer. */
    function captureSelection(pointer?: Point): void {
      const browserSelection = window.getSelection();
      const text = browserSelection?.toString().trim() ?? "";
      const anchor = browserSelection?.anchorNode;
      const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement;
      const root = anchor?.getRootNode();
      // Diffs can render code in either ordinary DOM or an open shadow tree.
      const selectionElement = root instanceof ShadowRoot ? root.host : anchorElement;
      const insideDiff = selectionElement?.closest("[data-diff-selection-root]");

      if (!text || !insideDiff || !browserSelection?.rangeCount) {
        setSelection((current) => {
          if (!current?.open) return null;
          return current.pending ? { ...current, pending: undefined } : current;
        });
        return;
      }

      const rect = browserSelection.getRangeAt(0).getBoundingClientRect();
      const triggerAnchor = pointer ?? (rect.width || rect.height ? { x: rect.right, y: rect.top } : null);
      if (!triggerAnchor) return setSelection(null);

      const maxX = Math.max(window.innerWidth - 154, 8);
      const maxY = Math.max(window.innerHeight - 39, 8);
      const preferredY = triggerAnchor.y + 10 <= maxY ? triggerAnchor.y + 10 : triggerAnchor.y - 41;
      const x = Math.min(Math.max(triggerAnchor.x + 10, 8), maxX);
      const y = Math.min(Math.max(preferredY, 8), maxY);
      const nextSelection = { text, x, y };
      setSelection((current) => current?.open
        ? { ...current, pending: nextSelection }
        : { ...nextSelection, context: [text], open: false });
    }

    /** Uses the pointer release point after the browser finalizes its selection range. */
    function captureAfterMouseUp(event: MouseEvent): void {
      if (event.target instanceof Element && event.target.closest(".ai-chat-launch, .selection-trigger, .question-panel")) return;
      const pointer = { x: event.clientX, y: event.clientY };
      window.requestAnimationFrame(() => captureSelection(pointer));
    }

    /** Captures keyboard-created code selections while ignoring typing inside the chat. */
    function captureAfterKeyUp(event: KeyboardEvent): void {
      if (event.target instanceof Element && event.target.closest(".question-panel")) return;
      captureSelection();
    }

    document.addEventListener("keyup", captureAfterKeyUp, true);
    document.addEventListener("mouseup", captureAfterMouseUp, true);
    return () => {
      document.removeEventListener("keyup", captureAfterKeyUp, true);
      document.removeEventListener("mouseup", captureAfterMouseUp, true);
    };
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

    updateFollowState();
    scroller.addEventListener("scroll", updateFollowState, { passive: true });
    return () => scroller.removeEventListener("scroll", updateFollowState);
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
      return { ...current, context: [...current.context, current.pending.text], pending: undefined };
    });
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  /** Opens an empty repository chat without sending a question. */
  function openChat(): void {
    followsConversationRef.current = true;
    setSelection({ context: [], open: true, text: "", x: 0, y: 0 });
    window.setTimeout(() => inputRef.current?.focus(), 0);
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

  /** Resizes from the hidden corner handle without showing the browser's default corner glyph. */
  function startResizing(event: ReactPointerEvent<HTMLDivElement>): void {
    const panel = panelRef.current;
    if (!panel) return;

    const rect = panel.getBoundingClientRect();
    const anchoredRight = panel.style.right !== "auto";
    const anchoredBottom = panel.style.bottom !== "auto";
    window.cancelAnimationFrame(momentumFrameRef.current);
    resizeRef.current = {
      height: rect.height,
      maxHeight: anchoredBottom ? window.innerHeight - 16 : window.innerHeight - rect.top - 8,
      maxWidth: anchoredRight ? window.innerWidth - 16 : window.innerWidth - rect.left - 8,
      minHeight: Math.min(rect.height, 180),
      width: rect.width,
      x: event.clientX,
      y: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  /** Applies the current pointer distance to the panel's explicit width and height. */
  function resizePanel(event: ReactPointerEvent<HTMLDivElement>): void {
    const resize = resizeRef.current;
    const panel = panelRef.current;
    if (!resize || !panel) return;

    const width = Math.min(resize.maxWidth, Math.max(300, resize.width + event.clientX - resize.x));
    const height = Math.min(resize.maxHeight, Math.max(resize.minHeight, resize.height + event.clientY - resize.y));
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
  }

  /** Ends a corner resize and releases the pointer so other panel interactions resume normally. */
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
    const taskContext = selection.context.join("\n\n");

    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setSuggestion("");
    let pendingDelta = "";
    let frame = 0;
    let startedTurn = false;

    /** Commits streamed text at most once per paint instead of rerendering for every token. */
    function flushDelta(): void {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      if (!pendingDelta) return;
      const text = pendingDelta;
      pendingDelta = "";
      setTurns((current) => current.map((turn, index) => (
        index === current.length - 1 ? { ...turn, answer: turn.answer + text } : turn
      )));
    }

    /** Coalesces model deltas until the browser is ready to paint them. */
    function queueDelta(text: string): void {
      pendingDelta += text;
      if (!frame) frame = window.requestAnimationFrame(flushDelta);
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
          selection: taskContext,
          source,
        }),
      });
      if (!response.ok || !response.body) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "No answer was returned.");
      }

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        buffer += value ?? "";
        if (done) buffer += "\n";
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line) as { message?: string; text?: string; type?: string };
          if (event.type === "delta" && event.text) queueDelta(event.text);
          if (event.type === "suggestion" && event.text) setSuggestion(event.text);
          if (event.type === "error") throw new Error(event.message);
        }

        if (done) break;
      }
      flushDelta();
    } catch {
      flushDelta();
      if (!controller.signal.aborted && startedTurn) {
        setTurns((current) => current.map((turn, index) => (
          index === current.length - 1
            ? { ...turn, answer: turn.answer || "The question could not be answered. Please try again." }
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
    const placeholder = turns.length ? suggestion || "Where is this called from?" : DEFAULT_QUESTION;
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
  const suggestedQuestion = turns.length ? suggestion || "Where is this called from?" : DEFAULT_QUESTION;
  const isGeneratingSuggestion = Boolean(turns.length && loading && !suggestion);

  return (
    <>
      {!selection?.open && (
        <button aria-label="Open AI chat" className="ai-chat-launch" onClick={openChat} type="button">
          <Sparkles size={14} /> AI chat
        </button>
      )}

      {triggerSelection && (
        <button
          className="selection-trigger"
          style={{ left: triggerSelection.x, top: triggerSelection.y }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={addsToTask ? addSelectionToTask : openPanel}
        >
          <Plus size={13} /> {addsToTask ? "Add to task" : "Ask Diffs"}
        </button>
      )}

      {selection?.open && (
        <aside
          ref={panelRef}
          className={`question-panel${isDraggingFiles ? " dragging-files" : ""}`}
          aria-label={selection.context.length ? "Ask about selected code" : "AI chat"}
          onDragEnter={beginFileDrag}
          onDragLeave={endFileDrag}
          onDragOver={(event) => event.preventDefault()}
          onDrop={dropAttachments}
        >
          <div
            className="question-panel-header"
            onPointerDown={startDragging}
            onPointerMove={movePanel}
            onPointerUp={stopDragging}
            onPointerCancel={stopDragging}
          >
            <span><Sparkles size={14} /> {selection.context.length ? "Ask Diffs" : "AI chat"} <GripHorizontal className="drag-hint" size={13} /></span>
            <button aria-label="Close" onClick={closePanel}><X size={15} /></button>
          </div>

          {selection.context.length > 0 && (
            <div className="selected-snippet">
              {selection.context.map((snippet, index) => (
                <div className="selected-snippet-item" key={`${snippet}-${index}`}>{snippet}</div>
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
              {!question && (
                <span className={`question-suggestion${isGeneratingSuggestion ? " loading" : ""}`} aria-hidden="true">
                  <span>{isGeneratingSuggestion ? "Finding a useful next question…" : suggestedQuestion}</span>
                  {!isGeneratingSuggestion && <kbd><b>⇥</b> Tab</kbd>}
                </span>
              )}
              <textarea
                ref={inputRef}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Tab" && !question && !isGeneratingSuggestion) {
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
              multiple
              onChange={selectAttachments}
              ref={attachmentInputRef}
              type="file"
            />
            <button aria-label="Attach files" className="attach-file" onClick={() => attachmentInputRef.current?.click()} type="button">
              <Paperclip size={14} />
            </button>
            <button className="ask-submit" disabled={loading || !question.trim()}>
              {loading ? "Thinking…" : <><span>Ask</span><CornerDownLeft size={13} /></>}
            </button>
          </form>
          <div
            aria-hidden="true"
            className="question-panel-resize"
            onPointerCancel={stopResizing}
            onPointerDown={startResizing}
            onPointerMove={resizePanel}
            onPointerUp={stopResizing}
          />
        </aside>
      )}
    </>
  );
}
