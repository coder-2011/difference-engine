"use client";

import { AlertCircle, ExternalLink, GitCompareArrows, LoaderCircle, Network, RefreshCw } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import type { CallDiffDocument, CallDiffNode } from "@/types/call-diff";

type CallDiffViewerProps = {
  onSelect?: (selection: CallDiffSelection) => void;
  source: string[];
};

export type CallDiffSelection = {
  file: string;
  line: number;
  text: string;
  x: number;
  y: number;
};

type CallDiffState =
  | { status: "loading" }
  | { document: CallDiffDocument; status: "ready" }
  | { error: string; status: "error" };

/** Builds a viewer link for the exact source revision and location used by one call-tree node. */
function sourceLocationUrl(source: string[], ref: string, file: string, line: number): string {
  const repository = source.slice(0, 2).map(encodeURIComponent).join("/");
  const path = file.split("/").map(encodeURIComponent).join("/");
  return `/${repository}/blob/${encodeURIComponent(ref)}/${path}#L${line}`;
}

/** Renders one recursive call-flow node with source navigation and selection actions. */
function CallDiffNodeRow({ fromRef, node, onSelect, source, toRef }: { fromRef: string; node: CallDiffNode; onSelect?: (selection: CallDiffSelection) => void; source: string[]; toRef: string }) {
  const ref = node.status === "removed" ? fromRef : toRef;
  const location = `${node.file}:${node.line}`;

  /** Places one Call Flow source line into the existing annotation and Ask Diffs selection flow. */
  function selectNode(event: ReactMouseEvent<HTMLButtonElement>): void {
    onSelect?.({
      file: node.file,
      line: node.line,
      text: node.snippet,
      x: event.clientX,
      y: event.clientY,
    });
  }

  return (
    <li className={`call-diff-node ${node.kind} ${node.status}`}>
      <div className="call-diff-node-line">
        <span aria-label={node.status === "same" ? "unchanged call" : `${node.status} call`} className="call-diff-status" />
        {onSelect ? (
          <button className="call-diff-node-select" onClick={selectNode} title={`Ask or annotate ${location}`} type="button">
            <code>{node.label}</code>
            <span>{location}</span>
          </button>
        ) : (
          <a href={sourceLocationUrl(source, ref, node.file, node.line)} title={`Open ${location}`}>
            <code>{node.label}</code>
            <span>{location}</span>
          </a>
        )}
        {onSelect && <a aria-label={`Open ${location}`} className="call-diff-node-source" href={sourceLocationUrl(source, ref, node.file, node.line)} title={`Open ${location}`}><ExternalLink size={12} /></a>}
      </div>
      {node.children.length > 0 && (
        <ol>
          {node.children.map((child, index) => (
            <CallDiffNodeRow fromRef={fromRef} key={`${child.key}-${child.line}-${index}`} node={child} onSelect={onSelect} source={source} toRef={toRef} />
          ))}
        </ol>
      )}
    </li>
  );
}

/** Shows lazy call-flow analysis and exposes one bounded source line for each selected node. */
export function CallDiffViewer({ onSelect, source }: CallDiffViewerProps) {
  const sourcePath = useMemo(() => source.map(encodeURIComponent).join("/"), [source]);
  const [state, setState] = useState<CallDiffState>({ status: "loading" });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });

    /** Reads the server-only analysis once and ignores a response from a superseded review. */
    async function loadCallDiff(): Promise<void> {
      try {
        const response = await fetch(`/api/call-diff/${sourcePath}`, { signal: controller.signal });
        const result = await response.json() as CallDiffDocument & { error?: string };
        if (!response.ok) throw new Error(result.error ?? "The call flow could not be loaded");
        setState({ document: result, status: "ready" });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({ error: error instanceof Error ? error.message : "The call flow could not be loaded", status: "error" });
      }
    }

    void loadCallDiff();
    return () => controller.abort();
  }, [retry, sourcePath]);

  if (state.status === "loading") {
    return <section aria-busy="true" className="call-diff-loading"><LoaderCircle className="spinner" size={19} /><strong>Tracing changed call flow</strong><span>Reading the before and after source snapshots…</span></section>;
  }

  if (state.status === "error") {
    return (
      <section className="call-diff-error">
        <AlertCircle size={18} />
        <div><strong>Couldn’t trace this call flow</strong><span>{state.error}</span></div>
        <button onClick={() => setRetry((value) => value + 1)} type="button"><RefreshCw size={13} /> Retry</button>
      </section>
    );
  }

  const document = state.document;
  const summary = `${document.filesAnalyzed} changed ${document.filesAnalyzed === 1 ? "source file" : "source files"}`;
  const limits = [document.ignoredFiles ? `${document.ignoredFiles} skipped` : "", document.truncated ? "bounded view" : ""].filter(Boolean).join(" · ");

  return (
    <section className="call-diff-viewer" aria-label="Call flow">
      <header className="call-diff-header">
        <div className="call-diff-summary"><GitCompareArrows size={14} /><span>{summary}</span>{limits && <small>{limits}</small>}</div>
      </header>

      <div className="call-diff-legend" aria-label="Call flow legend"><span className="added">Added</span><span className="removed">Removed</span><span>{onSelect ? "Click a call to ask or annotate." : "Click any call to open its exact revision."}</span></div>

      {document.entries.length ? (
        <div className="call-diff-entry-list">
          {document.entries.map((entry) => (
            <article className="call-diff-entry" key={entry.key}>
              <ol className="call-diff-tree"><CallDiffNodeRow fromRef={document.fromRef} node={entry.tree} onSelect={onSelect} source={source} toRef={document.toRef} /></ol>
            </article>
          ))}
        </div>
      ) : (
        <div className="call-diff-empty"><Network size={19} /><strong>No changed call flow found</strong><span>The changed supported files do not add, remove, or rewire a parsed call.</span></div>
      )}
    </section>
  );
}
