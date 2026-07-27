import type {
  Edge,
  FlowNode,
  MachineDefinition,
  PortView,
  ProjectState,
  Recipe,
  RecipePort,
  Resource,
  SimulationResult,
} from "./types.ts";
import { type Locale, translate } from "./i18n.ts";
import { findClosedLoops } from "./closed_loops.ts";

const translatableNodeTitleKeys = new Set<string>([
  "node.default.machine",
  "node.default.source",
  "node.default.input",
  "node.default.extract",
  "node.default.splitter",
  "node.default.merger",
]);

export function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function resourceById(
  state: ProjectState,
  id: string,
): Resource | undefined {
  return state.resources.find((item) => item.id === id);
}

export function resourceLabel(
  resource: Resource | undefined,
  fallback = "AUTO",
): string {
  const symbol = resource?.symbol?.trim();
  if (symbol) return symbol;
  const generated = Array.from(resource?.name.trim() ?? "").slice(0, 2).join(
    "",
  ).toLocaleUpperCase();
  return generated || fallback;
}

export function probabilityForOutput(port: RecipePort): number {
  if (!Number.isFinite(port.probability)) return 1;
  return Math.min(1, Math.max(0, port.probability ?? 1));
}

export function normalizeRecipeDuration(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function recipeById(
  state: ProjectState,
  id: string,
): Recipe | undefined {
  return state.recipes.find((item) => item.id === id);
}

export function machineById(
  state: ProjectState,
  id: string,
): MachineDefinition | undefined {
  return state.machines.find((item) => item.id === id);
}

export function recipesForMachine(
  state: ProjectState,
  machineId: string,
): Recipe[] {
  return state.recipes.filter((recipe) => recipe.machineId === machineId);
}

export function activeRecipesForNode(
  state: ProjectState,
  node: FlowNode,
): Recipe[] {
  if (node.kind !== "machine" || !node.machineId) return [];
  const available = recipesForMachine(state, node.machineId);
  const selected = available.filter((recipe) =>
    node.activeRecipeIds?.includes(recipe.id)
  );
  if (node.multiRecipe) {
    return selected.length ? selected : available.slice(0, 1);
  }
  return [selected[0] ?? available[0]].filter(Boolean);
}

function dynamicInputIndex(
  kind: "extract" | "merger",
  portId: string,
): number | null {
  if (kind === "extract" && portId === "extract-in") return 0;
  const pattern = kind === "extract"
    ? /^extract-in-(\d+)$/
    : /^merge-in-(\d+)$/;
  const match = portId.match(pattern);
  return match ? Number(match[1]) : null;
}

function dynamicInputId(
  kind: "extract" | "merger",
  index: number,
): string {
  if (kind === "extract" && index === 0) return "extract-in";
  return kind === "extract" ? `extract-in-${index}` : `merge-in-${index}`;
}

function dynamicInputPorts(
  state: ProjectState,
  node: FlowNode,
  kind: "extract" | "merger",
): PortView[] {
  const connectedEdges = state.edges
    .filter((edge) =>
      edge.targetNodeId === node.id &&
      dynamicInputIndex(kind, edge.targetPortId) !== null
    )
    .sort((first, second) =>
      dynamicInputIndex(kind, first.targetPortId)! -
      dynamicInputIndex(kind, second.targetPortId)!
    );
  const connectedPortIds = new Set(
    connectedEdges.map((edge) => edge.targetPortId),
  );
  const ports = connectedEdges.map((edge) => {
    const resource = resourceById(state, edge.resourceId);
    return {
      id: edge.targetPortId,
      resourceId: resource?.id ?? "",
      amount: kind === "extract" ? 0 : 1,
      direction: "input" as const,
      label: resourceLabel(resource),
    };
  });
  const highestIndex = connectedEdges.reduce(
    (highest, edge) =>
      Math.max(
        highest,
        dynamicInputIndex(kind, edge.targetPortId) ?? -1,
      ),
    -1,
  );
  let nextIndex = highestIndex + 1;
  let nextPortId = dynamicInputId(kind, nextIndex);
  while (connectedPortIds.has(nextPortId)) {
    nextIndex += 1;
    nextPortId = dynamicInputId(kind, nextIndex);
  }
  ports.push({
    id: nextPortId,
    resourceId: "",
    amount: 0,
    direction: "input",
    label: "AUTO",
  });
  return ports;
}

export function portsForNode(
  state: ProjectState,
  node: FlowNode,
): { inputs: PortView[]; outputs: PortView[] } {
  if (node.kind === "machine") {
    const recipes = activeRecipesForNode(state, node);
    const convert = (
      recipe: Recipe,
      direction: "input" | "output",
    ): PortView[] =>
      recipe[direction === "input" ? "inputs" : "outputs"].map((port) => ({
        ...port,
        id: `${recipe.id}:${port.id}`,
        recipeId: recipe.id,
        direction,
        label: resourceLabel(resourceById(state, port.resourceId), "?"),
      }));
    return {
      inputs: recipes.flatMap((recipe) => convert(recipe, "input")),
      outputs: recipes.flatMap((recipe) => convert(recipe, "output")),
    };
  }

  const resource = node.resourceId
    ? resourceById(state, node.resourceId)
    : undefined;
  const resourceId = resource?.id ?? "";
  const label = resourceLabel(resource);

  if (node.kind === "source") {
    return {
      inputs: [],
      outputs: [{
        id: "source-out",
        resourceId,
        amount: Number.POSITIVE_INFINITY,
        direction: "output",
        label,
      }],
    };
  }
  if (node.kind === "input") {
    return {
      inputs: [],
      outputs: (node.inputSupplies ?? []).map((supply) => {
        const supplyResource = resourceById(state, supply.resourceId);
        return {
          id: `input-out:${supply.id}`,
          resourceId: supplyResource?.id ?? "",
          amount: supply.amount,
          direction: "output" as const,
          label: resourceLabel(supplyResource),
        };
      }),
    };
  }
  if (node.kind === "extract") {
    return {
      inputs: dynamicInputPorts(state, node, "extract"),
      outputs: [],
    };
  }
  if (node.kind === "splitter") {
    return {
      inputs: [{
        id: "split-in",
        resourceId,
        amount: 1,
        direction: "input",
        label,
      }],
      outputs: [0, 1].map((index) => ({
        id: `split-out-${index}`,
        resourceId,
        amount: node.splitRatios?.[index] ?? 0.5,
        direction: "output" as const,
        label,
      })),
    };
  }
  if (node.kind === "merger") {
    return {
      inputs: dynamicInputPorts(state, node, "merger"),
      outputs: [{
        id: "merge-out",
        resourceId,
        amount: 1,
        direction: "output",
        label,
      }],
    };
  }
  return { inputs: [], outputs: [] };
}

export function validateConnection(
  state: ProjectState,
  sourceNode: FlowNode,
  sourcePortId: string,
  targetNode: FlowNode,
  targetPortId: string,
  locale: Locale = "ko",
): string | null {
  if (sourceNode.id === targetNode.id) {
    return translate(locale, "engine.connection.sameNode");
  }
  const source = portsForNode(state, sourceNode).outputs.find((port) =>
    port.id === sourcePortId
  );
  const target = portsForNode(state, targetNode).inputs.find((port) =>
    port.id === targetPortId
  );
  if (!source || !target) {
    return translate(locale, "engine.connection.direction");
  }
  if (sourceNode.finalOutputPortIds?.includes(sourcePortId)) {
    return translate(locale, "engine.connection.finalOutput");
  }
  if (!source.resourceId) {
    return translate(locale, "engine.connection.sourceResourceRequired");
  }
  const targetAutomaticallyInfersResource = [
    "splitter",
    "merger",
  ].includes(targetNode.kind);
  const otherIncomingResource = state.edges.find((edge) =>
    edge.targetNodeId === targetNode.id &&
    edge.targetPortId !== targetPortId
  )?.resourceId;
  const requiredTargetResource = targetNode.kind === "extract"
    ? ""
    : targetAutomaticallyInfersResource
    ? otherIncomingResource ?? ""
    : target.resourceId;
  if (
    requiredTargetResource &&
    source.resourceId !== requiredTargetResource
  ) {
    const from = resourceById(state, source.resourceId)?.name ??
      translate(locale, "common.unknown");
    const to = resourceById(state, requiredTargetResource)?.name ??
      translate(locale, "common.unknown");
    return translate(locale, "engine.connection.resourceMismatch", {
      from,
      to,
    });
  }
  return null;
}

function outgoing(edges: Edge[], nodeId: string, portId: string): Edge[] {
  return edges.filter((edge) =>
    edge.sourceNodeId === nodeId && edge.sourcePortId === portId
  );
}

export interface SimulationOptions {
  inputNodeId?: string;
}

function connectedComponent(state: ProjectState, rootId: string): Set<string> {
  const connected = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of state.edges) {
      if (
        connected.has(edge.sourceNodeId) && !connected.has(edge.targetNodeId)
      ) {
        connected.add(edge.targetNodeId);
        changed = true;
      }
      if (
        connected.has(edge.targetNodeId) && !connected.has(edge.sourceNodeId)
      ) {
        connected.add(edge.sourceNodeId);
        changed = true;
      }
    }
  }
  return connected;
}

