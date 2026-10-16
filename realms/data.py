"""Read the maintained workbook without modifying its contents."""

from __future__ import annotations

import math
from collections import defaultdict
from pathlib import Path

import pandas as pd

from realms.models import Dataset, Location, RailLink

REQUIRED_COLUMNS = {"Location", "X", "Z", "Path"}


class DataValidationError(ValueError):
    """The source cannot safely be interpreted as a route network."""


def _text(value: object) -> str:
    return "" if pd.isna(value) else str(value).strip()


def dataset_from_frame(frame: pd.DataFrame) -> Dataset:
    missing = REQUIRED_COLUMNS - set(frame.columns)
    if missing:
        raise DataValidationError(f"Missing columns: {', '.join(sorted(missing))}.")
    if frame.empty:
        raise DataValidationError("The location table is empty.")

    locations: dict[str, Location] = {}
    paths: dict[str, list[str]] = defaultdict(list)
    for row_number, row in enumerate(frame.to_dict("records"), start=2):
        name = _text(row["Location"])
        if not name:
            raise DataValidationError(f"Row {row_number}: location name is blank.")
        try:
            x, z = float(row["X"]), float(row["Z"])
        except (TypeError, ValueError) as exc:
            raise DataValidationError(f"Row {row_number}: X and Z must be numbers.") from exc
        if not math.isfinite(x) or not math.isfinite(z):
            raise DataValidationError(f"Row {row_number}: X and Z must be finite.")

        # The workbook has no separate ID column. Its exact normalized name is
        # the key; display labels and coordinates are never reverse-matched.
        location = Location(name, name, x, z, _text(row.get("Owner")), _text(row.get("Type")))
        if name in locations and locations[name] != location:
            raise DataValidationError(f"Conflicting coordinates or metadata for {name!r}.")
        locations[name] = location
        path = _text(row["Path"])
        if path:
            paths[path].append(name)

    rails = []
    for name, endpoints in sorted(paths.items()):
        if len(endpoints) != 2 or endpoints[0] == endpoints[1]:
            raise DataValidationError(
                f"Rail path {name!r} must have exactly two distinct endpoints."
            )
        rails.append(RailLink(name, *endpoints))
    return Dataset(locations, tuple(rails))


def load_dataset(filepath: str | Path, sheet_name: str = "Tableau Data") -> Dataset:
    return dataset_from_frame(pd.read_excel(filepath, sheet_name=sheet_name))
