import { analyzeBottlenecks, findMinimumInputBatch } from "./analysis.ts";
import { initialState, simulate } from "./engine.ts";
import type { ProjectState } from "./types.ts";

function baseState(): ProjectState {
  const state = structuredClone(initialState);
  state.resources.push(
    { id: "a", name: "A", unit: "kg", color: "#2563eb" },
    { id: "b", name: "B", unit: "kg", color: "#60a5fa" },
    { id: "c", name: "C", unit: "kg", color: "#38bdf8" },
  );
  return state;
}

Deno.test("minimum input batch finds a zero-leftover recipe cycle", () => {
  const state = baseState();
  state.machines.push({ id: "m", name: "M", description: "" });
  state.recipes.push({
    id: "r",
    machineId: "m",
    description: "",
    duration: 2,
    inputs: [{ id: "in", resourceId: "a", amount: 3 }],
    outputs: [{ id: "out", resourceId: "b", amount: 1 }],
    auxiliaryUses: [],
  });
  state.nodes.push(
    {
      id: "input",
      kind: "input",
      title: "Input",
      x: 0,
      y: 0,
      inputSupplies: [{ id: "a", resourceId: "a", amount: 10 }],
    },
    {
      id: "m",
      kind: "machine",
      title: "M",
      x: 300,
      y: 0,
      machineId: "m",
      activeRecipeIds: ["r"],
      finalOutputPortIds: ["r:out"],
    },
  );
  state.edges.push({
    id: "in",
    sourceNodeId: "input",
    sourcePortId: "input-out:a",
    targetNodeId: "m",
    targetPortId: "r:in",
    resourceId: "a",
  });

  const minimum = findMinimumInputBatch(state, "input");
  if (!minimum.exact || minimum.amounts.a !== 3) {
    throw new Error(`unexpected minimum: ${JSON.stringify(minimum)}`);
  }
  if (Object.keys(minimum.remainingResources).length) {
    throw new Error("the recommended batch still has leftovers");
  }
});

Deno.test("minimum input batch balances equal output branches", () => {
  const state = baseState();
  state.machines.push(
    { id: "m1", name: "M1", description: "" },
    { id: "m2", name: "M2", description: "" },
  );
  state.recipes.push(
    {
      id: "r1",
      machineId: "m1",
      description: "",
      duration: 1,
      inputs: [{ id: "in", resourceId: "a", amount: 3 }],
      outputs: [{ id: "out", resourceId: "b", amount: 1 }],
      auxiliaryUses: [],
    },
    {
      id: "r2",
      machineId: "m2",
      description: "",
      duration: 1,
      inputs: [{ id: "in", resourceId: "a", amount: 101 }],
      outputs: [{ id: "out", resourceId: "c", amount: 1 }],
      auxiliaryUses: [],
    },
  );
  state.nodes.push(
    {
      id: "input",
      kind: "input",
      title: "Input",
      x: 0,
      y: 0,
      inputSupplies: [{ id: "a", resourceId: "a", amount: 5 }],
    },
    {
      id: "m1",
      kind: "machine",
      title: "M1",
      x: 300,
      y: 0,
      machineId: "m1",
      activeRecipeIds: ["r1"],
      finalOutputPortIds: ["r1:out"],
    },
    {
      id: "m2",
      kind: "machine",
      title: "M2",
      x: 300,
      y: 200,
      machineId: "m2",
      activeRecipeIds: ["r2"],
      finalOutputPortIds: ["r2:out"],
    },
  );
  state.edges.push(
    {
      id: "to-m1",
      sourceNodeId: "input",
      sourcePortId: "input-out:a",
      targetNodeId: "m1",
      targetPortId: "r1:in",
      resourceId: "a",
    },
    {
      id: "to-m2",
      sourceNodeId: "input",
      sourcePortId: "input-out:a",
      targetNodeId: "m2",
      targetPortId: "r2:in",
      resourceId: "a",
    },
  );

  const minimum = findMinimumInputBatch(state, "input");
  if (!minimum.exact || minimum.amounts.a !== 606) {
    throw new Error(
      `expected a balanced batch of 606: ${JSON.stringify(minimum)}`,
    );
  }
});

