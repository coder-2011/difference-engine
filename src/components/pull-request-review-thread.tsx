"use client";

import type { FormEvent } from "react";
import Image from "next/image";
import { Check, ExternalLink, Reply, RotateCcw, Send } from "lucide-react";
import { useState } from "react";
import { GitHubMarkdown } from "@/components/github-markdown";
import type { PullRequestAction, PullRequestReviewThread } from "@/types/github";

type PullRequestReviewThreadProps = {
  onAction: (action: PullRequestAction) => Promise<boolean>;
  pending: boolean;
  thread: PullRequestReviewThread;
};

/** Formats GitHub's current and original line locations without hiding an outdated anchor. */
function threadLocation(thread: PullRequestReviewThread): string {
  const range = thread.startLine && thread.line && thread.startLine !== thread.line
    ? `${thread.startLine}–${thread.line}`
    : String(thread.line ?? thread.originalLine ?? "file");
  const original = thread.originalStartLine && thread.originalStartLine !== thread.originalLine
    ? `${thread.originalStartLine}–${thread.originalLine}`
    : thread.originalLine;

  return thread.line ? `${thread.path}:${range}` : `${thread.path}:${original ?? "file"}`;
}

/** Renders one complete GitHub inline discussion, including replies and available thread controls. */
export function PullRequestReviewThread({ onAction, pending, thread }: PullRequestReviewThreadProps) {
  const [reply, setReply] = useState("");
  const [replyOpen, setReplyOpen] = useState(false);
  const rootComment = thread.comments[0];

  /** Sends a reply to GitHub's root review comment and clears only after confirmation. */
  async function submitReply(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!rootComment || !reply.trim() || pending) return;

    if (await onAction({ action: "reply", body: reply, commentId: rootComment.id })) {
      setReply("");
      setReplyOpen(false);
    }
  }

  if (!rootComment) return null;

  return (
    <section className={`pr-review-thread ${thread.isResolved ? "resolved" : ""}`}>
      <header className="pr-review-thread-heading">
        <div>
          <a href={rootComment.url} rel="noreferrer" target="_blank"><code>{threadLocation(thread)}</code> <ExternalLink aria-hidden="true" size={12} /></a>
          <span className={`pr-review-thread-state ${thread.isOutdated ? "outdated" : ""}`}>{!thread.statusKnown ? "Status unavailable" : thread.isOutdated ? "Outdated" : thread.isResolved ? "Resolved" : "Open"}</span>
          {thread.isResolved && thread.resolvedBy && <span>by {thread.resolvedBy}</span>}
        </div>
        {thread.id && (thread.canResolve || thread.canUnresolve) && (
          <button
            disabled={pending}
            onClick={() => void onAction({ action: thread.isResolved ? "unresolve-thread" : "resolve-thread", threadId: thread.id! })}
            type="button"
          >
            {thread.isResolved ? <RotateCcw size={13} /> : <Check size={13} />}
            {thread.isResolved ? "Unresolve" : "Resolve"}
          </button>
        )}
      </header>
      {thread.diffHunk && <pre className="pr-review-thread-hunk"><code>{thread.diffHunk}</code></pre>}
      <div className="pr-review-thread-comments">
        {thread.comments.map((comment) => (
          <article className="pr-review-thread-comment" key={comment.id}>
            <Image className="avatar" src={comment.avatarUrl} alt="" width={20} height={20} />
            <div>
              <header><strong>{comment.author}</strong><time dateTime={comment.createdAt} suppressHydrationWarning>{new Date(comment.createdAt).toLocaleString()}</time>{comment.updatedAt !== comment.createdAt && <span>edited</span>}</header>
              <div className="pr-comment-markdown"><GitHubMarkdown>{comment.body}</GitHubMarkdown></div>
            </div>
          </article>
        ))}
      </div>
      {thread.canReply && (
        <div className="pr-review-thread-reply">
          {!replyOpen && <button disabled={pending} onClick={() => setReplyOpen(true)} type="button"><Reply size={13} /> Reply</button>}
          {replyOpen && (
            <form onSubmit={submitReply}>
              <textarea aria-label={`Reply to ${threadLocation(thread)}`} autoFocus disabled={pending} onChange={(event) => setReply(event.target.value)} value={reply} />
              <div>
                <button disabled={pending} onClick={() => setReplyOpen(false)} type="button">Cancel</button>
                <button disabled={!reply.trim() || pending} type="submit"><Send size={13} /> Reply</button>
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
