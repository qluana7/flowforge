import {
  activeRecipesForNode,
  initialState,
  machineById,
  normalizeRecipeDuration,
  portsForNode,
  probabilityForOutput,
  recipesForMachine,
  resourceById,
  resourceLabel,
  simulate,
  uid,
  validateConnection,
} from "./engine.ts";
import { analyzeBottlenecks, findMinimumInputBatch } from "./analysis.ts";
import {
  type EdgeObstacle,
  type EdgeSegment,
  routeCoreSegments,
  routeOrthogonalEdge,
} from "./edge_routing.ts";
import {
  type ImportKind,
  importKindFromPayload,
  projectNameFromFilename,
  safeProjectFilename,
} from "./file_format.ts";
import { type Locale, translate, type TranslationKey } from "./i18n.ts";
import type {
  AuxiliaryDefinition,
  FlowNode,
  MachineDefinition,
  NodeKind,
  NodeTitleKey,
  PortDirection,
  ProjectState,
  Recipe,
  Resource,
} from "./types.ts";

type DefinitionsPayload = Pick<
  ProjectState,
  "resources" | "auxiliaries" | "machines" | "recipes"
>;
type ChartPayload = Pick<ProjectState, "nodes" | "edges"> & {
  camera: { x: number; y: number; zoom: number };
};
type TemplateFile = {
  kind: "flowforge-template";
  version: 1;
  exportedAt: string;
  name: string;
  definitions: DefinitionsPayload;
};
type ProjectFile = {
  kind: "flowforge-project";
  version: 1;
  exportedAt: string;
  name: string;
  definitions: DefinitionsPayload;
  chart: ChartPayload;
};
type WritableFileStream = {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
};
type FlowforgeFileHandle = {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<WritableFileStream>;
  queryPermission?(
    options?: { mode: "read" | "readwrite" },
  ): Promise<PermissionState>;
  requestPermission?(
    options?: { mode: "read" | "readwrite" },
  ): Promise<PermissionState>;
};
type FilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<FlowforgeFileHandle>;
  showOpenFilePicker?: (options: {
    multiple: boolean;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<FlowforgeFileHandle[]>;
};
type ProjectMetadata = {
  name: string | null;
  revision: number;
  savedRevision: number | null;
};
const STORAGE_KEY = "flowforge-project-v3";
const PROJECT_META_KEY = "flowforge-project-meta-v1";
const HANDLE_DATABASE = "flowforge-file-handles";
const HANDLE_STORE = "handles";
const PROJECT_HANDLE_KEY = "current-project";
const THEME_KEY = "flowforge-theme";
const LANGUAGE_KEY = "flowforge-language";
const clone = <T>(value: T): T => structuredClone(value);

function normalizeDefinitionsSchema(
  definitions: DefinitionsPayload,
): DefinitionsPayload {
  return {
    ...clone(definitions),
    recipes: definitions.recipes.map((sourceRecipe) => {
      const recipe = sourceRecipe as Recipe & { name?: string };
      const { name: _legacyName, ...normalized } = recipe;
      return normalized;
    }),
  };
}

function normalizeProjectState(project: ProjectState): ProjectState {
  const normalized: ProjectState = {
    ...clone(project),
    ...normalizeDefinitionsSchema(project),
  };
  const migratedSourceIds = new Set<string>();
  for (const node of normalized.nodes) {
    if (node.kind === "source" && node.amount !== undefined) {
      const supplyId = "legacy";
      node.kind = "input";
      node.titleKey = node.titleKey === "node.default.source"
        ? "node.default.input"
        : node.titleKey;
      node.inputSupplies = node.resourceId
        ? [{ id: supplyId, resourceId: node.resourceId, amount: node.amount }]
        : [];
      node.finalOutputPortIds = node.finalOutputPortIds?.map((portId) =>
        portId === "source-out" ? `input-out:${supplyId}` : portId
      );
      delete node.resourceId;
      delete node.amount;
      migratedSourceIds.add(node.id);
    }
  }
  for (const edge of normalized.edges) {
    if (
      migratedSourceIds.has(edge.sourceNodeId) &&
      edge.sourcePortId === "source-out"
    ) {
      edge.sourcePortId = "input-out:legacy";
    }
  }
  return normalized;
}

function loadState(): ProjectState {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as
      | ProjectState
      | null;
    return parsed?.version === 2
      ? normalizeProjectState(parsed)
      : clone(initialState);
  } catch {
    return clone(initialState);
  }
}

function loadProjectMetadata(): ProjectMetadata {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(PROJECT_META_KEY) ?? "null",
    ) as Partial<ProjectMetadata> | null;
    const revision = parsed?.revision;
    const savedRevision = parsed?.savedRevision;
    return {
      name: typeof parsed?.name === "string" ? parsed.name : null,
      revision: Number.isInteger(revision) ? revision as number : 0,
      savedRevision: Number.isInteger(savedRevision)
        ? savedRevision as number
        : null,
    };
  } catch {
    return { name: null, revision: 0, savedRevision: null };
  }
}

let state = loadState();
const loadedProjectMetadata = loadProjectMetadata();
let projectName = loadedProjectMetadata.name;
let projectRevision = loadedProjectMetadata.revision;
let projectSavedRevision = loadedProjectMetadata.savedRevision;
let projectFileHandle: FlowforgeFileHandle | null = null;
let selectedNodeId: string | null = null;
let selectedNodeIds = new Set<string>();
let selectedEdgeId: string | null = null;
let activeLibraryTab:
  | "resources"
  | "auxiliaries"
  | "machines"
  | "utilities"
  | null = null;
let animateLibraryDrawer = false;
let activeTopMenu: "project" | "file" | "edit" | "view" | null = null;
const undoStack: ProjectState[] = [];
const redoStack: ProjectState[] = [];
let pendingPort:
  | { nodeId: string; portId: string; direction: PortDirection }
  | null = null;
let pointerPosition = { x: 0, y: 0 };
let panOffset = { x: 0, y: 0 };
let zoomLevel = 1;
let worldLayout = {
  offsetX: 2000,
  offsetY: 2000,
  width: 5400,
  height: 4900,
};
let suppressNextNodeClick = false;
let draggedRecipePortRow: HTMLElement | null = null;
let pendingDelete:
  | { kind: "resource" | "auxiliary" | "machine" | "recipe"; id: string }
  | null = null;
const storedLanguage = localStorage.getItem(LANGUAGE_KEY);
let locale: Locale = storedLanguage === "ko" || storedLanguage === "en"
  ? storedLanguage
  : navigator.language.toLowerCase().startsWith("ko")
  ? "ko"
  : "en";
let result = simulate(state, locale);
let theme = localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) throw new Error("#app element is required");
const app: HTMLDivElement = appElement;

function applyTheme(): void {
  document.documentElement.dataset.theme = theme;
}
applyTheme();

function t(
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  return translate(locale, key, params);
}

function applyLocale(): void {
  document.documentElement.lang = locale;
  document.title = `${projectName ?? t("project.untitled")} — Flowforge`;
  document.querySelector<HTMLMetaElement>('meta[name="description"]')
    ?.setAttribute("content", t("meta.description"));
}
applyLocale();

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    })[character] ?? character);
}

function persistProjectMetadata(): void {
  localStorage.setItem(
    PROJECT_META_KEY,
    JSON.stringify(
      {
        name: projectName,
        revision: projectRevision,
        savedRevision: projectSavedRevision,
      } satisfies ProjectMetadata,
    ),
  );
}

function touchProject(): void {
  projectRevision += 1;
  persistProjectMetadata();
}

function save(): void {
  touchProject();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function projectIsSaved(): boolean {
  return projectSavedRevision !== null &&
    projectSavedRevision === projectRevision;
}

function markProjectSaved(): void {
  projectSavedRevision = projectRevision;
  persistProjectMetadata();
}

function openHandleDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DATABASE, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(HANDLE_STORE)) {
        request.result.createObjectStore(HANDLE_STORE);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function storedProjectHandle(): Promise<FlowforgeFileHandle | null> {
  try {
    const database = await openHandleDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE, "readonly");
      const request = transaction.objectStore(HANDLE_STORE).get(
        PROJECT_HANDLE_KEY,
      );
      request.addEventListener(
        "success",
        () =>
          resolve((request.result as FlowforgeFileHandle | undefined) ?? null),
      );
      request.addEventListener("error", () => reject(request.error));
      transaction.addEventListener("complete", () => database.close());
    });
  } catch {
    return null;
  }
}

async function rememberProjectHandle(
  handle: FlowforgeFileHandle | null,
): Promise<void> {
  try {
    const database = await openHandleDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE, "readwrite");
      const store = transaction.objectStore(HANDLE_STORE);
      handle
        ? store.put(handle, PROJECT_HANDLE_KEY)
        : store.delete(PROJECT_HANDLE_KEY);
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () => reject(transaction.error));
      transaction.addEventListener("abort", () => reject(transaction.error));
    });
    database.close();
  } catch {
    // IndexedDB handle persistence is an enhancement. Saving still works for
    // this session when a browser does not support cloning file handles.
  }
}

async function restoreStoredProjectHandle(): Promise<void> {
  if (!projectName) return;
  const handle = await storedProjectHandle();
  if (!handle || projectNameFromFilename(handle.name) !== projectName) return;
  projectFileHandle = handle;
}

function checkpoint(): void {
  undoStack.push(clone(state));
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
}

function restoreState(next: ProjectState): void {
  state = normalizeProjectState(next);
  selectedNodeId = null;
  selectedNodeIds.clear();
  selectedEdgeId = null;
  pendingPort = null;
  save();
  render();
}

function undo(): void {
  const previous = undoStack.pop();
  if (!previous) return;
  redoStack.push(clone(state));
  restoreState(previous);
  showToast(t("toast.undo"));
}

function redo(): void {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(clone(state));
  restoreState(next);
  showToast(t("toast.redo"));
}

function icon(kind: NodeKind): string {
  return {
    machine: "⬡",
    source: "↳",
    input: "⇥",
    extract: "↲",
    splitter: "⑂",
    merger: "⑃",
  }[kind];
}

function resourceDot(resourceId: string): string {
  const resource = resourceById(state, resourceId);
  return `<span class="resource-dot ${
    resource?.imageDataUrl ? "has-image" : ""
  }" style="--resource-color:${resource?.color ?? "#6f7d86"}">${
    resource?.imageDataUrl
      ? `<img src="${escapeHtml(resource.imageDataUrl)}" alt="">`
      : escapeHtml(resourceLabel(resource, "∙"))
  }</span>`;
}

function machineVisual(machineId?: string): string {
  const machine = machineId ? machineById(state, machineId) : undefined;
  return machine?.imageDataUrl
    ? `<img src="${escapeHtml(machine.imageDataUrl)}" alt="">`
    : "⬡";
}

const defaultNodeTitleKeys: Record<NodeKind, NodeTitleKey> = {
  machine: "node.default.machine",
  source: "node.default.source",
  input: "node.default.input",
  extract: "node.default.extract",
  splitter: "node.default.splitter",
  merger: "node.default.merger",
};

function nodeTitle(node: FlowNode): string {
  if (
    node.titleKey &&
    Object.values(defaultNodeTitleKeys).includes(node.titleKey)
  ) {
    return t(node.titleKey);
  }
  if (node.kind !== "machine") {
    const key = defaultNodeTitleKeys[node.kind];
    const isLegacyDefault = (["ko", "en"] as const).some((language) =>
      node.title === translate(language, key)
    );
    if (isLegacyDefault) return t(key);
  }
  return node.title;
}

function nodeSubtitle(node: FlowNode): string {
  if (node.kind === "machine") {
    const recipes = activeRecipesForNode(state, node);
    if (!recipes.length) return t("node.subtitle.noRecipe");
    return "";
  }
  if (node.kind === "source") {
    const resource = node.resourceId
      ? resourceById(state, node.resourceId)
      : undefined;
    return t("node.subtitle.source", {
      unit: resource?.unit ?? "",
    });
  }
  if (node.kind === "input") {
    return t("node.subtitle.input", {
      count: node.inputSupplies?.length ?? 0,
    });
  }
  if (node.kind === "extract") {
    const incomingEdges = state.edges.filter((edge) =>
      edge.targetNodeId === node.id
    );
    if (incomingEdges.length > 1) {
      return t("node.subtitle.extractMultiple", {
        count: incomingEdges.length,
      });
    }
    const edge = incomingEdges[0];
    const resource = edge ? resourceById(state, edge.resourceId) : undefined;
    const amount = edge ? result.edgeFlows[edge.id] : undefined;
    return resource
      ? t("node.subtitle.extract", {
        amount: amount === undefined ? "0" : formatAmount(amount),
        unit: resource.unit,
      })
      : t("node.subtitle.extractUnconnected");
  }
  if (node.kind === "splitter") {
    return t("node.subtitle.split", {
      first: Math.round((node.splitRatios?.[0] ?? 0.5) * 100),
      second: Math.round((node.splitRatios?.[1] ?? 0.5) * 100),
    });
  }
  return t("node.subtitle.merge");
}

function formatAmount(value: number, maximumFractionDigits = 2): string {
  if (value === Number.POSITIVE_INFINITY) return "∞";
  if (value === Number.NEGATIVE_INFINITY) return "−∞";
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits,
  }).format(value);
}

function isCompatiblePort(
  nodeId: string,
  portId: string,
  direction: PortDirection,
): boolean {
  if (!pendingPort || pendingPort.direction === direction) return false;
  const firstNode = state.nodes.find((node) => node.id === pendingPort?.nodeId);
  const secondNode = state.nodes.find((node) => node.id === nodeId);
  if (!firstNode || !secondNode) return false;
  const sourceNode = pendingPort.direction === "output"
    ? firstNode
    : secondNode;
  const targetNode = pendingPort.direction === "input" ? firstNode : secondNode;
  const sourcePort = pendingPort.direction === "output"
    ? pendingPort.portId
    : portId;
  const targetPort = pendingPort.direction === "input"
    ? pendingPort.portId
    : portId;
  return validateConnection(
    state,
    sourceNode,
    sourcePort,
    targetNode,
    targetPort,
    locale,
  ) === null;
}

function renderPort(
  node: FlowNode,
  port: ReturnType<typeof portsForNode>["inputs"][number],
): string {
  const pending = pendingPort?.nodeId === node.id &&
    pendingPort.portId === port.id;
  const compatible = isCompatiblePort(node.id, port.id, port.direction);
  const sideClass = port.direction === "input" ? "port-input" : "port-output";
  const finalOutput = port.direction === "output" &&
    node.finalOutputPortIds?.includes(port.id);
  const label = port.resourceId ? port.label : "AUTO";
  const content = `
    ${resourceDot(port.resourceId)}
    <span>${escapeHtml(label)} ${
    port.amount > 0 ? `<em>${formatAmount(port.amount)}</em>` : ""
  }</span>`;
  const directionLabel = t(
    port.direction === "input"
      ? "node.portDirection.input"
      : "node.portDirection.output",
  );
  const connectTitle = finalOutput
    ? t("node.portFinalOutputActive")
    : port.direction === "output"
    ? t("node.portFinalOutputHint")
    : t("node.portConnectTitle", {
      direction: directionLabel,
    });
  return `
    <button class="port-row ${sideClass}${
    finalOutput ? " is-final-output" : ""
  }${pending ? " is-pending" : ""}${compatible ? " is-compatible" : ""}"
      data-node="${node.id}" data-port="${port.id}"
      data-direction="${port.direction}" data-resource="${port.resourceId}"
      data-final-output="${finalOutput ? "true" : "false"}"
      title="${connectTitle}" aria-label="${connectTitle}">
      ${
    port.direction === "input"
      ? `<i class="port-socket"></i>${content}`
      : `${content}<i class="port-socket"></i>`
  }
    </button>`;
}

function renderNode(node: FlowNode): string {
  const ports = portsForNode(state, node);
  const selected = selectedNodeIds.has(node.id) ? " is-selected" : "";
  const warning = !["source", "input"].includes(node.kind) &&
      result.nodeRuns[node.id] === undefined
    ? " has-warning"
    : "";
  const runs = result.nodeRuns[node.id];
  const displayTitle = nodeTitle(node);
  const subtitle = nodeSubtitle(node);
  const durationBadges = node.kind === "machine"
    ? activeRecipesForNode(state, node).map((recipe) =>
      `<span title="${escapeHtml(recipe.id)}">${
        formatAmount(recipe.duration)
      }s</span>`
    ).join("")
    : "";

  return `
    <article class="flow-node node-${node.kind}${selected}${warning}"
      data-node-id="${node.id}" style="left:${
    node.x + worldLayout.offsetX
  }px;top:${node.y + worldLayout.offsetY}px">
      <header class="node-header" data-drag-handle>
        <span class="node-kind ${
    node.kind === "machine" && machineById(state, node.machineId ?? "")
        ?.imageDataUrl
      ? "has-image"
      : ""
  }">${
    node.kind === "machine" ? machineVisual(node.machineId) : icon(node.kind)
  }</span>
        <div>
          <strong>${escapeHtml(displayTitle)}</strong>
          ${subtitle ? `<small>${escapeHtml(subtitle)}</small>` : ""}
        </div>
        ${
    durationBadges
      ? `<div class="node-duration-list">${durationBadges}</div>`
      : ""
  }
        <button class="node-menu" data-action="delete-node" title="${
    t("node.deleteTitle")
  }" aria-label="${t("node.deleteTitle")}">×</button>
      </header>
      <div class="node-body">
        <div class="port-column inputs">${
    ports.inputs.map((port) => renderPort(node, port)).join("")
  }</div>
        <div class="port-column outputs">${
    ports.outputs.map((port) => renderPort(node, port)).join("")
  }</div>
      </div>
      ${
    node.kind === "input"
      ? `<footer class="node-action-footer"><button data-action="calculate-input-node" data-node-id="${node.id}">${
        t("input.calculate")
      }</button></footer>`
      : runs !== undefined
      ? `<footer class="node-metric"><span>${t("node.throughput")}</span><b>${
        formatAmount(runs)
      } ${t("node.cycle")}</b></footer>`
      : ""
  }
    </article>`;
}