Deno.test("minimum input batch treats Extract as the output boundary", () => {
  const state = baseState();
  state.machines.push(
    { id: "first", name: "First", description: "" },
    { id: "second", name: "Second", description: "" },
  );
  state.recipes.push(
    {
      id: "first-r",
      machineId: "first",
      description: "",
      duration: 1,
      inputs: [{ id: "in", resourceId: "a", amount: 2 }],
      outputs: [{ id: "out", resourceId: "b", amount: 3 }],
      auxiliaryUses: [],
    },
    {
      id: "second-r",
      machineId: "second",
      description: "",
      duration: 1,
      inputs: [{ id: "in", resourceId: "b", amount: 2 }],
      outputs: [{ id: "out", resourceId: "c", amount: 1 }],
      auxiliaryUses: [],
    },
  );
  state.nodes.push(
    {
      id: "input",
      kind: "input",
      title: "Input",
      x: 0,
      y: 0,
      inputSupplies: [{ id: "a", resourceId: "a", amount: 99 }],
    },
    {
      id: "first",
      kind: "machine",
      title: "First",
      x: 300,
      y: 0,
      machineId: "first",
      activeRecipeIds: ["first-r"],
    },
    {
      id: "second",
      kind: "machine",
      title: "Second",
      x: 600,
      y: 0,
      machineId: "second",
      activeRecipeIds: ["second-r"],
    },
    {
      id: "extract",
      kind: "extract",
      title: "Extract",
      x: 900,
      y: 0,
    },
  );
  state.edges.push(
    {
      id: "input-first",
      sourceNodeId: "input",
      sourcePortId: "input-out:a",
      targetNodeId: "first",
      targetPortId: "first-r:in",
      resourceId: "a",
    },
    {
      id: "first-second",
      sourceNodeId: "first",
      sourcePortId: "first-r:out",
      targetNodeId: "second",
      targetPortId: "second-r:in",
      resourceId: "b",
    },
    {
      id: "second-extract",
      sourceNodeId: "second",
      sourcePortId: "second-r:out",
      targetNodeId: "extract",
      targetPortId: "extract-in",
      resourceId: "c",
    },
  );

  const minimum = findMinimumInputBatch(state, "input", "en");
  if (
    !minimum.exact ||
    minimum.amounts.a !== 4 ||
    minimum.outputs.c !== 3 ||
    Object.keys(minimum.remainingResources).length
  ) {
    throw new Error(
      `expected 4 A to balance 3:2 intermediate ratios: ${
        JSON.stringify(minimum)
      }`,
    );
  }
});

Deno.test("minimum input batch supports independent extracted processes", () => {
  const state = baseState();
  state.resources.push({
    id: "d",
    name: "D",
    unit: "kg",
    color: "#0ea5e9",
  });
  state.machines.push(
    { id: "left", name: "Left", description: "" },
    { id: "right", name: "Right", description: "" },
  );
  state.recipes.push(
    {
      id: "left-r",
      machineId: "left",
      description: "",
      duration: 1,
      inputs: [{ id: "in", resourceId: "a", amount: 2 }],
      outputs: [{ id: "out", resourceId: "b", amount: 1 }],
      auxiliaryUses: [],
    },
    {
      id: "right-r",
      machineId: "right",
      description: "",
      duration: 1,
      inputs: [{ id: "in", resourceId: "c", amount: 3 }],
      outputs: [{ id: "out", resourceId: "d", amount: 1 }],
      auxiliaryUses: [],
    },
  );
  state.nodes.push(
    {
      id: "input",
      kind: "input",
      title: "Input",
      x: 0,
      y: 0,
      inputSupplies: [
        { id: "a", resourceId: "a", amount: 20 },
        { id: "c", resourceId: "c", amount: 30 },
      ],
    },
    {
      id: "left",
      kind: "machine",
      title: "Left",
      x: 300,
      y: 0,
      machineId: "left",
      activeRecipeIds: ["left-r"],
    },
    {
      id: "right",
      kind: "machine",
      title: "Right",
      x: 300,
      y: 250,
      machineId: "right",
      activeRecipeIds: ["right-r"],
    },
    {
      id: "extract",
      kind: "extract",
      title: "Extract",
      x: 650,
      y: 100,
    },
  );
  state.edges.push(
    {
      id: "input-left",
      sourceNodeId: "input",
      sourcePortId: "input-out:a",
      targetNodeId: "left",
      targetPortId: "left-r:in",
      resourceId: "a",
    },
    {
      id: "input-right",
      sourceNodeId: "input",
      sourcePortId: "input-out:c",
      targetNodeId: "right",
      targetPortId: "right-r:in",
      resourceId: "c",
    },
    {
      id: "left-extract",
      sourceNodeId: "left",
      sourcePortId: "left-r:out",
      targetNodeId: "extract",
      targetPortId: "extract-in",
      resourceId: "b",
    },
    {
      id: "right-extract",
      sourceNodeId: "right",
      sourcePortId: "right-r:out",
      targetNodeId: "extract",
      targetPortId: "extract-in-1",
      resourceId: "d",
    },
  );

  const minimum = findMinimumInputBatch(state, "input", "en");
  if (
    !minimum.exact ||
    minimum.amounts.a !== 2 ||
    minimum.amounts.c !== 3 ||
    minimum.outputs.b !== 1 ||
    minimum.outputs.d !== 1
  ) {
    throw new Error(
      `independent recipes were not minimized together: ${
        JSON.stringify(minimum)
      }`,
    );
  }
});

