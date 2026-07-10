"use client";

import { CornerDownLeft, Sparkles, X } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";

type SelectionState = {
  text: string;
  x: number;
  y: number;
};

/** Detects code selections and presents a small question-and-answer popover. */
export function SelectionQuestion() {
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [askedQuestion, setAskedQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    /** Captures a non-empty selection only when it originated inside the diff renderer. */
    function captureSelection(): void {
      if (panelOpen) return;

      const browserSelection = window.getSelection();
      const text = browserSelection?.toString().trim() ?? "";
      const root = browserSelection?.anchorNode?.getRootNode();
      const shadowHost = root instanceof ShadowRoot ? root.host : null;
      const insideDiff = shadowHost?.closest("[data-diff-selection-root]");

      if (!text || !insideDiff || !browserSelection?.rangeCount) {
        setSelection(null);
        return;
      }

      const rect = browserSelection.getRangeAt(0).getBoundingClientRect();
      const x = Math.min(rect.right, window.innerWidth - 150);
      const y = Math.max(rect.top - 42, 12);
      setSelection({ text, x, y });
    }

    /** Defers mouse-up capture until the browser has finalized its selection range. */
    function captureAfterMouseUp(): void {
      window.requestAnimationFrame(captureSelection);
    }

    document.addEventListener("selectionchange", captureSelection);
    document.addEventListener("mouseup", captureAfterMouseUp);
    return () => {
      document.removeEventListener("selectionchange", captureSelection);
      document.removeEventListener("mouseup", captureAfterMouseUp);
    };
  }, [panelOpen]);

  /** Opens the question panel while preserving the selected code text. */
  function openPanel(): void {
    setPanelOpen(true);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  /** Closes the answer panel and clears the captured selection. */
  function closePanel(): void {
    setPanelOpen(false);
    setSelection(null);
  }

  /** Sends the selected code and user's question to the server-side model endpoint. */
  async function askQuestion(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!selection?.text || !question.trim()) return;

    setLoading(true);
    setAnswer("");
    setAskedQuestion(question.trim());

    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question.trim(), selection: selection.text }),
      });
      const body = (await response.json()) as { answer?: string; error?: string };
      setAnswer(body.answer ?? body.error ?? "No answer was returned.");
    } catch {
      setAnswer("The question could not be answered. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {selection && !panelOpen && (
        <button className="selection-trigger" style={{ left: selection.x, top: selection.y }} onMouseDown={(event) => event.preventDefault()} onClick={openPanel}>
          <Sparkles size={13} /> Ask about this
        </button>
      )}

      {panelOpen && selection && (
        <aside className="question-panel" aria-label="Ask about selected code">
          <div className="question-panel-header">
            <span><Sparkles size={14} /> Ask Diffs</span>
            <button aria-label="Close" onClick={closePanel}><X size={15} /></button>
          </div>
          <div className="selected-snippet">{selection.text}</div>
          <form onSubmit={askQuestion}>
            <textarea
              ref={inputRef}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="What does this code do?"
              rows={2}
            />
            <button disabled={loading || !question.trim()}>{loading ? "Thinking…" : <><span>Ask</span><CornerDownLeft size={13} /></>}</button>
          </form>
          {(askedQuestion || loading) && (
            <div className="answer-block">
              <span className="asked-question">{askedQuestion}</span>
              <p>{loading ? "Reading the selected code…" : answer}</p>
            </div>
          )}
        </aside>
      )}
    </>
  );
}
