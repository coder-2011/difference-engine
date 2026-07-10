import Image from "next/image";
import { ArrowRight, Github, GitPullRequest, LockKeyhole, Sparkles } from "lucide-react";
import { auth } from "@/auth";
import { Brand } from "@/components/brand";
import { OpenAIConnection } from "@/components/openai-connection";
import { PullRequestList } from "@/components/pull-request-list";
import { listOpenPullRequests } from "@/lib/github";
import { getOpenAIConnection } from "@/lib/openai-auth";
import { getGitHubAccessToken } from "@/lib/session";
import { login, logout, openSource } from "./actions";

type HomeProps = {
  searchParams: Promise<{ error?: string }>;
};

/** Renders the URL launcher and, when authenticated, the user's open PR inbox. */
export default async function Home({ searchParams }: HomeProps) {
  const [session, params, accessToken, openAIConnection] = await Promise.all([
    auth(),
    searchParams,
    getGitHubAccessToken(),
    getOpenAIConnection(),
  ]);
  const pullRequests = accessToken
    ? await listOpenPullRequests(accessToken).catch(() => [])
    : [];

  return (
    <main className="home-shell">
      <nav className="home-nav">
        <Brand />
        <div className="nav-auth-actions">
          <OpenAIConnection initialConnection={openAIConnection} />
          {session?.user ? (
            <div className="account-cluster">
              {session.user.image && (
                <Image className="avatar" src={session.user.image} alt="" width={26} height={26} />
              )}
              <span className="account-name">{session.user.name}</span>
              <form action={logout}><button className="quiet-button">Sign out</button></form>
            </div>
          ) : (
            <form action={login}>
              <button className="github-button"><Github size={15} /> Sign in with GitHub</button>
            </form>
          )}
        </div>
      </nav>

      <section className="hero">
        <div className="eyebrow"><Sparkles size={13} /> A calmer code review</div>
        <h1>Read the change.<br /><span>Understand the intent.</span></h1>
        <p className="hero-copy">
          A fast, beautiful diff viewer for GitHub pull requests, comparisons, and commits.
        </p>

        <form className="url-form" action={openSource}>
          <Github size={17} aria-hidden="true" />
          <input
            name="url"
            type="url"
            required
            aria-label="GitHub URL"
            placeholder="https://github.com/org/repo/pull/123"
          />
          <button aria-label="Open diff"><ArrowRight size={18} /></button>
        </form>
        {params.error && <p className="form-error">{params.error}</p>}

        <div className="replace-hint">
          <code><span>github</span>.com/org/repo/pull/123</code>
          <ArrowRight size={13} />
          <code><strong>diffs.naman.world</strong>/org/repo/pull/123</code>
        </div>
      </section>

      {session?.user ? (
        <section className="pull-section">
          <div className="section-heading">
            <div>
              <span className="section-kicker">Your work</span>
              <h2>Open pull requests</h2>
            </div>
            <span className="count-pill">{pullRequests.length}</span>
          </div>

          {pullRequests.length ? (
            <PullRequestList pullRequests={pullRequests} />
          ) : (
            <div className="empty-state">
              <GitPullRequest size={22} />
              <div><strong>No open pull requests</strong><span>Your authored PRs will appear here.</span></div>
            </div>
          )}
        </section>
      ) : (
        <section className="login-note">
          <LockKeyhole size={18} />
          <div>
            <strong>Your public and private pull requests, in one place.</strong>
            <span>Sign in to see every open PR you authored. Diffs uses your GitHub access only for reads.</span>
          </div>
        </section>
      )}

      <footer className="home-footer">
        Built with <a href="https://diffs.com">Diffs</a> and <a href="https://trees.software">Trees</a> by Pierre.
      </footer>
    </main>
  );
}
