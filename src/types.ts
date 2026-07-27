export type ResourceCategory = "material" | "energy" | "utility" | "waste";
export type NodeKind =
  | "machine"
  | "source"
  | "input"
  | "extract"
  | "splitter"
  | "merger";
export type PortDirection = "input" | "output";
export type NodeTitleKey =
  | "node.default.machine"
  | "node.default.source"
  | "node.default.input"
  | "node.default.extract"
  | "node.default.splitter"
  | "node.default.merger";

export interface Resource {
  id: string;
  name: string;
  symbol?: string;
  category?: ResourceCategory;
  unit: string;
  color: string;
  imageDataUrl?: string;
}

export interface AuxiliaryDefinition {
  id: string;
  name: string;
  unit: string;
  color: string;
}

export interface RecipePort {
  id: string;
  resourceId: string;
  amount: number;
  probability?: number;
}

export interface AuxiliaryUse {
  auxiliaryId: string;
  amount: number;
}

export interface Recipe {
  id: string;
  machineId: string;
  description: string;
  duration: number;
  inputs: RecipePort[];
  outputs: RecipePort[];
  auxiliaryUses: AuxiliaryUse[];
}

export interface InputSupply {
  id: string;
  resourceId: string;
  amount: number;
}

export interface MachineDefinition {
  id: string;
  name: string;
  description: string;
  imageDataUrl?: string;
}

export interface FlowNode {
  id: string;
  kind: NodeKind;
  title: string;
  titleKey?: NodeTitleKey;
  x: number;
  y: number;
  machineId?: string;
  activeRecipeIds?: string[];
  finalOutputPortIds?: string[];
  multiRecipe?: boolean;
  resourceId?: string;
  inputSupplies?: InputSupply[];
  /** Legacy Source Node amount. Resource Nodes now supply on demand. */
  amount?: number;
  splitRatios?: number[];
}

export interface Edge {
  id: string;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
  resourceId: string;
}

export interface ProjectState {
  version: 2;
  resources: Resource[];
  auxiliaries: AuxiliaryDefinition[];
  machines: MachineDefinition[];
  recipes: Recipe[];
  nodes: FlowNode[];
  edges: Edge[];
}

export interface PortView {
  id: string;
  resourceId: string;
  amount: number;
  direction: PortDirection;
  label: string;
  recipeId?: string;
}

export interface SimulationResult {
  nodeRuns: Record<string, number>;
  edgeFlows: Record<string, number>;
  outputs: Record<string, number>;
  remainingResources: Record<string, number>;
  circulatingResources: Record<string, number>;
  auxiliaryTotals: Record<string, number>;
  elapsedTime: number;
  warnings: string[];
}