function resourceOptions(selected?: string): string {
  return state.resources.map((resource) =>
    `<option value="${resource.id}" ${
      resource.id === selected ? "selected" : ""
    }>${escapeHtml(resource.name)} · ${escapeHtml(resource.unit)}</option>`
  ).join("");
}

function renderInspector(): string {
  const node = selectedNodeIds.size === 1
    ? state.nodes.find((item) => item.id === selectedNodeId)
    : undefined;
  if (!node) {
    return `
      <div class="empty-inspector">
        <span>⌁</span><strong>${t("inspector.emptyTitle")}</strong>
        <p>${t("inspector.emptyDescription")}</p>
      </div>`;
  }

  const machineRecipes = node.machineId
    ? recipesForMachine(state, node.machineId)
    : [];
  const inferred = node.resourceId
    ? resourceById(state, node.resourceId)
    : undefined;
  const extractOutputs = new Map<string, number>();
  if (node.kind === "extract") {
    for (
      const edge of state.edges.filter((edge) => edge.targetNodeId === node.id)
    ) {
      extractOutputs.set(
        edge.resourceId,
        (extractOutputs.get(edge.resourceId) ?? 0) +
          (result.edgeFlows[edge.id] ?? 0),
      );
    }
  }
  const displayTitle = nodeTitle(node);

  return `
    <div class="inspector-content">
      <div class="inspector-kicker">${
    icon(node.kind)
  } ${node.kind.toUpperCase()}</div>
      <h2>${escapeHtml(displayTitle)}</h2>
      <label class="field">
        <span>${t("inspector.displayName")}</span>
        <input data-inspector="title" value="${escapeHtml(displayTitle)}">
      </label>
      ${
    node.kind === "source"
      ? `
        <label class="field"><span>${t("inspector.sourceResource")}</span>
          <select data-inspector="resourceId">${
        resourceOptions(node.resourceId)
      }</select>
        </label>
        <p class="setting-note">${t("inspector.sourceInfinite")}</p>`
      : ""
  }
      ${
    node.kind === "input"
      ? `<div class="input-supply-editor">
          <div class="input-supply-heading"><span>${
        t("inspector.inputSupplies")
      }</span><button data-action="add-input-supply" data-node-id="${node.id}">${
        t("common.add")
      }</button></div>
          ${
        (node.inputSupplies ?? []).map((supply) => `
            <div class="input-supply-row" data-supply-id="${supply.id}">
              <select data-input-supply-field="resourceId">${
          resourceOptions(supply.resourceId)
        }</select>
              <input data-input-supply-field="amount" type="number" min="0" step="any" value="${supply.amount}">
              <button data-action="remove-input-supply" data-node-id="${node.id}" data-supply-id="${supply.id}" aria-label="${
          t("common.delete")
        }">×</button>
            </div>`).join("")
      }
          ${
        node.inputSupplies?.length
          ? ""
          : `<p class="setting-note">${t("inspector.noInputSupplies")}</p>`
      }
          <button class="primary-button input-calculate-button" data-action="calculate-input-node" data-node-id="${node.id}">${
        t("input.calculate")
      }</button>
        </div>`
      : ""
  }
      ${
    node.kind === "extract"
      ? extractOutputs.size
        ? `<div class="inferred-list">${
          Array.from(extractOutputs, ([resourceId, amount]) => {
            const resource = resourceById(state, resourceId);
            if (!resource) return "";
            return `<div class="inferred-card">
              <small>${t("inspector.inferredFromConnection")}</small>
              <strong>${
              resourceDot(resource.id) + escapeHtml(resource.name)
            }</strong>
              <span>${formatAmount(amount)} ${escapeHtml(resource.unit)}</span>
            </div>`;
          }).join("")
        }</div>`
        : `
        <div class="inferred-card">
          <small>${t("inspector.inferredFromConnection")}</small>
          <strong>${t("inspector.notConnected")}</strong>
          <span>${t("inspector.connectInputHint")}</span>
        </div>`
      : ""
  }
      ${
    node.kind === "splitter"
      ? `
        <label class="field"><span>${t("inspector.firstOutputRatio")}</span>
          <div class="range-field">
            <input data-inspector="splitRatio" type="range" min="0" max="100"
              value="${Math.round((node.splitRatios?.[0] ?? 0.5) * 100)}">
            <output>${
        Math.round((node.splitRatios?.[0] ?? 0.5) * 100)
      }%</output>
          </div>
        </label>
        <p class="setting-note">${t("inspector.resourceAutoDetermined")}</p>`
      : ""
  }
      ${
    node.kind === "merger"
      ? `<div class="inferred-card"><small>${
        t("inspector.mergeResource")
      }</small><strong>${
        inferred
          ? resourceDot(inferred.id) + escapeHtml(inferred.name)
          : t("inspector.setFromFirstConnection")
      }</strong><span>${t("inspector.singleFlowPerInput")}</span></div>`
      : ""
  }
      ${
    node.kind === "machine"
      ? `
        <label class="switch-field">
          <div><strong>${t("inspector.multiRecipe")}</strong><small>${
        t("inspector.multiRecipeHelp")
      }</small></div>
          <input data-inspector="multiRecipe" type="checkbox" ${
        node.multiRecipe ? "checked" : ""
      }>
          <i></i>
        </label>
        <div class="recipe-selector">
          <span>${t("inspector.activeRecipes")}</span>
          ${
        machineRecipes.map((recipe) => {
          const active = node.activeRecipeIds?.includes(recipe.id);
          return `
              <label class="recipe-choice">
                <input data-inspector="activeRecipe" type="${
            node.multiRecipe ? "checkbox" : "radio"
          }" name="active-recipe" value="${recipe.id}" ${
            active ? "checked" : ""
          }>
                <div><strong>${escapeHtml(recipe.id)}</strong><small>${
            t("inspector.recipeMeta", {
              duration: recipe.duration,
              count: recipe.auxiliaryUses.length,
            })
          }</small></div>
              </label>`;
        }).join("") ||
        `<p class="setting-note">${t("inspector.noRecipes")}</p>`
      }
        </div>
        ${
        node.machineId
          ? `<button class="secondary-button" data-action="add-recipe" data-machine="${node.machineId}">${
            t("inspector.addRecipe")
          }</button>`
          : ""
      }`
      : ""
  }
      <button class="danger-button" data-action="delete-node">${
    t("inspector.deleteNode")
  }</button>
    </div>`;
}

function renderResults(): string {
  const outputCards = Object.entries(result.outputs).map(
    ([resourceId, amount]) => {
      const resource = resourceById(state, resourceId);
      return `<div class="result-card">
        ${resourceDot(resourceId)}
        <div><small>${t("results.finalOutput")}</small><strong>${
        formatAmount(amount)
      } ${escapeHtml(resource?.unit ?? "")}</strong></div>
      </div>`;
    },
  ).join("");
  const auxiliaryCards = Object.entries(result.auxiliaryTotals).map(
    ([id, amount]) => {
      const auxiliary = state.auxiliaries.find((item) => item.id === id);
      return `<div class="result-card auxiliary-result">
        <span class="aux-dot" style="--aux-color:${
        auxiliary?.color ?? "#f5c451"
      }">＋</span>
        <div><small>${
        escapeHtml(auxiliary?.name ?? t("results.auxiliaryFallback"))
      }</small><strong>${formatAmount(amount)} ${
        escapeHtml(auxiliary?.unit ?? "")
      }</strong></div>
      </div>`;
    },
  ).join("");
  return `
    <section class="result-strip">
      <div class="result-heading">
        <span class="status-pulse"></span>
        <div><small>LIVE SIMULATION</small><strong>${
    t("results.steadyState")
  }</strong></div>
      </div>
      <div class="result-scroll">
        ${
    outputCards ||
    `<div class="muted-result">${t("results.noConnectedOutput")}</div>`
  }
        ${auxiliaryCards}
      </div>
      <div class="result-health ${result.warnings.length ? "warning" : ""}">
        <strong>${result.warnings.length || "✓"}</strong>
        <span>${
    result.warnings.length
      ? t("results.needsReview", { count: result.warnings.length })
      : t("results.flowHealthy")
  }</span>
      </div>
    </section>`;
}

function resultResourceCards(
  values: Record<string, number>,
  emptyMessage: string,
): string {
  const cards = Object.entries(values).map(([resourceId, amount]) => {
    const resource = resourceById(state, resourceId);
    return `<div class="calculation-card">
      ${resourceDot(resourceId)}
      <div><strong>${escapeHtml(resource?.name ?? resourceId)}</strong>
      <span>${formatAmount(amount)} ${
      escapeHtml(resource?.unit ?? "")
    }</span></div>
    </div>`;
  }).join("");
  return cards || `<p class="calculation-empty">${emptyMessage}</p>`;
}

function openInputCalculation(nodeId: string): void {
  const node = state.nodes.find((item) =>
    item.id === nodeId && item.kind === "input"
  );
  if (!node) return;
  const minimum = findMinimumInputBatch(state, node.id, locale);
  const bottleneck = analyzeBottlenecks(state, node.id, locale);
  const auxiliaryCards = Object.entries(bottleneck.auxiliaryTotals).map(
    ([id, amount]) => {
      const auxiliary = state.auxiliaries.find((item) => item.id === id);
      return `<div class="calculation-card auxiliary">
        <span class="aux-dot" style="--aux-color:${
        auxiliary?.color ?? "#60a5fa"
      }">＋</span>
        <div><strong>${
        escapeHtml(auxiliary?.name ?? t("results.auxiliaryFallback"))
      }</strong><span>${formatAmount(amount)} ${
        escapeHtml(auxiliary?.unit ?? "")
      }</span></div>
      </div>`;
    },
  ).join("");
  const minimumCards = (node.inputSupplies ?? []).map((supply) => {
    const resource = resourceById(state, supply.resourceId);
    const amount = minimum.exact ? minimum.amounts[supply.id] ?? 0 : null;
    return `<div class="calculation-card minimum-card">
      ${resourceDot(supply.resourceId)}
      <div><strong>${escapeHtml(resource?.name ?? supply.resourceId)}</strong>
      <span>${
      amount === null
        ? "—"
        : `${formatAmount(amount)} ${escapeHtml(resource?.unit ?? "")}`
    }</span></div>
    </div>`;
  }).join("");
  const bottleneckNames = bottleneck.bottleneckNodeIds.map((id) => {
    const machineNode = state.nodes.find((item) => item.id === id);
    return machineNode ? nodeTitle(machineNode) : id;
  });
  const machineRows = bottleneck.machines.map((stat) => {
    const machineNode = state.nodes.find((item) => item.id === stat.nodeId);
    const bottleneckClass = bottleneck.bottleneckNodeIds.includes(stat.nodeId)
      ? " is-bottleneck"
      : "";
    return `<div class="schedule-machine-row${bottleneckClass}">
      <div class="schedule-machine-name"><strong>${
      escapeHtml(machineNode ? nodeTitle(machineNode) : stat.nodeId)
    }</strong><small>${
      bottleneck.bottleneckNodeIds.includes(stat.nodeId)
        ? t("calculation.bottleneckBadge")
        : ""
    }</small></div>
      <div class="utilization-meter"><i style="width:${
      Math.min(100, stat.utilization * 100)
    }%"></i></div>
      <span>${formatAmount(stat.utilization * 100, 1)}%</span>
      <span>${stat.cycles} ${t("node.cycle")}</span>
      <span>${formatAmount(stat.busyTime)}s</span>
      <span>${formatAmount(stat.materialWaitTime)}s</span>
    </div>`;
  }).join("");
  const allWarnings = [
    ...minimum.warnings,
    ...bottleneck.warnings,
  ].filter((warning, index, values) => values.indexOf(warning) === index);
  const loopCards = bottleneck.closedLoops.map((loop, index) => {
    const loopNodeIds = new Set(loop.nodeIds);
    const route: string[] = [];
    let currentId = loop.nodeIds[0];
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const routeNode = state.nodes.find((item) => item.id === currentId);
      if (routeNode) route.push(nodeTitle(routeNode));
      const nextEdge = state.edges.find((edge) =>
        edge.sourceNodeId === currentId &&
        loopNodeIds.has(edge.targetNodeId) &&
        !visited.has(edge.targetNodeId)
      ) ?? state.edges.find((edge) =>
        edge.sourceNodeId === currentId &&
        loopNodeIds.has(edge.targetNodeId)
      );
      currentId = nextEdge?.targetNodeId ?? "";
    }
    if (route.length) route.push(route[0]);
    const renderLoopResources = (
      values: Record<string, number>,
      empty: string,
    ): string => {
      const items = Object.entries(values).map(([resourceId, amount]) => {
        const resource = resourceById(state, resourceId);
        return `<span>${resourceDot(resourceId)}<b>${
          escapeHtml(resource?.name ?? resourceId)
        }</b><em>${formatAmount(amount)} ${
          escapeHtml(resource?.unit ?? "")
        }</em></span>`;
      }).join("");
      return items || `<small>${empty}</small>`;
    };
    const loopBottlenecks = loop.bottleneckNodeIds.map((id) => {
      const machineNode = state.nodes.find((item) => item.id === id);
      return machineNode ? nodeTitle(machineNode) : id;
    });
    return `<article class="closed-loop-card">
      <header><div><span>${
      t("calculation.closedLoopIndex", {
        index: index + 1,
      })
    }</span><strong>${
      t("calculation.closedLoopActive", {
        count: loop.completedCycles,
      })
    }</strong></div><b>↻</b></header>
      <div class="closed-loop-route">${route.map(escapeHtml).join(" → ")}</div>
      <div class="closed-loop-metrics">
        <div><small>${t("calculation.loopInitialCharge")}</small>
          <div>${
      renderLoopResources(
        loop.initialResources,
        t("calculation.loopNoInitialCharge"),
      )
    }</div>
        </div>
        <div><small>${t("calculation.loopCirculating")}</small>
          <div>${
      renderLoopResources(
        loop.circulatingResources,
        t("calculation.loopNoCirculating"),
      )
    }</div>
        </div>
      </div>
      <footer><span>${t("calculation.loopNominalTime")}: <b>${
      formatAmount(loop.nominalCycleTime)
    }s</b></span><span>${t("calculation.loopBottleneck")}: <b>${
      escapeHtml(
        loopBottlenecks.join(", ") || t("calculation.loopNoBottleneck"),
      )
    }</b></span></footer>
    </article>`;
  }).join("");
  modal(`<div class="modal calculation-modal">
    <div class="modal-header">
      <div><span class="eyebrow">${t("calculation.kicker")}</span><h2>${
    escapeHtml(nodeTitle(node))
  }</h2></div>
      <button type="button" data-action="close-modal" aria-label="${
    t("common.close")
  }">×</button>
    </div>
    <div class="calculation-summary">
      <div><small>${t("calculation.elapsedTime")}</small><strong>${
    formatAmount(bottleneck.elapsedTime)
  }s</strong></div>
      <div><small>${t("calculation.expectedValue")}</small><strong>${
    t("calculation.applied")
  }</strong></div>
      <div><small>${t("calculation.status")}</small><strong>${
    allWarnings.length
      ? t("results.needsReview", { count: allWarnings.length })
      : t("results.flowHealthy")
  }</strong></div>
    </div>
    <div class="calculation-section">
      <h3>${t("calculation.outputs")}</h3>
      <div class="calculation-grid">${
    resultResourceCards(
      bottleneck.outputs,
      t("calculation.noOutputs"),
    )
  }</div>
    </div>
    <div class="calculation-section minimum-section">
      <div class="calculation-section-heading">
        <div><h3>${t("calculation.minimumTitle")}</h3><small>${
    minimum.exact
      ? t("calculation.minimumExact")
      : t("calculation.minimumUnavailable")
  }</small></div>
        ${
    minimum.exact
      ? `<button data-action="apply-minimum-input" data-node-id="${node.id}">${
        t("calculation.applyMinimum")
      }</button>`
      : ""
  }
      </div>
      <div class="calculation-grid">${
    minimumCards ||
    `<p class="calculation-empty">${t("inspector.noInputSupplies")}</p>`
  }</div>
      <p class="analysis-note">${
    t("calculation.minimumChecked", {
      count: minimum.evaluatedCandidates,
    })
  }</p>
      <p class="analysis-note">${t("calculation.minimumScope")}</p>
    </div>
    <div class="calculation-section bottleneck-section">
      <div class="calculation-section-heading">
        <div><h3>${t("calculation.bottleneckTitle")}</h3><small>${
    bottleneckNames.length
      ? t("calculation.bottleneckSummary", {
        names: bottleneckNames.join(", "),
      })
      : t("calculation.noBottleneck")
  }</small></div>
      </div>
      ${
    machineRows
      ? `<div class="schedule-machine-header">
          <span>${t("calculation.machine")}</span><span>${
        t("calculation.utilization")
      }</span><span></span><span>${t("calculation.cycles")}</span>
          <span>${t("calculation.busyTime")}</span><span>${
        t("calculation.materialWait")
      }</span>
        </div>
        <div class="schedule-machine-list">${machineRows}</div>`
      : `<p class="calculation-empty">${t("calculation.noSchedule")}</p>`
  }
    </div>
    ${
    loopCards
      ? `<div class="calculation-section closed-loop-section">
          <div class="calculation-section-heading"><div><h3>${
        t("calculation.closedLoops")
      }</h3><small>${t("calculation.closedLoopHelp")}</small></div></div>
          <div class="closed-loop-list">${loopCards}</div>
        </div>`
      : ""
  }
    <div class="calculation-section">
      <h3>${t("calculation.remaining")}</h3>
      <div class="calculation-grid">${
    resultResourceCards(
      bottleneck.remainingResources,
      t("calculation.noRemaining"),
    )
  }</div>
    </div>
    <div class="calculation-section">
      <h3>${t("calculation.auxiliaries")}</h3>
      <div class="calculation-grid">${
    auxiliaryCards ||
    `<p class="calculation-empty">${t("calculation.noAuxiliaries")}</p>`
  }</div>
    </div>
    ${
    allWarnings.length
      ? `<div class="calculation-warnings"><h3>${
        t("calculation.warnings")
      }</h3><ul>${
        allWarnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")
      }</ul></div>`
      : ""
  }
    <div class="modal-actions"><button type="button" class="primary-button" data-action="close-modal">${
    t("common.confirm")
  }</button></div>
  </div>`);
}

