from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from streamlit.testing.v1 import AppTest

ROOT = Path(__file__).resolve().parents[1]


class AppTests(unittest.TestCase):
    def setUp(self):
        self.app = AppTest.from_file(str(ROOT / "main.py"), default_timeout=20).run()
        self.assertEqual(len(self.app.exception), 0)

    def search(self, origin, destination, ice=False):
        self.app.selectbox(key="origin").select(origin)
        self.app.selectbox(key="destination").select(destination)
        self.app.checkbox(key="include_ice").set_value(ice)
        self.app.button[0].click().run()
        self.assertEqual(len(self.app.exception), 0)
        self.assertEqual(len(self.app.error), 0)
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
