import {
  type EdgeObstacle,
  routeCoreSegments,
  routeOrthogonalEdge,
  segmentIntersectsObstacle,
  segmentOverlapLength,
} from "./edge_routing.ts";

function coreRouteIntersects(
  points: { x: number; y: number }[],
  obstacle: EdgeObstacle,
): boolean {
  for (let index = 1; index < points.length - 2; index += 1) {
    if (
      segmentIntersectsObstacle(points[index], points[index + 1], obstacle)
    ) {
      return true;
    }
  }
  return false;
}

Deno.test("edge routing avoids a node placed between connected ports", () => {
  const blockingNode = {
    left: 350,
    top: 80,
    right: 570,
    bottom: 220,
  };
  const route = routeOrthogonalEdge(
    { x: 220, y: 150 },
    { x: 700, y: 150 },
    [
      { left: 0, top: 90, right: 220, bottom: 210 },
      blockingNode,
      { left: 700, top: 90, right: 920, bottom: 210 },
    ],
  );

  if (coreRouteIntersects(route.points, blockingNode)) {
    throw new Error(`route crosses blocking node: ${route.d}`);
  }
});

Deno.test("backward edge routing exits around its endpoint nodes", () => {
  const sourceNode = {
    left: 500,
    top: 90,
    right: 736,
    bottom: 210,
  };
  const targetNode = {
    left: 100,
    top: 90,
    right: 336,
    bottom: 210,
  };
  const route = routeOrthogonalEdge(
    { x: sourceNode.right, y: 150 },
    { x: targetNode.left, y: 150 },
    [sourceNode, targetNode],
  );

  if (
    coreRouteIntersects(route.points, sourceNode) ||
    coreRouteIntersects(route.points, targetNode)
  ) {
    throw new Error(`backward route crosses an endpoint node: ${route.d}`);
  }
});

Deno.test("routed edge returns a usable path label position", () => {
  const route = routeOrthogonalEdge(
    { x: 100, y: 100 },
    { x: 500, y: 240 },
    [],
  );

  if (
    !route.d.startsWith("M ") ||
    !Number.isFinite(route.label.x) ||
    !Number.isFinite(route.label.y)
  ) {
    throw new Error("routed edge did not return valid SVG geometry");
  }
});

Deno.test("perfectly straight edges use a non-degenerate line path", () => {
  const route = routeOrthogonalEdge(
    { x: 220, y: 150 },
    { x: 700, y: 150 },
    [],
  );

  if (route.d !== "M 220 150 L 700 150") {
    throw new Error(
      `expected a simple straight SVG path, received: ${route.d}`,
    );
  }
});

Deno.test("later edges choose another channel instead of overlapping", () => {
  const from = { x: 220, y: 150 };
  const to = { x: 700, y: 150 };
  const first = routeOrthogonalEdge(from, to, []);
  const occupiedSegments = routeCoreSegments(first.points);
  const second = routeOrthogonalEdge(from, to, [], { occupiedSegments });
  const overlap = routeCoreSegments(second.points).reduce(
    (total, segment) =>
      total + occupiedSegments.reduce(
        (subtotal, occupied) =>
          subtotal + segmentOverlapLength(segment, occupied),
        0,
      ),
    0,
  );

  if (overlap !== 0) {
    throw new Error(`expected separate edge channels, overlap: ${overlap}`);
  }
  if (second.points.every((point) => point.y === from.y)) {
    throw new Error("second route did not leave the occupied straight channel");
  }
});