function renderMachineLibrary(machine: MachineDefinition): string {
  const recipes = recipesForMachine(state, machine.id);
  return `
    <div class="machine-library-item">
      <button class="palette-item" draggable="true" data-palette="machine" data-id="${machine.id}">
        <span class="palette-icon machine ${
    machine.imageDataUrl ? "has-image" : ""
  }">${machineVisual(machine.id)}</span>
        <div><strong>${escapeHtml(machine.name)}</strong><small>${
    t("library.machineRecipeCount", { count: recipes.length })
  }</small></div>
        <i>⠿</i>
      </button>
      <div class="definition-actions machine-actions">
        <button data-action="set-image" data-kind="machine" data-id="${machine.id}" title="${
    t("library.imageRegisterTitle")
  }" aria-label="${t("library.imageRegisterTitle")}">▣</button>
        <button data-action="edit-definition" data-kind="machine" data-id="${machine.id}" title="${
    t("library.machineEditTitle")
  }" aria-label="${t("library.machineEditTitle")}">✎</button>
        <button data-action="add-recipe" data-machine="${machine.id}" title="${
    t("library.recipeAddTitle")
  }" aria-label="${t("library.recipeAddTitle")}">＋</button>
        <button data-action="request-delete" data-kind="machine" data-id="${machine.id}" title="${
    t("library.machineDeleteTitle")
  }" aria-label="${t("library.machineDeleteTitle")}">×</button>
      </div>
      <div class="machine-recipes">
        ${
    recipes.map((recipe) => `
          <div><span>${escapeHtml(recipe.id)}</span>
            <div class="recipe-actions">
              <button data-action="edit-definition" data-kind="recipe" data-id="${recipe.id}" title="${
      t("library.recipeEditTitle")
    }" aria-label="${t("library.recipeEditTitle")}">✎</button>
              <button data-action="request-delete" data-kind="recipe" data-id="${recipe.id}" title="${
      t("library.recipeDeleteTitle")
    }" aria-label="${t("library.recipeDeleteTitle")}">×</button>
            </div>
          </div>`).join("")
  }
      </div>
    </div>`;
}

function renderLibraryDrawer(): string {
  if (!activeLibraryTab) return "";
  const panels = {
    resources: {
      kicker: "RESOURCE CATALOG",
      title: t("library.resources"),
      action: "add-resource",
      body: `<div class="drawer-resource-list">${
        state.resources.map((resource) => `
          <div class="drawer-list-item">${resourceDot(resource.id)}
            <div class="drawer-item-copy"><strong>${
          escapeHtml(resource.name)
        }</strong><small>${escapeHtml(resource.unit)}</small></div>
            <div class="definition-actions">
              <button data-action="set-image" data-kind="resource" data-id="${resource.id}" title="${
          t("library.imageRegisterTitle")
        }" aria-label="${t("library.imageRegisterTitle")}">▣</button>
              <button data-action="edit-definition" data-kind="resource" data-id="${resource.id}" title="${
          t("library.resourceEditTitle")
        }" aria-label="${t("library.resourceEditTitle")}">✎</button>
              <button data-action="request-delete" data-kind="resource" data-id="${resource.id}" title="${
          t("library.resourceDeleteTitle")
        }" aria-label="${t("library.resourceDeleteTitle")}">×</button>
            </div>
          </div>`).join("")
      }</div>`,
    },
    auxiliaries: {
      kicker: "CUSTOM METRICS",
      title: t("library.metrics"),
      action: "add-auxiliary",
      body: `<div class="drawer-list">${
        state.auxiliaries.map((auxiliary) => `
          <div class="drawer-list-item">
            <span class="aux-dot" style="--aux-color:${auxiliary.color}">＋</span>
            <div class="drawer-item-copy"><strong>${
          escapeHtml(auxiliary.name)
        }</strong><small>${escapeHtml(auxiliary.unit)}</small></div>
            <div class="definition-actions">
              <button data-action="edit-definition" data-kind="auxiliary" data-id="${auxiliary.id}" title="${
          t("library.metricEditTitle")
        }" aria-label="${t("library.metricEditTitle")}">✎</button>
              <button data-action="request-delete" data-kind="auxiliary" data-id="${auxiliary.id}" title="${
          t("library.metricDeleteTitle")
        }" aria-label="${t("library.metricDeleteTitle")}">×</button>
            </div>
          </div>`).join("")
      }</div>`,
    },
    machines: {
      kicker: "MACHINE LIBRARY",
      title: t("library.machines"),
      action: "add-machine",
      body: `<div class="palette-list">${
        state.machines.map(renderMachineLibrary).join("")
      }</div>`,
    },
    utilities: {
      kicker: "FLOW UTILITIES",
      title: t("library.flowTools"),
      action: "",
      body: `<div class="drawer-utility-list">
        <button draggable="true" data-palette="source"><b>↳</b><div><strong>${
        t("utility.source.name")
      }</strong><small>${t("utility.source.description")}</small></div></button>
        <button draggable="true" data-palette="input"><b>⇥</b><div><strong>${
        t("utility.input.name")
      }</strong><small>${t("utility.input.description")}</small></div></button>
        <button draggable="true" data-palette="splitter"><b>⑂</b><div><strong>${
        t("utility.splitter.name")
      }</strong><small>${
        t("utility.splitter.description")
      }</small></div></button>
        <button draggable="true" data-palette="merger"><b>⑃</b><div><strong>${
        t("utility.merger.name")
      }</strong><small>${t("utility.merger.description")}</small></div></button>
      </div>`,
    },
  } as const;
  const panel = panels[activeLibraryTab];
  return `<aside class="library-drawer${
    animateLibraryDrawer ? " is-opening" : ""
  }">
    <div class="drawer-heading">
      <div><span class="eyebrow">${panel.kicker}</span><h2>${panel.title}</h2></div>
      <div>${
    panel.action
      ? `<button data-action="${panel.action}" class="drawer-add">${
        t("common.add")
      }</button>`
      : ""
  }<button data-action="close-library" class="drawer-close" aria-label="${
    t("common.close")
  }">×</button></div>
    </div>
    ${panel.body}
    <p class="drag-hint">${
    ["machines", "utilities"].includes(activeLibraryTab)
      ? t("library.dragToCanvas")
      : t("library.globalDefinitions")
  }</p>
  </aside>`;
}

function renderTopMenu(
  menu: NonNullable<typeof activeTopMenu>,
): string {
  if (activeTopMenu !== menu) return "";
  if (menu === "project") {
    return `<div class="top-menu-dropdown">
      <button data-action="request-new-project"><b>${
      t("menu.newProject")
    }</b><kbd>Ctrl+N</kbd></button>
      <span class="menu-separator"></span>
      <button data-action="open-project">${
      t("menu.openProject")
    } <kbd>Ctrl+O</kbd></button>
      <button data-action="save-project"><b>${
      t("menu.saveProject")
    }</b><kbd>Ctrl+S</kbd></button>
      <button data-action="save-project-as">${
      t("menu.saveProjectAs")
    } <kbd>Ctrl+Shift+S</kbd></button>
    </div>`;
  }
  if (menu === "file") {
    return `<div class="top-menu-dropdown file-dropdown">
      <small>${t("menu.template")}</small>
      <button data-action="import-template">${t("menu.importTemplate")}</button>
      <button data-action="export-template">${t("menu.exportTemplate")}</button>
      <span class="menu-separator"></span>
      <button data-action="open-file-menu">${t("menu.fileGuide")}</button>
    </div>`;
  }
  if (menu === "edit") {
    return `<div class="top-menu-dropdown">
      <button data-action="undo" ${undoStack.length ? "" : "disabled"}>${
      t("menu.undo")
    } <kbd>Ctrl+Z</kbd></button>
      <button data-action="redo" ${redoStack.length ? "" : "disabled"}>${
      t("menu.redo")
    } <kbd>Ctrl+Shift+Z</kbd></button>
      <span class="menu-separator"></span>
      <button data-action="delete-selection" ${
      selectedNodeIds.size || selectedEdgeId ? "" : "disabled"
    }>${t("menu.deleteSelection")} <kbd>Delete</kbd></button>
    </div>`;
  }
  return `<div class="top-menu-dropdown">
    <button data-action="theme">${t("menu.switchTheme")} <kbd>${
    theme === "dark" ? "Light" : "Dark"
  }</kbd></button>
    <span class="menu-separator"></span>
    <button data-action="zoom-in">${t("menu.zoomIn")} <kbd>Ctrl++</kbd></button>
    <button data-action="zoom-out">${
    t("menu.zoomOut")
  } <kbd>Ctrl+-</kbd></button>
    <button data-action="zoom-reset">${
    t("menu.zoomReset")
  } <kbd>Ctrl+0</kbd></button>
  </div>`;
}

function dismissTopMenu(): void {
  activeTopMenu = null;
  document.querySelectorAll(".top-menu-dropdown").forEach((element) =>
    element.remove()
  );
  document.querySelectorAll(".menu-entry > button.active").forEach((element) =>
    element.classList.remove("active")
  );
}

function render(): void {
  result = simulate(state, locale);
  worldLayout = calculateWorldLayout();
  app.innerHTML = `
    <header class="topbar">
      <div class="top-left">
        <div class="brand"><span class="brand-mark">F</span><strong>Flowforge</strong><em>STUDIO</em></div>
        <nav class="menu-bar" aria-label="${t("menu.aria")}">
          ${
    (["project", "file", "edit", "view"] as const).map((menu) => `
            <div class="menu-entry">
              <button data-action="top-menu" data-menu="${menu}" class="${
      activeTopMenu === menu ? "active" : ""
    }">${
      {
        project: t("menu.project"),
        file: t("menu.file"),
        edit: t("menu.edit"),
        view: t("menu.view"),
      }[menu]
    }</button>
              ${renderTopMenu(menu)}
            </div>`).join("")
  }
        </nav>
      </div>
      <div class="project-title" title="${
    escapeHtml(projectName ?? t("project.untitled"))
  }"><span>PROJECT /</span><strong>${
    escapeHtml(projectName ?? t("project.untitled"))
  }</strong><i class="${projectIsSaved() ? "" : "is-unsaved"}">● ${
    t(projectIsSaved() ? "project.saved" : "project.unsaved").toUpperCase()
  }</i></div>
      <nav class="top-actions">
        <label class="language-switcher">
          <span>${t("language.label")}</span>
          <select data-language aria-label="${t("language.label")}">
            <option value="ko" ${locale === "ko" ? "selected" : ""}>${
    t("language.ko")
  }</option>
            <option value="en" ${locale === "en" ? "selected" : ""}>${
    t("language.en")
  }</option>
          </select>
        </label>
      </nav>
    </header>
    <main class="workspace">
      <nav class="library-rail" aria-label="${t("library.aria")}">
        <button data-action="library-tab" data-tab="resources" class="${
    activeLibraryTab === "resources" ? "active" : ""
  }" title="${t("library.resources")}" aria-label="${
    t("library.resources")
  }"><span>◉</span></button>
        <button data-action="library-tab" data-tab="auxiliaries" class="${
    activeLibraryTab === "auxiliaries" ? "active" : ""
  }" title="${t("library.metrics")}" aria-label="${
    t("library.metrics")
  }"><span>ϟ</span></button>
        <button data-action="library-tab" data-tab="machines" class="${
    activeLibraryTab === "machines" ? "active" : ""
  }" title="${t("library.machines")}" aria-label="${
    t("library.machines")
  }"><span>⬡</span></button>
        <button data-action="library-tab" data-tab="utilities" class="${
    activeLibraryTab === "utilities" ? "active" : ""
  }" title="${t("library.flowTools")}" aria-label="${
    t("library.flowTools")
  }"><span>⑂</span></button>
      </nav>
      ${renderLibraryDrawer()}
      <section class="canvas-shell">
        <div class="canvas-toolbar">
          <span><b></b> PROCESS MAP <em>${
    t("canvas.nodeCount", { count: state.nodes.length })
  }</em></span>
          <div class="canvas-toolbar-actions"><span class="connection-help">${
    pendingPort
      ? t("canvas.connectHelp")
      : selectedNodeIds.size > 1
      ? t("canvas.selectionHelp", { count: selectedNodeIds.size })
      : t("canvas.defaultHelp")
  }</span>
            <div class="zoom-controls">
              <button data-action="zoom-out" title="${
    t("canvas.zoomOutTitle")
  }" aria-label="${t("menu.zoomOut")}">−</button>
              <button data-action="zoom-reset" title="${
    t("canvas.zoomResetTitle")
  }" aria-label="${t("menu.zoomReset")}">${
    Math.round(zoomLevel * 100)
  }%</button>
              <button data-action="zoom-in" title="${
    t("canvas.zoomInTitle")
  }" aria-label="${t("menu.zoomIn")}">＋</button>
            </div>
          </div>
        </div>
        <div class="canvas" id="canvas">
          <div class="canvas-grid"></div>
          <svg class="edge-layer" id="edge-layer"></svg>
          <div class="node-layer">${state.nodes.map(renderNode).join("")}</div>
          <div class="selection-box" id="selection-box"></div>
          <div class="file-drop-overlay">
            <span>⇩</span>
            <strong>${t("import.dropTitle")}</strong>
            <small>${t("import.dropHelp")}</small>
          </div>
        </div>
        ${renderResults()}
        ${
    selectedNodeIds.size === 1
      ? `<aside class="inspector-panel floating">${renderInspector()}</aside>`
      : ""
  }
      </section>
    </main>
    <div id="modal-root"></div><div id="toast-root"></div>`;
  animateLibraryDrawer = false;
  requestAnimationFrame(drawEdges);
  attachDragHandlers();
}

function calculateWorldLayout(): typeof worldLayout {
  const nodeBounds = state.nodes.map((node) => {
    const ports = portsForNode(state, node);
    const visiblePortRows = Math.max(
      ports.inputs.length,
      ports.outputs.length,
    );
    const estimatedHeight = Math.max(260, 110 + visiblePortRows * 37);
    return {
      left: node.x,
      top: node.y,
      right: node.x + 320,
      bottom: node.y + estimatedHeight,
    };
  });
  const margin = 2000;
  const minX = Math.min(0, ...nodeBounds.map((bounds) => bounds.left)) - margin;
  const minY = Math.min(0, ...nodeBounds.map((bounds) => bounds.top)) - margin;
  const maxX = Math.max(1400, ...nodeBounds.map((bounds) => bounds.right)) +
    margin;
  const maxY = Math.max(900, ...nodeBounds.map((bounds) => bounds.bottom)) +
    margin;
  return {
    offsetX: -minX,
    offsetY: -minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function canvasDimensions(): { width: number; height: number } {
  return { width: worldLayout.width, height: worldLayout.height };
}

function screenToCanvas(
  canvas: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - panOffset.x) / zoomLevel,
    y: (clientY - rect.top - panOffset.y) / zoomLevel,
  };
}

function applyViewportTransform(): void {
  const transform = `translate3d(${
    panOffset.x - worldLayout.offsetX * zoomLevel
  }px, ${
    panOffset.y - worldLayout.offsetY * zoomLevel
  }px, 0) scale(${zoomLevel})`;
  document.querySelectorAll<HTMLElement>(".edge-layer, .node-layer")
    .forEach((element) => element.style.transform = transform);
  const selectionBox = document.querySelector<HTMLElement>("#selection-box");
  if (selectionBox) selectionBox.style.transform = transform;
  const grid = document.querySelector<HTMLElement>(".canvas-grid");
  if (grid) {
    grid.style.backgroundPosition = `${panOffset.x}px ${panOffset.y}px`;
    grid.style.backgroundSize = `${22 * zoomLevel}px ${22 * zoomLevel}px`;
  }
}

function setZoom(
  requestedZoom: number,
  clientX?: number,
  clientY?: number,
): void {
  const canvas = document.querySelector<HTMLElement>("#canvas");
  if (!canvas) return;
  const nextZoom = Math.min(2, Math.max(0.35, requestedZoom));
  const rect = canvas.getBoundingClientRect();
  const anchorX = clientX ?? rect.left + rect.width / 2;
  const anchorY = clientY ?? rect.top + rect.height / 2;
  const logical = screenToCanvas(canvas, anchorX, anchorY);
  panOffset = {
    x: anchorX - rect.left - logical.x * nextZoom,
    y: anchorY - rect.top - logical.y * nextZoom,
  };
  zoomLevel = nextZoom;
  touchProject();
  applyViewportTransform();
  render();
}

