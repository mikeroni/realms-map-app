"""Explicit records shared by the route planner and its interface."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class TravelMode(str, Enum):
    RAIL = "rail"
    WALK = "walk"
    ICE = "ice"


@dataclass(frozen=True)
class Location:
    id: str
    name: str
    x: float
    z: float
    owner: str = ""
    kind: str = ""

    @property
    def label(self) -> str:
        if (
            self.owner
            and self.owner != "Public Land"
            and self.owner.casefold() not in self.name.casefold()
        ):
            return f"{self.name} ({self.owner})"
        return self.name


@dataclass(frozen=True)
class RailLink:
    name: str
    origin: str
    destination: str


@dataclass(frozen=True)
class Dataset:
    locations: dict[str, Location]
    rails: tuple[RailLink, ...]


@dataclass(frozen=True)
class Edge:
    destination: str
    distance: float
    duration: float
    mode: TravelMode
    rail_path: str | None = None


@dataclass(frozen=True)
class Segment:
    origin: str
    edge: Edge


@dataclass(frozen=True)
class Route:
    origin: str
    destination: str
    segments: tuple[Segment, ...]

    @property
    def total_time(self) -> float:
        return sum(segment.edge.duration for segment in self.segments)

    @property
    def total_distance(self) -> float:
        return sum(segment.edge.distance for segment in self.segments)

    @property
    def rail_paths(self) -> tuple[str, ...]:
        return tuple(
            dict.fromkeys(
                segment.edge.rail_path for segment in self.segments if segment.edge.rail_path
            )
        )