Deno.test("minimum input rejects batches with a non-extracted byproduct", () => {
  const state = baseState();
  state.machines.push({ id: "m", name: "M", description: "" });
  state.recipes.push({
    id: "r",
    machineId: "m",
    description: "",
    duration: 1,
    inputs: [{ id: "in", resourceId: "a", amount: 1 }],
    outputs: [
      { id: "extracted", resourceId: "b", amount: 1 },
      { id: "leftover", resourceId: "c", amount: 1 },
    ],
    auxiliaryUses: [],
  });
  state.nodes.push(
    {
      id: "input",
      kind: "input",
      title: "Input",
      x: 0,
      y: 0,
      inputSupplies: [{ id: "a", resourceId: "a", amount: 10 }],
    },
    {
      id: "m",
      kind: "machine",
      title: "M",
      x: 300,
      y: 0,
      machineId: "m",
      activeRecipeIds: ["r"],
    },
    {
      id: "extract",
      kind: "extract",
      title: "Extract",
      x: 600,
      y: 0,
    },
  );
  state.edges.push(
    {
      id: "input-m",
      sourceNodeId: "input",
      sourcePortId: "input-out:a",
      targetNodeId: "m",
      targetPortId: "r:in",
      resourceId: "a",
    },
    {
      id: "m-extract",
      sourceNodeId: "m",
      sourcePortId: "r:extracted",
      targetNodeId: "extract",
      targetPortId: "extract-in",
      resourceId: "b",
    },
  );

  const minimum = findMinimumInputBatch(state, "input", "en");
  if (minimum.exact || minimum.remainingResources.c !== 1) {
    throw new Error(
      `a non-extracted byproduct must prevent an exact result: ${
        JSON.stringify(minimum)
      }`,
    );
  }
});

Deno.test("concurrent schedule identifies the downstream slow machine", () => {
  const state = baseState();
  state.machines.push(
    { id: "fast", name: "Fast", description: "" },
    { id: "slow", name: "Slow", description: "" },
  );
  state.recipes.push(
    {
      id: "fast-r",
      machineId: "fast",
      description: "",
      duration: 1,
      inputs: [{ id: "in", resourceId: "a", amount: 1 }],
      outputs: [{ id: "out", resourceId: "b", amount: 1 }],
      auxiliaryUses: [],
    },
    {
      id: "slow-r",
      machineId: "slow",
      description: "",
      duration: 4,
      inputs: [{ id: "in", resourceId: "b", amount: 1 }],
      outputs: [{ id: "out", resourceId: "c", amount: 1 }],
      auxiliaryUses: [],
    },
  );
  state.nodes.push(
    {
      id: "input",
      kind: "input",
      title: "Input",
      x: 0,
      y: 0,
      inputSupplies: [{ id: "a", resourceId: "a", amount: 5 }],
    },
    {
      id: "fast",
      kind: "machine",
      title: "Fast",
      x: 300,
      y: 0,
      machineId: "fast",
      activeRecipeIds: ["fast-r"],
    },
    {
      id: "slow",
      kind: "machine",
      title: "Slow",
      x: 600,
      y: 0,
      machineId: "slow",
      activeRecipeIds: ["slow-r"],
      finalOutputPortIds: ["slow-r:out"],
    },
  );
  state.edges.push(
    {
      id: "input-fast",
      sourceNodeId: "input",
      sourcePortId: "input-out:a",
      targetNodeId: "fast",
      targetPortId: "fast-r:in",
      resourceId: "a",
    },
    {
      id: "fast-slow",
      sourceNodeId: "fast",
      sourcePortId: "fast-r:out",
      targetNodeId: "slow",
      targetPortId: "slow-r:in",
      resourceId: "b",
    },
  );

  const analysis = analyzeBottlenecks(state, "input");
  if (analysis.elapsedTime !== 21) {
    throw new Error(
      `expected a 21 second schedule, got ${analysis.elapsedTime}`,
    );
  }
  if (analysis.outputs.c !== 5) {
    throw new Error(`expected 5 C, got ${analysis.outputs.c}`);
  }
  if (
    analysis.bottleneckNodeIds.length !== 1 ||
    analysis.bottleneckNodeIds[0] !== "slow"
  ) {
    throw new Error(
      `expected slow bottleneck, got ${analysis.bottleneckNodeIds.join(",")}`,
    );
  }
});

