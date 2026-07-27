import {
  activeRecipesForNode,
  portsForNode,
  probabilityForOutput,
  recipeById,
  simulate,
} from "./engine.ts";
import { findClosedLoops } from "./closed_loops.ts";
import { type Locale, translate } from "./i18n.ts";
import type {
  FlowNode,
  ProjectState,
  Recipe,
  SimulationResult,
} from "./types.ts";

const EPSILON = 1e-7;

export interface MinimumInputBatch {
  amounts: Record<string, number>;
  exact: boolean;
  evaluatedCandidates: number;
  outputs: Record<string, number>;
  remainingResources: Record<string, number>;
  warnings: string[];
}

export interface ScheduleEvent {
  nodeId: string;
  recipeId: string;
  start: number;
  end: number;
}

export interface MachineScheduleStat {
  nodeId: string;
  cycles: number;
  busyTime: number;
  materialWaitTime: number;
  utilization: number;
  firstStart: number;
  lastFinish: number;
  immediateRestarts: number;
  score: number;
}

export interface BottleneckAnalysis {
  elapsedTime: number;
  events: ScheduleEvent[];
  machines: MachineScheduleStat[];
  bottleneckNodeIds: string[];
  outputs: Record<string, number>;
  remainingResources: Record<string, number>;
  circulatingResources: Record<string, number>;
  auxiliaryTotals: Record<string, number>;
  closedLoops: ClosedLoopAnalysis[];
  warnings: string[];
}

export interface ClosedLoopAnalysis {
  id: string;
  nodeIds: string[];
  edgeIds: string[];
  resourceIds: string[];
  initialResources: Record<string, number>;
  circulatingResources: Record<string, number>;
  completedCycles: number;
  nominalCycleTime: number;
  bottleneckNodeIds: string[];
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
  if (!resourceId || !(amount > EPSILON)) return;
  record[resourceId] = (record[resourceId] ?? 0) + amount;
}

function amountTotal(record: Record<string, number>): number {
  return Object.values(record).reduce((sum, amount) => sum + amount, 0);
}

type Terminal =
  | { kind: "machine"; key: string; nodeId: string; recipeId: string }
  | {
    kind: "output";
    key: string;
    nodeId: string;
    portId: string;
    amount: number;
  };

function minimumTerminals(
  state: ProjectState,
  inputNodeId: string,
): Terminal[] {
  const reachable = forwardReachable(state, inputNodeId);
  const terminals = new Map<string, Terminal>();
  const addOutputProducer = (
    nodeId: string,
    portId: string,
    visiting = new Set<string>(),
  ): void => {
    const visitKey = `${nodeId}:${portId}`;
    if (visiting.has(visitKey)) return;
    const nextVisiting = new Set(visiting);
    nextVisiting.add(visitKey);
    const node = state.nodes.find((item) => item.id === nodeId);
    if (!node || !reachable.has(node.id)) return;
    const port = portsForNode(state, node).outputs.find((item) =>
      item.id === portId
    );
    if (!port) return;

    if (node.kind === "machine" && port.recipeId) {
      const key = `machine:${node.id}:${port.recipeId}`;
      terminals.set(key, {
        kind: "machine",
        key,
        nodeId: node.id,
        recipeId: port.recipeId,
      });
      return;
    }

    const upstreamEdges = node.kind === "splitter"
      ? state.edges.filter((edge) =>
        edge.targetNodeId === node.id && edge.targetPortId === "split-in"
      )
      : node.kind === "merger"
      ? state.edges.filter((edge) => edge.targetNodeId === node.id)
      : [];
    if (upstreamEdges.length) {
      for (const edge of upstreamEdges) {
        addOutputProducer(
          edge.sourceNodeId,
          edge.sourcePortId,
          nextVisiting,
        );
      }
      return;
    }

    const key = `output:${node.id}:${port.id}`;
    terminals.set(key, {
      kind: "output",
      key,
      nodeId: node.id,
      portId: port.id,
      amount: Number.isFinite(port.amount) && port.amount > EPSILON
        ? port.amount
        : 1,
    });
  };

  for (const node of state.nodes) {
    if (!reachable.has(node.id)) continue;
    for (const portId of node.finalOutputPortIds ?? []) {
      addOutputProducer(node.id, portId);
    }
    if (node.kind !== "extract") continue;
    for (const edge of state.edges) {
      if (
        edge.targetNodeId === node.id &&
        reachable.has(edge.sourceNodeId)
      ) {
        addOutputProducer(edge.sourceNodeId, edge.sourcePortId);
      }
    }
  }
  return [...terminals.values()];
}

function candidateState(
  state: ProjectState,
  inputNodeId: string,
  amounts: Record<string, number>,
): ProjectState {
  const candidate = structuredClone(state);
  const inputNode = candidate.nodes.find((node) =>
    node.id === inputNodeId && node.kind === "input"
  );
  if (inputNode) {
    for (const supply of inputNode.inputSupplies ?? []) {
      supply.amount = Math.max(0, amounts[supply.id] ?? 0);
    }
  }
  return candidate;
}