function socketElement(
  nodeId: string,
  portId: string,
): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-node="${nodeId}"][data-port="${portId}"] .port-socket`,
  );
}

function socketPosition(
  socket: HTMLElement,
  canvas: HTMLElement,
): { x: number; y: number } {
  const socketRect = socket.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  return {
    x: (socketRect.left + socketRect.width / 2 - canvasRect.left -
          panOffset.x) / zoomLevel + worldLayout.offsetX,
    y: (socketRect.top + socketRect.height / 2 - canvasRect.top -
          panOffset.y) / zoomLevel + worldLayout.offsetY,
  };
}

function nodeObstacles(canvas: HTMLElement): EdgeObstacle[] {
  const canvasRect = canvas.getBoundingClientRect();
  return Array.from(
    document.querySelectorAll<HTMLElement>(".flow-node"),
    (node) => {
      const rect = node.getBoundingClientRect();
      return {
        left: (rect.left - canvasRect.left - panOffset.x) / zoomLevel +
          worldLayout.offsetX,
        top: (rect.top - canvasRect.top - panOffset.y) / zoomLevel +
          worldLayout.offsetY,
        right: (rect.right - canvasRect.left - panOffset.x) / zoomLevel +
          worldLayout.offsetX,
        bottom: (rect.bottom - canvasRect.top - panOffset.y) / zoomLevel +
          worldLayout.offsetY,
      };
    },
  );
}

function curvePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const distance = Math.max(70, Math.abs(to.x - from.x) * 0.45);
  const direction = to.x >= from.x ? 1 : -1;
  return `M ${from.x} ${from.y} C ${from.x + distance * direction} ${from.y}, ${
    to.x - distance * direction
  } ${to.y}, ${to.x} ${to.y}`;
}

function drawEdges(): void {
  const canvas = document.querySelector<HTMLElement>("#canvas");
  const svg = document.querySelector<SVGSVGElement>("#edge-layer");
  const layer = document.querySelector<HTMLElement>(".node-layer");
  if (!canvas || !svg || !layer) return;
  const dimensions = canvasDimensions();
  for (const element of [svg, layer]) {
    element.style.width = `${dimensions.width}px`;
    element.style.height = `${dimensions.height}px`;
  }
  svg.setAttribute("viewBox", `0 0 ${dimensions.width} ${dimensions.height}`);
  // Freshly rendered nodes have no transform yet. Apply the camera before
  // measuring their sockets so node and SVG coordinates share one space.
  applyViewportTransform();
  const obstacles = nodeObstacles(canvas);
  const occupiedSegments: EdgeSegment[] = [];
  svg.innerHTML = `
    <defs>
      <filter id="edge-glow" filterUnits="userSpaceOnUse" x="-80" y="-80" width="${
    dimensions.width + 160
  }" height="${
    dimensions.height + 160
  }"><feDropShadow dx="0" dy="0" stdDeviation="2" flood-color="#3b82f6" flood-opacity=".28"/></filter>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"></path>
      </marker>
    </defs>
    <g id="committed-edges">
      ${
    state.edges.map((edge) => {
      const source = socketElement(edge.sourceNodeId, edge.sourcePortId);
      const target = socketElement(edge.targetNodeId, edge.targetPortId);
      if (!source || !target) return "";
      const from = socketPosition(source, canvas);
      const to = socketPosition(target, canvas);
      const resource = resourceById(state, edge.resourceId);
      const flow = result.edgeFlows[edge.id];
      const route = routeOrthogonalEdge(from, to, obstacles, {
        occupiedSegments,
      });
      occupiedSegments.push(...routeCoreSegments(route.points));
      const path = route.d;
      const labelX = route.label.x;
      const labelY = route.label.y;
      return `
          <path class="edge-hit" data-edge-id="${edge.id}" d="${path}"></path>
          <path class="edge-underlay" d="${path}"></path>
          <path class="edge-line ${
        selectedEdgeId === edge.id ? "is-selected" : ""
      }" style="--edge-color:${
        resource?.color ?? "#3b82f6"
      }" d="${path}" marker-end="url(#arrow)"></path>
          ${
        flow !== undefined
          ? `<g class="edge-label"><rect x="${labelX - 27}" y="${
            labelY - 12
          }" width="54" height="24" rx="12"></rect><text x="${labelX}" y="${
            labelY + 3.5
          }">${formatAmount(flow, 1)}</text></g>`
          : ""
      }
          ${
        selectedEdgeId === edge.id
          ? `<g class="edge-delete-control" data-action="delete-edge" data-edge-id="${edge.id}" transform="translate(${
            labelX + 39
          } ${labelY})">
              <circle r="13"></circle><text y="1">×</text>
            </g>`
          : ""
      }`;
    }).join("")
  }
    </g>
    <path id="live-edge" class="live-edge"></path>`;
  drawLiveEdge();
}

function drawLiveEdge(): void {
  const canvas = document.querySelector<HTMLElement>("#canvas");
  const live = document.querySelector<SVGPathElement>("#live-edge");
  if (!canvas || !live || !pendingPort) return;
  const socket = socketElement(pendingPort.nodeId, pendingPort.portId);
  if (!socket) return;
  const fixed = socketPosition(socket, canvas);
  const pointerInLayer = {
    x: pointerPosition.x + worldLayout.offsetX,
    y: pointerPosition.y + worldLayout.offsetY,
  };
  const from = pendingPort.direction === "output" ? fixed : pointerInLayer;
  const to = pendingPort.direction === "output" ? pointerInLayer : fixed;
  live.setAttribute("d", curvePath(from, to));
}

function attachDragHandlers(): void {
  document.querySelectorAll<HTMLElement>("[draggable][data-palette]").forEach(
    (item) => {
      item.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData(
          "application/json",
          JSON.stringify({ kind: item.dataset.palette, id: item.dataset.id }),
        );
      });
    },
  );

  const canvas = document.querySelector<HTMLElement>("#canvas");
  const isFileDrag = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");
  canvas?.addEventListener("dragenter", (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    canvas.classList.add("is-file-dragging");
  });
  canvas?.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (isFileDrag(event)) canvas.classList.add("is-file-dragging");
  });
  canvas?.addEventListener("dragleave", (event) => {
    if (
      event.relatedTarget instanceof Node &&
      canvas.contains(event.relatedTarget)
    ) return;
    canvas.classList.remove("is-file-dragging");
  });
  canvas?.addEventListener("drop", async (event) => {
    event.preventDefault();
    canvas.classList.remove("is-file-dragging");
    const file = event.dataTransfer?.files[0];
    if (file) {
      await importDroppedFile(file);
      return;
    }
    try {
      const data = JSON.parse(
        event.dataTransfer?.getData("application/json") ?? "{}",
      ) as { kind: NodeKind; id?: string };
      const position = screenToCanvas(canvas, event.clientX, event.clientY);
      addNode(
        data.kind,
        position.x - 105,
        position.y - 50,
        data.id,
      );
    } catch {
      showToast(t("toast.nodeAddFailed"), "error");
    }
  });
  canvas?.addEventListener("auxclick", (event) => {
    if (event.button === 1) event.preventDefault();
  });
  canvas?.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.1 : 0.9;
    setZoom(zoomLevel * factor, event.clientX, event.clientY);
  }, { passive: false });
  canvas?.addEventListener("pointerdown", (event) => {
    dismissTopMenu();
    const target = event.target as HTMLElement;

    if (event.button === 1) {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add("is-panning");
      const start = { x: event.clientX, y: event.clientY };
      const origin = { ...panOffset };
      let moved = false;
      const move = (moveEvent: PointerEvent) => {
        moved = moved ||
          Math.abs(moveEvent.clientX - start.x) +
                Math.abs(moveEvent.clientY - start.y) > 1;
        panOffset = {
          x: origin.x + moveEvent.clientX - start.x,
          y: origin.y + moveEvent.clientY - start.y,
        };
        applyViewportTransform();
      };
      const up = () => {
        canvas.classList.remove("is-panning");
        canvas.removeEventListener("pointermove", move);
        if (moved) {
          touchProject();
          render();
        }
      };
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", up, { once: true });
      return;
    }
    if (
      target.closest(".flow-node") || target.closest(".port-row") ||
      target.closest(".edge-hit") || target.closest(".edge-delete-control")
    ) return;
    if (event.button !== 0) return;

    const start = screenToCanvas(canvas, event.clientX, event.clientY);
    const box = document.querySelector<HTMLElement>("#selection-box");
    let dragged = false;
    canvas.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const current = screenToCanvas(
        canvas,
        moveEvent.clientX,
        moveEvent.clientY,
      );
      dragged = dragged ||
        Math.abs(current.x - start.x) + Math.abs(current.y - start.y) > 5;
      if (!box || !dragged) return;
      box.classList.add("visible");
      box.style.left = `${
        Math.min(start.x, current.x) + worldLayout.offsetX
      }px`;
      box.style.top = `${Math.min(start.y, current.y) + worldLayout.offsetY}px`;
      box.style.width = `${Math.abs(current.x - start.x)}px`;
      box.style.height = `${Math.abs(current.y - start.y)}px`;
    };
    const up = (upEvent: PointerEvent) => {
      canvas.removeEventListener("pointermove", move);
      const end = screenToCanvas(canvas, upEvent.clientX, upEvent.clientY);
      if (dragged) {
        const area = {
          left: Math.min(start.x, end.x),
          top: Math.min(start.y, end.y),
          right: Math.max(start.x, end.x),
          bottom: Math.max(start.y, end.y),
        };
        selectedNodeIds = new Set(
          state.nodes.filter((node) => {
            const element = document.querySelector<HTMLElement>(
              `[data-node-id="${node.id}"]`,
            );
            const width = element?.offsetWidth ?? 236;
            const height = element?.offsetHeight ?? 112;
            return node.x < area.right && node.x + width > area.left &&
              node.y < area.bottom && node.y + height > area.top;
          }).map((node) => node.id),
        );
        selectedNodeId = selectedNodeIds.size === 1
          ? [...selectedNodeIds][0]
          : null;
      } else {
        selectedNodeIds.clear();
        selectedNodeId = null;
        selectedEdgeId = null;
      }
      render();
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up, { once: true });
  });

  document.querySelectorAll<HTMLElement>(".port-row").forEach((port) => {
    port.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const nodeId = port.dataset.node;
      const portId = port.dataset.port;
      const direction = port.dataset.direction as PortDirection | undefined;
      if (!nodeId || !portId || !direction || !canvas) return;
      if (port.dataset.finalOutput === "true") {
        event.stopPropagation();
        return;
      }
      pendingPort = { nodeId, portId, direction };
      port.classList.add("is-pending");
      document.querySelectorAll<HTMLElement>(".port-row").forEach(
        (candidate) => {
          const candidateDirection = candidate.dataset.direction as
            | PortDirection
            | undefined;
          if (
            candidate.dataset.node && candidate.dataset.port &&
            candidateDirection &&
            isCompatiblePort(
              candidate.dataset.node,
              candidate.dataset.port,
              candidateDirection,
            )
          ) candidate.classList.add("is-compatible");
        },
      );
      const updatePointer = (moveEvent: PointerEvent) => {
        pointerPosition = screenToCanvas(
          canvas,
          moveEvent.clientX,
          moveEvent.clientY,
        );
        drawLiveEdge();
      };
      updatePointer(event);
      const up = (upEvent: PointerEvent) => {
        document.removeEventListener("pointermove", updatePointer);
        const releaseTarget = document.elementFromPoint(
          upEvent.clientX,
          upEvent.clientY,
        )?.closest<HTMLElement>(".port-row");
        if (
          releaseTarget &&
          !(releaseTarget.dataset.node === nodeId &&
            releaseTarget.dataset.port === portId)
        ) {
          connectPort(releaseTarget);
        } else {
          pendingPort = null;
          document.querySelectorAll(
            ".port-row.is-pending, .port-row.is-compatible",
          ).forEach((item) =>
            item.classList.remove("is-pending", "is-compatible")
          );
          document.querySelector<SVGPathElement>("#live-edge")
            ?.setAttribute("d", "");
        }
      };
      document.addEventListener("pointermove", updatePointer);
      document.addEventListener("pointerup", up, { once: true });
    });
  });

  document.querySelectorAll<HTMLElement>("[data-drag-handle]").forEach(
    (handle) => {
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement).closest("button")) return;
        event.stopPropagation();
        const element = handle.closest<HTMLElement>(".flow-node");
        const node = state.nodes.find((item) =>
          item.id === element?.dataset.nodeId
        );
        if (!element || !node) return;
        if (!selectedNodeIds.has(node.id)) {
          selectedNodeIds = new Set([node.id]);
          selectedNodeId = node.id;
          document.querySelectorAll(".flow-node.is-selected").forEach((item) =>
            item.classList.remove("is-selected")
          );
          element.classList.add("is-selected");
        }
        element.setPointerCapture(event.pointerId);
        const start = { x: event.clientX, y: event.clientY };
        const movingNodes = state.nodes.filter((item) =>
          selectedNodeIds.has(item.id)
        );
        const origins = new Map(
          movingNodes.map((item) => [item.id, { x: item.x, y: item.y }]),
        );
        let moved = false;
        const move = (moveEvent: PointerEvent) => {
          if (!moved) {
            moved = true;
            checkpoint();
          }
          for (const item of movingNodes) {
            const origin = origins.get(item.id);
            if (!origin) continue;
            item.x = origin.x +
              (moveEvent.clientX - start.x) / zoomLevel;
            item.y = origin.y +
              (moveEvent.clientY - start.y) / zoomLevel;
            const itemElement = document.querySelector<HTMLElement>(
              `[data-node-id="${item.id}"]`,
            );
            if (itemElement) {
              itemElement.style.left = `${item.x + worldLayout.offsetX}px`;
              itemElement.style.top = `${item.y + worldLayout.offsetY}px`;
            }
          }
          drawEdges();
        };
        const up = () => {
          element.removeEventListener("pointermove", move);
          if (moved) {
            suppressNextNodeClick = true;
            save();
            render();
          }
        };
        element.addEventListener("pointermove", move);
        element.addEventListener("pointerup", up, { once: true });
      });
    },
  );
}

function addNode(
  kind: NodeKind,
  x: number,
  y: number,
  machineId?: string,
): void {
  if (!state.resources.length && kind !== "machine") {
    showToast(t("toast.addResourceFirst"), "error");
    return;
  }
  const machine = machineId ? machineById(state, machineId) : undefined;
  const firstRecipe = machineId
    ? recipesForMachine(state, machineId)[0]
    : undefined;
  const labels: Record<NodeKind, string> = {
    machine: machine?.name ?? t("node.default.machine"),
    source: t("node.default.source"),
    input: t("node.default.input"),
    extract: t("node.default.extract"),
    splitter: t("node.default.splitter"),
    merger: t("node.default.merger"),
  };
  const node: FlowNode = {
    id: uid("node"),
    kind,
    title: labels[kind],
    titleKey: machine ? undefined : defaultNodeTitleKeys[kind],
    x,
    y,
    machineId,
    activeRecipeIds: firstRecipe ? [firstRecipe.id] : [],
    multiRecipe: false,
    resourceId: kind === "source" ? state.resources[0]?.id : undefined,
    inputSupplies: kind === "input" && state.resources[0]
      ? [{
        id: uid("supply"),
        resourceId: state.resources[0].id,
        amount: 100,
      }]
      : undefined,
    splitRatios: kind === "splitter" ? [0.5, 0.5] : undefined,
  };
  checkpoint();
  state.nodes.push(node);
  selectedNodeId = node.id;
  selectedNodeIds = new Set([node.id]);
  save();
  render();
  showToast(t("toast.nodeAdded", { name: nodeTitle(node) }));
}

function refreshInferredResources(): void {
  const finalOutputKeys = new Set<string>();
  for (const node of state.nodes) {
    const outputIds = new Set(
      portsForNode(state, node).outputs.map((port) => port.id),
    );
    const validFinalOutputs = (node.finalOutputPortIds ?? []).filter((portId) =>
      outputIds.has(portId)
    );
    if (validFinalOutputs.length) {
      node.finalOutputPortIds = [...new Set(validFinalOutputs)];
      for (const portId of node.finalOutputPortIds) {
        finalOutputKeys.add(`${node.id}:${portId}`);
      }
    } else {
      delete node.finalOutputPortIds;
    }
  }
  state.edges = state.edges.filter((edge) =>
    !finalOutputKeys.has(`${edge.sourceNodeId}:${edge.sourcePortId}`)
  );
  for (const node of state.nodes) {
    if (!["extract", "splitter", "merger"].includes(node.kind)) continue;
    node.resourceId = state.edges.find((edge) => edge.targetNodeId === node.id)
      ?.resourceId;
  }
}

function toggleFinalOutput(nodeId: string, portId: string): void {
  const node = state.nodes.find((item) => item.id === nodeId);
  const output = node
    ? portsForNode(state, node).outputs.find((port) => port.id === portId)
    : undefined;
  if (!node || !output) return;

  checkpoint();
  const finalOutputs = new Set(node.finalOutputPortIds ?? []);
  const enabled = !finalOutputs.has(portId);
  if (enabled) finalOutputs.add(portId);
  else finalOutputs.delete(portId);
  node.finalOutputPortIds = [...finalOutputs];
  if (!node.finalOutputPortIds.length) delete node.finalOutputPortIds;
  refreshInferredResources();
  pendingPort = null;
  selectedEdgeId = null;
  save();
  render();
  showToast(
    t(enabled ? "toast.finalOutputEnabled" : "toast.finalOutputDisabled"),
  );
}

