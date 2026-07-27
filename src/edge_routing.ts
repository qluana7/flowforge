export type EdgePoint = {
  x: number;
  y: number;
};

export type EdgeObstacle = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type RoutedEdge = {
  d: string;
  label: EdgePoint;
  points: EdgePoint[];
};

export type EdgeSegment = {
  from: EdgePoint;
  to: EdgePoint;
};

export type EdgeRoutingOptions = {
  occupiedSegments?: EdgeSegment[];
};

const OBSTACLE_PADDING = 16;
const PORT_ESCAPE = 30;
const LANE_GAP = 24;
const CHANNEL_GAP = 12;
const CORNER_RADIUS = 10;
const OVERLAP_PENALTY = 32;

function inflateObstacle(obstacle: EdgeObstacle): EdgeObstacle {
  return {
    left: obstacle.left - OBSTACLE_PADDING,
    top: obstacle.top - OBSTACLE_PADDING,
    right: obstacle.right + OBSTACLE_PADDING,
    bottom: obstacle.bottom + OBSTACLE_PADDING,
  };
}

function approximatelyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.001;
}

function isSamePoint(a: EdgePoint, b: EdgePoint): boolean {
  return approximatelyEqual(a.x, b.x) && approximatelyEqual(a.y, b.y);
}

function cleanPoints(
  points: EdgePoint[],
  protectedPoints: EdgePoint[],
): EdgePoint[] {
  const unique = points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous ||
      !approximatelyEqual(point.x, previous.x) ||
      !approximatelyEqual(point.y, previous.y);
  });

  return unique.filter((point, index) => {
    const previous = unique[index - 1];
    const next = unique[index + 1];
    if (!previous || !next) return true;
    if (
      protectedPoints.some((protectedPoint) =>
        isSamePoint(
          point,
          protectedPoint,
        )
      )
    ) {
      return true;
    }
    const sameColumn = approximatelyEqual(previous.x, point.x) &&
      approximatelyEqual(point.x, next.x);
    const sameRow = approximatelyEqual(previous.y, point.y) &&
      approximatelyEqual(point.y, next.y);
    return !sameColumn && !sameRow;
  });
}

export function segmentIntersectsObstacle(
  from: EdgePoint,
  to: EdgePoint,
  obstacle: EdgeObstacle,
): boolean {
  if (approximatelyEqual(from.y, to.y)) {
    const left = Math.min(from.x, to.x);
    const right = Math.max(from.x, to.x);
    return from.y >= obstacle.top && from.y <= obstacle.bottom &&
      right >= obstacle.left && left <= obstacle.right;
  }

  if (approximatelyEqual(from.x, to.x)) {
    const top = Math.min(from.y, to.y);
    const bottom = Math.max(from.y, to.y);
    return from.x >= obstacle.left && from.x <= obstacle.right &&
      bottom >= obstacle.top && top <= obstacle.bottom;
  }

  return true;
}

function routeCollides(
  points: EdgePoint[],
  obstacles: EdgeObstacle[],
): boolean {
  // The first and last segments are the short port exit/entry stubs. They are
  // deliberately allowed to touch their own nodes; all routed segments between
  // those stubs must remain outside every node.
  for (let index = 1; index < points.length - 2; index += 1) {
    if (
      obstacles.some((obstacle) =>
        segmentIntersectsObstacle(points[index], points[index + 1], obstacle)
      )
    ) {
      return true;
    }
  }
  return false;
}

function routeLength(points: EdgePoint[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += Math.abs(points[index].x - points[index - 1].x) +
      Math.abs(points[index].y - points[index - 1].y);
  }
  return length;
}

export function routeCoreSegments(points: EdgePoint[]): EdgeSegment[] {
  const segments: EdgeSegment[] = [];
  for (let index = 1; index < points.length - 2; index += 1) {
    segments.push({ from: points[index], to: points[index + 1] });
  }
  return segments;
}

