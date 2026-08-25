import Image from "next/image";
import { Github, GitPullRequest, LockKeyhole } from "lucide-react";
import { auth } from "@/auth";
import { Brand } from "@/components/brand";
import { OpenAIConnection } from "@/components/openai-connection";
import { PullRequestList } from "@/components/pull-request-list";
import { UrlForm } from "@/components/url-form";
import { isGitHubConnected, listOpenPullRequests, listRecentPullRequests } from "@/lib/github";
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
  const githubConnected = await isGitHubConnected(accessToken);
  const githubToken = githubConnected ? accessToken : undefined;
  const [pullRequests, recentPullRequests] = githubToken
    ? await Promise.all([
        listOpenPullRequests(githubToken).catch(() => []),
        listRecentPullRequests(githubToken).catch(() => []),
      ])
    : [[], []];

  return (
    <main className="home-shell">
      <nav className="home-nav">
        <Brand />
        <div className="nav-auth-actions">
          <OpenAIConnection initiallyConnected={openAIConnected} />
          {session?.user && githubConnected ? (
            <div className="account-cluster">
              {session.user.image && (
                <Image className="avatar" src={session.user.image} alt="" width={26} height={26} />
              )}
              <span className="account-name">{session.user.name}</span>
              <form action={logout}><button className="quiet-button">Sign out</button></form>
            </div>
          ) : (
            <form action={login}>
              <button className="github-button">
                <Github size={15} />
                {session?.user ? "GitHub signed out · Sign in" : "Sign in with GitHub"}
              </button>
            </form>
          )}
        </div>
      </nav>

      <section className="hero">
        <UrlForm action={openSource} />
        {params.error && <p className="form-error">{params.error}</p>}
      </section>

      {session?.user && githubConnected ? (
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
            <span>Sign in to see open and recent PRs that involve you. Comments and PR actions you choose go directly to GitHub.</span>
          </div>
        </section>
      )}

    </main>
  );
}
