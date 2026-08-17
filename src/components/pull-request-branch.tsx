"use client";

import type { FormEvent, KeyboardEvent } from "react";
import { Pencil } from "lucide-react";
import { useState } from "react";

type PullRequestBranchProps = {
  initialBranch: string;
  initialLabel: string;
  source: string[];
};

/** Renders a PR head branch that an authorized viewer can rename directly on GitHub. */
export function PullRequestBranch({ initialBranch, initialLabel, source }: PullRequestBranchProps) {
  const [branch, setBranch] = useState(initialBranch);
  const [draft, setDraft] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const prefix = initialLabel.endsWith(initialBranch) ? initialLabel.slice(0, -initialBranch.length) : "";

  /** Opens the inline editor with the current head branch name. */
  function beginEditing(): void {
    setDraft(branch);
    setError(undefined);
  }

  /** Leaves branch edit mode without changing the visible head branch. */
  function cancelEditing(): void {
    setDraft(undefined);
    setError(undefined);
  }

  /** Lets Escape cancel while Enter follows the form's normal submit path. */
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") cancelEditing();
  }

  /** Renames the current pull request head branch after GitHub accepts the new name. */
  async function saveBranch(): Promise<void> {
    const nextBranch = draft?.trim() ?? "";
    if (!nextBranch || pending) return;
    if (nextBranch === branch) {
      cancelEditing();
      return;
    }

    setPending(true);
    setError(undefined);

    try {
      const path = source.map(encodeURIComponent).join("/");
      const response = await fetch(`/api/pull-request/${path}`, {
        body: JSON.stringify({ action: "rename-branch", name: nextBranch }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      // SAFETY: The same-origin pull-request route returns this documented error envelope.
      const result = await response.json().catch(() => null) as { error?: string } | null;

      if (!response.ok) throw new Error(result?.error ?? "GitHub could not rename this branch");

      setBranch(nextBranch);
      setDraft(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "GitHub could not rename this branch");
    } finally {
      setPending(false);
    }
  }

  /** Saves the branch when the form submits through Enter or the Save button. */
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void saveBranch();
  }

  if (draft === undefined) {
    return (
      <button className="pr-branch-button" onClick={beginEditing} title="Rename branch" type="button">
        <span>{prefix}{branch}</span>
        <Pencil aria-hidden="true" size={11} />
      </button>
    );
  }

  return (
    <form className="pr-branch-editor" onSubmit={handleSubmit}>
      {prefix && <span>{prefix}</span>}
      <input
        aria-label="Pull request branch name"
        autoFocus
        disabled={pending}
        maxLength={255}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        value={draft}
      />
      <button disabled={!draft.trim() || draft.trim() === branch || pending} type="submit">Save</button>
      <button disabled={pending} onClick={cancelEditing} type="button">Cancel</button>
      {error && <span className="pr-branch-error" role="alert">{error}</span>}
    </form>
  );
}
