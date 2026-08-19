"use client";

import type { CSSProperties, FormEvent, KeyboardEvent } from "react";
import Image from "next/image";
import { Check, CheckCircle2, ChevronDown, CircleX, GitCommitHorizontal, GitPullRequest, GitPullRequestClosed, Pencil, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GitHubMarkdown } from "@/components/github-markdown";
import { PullRequestReviewThread } from "@/components/pull-request-review-thread";
import type { PullRequestAction, PullRequestMergeMethod, PullRequestWorkspace } from "@/types/github";

type PullRequestWorkspaceProps = {
  description?: string;
  source: string[];
  workspace: PullRequestWorkspace;
};

type Particle = {
  color: string;
  delay: string;
  drift: string;
  duration: string;
  left: string;
  size: number;
};

type ParticleStyle = CSSProperties & Record<"--pr-particle-drift", string>;

type ActionMessage = {
  error: boolean;
  text: string;
};

const ACTION_MESSAGES = {
  close: "Pull request closed on GitHub.",
  comment: "Comment posted to GitHub.",
  "edit-body": "Pull request body updated on GitHub.",
  "edit-title": "Pull request title updated on GitHub.",
  merge: "Pull request merged on GitHub.",
  reply: "Reply posted to GitHub.",
  review: "Review submitted to GitHub.",
  "resolve-thread": "Review thread resolved on GitHub.",
  "unresolve-thread": "Review thread reopened on GitHub.",
} satisfies Partial<Record<PullRequestAction["action"], string>>;
const MERGE_METHOD_LABELS = {
  merge: "Merge commit",
  rebase: "Rebase and merge",
  squash: "Squash and merge",
} satisfies Record<PullRequestMergeMethod, string>;
const PR_STATES_BLOCK = /<!-- pr-states:start -->[\s\S]*?<!-- pr-states:end -->/;
const CELEBRATION_PARTICLES: readonly Particle[] = [
  { color: "#4ade80", delay: "0ms", drift: "-30px", duration: "2680ms", left: "4%", size: 9 },
  { color: "#79aeb0", delay: "120ms", drift: "24px", duration: "2820ms", left: "9%", size: 10 },
  { color: "#a78bfa", delay: "260ms", drift: "-22px", duration: "2920ms", left: "14%", size: 9 },
  { color: "#d8b84f", delay: "80ms", drift: "28px", duration: "2740ms", left: "20%", size: 11 },
  { color: "#79aeb0", delay: "210ms", drift: "-26px", duration: "3000ms", left: "27%", size: 10 },
  { color: "#4ade80", delay: "50ms", drift: "20px", duration: "2700ms", left: "33%", size: 9 },
  { color: "#a78bfa", delay: "300ms", drift: "-24px", duration: "3060ms", left: "39%", size: 11 },
  { color: "#d8b84f", delay: "160ms", drift: "30px", duration: "2860ms", left: "45%", size: 10 },
  { color: "#4ade80", delay: "20ms", drift: "-20px", duration: "2760ms", left: "51%", size: 9 },
  { color: "#79aeb0", delay: "240ms", drift: "26px", duration: "3020ms", left: "57%", size: 11 },
  { color: "#d8b84f", delay: "100ms", drift: "-28px", duration: "2840ms", left: "63%", size: 10 },
  { color: "#a78bfa", delay: "340ms", drift: "22px", duration: "3100ms", left: "69%", size: 11 },
  { color: "#4ade80", delay: "70ms", drift: "-24px", duration: "2780ms", left: "75%", size: 9 },
  { color: "#79aeb0", delay: "280ms", drift: "18px", duration: "2980ms", left: "81%", size: 10 },
  { color: "#a78bfa", delay: "140ms", drift: "-18px", duration: "2880ms", left: "86%", size: 9 },
  { color: "#d8b84f", delay: "320ms", drift: "32px", duration: "3040ms", left: "90%", size: 11 },
  { color: "#79aeb0", delay: "190ms", drift: "-30px", duration: "2940ms", left: "94%", size: 10 },
  { color: "#4ade80", delay: "30ms", drift: "16px", duration: "2720ms", left: "97%", size: 9 },
];