function isExactBatch(
  result: SimulationResult,
  amounts: Record<string, number>,
): boolean {
  const hasInput = Object.values(amounts).some((amount) => amount > EPSILON);
  const hasOutput = Object.values(result.outputs).some((amount) =>
    amount > EPSILON
  );
  const hasRemaining = Object.values(result.remainingResources).some(
    (amount) => !Number.isFinite(amount) || amount > EPSILON,
  );
  return hasInput && hasOutput && !hasRemaining && !result.warnings.length;
}

function rounded(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.round((value + Number.EPSILON) * 1e9) / 1e9;
}

function buildMinimumCandidate(
  state: ProjectState,
  inputNodeId: string,
  terminals: Terminal[],
  multipliers: number[],
  currentFlows: Record<string, number>,
  locale: Locale,
): {
  amounts: Record<string, number>;
  warnings: string[];
  edgeRequirements: Record<string, number>;
  bootstrapSteps: Record<string, number>;
  bootstrapMaximums: Record<string, number>;
} {
  const warnings: string[] = [];
  const outputDemand = new Map<string, number>();
  const machineRuns = new Map<string, number>();
  const utilityInputDemand = new Map<string, number>();
  const supplyAmounts: Record<string, number> = {};
  const edgeRequirements: Record<string, number> = {};
  const bootstrapSteps: Record<string, number> = {};
  const bootstrapMaximums: Record<string, number> = {};
  let operations = 0;
  const closedLoops = findClosedLoops(state);
  const loopEdgeIds = new Set(
    closedLoops.flatMap((loop) => {
      const resourceIds = new Set(loop.circulatingResourceIds);
      return state.edges.filter((edge) =>
        loop.edgeIds.includes(edge.id) && resourceIds.has(edge.resourceId)
      ).map((edge) => edge.id);
    }),
  );
  const inputNode = state.nodes.find((node) =>
    node.id === inputNodeId && node.kind === "input"
  );

  const outgoingCount = (nodeId: string, portId: string): number =>
    Math.max(
      1,
      state.edges.filter((edge) =>
        edge.sourceNodeId === nodeId && edge.sourcePortId === portId
      ).length,
    );

  const requestInput = (
    node: FlowNode,
    portId: string,
    amount: number,
  ): void => {
    if (!(amount > EPSILON)) return;
    const edge = state.edges.find((item) =>
      item.targetNodeId === node.id && item.targetPortId === portId
    );
    if (!edge) {
      warnings.push(
        translate(locale, "analysis.minimum.missingInput", {
          node: node.title,
        }),
      );
      return;
    }
    edgeRequirements[edge.id] = Math.max(
      edgeRequirements[edge.id] ?? 0,
      amount,
    );
    if (loopEdgeIds.has(edge.id)) {
      const targetPort = portsForNode(state, node).inputs.find((port) =>
        port.id === portId
      );
      const bootstrapSupply = inputNode?.inputSupplies?.find((supply) =>
        supply.resourceId === edge.resourceId
      );
      if (bootstrapSupply && targetPort) {
        bootstrapSteps[bootstrapSupply.id] = Math.max(
          bootstrapSteps[bootstrapSupply.id] ?? 0,
          targetPort.amount,
        );
        bootstrapMaximums[bootstrapSupply.id] = Math.max(
          bootstrapMaximums[bootstrapSupply.id] ?? 0,
          amount,
        );
        supplyAmounts[bootstrapSupply.id] = Math.max(
          supplyAmounts[bootstrapSupply.id] ?? 0,
          targetPort.amount,
        );
        return;
      }
    }
    requestOutput(
      edge.sourceNodeId,
      edge.sourcePortId,
      amount * outgoingCount(edge.sourceNodeId, edge.sourcePortId),
    );
  };

  const requestMachineRuns = (
    node: FlowNode,
    recipe: Recipe,
    desiredRuns: number,
  ): void => {
    const key = `${node.id}:${recipe.id}`;
    const previous = machineRuns.get(key) ?? 0;
    if (!(desiredRuns > previous + EPSILON)) return;
    machineRuns.set(key, desiredRuns);
    for (const input of recipe.inputs) {
      requestInput(
        node,
        `${recipe.id}:${input.id}`,
        desiredRuns * input.amount,
      );
    }
  };

  const requestOutput = (
    nodeId: string,
    portId: string,
    amount: number,
  ): void => {
    operations += 1;
    if (operations > 10_000) {
      if (!warnings.includes(translate(locale, "analysis.minimum.cycle"))) {
        warnings.push(translate(locale, "analysis.minimum.cycle"));
      }
      return;
    }
    const key = `${nodeId}:${portId}`;
    const previous = outputDemand.get(key) ?? 0;
    if (!(amount > previous + EPSILON)) return;
    outputDemand.set(key, amount);
    const node = state.nodes.find((item) => item.id === nodeId);
    if (!node) return;

    if (node.kind === "input") {
      if (node.id !== inputNodeId) {
        warnings.push(translate(locale, "analysis.minimum.otherInput"));
        return;
      }
      const supplyId = portId.startsWith("input-out:")
        ? portId.slice("input-out:".length)
        : "";
      if (supplyId) supplyAmounts[supplyId] = amount;
      return;
    }
    if (node.kind === "source") return;

    if (node.kind === "machine") {
      const port = portsForNode(state, node).outputs.find((item) =>
        item.id === portId
      );
      const recipe = port?.recipeId
        ? recipeById(state, port.recipeId)
        : undefined;
      const recipePort = recipe?.outputs.find((item) =>
        `${recipe.id}:${item.id}` === portId
      );
      const yieldPerRun = recipePort
        ? recipePort.amount * probabilityForOutput(recipePort)
        : 0;
      if (!recipe || !(yieldPerRun > EPSILON)) {
        warnings.push(
          translate(locale, "analysis.minimum.zeroYield", {
            node: node.title,
          }),
        );
        return;
      }
      requestMachineRuns(node, recipe, amount / yieldPerRun);
      return;
    }

    if (node.kind === "splitter") {
      const outputIndex = portId === "split-out-0" ? 0 : 1;
      const ratio = node.splitRatios?.[outputIndex] ?? 0.5;
      if (!(ratio > EPSILON)) {
        warnings.push(
          translate(locale, "analysis.minimum.zeroRatio", {
            node: node.title,
          }),
        );
        return;
      }
      const desiredInput = Math.max(
        ...[0, 1].map((index) => {
          const demand = outputDemand.get(
            `${node.id}:split-out-${index}`,
          ) ?? 0;
          const outputRatio = node.splitRatios?.[index] ?? 0.5;
          return outputRatio > EPSILON ? demand / outputRatio : 0;
        }),
      );
      const previousInput = utilityInputDemand.get(node.id) ?? 0;
      if (desiredInput > previousInput + EPSILON) {
        utilityInputDemand.set(node.id, desiredInput);
        requestInput(node, "split-in", desiredInput);
      }
      return;
    }

    if (node.kind === "merger") {
      const previousInput = utilityInputDemand.get(node.id) ?? 0;
      if (!(amount > previousInput + EPSILON)) return;
      utilityInputDemand.set(node.id, amount);
      const inputs = portsForNode(state, node).inputs.filter((port) =>
        state.edges.some((edge) =>
          edge.targetNodeId === node.id && edge.targetPortId === port.id
        )
      );
      const weighted = inputs.map((port) => {
        const edge = state.edges.find((item) =>
          item.targetNodeId === node.id && item.targetPortId === port.id
        );
        return { port, weight: edge ? currentFlows[edge.id] ?? 0 : 0 };
      });
      const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
      for (const item of weighted) {
        const weight = totalWeight > EPSILON
          ? item.weight / totalWeight
          : 1 / Math.max(1, weighted.length);
        requestInput(node, item.port.id, amount * weight);
      }
    }
  };

  terminals.forEach((terminal, index) => {
    const multiplier = multipliers[index] ?? 1;
    if (terminal.kind === "machine") {
      const node = state.nodes.find((item) => item.id === terminal.nodeId);
      const recipe = recipeById(state, terminal.recipeId);
      if (node && recipe) requestMachineRuns(node, recipe, multiplier);
    } else {
      requestOutput(
        terminal.nodeId,
        terminal.portId,
        multiplier * terminal.amount,
      );
    }
  });

  for (const supply of inputNode?.inputSupplies ?? []) {
    supplyAmounts[supply.id] = rounded(supplyAmounts[supply.id] ?? 0);
  }
  return {
    amounts: supplyAmounts,
    warnings: [...new Set(warnings)],
    edgeRequirements,
    bootstrapSteps,
    bootstrapMaximums,
  };
}