function connectPort(target: HTMLElement): void {
  const nodeId = target.dataset.node;
  const portId = target.dataset.port;
  const direction = target.dataset.direction as PortDirection | undefined;
  if (!nodeId || !portId || !direction) return;
  if (target.dataset.finalOutput === "true") {
    pendingPort = null;
    showToast(t("engine.connection.finalOutput"), "error");
    render();
    return;
  }
  if (!pendingPort) {
    pendingPort = { nodeId, portId, direction };
    render();
    return;
  }
  if (pendingPort.nodeId === nodeId && pendingPort.portId === portId) {
    pendingPort = null;
    render();
    return;
  }
  if (pendingPort.direction === direction) {
    pendingPort = { nodeId, portId, direction };
    render();
    return;
  }

  const firstNode = state.nodes.find((node) => node.id === pendingPort?.nodeId);
  const secondNode = state.nodes.find((node) => node.id === nodeId);
  if (!firstNode || !secondNode) return;
  const sourceNode = pendingPort.direction === "output"
    ? firstNode
    : secondNode;
  const targetNode = pendingPort.direction === "input" ? firstNode : secondNode;
  const sourcePortId = pendingPort.direction === "output"
    ? pendingPort.portId
    : portId;
  const targetPortId = pendingPort.direction === "input"
    ? pendingPort.portId
    : portId;
  const error = validateConnection(
    state,
    sourceNode,
    sourcePortId,
    targetNode,
    targetPortId,
    locale,
  );
  if (error) {
    pendingPort = null;
    showToast(error, "error");
    render();
    return;
  }
  const sourcePort = portsForNode(state, sourceNode).outputs.find((port) =>
    port.id === sourcePortId
  );
  if (!sourcePort?.resourceId) return;
  const replaced = state.edges.some((edge) =>
    edge.targetNodeId === targetNode.id &&
    edge.targetPortId === targetPortId
  );
  checkpoint();
  state.edges = state.edges.filter((edge) =>
    !(edge.targetNodeId === targetNode.id &&
      edge.targetPortId === targetPortId)
  );
  state.edges.push({
    id: uid("edge"),
    sourceNodeId: sourceNode.id,
    sourcePortId,
    targetNodeId: targetNode.id,
    targetPortId,
    resourceId: sourcePort.resourceId,
  });
  refreshInferredResources();
  pendingPort = null;
  selectedEdgeId = null;
  save();
  render();
  showToast(
    t(replaced ? "toast.connectionReplaced" : "toast.connectionCreated"),
  );
}

function pruneNodeEdges(node: FlowNode): void {
  const ports = portsForNode(state, node);
  const inputs = new Map(
    ports.inputs.map((port) => [port.id, port.resourceId]),
  );
  const outputs = new Map(
    ports.outputs.map((port) => [port.id, port.resourceId]),
  );
  node.finalOutputPortIds = (node.finalOutputPortIds ?? []).filter((portId) =>
    outputs.has(portId)
  );
  if (!node.finalOutputPortIds.length) delete node.finalOutputPortIds;
  const finalOutputs = new Set(node.finalOutputPortIds ?? []);
  state.edges = state.edges.filter((edge) =>
    edge.sourceNodeId === node.id
      ? outputs.get(edge.sourcePortId) === edge.resourceId &&
        !finalOutputs.has(edge.sourcePortId)
      : edge.targetNodeId === node.id
      ? inputs.get(edge.targetPortId) === edge.resourceId
      : true
  );
  refreshInferredResources();
}

function deleteEdge(edgeId: string): void {
  if (!state.edges.some((edge) => edge.id === edgeId)) return;
  checkpoint();
  state.edges = state.edges.filter((edge) => edge.id !== edgeId);
  refreshInferredResources();
  selectedEdgeId = null;
  save();
  render();
  showToast(t("toast.connectionDeleted"));
}

function deleteSelectedNode(nodeId?: string): void {
  const ids = nodeId
    ? new Set([nodeId])
    : selectedNodeIds.size
    ? new Set(selectedNodeIds)
    : selectedNodeId
    ? new Set([selectedNodeId])
    : new Set<string>();
  if (!ids.size) return;
  checkpoint();
  state.nodes = state.nodes.filter((node) => !ids.has(node.id));
  state.edges = state.edges.filter((edge) =>
    !ids.has(edge.sourceNodeId) && !ids.has(edge.targetNodeId)
  );
  refreshInferredResources();
  selectedNodeId = null;
  selectedNodeIds.clear();
  selectedEdgeId = null;
  save();
  render();
}

function showToast(
  message: string,
  type: "success" | "error" = "success",
): void {
  const root = document.querySelector<HTMLElement>("#toast-root");
  if (!root) return;
  root.innerHTML = `<div class="toast ${type}"><span>${
    type === "success" ? "✓" : "!"
  }</span>${escapeHtml(message)}</div>`;
  globalThis.setTimeout(() => root.innerHTML = "", 2600);
}

function modal(content: string): void {
  const root = document.querySelector<HTMLElement>("#modal-root");
  if (root) root.innerHTML = `<div class="modal-backdrop">${content}</div>`;
}

function closeModal(): void {
  const root = document.querySelector<HTMLElement>("#modal-root");
  if (root) root.innerHTML = "";
  pendingDelete = null;
}

async function imageFileToDataUrl(file: File): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
  try {
    const image = new Image();
    image.src = raw;
    await image.decode();
    const maxSize = 320;
    const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext("2d")?.drawImage(
      image,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return canvas.toDataURL("image/webp", 0.84);
  } catch {
    return raw;
  }
}

function imageOwner(
  kind: "resource" | "machine",
  id: string,
): Resource | MachineDefinition | undefined {
  return kind === "resource"
    ? state.resources.find((item) => item.id === id)
    : state.machines.find((item) => item.id === id);
}

function openImageModal(kind: "resource" | "machine", id: string): void {
  const owner = imageOwner(kind, id);
  if (!owner) return;
  modal(`<form class="modal" id="definition-image-form">
    <input type="hidden" name="kind" value="${kind}">
    <input type="hidden" name="id" value="${id}">
    <div class="modal-header">
      <div><span class="eyebrow">CUSTOM IMAGE</span><h2>${
    t("image.modalTitle", { name: escapeHtml(owner.name) })
  }</h2></div>
      <button type="button" data-action="close-modal" aria-label="${
    t("common.close")
  }">×</button>
    </div>
    <div class="image-upload-area">
      ${
    owner.imageDataUrl
      ? `<img src="${escapeHtml(owner.imageDataUrl)}" alt="">`
      : `<span>${kind === "resource" ? "◉" : "⬡"}</span>`
  }
      <div><strong>${t("image.chooseFile")}</strong><small>${
    t("image.thumbnailHelp")
  }</small></div>
      <input name="image" type="file" accept="image/*" required>
    </div>
    <div class="modal-actions">
      ${
    owner.imageDataUrl
      ? `<button type="button" class="danger-button compact" data-action="remove-image" data-kind="${kind}" data-id="${id}">${
        t("image.useDefault")
      }</button>`
      : ""
  }
      <button type="button" class="quiet-button" data-action="close-modal">${
    t("common.cancel")
  }</button>
      <button class="primary-button">${t("image.register")}</button>
    </div>
  </form>`);
}

function definitionName(
  kind: NonNullable<typeof pendingDelete>["kind"],
  id: string,
): string {
  if (kind === "resource") {
    return state.resources.find((item) => item.id === id)?.name ??
      t("definition.fallback.resource");
  }
  if (kind === "auxiliary") {
    return state.auxiliaries.find((item) => item.id === id)?.name ??
      t("definition.fallback.metric");
  }
  if (kind === "machine") {
    return state.machines.find((item) => item.id === id)?.name ??
      t("definition.fallback.machine");
  }
  return state.recipes.find((item) => item.id === id)?.id ??
    t("definition.fallback.recipe");
}

function deletionImpact(
  kind: NonNullable<typeof pendingDelete>["kind"],
  id: string,
): string {
  if (kind === "resource") {
    const recipes = state.recipes.filter((recipe) =>
      [...recipe.inputs, ...recipe.outputs].some((port) =>
        port.resourceId === id
      )
    ).length;
    const nodes = state.nodes.filter((node) =>
      node.resourceId === id ||
      node.inputSupplies?.some((supply) =>
        supply.resourceId === id
      )
    ).length;
    return t("delete.impact.resource", { recipes, nodes });
  }
  if (kind === "machine") {
    const recipes = recipesForMachine(state, id).length;
    const nodes = state.nodes.filter((node) => node.machineId === id).length;
    return t("delete.impact.machine", { recipes, nodes });
  }
  if (kind === "recipe") {
    const nodes = state.nodes.filter((node) =>
      node.activeRecipeIds?.includes(id)
    ).length;
    return t("delete.impact.recipe", { nodes });
  }
  const recipes =
    state.recipes.filter((recipe) =>
      recipe.auxiliaryUses.some((use) => use.auxiliaryId === id)
    ).length;
  return t("delete.impact.metric", { recipes });
}

function openDeleteModal(
  kind: NonNullable<typeof pendingDelete>["kind"],
  id: string,
): void {
  pendingDelete = { kind, id };
  const name = definitionName(kind, id);
  modal(`<div class="modal confirm-modal">
    <div class="modal-header">
      <div><span class="eyebrow danger">DELETE DEFINITION</span><h2>${
    t("delete.modalTitle", { name: escapeHtml(name) })
  }</h2></div>
      <button type="button" data-action="close-modal" aria-label="${
    t("common.close")
  }">×</button>
    </div>
    <div class="delete-warning"><span>!</span><p>${
    escapeHtml(deletionImpact(kind, id))
  }<br>${t("delete.undoHelp")}</p></div>
    <div class="modal-actions">
      <button type="button" class="quiet-button" data-action="close-modal">${
    t("common.cancel")
  }</button>
      <button type="button" class="danger-button compact" data-action="confirm-delete">${
    t("common.delete")
  }</button>
    </div>
  </div>`);
}

function removeRecipes(recipeIds: Set<string>): void {
  state.recipes = state.recipes.filter((recipe) => !recipeIds.has(recipe.id));
  state.edges = state.edges.filter((edge) =>
    ![...recipeIds].some((id) =>
      edge.sourcePortId.startsWith(`${id}:`) ||
      edge.targetPortId.startsWith(`${id}:`)
    )
  );
  for (const node of state.nodes.filter((item) => item.kind === "machine")) {
    node.activeRecipeIds = (node.activeRecipeIds ?? []).filter((id) =>
      !recipeIds.has(id)
    );
    if (!node.activeRecipeIds.length && node.machineId) {
      const fallback = recipesForMachine(state, node.machineId)[0];
      node.activeRecipeIds = fallback ? [fallback.id] : [];
    }
  }
}

function performDefinitionDelete(): void {
  if (!pendingDelete) return;
  const { kind, id } = pendingDelete;
  checkpoint();
  if (kind === "resource") {
    const affectedRecipes = new Set(
      state.recipes.filter((recipe) =>
        [...recipe.inputs, ...recipe.outputs].some((port) =>
          port.resourceId === id
        )
      ).map((recipe) => recipe.id),
    );
    removeRecipes(affectedRecipes);
    state.resources = state.resources.filter((item) => item.id !== id);
    state.edges = state.edges.filter((edge) => edge.resourceId !== id);
    const fallback = state.resources[0]?.id;
    for (const node of state.nodes) {
      if (node.kind === "source" && node.resourceId === id) {
        node.resourceId = fallback;
      }
      if (node.kind === "input") {
        const removedSupplyIds = new Set(
          (node.inputSupplies ?? []).filter((supply) =>
            supply.resourceId === id
          ).map((supply) => supply.id),
        );
        node.inputSupplies = (node.inputSupplies ?? []).filter((supply) =>
          supply.resourceId !== id
        );
        state.edges = state.edges.filter((edge) =>
          edge.sourceNodeId !== node.id ||
          ![...removedSupplyIds].some((supplyId) =>
            edge.sourcePortId === `input-out:${supplyId}`
          )
        );
      }
    }
  }
  if (kind === "auxiliary") {
    state.auxiliaries = state.auxiliaries.filter((item) => item.id !== id);
    for (const recipe of state.recipes) {
      recipe.auxiliaryUses = recipe.auxiliaryUses.filter((use) =>
        use.auxiliaryId !== id
      );
    }
  }
  if (kind === "machine") {
    const recipeIds = new Set(
      recipesForMachine(state, id).map((recipe) => recipe.id),
    );
    removeRecipes(recipeIds);
    const nodeIds = new Set(
      state.nodes.filter((node) => node.machineId === id).map((node) =>
        node.id
      ),
    );
    state.nodes = state.nodes.filter((node) => !nodeIds.has(node.id));
    state.edges = state.edges.filter((edge) =>
      !nodeIds.has(edge.sourceNodeId) && !nodeIds.has(edge.targetNodeId)
    );
    state.machines = state.machines.filter((item) => item.id !== id);
  }
  if (kind === "recipe") removeRecipes(new Set([id]));
  refreshInferredResources();
  pendingDelete = null;
  selectedNodeId = null;
  selectedNodeIds.clear();
  selectedEdgeId = null;
  activeTopMenu = null;
  closeModal();
  save();
  render();
  showToast(t("toast.definitionDeleted"));
}

function currentDefinitions(): DefinitionsPayload {
  return clone({
    resources: state.resources,
    auxiliaries: state.auxiliaries,
    machines: state.machines,
    recipes: state.recipes,
  });
}

function currentChart(): ChartPayload {
  return clone({
    nodes: state.nodes,
    edges: state.edges,
    camera: { x: panOffset.x, y: panOffset.y, zoom: zoomLevel },
  });
}

function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

const jsonFileTypes = [{
  description: "Flowforge JSON",
  accept: { "application/json": [".json"] },
}];

function projectFilePayload(name: string): ProjectFile {
  return {
    kind: "flowforge-project",
    version: 1,
    exportedAt: new Date().toISOString(),
    name,
    definitions: currentDefinitions(),
    chart: currentChart(),
  };
}

function templateFilePayload(name: string): TemplateFile {
  return {
    kind: "flowforge-template",
    version: 1,
    exportedAt: new Date().toISOString(),
    name,
    definitions: currentDefinitions(),
  };
}

function isPickerCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function ensureWritePermission(
  handle: FlowforgeFileHandle,
): Promise<boolean> {
  const options = { mode: "readwrite" as const };
  if (!handle.queryPermission) return true;
  const current = await handle.queryPermission(options);
  if (current === "granted") return true;
  return handle.requestPermission
    ? await handle.requestPermission(options) === "granted"
    : false;
}

async function writeJson(
  handle: FlowforgeFileHandle,
  value: unknown,
): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(value, null, 2));
  await writable.close();
}

async function chooseSaveHandle(
  suggestedName: string,
): Promise<FlowforgeFileHandle | null> {
  const pickerWindow = window as FilePickerWindow;
  if (!pickerWindow.showSaveFilePicker) return null;
  return await pickerWindow.showSaveFilePicker({
    suggestedName,
    types: jsonFileTypes,
  });
}

async function saveProject(saveAs = false): Promise<void> {
  try {
    let handle = saveAs ? null : projectFileHandle;
    const pickerAvailable = !!(window as FilePickerWindow).showSaveFilePicker;
    if (!handle && pickerAvailable) {
      handle = await chooseSaveHandle(
        safeProjectFilename(projectName ?? t("project.untitled")),
      );
      if (!handle) return;
    }

    if (handle) {
      if (!await ensureWritePermission(handle)) {
        showToast(t("toast.filePermissionDenied"), "error");
        return;
      }
      const nextName = projectNameFromFilename(handle.name);
      await writeJson(handle, projectFilePayload(nextName));
      projectFileHandle = handle;
      projectName = nextName;
      await rememberProjectHandle(handle);
    } else {
      const fallbackName = projectName ?? t("project.untitled");
      downloadJson(
        safeProjectFilename(fallbackName),
        projectFilePayload(fallbackName),
      );
      projectName = fallbackName;
      projectFileHandle = null;
      await rememberProjectHandle(null);
    }
    markProjectSaved();
    applyLocale();
    render();
    showToast(t("toast.projectSaved", {
      name: projectName ?? t("project.untitled"),
    }));
  } catch (error) {
    if (!isPickerCancellation(error)) {
      showToast(t("toast.fileSaveFailed"), "error");
    }
  }
}

async function exportTemplate(): Promise<void> {
  try {
    const baseName = projectName ?? t("files.template.defaultName");
    const suggestedName = safeProjectFilename(baseName).replace(
      /\.flowforge\.json$/i,
      ".template.json",
    );
    const handle = await chooseSaveHandle(suggestedName);
    if (handle) {
      if (!await ensureWritePermission(handle)) {
        showToast(t("toast.filePermissionDenied"), "error");
        return;
      }
      const name = projectNameFromFilename(handle.name);
      await writeJson(handle, templateFilePayload(name));
    } else if (!(window as FilePickerWindow).showSaveFilePicker) {
      downloadJson(suggestedName, templateFilePayload(baseName));
    } else {
      return;
    }
    showToast(t("toast.templateExported"));
  } catch (error) {
    if (!isPickerCancellation(error)) {
      showToast(t("toast.fileSaveFailed"), "error");
    }
  }
}

