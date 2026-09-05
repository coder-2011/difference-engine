import { z } from "zod";
import { isRecord, isString } from "@/lib/json";

export type StructuredTextFormat = {
  format: {
    name: string;
    schema: Record<string, unknown>;
    strict: true;
    type: "json_schema";
  };
};

/** Builds the strict Responses API text.format payload for one zod schema. */
export function structuredTextFormat(name: string, schema: z.ZodType): StructuredTextFormat {
  const jsonSchema: Record<string, unknown> = { ...z.toJSONSchema(schema) };
  // The Responses API expects a bare schema without the draft identifier.
  delete jsonSchema.$schema;
  return { format: { name, schema: jsonSchema, strict: true, type: "json_schema" } };
}

/** Validates one structured model reply, or returns null when the text is not the expected JSON. */
export function parseStructured<Schema extends z.ZodType>(schema: Schema, text: string): z.output<Schema> | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Collects the completed output text from one streamed, tool-free Responses call. */
export async function readStreamedOutputText(response: Response): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += value ?? "";
    if (done) buffer += "\n\n";
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      const data = block.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trimStart();
      if (!data || data === "[DONE]") continue;

      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (!isRecord(event)) continue;
      if (event.type === "response.output_text.delta" && isString(event.delta)) text += event.delta;
      if (event.type === "error" || event.type === "response.failed") return "";
    }

    if (done) break;
  }

  return text.trim();
}
