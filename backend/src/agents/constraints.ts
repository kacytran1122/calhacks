import { z } from "zod";
import { llmAvailable, structured } from "../../claude";
import { haversineMiles } from "../integrations/geo";
import { AIRFARE } from "../ml/price";

export const TravelConstraintsSchema = z.object({
  status: z.enum(["ready", "needs_clarification"]),
  summary: z.string().min(1).max(500),
  destination: z.string().max(200).nullable(),
  arriveBy: z.string().max(100).nullable(),
  departAfter: z.string().max(100).nullable(),
  timezone: z.string().max(80).nullable(),
  followUpQuestion: z.string().max(300).nullable(),
});
export const TravelConstraintsPlanSchema = TravelConstraintsSchema.extend({ raw: z.string().min(1).max(5_000) });

export type TravelConstraints = z.infer<typeof TravelConstraintsSchema>;

type ReviewArgs = {
  text: string;
  origin?: string;
  eventName?: string;
  eventVenue?: string;
  eventCity?: string;
  eventStartsAt?: string;
  eventLat?: number;
  eventLon?: number;
};

const TIME_CODES = new Set(["AM", "PM", "PT", "ET", "CT", "MT", "UTC", "PST", "PDT", "CST", "CDT", "EST", "EDT", "MST", "MDT"]);

function lastTravelerAnswer(text: string) {
  return [...text.matchAll(/Traveler's answer:\s*([^\n]+)/gi)].at(-1)?.[1]?.trim() ?? "";
}

function destinationConflict(args: ReviewArgs) {
  if (args.eventLat === undefined || args.eventLon === undefined) return null;
  const answer = lastTravelerAnswer(args.text);
  const selectedEventTerms = [args.eventName, args.eventVenue, args.eventCity]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => [value.toLowerCase(), value.toLowerCase().split(/[,-]/)[0]!.trim()])
    .filter((value) => value.length >= 3);
  const answerChoosesEvent = /\b(selected event|event venue|event location)\b/i.test(answer)
    || /\b(ignore|remove|mistake|typo|do not include|don't include)\b/i.test(answer)
    || selectedEventTerms.some((term) => answer.toLowerCase().includes(term));
  if (answerChoosesEvent) return null;

  const codes = [...new Set(args.text.match(/\b[A-Z]{3}\b/g) ?? [])].filter((code) => !TIME_CODES.has(code));
  for (const code of codes) {
    const airport = AIRFARE.airports.find((candidate) => candidate.code === code);
    if (!airport) continue;
    const miles = Math.round(haversineMiles({ lat: args.eventLat, lon: args.eventLon }, airport));
    if (miles <= 120) continue;
    const eventPlace = args.eventCity || args.eventVenue || "the selected event location";
    return {
      summary: `The request names ${code}, but ${args.eventName || "the selected event"} is in ${eventPlace}.`,
      question: `${args.eventName || "The selected event"} is in ${eventPlace}, but your requirement mentions ${code}, about ${miles.toLocaleString()} miles away. Should S’mile plan to the event in ${eventPlace}, or did you select the wrong event?`,
    };
  }
  return null;
}

function enforceSelectedEvent(result: TravelConstraints, args: ReviewArgs, parsedBy: "rules" | "claude") {
  const conflict = destinationConflict(args);
  if (!conflict) return { ...result, parsedBy };
  return {
    ...result,
    status: "needs_clarification" as const,
    summary: conflict.summary,
    destination: null,
    followUpQuestion: conflict.question,
    parsedBy,
  };
}

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

export async function reviewTravelConstraints(args: ReviewArgs) {
  const text = args.text.trim();
  if (!text) return enforceSelectedEvent(fallbackTravelConstraints("No additional travel requirements."), args, "rules");
  if (!llmAvailable()) return enforceSelectedEvent(fallbackTravelConstraints(text), args, "rules");
  try {
    const result = await structured(TravelConstraintsSchema, {
      model: "extract",
      system: "Interpret a traveler's arrival, departure, transfer, accessibility, or destination requirements. Use the supplied event context when it resolves a date or place. Never invent an airport, campus, date, AM/PM, or time zone. If one essential detail is missing or ambiguous, return needs_clarification and ask exactly one concise follow-up question. Otherwise return ready. Keep summary short, explicit, and suitable for a route-planning agent. Preserve stated local time and time zone in arriveBy or departAfter.",
      user: JSON.stringify(args),
      effort: "low",
    });
    return enforceSelectedEvent(result, args, "claude");
  } catch {
    return enforceSelectedEvent(fallbackTravelConstraints(text), args, "rules");
  }
}
