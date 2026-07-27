import {
  importKindFromPayload,
  projectNameFromFilename,
  safeProjectFilename,
} from "./file_format.ts";

Deno.test("dragged Flowforge files are detected by their payload kind", () => {
  const cases = [
    ["flowforge-template", "template"],
    ["flowforge-definitions", "definitions"],
    ["flowforge-chart", "chart"],
    ["flowforge-project", "project"],
  ] as const;

  for (const [kind, expected] of cases) {
    const actual = importKindFromPayload({ kind });
    if (actual !== expected) {
      throw new Error(`expected ${expected}, received ${actual}`);
    }
  }

  if (importKindFromPayload({ kind: "other" }) !== null) {
    throw new Error("unsupported file kinds must be rejected");
  }
});

Deno.test("project filenames are normalized for save and display", () => {
  if (projectNameFromFilename("Aluminium.flowforge.json") !== "Aluminium") {
    throw new Error("the Flowforge extension should be hidden in the title");
  }
  if (projectNameFromFilename("legacy.project.json") !== "legacy") {
    throw new Error("legacy project extensions should remain readable");
  }
  if (safeProjectFilename("Bauxite: Loop") !== "Bauxite- Loop.flowforge.json") {
    throw new Error("unsafe filename characters should be replaced");
  }
});
