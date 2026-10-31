<h1 align="center">diffs</h1>

<p align="center">A calmer way to review code.</p>

Diffs is a focused viewer for GitHub pull requests, comparisons, and commits. It keeps the repository tree, pull request context, and the actual patch together, so reviewing a change feels less like navigating a website and more like reading code.

Try it at [diffs.naman.world](https://diffs.naman.world).

## What it does

- Opens any public GitHub diff from its URL.
- Uses GitHub sign-in for private repositories and a personal list of open pull requests that you authored, were assigned, or were asked to review.
- Renders large patches with a navigable file tree and split or unified views.
- Shows the pull request description beside the code it explains.
- Lets you connect OpenAI separately, then ask about selected code with the repository tree, full diff, and changed-file contents in context.

The diff and tree views are built with [`@pierre/diffs`](https://www.npmjs.com/package/@pierre/diffs) and [`@pierre/trees`](https://www.npmjs.com/package/@pierre/trees).

## Run it locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

Create a GitHub OAuth app, then fill in `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, and `AUTH_SECRET`. The default callback URL is:

```text
http://localhost:3000/api/auth/callback/github
```

Code questions use a separate OpenAI device authorization. The user completes the authorization on OpenAI, while Diffs stores only encrypted, HttpOnly session material. Without that connection, question controls and the question API remain unavailable.

Use `npm run typecheck`, `npm run lint`, and `npm run build` before deploying.

## GitHub webhook updates

Webhooks are optional. Without them, open PRs continue to check GitHub every 30 seconds while visible. To receive updates immediately:

1. Create a [Pusher Channels](https://pusher.com/channels/) app and set `PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_SECRET`, and `PUSHER_CLUSTER` in the deployment environment. Keep the app secret on the server.
2. Register a separate [GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) with its webhook URL set to `https://<your-host>/api/github-webhook`. Generate a webhook secret and set the same value as `GITHUB_WEBHOOK_SECRET` in the deployment environment. The existing GitHub OAuth app remains responsible for sign-in.
3. Give the GitHub App read permissions for Actions, Checks, Commit statuses, Contents, Issues, and Pull requests. Subscribe to `check_run`, `check_suite`, `commit_comment`, `create`, `delete`, `issue_comment`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, `push`, `status`, and `workflow_run`.
4. Install the GitHub App on the repositories that should send updates. A repository or organization administrator must approve an installation on repositories you do not own.

GitHub signs each delivery, and Diffs forwards only an empty change notification over a private repository channel. A subscriber must first prove it can read the PR using its own GitHub session; the actual PR data is fetched separately using that session. The 30-second conditional check remains active for repositories without the app and for missed or failed deliveries. GitHub does not automatically retry failed deliveries, and deliveries above 4 MiB fall back to the conditional check.

## Why it exists

Code review is already difficult. The interface should not add to it. Diffs keeps the useful parts close, removes the rest, and gives the change enough room to be understood.
