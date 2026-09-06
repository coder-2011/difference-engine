import { localDev, type AuthFn, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { unsealEveOpenAIAccess } from "@/lib/eve-openai-credential";
import { getGitHubSession } from "../lib/github-session";
import { sealGitHubAccessToken } from "../lib/github-token";

const OPENAI_ACCESS_HEADER = "x-diffs-openai-access";

/** Authenticates browser chat requests with the existing GitHub and OpenAI sessions. */
const githubSession: AuthFn<Request> = async (request) => {
  const session = await getGitHubSession(request);
  const openaiAccess = request.headers.get(OPENAI_ACCESS_HEADER);
  const credential = await unsealEveOpenAIAccess(openaiAccess ?? undefined);
  if (!session || !credential || !openaiAccess) return null;

  return {
    attributes: {
      githubAccessToken: await sealGitHubAccessToken(session.accessToken),
      openaiAccess,
    },
    authenticator: "oidc",
    principalId: session.userId,
    principalType: "user",
  };
};

export default eveChannel({
  auth: [githubSession, vercelOidc(), localDev()],
});