function forwardReachable(state: ProjectState, rootId: string): Set<string> {
  const reachable = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of state.edges) {
      if (
        reachable.has(edge.sourceNodeId) &&
        !reachable.has(edge.targetNodeId)
      ) {
        reachable.add(edge.targetNodeId);
        changed = true;
      }
    }
  }
  return reachable;
}

function addAmount(
  record: Record<string, number>,
  resourceId: string,
  amount: number,
): void {
  if (!resourceId || !(amount > 0)) return;
  record[resourceId] = (record[resourceId] ?? 0) + amount;
}

export function simulate(
  state: ProjectState,
  locale: Locale = "ko",
  options: SimulationOptions = {},
): SimulationResult {
  const result: SimulationResult = {
    nodeRuns: {},
    edgeFlows: {},
    outputs: {},
    remainingResources: {},
    circulatingResources: {},
    auxiliaryTotals: {},
    elapsedTime: 0,
    warnings: [],
  };
  const available = new Map<string, number>();
  const arrivalTimes = new Map<string, number>();
  const availableResources = new Map<string, string>();
  const incomingEdgeByBuffer = new Map<string, string>();
  const firedNodes = new Set<string>();
  const firedInfiniteRecipes = new Set<string>();
  const machineAvailableAt = new Map<string, number>();
  const activeNodeIds = options.inputNodeId
    ? connectedComponent(state, options.inputNodeId)
    : new Set(state.nodes.map((node) => node.id));
  const warningNodeIds = options.inputNodeId
    ? forwardReachable(state, options.inputNodeId)
    : activeNodeIds;

  if (options.inputNodeId) {
    for (const node of state.nodes) {
      if (node.kind === "input" && node.id !== options.inputNodeId) {
        activeNodeIds.delete(node.id);
      }
    }
  }
  const loops = findClosedLoops(state, activeNodeIds);
  const circulatingEdgeIds = new Set(
    loops.flatMap((loop) => {
      const resourceIds = new Set(loop.circulatingResourceIds);
      return state.edges.filter((edge) =>
        loop.edgeIds.includes(edge.id) && resourceIds.has(edge.resourceId)
      ).map((edge) => edge.id);
    }),
  );
  let utilityCycleDetected = false;

  const emitOutput = (
    node: FlowNode,
    portId: string,
    amount: number,
    readyAt: number,
    traversedEdges = new Set<string>(),
  ): void => {
    if (!(amount > 0)) return;
    const port = portsForNode(state, node).outputs.find((item) =>
      item.id === portId
    );
    if (!port) return;
    if (node.finalOutputPortIds?.includes(portId)) {
      addAmount(result.outputs, port.resourceId, amount);
      result.elapsedTime = Math.max(result.elapsedTime, readyAt);
      return;
    }
    const edges = outgoing(state.edges, node.id, portId).filter((edge) =>
      activeNodeIds.has(edge.targetNodeId)
    );
    if (!edges.length) {
      if (Number.isFinite(amount)) {
        addAmount(result.remainingResources, port.resourceId, amount);
      }
      return;
    }
    const share = amount / edges.length;
    for (const edge of edges) {
      if (traversedEdges.has(edge.id)) {
        utilityCycleDetected = true;
        continue;
      }
      result.edgeFlows[edge.id] = (result.edgeFlows[edge.id] ?? 0) + share;
      const nextTraversed = new Set(traversedEdges);
      nextTraversed.add(edge.id);
      deliver(
        edge.targetNodeId,
        edge.targetPortId,
        edge.resourceId,
        share,
        readyAt,
        edge.id,
        nextTraversed,
      );
    }
  };

  const deliver = (
    nodeId: string,
    portId: string,
    resourceId: string,
    amount: number,
    readyAt: number,
    incomingEdgeId: string,
    traversedEdges: Set<string>,
  ): void => {
    const node = state.nodes.find((item) => item.id === nodeId);
    if (!node || !activeNodeIds.has(node.id)) return;
    if (node.kind === "machine") {
      const key = `${node.id}:${portId}`;
      available.set(key, (available.get(key) ?? 0) + amount);
      arrivalTimes.set(key, Math.max(arrivalTimes.get(key) ?? 0, readyAt));
      availableResources.set(key, resourceId);
      incomingEdgeByBuffer.set(key, incomingEdgeId);
      return;
    }
    if (node.kind === "splitter") {
      portsForNode(state, node).outputs.forEach((port, index) => {
        emitOutput(
          node,
          port.id,
          amount * (node.splitRatios?.[index] ?? 0.5),
          readyAt,
          traversedEdges,
        );
      });
      return;
    }
    if (node.kind === "merger") {
      emitOutput(node, "merge-out", amount, readyAt, traversedEdges);
      return;
    }
    if (node.kind === "extract") {
      addAmount(result.outputs, resourceId, amount);
      result.elapsedTime = Math.max(result.elapsedTime, readyAt);
    }
  };

  for (
    const node of state.nodes.filter((item) =>
      item.kind === "source" && activeNodeIds.has(item.id)
    )
  ) {
    emitOutput(node, "source-out", Number.POSITIVE_INFINITY, 0);
  }

  for (
    const node of state.nodes.filter((item) =>
      item.kind === "input" &&
      activeNodeIds.has(item.id) &&
      (!options.inputNodeId || item.id === options.inputNodeId)
    )
  ) {
    for (const supply of node.inputSupplies ?? []) {
      emitOutput(
        node,
        `input-out:${supply.id}`,
        Math.max(0, supply.amount),
        0,
      );
    }
  }

  let reachedIterationLimit = true;
  for (let pass = 0; pass < 10_000; pass++) {
    let changed = false;
    for (
      const node of state.nodes.filter((item) =>
        item.kind === "machine" && activeNodeIds.has(item.id)
      )
    ) {
      const ports = portsForNode(state, node);
      const recipes = activeRecipesForNode(state, node);
      for (const recipe of recipes) {
        const inputPorts = ports.inputs.filter((port) =>
          port.recipeId === recipe.id
        );
        if (
          !inputPorts.length ||
          !inputPorts.every((port) =>
            (available.get(`${node.id}:${port.id}`) ?? 0) + 1e-9 >= port.amount
          )
        ) continue;
        const capacity = Math.min(
          ...inputPorts.map((port) =>
            (available.get(`${node.id}:${port.id}`) ?? 0) / port.amount
          ),
        );
        const runs = Number.isFinite(capacity)
          ? Math.floor(capacity + 1e-9)
          : capacity;
        if (!(runs > 0)) continue;
        const infiniteKey = `${node.id}:${recipe.id}`;
        if (!Number.isFinite(runs) && firedInfiniteRecipes.has(infiniteKey)) {
          continue;
        }
        if (!Number.isFinite(runs)) firedInfiniteRecipes.add(infiniteKey);
        const inputReadyAt = inputPorts.reduce(
          (latest, port) =>
            Math.max(
              latest,
              arrivalTimes.get(`${node.id}:${port.id}`) ?? 0,
            ),
          0,
        );
        const startAt = Math.max(
          inputReadyAt,
          machineAvailableAt.get(node.id) ?? 0,
        );
        const finishAt = startAt + runs * recipe.duration;
        for (const port of inputPorts) {
          const key = `${node.id}:${port.id}`;
          const current = available.get(key) ?? 0;
          if (Number.isFinite(current)) {
            available.set(key, Math.max(0, current - runs * port.amount));
          }
        }
        result.nodeRuns[node.id] = (result.nodeRuns[node.id] ?? 0) + runs;
        for (const use of recipe.auxiliaryUses) {
          result.auxiliaryTotals[use.auxiliaryId] =
            (result.auxiliaryTotals[use.auxiliaryId] ?? 0) +
            runs * use.amount;
        }
        for (const output of recipe.outputs) {
          emitOutput(
            node,
            `${recipe.id}:${output.id}`,
            runs * output.amount * probabilityForOutput(output),
            finishAt,
          );
        }
        machineAvailableAt.set(node.id, finishAt);
        result.elapsedTime = Math.max(result.elapsedTime, finishAt);
        firedNodes.add(node.id);
        changed = true;
      }
    }
    if (!changed) {
      reachedIterationLimit = false;
      break;
    }
  }

  for (
    const node of state.nodes.filter((item) =>
      item.kind === "machine" && warningNodeIds.has(item.id)
    )
  ) {
    if (!firedNodes.has(node.id)) {
      const title =
        node.titleKey && translatableNodeTitleKeys.has(node.titleKey)
          ? translate(locale, node.titleKey)
          : node.title;
      result.warnings.push(
        translate(locale, "engine.simulation.cannotCalculate", {
          node: title,
        }),
      );
    }
  }
  if (reachedIterationLimit) {
    result.warnings.push(
      translate(locale, "engine.simulation.iterationLimit"),
    );
  }
  if (utilityCycleDetected) {
    result.warnings.push(
      translate(locale, "engine.simulation.utilityCycle"),
    );
  }
  for (const [key, amount] of available) {
    if (!Number.isFinite(amount) || !(amount > 1e-9)) continue;
    const resourceId = availableResources.get(key);
    if (!resourceId) continue;
    const incomingEdgeId = incomingEdgeByBuffer.get(key);
    addAmount(
      incomingEdgeId && circulatingEdgeIds.has(incomingEdgeId)
        ? result.circulatingResources
        : result.remainingResources,
      resourceId,
      amount,
    );
  }
  return result;
}