export function segmentOverlapLength(
  first: EdgeSegment,
  second: EdgeSegment,
): number {
  const firstHorizontal = approximatelyEqual(first.from.y, first.to.y);
  const secondHorizontal = approximatelyEqual(second.from.y, second.to.y);
  if (
    firstHorizontal && secondHorizontal &&
    approximatelyEqual(first.from.y, second.from.y)
  ) {
    const start = Math.max(
      Math.min(first.from.x, first.to.x),
      Math.min(second.from.x, second.to.x),
    );
    const end = Math.min(
      Math.max(first.from.x, first.to.x),
      Math.max(second.from.x, second.to.x),
    );
    return Math.max(0, end - start);
  }

  const firstVertical = approximatelyEqual(first.from.x, first.to.x);
  const secondVertical = approximatelyEqual(second.from.x, second.to.x);
  if (
    firstVertical && secondVertical &&
    approximatelyEqual(first.from.x, second.from.x)
  ) {
    const start = Math.max(
      Math.min(first.from.y, first.to.y),
      Math.min(second.from.y, second.to.y),
    );
    const end = Math.min(
      Math.max(first.from.y, first.to.y),
      Math.max(second.from.y, second.to.y),
    );
    return Math.max(0, end - start);
  }

  return 0;
}

function isMonotonicStraightRoute(points: EdgePoint[]): boolean {
  const first = points[0];
  const last = points.at(-1)!;
  const horizontal = points.every((point) =>
    approximatelyEqual(point.y, first.y)
  );
  const vertical = points.every((point) =>
    approximatelyEqual(point.x, first.x)
  );
  const xDirection = Math.sign(last.x - first.x);
  const yDirection = Math.sign(last.y - first.y);

  if (horizontal && xDirection !== 0) {
    return points.slice(1).every((point, index) =>
      Math.sign(point.x - points[index].x) === xDirection ||
      approximatelyEqual(point.x, points[index].x)
    );
  }

  if (vertical && yDirection !== 0) {
    return points.slice(1).every((point, index) =>
      Math.sign(point.y - points[index].y) === yDirection ||
      approximatelyEqual(point.y, points[index].y)
    );
  }

  return false;
}

function roundedPath(points: EdgePoint[]): string {
  if (isMonotonicStraightRoute(points)) {
    const first = points[0];
    const last = points.at(-1)!;
    return `M ${first.x} ${first.y} L ${last.x} ${last.y}`;
  }

  const parts = [`M ${points[0].x} ${points[0].y}`];

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const corner = points[index];
    const next = points[index + 1];
    const incomingLength = Math.abs(corner.x - previous.x) +
      Math.abs(corner.y - previous.y);
    const outgoingLength = Math.abs(next.x - corner.x) +
      Math.abs(next.y - corner.y);
    const radius = Math.min(
      CORNER_RADIUS,
      incomingLength / 2,
      outgoingLength / 2,
    );
    const entry = {
      x: corner.x +
        Math.sign(previous.x - corner.x) * Math.min(radius, incomingLength),
      y: corner.y +
        Math.sign(previous.y - corner.y) * Math.min(radius, incomingLength),
    };
    const exit = {
      x: corner.x +
        Math.sign(next.x - corner.x) * Math.min(radius, outgoingLength),
      y: corner.y +
        Math.sign(next.y - corner.y) * Math.min(radius, outgoingLength),
    };
    parts.push(
      `L ${entry.x} ${entry.y} Q ${corner.x} ${corner.y} ${exit.x} ${exit.y}`,
    );
  }

  const last = points.at(-1)!;
  parts.push(`L ${last.x} ${last.y}`);
  return parts.join(" ");
}

function pointAtHalfLength(points: EdgePoint[]): EdgePoint {
  const halfLength = routeLength(points) / 2;
  let traversed = 0;

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const segmentLength = Math.abs(current.x - previous.x) +
      Math.abs(current.y - previous.y);
    if (traversed + segmentLength >= halfLength) {
      const ratio = segmentLength === 0
        ? 0
        : (halfLength - traversed) / segmentLength;
      return {
        x: previous.x + (current.x - previous.x) * ratio,
        y: previous.y + (current.y - previous.y) * ratio,
      };
    }
    traversed += segmentLength;
  }

  return points.at(-1)!;
}