function closedCoolantLoopState(coolantAmount = 1): ProjectState {
  const state = structuredClone(initialState);
  state.resources.push(
    { id: "raw", name: "Raw", unit: "kg", color: "#2563eb" },
    { id: "coolant", name: "Coolant", unit: "L", color: "#38bdf8" },
    { id: "product", name: "Product", unit: "ea", color: "#22c55e" },
  );
  state.machines.push({
    id: "reactor-machine",
    name: "Reactor",
    description: "",
  });
  state.recipes.push({
    id: "react",
    machineId: "reactor-machine",
    description: "",
    duration: 2,
    inputs: [
      { id: "raw", resourceId: "raw", amount: 1 },
      { id: "coolant", resourceId: "coolant", amount: 1 },
    ],
    outputs: [
      { id: "product", resourceId: "product", amount: 1 },
      { id: "coolant", resourceId: "coolant", amount: 1 },
    ],
    auxiliaryUses: [],
  });
  state.nodes.push(
    {
      id: "input",
      kind: "input",
      title: "Input",
      x: 0,
      y: 0,
      inputSupplies: [
        { id: "raw", resourceId: "raw", amount: 5 },
        { id: "coolant", resourceId: "coolant", amount: coolantAmount },
      ],
    },
    {
      id: "coolant-merge",
      kind: "merger",
      title: "Coolant merge",
      x: 250,
      y: 150,
      resourceId: "coolant",
    },
    {
      id: "reactor",
      kind: "machine",
      title: "Reactor",
      x: 500,
      y: 0,
      machineId: "reactor-machine",
      activeRecipeIds: ["react"],
    },
    {
      id: "extract",
      kind: "extract",
      title: "Extract",
      x: 750,
      y: 0,
    },
  );
  state.edges.push(
    {
      id: "raw-to-reactor",
      sourceNodeId: "input",
      sourcePortId: "input-out:raw",
      targetNodeId: "reactor",
      targetPortId: "react:raw",
      resourceId: "raw",
    },
    {
      id: "initial-coolant",
      sourceNodeId: "input",
      sourcePortId: "input-out:coolant",
      targetNodeId: "coolant-merge",
      targetPortId: "merge-in-0",
      resourceId: "coolant",
    },
    {
      id: "return-coolant",
      sourceNodeId: "reactor",
      sourcePortId: "react:coolant",
      targetNodeId: "coolant-merge",
      targetPortId: "merge-in-1",
      resourceId: "coolant",
    },
    {
      id: "coolant-to-reactor",
      sourceNodeId: "coolant-merge",
      sourcePortId: "merge-out",
      targetNodeId: "reactor",
      targetPortId: "react:coolant",
      resourceId: "coolant",
    },
    {
      id: "product-extract",
      sourceNodeId: "reactor",
      sourcePortId: "react:product",
      targetNodeId: "extract",
      targetPortId: "extract-in",
      resourceId: "product",
    },
  );
  return state;
}

Deno.test("closed loop reuses its initial charge without reporting it as leftover", () => {
  const state = closedCoolantLoopState();
  const result = simulate(state, "en", { inputNodeId: "input" });
  if (result.outputs.product !== 5 || result.nodeRuns.reactor !== 5) {
    throw new Error(`loop did not keep running: ${JSON.stringify(result)}`);
  }
  if (result.circulatingResources.coolant !== 1) {
    throw new Error(
      `expected one circulating coolant: ${
        JSON.stringify(result.circulatingResources)
      }`,
    );
  }
  if (
    Object.keys(result.remainingResources).length ||
    result.warnings.length
  ) {
    throw new Error(`loop was reported for review: ${JSON.stringify(result)}`);
  }

  const analysis = analyzeBottlenecks(state, "input", "en");
  const loop = analysis.closedLoops[0];
  if (
    analysis.outputs.product !== 5 ||
    analysis.elapsedTime !== 10 ||
    analysis.circulatingResources.coolant !== 1 ||
    analysis.warnings.length
  ) {
    throw new Error(`unexpected loop schedule: ${JSON.stringify(analysis)}`);
  }
  if (
    !loop ||
    loop.initialResources.coolant !== 1 ||
    loop.completedCycles !== 5 ||
    loop.nominalCycleTime !== 2
  ) {
    throw new Error(`unexpected loop details: ${JSON.stringify(loop)}`);
  }

  const minimum = findMinimumInputBatch(state, "input", "en");
  if (
    !minimum.exact ||
    minimum.amounts.raw !== 1 ||
    minimum.amounts.coolant !== 1 ||
    minimum.warnings.length
  ) {
    throw new Error(
      `unexpected closed-loop minimum: ${JSON.stringify(minimum)}`,
    );
  }
});

