import {
  exampleState,
  initialState,
  normalizeRecipeDuration,
  portsForNode,
  probabilityForOutput,
  resourceLabel,
  simulate,
  validateConnection,
} from "./engine.ts";

Deno.test("recipe duration is stored with at most two decimal places", () => {
  if (normalizeRecipeDuration(0.45) !== 0.45) {
    throw new Error("two-decimal recipe duration must be preserved");
  }
  if (normalizeRecipeDuration(1.236) !== 1.24) {
    throw new Error("recipe duration must be rounded to two decimals");
  }
});

Deno.test("output probability defaults to certainty and stays bounded", () => {
  const basePort = { id: "out", resourceId: "water", amount: 1 };
  if (probabilityForOutput(basePort) !== 1) {
    throw new Error("legacy outputs must default to 100% probability");
  }
  if (probabilityForOutput({ ...basePort, probability: 0.35 }) !== 0.35) {
    throw new Error("explicit output probability was not preserved");
  }
  if (probabilityForOutput({ ...basePort, probability: 2 }) !== 1) {
    throw new Error("output probability must be clamped to 100%");
  }
});

Deno.test("resources without symbols get an automatic short label", () => {
  const label = resourceLabel({
    id: "water",
    name: "Water",
    unit: "L",
    color: "#2563eb",
  });

  if (label !== "WA") {
    throw new Error(`expected an automatic WA label, received: ${label}`);
  }
});

Deno.test("new projects start completely empty", () => {
  const counts = [
    initialState.resources.length,
    initialState.auxiliaries.length,
    initialState.machines.length,
    initialState.recipes.length,
    initialState.nodes.length,
    initialState.edges.length,
  ];
  if (counts.some((count) => count !== 0)) {
    throw new Error(`expected empty project, received counts: ${counts}`);
  }
});

Deno.test("demo flow calculates final gears and energy", () => {
  const result = simulate(structuredClone(exampleState));

  if (result.outputs.gear !== 30) {
    throw new Error(`expected 30 gears, received ${result.outputs.gear}`);
  }
  if (result.auxiliaryTotals.electricity !== 237) {
    throw new Error(
      `expected 237 kWh, received ${result.auxiliaryTotals.electricity}`,
    );
  }
  if (result.auxiliaryTotals.coolant !== 24) {
    throw new Error(
      `expected 24 L coolant, received ${result.auxiliaryTotals.coolant}`,
    );
  }
  if (result.warnings.length !== 0) {
    throw new Error(`unexpected warnings: ${result.warnings.join(", ")}`);
  }
});

Deno.test("resource nodes supply without a quantity limit", () => {
  const state = structuredClone(initialState);
  state.resources.push(
    { id: "a", name: "A", unit: "kg", color: "#2563eb" },
    { id: "b", name: "B", unit: "kg", color: "#60a5fa" },
  );
  state.machines.push({ id: "machine", name: "Machine", description: "" });
  state.recipes.push({
    id: "unlimited",
    machineId: "machine",
    description: "",
    duration: 1,
    inputs: [{ id: "in", resourceId: "a", amount: 2 }],
    outputs: [{ id: "out", resourceId: "b", amount: 1 }],
    auxiliaryUses: [],
  });
  state.nodes.push(
    {
      id: "source",
      kind: "source",
      title: "Resource",
      x: 0,
      y: 0,
      resourceId: "a",
      amount: 1,
    },
    {
      id: "machine",
      kind: "machine",
      title: "Machine",
      x: 300,
      y: 0,
      machineId: "machine",
      activeRecipeIds: ["unlimited"],
      finalOutputPortIds: ["unlimited:out"],
    },
  );
  state.edges.push({
    id: "edge",
    sourceNodeId: "source",
    sourcePortId: "source-out",
    targetNodeId: "machine",
    targetPortId: "unlimited:in",
    resourceId: "a",
  });

  const sourcePort = portsForNode(state, state.nodes[0]).outputs[0];
  const result = simulate(state);
  if (sourcePort.amount !== Number.POSITIVE_INFINITY) {
    throw new Error("resource node still used its legacy quantity");
  }
  if (result.outputs.b !== Number.POSITIVE_INFINITY) {
    throw new Error("resource node did not provide an unlimited flow");
  }
});

