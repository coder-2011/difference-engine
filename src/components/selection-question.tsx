"use client";

import { CornerDownLeft, GripHorizontal, Sparkles, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { FormEvent, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

const DEFAULT_QUESTION = "What does this code do?";

type ChatTurn = {
  answer: string;
  question: string;
  selection: string;
};

type Point = {
  x: number;
  y: number;
};

type SelectionState = Point & {
  open: boolean;
  text: string;
};

type SelectionQuestionProps = {
  source: string[];
};

/** Detects code selections and presents a movable, multi-turn code conversation. */
export function SelectionQuestion({ source }: SelectionQuestionProps) {
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [pendingSelection, setPendingSelection] = useState<SelectionState | null>(null);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [pendingQuestion, setPendingQuestion] = useState("");
  const [suggestion, setSuggestion] = useState("");
  const loading = Boolean(pendingQuestion);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<(Point & { left: number; top: number }) | null>(null);
  const requestRef = useRef<AbortController | null>(null);

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
        if (selection?.open) setPendingSelection(null);
        else setSelection(null);
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
      const nextSelection = { open: false, text, x, y };
      if (selection?.open) setPendingSelection(nextSelection);
      else setSelection(nextSelection);
    }

    /** Uses the pointer release point after the browser finalizes its selection range. */
    function captureAfterMouseUp(event: MouseEvent): void {
      if (event.target instanceof Element && event.target.closest(".selection-trigger, .question-panel")) return;
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
  }, [selection?.open]);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
  }, [loading, turns]);

  /** Opens the chat with the newest selection without clearing prior turns. */
  function openPanel(): void {
    setSelection((current) => {
      const nextSelection = pendingSelection ?? current;
      return nextSelection && { ...nextSelection, open: true };
    });
    setPendingSelection(null);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  /** Closes the panel and clears conversation state tied to the old selection. */
  function closePanel(): void {
    // Aborting prevents a completed request from leaking into the next code selection.
    requestRef.current?.abort();
    requestRef.current = null;
    setSelection(null);
    setPendingSelection(null);
    setQuestion("");
    setTurns([]);
    setPendingQuestion("");
    setSuggestion("");
  }

  /** Starts moving the panel from its current rendered position. */
  function startDragging(event: ReactPointerEvent<HTMLDivElement>): void {
    if ((event.target as Element).closest("button")) return;
    const panel = panelRef.current;
    if (!panel) return;

    const rect = panel.getBoundingClientRect();
    dragRef.current = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
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

    const x = Math.min(Math.max(drag.left + event.clientX - drag.x, 8), window.innerWidth - panel.offsetWidth - 8);
    const y = Math.min(Math.max(drag.top + event.clientY - drag.y, 8), window.innerHeight - panel.offsetHeight - 8);
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  }

  /** Ends panel movement and releases pointer capture. */
  function stopDragging(event: ReactPointerEvent<HTMLDivElement>): void {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  /** Sends one question plus prior turns to the repository-aware model endpoint. */
  async function submitQuestion(value: string): Promise<void> {
    const submittedQuestion = value.trim();
    if (!selection?.text || !submittedQuestion || requestRef.current) return;

    const controller = new AbortController();
    requestRef.current = controller;
    setPendingQuestion(submittedQuestion);
    setQuestion("");
    setSuggestion("");
    setTurns((current) => [...current, { answer: "", question: submittedQuestion, selection: selection.text }]);
    let pendingDelta = "";
    let frame = 0;

    /** Commits streamed text at most once per paint instead of rerendering for every token. */
    function flushDelta(): void {
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
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          history: turns,
          question: submittedQuestion,
          selection: selection.text,
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
      if (frame) window.cancelAnimationFrame(frame);
      flushDelta();
    } catch {
      if (frame) window.cancelAnimationFrame(frame);
      flushDelta();
      if (!controller.signal.aborted) {
        setTurns((current) => current.map((turn, index) => (
          index === current.length - 1
            ? { ...turn, answer: turn.answer || "The question could not be answered. Please try again." }
            : turn
        )));
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setPendingQuestion("");
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

  const triggerSelection = selection?.open ? pendingSelection : selection;
  const placeholder = turns.length ? suggestion : DEFAULT_QUESTION;

  return (
    <>
      {triggerSelection && (
        <button
          className="selection-trigger"
          style={{ left: triggerSelection.x, top: triggerSelection.y }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={openPanel}
        >
          <Sparkles size={13} /> Ask about this
        </button>
      )}

      {selection?.open && (
        <aside
          ref={panelRef}
          className="question-panel"
          aria-label="Ask about selected code"
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

          <div className="selected-snippet">{selection.text}</div>

          {(turns.length > 0 || loading) && (
            <div className="conversation" ref={conversationRef}>
              {turns.map((turn, index) => (
                <article className="chat-turn" key={`${turn.question}-${index}`}>
                  <span className="asked-question">{turn.question}</span>
                  {turn.answer
                    ? <div className="chat-markdown"><ReactMarkdown skipHtml>{turn.answer}</ReactMarkdown></div>
                    : <p>Reading the codebase…</p>}
                </article>
              ))}
            </div>
          )}

          <form onSubmit={askQuestion}>
            <textarea
              ref={inputRef}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Tab" && !question.trim()) {
                  event.preventDefault();
                  fillPlaceholder();
                } else if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={placeholder}
              rows={2}
            />
            <button className="ask-submit" disabled={loading || !question.trim()}>
              {loading ? "Thinking…" : <><span>Ask</span><CornerDownLeft size={13} /></>}
            </button>
          </form>
        </aside>
      )}
    </>
  );
}