async function chooseAndImportFile(
  kind: "project" | "template",
): Promise<void> {
  const pickerWindow = window as FilePickerWindow;
  if (pickerWindow.showOpenFilePicker) {
    try {
      const [handle] = await pickerWindow.showOpenFilePicker({
        multiple: false,
        types: jsonFileTypes,
      });
      if (!handle) return;
      await importFile(kind, await handle.getFile(), {
        projectHandle: kind === "project" ? handle : null,
      });
    } catch (error) {
      if (!isPickerCancellation(error)) {
        showImportErrors([t("import.fileReadFailed")]);
      }
    }
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (file) await importFile(kind, file);
  }, { once: true });
  input.click();
}

function openFileMenu(): void {
  modal(`<div class="modal file-modal">
    <div class="modal-header">
      <div><span class="eyebrow">PROJECT / TEMPLATE</span><h2>${
    t("files.title")
  }</h2></div>
      <button type="button" data-action="close-modal" aria-label="${
    t("common.close")
  }">×</button>
    </div>
    <div class="file-format-list">
      <section class="project-format">
        <span class="file-format-icon">{P}</span>
        <div><strong>${t("files.project.title")}</strong><p>${
    t("files.project.description")
  }</p><code>*.flowforge.json</code></div>
        <div class="file-format-actions">
          <button data-action="open-project">${t("menu.openProject")}</button>
          <button data-action="save-project">${t("common.save")}</button>
        </div>
      </section>
      <section>
        <span class="file-format-icon">{T}</span>
        <div><strong>${t("files.template.title")}</strong><p>${
    t("files.template.description")
  }</p><code>*.template.json</code></div>
        <div class="file-format-actions">
          <button data-action="import-template">${t("common.import")}</button>
          <button data-action="export-template">${t("common.export")}</button>
        </div>
      </section>
    </div>
    <p class="file-note">${t("files.dataUrlNote")}</p>
  </div>`);
}

function openNewProjectModal(): void {
  activeTopMenu = null;
  modal(`<div class="modal confirm-modal">
    <div class="modal-header">
      <div><span class="eyebrow danger">NEW PROJECT</span><h2>${
    t("newProject.title")
  }</h2></div>
      <button type="button" data-action="close-modal" aria-label="${
    t("common.close")
  }">×</button>
    </div>
    <div class="delete-warning"><span>!</span><p>${
    t("newProject.warning")
  }<br>${t("newProject.undoHelp")}</p></div>
    <div class="modal-actions">
      <button type="button" class="quiet-button" data-action="close-modal">${
    t("common.cancel")
  }</button>
      <button type="button" class="danger-button compact" data-action="confirm-new-project">${
    t("menu.newProject")
  }</button>
    </div>
  </div>`);
}

function createNewProject(): void {
  checkpoint();
  state = clone(initialState);
  projectName = null;
  projectFileHandle = null;
  projectSavedRevision = null;
  void rememberProjectHandle(null);
  panOffset = { x: 0, y: 0 };
  zoomLevel = 1;
  selectedNodeId = null;
  selectedNodeIds.clear();
  selectedEdgeId = null;
  pendingPort = null;
  activeLibraryTab = null;
  activeTopMenu = null;
  closeModal();
  save();
  applyLocale();
  render();
  showToast(t("toast.projectCreated"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDefinitions(
  value: unknown,
): { definitions?: DefinitionsPayload; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { errors: [t("validation.definitionsNotObject")] };
  }
  const keys = ["resources", "auxiliaries", "machines", "recipes"] as const;
  for (const key of keys) {
    if (!Array.isArray(value[key])) {
      errors.push(t("validation.arrayMissing", { key }));
    }
  }
  if (errors.length) return { errors };
  const definitions = value as unknown as DefinitionsPayload;
  const allCollections: Array<[string, Array<{ id: string }>]> = [
    [t("definition.fallback.resource"), definitions.resources],
    [t("definition.fallback.metric"), definitions.auxiliaries],
    [t("definition.fallback.machine"), definitions.machines],
    [t("definition.fallback.recipe"), definitions.recipes],
  ];
  for (const [label, items] of allCollections) {
    const ids = new Set<string>();
    for (const item of items) {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id) {
        errors.push(t("validation.itemInvalidId", { type: label }));
        continue;
      }
      if (ids.has(item.id)) {
        errors.push(
          t("validation.duplicateDefinitionId", {
            type: label,
            id: item.id,
          }),
        );
      }
      ids.add(item.id);
    }
  }
  if (errors.length) return { errors };
  for (const resource of definitions.resources) {
    if (
      typeof resource.name !== "string" ||
      typeof resource.unit !== "string" ||
      typeof resource.color !== "string" ||
      (resource.symbol !== undefined &&
        typeof resource.symbol !== "string") ||
      (resource.category !== undefined &&
        (typeof resource.category !== "string" ||
          !["material", "energy", "utility", "waste"].includes(
            resource.category,
          ))) ||
      (resource.imageDataUrl !== undefined &&
        typeof resource.imageDataUrl !== "string")
    ) {
      errors.push(t("validation.resourceFields", { id: resource.id }));
    }
  }
  for (const auxiliary of definitions.auxiliaries) {
    if (
      typeof auxiliary.name !== "string" ||
      typeof auxiliary.unit !== "string" ||
      typeof auxiliary.color !== "string"
    ) {
      errors.push(t("validation.metricFields", { id: auxiliary.id }));
    }
  }
  for (const machine of definitions.machines) {
    if (
      typeof machine.name !== "string" ||
      typeof machine.description !== "string" ||
      (machine.imageDataUrl !== undefined &&
        typeof machine.imageDataUrl !== "string")
    ) {
      errors.push(t("validation.machineFields", { id: machine.id }));
    }
  }
  for (const recipe of definitions.recipes) {
    if (
      typeof recipe.description !== "string" ||
      typeof recipe.machineId !== "string" ||
      !Number.isFinite(recipe.duration) ||
      normalizeRecipeDuration(recipe.duration) !== recipe.duration
    ) {
      errors.push(t("validation.recipeFields", { id: recipe.id }));
    }
    if (Array.isArray(recipe.inputs) && Array.isArray(recipe.outputs)) {
      for (const port of [...recipe.inputs, ...recipe.outputs]) {
        if (
          !isRecord(port) || typeof port.id !== "string" ||
          typeof port.resourceId !== "string" ||
          !Number.isFinite(port.amount)
        ) {
          errors.push(t("validation.recipePortFields", { id: recipe.id }));
        }
      }
      for (const port of recipe.outputs) {
        if (!isRecord(port)) continue;
        if (
          port.probability !== undefined &&
          (typeof port.probability !== "number" ||
            !Number.isFinite(port.probability) ||
            port.probability < 0 || port.probability > 1)
        ) {
          errors.push(t("validation.recipePortFields", { id: recipe.id }));
        }
      }
    }
    if (Array.isArray(recipe.auxiliaryUses)) {
      for (const use of recipe.auxiliaryUses) {
        if (
          !isRecord(use) || typeof use.auxiliaryId !== "string" ||
          !Number.isFinite(use.amount)
        ) {
          errors.push(t("validation.recipeMetricUse", { id: recipe.id }));
        }
      }
    }
  }
  if (errors.length) return { errors };
  const resourceIds = new Set(definitions.resources.map((item) => item.id));
  const machineIds = new Set(definitions.machines.map((item) => item.id));
  const auxiliaryIds = new Set(
    definitions.auxiliaries.map((item) => item.id),
  );
  for (const recipe of definitions.recipes) {
    if (!machineIds.has(recipe.machineId)) {
      errors.push(
        t("validation.machineMissing", {
          owner: recipe.id,
          id: recipe.machineId,
        }),
      );
    }
    if (!Array.isArray(recipe.inputs) || !Array.isArray(recipe.outputs)) {
      errors.push(
        t("validation.ioArraysMissing", {
          owner: recipe.id,
        }),
      );
      continue;
    }
    for (const port of [...recipe.inputs, ...recipe.outputs]) {
      if (!resourceIds.has(port.resourceId)) {
        errors.push(
          t("validation.resourceMissing", {
            owner: recipe.id,
            id: port.resourceId,
          }),
        );
      }
    }
    if (!Array.isArray(recipe.auxiliaryUses)) {
      errors.push(
        t("validation.metricArrayMissing", {
          owner: recipe.id,
        }),
      );
      continue;
    }
    for (const use of recipe.auxiliaryUses) {
      if (!auxiliaryIds.has(use.auxiliaryId)) {
        errors.push(
          t("validation.metricMissing", {
            owner: recipe.id,
            id: use.auxiliaryId,
          }),
        );
      }
    }
  }
  return { definitions, errors };
}

function validateChart(
  value: unknown,
  definitions: DefinitionsPayload,
): { chart?: ChartPayload; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) return { errors: [t("validation.chartNotObject")] };
  if (!Array.isArray(value.nodes)) {
    errors.push(t("validation.nodesArrayMissing"));
  }
  if (!Array.isArray(value.edges)) {
    errors.push(t("validation.edgesArrayMissing"));
  }
  if (!isRecord(value.camera)) errors.push(t("validation.cameraMissing"));
  if (errors.length) return { errors };
  const chart = value as unknown as ChartPayload;
  const camera = chart.camera;
  if (
    !Number.isFinite(camera.x) || !Number.isFinite(camera.y) ||
    !Number.isFinite(camera.zoom)
  ) {
    errors.push(t("validation.cameraInvalid"));
  }
  const nodeIds = new Set<string>();
  const resourceIds = new Set(definitions.resources.map((item) => item.id));
  const machineIds = new Set(definitions.machines.map((item) => item.id));
  const recipeIds = new Set(definitions.recipes.map((item) => item.id));
  const validKinds = new Set([
    "machine",
    "source",
    "input",
    "extract",
    "splitter",
    "merger",
  ]);
  for (const node of chart.nodes) {
    if (!isRecord(node) || typeof node.id !== "string" || !node.id) {
      errors.push(t("validation.nodeInvalidId"));
      continue;
    }
    if (nodeIds.has(node.id)) {
      errors.push(t("validation.nodeDuplicateId", { id: node.id }));
    }
    nodeIds.add(node.id);
    if (
      typeof node.title !== "string" || !Number.isFinite(node.x) ||
      !Number.isFinite(node.y)
    ) {
      errors.push(t("validation.nodeFields", { id: node.id }));
    }
    if (!validKinds.has(node.kind)) {
      errors.push(
        t("validation.nodeKindUnknown", {
          id: node.id,
          kind: String(node.kind),
        }),
      );
    }
    if (
      node.finalOutputPortIds !== undefined &&
      (!Array.isArray(node.finalOutputPortIds) ||
        node.finalOutputPortIds.some((portId) => typeof portId !== "string"))
    ) {
      errors.push(t("validation.finalOutputArray", { id: node.id }));
    }
    if (node.resourceId && !resourceIds.has(node.resourceId)) {
      errors.push(
        t("validation.resourceMissing", {
          owner: node.title ?? node.id,
          id: node.resourceId,
        }),
      );
    }
    if (node.kind === "input") {
      if (!Array.isArray(node.inputSupplies)) {
        errors.push(t("validation.inputSupplies", { id: node.id }));
      } else {
        const supplyIds = new Set<string>();
        for (const supply of node.inputSupplies) {
          if (
            !isRecord(supply) ||
            typeof supply.id !== "string" ||
            !supply.id ||
            supplyIds.has(supply.id) ||
            typeof supply.resourceId !== "string" ||
            !resourceIds.has(supply.resourceId) ||
            !Number.isFinite(supply.amount) ||
            supply.amount < 0
          ) {
            errors.push(t("validation.inputSupplies", { id: node.id }));
            break;
          }
          supplyIds.add(supply.id);
        }
      }
    }
    if (node.kind === "machine") {
      if (!node.machineId || !machineIds.has(node.machineId)) {
        errors.push(
          t("validation.machineMissing", {
            owner: node.title ?? node.id,
            id: String(node.machineId),
          }),
        );
      }
      for (const recipeId of node.activeRecipeIds ?? []) {
        if (!recipeIds.has(recipeId)) {
          errors.push(
            t("validation.recipeMissing", {
              owner: node.title ?? node.id,
              id: recipeId,
            }),
          );
        }
      }
    }
  }
  if (errors.length) return { errors };
  const candidate: ProjectState = {
    version: 2,
    ...clone(definitions),
    nodes: clone(chart.nodes),
    edges: clone(chart.edges),
  };
  for (const node of candidate.nodes) {
    const outputIds = new Set(
      portsForNode(candidate, node).outputs.map((port) => port.id),
    );
    for (const portId of node.finalOutputPortIds ?? []) {
      if (!outputIds.has(portId)) {
        errors.push(t("validation.finalOutputPortMissing", { id: node.id }));
      }
    }
  }
  const occupiedInputs = new Set<string>();
  for (const edge of chart.edges) {
    if (
      !isRecord(edge) || typeof edge.id !== "string" ||
      typeof edge.sourceNodeId !== "string" ||
      typeof edge.sourcePortId !== "string" ||
      typeof edge.targetNodeId !== "string" ||
      typeof edge.targetPortId !== "string" ||
      typeof edge.resourceId !== "string"
    ) {
      errors.push(t("validation.edgeFields"));
      continue;
    }
    const sourceNode = candidate.nodes.find((node) =>
      node.id === edge.sourceNodeId
    );
    const targetNode = candidate.nodes.find((node) =>
      node.id === edge.targetNodeId
    );
    if (!sourceNode || !targetNode) {
      errors.push(t("validation.edgeNodeMissing", { id: edge.id }));
      continue;
    }
    if (!resourceIds.has(edge.resourceId)) {
      errors.push(
        t("validation.resourceMissing", {
          owner: edge.id,
          id: edge.resourceId,
        }),
      );
    }
    const sourcePort = portsForNode(candidate, sourceNode).outputs.find((
      port,
    ) => port.id === edge.sourcePortId);
    const targetPort = portsForNode(candidate, targetNode).inputs.find((port) =>
      port.id === edge.targetPortId
    );
    if (!sourcePort) {
      errors.push(t("validation.outputPortMissing", { id: edge.id }));
    }
    if (sourceNode.finalOutputPortIds?.includes(edge.sourcePortId)) {
      errors.push(t("validation.finalOutputConnected", { id: edge.id }));
    }
    if (!targetPort) {
      errors.push(t("validation.inputPortMissing", { id: edge.id }));
    }
    const targetKey = `${edge.targetNodeId}:${edge.targetPortId}`;
    if (occupiedInputs.has(targetKey)) {
      errors.push(
        t("validation.duplicateInputConnection", { id: edge.id }),
      );
    }
    occupiedInputs.add(targetKey);
  }
  return { chart, errors };
}

function showImportErrors(errors: string[]): void {
  modal(`<div class="modal import-error-modal">
    <div class="modal-header">
      <div><span class="eyebrow danger">IMPORT BLOCKED</span><h2>${
    t("import.blockedTitle")
  }</h2></div>
      <button type="button" data-action="close-modal" aria-label="${
    t("common.close")
  }">×</button>
    </div>
    <p>${t("import.unchangedHelp")}</p>
    <ul>${
    errors.slice(0, 12).map((error) => `<li>${escapeHtml(error)}</li>`).join("")
  }</ul>
    ${
    errors.length > 12
      ? `<small>${
        t("import.moreErrors", { count: errors.length - 12 })
      }</small>`
      : ""
  }
    <div class="modal-actions"><button type="button" class="primary-button" data-action="close-modal">${
    t("common.confirm")
  }</button></div>
  </div>`);
}

async function importDroppedFile(file: File): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    showImportErrors([t("import.invalidJson")]);
    return;
  }
  if (!isRecord(raw)) {
    showImportErrors([t("import.unknownFileFormat")]);
    return;
  }
  const kind = importKindFromPayload(raw);
  if (!kind) {
    showImportErrors([t("import.unknownFileFormat")]);
    return;
  }
  await importFile(kind, file);
}