Deno.test("input calculation reports expected output, leftovers, and time", () => {
  const state = structuredClone(initialState);
  state.resources.push(
    { id: "a", name: "A", unit: "kg", color: "#2563eb" },
    { id: "b", name: "B", unit: "kg", color: "#60a5fa" },
  );
  state.machines.push({ id: "machine", name: "Machine", description: "" });
  state.recipes.push({
    id: "probabilistic",
    machineId: "machine",
    description: "",
    duration: 2,
    inputs: [{ id: "in", resourceId: "a", amount: 3 }],
    outputs: [{ id: "out", resourceId: "b", amount: 2, probability: 0.5 }],
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
      id: "machine",
      kind: "machine",
      title: "Machine",
      x: 300,
      y: 0,
      machineId: "machine",
      activeRecipeIds: ["probabilistic"],
      finalOutputPortIds: ["probabilistic:out"],
    },
  );
  state.edges.push({
    id: "edge",
    sourceNodeId: "input",
    sourcePortId: "input-out:a",
    targetNodeId: "machine",
    targetPortId: "probabilistic:in",
    resourceId: "a",
  });

  const result = simulate(state, "ko", { inputNodeId: "input" });
  if (result.outputs.b !== 3) {
    throw new Error(`expected 3 B, received ${result.outputs.b}`);
  }
  if (result.remainingResources.a !== 1) {
    throw new Error(
      `expected 1 leftover A, received ${result.remainingResources.a}`,
    );
  }
  if (result.elapsedTime !== 6) {
    throw new Error(`expected 6 seconds, received ${result.elapsedTime}`);
  }
});

Deno.test("connection validation rejects mismatched resources", () => {
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
  );
  if (!error?.includes("자원이 일치하지 않습니다")) {
    throw new Error(`expected resource mismatch, received: ${error}`);
  }
});

Deno.test("legacy extract inputs continue to infer their resource", () => {
  const state = structuredClone(exampleState);
  const source = state.nodes.find((node) => node.id === "source-1");
  if (!source) throw new Error("fixture source node is missing");
  const extract = {
    id: "legacy-extract",
    kind: "extract" as const,
    title: "Legacy final output",
    x: 950,
    y: 230,
  };
  state.nodes.push(extract);

  const error = validateConnection(
    state,
    source,
    "input-out:iron-ore-supply",
    extract,
    "extract-in",
  );
  if (error !== null) {
    throw new Error(`expected replaceable extract input, received: ${error}`);
  }
});

Deno.test("final output ports calculate directly and reject connections", () => {
  const state = structuredClone(exampleState);
  if (state.nodes.some((node) => node.kind === "extract")) {
    throw new Error("the current demo must not require a final output node");
  }
  const press = state.nodes.find((node) => node.id === "press-1");
  if (!press) throw new Error("fixture press node is missing");
  const extract = {
    id: "legacy-extract",
    kind: "extract" as const,
    title: "Legacy final output",
    x: 950,
    y: 230,
  };
  state.nodes.push(extract);

  const error = validateConnection(
    state,
    press,
    "gear-press:press-out",
    extract,
    "extract-in",
  );
  if (!error?.includes("최종 출력")) {
    throw new Error(
      `expected final output connection error, received: ${error}`,
    );
  }

  const result = simulate(state);
  if (result.outputs.gear !== 30) {
    throw new Error(
      `expected 30 terminal gears, received ${result.outputs.gear}`,
    );
  }
});

