import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent, defineDynamic } from "eve";
import { unsealEveOpenAIAccess } from "@/lib/eve-openai-credential";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex";
const OPENAI_MODEL = process.env.OPENAI_OAUTH_MODEL ?? "gpt-5.6-terra";

export default defineAgent({
  model: defineDynamic({
    events: {
      /** Builds a direct model for every tool-loop call from the user's encrypted OpenAI login. */
      "step.started": async (_event, ctx) => {
        const sealedCredential = ctx.session.auth.current?.attributes.openaiAccess;
        const credential = await unsealEveOpenAIAccess(typeof sealedCredential === "string" ? sealedCredential : undefined);
        if (!credential) throw new Error("Connect OpenAI before asking about code.");

        const openai = createOpenAI({
          apiKey: credential.accessToken,
          baseURL: CODEX_RESPONSES_URL,
          // Eve only injects safety_identifier for providers named "openai"; ChatGPT OAuth rejects it.
          name: "chatgpt",
          headers: {
            "chatgpt-account-id": credential.accountId,
            "OpenAI-Beta": "responses=experimental",
          },
        });

        return {
          model: openai.responses(OPENAI_MODEL),
          // Explicit model metadata avoids a Gateway catalog lookup for this direct provider.
          modelContextWindowTokens: 128_000,
          modelOptions: { providerOptions: { openai: { store: false } } },
        };
      },
    },
  }),
});
