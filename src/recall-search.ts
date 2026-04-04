import { type RecallMessage, type RecallSearchResult } from "./recall-types.js";

export function searchRecallMessages(messages: RecallMessage[], query: string): RecallSearchResult {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return {
      matches: messages,
      mode: "recent",
    };
  }

  if (trimmedQuery.toLowerCase().startsWith("re:")) {
    const regex = buildRegexQuery(trimmedQuery.slice(3).trim());
    if (!regex) {
      return {
        matches: [],
        mode: "regex",
        error: "Regex search must use re:<pattern> or re:/pattern/flags.",
      };
    }

    return collectMatches(
      messages,
      (message) => {
        regex.lastIndex = 0;
        return regex.test(message.text);
      },
      "regex"
    );
  }

  const terms = parseQueryTerms(trimmedQuery);
  if (terms.length === 0) {
    return {
      matches: messages,
      mode: "recent",
    };
  }

  return collectMatches(
    messages,
    (message) => terms.every((term) => message.normalizedText.includes(term)),
    "text"
  );
}

function collectMatches(
  messages: RecallMessage[],
  predicate: (message: RecallMessage) => boolean,
  mode: RecallSearchResult["mode"]
): RecallSearchResult {
  return {
    matches: messages.filter(predicate),
    mode,
  };
}

function parseQueryTerms(query: string): string[] {
  const terms: string[] = [];
  const pattern = /"([^"]+)"|(\S+)/g;

  for (const match of query.matchAll(pattern)) {
    const phrase = match[1] ?? match[2];
    if (!phrase) {
      continue;
    }

    const normalized = phrase.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized) {
      terms.push(normalized);
    }
  }

  return terms;
}

function buildRegexQuery(value: string): RegExp | undefined {
  if (!value) {
    return undefined;
  }

  const literalMatch = value.match(/^\/(.*)\/([a-z]*)$/i);
  if (literalMatch) {
    try {
      return new RegExp(literalMatch[1] ?? "", literalMatch[2] || "i");
    } catch {
      return undefined;
    }
  }

  try {
    return new RegExp(value, "i");
  } catch {
    return undefined;
  }
}
