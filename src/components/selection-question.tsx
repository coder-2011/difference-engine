"use client";

import { CornerDownLeft, GripHorizontal, Sparkles, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { FormEvent, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

const DEFAULT_QUESTION = "What does this code do?";

type ChatTurn = {
  answer: string;
  question: string;
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
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [pendingQuestion, setPendingQuestion] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const loading = Boolean(pendingQuestion);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<(Point & { left: number; top: number }) | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let pointer: Point | null = null;

    /** Captures a non-empty selection only when it originated inside the diff renderer. */
    function captureSelection(): void {
      if (selection?.open) return;

      const browserSelection = window.getSelection();
      const text = browserSelection?.toString().trim() ?? "";
      const anchor = browserSelection?.anchorNode;
      const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement;
      const root = anchor?.getRootNode();
      const selectionPointer = pointer;
      pointer = null;
      // Diffs can render code in either ordinary DOM or an open shadow tree.
      const selectionElement = root instanceof ShadowRoot ? root.host : anchorElement;
      const insideDiff = selectionElement?.closest("[data-diff-selection-root]");

      if (!text || !insideDiff || !browserSelection?.rangeCount) {
        setSelection(null);
        return;
      }

      const rect = browserSelection.getRangeAt(0).getBoundingClientRect();
      const anchorX = selectionPointer?.x ?? rect.right;
      const anchorY = selectionPointer?.y ?? rect.top;
      const x = Math.min(Math.max(anchorX + 10, 8), window.innerWidth - 154);
      const y = Math.min(Math.max(selectionPointer ? anchorY + 10 : anchorY - 39, 8), window.innerHeight - 39);
      setSelection({ open: false, text, x, y });
    }

    /** Uses the pointer release point after the browser finalizes its selection range. */
    function captureAfterMouseUp(event: MouseEvent): void {
      if (event.target instanceof Element && event.target.closest(".selection-trigger, .question-panel")) return;
      pointer = { x: event.clientX, y: event.clientY };
      window.requestAnimationFrame(captureSelection);
    }

    document.addEventListener("selectionchange", captureSelection);
    document.addEventListener("mouseup", captureAfterMouseUp);
    return () => {
      document.removeEventListener("selectionchange", captureSelection);
      document.removeEventListener("mouseup", captureAfterMouseUp);
    };
  }, [selection?.open]);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
  }, [loading, turns]);

  /** Opens a fresh conversation while preserving the selected code. */
  function openPanel(): void {
    setSelection((current) => current && { ...current, open: true });
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  /** Closes the panel and clears conversation state tied to the old selection. */
  function closePanel(): void {
    // Aborting prevents a completed request from leaking into the next code selection.
    requestRef.current?.abort();
    requestRef.current = null;
    setSelection(null);
    setQuestion("");
    setTurns([]);
    setPendingQuestion("");
    setSuggestions([]);
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
    setSuggestions([]);

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
      const body = (await response.json()) as { answer?: string; error?: string; followups?: string[] };
      if (controller.signal.aborted) return;
      const answer = body.answer ?? body.error ?? "No answer was returned.";
      setTurns((current) => [...current, { answer, question: submittedQuestion }]);
      setSuggestions(body.followups ?? []);
    } catch {
      if (!controller.signal.aborted) {
        setTurns((current) => [...current, {
          answer: "The question could not be answered. Please try again.",
          question: submittedQuestion,
        }]);
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

  /** Fills the example question and leaves the cursor ready to edit it. */
  function fillDefaultQuestion(): void {
    setQuestion(DEFAULT_QUESTION);
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(DEFAULT_QUESTION.length, DEFAULT_QUESTION.length);
    }, 0);
  }

  return (
    <>
      {selection && !selection.open && (
        <button
          className="selection-trigger"
          style={{ left: selection.x, top: selection.y }}
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
                  <div className="chat-markdown"><ReactMarkdown skipHtml>{turn.answer}</ReactMarkdown></div>
                </article>
              ))}
              {loading && (
                <article className="chat-turn pending-turn">
                  <span className="asked-question">{pendingQuestion}</span>
                  <p>Reading the codebase…</p>
                </article>
              )}
            </div>
          )}

          {!loading && suggestions.length > 0 && (
            <div className="followup-suggestions">
              <span>Ask next</span>
              {suggestions.map((suggestion) => (
                <button aria-label={suggestion} key={suggestion} type="button" onClick={() => void submitQuestion(suggestion)}>{suggestion}</button>
              ))}
            </div>
          )}

          <form onSubmit={askQuestion}>
            {!question && (
              <button className="prompt-shortcut" type="button" onClick={fillDefaultQuestion}>
                <kbd>Tab</kbd> {DEFAULT_QUESTION}
              </button>
            )}
            <textarea
              ref={inputRef}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Tab" && !question.trim()) {
                  event.preventDefault();
                  fillDefaultQuestion();
                } else if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={turns.length ? "Ask a follow-up…" : "Ask about the selected code…"}
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