async function importFile(
  kind: ImportKind,
  file: File,
  options: { projectHandle?: FlowforgeFileHandle | null } = {},
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    showImportErrors([t("import.invalidJson")]);
    return;
  }
  if (!isRecord(raw) || raw.version !== 1) {
    showImportErrors([t("import.unsupportedVersion")]);
    return;
  }
  let importedProject = false;
  let importedTemplate = false;
  if (kind === "template" || kind === "definitions") {
    const isTemplate = raw.kind === "flowforge-template";
    const isLegacyDefinitions = raw.kind === "flowforge-definitions";
    if (
      (kind === "template" && !isTemplate && !isLegacyDefinitions) ||
      (kind === "definitions" && !isLegacyDefinitions)
    ) {
      showImportErrors([t("import.wrongDefinitionsFormat")]);
      return;
    }
    const checked = validateDefinitions(raw.definitions);
    if (!checked.definitions || checked.errors.length) {
      showImportErrors(checked.errors);
      return;
    }
    checkpoint();
    state = normalizeProjectState({
      version: 2,
      ...normalizeDefinitionsSchema(checked.definitions),
      nodes: [],
      edges: [],
    });
    panOffset = { x: 0, y: 0 };
    zoomLevel = 1;
    projectName = typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim()
      : projectNameFromFilename(file.name);
    projectFileHandle = null;
    projectSavedRevision = null;
    importedTemplate = true;
    await rememberProjectHandle(null);
  }
  if (kind === "chart") {
    if (raw.kind !== "flowforge-chart") {
      showImportErrors([t("import.wrongChartFormat")]);
      return;
    }
    const checked = validateChart(raw.chart, currentDefinitions());
    if (!checked.chart || checked.errors.length) {
      showImportErrors(checked.errors);
      return;
    }
    checkpoint();
    state.nodes = clone(checked.chart.nodes);
    state.edges = clone(checked.chart.edges);
    state = normalizeProjectState(state);
    panOffset = { x: checked.chart.camera.x, y: checked.chart.camera.y };
    zoomLevel = Math.min(2, Math.max(0.35, checked.chart.camera.zoom));
  }
  if (kind === "project") {
    if (raw.kind !== "flowforge-project") {
      showImportErrors([t("import.wrongProjectFormat")]);
      return;
    }
    const definitionsCheck = validateDefinitions(raw.definitions);
    if (!definitionsCheck.definitions || definitionsCheck.errors.length) {
      showImportErrors(definitionsCheck.errors);
      return;
    }
    const chartCheck = validateChart(raw.chart, definitionsCheck.definitions);
    if (!chartCheck.chart || chartCheck.errors.length) {
      showImportErrors(chartCheck.errors);
      return;
    }
    checkpoint();
    state = normalizeProjectState({
      version: 2,
      ...normalizeDefinitionsSchema(definitionsCheck.definitions),
      nodes: clone(chartCheck.chart.nodes),
      edges: clone(chartCheck.chart.edges),
    });
    panOffset = {
      x: chartCheck.chart.camera.x,
      y: chartCheck.chart.camera.y,
    };
    zoomLevel = Math.min(2, Math.max(0.35, chartCheck.chart.camera.zoom));
    projectName = typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim()
      : projectNameFromFilename(file.name);
    projectFileHandle = options.projectHandle ?? null;
    importedProject = true;
    await rememberProjectHandle(projectFileHandle);
  }
  refreshInferredResources();
  selectedNodeId = null;
  selectedNodeIds.clear();
  selectedEdgeId = null;
  activeTopMenu = null;
  closeModal();
  save();
  if (importedProject) markProjectSaved();
  if (importedTemplate) projectSavedRevision = null;
  persistProjectMetadata();
  applyLocale();
  render();
  showToast(
    t(
      importedProject
        ? "toast.projectOpened"
        : importedTemplate
        ? "toast.templateImported"
        : "toast.jsonImported",
      { name: projectName ?? t("project.untitled") },
    ),
  );
}

function modalFrame(
  id: string,
  kicker: string,
  title: string,
  body: string,
  submitLabel: string,
  extraClass = "",
): string {
  return `<form class="modal ${extraClass}" id="${id}">
    <div class="modal-header"><div><span class="eyebrow">${kicker}</span><h2>${title}</h2></div><button type="button" data-action="close-modal" aria-label="${
    t("common.close")
  }">×</button></div>
    ${body}
    <div class="modal-actions"><button type="button" class="quiet-button" data-action="close-modal">${
    t("common.cancel")
  }</button><button class="primary-button">${submitLabel}</button></div>
  </form>`;
}

function openResourceModal(resourceId?: string): void {
  const resource = resourceId
    ? state.resources.find((item) => item.id === resourceId)
    : undefined;
  if (resourceId && !resource) return;
  modal(modalFrame(
    "resource-form",
    resource ? "EDIT RESOURCE" : "NEW RESOURCE",
    t(resource ? "form.resource.editTitle" : "form.resource.title"),
    `<input type="hidden" name="definitionId" value="${resource?.id ?? ""}">
    <div class="modal-grid">
      <label class="field wide"><span>${
      t("form.resource.name")
    }</span><input name="name" required placeholder="${
      t("form.resource.namePlaceholder")
    }" value="${escapeHtml(resource?.name ?? "")}"></label>
      <label class="field"><span>${
      t("form.resource.unit")
    }</span><input name="unit" required placeholder="L" value="${
      escapeHtml(resource?.unit ?? "")
    }"></label>
      <label class="field color-field"><span>${
      t("form.resource.color")
    }</span><input name="color" type="color" value="${
      resource?.color ?? "#62b891"
    }"></label>
      <label class="field wide"><span>${
      t("form.resource.imageOptional")
    }</span><input name="image" type="file" accept="image/*"></label>
    </div>`,
    resource ? t("common.save") : t("form.resource.submit"),
  ));
}

function openAuxiliaryModal(auxiliaryId?: string): void {
  const auxiliary = auxiliaryId
    ? state.auxiliaries.find((item) => item.id === auxiliaryId)
    : undefined;
  if (auxiliaryId && !auxiliary) return;
  modal(modalFrame(
    "auxiliary-form",
    auxiliary ? "EDIT METRIC" : "NEW METRIC",
    t(auxiliary ? "form.metric.editTitle" : "form.metric.title"),
    `<input type="hidden" name="definitionId" value="${auxiliary?.id ?? ""}">
    <div class="modal-grid">
      <label class="field wide"><span>${
      t("form.metric.name")
    }</span><input name="name" required placeholder="${
      t("form.metric.namePlaceholder")
    }" value="${escapeHtml(auxiliary?.name ?? "")}"></label>
      <label class="field"><span>${
      t("form.metric.unit")
    }</span><input name="unit" required placeholder="m³" value="${
      escapeHtml(auxiliary?.unit ?? "")
    }"></label>
      <label class="field color-field"><span>${
      t("form.metric.color")
    }</span><input name="color" type="color" value="${
      auxiliary?.color ?? "#f5c451"
    }"></label>
    </div>`,
    auxiliary ? t("common.save") : t("form.metric.submit"),
  ));
}

function openMachineModal(machineId?: string): void {
  const machine = machineId ? machineById(state, machineId) : undefined;
  if (machineId && !machine) return;
  modal(modalFrame(
    "machine-form",
    machine ? "EDIT MACHINE" : "NEW MACHINE",
    t(machine ? "form.machine.editTitle" : "form.machine.title"),
    `<input type="hidden" name="definitionId" value="${machine?.id ?? ""}">
    <div class="modal-grid">
      <label class="field wide"><span>${
      t("form.machine.name")
    }</span><input name="name" required placeholder="${
      t("form.machine.namePlaceholder")
    }" value="${escapeHtml(machine?.name ?? "")}"></label>
      <label class="field wide"><span>${
      t("form.machine.description")
    }</span><input name="description" placeholder="${
      t("form.machine.descriptionPlaceholder")
    }" value="${escapeHtml(machine?.description ?? "")}"></label>
      <label class="field wide"><span>${
      t("form.machine.imageOptional")
    }</span><input name="image" type="file" accept="image/*"></label>
    </div><p class="modal-note">${t("form.machine.help")}</p>`,
    machine ? t("common.save") : t("form.machine.submit"),
  ));
}

