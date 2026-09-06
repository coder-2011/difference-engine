import { z } from "zod";
import { defineDynamic, defineTool } from "eve/tools";
import { readRepositoryFiles } from "@/lib/github";
import { unsealGitHubAccessToken } from "../lib/github-token";

const CLIENT_CONTEXT_PREFIX = "Client context:\n";

type RepositoryContext = {
  source: string[];
};

/** Extracts the one-turn repository source that Eve rendered as model context. */
function repositoryContext(messages: ReadonlyArray<{ content: unknown; role: string }>): RepositoryContext | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== "user" || typeof message.content !== "string" || !message.content.startsWith(CLIENT_CONTEXT_PREFIX)) continue;

    try {
      const value: unknown = JSON.parse(message.content.slice(CLIENT_CONTEXT_PREFIX.length));
      if (!value || typeof value !== "object" || !("source" in value)) return undefined;
      const source = (value as { source?: unknown }).source;
      if (!Array.isArray(source) || source.length < 2 || source.length > 12 || source.some((part) => typeof part !== "string" || !part || part.length > 256)) return undefined;
      return { source };
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/** Adds stable line numbers so the agent can return links that open in the code viewer. */
function numberedText(text: string): string {
  return text.split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n");
}

export default defineDynamic({
  events: {
    "step.started": (_event, context) => {
      const repository = repositoryContext(context.messages);
      if (!repository) return null;

      return defineTool({
        description: "Read up to eight exact files from the current repository revision. Use only when the displayed diff, selected code, and conversation do not answer the question.",
        inputSchema: z.object({
          paths: z.array(z.string().min(1).max(1024)).min(1).max(8),
        }),
        async execute({ paths }, toolContext) {
          const sealedAccessToken = toolContext.session.auth.current?.attributes.githubAccessToken;
          const accessToken = await unsealGitHubAccessToken(typeof sealedAccessToken === "string" ? sealedAccessToken : undefined);
          const result = await readRepositoryFiles(repository.source, paths, accessToken);
          return {
            files: result.files.map((file) => ({ ...file, text: file.text ? numberedText(file.text) : undefined })),
            revision: result.revision,
          };
        },
      });
    },
  },
});
