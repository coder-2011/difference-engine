import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { ArrowLeft, ArrowUpRight, FileCode2, GitCompareArrows } from "lucide-react";
import { Brand } from "@/components/brand";
import { DiffViewer } from "@/components/diff-viewer";
import { OpenAIConnection } from "@/components/openai-connection";
import { getDiffDocument, GitHubError } from "@/lib/github";
import { isOpenAIConnected } from "@/lib/openai-auth";
import { getGitHubAccessToken } from "@/lib/session";

type DiffPageProps = {
  params: Promise<{ source: string[] }>;
};

/** Loads the GitHub title into the browser tab without fetching the raw patch. */
export async function generateMetadata({ params }: DiffPageProps): Promise<Metadata> {
  const [{ source }, accessToken] = await Promise.all([params, getGitHubAccessToken()]);

  try {
    const document = await getDiffDocument(source, accessToken);
    return { title: document.title };
  } catch {
    return { title: "Diff" };
  }
}

/** Renders GitHub metadata above the virtualized, interactive diff workspace. */
export default async function DiffPage({ params }: DiffPageProps) {
  const [{ source }, accessToken, openAIConnected] = await Promise.all([
    params,
    getGitHubAccessToken(),
    isOpenAIConnected(),
  ]);

  let document;

  try {
    document = await getDiffDocument(source, accessToken);
  } catch (error) {
    if (error instanceof GitHubError && error.status < 500) notFound();
    throw error;
  }

  return (
    <main className="diff-page">
      <header className="diff-nav">
        <div className="diff-nav-left">
          <Brand compact />
          <span className="nav-separator" />
          <Link className="back-link" href="/"><ArrowLeft size={14} /> Pull requests</Link>
        </div>
        <div className="diff-nav-actions">
          <OpenAIConnection compact initiallyConnected={openAIConnected} />
          <a className="source-link" href={document.sourceUrl} target="_blank" rel="noreferrer">
            Open on GitHub <ArrowUpRight size={14} />
          </a>
        </div>
      </header>

      <section className="pr-header">
        <div className="pr-repo"><FileCode2 size={14} /> {document.repository}</div>
        <h1>{document.title}</h1>
        <div className="pr-byline">
          {document.avatarUrl && <Image className="avatar" src={document.avatarUrl} alt="" width={22} height={22} />}
          <strong>{document.author}</strong>
          {document.baseLabel && document.headLabel && (
            <span className="branch-pair"><GitCompareArrows size={13} /> {document.baseLabel} <span>←</span> {document.headLabel}</span>
          )}
        </div>

        {document.description && (
          <details className="pr-description" open>
            <summary>Pull request description</summary>
            <div className="markdown-body"><ReactMarkdown skipHtml>{document.description}</ReactMarkdown></div>
          </details>
        )}
      </section>

      <DiffViewer
        additions={document.additions}
        changedFiles={document.changedFiles}
        deletions={document.deletions}
        openAIConnected={openAIConnected}
        source={source}
      />
    </main>
  );
}