function pipelinedLoopState(tokenAmount: number): ProjectState {
  const state = structuredClone(initialState);
  state.resources.push(
    { id: "raw", name: "Raw", unit: "kg", color: "#2563eb" },
    { id: "token-a", name: "Carrier A", unit: "ea", color: "#38bdf8" },
    { id: "token-b", name: "Carrier B", unit: "ea", color: "#0ea5e9" },
    { id: "product", name: "Product", unit: "ea", color: "#22c55e" },
  );
  state.machines.push(
    { id: "machine-a", name: "Machine A", description: "" },
    { id: "machine-b", name: "Machine B", description: "" },
  );
  state.recipes.push(
    {
      id: "process-a",
      machineId: "machine-a",
      description: "",
      duration: 5,
      inputs: [
        { id: "raw", resourceId: "raw", amount: 1 },
        { id: "carrier", resourceId: "token-a", amount: 1 },
      ],
      outputs: [
        { id: "product", resourceId: "product", amount: 1 },
        { id: "carrier", resourceId: "token-b", amount: 1 },
      ],
      auxiliaryUses: [],
    },
    {
      id: "process-b",
      machineId: "machine-b",
      description: "",
      duration: 5,
      inputs: [{ id: "carrier", resourceId: "token-b", amount: 1 }],
      outputs: [{ id: "carrier", resourceId: "token-a", amount: 1 }],
      auxiliaryUses: [],
    },
  );
  state.nodes.push(
    {
      id: "input",
      kind: "input",
      title: "Input",
      x: 0,
      y: 0,
      inputSupplies: [
        { id: "raw", resourceId: "raw", amount: 4 },
        { id: "token", resourceId: "token-a", amount: tokenAmount },
      ],
    },
    {
      id: "carrier-merge",
      kind: "merger",
      title: "Carrier merge",
      x: 250,
      y: 150,
      resourceId: "token-a",
    },
    {
      id: "a",
      kind: "machine",
      title: "Machine A",
      x: 500,
      y: 0,
      machineId: "machine-a",
      activeRecipeIds: ["process-a"],
      finalOutputPortIds: ["process-a:product"],
    },
    {
      id: "b",
      kind: "machine",
      title: "Machine B",
      x: 750,
      y: 150,
      machineId: "machine-b",
      activeRecipeIds: ["process-b"],
    },
  );
  state.edges.push(
    {
      id: "raw-to-a",
      sourceNodeId: "input",
      sourcePortId: "input-out:raw",
      targetNodeId: "a",
      targetPortId: "process-a:raw",
      resourceId: "raw",
    },
    {
      id: "initial-token",
      sourceNodeId: "input",
      sourcePortId: "input-out:token",
      targetNodeId: "carrier-merge",
      targetPortId: "merge-in-0",
      resourceId: "token-a",
    },
    {
      id: "a-to-b",
      sourceNodeId: "a",
      sourcePortId: "process-a:carrier",
      targetNodeId: "b",
      targetPortId: "process-b:carrier",
      resourceId: "token-b",
    },
    {
      id: "b-to-merge",
      sourceNodeId: "b",
      sourcePortId: "process-b:carrier",
      targetNodeId: "carrier-merge",
      targetPortId: "merge-in-1",
      resourceId: "token-a",
    },
    {
      id: "merge-to-a",
      sourceNodeId: "carrier-merge",
      sourcePortId: "merge-out",
      targetNodeId: "a",
      targetPortId: "process-a:carrier",
      resourceId: "token-a",
    },
  );
  return state;
}

Deno.test("additional closed-loop inventory reduces pipeline makespan", () => {
  const oneCarrier = analyzeBottlenecks(
    pipelinedLoopState(1),
    "input",
    "en",
  );
  const twoCarriers = analyzeBottlenecks(
    pipelinedLoopState(2),
    "input",
    "en",
  );
  if (
    oneCarrier.outputs.product !== 4 ||
    twoCarriers.outputs.product !== 4
  ) {
    throw new Error("both loop charges should produce all four products");
  }
  if (
    oneCarrier.elapsedTime !== 40 ||
    twoCarriers.elapsedTime !== 25 ||
    twoCarriers.elapsedTime >= oneCarrier.elapsedTime
  ) {
    throw new Error(
      `expected 40s → 25s with more circulating inventory, got ${oneCarrier.elapsedTime}s → ${twoCarriers.elapsedTime}s`,
    );
  }
  if (
    oneCarrier.circulatingResources["token-a"] !== 1 ||
    twoCarriers.circulatingResources["token-a"] !== 2 ||
    oneCarrier.warnings.length ||
    twoCarriers.warnings.length
  ) {
    throw new Error(
      `unexpected final loop inventory: ${
        JSON.stringify({
          one: oneCarrier.circulatingResources,
          two: twoCarriers.circulatingResources,
        })
      }`,
    );
  }
});

