import type { ProjectState } from "./types.ts";

export interface ClosedLoopComponent {
  id: string;
  nodeIds: string[];
  edgeIds: string[];
  resourceIds: string[];
  circulatingResourceIds: string[];
}

export function findClosedLoops(
  state: ProjectState,
  includedNodeIds = new Set(state.nodes.map((node) => node.id)),
): ClosedLoopComponent[] {
  const adjacency = new Map<string, string[]>();
  for (const nodeId of includedNodeIds) adjacency.set(nodeId, []);
  for (const edge of state.edges) {
    if (
      includedNodeIds.has(edge.sourceNodeId) &&
      includedNodeIds.has(edge.targetNodeId)
    ) {
      adjacency.get(edge.sourceNodeId)?.push(edge.targetNodeId);
    }
  }

  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (nodeId: string): void => {
    indexes.set(nodeId, nextIndex);
    lowLinks.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const targetId of adjacency.get(nodeId) ?? []) {
      if (!indexes.has(targetId)) {
        visit(targetId);
        lowLinks.set(
          nodeId,
          Math.min(lowLinks.get(nodeId)!, lowLinks.get(targetId)!),
        );
      } else if (onStack.has(targetId)) {
        lowLinks.set(
          nodeId,
          Math.min(lowLinks.get(nodeId)!, indexes.get(targetId)!),
        );
      }
    }

    if (lowLinks.get(nodeId) !== indexes.get(nodeId)) return;
    const component: string[] = [];
    while (stack.length) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === nodeId) break;
    }
    components.push(component);
  };

  for (const nodeId of includedNodeIds) {
    if (!indexes.has(nodeId)) visit(nodeId);
  }

  return components.flatMap((nodeIds) => {
    const memberIds = new Set(nodeIds);
    const internalEdges = state.edges.filter((edge) =>
      memberIds.has(edge.sourceNodeId) && memberIds.has(edge.targetNodeId)
    );
    const cyclic = nodeIds.length > 1 ||
      internalEdges.some((edge) => edge.sourceNodeId === edge.targetNodeId);
    if (!cyclic) return [];
    const sortedNodeIds = [...nodeIds].sort();
    const resourceIds = [
      ...new Set(internalEdges.map((edge) => edge.resourceId)),
    ].sort();
    const internalResourceIds = new Set(resourceIds);
    const circulatingResourceIds = [
      ...new Set(
        state.edges.filter((edge) =>
          !memberIds.has(edge.sourceNodeId) &&
          memberIds.has(edge.targetNodeId) &&
          internalResourceIds.has(edge.resourceId)
        ).map((edge) => edge.resourceId),
      ),
    ].sort();
    return [{
      id: `loop:${sortedNodeIds.join("|")}`,
      nodeIds: sortedNodeIds,
      edgeIds: internalEdges.map((edge) => edge.id),
      resourceIds,
      circulatingResourceIds,
    }];
  });
}
