"use client";

import type { CSSProperties, FormEvent } from "react";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckCircle2, CircleAlert, CircleX, GitPullRequestClosed, LoaderCircle, PanelRightOpen, Play, Send, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { PullRequestAction, PullRequestMergeMethod, PullRequestWorkflowRun, PullRequestWorkspace } from "@/types/github";

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

const DATE_FORMAT = new Intl.DateTimeFormat("en", { day: "numeric", month: "short" });
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

/** Formats a GitHub timestamp in the compact form used inside conversation rows. */
function commentDate(value: string): string {
  return DATE_FORMAT.format(new Date(value));
}

/** Selects the first GitHub-enabled merge method, preferring the common squash flow. */
function initialMergeMethod(methods: PullRequestMergeMethod[]): PullRequestMergeMethod {
  return methods.includes("squash") ? "squash" : methods[0] ?? "merge";
}

/** Renders the visible status indicator for one GitHub Actions workflow run. */
function WorkflowIcon({ run }: { run: PullRequestWorkflowRun }) {
  if (run.status !== "completed") return <LoaderCircle className="spinner" size={14} />;
  if (run.conclusion === "success") return <CheckCircle2 size={14} />;
  return <CircleAlert size={14} />;
}

/** Renders the PR description and GitHub-backed conversation/actions as one responsive workspace. */
export function PullRequestWorkspace({ description, source, workspace: initialWorkspace }: PullRequestWorkspaceProps) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [comment, setComment] = useState("");
  const [mergeMethod, setMergeMethod] = useState<PullRequestMergeMethod>(() => initialMergeMethod(initialWorkspace.mergeMethods));
  const [pendingAction, setPendingAction] = useState<string>();
  const [message, setMessage] = useState<ActionMessage>();
  const [celebrating, setCelebrating] = useState(false);

  useEffect(() => {
    if (!celebrating) return;

    const timer = window.setTimeout(() => setCelebrating(false), 3_500);
    return () => window.clearTimeout(timer);
  }, [celebrating]);

  /** Sends one explicit user action to the server and replaces local data with GitHub's fresh state. */
  async function runAction(action: PullRequestAction): Promise<boolean> {
    const actionKey = action.action === "rerun" ? `rerun-${action.runId}` : action.action;
    setPendingAction(actionKey);
    setMessage(undefined);

    try {
      const path = source.map(encodeURIComponent).join("/");
      const response = await fetch(`/api/pull-request/${path}`, {
        body: JSON.stringify(action),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const result = await response.json() as { celebrate?: boolean; error?: string; workspace?: PullRequestWorkspace };

      if (!response.ok || !result.workspace) throw new Error(result.error ?? "GitHub could not complete this action");

      const refreshedMergeMethods = result.workspace.mergeMethods;
      setWorkspace(result.workspace);
      setMergeMethod((currentMethod) => refreshedMergeMethods.includes(currentMethod)
        ? currentMethod
        : initialMergeMethod(refreshedMergeMethods));
      if (result.celebrate) setCelebrating(true);
      setMessage({
        error: false,
        text: action.action === "comment" ? "Comment posted to GitHub." : action.action === "rerun" ? "GitHub is rerunning failed jobs." : action.action === "close" ? "Pull request closed on GitHub." : "Pull request merged on GitHub.",
      });
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

  return (
    <section className={`pr-workspace ${description ? "has-description" : ""}`}>
      {description && (
        <details className="pr-description" open>
          <summary>Pull request description</summary>
          <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{description}</ReactMarkdown></div>
        </details>
      )}

      <aside className="pr-conversation" aria-label="Pull request conversation">
        {celebrating && (
          <div className="merge-celebration" aria-hidden="true">
            {CELEBRATION_PARTICLES.map((particle, index) => (
              <span
                key={index}
                style={{
                  "--pr-particle-drift": particle.drift,
                  animationDelay: particle.delay,
                  animationDuration: particle.duration,
                  backgroundColor: particle.color,
                  height: `${particle.size * 1.4}px`,
                  left: particle.left,
                  width: `${particle.size}px`,
                } as ParticleStyle}
              />
            ))}
          </div>
        )}

        <header className="pr-conversation-heading">
          <span>Conversation</span>
          <span>{workspace.comments.length}</span>
        </header>

        <div className="pr-comment-list">
          {workspace.comments.length ? workspace.comments.map((entry) => (
            <article className="pr-comment" key={entry.key}>
              <Image className="avatar" src={entry.avatarUrl} alt="" width={20} height={20} />
              <div>
                <header><strong>{entry.author}</strong><time dateTime={entry.createdAt}>{commentDate(entry.createdAt)}</time></header>
                {entry.context && <span className="pr-comment-context">{entry.context}</span>}
                <div className="pr-comment-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{entry.body}</ReactMarkdown></div>
              </div>
            </article>
          )) : !workspace.conversationUnavailable && <p className="pr-comment-empty">No conversation yet.</p>}
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

        {!workspace.canComment && <p className="pr-signin-note">Conversation locked on GitHub.</p>}

        {(workspace.workflowRuns.length > 0 || workspace.canMerge || workspace.canClose) && workspace.state === "open" && (
          <div className="pr-actions">
            {workspace.workflowRuns.length > 0 && (
              <details className="pr-workflow-disclosure">
                <summary className="pr-ci-summary">
                  <span>CI</span>
                  <span>{workspace.workflowRuns.length} checks</span>
                  <PanelRightOpen size={13} />
                </summary>
                <div className="pr-workflow-list">
                  {workspace.workflowRuns.map((run) => (
                    <div className={`workflow-run ${run.status === "completed" && run.conclusion !== "success" ? "failed" : ""}`} key={run.id}>
                      <a href={run.url} target="_blank" rel="noreferrer"><WorkflowIcon run={run} /> {run.name}</a>
                      {run.canRerun && <button disabled={Boolean(pendingAction)} onClick={() => void runAction({ action: "rerun", runId: run.id })} type="button"><Play size={11} /> Re-run</button>}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {(workspace.canMerge || workspace.canClose) && <div className="pr-action-row">
              {workspace.canMerge && (
                <div className="merge-control">
                  {workspace.mergeMethods.length > 1 && (
                    <select aria-label="Merge method" disabled={Boolean(pendingAction)} onChange={(event) => setMergeMethod(event.target.value as PullRequestMergeMethod)} value={mergeMethod}>
                      {workspace.mergeMethods.map((method) => <option key={method} value={method}>{method}</option>)}
                    </select>
                  )}
                  <button className="merge-button" disabled={Boolean(pendingAction)} onClick={() => void runAction({ action: "merge", method: mergeMethod })} type="button"><Sparkles size={13} /> Merge</button>
                </div>
              )}
              {workspace.canClose && <button className="close-pr-button" disabled={Boolean(pendingAction)} onClick={() => void runAction({ action: "close" })} type="button"><GitPullRequestClosed size={13} /> Close</button>}
            </div>}
          </div>
        )}

        {workspace.state === "merged" && <div className="pr-resolution merged"><CheckCircle2 size={14} /> Merged on GitHub</div>}
        {workspace.state === "closed" && <div className="pr-resolution closed"><CircleX size={14} /> Closed on GitHub</div>}
        {message && <p className={`pr-action-message ${message.error ? "error" : ""}`} role="status">{message.text}</p>}
      </aside>
    </section>
  );
}