/** Formats a GitHub timestamp as a compact elapsed time for conversation rows. */
export function commentDate(value: string): string {
  const minutes = Math.floor(Math.max(0, Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Keeps multiline commit bodies readable in the compact PR conversation timeline. */
function commitSummary(message: string): string {
  return message.split("\n", 1)[0] ?? "Untitled commit";
}

/** Selects the first GitHub-enabled merge method, preferring the common squash flow. */
function initialMergeMethod(methods: PullRequestMergeMethod[]): PullRequestMergeMethod {
  return methods.includes("squash") ? "squash" : methods[0] ?? "merge";
}

/** Converts one celebration particle into the custom-property style its animation consumes. */
function celebrationParticleStyle(particle: Particle): ParticleStyle {
  return {
    "--pr-particle-drift": particle.drift,
    animationDelay: particle.delay,
    animationDuration: particle.duration,
    backgroundColor: particle.color,
    height: `${particle.size * 1.4}px`,
    left: particle.left,
    width: `${particle.size}px`,
  };
}

/** Groups workflow states into the three colors used by the CI details list. */
function workflowRunTone(status: string, conclusion: string | null): "failed" | "skipped" | "success" {
  if (status !== "completed" || ["neutral", "skipped", "stale"].includes(conclusion ?? "")) return "skipped";
  return conclusion === "success" ? "success" : "failed";
}

/** Explains an open pull request's GitHub state without repeating an available merge action. */
function openPullRequestState(workspace: PullRequestWorkspace): string | undefined {
  if (workspace.draft) return "Not yet ready for review.";
  if (workspace.canMerge) return undefined;
  if (workspace.canManageMerge) return "GitHub is checking merge requirements.";
  if (workspace.hasGitHubAccess) return "You cannot merge this pull request.";
  return "Sign in with GitHub to manage this pull request.";
}

/** Renders the PR description and GitHub-backed conversation/actions as one responsive workspace. */
export function PullRequestWorkspace({ description: initialBody, source, workspace: initialWorkspace }: PullRequestWorkspaceProps) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [body, setBody] = useState(initialBody ?? "");
  const [bodyDraft, setBodyDraft] = useState<string>();
  const [comment, setComment] = useState("");
  const [mergeMethod, setMergeMethod] = useState<PullRequestMergeMethod>(() => initialMergeMethod(initialWorkspace.mergeMethods));
  const [mergeMenuOpen, setMergeMenuOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PullRequestAction["action"]>();
  const [message, setMessage] = useState<ActionMessage>();
  const [celebrating, setCelebrating] = useState(false);
  const mergeMenuRef = useRef<HTMLDivElement>(null);
  const mergeMethodTriggerRef = useRef<HTMLButtonElement>(null);
  // Keep a preserved client workspace renderable while a deployment adds new conversation fields.
  const reviewThreads = workspace.reviewThreads ?? [];
  const timelineEvents = workspace.timelineEvents ?? [];
  // Collapses GitHub workflow state into the color counts exposed by the compact CI footer.
  const successfulCheckCount = workspace.workflowRuns.filter((run) => run.status === "completed" && run.conclusion === "success").length;
  const skippedOrPendingCheckCount = workspace.workflowRuns.filter((run) => run.conclusion === "skipped" || run.status !== "completed" || run.conclusion === "neutral" || run.conclusion === "stale").length;
  const failedCheckCount = workspace.workflowRuns.filter((run) => ["action_required", "cancelled", "failure", "startup_failure", "timed_out"].includes(run.conclusion ?? "")).length;
  const openState = openPullRequestState(workspace);
  // GitHub interleaves normal comments, reviews, and activity records by time in one conversation.
  const conversationItems = [
    ...workspace.comments.map((entry) => ({ createdAt: entry.createdAt, entry, kind: "comment" as const, key: entry.key })),
    ...timelineEvents.map((event) => ({ createdAt: event.createdAt, event, kind: "event" as const, key: event.key })),
  ].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const reviewThreadsByReview = new Map<number, typeof reviewThreads>();
  // Group each inline discussion once before rendering every submitted review in the timeline.
  for (const thread of reviewThreads) {
    if (!thread.reviewId) continue;
    const threads = reviewThreadsByReview.get(thread.reviewId) ?? [];
    threads.push(thread);
    reviewThreadsByReview.set(thread.reviewId, threads);
  }
  const renderedReviewIds = new Set(
    conversationItems
      .filter((item): item is typeof item & { kind: "comment" } => item.kind === "comment")
      .map((item) => item.entry.reviewId)
      .filter((id): id is number => typeof id === "number"),
  );
  const unattachedThreads = reviewThreads.filter((thread) => !thread.reviewId || !renderedReviewIds.has(thread.reviewId));
  // Hide automation metadata in rendered prose while retaining it in the editable GitHub body.
  const visibleBody = body.replace(PR_STATES_BLOCK, "").trim();

  useEffect(() => {
    if (!celebrating) return;

    const timer = window.setTimeout(() => setCelebrating(false), 3_500);
    return () => window.clearTimeout(timer);
  }, [celebrating]);

  useEffect(() => {
    if (!mergeMenuOpen) return;

    /** Closes the merge-method menu when the user clicks anywhere outside it. */
    function closeMergeMenu(event: PointerEvent): void {
      if (event.target instanceof Node && !mergeMenuRef.current?.contains(event.target)) setMergeMenuOpen(false);
    }

    document.addEventListener("pointerdown", closeMergeMenu);
    return () => document.removeEventListener("pointerdown", closeMergeMenu);
  }, [mergeMenuOpen]);

  /** Opens the menu from an arrow key or closes it from its focused trigger. */
  function handleMergeTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "Escape" && mergeMenuOpen) {
      event.preventDefault();
      setMergeMenuOpen(false);
      return;
    }

    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

    const opensUp = event.key === "ArrowUp";
    event.preventDefault();
    setMergeMenuOpen(true);
    window.setTimeout(() => {
      const options = mergeMenuRef.current?.querySelectorAll<HTMLButtonElement>(".merge-method-option");
      const selected = mergeMenuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
      const fallback = opensUp ? options?.item((options?.length ?? 1) - 1) : options?.item(0);
      (selected ?? fallback)?.focus();
    }, 0);
  }

  /** Moves focus through the custom merge options and closes the menu on Escape. */
  function navigateMergeMenu(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Tab") {
      setMergeMenuOpen(false);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setMergeMenuOpen(false);
      mergeMethodTriggerRef.current?.focus();
      return;
    }

    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

    event.preventDefault();
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".merge-method-option"));
    const activeElement = document.activeElement;
    const currentIndex = activeElement instanceof HTMLButtonElement ? options.indexOf(activeElement) : -1;
    if (!options.length) return;

    let nextIndex = 0;
    if (event.key === "End" || (event.key === "ArrowUp" && currentIndex < 0)) {
      nextIndex = options.length - 1;
    } else if (event.key === "ArrowDown" && currentIndex >= 0) {
      nextIndex = (currentIndex + 1) % options.length;
    } else if (event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + options.length) % options.length;
    }
    options[nextIndex]?.focus();
  }

  /** Applies one merge method, closes the menu, and returns focus to its trigger. */
  function chooseMergeMethod(method: PullRequestMergeMethod): void {
    setMergeMethod(method);
    setMergeMenuOpen(false);
    mergeMethodTriggerRef.current?.focus();
  }

  /** Sends one explicit user action to the server and replaces local data with GitHub's fresh state. */
  async function runAction(action: PullRequestAction): Promise<boolean> {
    setPendingAction(action.action);
    setMessage(undefined);

    try {
      const path = source.map(encodeURIComponent).join("/");
      const response = await fetch(`/api/pull-request/${path}`, {
        body: JSON.stringify(action),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      // SAFETY: The local route returns this action result after validating its requested mutation.
      const result = await response.json() as { celebrate?: boolean; error?: string; workspace?: PullRequestWorkspace };

      if (!response.ok || !result.workspace) throw new Error(result.error ?? "GitHub could not complete this action");

      const refreshedMergeMethods = result.workspace.mergeMethods;
      setWorkspace(result.workspace);
      setMergeMethod((currentMethod) => refreshedMergeMethods.includes(currentMethod)
        ? currentMethod
        : initialMergeMethod(refreshedMergeMethods));
      if (result.celebrate) setCelebrating(true);
      // SAFETY: The in-check above verifies that `action.action` is a valid key of `ACTION_MESSAGES`.
      const actionMessage = action.action in ACTION_MESSAGES
        ? ACTION_MESSAGES[action.action as keyof typeof ACTION_MESSAGES]
        : undefined;
      if (actionMessage) setMessage({ error: false, text: actionMessage });
      return true;
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : "GitHub could not complete this action" });
      return false;
    } finally {
      setPendingAction(undefined);
    }
  }

  /** Posts the composed GitHub comment while preserving its command text exactly. */
  async function submitComment(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!comment.trim() || pendingAction) return;

    if (await runAction({ action: "comment", body: comment })) setComment("");
  }

  /** Saves the complete Markdown body to GitHub and updates the rendered description only after confirmation. */
  async function submitBody(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (bodyDraft === undefined || bodyDraft === body || pendingAction) return;

    const savedBody = bodyDraft;
    if (!await runAction({ action: "edit-body", body: savedBody })) return;

    setBody(savedBody);
    setBodyDraft(undefined);
  }

  return (
    <section className={`pr-workspace ${visibleBody || workspace.canEditBody ? "has-description" : ""}`}>
      {celebrating && (
        <div className="merge-celebration" aria-hidden="true">
          {CELEBRATION_PARTICLES.map((particle, index) => (
            <span
              key={index}
              style={celebrationParticleStyle(particle)}
            />
          ))}
        </div>
      )}

      {(visibleBody || workspace.canEditBody) && (
        <section className="pr-description">
          <div className="pr-description-heading">
            <span>Pull request description</span>
            {workspace.canEditBody && <button className="edit-pr-button" disabled={Boolean(pendingAction)} onClick={() => setBodyDraft(body)} type="button"><Pencil size={13} /> Edit body</button>}
          </div>
          {visibleBody && <div className="markdown-body"><GitHubMarkdown>{visibleBody}</GitHubMarkdown></div>}
        </section>
      )}

      {bodyDraft !== undefined && (
        <div aria-labelledby="pr-body-editor-title" aria-modal="true" className="pr-body-editor" role="dialog">
          <form onSubmit={submitBody}>
            <header className="pr-body-editor-header">
              <div>
                <strong id="pr-body-editor-title">Edit pull request body</strong>
                <span>GitHub Markdown</span>
              </div>
              <div className="pr-body-editor-actions">
                <button disabled={Boolean(pendingAction)} onClick={() => setBodyDraft(undefined)} type="button">Cancel</button>
                <button className="save" disabled={bodyDraft === body || Boolean(pendingAction)} type="submit">Save to GitHub</button>
              </div>
            </header>
            <div className="pr-body-editor-panes">
              <label className="pr-body-editor-pane">
                <span>Markdown</span>
                <textarea
                  aria-label="Pull request body Markdown"
                  autoFocus
                  disabled={Boolean(pendingAction)}
                  onChange={(event) => setBodyDraft(event.target.value)}
                  spellCheck
                  value={bodyDraft}
                />
              </label>
              <section aria-label="Markdown preview" className="pr-body-editor-pane pr-body-editor-preview">
                <span>Preview</span>
                <div className="markdown-body">
                  {bodyDraft ? <GitHubMarkdown>{bodyDraft}</GitHubMarkdown> : <p className="pr-body-editor-empty">Nothing to preview.</p>}
                </div>
              </section>
            </div>
          </form>
        </div>
      )}

      <aside className={`pr-conversation${mergeMenuOpen ? " merge-menu-open" : ""}`} aria-label="Pull request conversation">
        {workspace.state === "open" && (
          <header className="pr-conversation-heading">
            <div className="pr-state">
              <span className={`pr-state-pill ${workspace.draft ? "draft" : "open"}`}>{workspace.draft ? "Draft" : "Open"}</span>
              {openState && <span>{openState}</span>}
            </div>
          </header>
        )}

        <div className="pr-comment-list">
          {workspace.commits.length > 0 && (
            <details className="pr-commit-list">
              <summary><GitCommitHorizontal size={13} /> <span>{workspace.commits.length === 1 ? "1 commit" : `${workspace.commits.length} commits`}</span></summary>
              {workspace.commits.map((commit) => (
                <article className="pr-commit" key={commit.sha}>
                  <span className="pr-commit-message" title={commit.message}>{commitSummary(commit.message)}</span>
                  <span className="pr-commit-meta">{commit.author} · {commit.sha.slice(0, 7)}</span>
                </article>
              ))}
            </details>
          )}
          {workspace.commitsUnavailable && <p className="pr-conversation-note">Commit history may be incomplete.</p>}
          {conversationItems.length || reviewThreads.length ? conversationItems.map((item) => {
            if (item.kind === "event") {
              return <p className="pr-timeline-event" key={item.key}><time dateTime={item.event.createdAt} suppressHydrationWarning>{commentDate(item.event.createdAt)}</time>{item.event.text}</p>;
            }

            const entry = item.entry;
            const threads = entry.reviewId ? reviewThreadsByReview.get(entry.reviewId) : undefined;
            const hasBody = Boolean(entry.body?.trim());
            const hasThreads = Boolean(threads?.length);

            if (!hasBody && !hasThreads) {
              if (entry.context && entry.context !== "commented") {
                const actionLabel = entry.context === "approved" ? "approved these changes" : entry.context === "changes requested" ? "requested changes" : entry.context;
                return <p className="pr-timeline-event" key={item.key}><time dateTime={entry.createdAt} suppressHydrationWarning>{commentDate(entry.createdAt)}</time>{entry.author} {actionLabel}</p>;
              }
              return null;
            }

            return (
              <div className="pr-conversation-entry" key={item.key}>
                {hasBody && (
                  <article className="pr-comment">
                    <Image className="avatar" src={entry.avatarUrl} alt="" width={20} height={20} />
                    <div>
                      <header><strong>{entry.author}</strong><time dateTime={entry.createdAt} suppressHydrationWarning>{commentDate(entry.createdAt)}</time>{entry.updatedAt !== entry.createdAt && <span>edited</span>}</header>
                      {entry.context && entry.context !== "commented" && <span className="pr-comment-context">{entry.context === "approved" ? "approved these changes" : entry.context === "changes requested" ? "requested changes" : entry.context}</span>}
                      <div className="pr-comment-markdown"><GitHubMarkdown>{entry.body}</GitHubMarkdown></div>
                    </div>
                  </article>
                )}
                {threads?.map((thread) => (
                  <PullRequestReviewThread key={thread.comments[0]?.id ?? thread.path} onAction={runAction} pending={Boolean(pendingAction)} thread={thread} />
                ))}
              </div>
            );
          }) : !workspace.conversationUnavailable && <p className="pr-comment-empty">No conversation yet.</p>}
          {unattachedThreads.map((thread) => (
            <PullRequestReviewThread key={thread.comments[0]?.id ?? thread.path} onAction={runAction} pending={Boolean(pendingAction)} thread={thread} />
          ))}
          {workspace.conversationUnavailable && <p className="pr-conversation-note">Conversation may be incomplete.</p>}
        </div>

        {workspace.canComment && (
          <form className="pr-comment-form" onSubmit={submitComment}>
            <textarea
              aria-label="Comment or GitHub command"
              disabled={Boolean(pendingAction)}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Leave a comment or run a command…"
              value={comment}
            />
            <button disabled={!comment.trim() || Boolean(pendingAction)} type="submit"><Send size={13} /> Comment</button>
          </form>
        )}

        {!workspace.canComment && <p className="pr-signin-note">{workspace.hasGitHubAccess ? "Conversation locked on GitHub." : "Sign in with GitHub to comment, merge, or manage this pull request."}</p>}

        {(workspace.workflowRuns.length > 0 || workspace.canManageMerge || workspace.canMarkReady || workspace.canClose) && workspace.state === "open" && (
          <div className="pr-actions">
            {(workspace.canManageMerge || workspace.canMarkReady || workspace.canClose) && <div className="pr-action-row">
              {workspace.canMarkReady && <button className="ready-review-button" disabled={Boolean(pendingAction)} onClick={() => void runAction({ action: "ready" })} type="button"><GitPullRequest size={13} /> Mark ready for review</button>}
              {workspace.canManageMerge && (
                <div className="merge-control">
                  <button className="merge-button" disabled={Boolean(pendingAction) || !workspace.canMerge} onClick={() => void runAction({ action: "merge", method: mergeMethod })} title={workspace.canMerge ? undefined : "GitHub has not made this pull request mergeable yet"} type="button">{MERGE_METHOD_LABELS[mergeMethod]}</button>
                  {workspace.mergeMethods.length > 1 && (
                    <div className="merge-method-dropdown" ref={mergeMenuRef}>
                      <button
                        aria-expanded={mergeMenuOpen}
                        aria-haspopup="menu"
                        aria-label={`Merge method: ${MERGE_METHOD_LABELS[mergeMethod]}`}
                        className="merge-method-trigger"
                        disabled={Boolean(pendingAction)}
                        onClick={() => setMergeMenuOpen((open) => !open)}
                        onKeyDown={handleMergeTriggerKeyDown}
                        ref={mergeMethodTriggerRef}
                        type="button"
                      >
                        <ChevronDown aria-hidden="true" size={13} />
                      </button>
                      {mergeMenuOpen && (
                        <div aria-label="Merge method" className="merge-method-menu" onKeyDown={navigateMergeMenu} role="menu">
                          {workspace.mergeMethods.map((method) => (
                            <button
                              aria-checked={method === mergeMethod}
                              className="merge-method-option"
                              key={method}
                              onClick={() => chooseMergeMethod(method)}
                              role="menuitemradio"
                              type="button"
                            >
                              {method === mergeMethod && <Check aria-hidden="true" size={12} />}
                              <span>{MERGE_METHOD_LABELS[method]}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {workspace.canClose && <button className="close-pr-button" disabled={Boolean(pendingAction)} onClick={() => void runAction({ action: "close" })} type="button"><GitPullRequestClosed size={13} /> Close</button>}
            </div>}
            {workspace.workflowRuns.length > 0 && (
              <details className="pr-ci-summary">
                <summary>
                  <span className="sr-only">{successfulCheckCount} successful checks, {skippedOrPendingCheckCount} skipped or pending checks, {failedCheckCount} failed checks.</span>
                  <span aria-hidden="true">CI</span>
                  <span className="ci-success" aria-hidden="true">{successfulCheckCount}</span>
                  <span className="ci-skipped" aria-hidden="true">{skippedOrPendingCheckCount}</span>
                  <span className="ci-failed" aria-hidden="true">{failedCheckCount}</span>
                </summary>
                <div className="pr-ci-panel">
                  {workspace.workflowRuns.map((run) => {
                    const tone = workflowRunTone(run.status, run.conclusion);
                    return (
                      <a className="pr-ci-run" href={run.url} key={run.id} rel="noreferrer" target="_blank">
                        <span className={`pr-ci-run-tone ${tone}`} aria-hidden="true" />
                        <span className="pr-ci-run-name">{run.name}</span>
                      </a>
                    );
                  })}
                </div>
              </details>
            )}
          </div>
        )}

        {workspace.state === "merged" && <div className="pr-resolution merged"><CheckCircle2 size={14} /> Merged on GitHub</div>}
        {workspace.state === "closed" && <div className="pr-resolution closed"><CircleX size={14} /> Closed on GitHub</div>}
        {message && <p className={`pr-action-message ${message.error ? "error" : ""}`} role="status">{message.text}</p>}
      </aside>
    </section>
  );
}