function gcd(first: number, second: number): number {
  let a = Math.abs(Math.round(first));
  let b = Math.abs(Math.round(second));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function lcm(first: number, second: number): number {
  return Math.abs(first * second) / gcd(first, second);
}

function approximateFraction(
  value: number,
  maxDenominator = 10_000,
): { numerator: number; denominator: number } {
  if (!Number.isFinite(value)) return { numerator: 0, denominator: 1 };
  let bestNumerator = Math.round(value);
  let bestDenominator = 1;
  let bestError = Math.abs(value - bestNumerator);
  for (let denominator = 2; denominator <= maxDenominator; denominator += 1) {
    const numerator = Math.round(value * denominator);
    const error = Math.abs(value - numerator / denominator);
    if (error < bestError) {
      bestNumerator = numerator;
      bestDenominator = denominator;
      bestError = error;
      if (error < 1e-10) break;
    }
  }
  const divisor = gcd(bestNumerator, bestDenominator);
  return {
    numerator: bestNumerator / divisor,
    denominator: bestDenominator / divisor,
  };
}

function integerNullspaceCandidate(matrix: number[][]): number[] | null {
  if (!matrix.length) return [];
  const columnCount = matrix[0].length;
  const reduced = matrix.map((row) => [...row]);
  const pivots: number[] = [];
  let pivotRow = 0;
  for (
    let column = 0;
    column < columnCount && pivotRow < reduced.length;
    column += 1
  ) {
    let selected = pivotRow;
    for (let row = pivotRow + 1; row < reduced.length; row += 1) {
      if (
        Math.abs(reduced[row][column]) > Math.abs(reduced[selected][column])
      ) {
        selected = row;
      }
    }
    if (Math.abs(reduced[selected][column]) <= EPSILON) continue;
    [reduced[pivotRow], reduced[selected]] = [
      reduced[selected],
      reduced[pivotRow],
    ];
    const divisor = reduced[pivotRow][column];
    reduced[pivotRow] = reduced[pivotRow].map((value) => value / divisor);
    for (let row = 0; row < reduced.length; row += 1) {
      if (row === pivotRow) continue;
      const factor = reduced[row][column];
      if (Math.abs(factor) <= EPSILON) continue;
      reduced[row] = reduced[row].map((value, index) =>
        value - factor * reduced[pivotRow][index]
      );
    }
    pivots[pivotRow] = column;
    pivotRow += 1;
  }
  const pivotColumns = new Set(pivots);
  const freeColumns = Array.from(
    { length: columnCount },
    (_, index) => index,
  ).filter((column) => !pivotColumns.has(column));
  if (!freeColumns.length) return null;

  let best: number[] | null = null;
  const freeValues = Array(freeColumns.length).fill(1) as number[];
  let tried = 0;
  const tryAssignment = (): void => {
    tried += 1;
    if (tried > 4096) return;
    const solution = Array(columnCount).fill(0) as number[];
    freeColumns.forEach((column, index) => {
      solution[column] = freeValues[index];
    });
    for (let row = pivots.length - 1; row >= 0; row -= 1) {
      const pivot = pivots[row];
      solution[pivot] = -reduced[row].reduce(
        (sum, coefficient, column) =>
          column === pivot ? sum : sum + coefficient * solution[column],
        0,
      );
    }
    if (solution.some((value) => !(value > EPSILON))) return;
    const fractions = solution.map((value) => approximateFraction(value));
    const denominator = fractions.reduce(
      (multiple, fraction) => lcm(multiple, fraction.denominator),
      1,
    );
    const integers = fractions.map((fraction) =>
      Math.round(fraction.numerator * denominator / fraction.denominator)
    );
    const divisor = integers.reduce((common, value) => gcd(common, value), 0);
    const normalized = integers.map((value) => value / Math.max(1, divisor));
    if (normalized.some((value) => value <= 0)) return;
    if (
      !best ||
      normalized.reduce((sum, value) => sum + value, 0) <
        best.reduce((sum, value) => sum + value, 0)
    ) {
      best = normalized;
    }
  };
  const enumerateFree = (index: number): void => {
    if (tried > 4096) return;
    if (index === freeColumns.length) {
      tryAssignment();
      return;
    }
    const limit = freeColumns.length <= 4 ? 8 : 2;
    for (let value = 1; value <= limit; value += 1) {
      freeValues[index] = value;
      enumerateFree(index + 1);
    }
  };
  enumerateFree(0);
  return best;
}

function analyticTerminalMultipliers(
  state: ProjectState,
  inputNodeId: string,
  terminals: Terminal[],
  currentFlows: Record<string, number>,
  locale: Locale,
): number[] | null {
  if (!terminals.length) return null;
  const isolated = terminals.map((_, terminalIndex) =>
    buildMinimumCandidate(
      state,
      inputNodeId,
      terminals,
      terminals.map((__, index) => index === terminalIndex ? 1 : 0),
      currentFlows,
      locale,
    )
  );
  const matrix: number[][] = [];
  const outputGroups = new Map<string, string[]>();
  for (const edge of state.edges) {
    const key = `${edge.sourceNodeId}:${edge.sourcePortId}`;
    outputGroups.set(key, [...(outputGroups.get(key) ?? []), edge.id]);
  }
  for (const edgeIds of outputGroups.values()) {
    if (edgeIds.length < 2) continue;
    const reference = edgeIds[0];
    for (const edgeId of edgeIds.slice(1)) {
      const row = isolated.map((candidate) =>
        (candidate.edgeRequirements[reference] ?? 0) -
        (candidate.edgeRequirements[edgeId] ?? 0)
      );
      if (row.some((value) => Math.abs(value) > EPSILON)) matrix.push(row);
    }
  }
  if (!matrix.length) return terminals.map(() => 1);
  return integerNullspaceCandidate(matrix);
}

function exactCandidateWithMinimumBootstrap(
  state: ProjectState,
  inputNodeId: string,
  candidate: ReturnType<typeof buildMinimumCandidate>,
  locale: Locale,
): { amounts: Record<string, number>; result: SimulationResult } | null {
  const baseAmounts = { ...candidate.amounts };
  const simulateAmounts = (amounts: Record<string, number>) => {
    const result = simulate(
      candidateState(state, inputNodeId, amounts),
      locale,
      { inputNodeId },
    );
    return { result, exact: isExactBatch(result, amounts) };
  };
  const base = simulateAmounts(baseAmounts);
  if (base.exact) return { amounts: baseAmounts, result: base.result };

  const bootstrapIds = Object.keys(candidate.bootstrapSteps).filter((id) =>
    (candidate.bootstrapSteps[id] ?? 0) > EPSILON
  );
  if (!bootstrapIds.length) return null;

  // Supplying the full requested loop demand is a safe upper bound: the
  // process can complete even before any material returns. Once that state is
  // valid, reduce each initial charge to the smallest amount that still starts
  // and completes the whole process.
  const amounts = { ...baseAmounts };
  const maximumUnits: Record<string, number> = {};
  for (const supplyId of bootstrapIds) {
    const step = candidate.bootstrapSteps[supplyId];
    const maximum = Math.max(
      amounts[supplyId] ?? 0,
      candidate.bootstrapMaximums[supplyId] ?? 0,
    );
    const units = Math.max(1, Math.ceil((maximum - EPSILON) / step));
    maximumUnits[supplyId] = units;
    amounts[supplyId] = rounded(units * step);
  }
  let upper = simulateAmounts(amounts);
  if (!upper.exact) return null;

  for (const supplyId of bootstrapIds) {
    const step = candidate.bootstrapSteps[supplyId];
    const minimumUnits = Math.max(
      1,
      Math.ceil(((baseAmounts[supplyId] ?? step) - EPSILON) / step),
    );
    let low = minimumUnits;
    let high = maximumUnits[supplyId];
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const trialAmounts = {
        ...amounts,
        [supplyId]: rounded(middle * step),
      };
      const trial = simulateAmounts(trialAmounts);
      if (trial.exact) {
        high = middle;
        amounts[supplyId] = trialAmounts[supplyId];
        upper = trial;
      } else {
        low = middle + 1;
      }
    }
    amounts[supplyId] = rounded(low * step);
    upper = simulateAmounts(amounts);
    if (!upper.exact) return null;
  }

  return { amounts, result: upper.result };
}