function candidateScore(
  points: EdgePoint[],
  occupiedSegments: EdgeSegment[],
): number {
  const bends = Math.max(0, points.length - 2);
  const overlapLength = routeCoreSegments(points).reduce(
    (total, segment) =>
      total + occupiedSegments.reduce(
        (segmentTotal, occupied) =>
          segmentTotal + segmentOverlapLength(segment, occupied),
        0,
      ),
    0,
  );
  return routeLength(points) + bends * 8 +
    overlapLength * OVERLAP_PENALTY;
}

function addLaneVariants(
  lanes: Set<number>,
  lane: number,
  minimum = Number.NEGATIVE_INFINITY,
): void {
  for (
    const candidate of [
      lane,
      lane - CHANNEL_GAP,
      lane + CHANNEL_GAP,
      lane - CHANNEL_GAP * 2,
      lane + CHANNEL_GAP * 2,
    ]
  ) {
    if (candidate >= minimum) lanes.add(candidate);
  }
}

export function routeOrthogonalEdge(
  from: EdgePoint,
  to: EdgePoint,
  obstacles: EdgeObstacle[],
  options: EdgeRoutingOptions = {},
): RoutedEdge {
  const expandedObstacles = obstacles.map(inflateObstacle);
  const start = { x: from.x + PORT_ESCAPE, y: from.y };
  const end = { x: to.x - PORT_ESCAPE, y: to.y };
  const candidates: EdgePoint[][] = [];
  const laneXs = new Set<number>();
  const laneYs = new Set<number>();
  addLaneVariants(laneXs, (start.x + end.x) / 2);
  addLaneVariants(laneXs, Math.min(start.x, end.x) - LANE_GAP);
  addLaneVariants(laneXs, Math.max(start.x, end.x) + LANE_GAP);

  for (const obstacle of expandedObstacles) {
    addLaneVariants(laneXs, obstacle.left - LANE_GAP);
    addLaneVariants(laneXs, obstacle.right + LANE_GAP);
    addLaneVariants(laneYs, obstacle.top - LANE_GAP, 58);
    addLaneVariants(laneYs, obstacle.bottom + LANE_GAP, 58);
  }

  const upperEdge = Math.min(
    from.y,
    to.y,
    ...expandedObstacles.map((obstacle) => obstacle.top),
  );
  const lowerEdge = Math.max(
    from.y,
    to.y,
    ...expandedObstacles.map((obstacle) => obstacle.bottom),
  );
  addLaneVariants(laneYs, Math.max(58, upperEdge - LANE_GAP), 58);
  addLaneVariants(laneYs, lowerEdge + LANE_GAP, 58);

  for (const laneX of laneXs) {
    candidates.push(cleanPoints([
      from,
      start,
      { x: laneX, y: start.y },
      { x: laneX, y: end.y },
      end,
      to,
    ], [start, end]));
  }

  for (const laneY of laneYs) {
    candidates.push(cleanPoints([
      from,
      start,
      { x: start.x, y: laneY },
      { x: end.x, y: laneY },
      end,
      to,
    ], [start, end]));
  }

  const occupiedSegments = options.occupiedSegments ?? [];
  const sortedCandidates = candidates
    .map((candidate) => ({
      candidate,
      score: candidateScore(candidate, occupiedSegments),
    }))
    .sort((a, b) => a.score - b.score);
  const route =
    sortedCandidates.find(({ candidate }) =>
      !routeCollides(candidate, expandedObstacles)
    )?.candidate ?? sortedCandidates[0].candidate;

  return {
    d: roundedPath(route),
    label: pointAtHalfLength(route),
    points: route,
  };
}
