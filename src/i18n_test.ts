import { exampleState, validateConnection } from "./engine.ts";
import { translate } from "./i18n.ts";

Deno.test("translations interpolate values in both languages", () => {
  const korean = translate("ko", "canvas.selectionHelp", { count: 3 });
  const english = translate("en", "canvas.selectionHelp", { count: 3 });

  if (!korean.includes("3개") || !english.includes("3 nodes")) {
    throw new Error(`unexpected translations: ${korean} / ${english}`);
  }
});

Deno.test("creation dialogs use one concise add action", () => {
  const keys = [
    "form.resource.submit",
    "form.metric.submit",
    "form.machine.submit",
    "form.recipe.submit",
  ] as const;

  for (const key of keys) {
    if (translate("ko", key) !== "추가" || translate("en", key) !== "Add") {
      throw new Error(`unexpected creation action for ${key}`);
    }
  }
});

Deno.test("engine validation follows the selected language", () => {
  const state = structuredClone(exampleState);
  const source = state.nodes.find((node) => node.id === "source-1");
  const press = state.nodes.find((node) => node.id === "press-1");
  if (!source || !press) throw new Error("fixture nodes are missing");

  const error = validateConnection(
    state,
    source,
    "input-out:iron-ore-supply",
    press,
    "gear-press:press-in",
    "en",
  );

  if (!error?.includes("Resources do not match")) {
    throw new Error(`expected an English validation error, received: ${error}`);
  }
});