export const exampleState: ProjectState = {
  version: 2,
  resources: [
    {
      id: "iron-ore",
      name: "철광석",
      symbol: "Fe",
      category: "material",
      unit: "kg",
      color: "#ef8d5d",
    },
    {
      id: "iron-plate",
      name: "철판",
      symbol: "PL",
      category: "material",
      unit: "kg",
      color: "#8096b3",
    },
    {
      id: "gear",
      name: "기어",
      symbol: "GR",
      category: "material",
      unit: "개",
      color: "#66b894",
    },
  ],
  auxiliaries: [
    { id: "electricity", name: "전력", unit: "kWh", color: "#f5c451" },
    { id: "coolant", name: "냉각수", unit: "L", color: "#55a9e8" },
  ],
  machines: [
    {
      id: "furnace",
      name: "산업용 용광로",
      description: "금속 원료를 가열하고 제련합니다.",
    },
    {
      id: "press",
      name: "정밀 프레스",
      description: "금속 소재를 압착 성형합니다.",
    },
  ],
  recipes: [
    {
      id: "smelting",
      machineId: "furnace",
      description: "철광석을 가열해 철판을 생산합니다.",
      duration: 4,
      auxiliaryUses: [
        { auxiliaryId: "electricity", amount: 3.2 },
        { auxiliaryId: "coolant", amount: 0.4 },
      ],
      inputs: [{ id: "smelt-in", resourceId: "iron-ore", amount: 2 }],
      outputs: [{ id: "smelt-out", resourceId: "iron-plate", amount: 1 }],
    },
    {
      id: "fast-smelting",
      machineId: "furnace",
      description: "전력을 더 사용해 빠르게 제련합니다.",
      duration: 2.5,
      auxiliaryUses: [{ auxiliaryId: "electricity", amount: 4.8 }],
      inputs: [{ id: "fast-in", resourceId: "iron-ore", amount: 2.2 }],
      outputs: [{ id: "fast-out", resourceId: "iron-plate", amount: 1 }],
    },
    {
      id: "gear-press",
      machineId: "press",
      description: "철판을 압착해 기어를 생산합니다.",
      duration: 3,
      auxiliaryUses: [{ auxiliaryId: "electricity", amount: 1.5 }],
      inputs: [{ id: "press-in", resourceId: "iron-plate", amount: 2 }],
      outputs: [{ id: "press-out", resourceId: "gear", amount: 1 }],
    },
  ],
  nodes: [
    {
      id: "source-1",
      kind: "input",
      title: "철광석 입력",
      x: 70,
      y: 230,
      inputSupplies: [{
        id: "iron-ore-supply",
        resourceId: "iron-ore",
        amount: 120,
      }],
    },
    {
      id: "furnace-1",
      kind: "machine",
      title: "용광로 #01",
      x: 350,
      y: 190,
      machineId: "furnace",
      activeRecipeIds: ["smelting"],
      multiRecipe: false,
    },
    {
      id: "press-1",
      kind: "machine",
      title: "프레스 #01",
      x: 650,
      y: 190,
      machineId: "press",
      activeRecipeIds: ["gear-press"],
      finalOutputPortIds: ["gear-press:press-out"],
      multiRecipe: false,
    },
  ],
  edges: [
    {
      id: "edge-1",
      sourceNodeId: "source-1",
      sourcePortId: "input-out:iron-ore-supply",
      targetNodeId: "furnace-1",
      targetPortId: "smelting:smelt-in",
      resourceId: "iron-ore",
    },
    {
      id: "edge-2",
      sourceNodeId: "furnace-1",
      sourcePortId: "smelting:smelt-out",
      targetNodeId: "press-1",
      targetPortId: "gear-press:press-in",
      resourceId: "iron-plate",
    },
  ],
};

export const initialState: ProjectState = {
  version: 2,
  resources: [],
  auxiliaries: [],
  machines: [],
  recipes: [],
  nodes: [],
  edges: [],
};
