"use client";

import type { FocusEvent, FormEvent, KeyboardEvent } from "react";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { usePullRequestLive } from "@/components/pull-request-live";
import type { PullRequestWorkspace } from "@/types/github";

type PullRequestTitleProps = {
  initialTitle: string;
  editable?: boolean;
  source: string[];
};

/** Renders a PR title that authorized viewers can rename directly on GitHub. */
export function PullRequestTitle({ editable = true, initialTitle, source }: PullRequestTitleProps) {
  const live = usePullRequestLive();
  const [savedTitle, setTitle] = useState(initialTitle);
  const title = live?.workspace?.details?.title ?? savedTitle;
  const [draft, setDraft] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  /** Opens the inline editor with the current GitHub title. */
  function beginEditing(): void {
    setDraft(title);
    setError(undefined);
  }

  /** Leaves edit mode without changing the visible title. */
  function cancelEditing(): void {
    setDraft(undefined);
    setError(undefined);
  }

  /** Lets Escape cancel while Enter follows the form's normal submit path. */
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") cancelEditing();
  }

  /** Persists one non-empty title and exits edit mode after GitHub confirms it. */
  async function saveTitle(): Promise<void> {
    const nextTitle = draft?.trim() ?? "";
    if (!nextTitle || pending) return;
    if (nextTitle === title) {
      cancelEditing();
      return;
    }

    setPending(true);
    setError(undefined);

    try {
      const path = source.map(encodeURIComponent).join("/");
      const response = await fetch(`/api/pull-request/${path}`, {
        body: JSON.stringify({ action: "edit-title", title: nextTitle }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      // SAFETY: The same-origin pull-request route returns this documented error envelope.
      const result = await response.json().catch(() => null) as { error?: string; workspace?: PullRequestWorkspace } | null;

      if (!response.ok) throw new Error(result?.error ?? "GitHub could not rename this pull request");

      setTitle(nextTitle);
      if (result?.workspace) live?.publish(result.workspace);
      document.title = `${nextTitle} · Diffs`;
      setDraft(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "GitHub could not rename this pull request");
    } finally {
      setPending(false);
    }
  }

  /** Saves the title when the form submits through Enter or the Save button. */
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void saveTitle();
  }

  /** Saves a valid draft only after focus leaves the complete inline editor. */
  function handleBlur(event: FocusEvent<HTMLFormElement>): void {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    void saveTitle();
  }

  if (!editable) return <h1>{title}</h1>;
  if (draft === undefined) {
    return (
      <h1>
        <button className="pr-title-button" onClick={beginEditing} title="Rename pull request" type="button">
          <span>{title}</span>
          <Pencil aria-hidden="true" size={15} />
        </button>
      </h1>
    );
  }

  return (
    <form className="pr-title-editor" onBlur={handleBlur} onSubmit={handleSubmit}>
      <input
        aria-label="Pull request title"
        autoFocus
        disabled={pending}
        maxLength={256}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        value={draft}
      />
      <button className="save" disabled={!draft.trim() || draft.trim() === title || pending} type="submit">Save</button>
      <button disabled={pending} onClick={cancelEditing} type="button">Cancel</button>
      {error && <span className="pr-title-error" role="alert">{error}</span>}
    </form>
  );
}
