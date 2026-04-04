export type RecallCommand =
  | { kind: "settings" }
  | { kind: "status" }
  | { kind: "picker"; initialQuery: string };

export function parseRecallCommandArgs(args: string): RecallCommand {
  const trimmed = args.trim();
  const lower = trimmed.toLowerCase();

  if (lower === "settings") {
    return { kind: "settings" };
  }

  if (lower === "status") {
    return { kind: "status" };
  }

  return { kind: "picker", initialQuery: trimmed };
}

export function getRecallArgumentCompletions(
  prefix: string
): { value: string; label: string }[] | null {
  const options = ["settings", "status"];
  const safePrefix = prefix.trim().toLowerCase();
  const matches = options.filter((option) => option.startsWith(safePrefix));

  if (matches.length === 0) {
    return null;
  }

  return matches.map((value) => ({ value, label: value }));
}
