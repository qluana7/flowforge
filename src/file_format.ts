export type ImportKind = "template" | "project" | "definitions" | "chart";

export function importKindFromPayload(value: unknown): ImportKind | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "flowforge-template") return "template";
  if (kind === "flowforge-definitions") return "definitions";
  if (kind === "flowforge-chart") return "chart";
  if (kind === "flowforge-project") return "project";
  return null;
}

export function projectNameFromFilename(filename: string): string {
  const stripped = filename
    .replace(/\.flowforge\.json$/i, "")
    .replace(/\.project\.json$/i, "")
    .replace(/\.template\.json$/i, "")
    .replace(/\.definitions\.json$/i, "")
    .replace(/\.json$/i, "")
    .trim();
  return stripped || "Flowforge Project";
}

export function safeProjectFilename(name: string): string {
  const safe = Array.from(
    name.trim(),
    (character) => character.charCodeAt(0) < 32 ? "-" : character,
  ).join("")
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/[.\s]+$/g, "")
    .slice(0, 120);
  return `${safe || "Flowforge Project"}.flowforge.json`;
}
