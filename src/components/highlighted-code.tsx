"use client";

import type { ComponentPropsWithoutRef } from "react";
import { Children, cloneElement, isValidElement, useDeferredValue, useEffect, useState } from "react";

const LANGUAGE_ALIASES = {
  bash: "bash",
  c: "c",
  "c++": "cpp",
  cpp: "cpp",
  css: "css",
  cu: "cpp",
  cuh: "cpp",
  cuda: "cpp",
  go: "go",
  html: "html",
  java: "java",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  markdown: "markdown",
  md: "markdown",
  python: "python",
  py: "python",
  rs: "rust",
  rust: "rust",
  shell: "bash",
  sh: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "tsx",
  typescript: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
} as const;

const MAX_HIGHLIGHT_LENGTH = 20_000;
const HIGHLIGHT_CACHE = new Map<string, string>();
const MAX_CACHE_ENTRIES = 500;

type SupportedLanguage = typeof LANGUAGE_ALIASES[keyof typeof LANGUAGE_ALIASES];
type CodeProps = ComponentPropsWithoutRef<"code"> & {
  block?: boolean;
};
type HighlightedResult = {
  html: string;
  language: SupportedLanguage;
  source: string;
};
type MarkdownCodeBlockProps = {
  children: React.ReactNode;
  className?: string;
  source: string;
};

/** Highlights one block through the same Pierre WASM singleton and theme as the diff viewer. */
async function highlightCode(source: string, language: SupportedLanguage): Promise<string> {
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

/** Maps a fenced-Markdown class name to a bundled grammar, if one exists. */
function supportedLanguage(className?: string): SupportedLanguage | null {
  const match = className?.match(/language-([^\s]+)/)?.[1]?.toLowerCase();
  if (!match) return null;

  // SAFETY: `match` is only used to index a static grammar alias table and missing keys return null.
  return LANGUAGE_ALIASES[match as keyof typeof LANGUAGE_ALIASES] ?? null;
}

/** Converts React's Markdown children into the exact source sent to the highlighter. */
function codeText(children: CodeProps["children"]): string {
  return String(children).replace(/\n$/, "");
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