export function findMinimumInputBatch(
  state: ProjectState,
  inputNodeId: string,
  locale: Locale = "ko",
): MinimumInputBatch {
  const inputNode = state.nodes.find((node) =>
    node.id === inputNodeId && node.kind === "input"
  );
  if (!inputNode) {
    return {
      amounts: {},
      exact: false,
      evaluatedCandidates: 0,
      outputs: {},
      remainingResources: {},
      warnings: [translate(locale, "analysis.minimum.inputMissing")],
    };
  }
  const terminals = minimumTerminals(state, inputNodeId);
  if (!terminals.length) {
    return {
      amounts: Object.fromEntries(
        (inputNode.inputSupplies ?? []).map((supply) => [supply.id, 0]),
      ),
      exact: false,
      evaluatedCandidates: 0,
      outputs: {},
      remainingResources: {},
      warnings: [translate(locale, "analysis.minimum.noFinalOutput")],
    };
  }

  const current = simulate(state, locale, { inputNodeId });
  const base = buildMinimumCandidate(
    state,
    inputNodeId,
    terminals,
    terminals.map(() => 1),
    current.edgeFlows,
    locale,
  );
  const baseResult = simulate(
    candidateState(state, inputNodeId, base.amounts),
    locale,
    { inputNodeId },
  );
  const fallback = {
    amounts: base.amounts,
    result: baseResult,
    warnings: base.warnings,
  };
  let best:
    | {
      amounts: Record<string, number>;
      result: SimulationResult;
      total: number;
    }
    | undefined;
  let evaluatedCandidates = 0;
  const terminalCount = terminals.length;
  const limit = terminalCount === 1
    ? 64
    : terminalCount === 2
    ? 24
    : terminalCount === 3
    ? 12
    : terminalCount === 4
    ? 8
    : 2;
  const multipliers = Array(terminalCount).fill(1) as number[];
  const evaluatedBootstrapCandidates = new Map<
    string,
    { amounts: Record<string, number>; result: SimulationResult } | null
  >();
  let stop = false;

  const evaluate = (): void => {
    if (stop) return;
    evaluatedCandidates += 1;
    if (evaluatedCandidates > 10_000) {
      stop = true;
      return;
    }
    const candidate = buildMinimumCandidate(
      state,
      inputNodeId,
      terminals,
      multipliers,
      current.edgeFlows,
      locale,
    );
    if (candidate.warnings.length) return;
    const candidateKey = JSON.stringify(
      [
        candidate.amounts,
        candidate.bootstrapSteps,
        candidate.bootstrapMaximums,
      ].map((record) =>
        Object.entries(record).sort(([first], [second]) =>
          first.localeCompare(second)
        )
      ),
    );
    let exactCandidate = evaluatedBootstrapCandidates.get(candidateKey);
    if (!evaluatedBootstrapCandidates.has(candidateKey)) {
      exactCandidate = exactCandidateWithMinimumBootstrap(
        state,
        inputNodeId,
        candidate,
        locale,
      );
      evaluatedBootstrapCandidates.set(candidateKey, exactCandidate);
    }
    if (!exactCandidate) return;
    const total = amountTotal(exactCandidate.amounts);
    if (!best || total < best.total - EPSILON) {
      best = {
        amounts: exactCandidate.amounts,
        result: exactCandidate.result,
        total,
      };
    }
  };

  const enumerate = (index: number): void => {
    if (stop) return;
    if (index === terminalCount) {
      evaluate();
      return;
    }
    for (let value = 1; value <= limit && !stop; value += 1) {
      multipliers[index] = value;
      enumerate(index + 1);
    }
  };
  const analytic = analyticTerminalMultipliers(
    state,
    inputNodeId,
    terminals,
    current.edgeFlows,
    locale,
  );
  if (analytic?.length === terminalCount) {
    analytic.forEach((value, index) => {
      multipliers[index] = value;
    });
    evaluate();
  }
  enumerate(0);

  if (best) {
    return {
      amounts: best.amounts,
      exact: true,
      evaluatedCandidates,
      outputs: best.result.outputs,
      remainingResources: best.result.remainingResources,
      warnings: [],
    };
  }
  return {
    amounts: fallback.amounts,
    exact: false,
    evaluatedCandidates,
    outputs: fallback.result.outputs,
    remainingResources: fallback.result.remainingResources,
    warnings: [
      ...fallback.warnings,
      ...fallback.result.warnings,
      translate(locale, "analysis.minimum.notExact"),
    ],
  };
}

