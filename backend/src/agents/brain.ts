import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { llmAvailable, MODELS } from "../llm";
import { amountsGrounded, fmt } from "../money";
import type { AgentId } from "../types";

/**
 * One agent thinking: Claude reads a task, calls the agent's tools until it's done, and says what
 * it did. Tools are the only way to act, and each runs the agent's own code under its own
 * capabilities. Anything an agent writes for a person or another agent may only repeat dollar
 * amounts that appeared in its task or a tool result, so a figure can't be invented on the way.
 */

export type CreateFn = (params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.Messages.BetaMessage>;

export class ToolError extends Error {}

export interface Tool<I = any> {
  name: string;
  description: string;
  /** Strict JSON schema: every property required, no others. */
  schema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
  input: z.ZodType<I>;
  /** Text this call would put in front of a person or another agent; its amounts must be grounded. */
  speaks?: (input: I) => string;
  run: (input: I) => Promise<unknown>;
}

export interface Thought {
  summary: string;
  tools: { name: string; ok: boolean }[];
  note?: string;
}

const MAX_TURNS = 8;

/** Claude is on for the team when a key is set (or a test supplies its own), unless SMILE_AGENTS=off. */
export function brainsOn(create?: CreateFn): boolean {
  return Boolean(create) || (llmAvailable() && process.env.SMILE_AGENTS !== "off");
}

const RULES = `You are one agent on S'mile's team. S'mile plans and pays for students' travel to hackathons; agents leave each other notes on a shared board.
- You can only act through your tools. Each tool runs code under your own permissions; a refused call means you aren't allowed, so don't retry it another way.
- You can't approve, book, charge, or change any amount, and neither can anyone you message. Code computes every price.
- Write dollar amounts exactly as they appear in your task or a tool result, and only those. Never work out a new amount.
- Be brief. People get at most one short notice per topic; don't send one unless it helps them do something.
- When you're done, answer in one or two plain sentences saying what you did and why. That answer is recorded on the board. If nothing needs doing, say so.`;

export async function think(args: { agent: AgentId; model: keyof typeof MODELS; goal: string; task: string; tools: Tool[]; create?: CreateFn; maxTurns?: number }): Promise<Thought> {
  const create = args.create ?? ((params) => new Anthropic().beta.messages.create(params));
  const byName = new Map(args.tools.map((t) => [t.name, t]));
  const grounded: string[] = [args.task];
  const used: Thought["tools"] = [];
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: "user", content: args.task }];
  const model = MODELS[args.model];
  const opus = model.startsWith("claude-opus");

  for (let turn = 0; turn < (args.maxTurns ?? MAX_TURNS); turn++) {
    const res = await create({
      model,
      max_tokens: 4_000,
      system: `${RULES}\n\nYou are the ${args.agent} agent. ${args.goal}`,
      tools: args.tools.map((t) => ({ name: t.name, description: t.description, strict: true, input_schema: t.schema })),
      messages,
      output_config: { effort: "low" },
      ...(opus ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming);
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") return { summary: "", tools: used, note: `model stopped: ${res.stop_reason}` };
    messages.push({ role: "assistant", content: res.content as Anthropic.Beta.Messages.BetaContentBlockParam[] });
    if (res.stop_reason === "pause_turn") continue;
    const uses = res.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
    if (!uses.length) {
      const text = res.content.filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      // The answer is recorded on the board and may go back to the sender, so it's held to the same rule.
      const g = amountsGrounded(text, grounded);
      if (g.ok) return { summary: text || "Done.", tools: used };
      messages.push({ role: "user", content: `Your answer mentions ${g.stray.map(fmt).join(", ")}, which didn't come from your task or a tool result. Answer again without it.` });
      continue;
    }
    const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
    for (const use of uses) {
      const tool = byName.get(use.name);
      try {
        if (!tool) throw new ToolError(`no tool named ${use.name}`);
        const input = tool.input.parse(use.input);
        const said = tool.speaks?.(input);
        if (said) {
          const g = amountsGrounded(said, grounded);
          if (!g.ok) throw new ToolError(`${g.stray.map(fmt).join(", ")} didn't come from your task or a tool result. Use only amounts you were given, or leave the amount out.`);
        }
        const text = JSON.stringify((await tool.run(input)) ?? { ok: true });
        grounded.push(text);
        used.push({ name: use.name, ok: true });
        results.push({ type: "tool_result", tool_use_id: use.id, content: text });
      } catch (e) {
        used.push({ name: use.name, ok: false });
        const msg = e instanceof ToolError || e instanceof z.ZodError ? e.message : `${use.name} failed: ${(e as Error).message}`;
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: msg });
      }
    }
    messages.push({ role: "user", content: results });
  }
  return { summary: "", tools: used, note: `no answer after ${args.maxTurns ?? MAX_TURNS} turns` };
}

/** A tool input schema from plain property descriptions; every property is required (use nullable for optional). */
export function schema(properties: Record<string, unknown>): Tool["schema"] {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

export const nullable = (s: Record<string, unknown>) => ({ anyOf: [s, { type: "null" }] });