function recipePortRow(
  direction: "input" | "output",
  port?: Recipe["inputs"][number],
): string {
  const probabilistic = direction === "output" &&
    port?.probability !== undefined;
  const probabilityPercent = Number(
    ((port ? probabilityForOutput(port) : 1) * 100).toFixed(4),
  );
  return `<div class="recipe-port-row ${
    direction === "output"
      ? `with-probability${probabilistic ? " is-probabilistic" : ""}`
      : ""
  }" data-recipe-port="${direction}" data-port-id="${port?.id ?? ""}">
    <button type="button" class="recipe-port-drag-handle" draggable="true" title="${
    t("form.recipe.reorderPort")
  }" aria-label="${t("form.recipe.reorderPort")}">⠿</button>
    <select>${resourceOptions(port?.resourceId)}</select>
    <input type="number" value="${port?.amount ?? 1}" required>
    ${
    direction === "output"
      ? `<label class="probability-toggle" title="${
        t("form.recipe.probabilisticOutput")
      }"><input data-output-probabilistic type="checkbox" ${
        probabilistic ? "checked" : ""
      } aria-label="${
        t("form.recipe.probabilisticOutput")
      }"><span>%</span></label>
      <label class="probability-input" title="${
        t("form.recipe.outputProbability")
      }"><input data-output-probability type="number" min="0" max="100" step="any" value="${probabilityPercent}" ${
        probabilistic ? "" : "disabled"
      } aria-label="${
        t("form.recipe.outputProbability")
      }"><span>%</span></label>`
      : ""
  }
    <button type="button" data-action="remove-row" aria-label="${
    t("common.delete")
  }">×</button>
  </div>`;
}

function auxiliaryRow(use?: Recipe["auxiliaryUses"][number]): string {
  return `<div class="recipe-port-row" data-auxiliary-row>
    <select>${
    state.auxiliaries.map((item) =>
      `<option value="${item.id}" ${
        item.id === use?.auxiliaryId ? "selected" : ""
      }>${escapeHtml(item.name)} · ${escapeHtml(item.unit)}</option>`
    ).join("")
  }</select>
    <input type="number" value="${use?.amount ?? 1}" required>
    <button type="button" data-action="remove-row" aria-label="${
    t("common.delete")
  }">×</button>
  </div>`;
}

function openRecipeModal(machineId: string, recipeId?: string): void {
  const machine = machineById(state, machineId);
  const recipe = recipeId
    ? state.recipes.find((item) =>
      item.id === recipeId && item.machineId === machineId
    )
    : undefined;
  if (!machine || !state.resources.length) return;
  if (recipeId && !recipe) return;
  modal(modalFrame(
    "recipe-form",
    recipe ? "EDIT RECIPE" : "NEW RECIPE",
    t(recipe ? "form.recipe.editTitle" : "form.recipe.title", {
      machine: escapeHtml(machine.name),
    }),
    `<input type="hidden" name="definitionId" value="${recipe?.id ?? ""}">
    <input type="hidden" name="machineId" value="${machineId}">
    <div class="modal-grid">
      <label class="field"><span>${
      t("form.recipe.id")
    }</span><input name="id" required placeholder="${
      t("form.recipe.idPlaceholder")
    }" value="${escapeHtml(recipe?.id ?? "")}"></label>
      <label class="field"><span>${
      t("form.recipe.duration")
    }</span><input name="duration" type="number" value="${
      normalizeRecipeDuration(recipe?.duration ?? 5)
    }" step="0.01" required></label>
      <label class="field wide"><span>${
      t("form.recipe.description")
    }</span><input name="description" placeholder="${
      t("form.recipe.descriptionPlaceholder")
    }" value="${escapeHtml(recipe?.description ?? "")}"></label>
    </div>
    <div class="recipe-port-editor three">
      <section><div><strong>${
      t("form.recipe.inputs")
    }</strong><button type="button" data-action="add-input">${
      t("common.add")
    }</button></div><div id="recipe-inputs">${
      recipe
        ? recipe.inputs.map((port) => recipePortRow("input", port)).join("")
        : recipePortRow("input")
    }</div></section>
      <section><div><strong>${
      t("form.recipe.outputs")
    }</strong><button type="button" data-action="add-output">${
      t("common.add")
    }</button></div><div id="recipe-outputs">${
      recipe
        ? recipe.outputs.map((port) => recipePortRow("output", port)).join("")
        : recipePortRow("output")
    }</div></section>
      <section><div><strong>${
      t("form.recipe.metrics")
    }</strong><button type="button" data-action="add-aux-row">${
      t("common.add")
    }</button></div><div id="recipe-auxiliaries">${
      recipe?.auxiliaryUses.length
        ? recipe.auxiliaryUses.map((use) => auxiliaryRow(use)).join("")
        : !recipe && state.auxiliaries.length
        ? auxiliaryRow()
        : !state.auxiliaries.length
        ? `<p class="setting-note">${t("form.recipe.defineMetricFirst")}</p>`
        : ""
    }</div></section>
    </div>`,
    recipe ? t("common.save") : t("form.recipe.submit"),
    "recipe-modal",
  ));
}

async function handleResourceSubmit(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const definitionId = String(data.get("definitionId") ?? "");
  const existing = definitionId
    ? state.resources.find((item) => item.id === definitionId)
    : undefined;
  if (definitionId && !existing) return;
  const image = data.get("image");
  const uploadedImage = image instanceof File && image.size
    ? await imageFileToDataUrl(image)
    : undefined;
  const values = {
    name: String(data.get("name")),
    unit: String(data.get("unit")),
    color: String(data.get("color")),
  };
  checkpoint();
  const resource: Resource = existing ?? {
    id: uid("resource"),
    ...values,
  };
  if (existing) {
    Object.assign(existing, values);
    if (uploadedImage) existing.imageDataUrl = uploadedImage;
  } else {
    resource.imageDataUrl = uploadedImage;
    state.resources.push(resource);
  }
  closeModal();
  save();
  render();
  showToast(
    t(existing ? "toast.resourceUpdated" : "toast.resourceCreated", {
      name: resource.name,
    }),
  );
}

function handleAuxiliarySubmit(form: HTMLFormElement): void {
  const data = new FormData(form);
  const definitionId = String(data.get("definitionId") ?? "");
  const existing = definitionId
    ? state.auxiliaries.find((item) => item.id === definitionId)
    : undefined;
  if (definitionId && !existing) return;
  const values = {
    name: String(data.get("name")),
    unit: String(data.get("unit")),
    color: String(data.get("color")),
  };
  checkpoint();
  const auxiliary: AuxiliaryDefinition = existing ?? {
    id: uid("aux"),
    ...values,
  };
  if (existing) Object.assign(existing, values);
  else state.auxiliaries.push(auxiliary);
  closeModal();
  save();
  render();
  showToast(
    t(existing ? "toast.metricUpdated" : "toast.metricCreated", {
      name: auxiliary.name,
    }),
  );
}

async function handleMachineSubmit(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const definitionId = String(data.get("definitionId") ?? "");
  const existing = definitionId ? machineById(state, definitionId) : undefined;
  if (definitionId && !existing) return;
  const image = data.get("image");
  const uploadedImage = image instanceof File && image.size
    ? await imageFileToDataUrl(image)
    : undefined;
  const values = {
    name: String(data.get("name")),
    description: String(data.get("description")),
  };
  checkpoint();
  const previousName = existing?.name;
  const machine: MachineDefinition = existing ?? {
    id: uid("machine"),
    ...values,
  };
  if (existing) {
    Object.assign(existing, values);
    if (uploadedImage) existing.imageDataUrl = uploadedImage;
    for (
      const node of state.nodes.filter((item) =>
        item.machineId === existing.id && item.title === previousName
      )
    ) {
      node.title = existing.name;
    }
  } else {
    machine.imageDataUrl = uploadedImage;
    state.machines.push(machine);
  }
  closeModal();
  save();
  render();
  showToast(
    t(existing ? "toast.machineUpdated" : "toast.machineCreated", {
      name: machine.name,
    }),
  );
}

async function handleImageSubmit(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const kind = String(data.get("kind")) as "resource" | "machine";
  const id = String(data.get("id"));
  const file = data.get("image");
  const owner = imageOwner(kind, id);
  if (!owner || !(file instanceof File) || !file.size) return;
  const imageDataUrl = await imageFileToDataUrl(file);
  checkpoint();
  owner.imageDataUrl = imageDataUrl;
  closeModal();
  save();
  render();
  showToast(t("toast.imageSet", { name: owner.name }));
}

function handleRecipeSubmit(form: HTMLFormElement): void {
  const data = new FormData(form);
  const definitionId = String(data.get("definitionId") ?? "");
  const existing = definitionId
    ? state.recipes.find((item) => item.id === definitionId)
    : undefined;
  if (definitionId && !existing) return;
  const recipeId = String(data.get("id") ?? "").trim();
  if (!recipeId) {
    showToast(t("toast.recipeIdRequired"), "error");
    return;
  }
  if (
    state.recipes.some((item) =>
      item.id === recipeId && item.id !== definitionId
    )
  ) {
    showToast(t("toast.recipeIdDuplicate", { id: recipeId }), "error");
    return;
  }
  const recipe: Recipe = {
    id: recipeId,
    machineId: String(data.get("machineId")),
    description: String(data.get("description")),
    duration: normalizeRecipeDuration(Number(data.get("duration"))),
    inputs: [],
    outputs: [],
    auxiliaryUses: [],
  };
  const usedPortIds = new Set<string>();
  const portIndexes = { input: 0, output: 0 };
  form.querySelectorAll<HTMLElement>("[data-recipe-port]").forEach(
    (row) => {
      const direction = row.dataset.recipePort as "input" | "output";
      const resourceId = row.querySelector<HTMLSelectElement>("select")?.value;
      const amount = Number(
        row.querySelector<HTMLInputElement>("input")?.value,
      );
      if (resourceId && amount) {
        let portId = row.dataset.portId;
        while (!portId || usedPortIds.has(portId)) {
          portId = `${direction}-${portIndexes[direction]++}`;
        }
        usedPortIds.add(portId);
        const port = {
          id: portId,
          resourceId,
          amount,
        };
        if (direction === "output") {
          const probabilistic = row.querySelector<HTMLInputElement>(
            "[data-output-probabilistic]",
          )?.checked ?? false;
          const probabilityInput = row.querySelector<HTMLInputElement>(
            "[data-output-probability]",
          );
          const probabilityPercent = Number(probabilityInput?.value);
          recipe.outputs.push(
            probabilistic
              ? {
                ...port,
                probability: Number.isFinite(probabilityPercent)
                  ? Math.min(100, Math.max(0, probabilityPercent)) / 100
                  : 1,
              }
              : port,
          );
        } else {
          recipe.inputs.push(port);
        }
      }
    },
  );
  form.querySelectorAll<HTMLElement>("[data-auxiliary-row]").forEach((row) => {
    const auxiliaryId = row.querySelector<HTMLSelectElement>("select")?.value;
    const amount = Number(row.querySelector<HTMLInputElement>("input")?.value);
    if (auxiliaryId && amount) {
      recipe.auxiliaryUses.push({ auxiliaryId, amount });
    }
  });
  if (!recipe.inputs.length || !recipe.outputs.length) {
    showToast(t("toast.recipePortsRequired"), "error");
    return;
  }
  checkpoint();
  const previousRecipeId = existing?.id;
  if (existing) {
    Object.assign(existing, recipe);
    delete (existing as Recipe & { name?: string }).name;
  } else {
    state.recipes.push(recipe);
  }
  if (previousRecipeId && previousRecipeId !== recipe.id) {
    const replacePortRecipeId = (portId: string): string =>
      portId.startsWith(`${previousRecipeId}:`)
        ? `${recipe.id}:${portId.slice(previousRecipeId.length + 1)}`
        : portId;
    for (const node of state.nodes) {
      node.activeRecipeIds = node.activeRecipeIds?.map((id) =>
        id === previousRecipeId ? recipe.id : id
      );
      node.finalOutputPortIds = node.finalOutputPortIds?.map(
        replacePortRecipeId,
      );
    }
    for (const edge of state.edges) {
      edge.sourcePortId = replacePortRecipeId(edge.sourcePortId);
      edge.targetPortId = replacePortRecipeId(edge.targetPortId);
    }
  }
  for (
    const node of state.nodes.filter((item) =>
      item.kind === "machine" &&
      item.activeRecipeIds?.includes(recipe.id)
    )
  ) {
    pruneNodeEdges(node);
  }
  closeModal();
  save();
  render();
  showToast(
    t(existing ? "toast.recipeUpdated" : "toast.recipeCreated", {
      name: recipe.id,
    }),
  );
}

app.addEventListener("dblclick", (event) => {
  const port = (event.target as HTMLElement).closest<HTMLElement>(".port-row");
  if (
    !port ||
    port.dataset.direction !== "output" ||
    !port.dataset.node ||
    !port.dataset.port
  ) return;
  event.preventDefault();
  event.stopPropagation();
  toggleFinalOutput(port.dataset.node, port.dataset.port);
});

app.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const edgeHit = target.closest<SVGPathElement>(".edge-hit");
  if (edgeHit?.dataset.edgeId) {
    selectedEdgeId = edgeHit.dataset.edgeId;
    selectedNodeId = null;
    selectedNodeIds.clear();
    drawEdges();
    return;
  }
  const port = target.closest<HTMLElement>(".port-row");
  if (port) {
    event.stopPropagation();
    return;
  }
  const actionElement = target.closest<HTMLElement>("[data-action]");
  const action = actionElement?.dataset.action;
  if (action && action !== "top-menu" && activeTopMenu) {
    dismissTopMenu();
  }
  if (action === "top-menu" && actionElement?.dataset.menu) {
    const menu = actionElement.dataset.menu as typeof activeTopMenu;
    activeTopMenu = activeTopMenu === menu ? null : menu;
    render();
    return;
  }
  if (action === "request-new-project") openNewProjectModal();
  if (action === "confirm-new-project") {
    createNewProject();
    return;
  }
  if (action === "open-file-menu") openFileMenu();
  if (action === "open-project") void chooseAndImportFile("project");
  if (action === "save-project") void saveProject();
  if (action === "save-project-as") void saveProject(true);
  if (action === "import-template") void chooseAndImportFile("template");
  if (action === "export-template") void exportTemplate();
  if (action === "add-resource") openResourceModal();
  if (action === "add-auxiliary") openAuxiliaryModal();
  if (action === "add-machine") openMachineModal();
  if (action === "library-tab" && actionElement?.dataset.tab) {
    const tab = actionElement.dataset.tab as typeof activeLibraryTab;
    const nextTab = activeLibraryTab === tab ? null : tab;
    animateLibraryDrawer = nextTab !== null && nextTab !== activeLibraryTab;
    activeLibraryTab = nextTab;
    render();
  }
  if (action === "close-library") {
    activeLibraryTab = null;
    render();
  }
  if (action === "undo") undo();
  if (action === "redo") redo();
  if (action === "zoom-in") setZoom(zoomLevel * 1.15);
  if (action === "zoom-out") setZoom(zoomLevel / 1.15);
  if (action === "zoom-reset") setZoom(1);
  if (
    action === "edit-definition" &&
    actionElement?.dataset.kind &&
    actionElement.dataset.id
  ) {
    const { kind, id } = actionElement.dataset;
    if (kind === "resource") openResourceModal(id);
    if (kind === "auxiliary") openAuxiliaryModal(id);
    if (kind === "machine") openMachineModal(id);
    if (kind === "recipe") {
      const recipe = state.recipes.find((item) => item.id === id);
      if (recipe) openRecipeModal(recipe.machineId, recipe.id);
    }
  }
  if (
    action === "set-image" &&
    (actionElement?.dataset.kind === "resource" ||
      actionElement?.dataset.kind === "machine") &&
    actionElement.dataset.id
  ) {
    openImageModal(actionElement.dataset.kind, actionElement.dataset.id);
  }
  if (
    action === "request-delete" &&
    actionElement?.dataset.kind &&
    actionElement.dataset.id
  ) {
    openDeleteModal(
      actionElement.dataset.kind as NonNullable<typeof pendingDelete>["kind"],
      actionElement.dataset.id,
    );
  }
  if (action === "confirm-delete") {
    performDefinitionDelete();
    return;
  }
  if (
    action === "remove-image" &&
    (actionElement?.dataset.kind === "resource" ||
      actionElement?.dataset.kind === "machine") &&
    actionElement.dataset.id
  ) {
    const owner = imageOwner(
      actionElement.dataset.kind,
      actionElement.dataset.id,
    );
    if (owner) {
      checkpoint();
      owner.imageDataUrl = undefined;
      closeModal();
      save();
      render();
      showToast(t("toast.defaultImageRestored"));
    }
  }
  if (action === "delete-edge" && actionElement?.dataset.edgeId) {
    deleteEdge(actionElement.dataset.edgeId);
    return;
  }
  if (action === "delete-selection") {
    if (selectedEdgeId) deleteEdge(selectedEdgeId);
    else deleteSelectedNode();
    return;
  }
  if (action === "add-recipe" && actionElement?.dataset.machine) {
    openRecipeModal(actionElement.dataset.machine);
  }
  if (action === "calculate-input-node" && actionElement?.dataset.nodeId) {
    openInputCalculation(actionElement.dataset.nodeId);
  }
  if (action === "apply-minimum-input" && actionElement?.dataset.nodeId) {
    const inputNode = state.nodes.find((item) =>
      item.id === actionElement.dataset.nodeId && item.kind === "input"
    );
    if (inputNode) {
      const minimum = findMinimumInputBatch(state, inputNode.id, locale);
      if (minimum.exact) {
        checkpoint();
        for (const supply of inputNode.inputSupplies ?? []) {
          supply.amount = minimum.amounts[supply.id] ?? 0;
        }
        closeModal();
        save();
        render();
        showToast(t("toast.minimumInputApplied"));
      } else {
        showToast(t("toast.minimumInputUnavailable"), "error");
      }
    }
  }
  if (action === "add-input-supply" && actionElement?.dataset.nodeId) {
    const node = state.nodes.find((item) =>
      item.id === actionElement.dataset.nodeId && item.kind === "input"
    );
    const resource = state.resources[0];
    if (node && resource) {
      checkpoint();
      node.inputSupplies = [
        ...(node.inputSupplies ?? []),
        { id: uid("supply"), resourceId: resource.id, amount: 100 },
      ];
      save();
      render();
    }
  }
  if (
    action === "remove-input-supply" &&
    actionElement?.dataset.nodeId &&
    actionElement.dataset.supplyId
  ) {
    const node = state.nodes.find((item) =>
      item.id === actionElement.dataset.nodeId && item.kind === "input"
    );
    if (node) {
      checkpoint();
      const portId = `input-out:${actionElement.dataset.supplyId}`;
      node.inputSupplies = (node.inputSupplies ?? []).filter((supply) =>
        supply.id !== actionElement.dataset.supplyId
      );
      node.finalOutputPortIds = node.finalOutputPortIds?.filter((id) =>
        id !== portId
      );
      state.edges = state.edges.filter((edge) =>
        edge.sourceNodeId !== node.id || edge.sourcePortId !== portId
      );
      refreshInferredResources();
      save();
      render();
    }
  }
  if (action === "close-modal") closeModal();
  if (action === "add-input") {
    document.querySelector("#recipe-inputs")?.insertAdjacentHTML(
      "beforeend",
      recipePortRow("input"),
    );
  }
  if (action === "add-output") {
    document.querySelector("#recipe-outputs")?.insertAdjacentHTML(
      "beforeend",
      recipePortRow("output"),
    );
  }
  if (action === "add-aux-row" && state.auxiliaries.length) {
    document.querySelector("#recipe-auxiliaries")?.insertAdjacentHTML(
      "beforeend",
      auxiliaryRow(),
    );
  }
  if (action === "remove-row") {
    actionElement?.closest(".recipe-port-row")?.remove();
  }
  if (action === "theme") {
    theme = theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, theme);
    applyTheme();
    render();
  }
  if (action === "reset") {
    openNewProjectModal();
  }
  if (action === "delete-node") {
    const id = actionElement?.closest<HTMLElement>("[data-node-id]")?.dataset
      .nodeId;
    deleteSelectedNode(id);
  }
  const nodeElement = target.closest<HTMLElement>(".flow-node");
  if (nodeElement && !target.closest("button")) {
    if (suppressNextNodeClick) {
      suppressNextNodeClick = false;
      return;
    }
    const id = nodeElement.dataset.nodeId;
    if (!id) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      selectedNodeIds.has(id)
        ? selectedNodeIds.delete(id)
        : selectedNodeIds.add(id);
    } else {
      selectedNodeIds = new Set([id]);
    }
    selectedNodeId = selectedNodeIds.size === 1
      ? [...selectedNodeIds][0]
      : null;
    selectedEdgeId = null;
    render();
  }
});

function clearRecipePortDragState(): void {
  document.querySelectorAll(
    ".recipe-port-row.is-dragging, .recipe-port-row.is-drop-before, .recipe-port-row.is-drop-after",
  ).forEach((row) =>
    row.classList.remove("is-dragging", "is-drop-before", "is-drop-after")
  );
  draggedRecipePortRow = null;
}

app.addEventListener("dragstart", (event) => {
  const handle = (event.target as HTMLElement).closest<HTMLElement>(
    ".recipe-port-drag-handle",
  );
  const row = handle?.closest<HTMLElement>("[data-recipe-port]");
  if (!handle || !row) return;
  draggedRecipePortRow = row;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      "text/plain",
      row.dataset.portId || row.dataset.recipePort || "recipe-port",
    );
  }
  requestAnimationFrame(() => row.classList.add("is-dragging"));
});

app.addEventListener("dragover", (event) => {
  if (!draggedRecipePortRow) return;
  const hoveredRow = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-recipe-port]",
  );
  if (
    !hoveredRow ||
    hoveredRow.parentElement !== draggedRecipePortRow.parentElement
  ) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  document.querySelectorAll(
    ".recipe-port-row.is-drop-before, .recipe-port-row.is-drop-after",
  ).forEach((row) => row.classList.remove("is-drop-before", "is-drop-after"));
  if (hoveredRow === draggedRecipePortRow) return;

  const bounds = hoveredRow.getBoundingClientRect();
  const placeBefore = event.clientY < bounds.top + bounds.height / 2;
  hoveredRow.classList.add(
    placeBefore ? "is-drop-before" : "is-drop-after",
  );
  hoveredRow.parentElement?.insertBefore(
    draggedRecipePortRow,
    placeBefore ? hoveredRow : hoveredRow.nextSibling,
  );
});

app.addEventListener("drop", (event) => {
  if (!draggedRecipePortRow) return;
  event.preventDefault();
  clearRecipePortDragState();
});

app.addEventListener("dragend", clearRecipePortDragState);

app.addEventListener("keydown", (event) => {
  const handle = (event.target as HTMLElement).closest<HTMLElement>(
    ".recipe-port-drag-handle",
  );
  if (
    !handle ||
    (event.key !== "ArrowUp" && event.key !== "ArrowDown")
  ) return;
  const row = handle.closest<HTMLElement>("[data-recipe-port]");
  if (!row?.parentElement) return;
  const sibling = event.key === "ArrowUp"
    ? row.previousElementSibling
    : row.nextElementSibling;
  if (!(sibling instanceof HTMLElement) || !sibling.dataset.recipePort) return;
  event.preventDefault();
  if (event.key === "ArrowUp") {
    row.parentElement.insertBefore(row, sibling);
  } else {
    row.parentElement.insertBefore(sibling, row);
  }
  handle.focus();
});

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  if (form.id === "resource-form") await handleResourceSubmit(form);
  if (form.id === "auxiliary-form") handleAuxiliarySubmit(form);
  if (form.id === "machine-form") await handleMachineSubmit(form);
  if (form.id === "recipe-form") handleRecipeSubmit(form);
  if (form.id === "definition-image-form") await handleImageSubmit(form);
});

app.addEventListener("change", async (event) => {
  const input = event.target as HTMLInputElement | HTMLSelectElement;
  if (
    input instanceof HTMLInputElement &&
    input.hasAttribute("data-output-probabilistic")
  ) {
    const row = input.closest<HTMLElement>(".recipe-port-row");
    const probabilityInput = row?.querySelector<HTMLInputElement>(
      "[data-output-probability]",
    );
    row?.classList.toggle("is-probabilistic", input.checked);
    if (probabilityInput) {
      probabilityInput.disabled = !input.checked;
      if (input.checked) probabilityInput.focus();
    }
    return;
  }
  if (
    input instanceof HTMLSelectElement &&
    input.hasAttribute("data-language") &&
    (input.value === "ko" || input.value === "en")
  ) {
    locale = input.value;
    localStorage.setItem(LANGUAGE_KEY, locale);
    applyLocale();
    render();
    return;
  }
  if (
    input instanceof HTMLInputElement &&
    (input.dataset.importKind === "template" ||
      input.dataset.importKind === "definitions" ||
      input.dataset.importKind === "chart" ||
      input.dataset.importKind === "project") &&
    input.files?.[0]
  ) {
    await importFile(input.dataset.importKind, input.files[0]);
    return;
  }
  const inputSupplyField = input.dataset.inputSupplyField;
  const supplyRow = input.closest<HTMLElement>("[data-supply-id]");
  const inputNode = state.nodes.find((item) =>
    item.id === selectedNodeId && item.kind === "input"
  );
  const supply = inputNode?.inputSupplies?.find((item) =>
    item.id === supplyRow?.dataset.supplyId
  );
  if (inputSupplyField && inputNode && supply) {
    checkpoint();
    if (inputSupplyField === "amount") {
      supply.amount = Math.max(0, Number(input.value) || 0);
    }
    if (inputSupplyField === "resourceId") {
      const portId = `input-out:${supply.id}`;
      supply.resourceId = input.value;
      inputNode.finalOutputPortIds = inputNode.finalOutputPortIds?.filter(
        (id) => id !== portId,
      );
      state.edges = state.edges.filter((edge) =>
        edge.sourceNodeId !== inputNode.id || edge.sourcePortId !== portId
      );
      refreshInferredResources();
    }
    save();
    render();
    return;
  }
  const field = input.dataset.inspector;
  const node = state.nodes.find((item) => item.id === selectedNodeId);
  if (!field || !node) return;
  checkpoint();
  if (field === "title") {
    node.title = input.value;
    node.titleKey = undefined;
  }
  if (field === "resourceId") {
    node.resourceId = input.value;
    state.edges = state.edges.filter((edge) => edge.sourceNodeId !== node.id);
    refreshInferredResources();
  }
  if (field === "splitRatio") {
    const first = Number(input.value) / 100;
    node.splitRatios = [first, 1 - first];
  }
  if (field === "multiRecipe") {
    node.multiRecipe = (input as HTMLInputElement).checked;
    if (!node.multiRecipe && (node.activeRecipeIds?.length ?? 0) > 1) {
      node.activeRecipeIds = [node.activeRecipeIds?.[0] ?? ""].filter(Boolean);
    }
    pruneNodeEdges(node);
  }
  if (field === "activeRecipe") {
    if (node.multiRecipe) {
      const checked = (input as HTMLInputElement).checked;
      const current = new Set(node.activeRecipeIds ?? []);
      checked ? current.add(input.value) : current.delete(input.value);
      node.activeRecipeIds = [...current];
    } else {
      node.activeRecipeIds = [input.value];
    }
    pruneNodeEdges(node);
  }
  save();
  render();
});

document.addEventListener("keydown", (event) => {
  const editing = ["INPUT", "SELECT", "TEXTAREA"].includes(
    (event.target as HTMLElement).tagName,
  );
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "s"
  ) {
    event.preventDefault();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    void saveProject(event.shiftKey);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !editing) {
    if (event.key.toLowerCase() === "n") {
      event.preventDefault();
      openNewProjectModal();
      return;
    }
    if (event.key.toLowerCase() === "o") {
      event.preventDefault();
      void chooseAndImportFile("project");
      return;
    }
    if (event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
      return;
    }
    if (event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setZoom(zoomLevel * 1.15);
      return;
    }
    if (event.key === "-") {
      event.preventDefault();
      setZoom(zoomLevel / 1.15);
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      setZoom(1);
      return;
    }
  }
  if (event.key === "Escape" && pendingPort) {
    pendingPort = null;
    render();
  }
  if (
    (event.key === "Delete" || event.key === "Backspace") &&
    selectedEdgeId &&
    !editing
  ) {
    deleteEdge(selectedEdgeId);
    return;
  }
  if (
    (event.key === "Delete" || event.key === "Backspace") &&
    selectedNodeIds.size &&
    !editing
  ) {
    deleteSelectedNode();
  }
});

globalThis.addEventListener("resize", drawEdges);
void restoreStoredProjectHandle();
refreshInferredResources();
render();