Deno.test("extract keeps one trailing auto input and collects every resource", () => {
  const state = structuredClone(initialState);
  state.resources.push(
    { id: "a", name: "A", unit: "kg", color: "#2563eb" },
    { id: "b", name: "B", unit: "L", color: "#60a5fa" },
  );
  state.nodes.push(
    {
      id: "source-a",
      kind: "input",
      title: "Source A",
      x: 0,
      y: 0,
      inputSupplies: [{ id: "a", resourceId: "a", amount: 10 }],
    },
    {
      id: "source-b",
      kind: "input",
      title: "Source B",
      x: 0,
      y: 200,
      inputSupplies: [{ id: "b", resourceId: "b", amount: 20 }],
    },
    {
      id: "extract",
      kind: "extract",
      title: "Final output",
      x: 500,
      y: 100,
    },
  );
  const extract = state.nodes[2];
  const initialPorts = portsForNode(state, extract).inputs;
  if (
    initialPorts.length !== 1 ||
    initialPorts[0].id !== "extract-in" ||
    initialPorts[0].resourceId
  ) {
    throw new Error("extract must start with one AUTO input");
  }

  state.edges.push({
    id: "edge-a",
    sourceNodeId: "source-a",
    sourcePortId: "input-out:a",
    targetNodeId: "extract",
    targetPortId: "extract-in",
    resourceId: "a",
  });
  const afterFirstConnection = portsForNode(state, extract).inputs;
  if (
    afterFirstConnection.length !== 2 ||
    afterFirstConnection[1].id !== "extract-in-1" ||
    afterFirstConnection[1].resourceId
  ) {
    throw new Error("extract did not append its second AUTO input");
  }

  const sourceB = state.nodes[1];
  const connectionError = validateConnection(
    state,
    sourceB,
    "input-out:b",
    extract,
    "extract-in-1",
  );
  if (connectionError !== null) {
    throw new Error(`extract rejected another resource: ${connectionError}`);
  }
  state.edges.push({
    id: "edge-b",
    sourceNodeId: "source-b",
    sourcePortId: "input-out:b",
    targetNodeId: "extract",
    targetPortId: "extract-in-1",
    resourceId: "b",
  });
  const afterSecondConnection = portsForNode(state, extract).inputs;
  if (
    afterSecondConnection.length !== 3 ||
    afterSecondConnection[2].id !== "extract-in-2" ||
    afterSecondConnection[2].resourceId
  ) {
    throw new Error("extract did not keep a trailing AUTO input");
  }

  const result = simulate(state);
  if (result.outputs.a !== 10 || result.outputs.b !== 20) {
    throw new Error(
      `extract did not collect all resources: ${
        JSON.stringify(result.outputs)
      }`,
    );
  }

  state.edges = state.edges.filter((edge) => edge.id !== "edge-b");
  const afterDisconnect = portsForNode(state, extract).inputs;
  if (
    afterDisconnect.length !== 2 ||
    afterDisconnect[1].id !== "extract-in-1" ||
    afterDisconnect[1].resourceId
  ) {
    throw new Error("extract did not restore a reusable trailing AUTO input");
  }
});

Deno.test("merger grows inputs and ignores its trailing AUTO input", () => {
  const state = structuredClone(initialState);
  state.resources.push({
    id: "a",
    name: "A",
    unit: "kg",
    color: "#2563eb",
  });
  state.nodes.push(
    {
      id: "source-a",
      kind: "input",
      title: "Source A",
      x: 0,
      y: 0,
      inputSupplies: [{ id: "a", resourceId: "a", amount: 10 }],
    },
    {
      id: "source-b",
      kind: "input",
      title: "Source B",
      x: 0,
      y: 200,
      inputSupplies: [{ id: "a", resourceId: "a", amount: 20 }],
    },
    {
      id: "merge",
      kind: "merger",
      title: "Merge",
      x: 300,
      y: 100,
      resourceId: "a",
    },
    {
      id: "extract",
      kind: "extract",
      title: "Final output",
      x: 600,
      y: 100,
    },
  );
  const merger = state.nodes[2];
  if (portsForNode(state, merger).inputs[0].id !== "merge-in-0") {
    throw new Error("merger must start with one AUTO input");
  }
  state.edges.push(
    {
      id: "merge-a",
      sourceNodeId: "source-a",
      sourcePortId: "input-out:a",
      targetNodeId: "merge",
      targetPortId: "merge-in-0",
      resourceId: "a",
    },
    {
      id: "merge-b",
      sourceNodeId: "source-b",
      sourcePortId: "input-out:a",
      targetNodeId: "merge",
      targetPortId: "merge-in-1",
      resourceId: "a",
    },
    {
      id: "merged-output",
      sourceNodeId: "merge",
      sourcePortId: "merge-out",
      targetNodeId: "extract",
      targetPortId: "extract-in",
      resourceId: "a",
    },
  );
  const mergerInputs = portsForNode(state, merger).inputs;
  if (
    mergerInputs.length !== 3 ||
    mergerInputs[2].id !== "merge-in-2" ||
    mergerInputs[2].resourceId
  ) {
    throw new Error("merger did not append a trailing AUTO input");
  }

  const result = simulate(state);
  if (result.outputs.a !== 30) {
    throw new Error(
      `expected merged output of 30, received ${result.outputs.a}`,
    );
  }
});
