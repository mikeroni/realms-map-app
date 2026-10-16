"""Share existing journeys and format directions without changing the network."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import urlencode, urlsplit, urlunsplit

from realms.models import Dataset, Route, TravelMode

ROUTE_PARAMS = ("from", "to", "ice")
MODE_LABELS = {TravelMode.WALK: "Walk", TravelMode.RAIL: "Rail", TravelMode.ICE: "Ice highway"}


@dataclass(frozen=True)
class JourneyQuery:
    origin: str
    destination: str
    include_ice: bool = False

    def params(self) -> dict[str, str]:
        return {"from": self.origin, "to": self.destination, "ice": str(int(self.include_ice))}


def parse_journey(params: Mapping[str, list[str]], dataset: Dataset) -> JourneyQuery | None:
    """Reject ambiguous or stale links; never guess a replacement location."""
    if not any(key in params for key in ROUTE_PARAMS):
        return None
    if any(len(params[key]) != 1 for key in ROUTE_PARAMS if key in params):
        raise ValueError(
            "This journey link has repeated or missing values. Choose the locations below."
        )
    origin = params.get("from", [""])[0]
    destination = params.get("to", [""])[0]
    if not origin or not destination:
        raise ValueError("This journey link needs both locations. Choose them below.")
    if origin not in dataset.locations or destination not in dataset.locations:
        raise ValueError(
            "A location in this journey link is no longer in the workbook. Choose the locations below."
        )
    if origin == destination:
        raise ValueError(
            "This journey link uses the same location twice. Choose two different locations."
        )
    ice = params.get("ice", ["0"])[0]
    if ice not in ("0", "1"):
        raise ValueError(
            "This journey link has an invalid ice setting. Choose the journey options below."
        )
    return JourneyQuery(origin, destination, ice == "1")


def journey_url(base_url: str, query: JourneyQuery) -> str:
    """Use the current app's address, without unrelated query parameters."""
    parts = urlsplit(base_url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("The app address must be an HTTP or HTTPS URL.")
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query.params()), ""))


def format_time(seconds: float) -> str:
    minutes, remaining = divmod(int(seconds), 60)
    return f"{minutes:02d}:{remaining:02d}"


def route_directions(route: Route, dataset: Dataset, include_ice: bool) -> str:
    origin = dataset.locations[route.origin]
    destination = dataset.locations[route.destination]
    lines = [
        f"{origin.label} → {destination.label}",
        f"Estimated time: {format_time(route.total_time)} (mm:ss) | Distance: {route.total_distance:.0f} blocks",
        f"Ice highways: {'included' if include_ice else 'excluded'}",
        f"Start: {origin.label} (X: {origin.x:g}, Z: {origin.z:g})",
    ]
    for number, segment in enumerate(route.segments, start=1):
        edge = segment.edge
        stop = dataset.locations[edge.destination]
        lines.append(
            f"{number}. {MODE_LABELS[edge.mode]} to {stop.label} (X: {stop.x:g}, Z: {stop.z:g})"
            f" — {edge.distance:.0f} blocks, {format_time(edge.duration)}"
        )
    lines.append("Times are estimates; terrain, waiting, and lag can change the journey.")
    return "\n".join(lines)
