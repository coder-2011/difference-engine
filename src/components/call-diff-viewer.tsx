"use client";

import { AlertCircle, ChevronDown, ChevronRight, ClipboardCopy, ExternalLink, FileText, LoaderCircle, Network, PanelLeftClose, PanelLeftOpen, RefreshCw, X } from "lucide-react";
import { Fragment, type MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import type { CallDiffDocument, CallDiffNode } from "@/types/call-diff";
import { getFiletypeFromFileName, getSharedHighlighter } from "@pierre/diffs";

type CallDiffViewerProps = {
  activeFile?: string;
  additions?: number;
  changedFiles?: number;
  deletions?: number;
  onClearFile?: () => void;
  onSelect?: (selection: CallDiffSelection) => void;
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
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

type SyntaxToken = {
  color?: string;
  content: string;
};

type CallDiffDisplayStatus = "added" | "changed" | "removed" | "same";

/** Builds a viewer link for the exact source revision and location used by one call-tree node. */
function sourceLocationUrl(source: string[], ref: string, file: string, line: number): string {
  const repository = source.slice(0, 2).map(encodeURIComponent).join("/");
  const path = file.split("/").map(encodeURIComponent).join("/");
  return `/${repository}/blob/${encodeURIComponent(ref)}/${path}#L${line}`;
}

/** Checks whether a call tree retains context from the selected changed file. */
function treeTouchesFile(node: CallDiffNode, file: string): boolean {
  return node.file === file || node.children.some((child) => treeTouchesFile(child, file));
}

/** Colors retained parents by the added and removed calls they contain. */
function displayStatus(node: CallDiffNode): CallDiffDisplayStatus {
  if (node.status !== "same") return node.status;

  const childStatuses = node.children.map(displayStatus);
  const hasAdded = childStatuses.some((status) => status === "added" || status === "changed");
  const hasRemoved = childStatuses.some((status) => status === "removed" || status === "changed");
  if (hasAdded && hasRemoved) return "changed";
  if (hasAdded) return "added";
  if (hasRemoved) return "removed";
  return "same";
}

/** Keeps only call-tree branches that lead to a changed call. */
function treeHasChanges(node: CallDiffNode): boolean {
  return node.status !== "same" || node.children.some(treeHasChanges);
}

/** Renders a Call Flow source line with the same shared Shiki theme as the main diff. */
function HighlightedCallCode({ file, text }: { file: string; text: string }) {
  const language = getFiletypeFromFileName(file);
  const key = `${file}\0${text}`;
  const [highlight, setHighlight] = useState<{ key: string; tokens: SyntaxToken[][] }>();

  useEffect(() => {
    let cancelled = false;

    void getSharedHighlighter({
      langs: [language],
      preferredHighlighter: "shiki-wasm",
      themes: ["pierre-dark"],
    }).then((highlighter) => highlighter.codeToTokens(text, {
      lang: language,
      theme: "pierre-dark",
    })).then((result) => {
      if (!cancelled) setHighlight({ key, tokens: result.tokens });
    }).catch(() => {
      // The source line remains readable when an optional grammar cannot load.
    });

    return () => {
      cancelled = true;
    };
  }, [key, language, text]);

  return (
    <code>
      {highlight?.key === key
        ? highlight.tokens.map((line, lineIndex) => (
            <Fragment key={lineIndex}>
              {line.map((token, tokenIndex) => <span key={tokenIndex} style={{ color: token.color }}>{token.content}</span>)}
              {lineIndex < highlight.tokens.length - 1 ? "\n" : null}
            </Fragment>
          ))
        : text}
    </code>
  );
}

/** Renders one recursive call-flow node with source navigation and selection actions. */
function CallDiffNodeRow({ collapsed, fromRef, node, onSelect, source, toRef }: { collapsed: boolean; fromRef: string; node: CallDiffNode; onSelect?: (selection: CallDiffSelection) => void; source: string[]; toRef: string }) {
  const ref = node.status === "removed" ? fromRef : toRef;
  const location = `${node.file}:${node.line}`;
  const sourceLine = node.snippet.trim() || node.label;
  const status = displayStatus(node);
  const children = node.children.filter(treeHasChanges);

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
    <li className={`call-diff-node ${node.kind} ${status}`}>
      <div className="call-diff-node-line">
        <span aria-label={status === "same" ? "unchanged call" : status === "changed" ? "added and removed calls" : `${status} call`} className="call-diff-status" />
        {onSelect ? (
          <button className="call-diff-node-select" onClick={selectNode} title={`Ask or annotate ${location}`} type="button">
            <HighlightedCallCode file={node.file} text={sourceLine} />
            <span>{location}</span>
          </button>
        ) : (
          <a href={sourceLocationUrl(source, ref, node.file, node.line)} title={`Open ${location}`}>
            <HighlightedCallCode file={node.file} text={sourceLine} />
            <span>{location}</span>
          </a>
        )}
        {onSelect && <a aria-label={`Open ${location}`} className="call-diff-node-source" href={sourceLocationUrl(source, ref, node.file, node.line)} title={`Open ${location}`}><ExternalLink size={12} /></a>}
      </div>
      {!collapsed && children.length > 0 && (
        <ol>
          {children.map((child, index) => (
            <CallDiffNodeRow collapsed={collapsed} fromRef={fromRef} key={`${child.key}-${child.line}-${index}`} node={child} onSelect={onSelect} source={source} toRef={toRef} />
          ))}
        </ol>
      )}
    </li>
  );
}

/** Shows lazy call-flow analysis and exposes one bounded source line for each selected node. */
export function CallDiffViewer({ activeFile, additions, changedFiles, deletions, onClearFile, onSelect, onToggleSidebar, sidebarOpen, source }: CallDiffViewerProps) {
  const sourcePath = useMemo(() => source.map(encodeURIComponent).join("/"), [source]);
  const [state, setState] = useState<CallDiffState>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [rawCallDiffCopyStatus, setRawCallDiffCopyStatus] = useState("");

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
  const changedLines = (additions ?? 0) + (deletions ?? 0);
  const hasLineCounts = additions !== undefined || deletions !== undefined;
  const entries = activeFile
    ? document.entries.filter((entry) => treeTouchesFile(entry.tree, activeFile))
    : document.entries;

  /** Copies the exact Call Flow API document so its intersection is available outside the viewer. */
  async function copyRawCallDiff(): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(document, null, 2));
      setRawCallDiffCopyStatus("Copied");
      window.setTimeout(() => setRawCallDiffCopyStatus(""), 2_000);
    } catch {
      setRawCallDiffCopyStatus("Copy failed");
    }
  }

  return (
    <section className="call-diff-viewer" aria-label="Call flow">
      <header className="call-diff-toolbar viewer-toolbar">
        <div className="change-stats">
          <span><FileText size={13} /> {changedFiles ?? document.filesAnalyzed} files</span>
          {hasLineCounts && <span>{changedLines.toLocaleString()} LOC</span>}
          {additions !== undefined && <span className="additions">+{additions.toLocaleString()}</span>}
          {deletions !== undefined && <span className="deletions">−{deletions.toLocaleString()}</span>}
        </div>
        <div className="viewer-actions">
          <button aria-label="Copy raw call diff as JSON" onClick={() => void copyRawCallDiff()} title="Copy raw call diff" type="button"><ClipboardCopy size={14} /> {rawCallDiffCopyStatus || "Copy raw call diff"}</button>
          {activeFile && <button aria-label="Show all call flows" className="call-diff-file-filter" onClick={onClearFile} title="Show all call flows" type="button"><FileText size={13} /><span>{activeFile}</span><X size={12} /></button>}
          <button className="sidebar-toggle" onClick={onToggleSidebar} title="Toggle file tree" type="button">
            {sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </button>
          <button className="collapse-toggle" onClick={() => setCollapsed((value) => !value)} type="button">
            {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
            {collapsed ? "Expand" : "Collapse"}
          </button>
        </div>
      </header>

      {entries.length ? (
        <div className="call-diff-entry-list">
          {entries.map((entry) => (
            <article className="call-diff-entry" key={entry.key}>
              <ol className="call-diff-tree"><CallDiffNodeRow collapsed={collapsed} fromRef={document.fromRef} node={entry.tree} onSelect={onSelect} source={source} toRef={document.toRef} /></ol>
            </article>
          ))}
        </div>
      ) : (
        <div className="call-diff-empty"><Network size={19} /><strong>{activeFile ? "No call flow touches this file" : "No changed call flow found"}</strong><span>{activeFile ? activeFile : "The changed supported files do not add, remove, or rewire a parsed call."}</span></div>
      )}
    </section>
  );
}
