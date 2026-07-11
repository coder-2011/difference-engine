import Image from "next/image";
import { CornerDownLeft, Github, GitPullRequest, LockKeyhole } from "lucide-react";
import { auth } from "@/auth";
import { Brand } from "@/components/brand";
import { OpenAIConnection } from "@/components/openai-connection";
import { PullRequestList } from "@/components/pull-request-list";
import { listOpenPullRequests, listRecentPullRequests } from "@/lib/github";
import { isOpenAIConnected } from "@/lib/openai-auth";
import { getGitHubAccessToken } from "@/lib/session";
import { login, logout, openSource } from "./actions";

type HomeProps = {
  searchParams: Promise<{ error?: string }>;
};

/** Renders the URL launcher and, when authenticated, the user's active and recent PR inbox. */
export default async function Home({ searchParams }: HomeProps) {
  const [session, params, accessToken, openAIConnected] = await Promise.all([
    auth(),
    searchParams,
    getGitHubAccessToken(),
    isOpenAIConnected(),
  ]);
  const [pullRequests, recentPullRequests] = accessToken
    ? await Promise.all([
        listOpenPullRequests(accessToken).catch(() => []),
        listRecentPullRequests(accessToken).catch(() => []),
      ])
    : [[], []];

  return (
    <main className="home-shell">
      <nav className="home-nav">
        <Brand />
        <div className="nav-auth-actions">
          <OpenAIConnection initiallyConnected={openAIConnected} />
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
        <form className="url-form" action={openSource}>
          <span className="url-prompt" aria-hidden="true">›</span>
          <input
            name="url"
            type="text"
            required
            aria-label="GitHub URL or pull request request"
            placeholder="paste a github url or type what you want open"
          />
          <button aria-label="Open diff"><CornerDownLeft size={13} /><span>to open</span></button>
        </form>
        {params.error && <p className="form-error">{params.error}</p>}

        <div className="replace-hint" aria-label="Replace github.com with diffs.naman.world">
          <code className="removed"><b>−</b><span className="path">github.com/<strong>org/repo/pull/123</strong></span></code>
          <code className="added"><b>+</b><span className="path">diffs.naman.world/<strong>org/repo/pull/123</strong></span></code>
        </div>
      </section>

      {session?.user ? (
        <>
          <section className="pull-section">
            <div className="section-heading">
              <h2>Open pull requests</h2>
              <span className="count-pill">{pullRequests.length}</span>
            </div>

            {pullRequests.length ? (
              <PullRequestList pullRequests={pullRequests} />
            ) : (
              <div className="empty-state">
                <GitPullRequest size={22} />
                <div><strong>No open pull requests</strong><span>Your authored and referenced PRs will appear here.</span></div>
              </div>
            )}
          </section>

          {recentPullRequests.length > 0 && (
            <section className="pull-section resolved-section">
              <div className="section-heading">
                <h2>Recently merged / closed</h2>
                <span className="count-pill">{recentPullRequests.length}</span>
              </div>
              <PullRequestList pullRequests={recentPullRequests} variant="resolved" />
            </section>
          )}
        </>
      ) : (
        <section className="login-note">
          <LockKeyhole size={18} />
          <div>
            <strong>Your public and private pull requests, in one place.</strong>
            <span>Sign in to see open and recent PRs that involve you. Diffs uses your GitHub access only for reads.</span>
          </div>
        </section>
      )}

    </main>
  );
}
