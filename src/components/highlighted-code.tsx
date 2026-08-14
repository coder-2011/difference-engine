"use client";

import type { ComponentPropsWithoutRef } from "react";
import { useDeferredValue, useEffect, useState } from "react";

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
type CodeProps = ComponentPropsWithoutRef<"code">;

let highlighterPromise: ReturnType<typeof loadHighlighter> | undefined;
const languagePromises: Partial<Record<SupportedLanguage, Promise<void>>> = {};

/** Defers the Shiki engine and every grammar until Markdown contains a supported fence. */
async function loadHighlighter() {
  const [{ createBundledHighlighter }, { createOnigurumaEngine }] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/oniguruma"),
  ]);
  const createHighlighter = createBundledHighlighter({
    engine: () => createOnigurumaEngine(() => import("shiki/wasm")),
    langs: {
      bash: () => import("@shikijs/langs/bash"),
      css: () => import("@shikijs/langs/css"),
      html: () => import("@shikijs/langs/html"),
      javascript: () => import("@shikijs/langs/javascript"),
      json: () => import("@shikijs/langs/json"),
      jsx: () => import("@shikijs/langs/jsx"),
      markdown: () => import("@shikijs/langs/markdown"),
      python: () => import("@shikijs/langs/python"),
      tsx: () => import("@shikijs/langs/tsx"),
      typescript: () => import("@shikijs/langs/typescript"),
      xml: () => import("@shikijs/langs/xml"),
      yaml: () => import("@shikijs/langs/yaml"),
    },
    themes: { "github-dark": () => import("@shikijs/themes/github-dark") },
  });
  return createHighlighter({ langs: [], themes: ["github-dark"] });
}

/** Shares one lazy highlighter and defers grammar modules until a fence requests one. */
function getHighlighter() {
  highlighterPromise ??= loadHighlighter();
  return highlighterPromise;
}

/** Loads one grammar once so simultaneous code blocks do not fetch it more than once. */
function loadLanguage(highlighter: Awaited<ReturnType<typeof loadHighlighter>>, language: SupportedLanguage): Promise<void> {
  return languagePromises[language] ??= highlighter.loadLanguage(language);
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

/** Renders inline code normally and fenced code with an asynchronously loaded Shiki grammar. */
export function HighlightedCode({ children, className, ...props }: CodeProps) {
  const language = supportedLanguage(className);
  const source = codeText(children);
  const deferredSource = useDeferredValue(source);
  const [highlighted, setHighlighted] = useState("");

  useEffect(() => {
    let cancelled = false;

    if (!language || deferredSource.length > MAX_HIGHLIGHT_LENGTH) {
      setHighlighted("");
      return () => {
        cancelled = true;
      };
    }

    void getHighlighter()
      .then(async (highlighter) => {
        await loadLanguage(highlighter, language);
        return highlighter.codeToHtml(deferredSource, { lang: language, theme: "github-dark" });
      })
      .then((html) => {
        if (!cancelled) setHighlighted(html);
      })
      .catch(() => {
        if (!cancelled) setHighlighted("");
      });

    return () => {
      cancelled = true;
    };
  }, [deferredSource, language]);

  if (!language || source.length > MAX_HIGHLIGHT_LENGTH || !highlighted) {
    return <code className={className} {...props}>{children}</code>;
  }

  return <div className="highlighted-code" dangerouslySetInnerHTML={{ __html: highlighted }} />;
}

/** Removes React Markdown's wrapper so highlighted code can supply its own preformatted element. */
export function MarkdownPre({ children }: ComponentPropsWithoutRef<"pre">) {
  return <>{children}</>;
}
