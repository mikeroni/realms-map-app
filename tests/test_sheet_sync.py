from __future__ import annotations

import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.sync_sheet import (
    ReleaseError,
    canonical,
    current_values,
    digest,
    metadata,
    normalized,
    sync,
    validate_release,
    write_export,
)

FIXTURES = Path(__file__).parent / "sheets"


class SheetSyncTests(unittest.TestCase):
    def setUp(self):
        self.rows = json.loads((FIXTURES / "release-fixture.json").read_text())
        self.meta = {
            "schema": "1",
            "status": "approved",
            "release_id": "00000000-0000-0000-0000-000000000001",
            "digest": digest(self.rows),
            "source_spreadsheet_id": "sheet-id",
            "prepared_at": "2026-01-01T00:00:00.000Z",
            "approved_at": "2026-01-01T00:01:00.000Z",
        }

    def test_hash_matches_javascript_including_unicode(self):
        self.assertEqual(
            digest(self.rows), (FIXTURES / "release-fixture.sha256").read_text().strip()
        )
        self.assertEqual(canonical(self.rows), canonical([self.rows[0], *reversed(self.rows[1:])]))

    def test_accepts_complete_approved_release(self):
        self.assertEqual(validate_release(self.meta, self.rows, self.meta, "sheet-id"), self.rows)

    def test_rejects_unapproved_stale_tampered_or_foreign_release(self):
        for changes in (
            {"status": "draft"},
            {"schema": "2"},
            {"digest": "0" * 64},
            {"source_spreadsheet_id": "other-sheet"},
            {"approved_at": ""},
            {"release_id": "../../x"},
        ):
            changed = {**self.meta, **changes}
            with self.subTest(changes=changes), self.assertRaises(ReleaseError):
                validate_release(changed, self.rows, changed, "sheet-id")
        with self.assertRaisesRegex(ReleaseError, "changed during"):
            validate_release(self.meta, self.rows, {**self.meta, "status": "draft"}, "sheet-id")

    def test_rejects_bad_coordinates_formula_and_endpoint_roles(self):
        for column, value in (
            (3, ""),
            (3, None),
            (3, True),
            (3, float("nan")),
            (3, 1.5),
            (2, '=HYPERLINK("url")'),
            (0, "Wrong"),
            (1, "A,B"),
        ):
            rows = copy.deepcopy(self.rows)
            rows[1][column] = value
            with self.subTest(column=column, value=value), self.assertRaises(ReleaseError):
                normalized(rows)

    def test_rejects_empty_missing_endpoint_and_duplicate_connection(self):
        for rows in (
            [self.rows[0]],
            self.rows[:2],
            [*self.rows, *[[row[0], "other name", *row[2:]] for row in self.rows[1:3]]],
        ):
            with self.assertRaises(ReleaseError):
                normalized(rows)

    def test_sheets_omitted_trailing_blanks_are_padded(self):
        rows = copy.deepcopy(self.rows)
        rows[3] = rows[3][:5]
        self.assertEqual(normalized(rows)[3][-2:], ["", ""])

    def test_metadata_rejects_duplicates_and_accepts_missing_empty_value(self):
        self.assertEqual(
            metadata([["key", "value"], ["status", "draft"], ["approved_at"]]),
            {"status": "draft", "approved_at": ""},
        )
        with self.assertRaises(ReleaseError):
            metadata([["key", "value"], ["status", "draft"], ["status", "approved"]])

    def test_draft_and_preparing_snapshots_are_non_publishing_noops(self):
        for status in ("draft", "preparing"):
            with tempfile.TemporaryDirectory() as directory:
                output, receipt = Path(directory) / "data.xlsx", Path(directory) / "receipt.json"
                values = [["key", "value"], ["schema", "1"], ["status", status]]
                with patch("tools.sync_sheet.fetch_values", return_value=values) as fetch:
                    self.assertFalse(sync(None, "sheet-id", output, receipt))
                    fetch.assert_called_once()
                self.assertFalse(output.exists())
                self.assertFalse(receipt.exists())

    def test_workbook_readback_and_noop_keep_original_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "dataset.xlsx"
            self.assertTrue(write_export(self.rows, output))
            self.assertEqual(canonical(current_values(output)), canonical(self.rows))
            original = hashlib.sha256(output.read_bytes()).hexdigest()
            self.assertFalse(write_export([self.rows[0], *reversed(self.rows[1:])], output))
            self.assertEqual(hashlib.sha256(output.read_bytes()).hexdigest(), original)
            with self.assertRaises(ReleaseError):
                write_export(self.rows[:2], output)
            self.assertEqual(hashlib.sha256(output.read_bytes()).hexdigest(), original)

    def test_sync_reads_metadata_twice_and_only_writes_after_validation(self):
        values = [["key", "value"], *[list(pair) for pair in self.meta.items()]]
        with tempfile.TemporaryDirectory() as directory:
            output, receipt = Path(directory) / "data.xlsx", Path(directory) / "receipt.json"
            with patch(
                "tools.sync_sheet.fetch_values", side_effect=[values, self.rows, values]
            ) as fetch:
                self.assertTrue(sync(None, "sheet-id", output, receipt))
                self.assertEqual(fetch.call_count, 3)
            saved = json.loads(receipt.read_text())
            self.assertNotIn("source_spreadsheet_id", saved)
            self.assertEqual(saved["digest"], self.meta["digest"])
            original = output.read_bytes()
            draft = [["key", "value"], ["status", "draft"]]
            with patch("tools.sync_sheet.fetch_values", side_effect=[values, self.rows, draft]):
                with self.assertRaises(ReleaseError):
                    sync(None, "sheet-id", output, receipt)
            self.assertEqual(output.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
