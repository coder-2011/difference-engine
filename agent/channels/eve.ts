import { localDev, type AuthFn, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { getGitHubSession } from "../lib/github-session";
import { sealGitHubAccessToken } from "../lib/github-token";

/** Authenticates browser chat requests with the existing GitHub Auth.js session. */
const githubSession: AuthFn<Request> = async (request) => {
  const session = await getGitHubSession(request);
  if (!session) return null;

  return {
    attributes: { githubAccessToken: await sealGitHubAccessToken(session.accessToken) },
    authenticator: "oidc",
    principalId: session.userId,
    principalType: "user",
  };
};

export default eveChannel({
  auth: [githubSession, vercelOidc(), localDev()],
});
