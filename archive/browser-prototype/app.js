
// Distance functions
function euclideanDistance(p1, p2) {
  return Math.hypot(p1[0] - p2[0], p1[1] - p2[1]);
}

function manhattanDistance(p1, p2) {
  return Math.abs(p1[0] - p2[0]) + Math.abs(p1[1] - p2[1]);
}

// Build graph from CSV rows
function buildGraph(data, includeIceHighways = false) {
  const graph = {};
  const nameToCoord = {};
  const ownerLookup = {};
  const typeLookup = {};
  const iceHighwayCoords = [];

  // Collect location metadata
  for (const row of data) {
    const location = row.Location;
    const coord = [parseFloat(row.X), parseFloat(row.Z)];
    if (!(location in nameToCoord)) {
      nameToCoord[location] = coord;
      ownerLookup[location] = row.Owner || "";
      typeLookup[location] = row.Type || "";

      if ((row.Type || "").includes("Ice Highway")) {
        iceHighwayCoords.push(location);
      }
    }
  }

  // Group by path and build graph
  const paths = {};
  for (const row of data) {
    const path = row.Path;
    if (!path) continue;
    if (!(path in paths)) {
      paths[path] = [];
    }
    paths[path].push(row);
  }

  for (const [path, points] of Object.entries(paths)) {
    if (points.length !== 2) continue;
    const [p1, p2] = points;
    const loc1 = p1.Location;
    const loc2 = p2.Location;
    const dist = manhattanDistance(nameToCoord[loc1], nameToCoord[loc2]);

    if (!graph[loc1]) graph[loc1] = [];
    if (!graph[loc2]) graph[loc2] = [];
    graph[loc1].push({ to: loc2, distance: dist, method: "Rail" });
    graph[loc2].push({ to: loc1, distance: dist, method: "Rail" });
  }

  // Add Ice Highways if enabled
  if (includeIceHighways) {
    for (let i = 0; i < iceHighwayCoords.length; i++) {
      for (let j = i + 1; j < iceHighwayCoords.length; j++) {
        const a = iceHighwayCoords[i];
        const b = iceHighwayCoords[j];
        const dist = euclideanDistance(nameToCoord[a], nameToCoord[b]);
        const time = dist / 72.0;
        graph[a].push({ to: b, distance: dist, method: "Ice Highway" });
        graph[b].push({ to: a, distance: dist, method: "Ice Highway" });
      }
    }
  }

  return { graph, nameToCoord, ownerLookup };
}

// Dijkstra's algorithm
function findShortestPath(graph, start, end) {
  const queue = [{ node: start, cost: 0, path: [] }];
  const visited = new Set();

  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost);
    const current = queue.shift();
    if (visited.has(current.node)) continue;
    visited.add(current.node);
    const newPath = [...current.path, current.node];

    if (current.node === end) {
      return { path: newPath, total: current.cost };
    }

    const neighbors = graph[current.node] || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor.to)) {
        queue.push({
          node: neighbor.to,
          cost: current.cost + neighbor.distance,
          path: newPath
        });
      }
    }
  }

  return { path: [], total: Infinity };
}
