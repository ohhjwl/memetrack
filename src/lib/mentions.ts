import { createServerFn } from "@tanstack/react-start";

export type Mention = { handle: string; text: string; url: string };

const cache = new Map<string, { at: number; rows: Mention[] }>();

function parseMentions(text: string): Mention[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const handle = String(row.handle ?? "").replace(/^@/, "").slice(0, 40);
      const body = String(row.text ?? "").replace(/\s+/g, " ").trim().slice(0, 220);
      const url = String(row.url ?? "");
      if (!handle || !body) return [];
      if (!url.startsWith("https://x.com/") && !url.startsWith("https://twitter.com/")) return [];
      return [{ handle, text: body, url }];
    })
    .slice(0, 5);
}

export const loadMentions = createServerFn({ method: "POST" })
  .validator((input: { query: string }) => {
    const query = String(input?.query ?? "").replace(/[\r\n]/g, " ").trim().slice(0, 80);
    if (query.length < 2) throw new Error("Query too short");
    return { query };
  })
  .handler(async ({ data }) => {
    const hit = cache.get(data.query);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return { ok: true as const, rows: hit.rows };
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: false as const, error: "X search is unavailable" };
    const res = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "grok-4.5",
        max_output_tokens: 700,
        max_tool_calls: 1,
        input: [{ role: "user", content: `Search X once for the latest posts matching: ${data.query}. Reply with ONLY a JSON array of up to 5 objects {"handle","text","url"}. Keep text under 160 characters. No markdown.` }],
        tools: [{ type: "x_search" }],
      }),
    });
    if (!res.ok) return { ok: false as const, error: "X search failed" };
    const body = (await res.json()) as { output?: { type?: string; content?: { type?: string; text?: string }[] }[] };
    const text = body.output?.filter((item) => item.type === "message").flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text" && part.text).map((part) => part.text).join("\n") ?? "";
    const rows = parseMentions(text);
    cache.set(data.query, { at: Date.now(), rows });
    return { ok: true as const, rows };
  });