Deno.test("minimum input includes the full startup charge before a large downstream batch", () => {
  const state = structuredClone(initialState);
  state.resources.push(
    { id: "raw", name: "Bauxite", unit: "ea", color: "#2563eb" },
    { id: "soda", name: "Soda", unit: "ea", color: "#38bdf8" },
    { id: "calcium", name: "Calcium", unit: "ea", color: "#0ea5e9" },
    { id: "slurry", name: "Slurry", unit: "mB", color: "#1d4ed8" },
    { id: "cracked", name: "Cracked", unit: "mB", color: "#3b82f6" },
    { id: "acid", name: "Acid", unit: "mB", color: "#f59e0b" },
    { id: "precursor", name: "Precursor", unit: "mB", color: "#eab308" },
    { id: "product", name: "Product", unit: "ea", color: "#22c55e" },
  );
  state.machines.push(
    { id: "mixer", name: "Mixer", description: "" },
    { id: "cracker", name: "Cracker", description: "" },
    { id: "reactor", name: "Reactor", description: "" },
    { id: "regenerator", name: "Regenerator", description: "" },
  );
  state.recipes.push(
    {
      id: "mix",
      machineId: "mixer",
      description: "",
      duration: 1,
      inputs: [
        { id: "raw", resourceId: "raw", amount: 32 },
        { id: "soda", resourceId: "soda", amount: 12 },
        { id: "calcium", resourceId: "calcium", amount: 6 },
      ],
      outputs: [{ id: "slurry", resourceId: "slurry", amount: 4000 }],
      auxiliaryUses: [],
    },
    {
      id: "crack",
      machineId: "cracker",
      description: "",
      duration: 1,
      inputs: [{ id: "slurry", resourceId: "slurry", amount: 16000 }],
      outputs: [{ id: "cracked", resourceId: "cracked", amount: 16000 }],
      auxiliaryUses: [],
    },
    {
      id: "react",
      machineId: "reactor",
      description: "",
      duration: 1,
      inputs: [
        { id: "cracked", resourceId: "cracked", amount: 4000 },
        { id: "acid", resourceId: "acid", amount: 1000 },
      ],
      outputs: [
        { id: "product", resourceId: "product", amount: 1 },
        { id: "precursor", resourceId: "precursor", amount: 1000 },
        { id: "soda", resourceId: "soda", amount: 12 },
        { id: "calcium", resourceId: "calcium", amount: 6 },
      ],
      auxiliaryUses: [],
    },
    {
      id: "regenerate",
      machineId: "regenerator",
      description: "",
      duration: 1,
      inputs: [{ id: "precursor", resourceId: "precursor", amount: 1000 }],
      outputs: [{ id: "acid", resourceId: "acid", amount: 1000 }],
      auxiliaryUses: [],
    },
  );
  state.nodes.push(
    {
      id: "input",
      kind: "input",
      title: "Input",
      x: 0,
      y: 0,
      inputSupplies: [
        { id: "raw", resourceId: "raw", amount: 256 },
        { id: "soda", resourceId: "soda", amount: 48 },
        { id: "calcium", resourceId: "calcium", amount: 24 },
        { id: "acid", resourceId: "acid", amount: 4000 },
      ],
    },
    {
      id: "soda-merge",
      kind: "merger",
      title: "Soda merge",
      x: 200,
      y: 100,
      resourceId: "soda",
    },
    {
      id: "calcium-merge",
      kind: "merger",
      title: "Calcium merge",
      x: 200,
      y: 200,
      resourceId: "calcium",
    },
    {
      id: "acid-merge",
      kind: "merger",
      title: "Acid merge",
      x: 650,
      y: 200,
      resourceId: "acid",
    },
    {
      id: "mixer",
      kind: "machine",
      title: "Mixer",
      x: 400,
      y: 0,
      machineId: "mixer",
      activeRecipeIds: ["mix"],
    },
    {
      id: "cracker",
      kind: "machine",
      title: "Cracker",
      x: 650,
      y: 0,
      machineId: "cracker",
      activeRecipeIds: ["crack"],
    },
    {
      id: "reactor",
      kind: "machine",
      title: "Reactor",
      x: 900,
      y: 0,
      machineId: "reactor",
      activeRecipeIds: ["react"],
      finalOutputPortIds: ["react:product"],
    },
    {
      id: "regenerator",
      kind: "machine",
      title: "Regenerator",
      x: 900,
      y: 250,
      machineId: "regenerator",
      activeRecipeIds: ["regenerate"],
    },
  );
  state.edges.push(
    {
      id: "raw",
      sourceNodeId: "input",
      sourcePortId: "input-out:raw",
      targetNodeId: "mixer",
      targetPortId: "mix:raw",
      resourceId: "raw",
    },
    {
      id: "initial-soda",
      sourceNodeId: "input",
      sourcePortId: "input-out:soda",
      targetNodeId: "soda-merge",
      targetPortId: "merge-in-0",
      resourceId: "soda",
    },
    {
      id: "returned-soda",
      sourceNodeId: "reactor",
      sourcePortId: "react:soda",
      targetNodeId: "soda-merge",
      targetPortId: "merge-in-1",
      resourceId: "soda",
    },
    {
      id: "soda",
      sourceNodeId: "soda-merge",
      sourcePortId: "merge-out",
      targetNodeId: "mixer",
      targetPortId: "mix:soda",
      resourceId: "soda",
    },
    {
      id: "initial-calcium",
      sourceNodeId: "input",
      sourcePortId: "input-out:calcium",
      targetNodeId: "calcium-merge",
      targetPortId: "merge-in-0",
      resourceId: "calcium",
    },
    {
      id: "returned-calcium",
      sourceNodeId: "reactor",
      sourcePortId: "react:calcium",
      targetNodeId: "calcium-merge",
      targetPortId: "merge-in-1",
      resourceId: "calcium",
    },
    {
      id: "calcium",
      sourceNodeId: "calcium-merge",
      sourcePortId: "merge-out",
      targetNodeId: "mixer",
      targetPortId: "mix:calcium",
      resourceId: "calcium",
    },
    {
      id: "slurry",
      sourceNodeId: "mixer",
      sourcePortId: "mix:slurry",
      targetNodeId: "cracker",
      targetPortId: "crack:slurry",
      resourceId: "slurry",
    },
    {
      id: "cracked",
      sourceNodeId: "cracker",
      sourcePortId: "crack:cracked",
      targetNodeId: "reactor",
      targetPortId: "react:cracked",
      resourceId: "cracked",
    },
    {
      id: "initial-acid",
      sourceNodeId: "input",
      sourcePortId: "input-out:acid",
      targetNodeId: "acid-merge",
      targetPortId: "merge-in-0",
      resourceId: "acid",
    },
    {
      id: "acid",
      sourceNodeId: "acid-merge",
      sourcePortId: "merge-out",
      targetNodeId: "reactor",
      targetPortId: "react:acid",
      resourceId: "acid",
    },
    {
      id: "precursor",
      sourceNodeId: "reactor",
      sourcePortId: "react:precursor",
      targetNodeId: "regenerator",
      targetPortId: "regenerate:precursor",
      resourceId: "precursor",
    },
    {
      id: "returned-acid",
      sourceNodeId: "regenerator",
      sourcePortId: "regenerate:acid",
      targetNodeId: "acid-merge",
      targetPortId: "merge-in-1",
      resourceId: "acid",
    },
  );

  const incorrect = structuredClone(state);
  const incorrectInput = incorrect.nodes.find((node) => node.id === "input")!;
  for (const supply of incorrectInput.inputSupplies ?? []) {
    supply.amount = {
      raw: 32,
      soda: 12,
      calcium: 6,
      acid: 1000,
    }[supply.id]!;
  }
  const stalled = simulate(incorrect, "en", { inputNodeId: "input" });
  if (
    stalled.remainingResources.slurry !== 4000 ||
    stalled.circulatingResources.slurry
  ) {
    throw new Error(
      `unfinished slurry must be an ordinary leftover: ${
        JSON.stringify(stalled)
      }`,
    );
  }

  const minimum = findMinimumInputBatch(state, "input", "en");
  const expected = { raw: 128, soda: 48, calcium: 24, acid: 1000 };
  if (
    !minimum.exact ||
    Object.entries(expected).some(([id, amount]) =>
      minimum.amounts[id] !== amount
    )
  ) {
    throw new Error(
      `startup inventory did not satisfy the 16,000 mB batch: ${
        JSON.stringify(minimum)
      }`,
    );
  }
});

