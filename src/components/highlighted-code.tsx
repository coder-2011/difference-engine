"use client";

import { getFiletypeFromFileName } from "@pierre/diffs";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Children, cloneElement, isValidElement, useDeferredValue, useEffect, useState } from "react";

const LANGUAGE_ALIASES: Record<string, string> = {
  bash: "bash",
  c: "c",
  "c++": "cpp",
  console: "bash",
  cpp: "cpp",
  css: "css",
  cu: "cpp",
  cuh: "cpp",
  cuda: "cpp",
  diff: "diff",
  go: "go",
  html: "html",
  java: "java",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  markdown: "markdown",
  md: "markdown",
  output: "text",
  patch: "diff",
  plaintext: "text",
  python: "python",
  py: "python",
  rs: "rust",
  rust: "rust",
  sh: "bash",
  shell: "bash",
  sql: "sql",
  suggestion: "diff",
  text: "text",
  ts: "typescript",
  tsx: "tsx",
  typescript: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

const MAX_HIGHLIGHT_LENGTH = 20_000;
const HIGHLIGHT_CACHE = new Map<string, string>();
const MAX_CACHE_ENTRIES = 500;

type CodeProps = ComponentPropsWithoutRef<"code"> & {
  block?: boolean;
};
type HighlightedResult = {
  html: string;
  language: string;
  source: string;
};
type MarkdownCodeBlockProps = {
  children: React.ReactNode;
  className?: string;
  source: string;
};

/** Highlights one block through the same Pierre WASM singleton and theme as the diff viewer. */
async function highlightCode(source: string, language: string): Promise<string> {
  const cacheKey = `${language}\0${source}`;
  const cached = HIGHLIGHT_CACHE.get(cacheKey);
  if (cached) return cached;

  const { getSharedHighlighter } = await import("@pierre/diffs");
  const highlighter = await getSharedHighlighter({
    langs: [language],
    preferredHighlighter: "shiki-js",
    themes: ["pierre-dark"],
  });
  const html = highlighter.codeToHtml(source, { lang: language, theme: "pierre-dark" });
  if (HIGHLIGHT_CACHE.size >= MAX_CACHE_ENTRIES) {
    const firstKey = HIGHLIGHT_CACHE.keys().next().value;
    if (firstKey) HIGHLIGHT_CACHE.delete(firstKey);
  }
  HIGHLIGHT_CACHE.set(cacheKey, html);
  return html;
}

/** Joins React, HAST, or string class names before matching a fence language. */
function classNameText(className: unknown): string {
  if (typeof className === "string") return className;
  if (Array.isArray(className)) return className.filter((part) => typeof part === "string").join(" ");
  return "";
}

/** Maps a fenced-Markdown class name to a Pierre grammar, including path and citation fences. */
function supportedLanguage(className: unknown): string | null {
  const token = classNameText(className).match(/language-([^\s]+)/)?.[1];
  if (!token) return null;

  const name = token.toLowerCase();
  const aliased = LANGUAGE_ALIASES[name];
  if (aliased) return aliased;

  const fromPath = getFiletypeFromFileName(token);
  if (fromPath !== "text") return fromPath;
  const fromExtension = getFiletypeFromFileName(`file.${name}`);
  return fromExtension === "text" ? null : fromExtension;
}

/** Converts React's Markdown children into the exact source sent to the highlighter. */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function codeText(children: CodeProps["children"]): string {
  return nodeText(children).replace(/\n$/, "");
}

/** Wraps code in a fence longer than any backtick run already inside it. */
function fencedMarkdown(source: string, className?: string): string {
  const language = className?.match(/language-([^\s]+)/)?.[1] ?? "";
  let fenceLength = 3;

  for (const match of source.matchAll(/`+/g)) {
    fenceLength = Math.max(fenceLength, match[0].length + 1);
  }

  const fence = "`".repeat(fenceLength);
  return `${fence}${language}\n${source}\n${fence}`;
}

/** Renders one fenced block with a control that copies valid Markdown source. */
function MarkdownCodeBlock({ children, className, source }: MarkdownCodeBlockProps) {
  /** Writes the original code and language fence instead of rendered DOM text. */
  async function copyMarkdown(): Promise<void> {
    if (!navigator.clipboard) return;

    try {
      await navigator.clipboard.writeText(fencedMarkdown(source, className));
    } catch {
      // Clipboard permission can be denied without affecting the rendered code.
    }
  }

  return (
    <div className="markdown-code-block">
      <button
        aria-label="Copy code as Markdown"
        className="markdown-code-copy"
        onClick={() => void copyMarkdown()}
        type="button"
      >
        Copy
      </button>
      {children}
    </div>
  );
}

/** Renders inline code normally and fenced code with an asynchronously loaded Shiki grammar. */
export function HighlightedCode({ block = false, children, className, ...props }: CodeProps) {
  const language = supportedLanguage(className);
  const source = codeText(children);
  const deferredSource = useDeferredValue(source);
  const cachedHtml = language && deferredSource.length <= MAX_HIGHLIGHT_LENGTH
    ? HIGHLIGHT_CACHE.get(`${language}\0${deferredSource}`)
    : undefined;
  const [highlighted, setHighlighted] = useState<HighlightedResult | null>(null);

  useEffect(() => {
    const highlightedLanguage = language;
    if (!highlightedLanguage || deferredSource.length > MAX_HIGHLIGHT_LENGTH) return;
    if (HIGHLIGHT_CACHE.has(`${highlightedLanguage}\0${deferredSource}`)) return;

    let cancelled = false;

    void highlightCode(deferredSource, highlightedLanguage)
      .then((html) => {
        if (!cancelled) setHighlighted({ html, language: highlightedLanguage, source: deferredSource });
      })
      .catch(() => {
        if (!cancelled) setHighlighted(null);
      });

    return () => {
      cancelled = true;
    };
  }, [deferredSource, language]);

  const activeHighlight = cachedHtml ? { html: cachedHtml, language, source: deferredSource } : highlighted;

  if (!language || source.length > MAX_HIGHLIGHT_LENGTH || source !== deferredSource || !activeHighlight || activeHighlight.language !== language || activeHighlight.source !== source) {
    const code = <code className={className} {...props}>{children}</code>;
    return block ? <MarkdownCodeBlock className={className} source={source}><pre>{code}</pre></MarkdownCodeBlock> : code;
  }

  return (
    <MarkdownCodeBlock className={className} source={source}>
      <div className="highlighted-code" dangerouslySetInnerHTML={{ __html: activeHighlight.html }} />
    </MarkdownCodeBlock>
  );
}

/** Passes block context to code renderers while preserving ordinary preformatted content. */
export function MarkdownPre({ children }: ComponentPropsWithoutRef<"pre">) {
  const code = Children.toArray(children)[0];
  if (isValidElement<CodeProps>(code)) {
    return cloneElement(code, { block: true });
  }

  return <pre>{children}</pre>;
}
