import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export const MODELS = {
  reason: "claude-opus-5-5",
  extract: "claude-haiku-5-5",
  concierge: "claude-opus-5-5",
} as const;

export function llmAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  client ??= new Anthropic();
  return client;
}

export class LlmUnavailable extends Error {}

export async function structured<S extends z.ZodType>(
  schema: S,
  opts: { model: keyof typeof MODELS; system: string; user: string; effort?: "low" | "medium" | "high" },
): Promise<z.infer<S>> {
  if (!llmAvailable()) throw new LlmUnavailable("ANTHROPIC_API_KEY is not set");
  const model = MODELS[opts.model];
  const params = {
    model,
    max_tokens: 16000,
    system: opts.system,
    messages: [{ role: "user" as const, content: opts.user }],
    output_config: { format: zodOutputFormat(schema), effort: opts.effort ?? "medium" },
  };
  const res =
    opts.model === "reason"
      ? await getClient().beta.messages.parse({
          ...params,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        } as Parameters<Anthropic["beta"]["messages"]["parse"]>[0])
      : await getClient().messages.parse(params);
  if (res.stop_reason === "refusal") throw new Error(`model declined (${res.stop_details?.category ?? "unknown"})`);
  if (res.stop_reason === "max_tokens") throw new Error("model output was cut off");
  const parsed = (res as { parsed_output?: unknown }).parsed_output;
  const check = schema.safeParse(parsed);
  if (!check.success) throw new Error(`model output failed validation: ${check.error.message}`);
  return check.data;
}