Deno.test("minimum batches use probabilistic outputs as expected values", () => {
  const state = baseState();
  state.machines.push(
    { id: "chance", name: "Chance", description: "" },
    { id: "finish", name: "Finish", description: "" },
  );
  state.recipes.push(
    {
      id: "chance-r",
      machineId: "chance",
      description: "",
      duration: 1,
      inputs: [{ id: "in", resourceId: "a", amount: 1 }],
      outputs: [{
        id: "out",
        resourceId: "b",
        amount: 1,
        probability: 0.5,
      }],
      auxiliaryUses: [],
    },
    {
      id: "finish-r",
      machineId: "finish",
      description: "",
      duration: 1,
      inputs: [{ id: "in", resourceId: "b", amount: 1 }],
      outputs: [{ id: "out", resourceId: "c", amount: 1 }],
      auxiliaryUses: [],
    },
  );
  state.nodes.push(
    {
      id: "input",
      kind: "input",
      title: "Input",
      x: 0,
      y: 0,
      inputSupplies: [{ id: "a", resourceId: "a", amount: 9 }],
    },
    {
      id: "chance",
      kind: "machine",
      title: "Chance",
      x: 300,
      y: 0,
      machineId: "chance",
      activeRecipeIds: ["chance-r"],
    },
    {
      id: "finish",
      kind: "machine",
      title: "Finish",
      x: 600,
      y: 0,
      machineId: "finish",
      activeRecipeIds: ["finish-r"],
      finalOutputPortIds: ["finish-r:out"],
    },
  );
  state.edges.push(
    {
      id: "input-chance",
      sourceNodeId: "input",
      sourcePortId: "input-out:a",
      targetNodeId: "chance",
      targetPortId: "chance-r:in",
      resourceId: "a",
    },
    {
      id: "chance-finish",
      sourceNodeId: "chance",
      sourcePortId: "chance-r:out",
      targetNodeId: "finish",
      targetPortId: "finish-r:in",
      resourceId: "b",
    },
  );

  const minimum = findMinimumInputBatch(state, "input");
  if (!minimum.exact || minimum.amounts.a !== 2) {
    throw new Error(
      `expected two probabilistic cycles: ${JSON.stringify(minimum)}`,
    );
  }
});

