<h1 align="center">diffs</h1>

<p align="center">A calmer way to review code.</p>

<p align="center">
  <a href="assets/diffs-launch.mp4">
    <img src="assets/diffs-launch.gif" alt="A short walkthrough of Diffs" width="960">
  </a>
</p>

Diffs is a focused viewer for GitHub pull requests, comparisons, and commits. It keeps the repository tree, pull request context, and the actual patch together, so reviewing a change feels less like navigating a website and more like reading code.

Try it at [diffs.naman.world](https://diffs.naman.world).

## What it does

- Opens any public GitHub diff from its URL.
- Uses GitHub sign-in for private repositories and a personal list of open pull requests that you authored, were assigned, or were asked to review.
- Renders large patches with a navigable file tree and split or unified views.
- Shows the pull request description beside the code it explains.
- Lets you select code and ask a question without leaving the diff.

The diff and tree views are built with [`@pierre/diffs`](https://www.npmjs.com/package/@pierre/diffs) and [`@pierre/trees`](https://www.npmjs.com/package/@pierre/trees).

## Run it locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

Create a GitHub OAuth app, fill in `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, and `AUTH_SECRET`, then add an `AI_GATEWAY_API_KEY` if you want code questions to return live answers. The default callback URL is:

```text
http://localhost:3000/api/auth/callback/github
```

Use `npm run typecheck`, `npm run lint`, and `npm run build` before deploying.

## Why it exists

Code review is already difficult. The interface should not add to it. Diffs keeps the useful parts close, removes the rest, and gives the change enough room to be understood.
