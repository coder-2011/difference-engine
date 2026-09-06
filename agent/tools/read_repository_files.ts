import { z } from "zod";
import { defineDynamic, defineTool } from "eve/tools";
import { listRepositoryPaths, readRepositoryDiff, readRepositoryFile, readRepositoryFiles, searchRepositoryText } from "@/lib/github";
import { unsealGitHubAccessToken } from "../lib/github-token";

const CLIENT_CONTEXT_PREFIX = "Client context:\n";
const REVISION_PATTERN = /^[0-9a-f]{40,64}$/i;

type RepositoryContext = {
  baseRevision?: string;
  revision?: string;
  source: string[];
};

/** Extracts the one-turn repository source and immutable revisions that Eve rendered as model context. */
function repositoryContext(messages: ReadonlyArray<{ content: unknown; role: string }>): RepositoryContext | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== "user" || typeof message.content !== "string" || !message.content.startsWith(CLIENT_CONTEXT_PREFIX)) continue;

    try {
      const value: unknown = JSON.parse(message.content.slice(CLIENT_CONTEXT_PREFIX.length));
      if (!value || typeof value !== "object" || !("source" in value)) return undefined;
      const source = (value as { source?: unknown }).source;
      if (!Array.isArray(source) || source.length < 2 || source.length > 12 || source.some((part) => typeof part !== "string" || !part || part.length > 256)) return undefined;
      const revision = (value as { revision?: unknown }).revision;
      const baseRevision = (value as { baseRevision?: unknown }).baseRevision;
      return {
        baseRevision: typeof baseRevision === "string" && REVISION_PATTERN.test(baseRevision) ? baseRevision : undefined,
        revision: typeof revision === "string" && REVISION_PATTERN.test(revision) ? revision : undefined,
        source,
      };
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/** Adds stable source line numbers so the agent can return links that open in the code viewer. */
function numberedText(text: string, startLine = 1): string {
  return text.split("\n").map((line, index) => `${startLine + index}: ${line}`).join("\n");
}

/** Restores the GitHub access token only inside one authenticated, read-only tool call. */
async function repositoryAccessToken(attributes: Record<string, unknown> | undefined): Promise<string | undefined> {
  const sealedAccessToken = attributes?.githubAccessToken;
  return unsealGitHubAccessToken(typeof sealedAccessToken === "string" ? sealedAccessToken : undefined);
}

export default defineDynamic({
  events: {
    "step.started": (_event, context) => {
      const repository = repositoryContext(context.messages);
      if (!repository) return null;

      const repositoryTools = {
        list_repository_paths: defineTool({
          description: "List up to 250 tracked paths from the current repository revision. Filter paths with query and follow nextCursor to browse every matching path.",
          inputSchema: z.object({
            cursor: z.number().int().min(0).default(0),
            query: z.string().max(256).optional(),
          }),
          async execute({ cursor, query }, toolContext) {
            return listRepositoryPaths(repository.source, cursor, query, await repositoryAccessToken(toolContext.session.auth.current?.attributes), repository.revision);
          },
        }),
        search_repository_text: defineTool({
          description: "Search one exact repository revision for text or a symbol. Follow nextCursor until matches are found or it is absent, then read matching files for complete context.",
          inputSchema: z.object({
            cursor: z.number().int().min(0).default(0),
            query: z.string().min(1).max(256),
          }),
          async execute({ cursor, query }, toolContext) {
            return searchRepositoryText(repository.source, query, cursor, await repositoryAccessToken(toolContext.session.auth.current?.attributes), repository.revision);
          },
        }),
        read_repository_file: defineTool({
          description: "Read one exact text file from the current repository revision. Start at offset 0 and follow nextOffset to inspect all of a large file.",
          inputSchema: z.object({
            offset: z.number().int().min(0).default(0),
            path: z.string().min(1).max(1024),
          }),
          async execute({ offset, path }, toolContext) {
            const result = await readRepositoryFile(repository.source, path, offset, await repositoryAccessToken(toolContext.session.auth.current?.attributes), repository.revision);
            return { ...result, text: result.text ? numberedText(result.text, result.startLine) : undefined };
          },
        }),
        read_repository_files: defineTool({
          description: "Read up to eight exact small text files from the current repository revision. Use read_repository_file for a large file or later section.",
          inputSchema: z.object({
            paths: z.array(z.string().min(1).max(1024)).min(1).max(8),
          }),
          async execute({ paths }, toolContext) {
            const result = await readRepositoryFiles(repository.source, paths, await repositoryAccessToken(toolContext.session.auth.current?.attributes), repository.revision);
            return {
              files: result.files.map((file) => ({ ...file, text: file.text ? numberedText(file.text) : undefined })),
              revision: result.revision,
            };
          },
        }),
      };
      const hasDiff = repository.source[2] === "pull" || repository.source[2] === "compare" || repository.source[2] === "commit";
      if (!hasDiff) return repositoryTools;

      return {
        ...repositoryTools,
        read_repository_diff: defineTool({
          description: "Read the complete unified diff for this review in pages. Start at offset 0 and follow nextOffset until it is absent.",
          inputSchema: z.object({
            offset: z.number().int().min(0).default(0),
          }),
          async execute({ offset }, toolContext) {
            return readRepositoryDiff(repository.source, offset, await repositoryAccessToken(toolContext.session.auth.current?.attributes), repository.baseRevision, repository.revision);
          },
        }),
      };
    },
  },
});