Deno.test("concurrent schedules draw unlimited supplemental resources on demand", () => {
  const state = baseState();
  state.resources.push({
    id: "energy",
    name: "Energy",
    unit: "kWh",
    color: "#1d4ed8",
  });
  state.machines.push({ id: "m", name: "M", description: "" });
  state.recipes.push({
    id: "r",
    machineId: "m",
    description: "",
    duration: 2,
    inputs: [
      { id: "material", resourceId: "a", amount: 1 },
      { id: "energy", resourceId: "energy", amount: 2 },
    ],
    outputs: [{ id: "out", resourceId: "b", amount: 1 }],
    auxiliaryUses: [],
  });
  state.nodes.push(
    {
      id: "input",
      kind: "input",
      title: "Input",
      x: 0,
      y: 0,
      inputSupplies: [{ id: "a", resourceId: "a", amount: 3 }],
    },
    {
      id: "source",
      kind: "source",
      title: "Unlimited energy",
      x: 0,
      y: 200,
      resourceId: "energy",
    },
    {
      id: "m",
      kind: "machine",
      title: "M",
      x: 300,
      y: 0,
      machineId: "m",
      activeRecipeIds: ["r"],
      finalOutputPortIds: ["r:out"],
    },
  );
  state.edges.push(
    {
      id: "material",
      sourceNodeId: "input",
      sourcePortId: "input-out:a",
      targetNodeId: "m",
      targetPortId: "r:material",
      resourceId: "a",
    },
    {
      id: "energy",
      sourceNodeId: "source",
      sourcePortId: "source-out",
      targetNodeId: "m",
      targetPortId: "r:energy",
      resourceId: "energy",
    },
  );

  const analysis = analyzeBottlenecks(state, "input");
  if (analysis.outputs.b !== 3 || analysis.elapsedTime !== 6) {
    throw new Error(
      `unexpected unlimited-source schedule: ${JSON.stringify(analysis)}`,
    );
  }
});

Deno.test("independent machines execute concurrently", () => {
  const state = baseState();
  state.machines.push(
    { id: "left", name: "Left", description: "" },
    { id: "right", name: "Right", description: "" },
  );
  state.recipes.push(
    {
      id: "left-r",
      machineId: "left",
      description: "",
      duration: 5,
      inputs: [{ id: "in", resourceId: "a", amount: 1 }],
      outputs: [{ id: "out", resourceId: "b", amount: 1 }],
      auxiliaryUses: [],
    },
    {
      id: "right-r",
      machineId: "right",
      description: "",
      duration: 7,
      inputs: [{ id: "in", resourceId: "b", amount: 1 }],
      outputs: [{ id: "out", resourceId: "c", amount: 1 }],
      auxiliaryUses: [],
    },
  );
  state.nodes.push(
    {
      id: "input",
      kind: "input",
      title: "Input",
      x: 0,
      y: 0,
      inputSupplies: [
        { id: "a", resourceId: "a", amount: 1 },
        { id: "b", resourceId: "b", amount: 1 },
      ],
    },
    {
      id: "left",
      kind: "machine",
      title: "Left",
      x: 300,
      y: 0,
      machineId: "left",
      activeRecipeIds: ["left-r"],
      finalOutputPortIds: ["left-r:out"],
    },
    {
      id: "right",
      kind: "machine",
      title: "Right",
      x: 300,
      y: 200,
      machineId: "right",
      activeRecipeIds: ["right-r"],
      finalOutputPortIds: ["right-r:out"],
    },
  );
  state.edges.push(
    {
      id: "left-input",
      sourceNodeId: "input",
      sourcePortId: "input-out:a",
      targetNodeId: "left",
      targetPortId: "left-r:in",
      resourceId: "a",
    },
    {
      id: "right-input",
      sourceNodeId: "input",
      sourcePortId: "input-out:b",
      targetNodeId: "right",
      targetPortId: "right-r:in",
      resourceId: "b",
    },
  );

  const analysis = analyzeBottlenecks(state, "input");
  if (analysis.elapsedTime !== 7) {
    throw new Error(
      `parallel machines should finish in 7 seconds, got ${analysis.elapsedTime}`,
    );
  }
  if (
    analysis.events.some((event) => event.start !== 0) ||
    analysis.bottleneckNodeIds[0] !== "right"
  ) {
    throw new Error(
      `unexpected concurrent schedule: ${JSON.stringify(analysis)}`,
    );
  }
});
