import { reviewTravelConstraints, type TravelConstraints } from "./constraints";

export interface ChatTravelMemory {
  zip?: string;
  url?: string;
  includeSelfDrive?: boolean;
  travelerBudgetCents?: number;
  maxDistanceMiles?: number;
  requirements?: string;
  ownMessages?: string[];
  clarificationQuestion?: string;
  preferenceQuestion?: string;
  preferenceIssues?: Partial<Record<"driving" | "budget" | "distance", string>>;
}

export type ChatTravelContext = {
  origin?: string;
  eventName?: string;
  eventVenue?: string;
  eventCity?: string;
  eventStartsAt?: string;
  eventLat?: number;
  eventLon?: number;
};

const timingOrAccommodation = /\b(?:arriv\w*|depart\w*|leav(?:e|ing)|(?:be|back)\s+at|by\s+\d|(?:after|before|at)\s+\d|wheelchair|step[ -]?free|accessib\w*|accommodat\w*)\b/i;
const noDrive = /\b(?:(?:no|without|not)\s+(?:self[ -]?)?driv\w*|(?:i\s+)?(?:can[’']?t|cannot|won[’']?t|don[’']?t|do\s+not)\s+(?:(?:want|plan)\s+to\s+)?(?:(?:self[ -]?)?drive|be\s+driving|(?:have|own)\s+(?:a\s+)?car)|exclud\w*\s+driving|public\s+(?:transit|transport)\s+only)\b/i;
const yesDrive = /\b(?:include\s+(?:self[ -]?)?driving|(?:i\s+)?(?:can|will)\s+(?:self[ -]?)?drive|self[ -]?driv\w*\s+(?:is\s+)?(?:fine|okay|ok|allowed)|driving\s+(?:is\s+)?(?:fine|okay|ok|allowed))\b/i;
const amount = "(\\d[\\d,]*(?:\\.\\d{1,2})?)";

export function updateChatTravelMemory(previous: ChatTravelMemory, text: string): ChatTravelMemory {
  const memory = { ...previous, ownMessages: [...(previous.ownMessages ?? [])] };
  const issues = { ...(previous.preferenceIssues ?? {}) };
  if (previous.preferenceQuestion && !Object.keys(issues).length) {
    const field = /driv/i.test(previous.preferenceQuestion) ? "driving" : /budget/i.test(previous.preferenceQuestion) ? "budget" : "distance";
    issues[field] = previous.preferenceQuestion;
  }
  const clean = text.trim().slice(0, 2_000);
  if (!clean) return memory;
  const withoutLinks = clean.replace(/https?:\/\/[^\s<>"]+/g, " ");
  const zip = withoutLinks.match(/\b\d{5}\b/)?.[0];
  const url = clean.match(/https?:\/\/[^\s<>"]+/)?.[0]?.replace(/[).,!?]+$/, "");
  if (zip) memory.zip = zip;
  if (url) memory.url = url;
  if (memory.ownMessages!.at(-1) !== clean) memory.ownMessages!.push(clean);
  while (memory.ownMessages!.length > 1 && memory.ownMessages!.join("\n").length > 4_000) memory.ownMessages!.shift();
  memory.requirements = memory.ownMessages!.map((answer) => `Traveler's answer: ${answer}`).join("\n");

  const no = noDrive.test(withoutLinks);
  const yes = yesDrive.test(withoutLinks);
  const answer = withoutLinks.replace(/^\s*@smile\b/i, "").trim();
  const answeringDrive = /(?:self[ -]?driv|driving)/i.test(previous.preferenceQuestion ?? "");
  if (no && yes) issues.driving = "Should driving be included, or should I use only options where you do not drive?";
  else if (no || (answeringDrive && /^(?:no|nope)(?:[.!])?$/i.test(answer))) {
    memory.includeSelfDrive = false;
    delete issues.driving;
  } else if (yes || (answeringDrive && /^(?:yes|yep)(?:[.!])?$/i.test(answer))) {
    memory.includeSelfDrive = true;
    delete issues.driving;
  } else if (/\b(?:driv\w*|car|vehicle)\b/i.test(withoutLinks)) {
    issues.driving = "Should driving be included, or should I use only options where you do not drive?";
  }

  const moneyPatterns = [
    new RegExp(`\\b(?:budget|spend|spending|up to|at most|under|maximum|max)(?:\\s+(?:is|of|:|total|travel))?\\s*:?\\s*\\$\\s*${amount}`, "gi"),
    new RegExp(`\\$\\s*${amount}\\s*(?:USD\\s*)?(?:budget|maximum|max|limit|total|or less)\\b`, "gi"),
    new RegExp(`\\b(?:spend|spending)\\s+(?:no\\s+)?more\\s+than\\s*\\$\\s*${amount}`, "gi"),
    new RegExp(`\\$\\s*${amount}\\s+is\\s+(?:the\\s+)?(?:most|maximum|max)\\s+(?:that\\s+)?(?:i|we)\\s+can\\s+(?:afford|spend)\\b`, "gi"),
  ];
  const budgets = [...new Set(moneyPatterns.flatMap((pattern) => [...withoutLinks.matchAll(pattern)].map((match) => Math.round(Number(match[1]!.replace(/,/g, "")) * 100))))];
  if (/budget|spend|maximum|max|limit/i.test(previous.preferenceQuestion ?? "") && /^\$\s*\d[\d,]*(?:\.\d{1,2})?\s*(?:USD)?[.!]?$/i.test(answer)) {
    budgets.push(Math.round(Number(answer.match(/\d[\d,]*(?:\.\d{1,2})?/)![0].replace(/,/g, "")) * 100));
  }
  const uniqueBudgets = [...new Set(budgets)];
  const uncertainBudget = withoutLinks.split(/\band\b|[.!?]/i).some((clause) => /\b(?:budget|spend|maximum|max|limit|afford)\b/i.test(clause) && /\b(?:or|between|around|about|maybe|roughly)\b/i.test(clause) && /\$\s*\d/.test(clause));
  if (uncertainBudget || uniqueBudgets.length > 1 || uniqueBudgets.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 100_000_000)) {
    issues.budget = "What is your maximum total travel budget in US dollars? Please give one amount.";
  } else if (uniqueBudgets.length === 1) {
    memory.travelerBudgetCents = uniqueBudgets[0];
    delete issues.budget;
  } else if (/\b(?:budget|spend|spending|afford)\b/i.test(withoutLinks) && /\d/.test(withoutLinks)) {
    issues.budget = "What is your maximum total travel budget in US dollars? Please give one amount and include the currency.";
  }

  const distances = [...withoutLinks.matchAll(/\b(?:within|up to|at most|maximum|max|distance(?:\s+limit)?(?:\s+is)?)\s*:?\s*(\d+(?:\.\d+)?)\s*(miles?|mi|kilometers?|kilometres?|km)\b/gi)]
    .map((match) => Number(match[1]) / (/^(?:km|kilo)/i.test(match[2]!) ? 1.609344 : 1));
  if (new Set(distances).size > 1 || distances.some((value) => !Number.isFinite(value) || value <= 0 || value > 25_000)) {
    issues.distance = "What is the farthest you want to travel? Please give one distance and its unit.";
  } else if (distances.length) {
    memory.maxDistanceMiles = distances[0];
    delete issues.distance;
  }
  memory.preferenceIssues = issues;
  memory.preferenceQuestion = issues.driving ?? issues.budget ?? issues.distance;
  return memory;
}

export async function prepareChatTravel(
  previous: ChatTravelMemory,
  text: string,
  context: ChatTravelContext = {},
  review: typeof reviewTravelConstraints = reviewTravelConstraints,
) {
  const memory = updateChatTravelMemory(previous, text);
  const preferences: {
    includeSelfDrive?: boolean;
    travelerBudgetCents?: number;
    maxDistanceMiles?: number;
    travelConstraints?: TravelConstraints & { raw: string };
  } = {
    includeSelfDrive: memory.includeSelfDrive,
    travelerBudgetCents: memory.travelerBudgetCents,
    maxDistanceMiles: memory.maxDistanceMiles,
  };
  if (memory.preferenceQuestion) {
    memory.clarificationQuestion = memory.preferenceQuestion;
    return { memory, preferences, clarification: memory.preferenceQuestion };
  }
  const raw = memory.requirements ?? "";
  if (timingOrAccommodation.test(raw)) {
    const checked = await review({ text: raw, origin: memory.zip, ...context });
    const unparsed = checked.parsedBy === "rules" && !checked.arriveBy && !checked.departAfter;
    const question = checked.status === "needs_clarification"
      ? checked.followUpQuestion || "Please confirm the exact place, date, time, and time zone for your travel requirement."
      : unparsed
        ? "I could not safely read your arrival, departure, or accessibility requirement. Please confirm the exact place, date, time, and time zone before I plan it."
        : undefined;
    if (question) {
      memory.clarificationQuestion = question;
      return { memory, preferences, clarification: question };
    }
    preferences.travelConstraints = { ...checked, raw };
  }
  memory.clarificationQuestion = undefined;
  return { memory, preferences, clarification: undefined };
}
