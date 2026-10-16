"""Fastest routes under the Realm's documented travel-time assumptions."""

from __future__ import annotations

import heapq
import math
from itertools import combinations, count

from realms.models import Dataset, Edge, Route, Segment, TravelMode

SPEEDS = {TravelMode.RAIL: 8.0, TravelMode.WALK: 3.0, TravelMode.ICE: 72.0}
Graph = dict[str, list[Edge]]


def build_graph(dataset: Dataset, include_ice_highways: bool = False) -> Graph:
    graph: Graph = {key: [] for key in dataset.locations}

    def connect(a: str, b: str, mode: TravelMode, path: str | None = None) -> None:
        first, second = dataset.locations[a], dataset.locations[b]
        dx, dz = abs(first.x - second.x), abs(first.z - second.z)
        distance = dx + dz if mode is TravelMode.RAIL else math.hypot(dx, dz)
        duration = distance / SPEEDS[mode]
        graph[a].append(Edge(b, distance, duration, mode, path))
        graph[b].append(Edge(a, distance, duration, mode, path))

    for rail in dataset.rails:
        connect(rail.origin, rail.destination, TravelMode.RAIL, rail.name)
    if include_ice_highways:
        stations = [
            key for key, location in dataset.locations.items() if "Ice Highway" in location.kind
        ]
        for a, b in combinations(stations, 2):
            connect(a, b, TravelMode.ICE)
    for a, b in combinations(dataset.locations, 2):
        connect(a, b, TravelMode.WALK)
    return graph


def fastest_route(graph: Graph, origin: str, destination: str) -> Route | None:
    if origin not in graph or destination not in graph:
        raise ValueError("Choose a valid origin and destination.")
    serial = count()
    queue = [(0.0, next(serial), origin)]
    best = {origin: 0.0}
    previous: dict[str, Segment] = {}

    while queue:
        duration, _, node = heapq.heappop(queue)
        if duration != best[node]:
            continue
        if node == destination:
            segments = []
            while node != origin:
                segment = previous[node]
                segments.append(segment)
                node = segment.origin
            return Route(origin, destination, tuple(reversed(segments)))
        for edge in graph[node]:
            if (
                edge.destination not in graph
                or not math.isfinite(edge.duration)
                or edge.duration < 0
            ):
                raise ValueError(
                    "Route edges must have known destinations and finite, nonnegative times."
                )
            candidate = duration + edge.duration
            if candidate < best.get(edge.destination, math.inf):
                best[edge.destination] = candidate
                previous[edge.destination] = Segment(node, edge)
                heapq.heappush(queue, (candidate, next(serial), edge.destination))
    return None