type MutableMachineStat = Omit<
  MachineScheduleStat,
  "materialWaitTime" | "utilization" | "score"
>;

type PendingEvent = ScheduleEvent & {
  outputs: Array<{ portId: string; amount: number }>;
};

function recipeForOutputPort(
  state: ProjectState,
  node: FlowNode,
  portId: string,
): Recipe | undefined {
  const port = portsForNode(state, node).outputs.find((item) =>
    item.id === portId
  );
  return port?.recipeId ? recipeById(state, port.recipeId) : undefined;
}

export function analyzeBottlenecks(
  state: ProjectState,
  inputNodeId: string,
  locale: Locale = "ko",
): BottleneckAnalysis {
  const inputNode = state.nodes.find((node) =>
    node.id === inputNodeId && node.kind === "input"
  );
  if (!inputNode) {
    return {
      elapsedTime: 0,
      events: [],
      machines: [],
      bottleneckNodeIds: [],
      outputs: {},
      remainingResources: {},
      circulatingResources: {},
      auxiliaryTotals: {},
      closedLoops: [],
      warnings: [translate(locale, "analysis.schedule.inputMissing")],
    };
  }

  const activeNodeIds = forwardReachable(state, inputNodeId);
  const loopComponents = findClosedLoops(state, activeNodeIds);
  const loopByNodeId = new Map(
    loopComponents.flatMap((loop) =>
      loop.nodeIds.map((nodeId) => [nodeId, loop] as const)
    ),
  );
  const circulatingEdgeIds = new Set(
    loopComponents.flatMap((loop) => {
      const resourceIds = new Set(loop.circulatingResourceIds);
      return state.edges.filter((edge) =>
        loop.edgeIds.includes(edge.id) && resourceIds.has(edge.resourceId)
      ).map((edge) => edge.id);
    }),
  );
  const loopInitialResources = new Map<string, Record<string, number>>(
    loopComponents.map((loop) => [loop.id, {}]),
  );
  const buffers = new Map<string, number>();
  const bufferResources = new Map<string, string>();
  const bufferIncomingEdges = new Map<string, string>();
  const outputs: Record<string, number> = {};
  const remainingResources: Record<string, number> = {};
  const circulatingResources: Record<string, number> = {};
  const auxiliaryTotals: Record<string, number> = {};
  const warnings: string[] = [];
  const warningSet = new Set<string>();
  const events: ScheduleEvent[] = [];
  const pending: PendingEvent[] = [];
  const busy = new Map<string, PendingEvent>();
  const recipeCursor = new Map<string, number>();
  const stats = new Map<string, MutableMachineStat>();
  const lastFinishBeforeStart = new Map<string, number>();
  let completedEvents = 0;
  let now = 0;

  const addWarning = (warning: string): void => {
    if (warningSet.has(warning)) return;
    warningSet.add(warning);
    warnings.push(warning);
  };

  const outgoingEdges = (nodeId: string, portId: string) =>
    state.edges.filter((edge) =>
      edge.sourceNodeId === nodeId &&
      edge.sourcePortId === portId &&
      activeNodeIds.has(edge.targetNodeId)
    );

  const infiniteMemo = new Map<string, boolean>();
  const isInfiniteOutput = (
    nodeId: string,
    portId: string,
    visiting = new Set<string>(),
  ): boolean => {
    const key = `${nodeId}:${portId}`;
    if (infiniteMemo.has(key)) return infiniteMemo.get(key)!;
    if (visiting.has(key)) return false;
    visiting.add(key);
    const node = state.nodes.find((item) => item.id === nodeId);
    let infinite = false;
    if (node?.kind === "source") {
      infinite = true;
    } else if (node?.kind === "splitter") {
      const edge = state.edges.find((item) =>
        item.targetNodeId === node.id && item.targetPortId === "split-in"
      );
      infinite = edge
        ? isInfiniteOutput(edge.sourceNodeId, edge.sourcePortId, visiting)
        : false;
    } else if (node?.kind === "merger") {
      infinite = state.edges.filter((edge) => edge.targetNodeId === node.id)
        .some((edge) =>
          isInfiniteOutput(edge.sourceNodeId, edge.sourcePortId, visiting)
        );
    } else if (node?.kind === "machine") {
      const recipe = recipeForOutputPort(state, node, portId);
      infinite = !!recipe && recipe.inputs.every((input) => {
        const edge = state.edges.find((item) =>
          item.targetNodeId === node.id &&
          item.targetPortId === `${recipe.id}:${input.id}`
        );
        return !!edge &&
          isInfiniteOutput(edge.sourceNodeId, edge.sourcePortId, visiting);
      });
    }
    visiting.delete(key);
    infiniteMemo.set(key, infinite);
    return infinite;
  };

  const emitOutput = (
    node: FlowNode,
    portId: string,
    amount: number,
    time: number,
  ): void => {
    if (!(amount > EPSILON)) return;
    const port = portsForNode(state, node).outputs.find((item) =>
      item.id === portId
    );
    if (!port) return;
    if (node.finalOutputPortIds?.includes(portId)) {
      addAmount(outputs, port.resourceId, amount);
      return;
    }
    const edges = outgoingEdges(node.id, portId);
    if (!edges.length) {
      if (Number.isFinite(amount)) {
        addAmount(remainingResources, port.resourceId, amount);
      }
      return;
    }
    const share = amount / edges.length;
    for (const edge of edges) {
      const targetLoop = loopByNodeId.get(edge.targetNodeId);
      if (
        targetLoop &&
        !targetLoop.nodeIds.includes(edge.sourceNodeId) &&
        targetLoop.circulatingResourceIds.includes(edge.resourceId) &&
        time <= EPSILON &&
        Number.isFinite(share)
      ) {
        addAmount(
          loopInitialResources.get(targetLoop.id)!,
          edge.resourceId,
          share,
        );
      }
      deliver(
        edge.targetNodeId,
        edge.targetPortId,
        edge.resourceId,
        share,
        time,
        edge.id,
      );
    }
  };

  const deliver = (
    nodeId: string,
    portId: string,
    resourceId: string,
    amount: number,
    time: number,
    incomingEdgeId: string,
  ): void => {
    const node = state.nodes.find((item) => item.id === nodeId);
    if (!node || !activeNodeIds.has(node.id)) return;
    if (node.kind === "machine") {
      const key = `${node.id}:${portId}`;
      buffers.set(key, (buffers.get(key) ?? 0) + amount);
      bufferResources.set(key, resourceId);
      bufferIncomingEdges.set(key, incomingEdgeId);
      return;
    }
    if (node.kind === "splitter") {
      portsForNode(state, node).outputs.forEach((port, index) => {
        emitOutput(
          node,
          port.id,
          amount * (node.splitRatios?.[index] ?? 0.5),
          time,
        );
      });
      return;
    }
    if (node.kind === "merger") {
      emitOutput(node, "merge-out", amount, time);
      return;
    }
    if (node.kind === "extract") {
      addAmount(outputs, resourceId, amount);
    }
  };

  const canStartRecipe = (node: FlowNode, recipe: Recipe): boolean =>
    recipe.inputs.every((input) => {
      const amount = buffers.get(`${node.id}:${recipe.id}:${input.id}`) ?? 0;
      return amount + EPSILON >= input.amount;
    });

  const startMachine = (node: FlowNode, time: number): boolean => {
    if (busy.has(node.id)) return false;
    const recipes = activeRecipesForNode(state, node);
    if (!recipes.length) return false;
    const cursor = recipeCursor.get(node.id) ?? 0;
    let selected: Recipe | undefined;
    let selectedIndex = cursor;
    for (let offset = 0; offset < recipes.length; offset += 1) {
      const index = (cursor + offset) % recipes.length;
      const recipe = recipes[index];
      if (canStartRecipe(node, recipe)) {
        selected = recipe;
        selectedIndex = index;
        break;
      }
    }
    if (!selected) return false;
    const allInputsInfinite = selected.inputs.every((input) =>
      buffers.get(`${node.id}:${selected!.id}:${input.id}`) ===
        Number.POSITIVE_INFINITY
    );
    if (allInputsInfinite) {
      addWarning(
        translate(locale, "analysis.schedule.unbounded", {
          node: node.title,
        }),
      );
      return false;
    }
    for (const input of selected.inputs) {
      const key = `${node.id}:${selected.id}:${input.id}`;
      const amount = buffers.get(key) ?? 0;
      if (Number.isFinite(amount)) {
        buffers.set(key, Math.max(0, amount - input.amount));
      }
    }
    for (const use of selected.auxiliaryUses) {
      auxiliaryTotals[use.auxiliaryId] =
        (auxiliaryTotals[use.auxiliaryId] ?? 0) + use.amount;
    }
    const end = time + Math.max(0, selected.duration);
    const event: PendingEvent = {
      nodeId: node.id,
      recipeId: selected.id,
      start: time,
      end,
      outputs: selected.outputs.map((output) => ({
        portId: `${selected!.id}:${output.id}`,
        amount: output.amount * probabilityForOutput(output),
      })),
    };
    pending.push(event);
    busy.set(node.id, event);
    recipeCursor.set(node.id, (selectedIndex + 1) % recipes.length);
    const stat = stats.get(node.id) ?? {
      nodeId: node.id,
      cycles: 0,
      busyTime: 0,
      firstStart: time,
      lastFinish: time,
      immediateRestarts: 0,
    };
    stat.firstStart = Math.min(stat.firstStart, time);
    stat.busyTime += Math.max(0, selected.duration);
    if (lastFinishBeforeStart.get(node.id) === time) {
      stat.immediateRestarts += 1;
    }
    stats.set(node.id, stat);
    return true;
  };

  const startAvailableMachines = (time: number): void => {
    for (
      const node of state.nodes.filter((item) =>
        item.kind === "machine" && activeNodeIds.has(item.id)
      )
    ) {
      startMachine(node, time);
    }
  };

  for (
    const node of state.nodes.filter((item) =>
      item.kind === "machine" && activeNodeIds.has(item.id)
    )
  ) {
    for (const port of portsForNode(state, node).inputs) {
      const edge = state.edges.find((item) =>
        item.targetNodeId === node.id && item.targetPortId === port.id
      );
      if (
        edge &&
        isInfiniteOutput(edge.sourceNodeId, edge.sourcePortId)
      ) {
        const key = `${node.id}:${port.id}`;
        buffers.set(key, Number.POSITIVE_INFINITY);
        bufferResources.set(key, edge.resourceId);
        bufferIncomingEdges.set(key, edge.id);
      }
    }
  }

  for (const supply of inputNode.inputSupplies ?? []) {
    emitOutput(
      inputNode,
      `input-out:${supply.id}`,
      Math.max(0, supply.amount),
      0,
    );
  }
  startAvailableMachines(0);

  while (pending.length && completedEvents < 100_000) {
    pending.sort((first, second) =>
      first.end - second.end || first.start - second.start
    );
    now = pending[0].end;
    const completing = pending.filter((event) =>
      Math.abs(event.end - now) <= EPSILON
    );
    pending.splice(0, completing.length);
    for (const event of completing) {
      busy.delete(event.nodeId);
      completedEvents += 1;
      events.push({
        nodeId: event.nodeId,
        recipeId: event.recipeId,
        start: event.start,
        end: event.end,
      });
      const stat = stats.get(event.nodeId);
      if (stat) {
        stat.cycles += 1;
        stat.lastFinish = event.end;
      }
      lastFinishBeforeStart.set(event.nodeId, event.end);
      const node = state.nodes.find((item) => item.id === event.nodeId);
      if (!node) continue;
      for (const output of event.outputs) {
        emitOutput(node, output.portId, output.amount, now);
      }
    }
    startAvailableMachines(now);
  }
  if (completedEvents >= 100_000) {
    addWarning(translate(locale, "analysis.schedule.limit"));
  }

  for (const [key, amount] of buffers) {
    if (!Number.isFinite(amount) || !(amount > EPSILON)) continue;
    const resourceId = bufferResources.get(key);
    if (!resourceId) continue;
    addAmount(
      circulatingEdgeIds.has(bufferIncomingEdges.get(key) ?? "")
        ? circulatingResources
        : remainingResources,
      resourceId,
      amount,
    );
  }

  const elapsedTime = events.reduce(
    (latest, event) => Math.max(latest, event.end),
    0,
  );
  const machineStats: MachineScheduleStat[] = [...stats.values()]
    .filter((stat) => stat.cycles > 0)
    .map((stat) => {
      const internalWait = Math.max(
        0,
        stat.lastFinish - stat.firstStart - stat.busyTime,
      );
      const materialWaitTime = stat.firstStart + internalWait;
      const utilization = elapsedTime > EPSILON
        ? stat.busyTime / elapsedTime
        : 0;
      const restartRatio = stat.cycles > 1
        ? stat.immediateRestarts / (stat.cycles - 1)
        : 0;
      const endCriticality = elapsedTime > EPSILON
        ? stat.lastFinish / elapsedTime
        : 0;
      const score = utilization * 0.75 + restartRatio * 0.1 +
        endCriticality * 0.15;
      return {
        ...stat,
        materialWaitTime,
        utilization,
        score,
      };
    })
    .sort((first, second) => second.score - first.score);
  const highestScore = machineStats[0]?.score ?? 0;
  const bottleneckNodeIds = machineStats
    .filter((stat) =>
      highestScore > EPSILON && stat.score >= highestScore * 0.97
    )
    .map((stat) => stat.nodeId);
  if (!machineStats.length) {
    addWarning(translate(locale, "analysis.schedule.noActivity"));
  }
  const closedLoops: ClosedLoopAnalysis[] = loopComponents.map((loop) => {
    const loopNodeIds = new Set(loop.nodeIds);
    const loopMachineNodes = state.nodes.filter((node) =>
      node.kind === "machine" && loopNodeIds.has(node.id)
    );
    const completedCycles = events.filter((event) =>
      loopNodeIds.has(event.nodeId)
    ).length;
    const nominalCycleTime = loopMachineNodes.reduce(
      (total, node) =>
        total +
        activeRecipesForNode(state, node).reduce(
          (recipeTotal, recipe) => recipeTotal + recipe.duration,
          0,
        ),
      0,
    );
    const loopCirculatingResources: Record<string, number> = {};
    for (const resourceId of loop.circulatingResourceIds) {
      const amount = circulatingResources[resourceId];
      if (amount > EPSILON) {
        loopCirculatingResources[resourceId] = amount;
      }
    }
    if (
      loopMachineNodes.length &&
      completedCycles === 0 &&
      !Object.keys(loopInitialResources.get(loop.id) ?? {}).length
    ) {
      addWarning(
        translate(locale, "analysis.schedule.loopNeedsCharge", {
          loop: loopMachineNodes.map((node) => node.title).join(" → "),
        }),
      );
    }
    return {
      ...loop,
      initialResources: loopInitialResources.get(loop.id) ?? {},
      circulatingResources: loopCirculatingResources,
      completedCycles,
      nominalCycleTime,
      bottleneckNodeIds: bottleneckNodeIds.filter((nodeId) =>
        loopNodeIds.has(nodeId)
      ),
    };
  });

  return {
    elapsedTime,
    events,
    machines: machineStats,
    bottleneckNodeIds,
    outputs,
    remainingResources,
    circulatingResources,
    auxiliaryTotals,
    closedLoops,
    warnings,
  };
}
