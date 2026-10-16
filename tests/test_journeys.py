from __future__ import annotations

import unittest
from urllib.parse import parse_qs, urlsplit

from realms.journeys import JourneyQuery, format_time, journey_url, parse_journey, route_directions
from realms.models import Dataset, Edge, Location, Route, Segment, TravelMode


class JourneyTests(unittest.TestCase):
    def setUp(self):
        self.names = ("Base (East) & West + #1", "Éowyn's / port?", "Ice Station")
        self.dataset = Dataset(
            {name: Location(name, name, index * 80, -20) for index, name in enumerate(self.names)},
            (),
        )

    def test_share_round_trip_preserves_exact_names_and_options(self):
        for ice in (False, True):
            query = JourneyQuery(*self.names[:2], ice)
            url = urlsplit(journey_url("https://example.org/planner/?unrelated=1#old", query))
            self.assertEqual(
                (url.scheme, url.netloc, url.path), ("https", "example.org", "/planner/")
            )
            self.assertEqual(url.fragment, "")
            params = parse_qs(url.query)
            self.assertNotIn("unrelated", params)
            self.assertEqual(parse_journey(params, self.dataset), query)

    def test_local_preview_links_stay_local(self):
        url = journey_url("http://localhost:8511/", JourneyQuery(*self.names[:2]))
        self.assertTrue(url.startswith("http://localhost:8511/?"))

    def test_no_route_parameters_is_not_a_request(self):
        self.assertIsNone(parse_journey({"unrelated": ["1"]}, self.dataset))

    def test_omitted_ice_defaults_to_off(self):
        query = parse_journey({"from": [self.names[0]], "to": [self.names[1]]}, self.dataset)
        self.assertFalse(query.include_ice)

    def test_invalid_links_are_rejected(self):
        valid = {"from": [self.names[0]], "to": [self.names[1]], "ice": ["0"]}
        for changes in (
            {"from": []},
            {"from": [""]},
            {"to": [""]},
            {"to": ["Removed location"]},
            {"to": [self.names[0]]},
            {"from": [self.names[0], self.names[0]]},
            {"ice": ["0", "1"]},
            {"ice": ["false"]},
            {"ice": [""]},
        ):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                parse_journey(valid | changes, self.dataset)
        with self.assertRaisesRegex(ValueError, "both locations"):
            parse_journey({"ice": ["1"]}, self.dataset)

    def test_unsafe_or_incomplete_app_address_is_rejected(self):
        for address in ("javascript:alert(1)", "//example.org", "/planner", "https://"):
            with self.subTest(address=address), self.assertRaises(ValueError):
                journey_url(address, JourneyQuery(*self.names[:2]))

    def test_directions_include_modes_coordinates_options_and_estimate(self):
        for mode in TravelMode:
            route = Route(
                self.names[0],
                self.names[1],
                (Segment(self.names[0], Edge(self.names[1], 80, 10, mode)),),
            )
            text = route_directions(route, self.dataset, mode is TravelMode.ICE)
            self.assertIn("X: 0, Z: -20", text)
            self.assertIn("X: 80, Z: -20", text)
            self.assertIn("00:10 (mm:ss)", text)
            self.assertIn("Times are estimates", text)
            self.assertIn(
                {TravelMode.WALK: "Walk", TravelMode.RAIL: "Rail", TravelMode.ICE: "Ice highway"}[
                    mode
                ],
                text,
            )
            self.assertIn(
                "Ice highways: included" if mode is TravelMode.ICE else "Ice highways: excluded",
                text,
            )

    def test_directions_keep_all_steps_in_order(self):
        route = Route(
            self.names[0],
            self.names[2],
            (
                Segment(self.names[0], Edge(self.names[1], 80, 10, TravelMode.RAIL)),
                Segment(self.names[1], Edge(self.names[2], 80, 80 / 3, TravelMode.WALK)),
            ),
        )
        text = route_directions(route, self.dataset, False)
        self.assertLess(text.index("1. Rail"), text.index("2. Walk"))
        self.assertIn("00:36", text)

    def test_time_format_keeps_existing_truncation(self):
        self.assertEqual(format_time(36.25), "00:36")
        self.assertEqual(format_time(60), "01:00")
