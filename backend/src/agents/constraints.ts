import { z } from "zod";
import { llmAvailable, structured } from "../llm";

export const TravelConstraintsSchema = z.object({
  status: z.enum(["ready", "needs_clarification"]),
  summary: z.string().min(1).max(500),
  destination: z.string().max(200).nullable(),
  arriveBy: z.string().max(100).nullable(),
  departAfter: z.string().max(100).nullable(),
  timezone: z.string().max(80).nullable(),
  followUpQuestion: z.string().max(300).nullable(),
});
export const TravelConstraintsPlanSchema = TravelConstraintsSchema.extend({ raw: z.string().min(1).max(1_500) });

export type TravelConstraints = z.infer<typeof TravelConstraintsSchema>;

export function fallbackTravelConstraints(text: string): TravelConstraints {
  const clean = text.trim().replace(/\s+/g, " ");
  const genericPlace = /\b(the )?(airport|school|college|station|campus)\b/i.test(clean);
  const airportCode = /\b(?!(?:AM|PM|PT|ET|CT|MT|UTC)\b)[A-Z]{3}\b/.test(clean);
  const namedPlace = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Airport|College|University|School|Station|Campus)\b/.test(clean);
  const vaguePlace = genericPlace && !airportCode && !namedPlace;
  const timeReference = /\b(?:at|by|before|after)\s+\d{1,2}(?::\d{2})?\b/i.test(clean);
  const explicitTime = /\b(?:at|by|before|after)\s+(?:(?:0?\d|1[0-2])(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|(?:1[3-9]|2[0-3]):\d{2})\b/i.test(clean);
  const vagueTime = timeReference && !explicitTime;
  if (vaguePlace || vagueTime) {
    return {
      status: "needs_clarification",
      summary: clean,
      destination: null,
      arriveBy: null,
      departAfter: null,
      timezone: null,
      followUpQuestion: vaguePlace ? "Which exact airport, school, station, or campus do you mean, and on what date?" : "Is that time AM or PM, and which time zone and date should S’mile use?",
    };
  }
  return { status: "ready", summary: clean, destination: null, arriveBy: null, departAfter: null, timezone: null, followUpQuestion: null };
}

export async function reviewTravelConstraints(args: { text: string; origin?: string; eventName?: string; eventCity?: string; eventStartsAt?: string }) {
  const text = args.text.trim();
  if (!text) return { ...fallbackTravelConstraints("No additional travel requirements."), parsedBy: "rules" as const };
  if (!llmAvailable()) return { ...fallbackTravelConstraints(text), parsedBy: "rules" as const };
  try {
    const result = await structured(TravelConstraintsSchema, {
      model: "extract",
      system: "Interpret a traveler's arrival, departure, transfer, accessibility, or destination requirements. Use the supplied event context when it resolves a date or place. Never invent an airport, campus, date, AM/PM, or time zone. If one essential detail is missing or ambiguous, return needs_clarification and ask exactly one concise follow-up question. Otherwise return ready. Keep summary short, explicit, and suitable for a route-planning agent. Preserve stated local time and time zone in arriveBy or departAfter.",
      user: JSON.stringify(args),
      effort: "low",
    });
    return { ...result, parsedBy: "claude" as const };
  } catch {
    return { ...fallbackTravelConstraints(text), parsedBy: "rules" as const };
  }
}
