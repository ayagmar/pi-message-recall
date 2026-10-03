import { fuzzyMatch } from "@earendil-works/pi-tui";
import { type RecallMessage, type RecallSearchResult } from "./recall-types.js";

type SearchTerm = {
  text: string;
  allowFuzzy: boolean;
};

export function searchRecallMessages(messages: RecallMessage[], query: string): RecallSearchResult {
  const uniqueMessages = dedupeMessages(messages);
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return {
      matches: uniqueMessages,
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
      uniqueMessages,
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
      matches: uniqueMessages,
      mode: "recent",
    };
  }

  const exactMatches: RecallMessage[] = [];
  const fuzzyMatches: RecallMessage[] = [];

  for (const message of uniqueMessages) {
    const matchKind = classifyTextMatch(message.normalizedText, terms);
    if (matchKind === "exact") {
      exactMatches.push(message);
      continue;
    }

    if (matchKind === "fuzzy") {
      fuzzyMatches.push(message);
    }
  }

  return {
    matches: [...exactMatches, ...fuzzyMatches],
    mode: "text",
  };
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

function dedupeMessages(messages: RecallMessage[]): RecallMessage[] {
  const seen = new Set<string>();
  const unique: RecallMessage[] = [];

  for (const message of messages) {
    if (seen.has(message.text)) {
      continue;
    }

    seen.add(message.text);
    unique.push(message);
  }

  return unique;
}

function classifyTextMatch(
  normalizedText: string,
  terms: SearchTerm[]
): "exact" | "fuzzy" | undefined {
  let isExact = true;

  for (const term of terms) {
    if (normalizedText.includes(term.text)) {
      continue;
    }

    // Fuzzy fallback: the term's characters appear in order (pi-tui's subsequence matcher).
    if (!term.allowFuzzy || !fuzzyMatch(term.text, normalizedText).matches) {
      return undefined;
    }

    isExact = false;
  }

  return isExact ? "exact" : "fuzzy";
}

function parseQueryTerms(query: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  const pattern = /"([^"]+)"|(\S+)/g;

  for (const match of query.matchAll(pattern)) {
    const phrase = match[1] ?? match[2];
    if (!phrase) {
      continue;
    }

    const normalized = phrase.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized) {
      terms.push({
        text: normalized,
        allowFuzzy: match[1] == null,
      });
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
