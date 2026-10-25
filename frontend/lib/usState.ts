const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};

const STATE_CODES = new Set(Object.values(STATE_NAMES));

export function stateCodeFrom(value?: string): string | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]!.replace(/\bUS(?:A)?\b/gi, "").trim();
    const code = part.match(/\b([A-Z]{2})\b/i)?.[1]?.toUpperCase();
    if (code && STATE_CODES.has(code)) return code;
    const name = part.toLowerCase();
    if (STATE_NAMES[name]) return STATE_NAMES[name];
  }
  const lower = value.toLowerCase();
  return Object.entries(STATE_NAMES).find(([name]) => new RegExp(`\\b${name.replace(" ", "\\s+")}\\b`, "i").test(lower))?.[1];
}
