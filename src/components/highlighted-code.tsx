"use client";

import type { ComponentPropsWithoutRef } from "react";
import { Children, cloneElement, isValidElement, useDeferredValue, useEffect, useState } from "react";

const LANGUAGE_ALIASES = {
  bash: "bash",
  css: "css",
  html: "html",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  markdown: "markdown",
  md: "markdown",
  python: "python",
  py: "python",
  shell: "bash",
  sh: "bash",
  ts: "typescript",
  tsx: "tsx",
  typescript: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
} as const;

const MAX_HIGHLIGHT_LENGTH = 20_000;

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

let highlighterPromise: ReturnType<typeof loadHighlighter> | undefined;

/** Loads only the grammars that commonly appear in a pull-request discussion. */
async function loadHighlighter() {
  const [
    { createHighlighterCore },
    { createOnigurumaEngine },
    { default: githubDark },
    { default: bash },
    { default: css },
    { default: html },
    { default: javascript },
    { default: json },
    { default: jsx },
    { default: markdown },
    { default: python },
    { default: tsx },
    { default: typescript },
    { default: xml },
    { default: yaml },
  ] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/oniguruma"),
    import("@shikijs/themes/github-dark"),
    import("@shikijs/langs/bash"),
    import("@shikijs/langs/css"),
    import("@shikijs/langs/html"),
    import("@shikijs/langs/javascript"),
    import("@shikijs/langs/json"),
    import("@shikijs/langs/jsx"),
    import("@shikijs/langs/markdown"),
    import("@shikijs/langs/python"),
    import("@shikijs/langs/tsx"),
    import("@shikijs/langs/typescript"),
    import("@shikijs/langs/xml"),
    import("@shikijs/langs/yaml"),
  ]);

  return createHighlighterCore({
    engine: createOnigurumaEngine(() => import("shiki/wasm")),
    langs: [bash, css, html, javascript, json, jsx, markdown, python, tsx, typescript, xml, yaml],
    themes: [githubDark],
  });
}

/** Shares one lazy highlighter across all Markdown code blocks in the browser. */
function getHighlighter() {
  highlighterPromise ??= loadHighlighter();
  return highlighterPromise;
}

/** Maps a fenced-Markdown class name to a bundled grammar, if one exists. */
function supportedLanguage(className?: string): SupportedLanguage | null {
  const match = className?.match(/language-([^\s]+)/)?.[1]?.toLowerCase();
  if (!match) return null;

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
        Copy MD
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
  const [highlighted, setHighlighted] = useState<HighlightedResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    const highlightedLanguage = language;

    if (!highlightedLanguage || deferredSource.length > MAX_HIGHLIGHT_LENGTH) {
      setHighlighted(null);
      return () => {
        cancelled = true;
      };
    }

    void getHighlighter()
      .then((highlighter) => highlighter.codeToHtml(deferredSource, { lang: highlightedLanguage, theme: "github-dark" }))
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

  if (!language || source.length > MAX_HIGHLIGHT_LENGTH || source !== deferredSource || !highlighted || highlighted.language !== language || highlighted.source !== source) {
    const code = <code className={className} {...props}>{children}</code>;
    return block ? <MarkdownCodeBlock className={className} source={source}><pre>{code}</pre></MarkdownCodeBlock> : code;
  }

  return (
    <MarkdownCodeBlock className={className} source={source}>
      <div className="highlighted-code" dangerouslySetInnerHTML={{ __html: highlighted.html }} />
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
