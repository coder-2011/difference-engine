import { NextResponse } from "next/server";

const MAX_SELECTION_LENGTH = 12_000;
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";

/** Gives a useful local answer when the configured model is unavailable. */
function fallbackAnswer(selection: string): string {
  const assignment = selection.match(/\b(?:const|let|var)\s+(\w+)\s*=\s*([^;\n]+)/);

  if (assignment) {
    return `The variable \`${assignment[1]}\` is assigned \`${assignment[2].trim()}\`.`;
  }

  const lineCount = selection.split("\n").length;
  return `This selection contains ${lineCount} line${lineCount === 1 ? "" : "s"} of code. Its exact behavior depends on the surrounding code.`;
}

/** Answers a question about selected code through Vercel AI Gateway. */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { question?: unknown; selection?: unknown };
  const question = typeof body.question === "string" ? body.question.trim().slice(0, 1_000) : "";
  const selection = typeof body.selection === "string" ? body.selection.slice(0, MAX_SELECTION_LENGTH) : "";

  if (!question || !selection) {
    return NextResponse.json({ error: "Select code and enter a question." }, { status: 400 });
  }

  const token = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN;

  if (!token) {
    return NextResponse.json({ answer: fallbackAnswer(selection) });
  }

  try {
    const response = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL ?? "openai/gpt-5.4-mini",
        messages: [
          {
            role: "system",
            content: "Answer the question about the selected code clearly and concisely. Use Markdown when it improves readability.",
          },
          {
            role: "user",
            content: `Question: ${question}\n\nSelected code:\n\`\`\`\n${selection}\n\`\`\``,
          },
        ],
      }),
    });
    const result = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const answer = result.choices?.[0]?.message?.content?.trim();

    return NextResponse.json({ answer: answer || fallbackAnswer(selection) });
  } catch {
    return NextResponse.json({ answer: fallbackAnswer(selection) });
  }
}
