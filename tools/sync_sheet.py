"""Pull one approved Google Sheets snapshot into the app's Excel export.

No writes to Google Sheets. Credentials use Application Default Credentials and
are supplied only to the publishing workflow, never to the Streamlit app.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import quote

import openpyxl
import pandas as pd

from realms.data import DataValidationError, dataset_from_frame

HEADERS = ["Origin/Destination", "Path", "Location", "X", "Z", "Type", "Owner"]
ROOT = Path(__file__).resolve().parents[1]
EXPORT = ROOT / "Realms Map Dataset.xlsx"
RECEIPT = ROOT / "data-release.json"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]


class ReleaseError(ValueError):
    """The release is missing, inconsistent, or no longer approved."""


def normalized(values: list[list]) -> list[list]:
    if not values or values[0] != HEADERS:
        raise ReleaseError("The export headings differ from the app's seven-column schema.")
    rows = []
    paths: dict[str, list[list]] = {}
    for raw in values[1:]:
        if not any(value is not None and str(value).strip() for value in raw):
            continue
        if len(raw) > 7:
            raise ReleaseError("An export row has extra columns.")
        row = ["" if value is None else value for value in raw] + [""] * (7 - len(raw))
        for index in (0, 1, 2, 5, 6):
            row[index] = str(row[index]).strip()
            if (
                len(row[index]) > 200
                or row[index].startswith("=")
                or any(ord(char) < 32 for char in row[index])
            ):
                raise ReleaseError(
                    "Export text contains a formula, control character, or long value."
                )
        for index in (3, 4):
            value = row[index]
            try:
                number = float(value)
            except (TypeError, ValueError) as error:
                raise ReleaseError("X and Z must be whole block coordinates.") from error
            if (
                isinstance(value, bool)
                or not math.isfinite(number)
                or not number.is_integer()
                or abs(number) > 2**53 - 1
            ):
                raise ReleaseError("X and Z must be safe whole block coordinates.")
            row[index] = int(number)
        if row[0] not in {"Origin", "Destination"} or not row[2]:
            raise ReleaseError("Each row needs a location and a valid endpoint role.")
        if "," in row[1]:
            raise ReleaseError("A path name contains Tableau's comma filter delimiter.")
        if row[1]:
            paths.setdefault(row[1], []).append(row)
        rows.append(row)
    pairs = set()
    for name, endpoints in paths.items():
        if len(endpoints) != 2 or {row[0] for row in endpoints} != {"Origin", "Destination"}:
            raise ReleaseError(f"Path {name!r} needs one Origin and one Destination.")
        pair = tuple(sorted(row[2] for row in endpoints))
        if pair in pairs:
            raise ReleaseError("The export contains duplicate connections.")
        pairs.add(pair)
    try:
        dataset_from_frame(pd.DataFrame(rows, columns=HEADERS))
    except DataValidationError as error:
        raise ReleaseError(str(error)) from error
    names: dict[str, str] = {}
    for row in rows:
        previous = names.setdefault(row[2].lower(), row[2])
        if previous != row[2]:
            raise ReleaseError("Location names differ only by case.")
    return [HEADERS, *rows]


def canonical(values: list[list]) -> str:
    rows = [[str(value) for value in row] for row in normalized(values)[1:]]

    def js_key(row):
        return json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode("utf-16-be")

    rows.sort(key=js_key)
    return json.dumps([HEADERS, *rows], ensure_ascii=False, separators=(",", ":"))


def digest(values: list[list]) -> str:
    return hashlib.sha256(canonical(values).encode()).hexdigest()


def metadata(values: list[list]) -> dict[str, str]:
    if not values or values[0] != ["key", "value"]:
        raise ReleaseError("Prepare a snapshot in Realm tools before syncing.")
    result = {}
    for row in values[1:]:
        if not row or not row[0]:
            continue
        if len(row) > 2 or row[0] in result:
            raise ReleaseError("Release metadata is malformed or has duplicate keys.")
        result[str(row[0])] = str(row[1]) if len(row) == 2 else ""
    return result


def validate_release(before: dict, values: list[list], after: dict, sheet_id: str) -> list[list]:
    if before != after:
        raise ReleaseError("The release changed during download. Retry after editing is complete.")
    if before.get("schema") != "1" or before.get("status") != "approved":
        raise ReleaseError("The snapshot is not approved for publication.")
    if before.get("source_spreadsheet_id") != sheet_id:
        raise ReleaseError("The snapshot belongs to a different spreadsheet.")
    if not re.fullmatch(r"[0-9a-f-]{36}", before.get("release_id", "")):
        raise ReleaseError("The release identifier is invalid.")
    if not before.get("approved_at") or not before.get("prepared_at"):
        raise ReleaseError("The release is missing preparation or approval time.")
    rows = normalized(values)
    if digest(rows) != before.get("digest"):
        raise ReleaseError("The export no longer matches its approved fingerprint.")
    return rows


def current_values(path: Path) -> list[list]:
    book = openpyxl.load_workbook(path, read_only=True, data_only=False)
    try:
        return [list(row) for row in book["Tableau Data"].values]
    finally:
        book.close()


def write_export(rows: list[list], output: Path) -> bool:
    """Validate first; replace only after the generated file passes a read-back."""
    rows = normalized(rows)
    if output.exists() and canonical(current_values(output)) == canonical(rows):
        return False
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.title = "Tableau Data"
    for row in rows:
        sheet.append(row)
    # Text remains text in Excel, including content that resembles a formula.
    for row in sheet:
        for cell in row:
            if isinstance(cell.value, str):
                cell.data_type = "s"
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    with tempfile.NamedTemporaryFile(suffix=".xlsx", dir=output.parent, delete=False) as temporary:
        candidate = Path(temporary.name)
    try:
        book.save(candidate)
        if digest(current_values(candidate)) != digest(rows):
            raise ReleaseError("Generated workbook failed its read-back check.")
        candidate.replace(output)
    finally:
        book.close()
        candidate.unlink(missing_ok=True)
    return True


def fetch_values(session, sheet_id: str, cell_range: str) -> list[list]:
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{quote(sheet_id, safe='')}/values/{quote(cell_range, safe='')}"
    response = session.get(url, params={"valueRenderOption": "UNFORMATTED_VALUE"}, timeout=30)
    response.raise_for_status()
    return response.json().get("values", [])


def sync(session, sheet_id: str, output: Path, receipt: Path) -> bool:
    # Two metadata reads catch a concurrent prepare/approval; the digest catches partial row writes.
    before = metadata(fetch_values(session, sheet_id, "'_App Release'!A1:B20"))
    if before.get("schema") == "1" and before.get("status") in {"draft", "preparing"}:
        return False  # Normal before approval; never publish an unfinished snapshot.
    values = fetch_values(session, sheet_id, "'_App Export'!A:G")
    after = metadata(fetch_values(session, sheet_id, "'_App Release'!A1:B20"))
    rows = validate_release(before, values, after, sheet_id)
    changed = write_export(rows, output)
    if changed:
        public_receipt = {
            key: before[key]
            for key in ("schema", "release_id", "digest", "prepared_at", "approved_at")
        }
        public_receipt["rows"] = len(rows) - 1
        receipt.write_text(json.dumps(public_receipt, indent=2) + "\n")
    return changed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sheet-id", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,}", args.sheet_id):
        parser.error("Invalid Google spreadsheet ID.")
    # Optional publishing dependencies are deliberately absent from the public app's requirements.
    import google.auth
    from google.auth.transport.requests import AuthorizedSession

    credentials, _ = google.auth.default(scopes=SCOPES)
    with AuthorizedSession(credentials) as session:
        changed = sync(session, args.sheet_id, EXPORT, RECEIPT)
    print(
        "Updated the validated Excel export."
        if changed
        else "No approved data changes; export left untouched."
    )
    if output_path := os.environ.get("GITHUB_OUTPUT"):
        with Path(output_path).open("a") as stream:
            stream.write(f"changed={str(changed).lower()}\n")


if __name__ == "__main__":
    main()
