from __future__ import annotations

import math
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pandas as pd

from realms.data import DataValidationError, dataset_from_frame, load_dataset
from realms.models import Dataset, Edge, Location, RailLink, TravelMode
from realms.routing import build_graph, fastest_route
from realms.tableau import map_url

ROOT = Path(__file__).resolve().parents[1]


def row(name="A", x=0, z=0, path="", **values):
    return {"Location": name, "X": x, "Z": z, "Path": path, **values}


class DataTests(unittest.TestCase):
    def test_shipped_workbook_loads(self):
        dataset = load_dataset(ROOT / "Realms Map Dataset.xlsx")
        self.assertIn("Community Base", dataset.locations)
        self.assertTrue(dataset.rails)

    def test_missing_column_rejected(self):
        with self.assertRaisesRegex(DataValidationError, "Missing columns"):
            dataset_from_frame(pd.DataFrame([{"Location": "A"}]))

    def test_empty_table_rejected(self):
        with self.assertRaisesRegex(DataValidationError, "empty"):
            dataset_from_frame(pd.DataFrame(columns=["Location", "X", "Z", "Path"]))

    def test_blank_name_rejected(self):
        with self.assertRaisesRegex(DataValidationError, "name is blank"):
            dataset_from_frame(pd.DataFrame([row("  ")]))

    def test_invalid_coordinates_rejected(self):
        for value in (None, math.nan, math.inf, "not a coordinate"):
            with self.subTest(value=value), self.assertRaises(DataValidationError):
                dataset_from_frame(pd.DataFrame([row(x=value)]))

    def test_conflicting_location_rejected(self):
        with self.assertRaisesRegex(DataValidationError, "Conflicting"):
            dataset_from_frame(pd.DataFrame([row(), row(x=1)]))

    def test_invalid_rail_endpoints_rejected(self):
        for rows in (
            [row(path="rail")],
            [row(path="rail"), row(path="rail")],
            [row("A", path="rail"), row("B", path="rail"), row("C", path="rail")],
        ):
            with (
                self.subTest(rows=rows),
                self.assertRaisesRegex(DataValidationError, "two distinct"),
            ):
                dataset_from_frame(pd.DataFrame(rows))

    def test_optional_blanks_and_parentheses_preserved(self):
        data = dataset_from_frame(pd.DataFrame([row(" Base (East) ", Owner=math.nan, Type=None)]))
        location = data.locations["Base (East)"]
        self.assertEqual(location.owner, "")
        self.assertEqual(location.label, "Base (East)")

    def test_display_label_does_not_change_identity(self):
        location = Location("Base (East)", "Base (East)", 0, 0, "Alex")
        self.assertEqual(location.label, "Base (East) (Alex)")
        self.assertEqual(location.id, "Base (East)")


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.dataset = Dataset(
            {
                "A": Location("A", "A", 0, 0, kind="Ice Highway"),
                "B": Location("B", "B", 80, 0),
                "C": Location("C", "C", 0, 72, kind="Ice Highway"),
            },
            (RailLink("A to B", "A", "B"),),
        )

    def test_rail_duration_and_path_id(self):
        route = fastest_route(build_graph(self.dataset), "A", "B")
        self.assertEqual(route.total_time, 10)
        self.assertEqual(route.total_distance, 80)
        self.assertEqual(route.rail_paths, ("A to B",))

    def test_walking_only_location_is_reachable(self):
        route = fastest_route(build_graph(self.dataset), "A", "C")
        self.assertEqual(route.total_time, 24)
        self.assertEqual(route.segments[0].edge.mode, TravelMode.WALK)
        self.assertEqual(route.rail_paths, ())

    def test_ice_only_station_and_toggle(self):
        off = fastest_route(build_graph(self.dataset), "A", "C")
        on = fastest_route(build_graph(self.dataset, True), "A", "C")
        self.assertEqual(on.total_time, 1)
        self.assertLess(on.total_time, off.total_time)
        self.assertEqual(on.segments[0].edge.mode, TravelMode.ICE)

    def test_time_not_distance_is_optimized(self):
        graph = {
            "A": [Edge("D", 100, 100 / 3, TravelMode.WALK), Edge("B", 100, 12.5, TravelMode.RAIL)],
            "B": [Edge("D", 100, 12.5, TravelMode.RAIL)],
            "D": [],
        }
        route = fastest_route(graph, "A", "D")
        self.assertEqual(route.total_time, 25)
        self.assertEqual(route.total_distance, 200)

    def test_colocated_places_keep_distinct_ids(self):
        data = Dataset({key: Location(key, key, 0, 0) for key in ("A", "B")}, ())
        route = fastest_route(build_graph(data), "A", "B")
        self.assertEqual(route.origin, "A")
        self.assertEqual(route.destination, "B")
        self.assertEqual(route.total_time, 0)

    def test_same_endpoint_has_zero_cost(self):
        route = fastest_route(build_graph(self.dataset), "A", "A")
        self.assertEqual(route.segments, ())
        self.assertEqual(route.total_time, 0)

    def test_unknown_endpoint_rejected(self):
        with self.assertRaises(ValueError):
            fastest_route(build_graph(self.dataset), "", "B")

    def test_disconnected_graph(self):
        self.assertIsNone(fastest_route({"A": [], "B": []}, "A", "B"))

    def test_invalid_edges_rejected(self):
        for weight in (-1, math.inf, math.nan):
            with self.subTest(weight=weight), self.assertRaises(ValueError):
                fastest_route({"A": [Edge("B", 1, weight, TravelMode.WALK)], "B": []}, "A", "B")

    def test_shipped_routes_match_independent_all_pairs_solver(self):
        # Bellman-Ford from each source independently checks all destinations,
        # including zero-cost ties, without sharing the heap implementation.
        dataset = load_dataset(ROOT / "Realms Map Dataset.xlsx")
        for ice in (False, True):
            graph = build_graph(dataset, ice)
            for origin in graph:
                expected = dict.fromkeys(graph, math.inf)
                expected[origin] = 0
                for _ in range(len(graph) - 1):
                    changed = False
                    for source, edges in graph.items():
                        for edge in edges:
                            candidate = expected[source] + edge.duration
                            if candidate < expected[edge.destination]:
                                expected[edge.destination] = candidate
                                changed = True
                    if not changed:
                        break
                for destination, cost in expected.items():
                    with self.subTest(ice=ice, origin=origin, destination=destination):
                        route = fastest_route(graph, origin, destination)
                        self.assertAlmostEqual(route.total_time, cost, places=8)
                        self.assertEqual(route.destination, destination)


class TableauTests(unittest.TestCase):
    def test_no_rail_means_no_map(self):
        self.assertIsNone(map_url(()))

    def test_filter_round_trip(self):
        paths = ("Fo & AJ to Nick", "Dorne to Comm")
        url = urlparse(map_url(paths))
        self.assertEqual(url.netloc, "public.tableau.com")
        params = parse_qs(url.query)
        self.assertEqual(params["Path"], [",".join(paths)])
        self.assertEqual(params["Show Trains"], ["1"])
