import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Github, GitPullRequest, LockKeyhole, Sparkles } from "lucide-react";
import { auth } from "@/auth";
import { Brand } from "@/components/brand";
import { listOpenPullRequests } from "@/lib/github";
import { getGitHubAccessToken } from "@/lib/session";
import { login, logout, openSource } from "./actions";

type HomeProps = {
  searchParams: Promise<{ error?: string }>;
};

/** Formats GitHub timestamps into a short relative label for PR cards. */
function relativeDate(value: string): string {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);

  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(value));
}

/** Renders the URL launcher and, when authenticated, the user's open PR inbox. */
export default async function Home({ searchParams }: HomeProps) {
  const [session, params, accessToken] = await Promise.all([auth(), searchParams, getGitHubAccessToken()]);
  const pullRequests = accessToken
    ? await listOpenPullRequests(accessToken).catch(() => [])
    : [];

  return (
    <main className="home-shell">
      <nav className="home-nav">
        <Brand />
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
            <div className="pull-grid">
              {pullRequests.map((pullRequest) => (
                <Link className="pull-card" href={pullRequest.viewerPath} key={`${pullRequest.repository}#${pullRequest.number}`}>
                  <div className="pull-card-top">
                    <span className="repo-name">{pullRequest.repository}</span>
                    <span className="pull-number">#{pullRequest.number}</span>
                  </div>
                  <h3>{pullRequest.title}</h3>
                  <div className="pull-card-meta">
                    <Image className="avatar" src={pullRequest.avatarUrl} alt="" width={20} height={20} />
                    <span>{pullRequest.author}</span>
                    <span className="meta-dot">·</span>
                    <span>{relativeDate(pullRequest.updatedAt)}</span>
                    {pullRequest.draft && <span className="draft-pill">Draft</span>}
                  </div>
                  <ArrowRight className="card-arrow" size={16} />
                </Link>
              ))}
            </div>
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
