"use client";

import type { FocusEvent, FormEvent, KeyboardEvent } from "react";
import { Pencil } from "lucide-react";
import { useState } from "react";

type PullRequestTitleProps = {
  initialTitle: string;
  source: string[];
};

/** Renders a PR title that authorized viewers can rename directly on GitHub. */
export function PullRequestTitle({ initialTitle, source }: PullRequestTitleProps) {
  const [title, setTitle] = useState(initialTitle);
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

  /** Selects the complete title so typing immediately replaces it. */
  function selectTitle(event: FocusEvent<HTMLInputElement>): void {
    event.currentTarget.select();
  }

  /** Lets Escape cancel while Enter follows the form's normal submit path. */
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") cancelEditing();
  }

  /** Persists one non-empty title and exits edit mode after GitHub confirms it. */
  async function submitTitle(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextTitle = draft?.trim() ?? "";
    if (!nextTitle || nextTitle === title || pending) return;

    setPending(true);
    setError(undefined);

    try {
      const path = source.map(encodeURIComponent).join("/");
      const response = await fetch(`/api/pull-request/${path}`, {
        body: JSON.stringify({ action: "edit-title", title: nextTitle }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;

      if (!response.ok) throw new Error(result?.error ?? "GitHub could not rename this pull request");

      setTitle(nextTitle);
      document.title = `${nextTitle} · Diffs`;
      setDraft(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "GitHub could not rename this pull request");
    } finally {
      setPending(false);
    }
  }

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
    <form className="pr-title-editor" onSubmit={submitTitle}>
      <input
        aria-label="Pull request title"
        autoFocus
        disabled={pending}
        maxLength={256}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={selectTitle}
        onKeyDown={handleKeyDown}
        value={draft}
      />
      <button className="save" disabled={!draft.trim() || draft.trim() === title || pending} type="submit">Save</button>
      <button disabled={pending} onClick={cancelEditing} type="button">Cancel</button>
      {error && <span className="pr-title-error" role="alert">{error}</span>}
    </form>
  );
}
