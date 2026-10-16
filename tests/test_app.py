from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from streamlit.testing.v1 import AppTest

ROOT = Path(__file__).resolve().parents[1]


class AppTests(unittest.TestCase):
    def setUp(self):
        self.app = AppTest.from_file(str(ROOT / "main.py"), default_timeout=20).run()
        self.assertEqual(len(self.app.exception), 0)

    def click(self, label):
        next(button for button in self.app.button if button.label == label).click().run()
        self.assertEqual(len(self.app.exception), 0)
        self.assertEqual(len(self.app.error), 0)

    def open_link(self, params):
        self.app = AppTest.from_file(str(ROOT / "main.py"), default_timeout=20)
        self.app.query_params.update(params)
        self.app.run()
        self.assertEqual(len(self.app.exception), 0)
        self.assertEqual(len(self.app.error), 0)

    def search(self, origin, destination, ice=False):
        self.app.selectbox(key="origin").select(origin)
        self.app.selectbox(key="destination").select(destination)
        self.app.checkbox(key="include_ice").set_value(ice)
        self.click("Find fastest route")
        return self.app.session_state["route_results"]

    def test_initial_state_and_missing_selection(self):
        self.assertIsNone(self.search("", ""))
        self.assertIn("both origin", self.app.warning[0].value)

    def test_blank_origin_after_success_is_not_substituted(self):
        self.assertIsNotNone(self.search("Community Base", "Dorne"))
        self.assertIsNone(self.search("", "Dorne"))
        self.assertEqual(len(self.app.success), 0)
        self.assertEqual(len(self.app.get("iframe")), 0)

    def test_blank_destination_after_success_is_not_substituted(self):
        self.search("Community Base", "Dorne")
        self.assertIsNone(self.search("Community Base", ""))
        self.assertEqual(len(self.app.success), 0)

    def test_walking_route_clears_previous_map(self):
        self.search("Community Base", "Dorne")
        self.assertEqual(len(self.app.get("iframe")), 1)
        route = self.search("Dorne", "Villager Trading Hall")
        self.assertEqual(route.rail_paths, ())
        self.assertEqual(route.total_time, 30)
        self.assertEqual(len(self.app.get("iframe")), 0)

    def test_ice_only_route_clears_previous_map(self):
        self.search("Community Base", "Dorne")
        route = self.search("Northern IHS", "Eastern IHS", ice=True)
        self.assertEqual(route.rail_paths, ())
        self.assertEqual(len(self.app.get("iframe")), 0)

    def test_parentheses_in_name_are_not_stripped(self):
        name = "End Portal 1 (Activated)"
        route = self.search(name, "Dorne")
        self.assertEqual(route.origin, name)

    def test_equal_endpoints_clear_previous_result(self):
        self.search("Community Base", "Dorne")
        self.assertIsNone(self.search("Dorne", "Dorne"))
        self.assertEqual(len(self.app.get("iframe")), 0)

    def test_launch_from_different_working_directory(self):
        previous = Path.cwd()
        try:
            with tempfile.TemporaryDirectory() as directory:
                os.chdir(directory)
                app = AppTest.from_file(str(ROOT / "main.py"), default_timeout=20).run()
                self.assertEqual(len(app.exception), 0)
                self.assertEqual(len(app.error), 0)
                self.assertGreater(len(app.selectbox[0].options), 1)
        finally:
            os.chdir(previous)

    def test_data_load_error_is_explained(self):
        source = """
from unittest.mock import patch
import main
with patch.object(main, "cached_dataset", side_effect=ValueError("Missing columns: X.")):
    main.main()
"""
        app = AppTest.from_string(source, default_timeout=20).run()
        self.assertEqual(len(app.exception), 0)
        self.assertIn("Missing columns: X", app.error[0].value)
        self.assertEqual(len(app.selectbox), 0)

    def test_example_calculates_a_real_workbook_route(self):
        self.app.checkbox(key="include_ice").set_value(True)
        self.click("Try an example journey")
        route = self.app.session_state["route_results"]
        self.assertEqual((route.origin, route.destination), ("Community Base", "Mob Farm"))
        self.assertEqual(
            [segment.edge.destination for segment in route.segments],
            ["Central IHS", "Fortune", "Petrichor", "Galini", "Mob Farm"],
        )
        self.assertEqual(
            [segment.edge.mode.value for segment in route.segments],
            ["rail", "rail", "rail", "rail", "walk"],
        )
        self.assertFalse(self.app.checkbox(key="include_ice").value)
        self.assertEqual(
            route.rail_paths,
            ("Comm to C IHS", "C IHS to Fortune", "Fortune to Petrichor", "Petrichor to Galini"),
        )
        self.assertEqual(len(self.app.get("iframe")), 1)

    def test_example_copy_and_share_include_the_complete_journey(self):
        self.click("Try an example journey")
        route = self.app.session_state["route_results"]
        directions = self.app.code[0].value
        for number, segment in enumerate(route.segments, start=1):
            self.assertIn(f"{number}. ", directions)
            self.assertIn(segment.edge.destination, directions)
        self.assertIn("5. Walk to Mob Farm", directions)
        map_params = parse_qs(urlsplit(self.app.get("iframe")[0].proto.src).query)
        self.assertEqual(map_params["Path"], [",".join(route.rail_paths)])
        self.open_link(parse_qs(urlsplit(self.app.code[1].value).query))
        self.assertEqual(self.app.session_state["route_results"], route)

    def test_swap_uses_current_form_values_and_preserves_ice(self):
        self.search("Community Base", "Dorne")
        self.app.selectbox(key="origin").select("Northern IHS")
        self.app.selectbox(key="destination").select("Eastern IHS")
        self.app.checkbox(key="include_ice").set_value(True)
        self.click("Swap endpoints")
        route = self.app.session_state["route_results"]
        self.assertEqual((route.origin, route.destination), ("Eastern IHS", "Northern IHS"))
        self.assertTrue(self.app.checkbox(key="include_ice").value)
        self.assertEqual(len(self.app.get("iframe")), 0)
        self.assertEqual(self.app.query_params["ice"], ["1"])
        self.click("Swap endpoints")
        self.assertEqual(self.app.session_state["route_results"].origin, "Northern IHS")

    def test_swap_incomplete_form_does_not_invent_an_endpoint(self):
        self.search("Community Base", "Dorne")
        self.app.selectbox(key="origin").select("")
        self.click("Swap endpoints")
        self.assertEqual(self.app.selectbox(key="origin").value, "Dorne")
        self.assertEqual(self.app.selectbox(key="destination").value, "")
        self.assertIsNone(self.app.session_state["route_results"])
        self.assertEqual(len(self.app.code), 0)
        self.assertNotIn("from", self.app.query_params)

    def test_share_link_restores_route_and_ice_without_a_click(self):
        original = self.search("Northern IHS", "Eastern IHS", ice=True)
        params = parse_qs(urlsplit(self.app.code[1].value).query)
        self.open_link(params)
        restored = self.app.session_state["route_results"]
        self.assertEqual(restored, original)
        self.assertTrue(self.app.checkbox(key="include_ice").value)
        self.assertEqual(len(self.app.get("iframe")), 0)

    def test_shared_rail_route_preserves_tableau_path_names(self):
        self.search("Community Base", "Dorne")
        before = self.app.get("iframe")[0].proto.src
        params = parse_qs(urlsplit(self.app.code[1].value).query)
        self.open_link(params)
        self.assertEqual(self.app.get("iframe")[0].proto.src, before)
        self.app.run()
        self.assertEqual(self.app.get("iframe")[0].proto.src, before)

    def test_shared_parentheses_name_is_not_reverse_parsed(self):
        self.open_link({"from": "End Portal 1 (Activated)", "to": "Dorne", "ice": "0"})
        self.assertEqual(self.app.session_state["route_results"].origin, "End Portal 1 (Activated)")

    def test_malformed_shared_links_do_not_fall_back_to_a_location(self):
        for params in (
            {"from": "Removed location", "to": "Dorne"},
            {"from": "Community Base"},
            {"from": "Dorne", "to": "Dorne"},
            {"from": ["Community Base", "Dorne"], "to": "Dorne"},
            {"from": "Community Base", "to": "Dorne", "ice": "maybe"},
        ):
            with self.subTest(params=params):
                self.open_link(params)
                self.assertIsNone(self.app.session_state["route_results"])
                self.assertEqual(len(self.app.warning), 1)
                self.assertEqual(len(self.app.code), 0)
                self.assertEqual(self.app.selectbox(key="origin").value, "")
                self.click("Try an example journey")
                self.assertEqual(len(self.app.warning), 0)
                self.assertIsNotNone(self.app.session_state["route_results"])

    def test_link_change_in_existing_session_replaces_previous_result(self):
        self.search("Community Base", "Dorne")
        self.app.query_params.update({"from": "Dorne", "to": "Villager Trading Hall"})
        self.app.run()
        route = self.app.session_state["route_results"]
        self.assertEqual(route.destination, "Villager Trading Hall")
        self.assertEqual(len(self.app.get("iframe")), 0)

    def test_copy_and_share_stay_with_the_displayed_result(self):
        self.search("Community Base", "Dorne")
        before = [code.value for code in self.app.code]
        # A rerun with edited form values must not silently relabel the old result.
        self.app.selectbox(key="destination").select("Northern IHS")
        self.app.checkbox(key="include_ice").set_value(True)
        self.app.run()
        self.assertEqual([code.value for code in self.app.code], before)

    def test_invalid_submission_clears_copy_share_and_route_url(self):
        self.search("Community Base", "Dorne")
        self.assertEqual(len(self.app.code), 2)
        self.search("", "Dorne")
        self.assertEqual(len(self.app.code), 0)
        self.assertNotIn("from", self.app.query_params)
        self.assertNotIn("ice", self.app.query_params)

    def test_unrelated_repeated_query_parameters_survive_search(self):
        self.open_link({"tag": ["one", "two"]})
        self.search("Community Base", "Dorne")
        self.assertEqual(self.app.query_params["tag"], ["one", "two"])
        self.search("", "Dorne")
        self.assertEqual(self.app.query_params["tag"], ["one", "two"])
