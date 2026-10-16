# Google Sheets location and rail editor

Install this **inside the existing Google spreadsheet that Tableau uses**. Do not
import a replacement workbook, rename connected tabs, or reconnect Tableau. The
editor preserves existing tab IDs, headings, surviving path IDs, and unrelated
data. Opening the sidebar does not change source data.

## Features and limits

- Add a master location in Overworld, Nether, or End, optionally adding a standalone
  point to that world's existing map-data tab.
- Edit a location's name, owner, type, X/Z coordinates, or world. Repeated rows in
  that world's map data stay consistent. Matching Overworld land-claim labels,
  owners, and types update too; conflicting claim details require manual resolution.
- Add or remove Overworld rail links by checking/unchecking destinations and
  reviewing a preview. Links are bidirectional. Removing a link keeps both places
  on the map, without accumulating duplicate standalone points on repeated edits.
- Remove an unconnected location after reviewing and confirming its removal.
  Locations with connections or land claims cannot be deleted. Cross-world moves
  have the same safeguards; coordinates are not automatically scaled.
- Prepare and approve a frozen Overworld export for the Python app. GitHub reads
  that snapshot, never unapproved live edits.
- `Origin/Destination`, `Path`, `shapeType`, and `shapeId` are controlled by the
  data rules, not editable form fields. Renaming a location does not rename its
  existing Path IDs, even when an ID contains the old name.
- No polygon drawing, boundary/point editing, or Nether/End connection editing.
  Editing a location's coordinates does not move its land-claim polygon.
  Transport assumptions are unchanged.

Use the desktop Google Sheets browser editor. Local tests simulate Google services;
native sidebar behavior and authorization require installation-time verification.

## Install in the existing spreadsheet

1. Make a backup copy for recovery and name the current version in version history.
   Test sample writes on a copy first. **Keep the original file as the live source**;
   a backup is not a replacement Tableau connection.
2. Sign into the Google account that owns or edits the live Sheet. Open
   **Extensions → Apps Script** from that spreadsheet.
3. Preserve any existing script. Do not replace an existing `onOpen` handler or
   same-named functions without deliberately merging them. Check for conflicts first.
4. Add `Domain.gs`, `Code.gs`, and `Sidebar.html` with their supplied contents.
   In project settings, enable **Show appsscript.json manifest file**. Use the supplied
   manifest for a new bound project; merge scopes/settings if code already exists.
5. Save and reload the spreadsheet. Open **Realm tools → Locations and rails**.
   Review Google's authorization request: the manifest requests only the current
   spreadsheet and container UI. No external requests, Drive access, GitHub tokens,
   web-app deployment, or installable triggers are needed for the editor.
6. Verify locations and existing connections. A mapped location missing from the
   master list is retained and reported, not automatically removed or backfilled.

### Update an already installed sidebar

1. Close any open Realm tools sidebars. Make a backup or name the current Sheet
   version before your first real edit.
2. Open **Extensions → Apps Script** in the same spreadsheet and replace the
   contents of `Domain.gs`, `Code.gs`, and `Sidebar.html` with the updated files.
   Update all three together. Leave `appsscript.json` and the Google/GitHub setup
   unchanged; this update requests no new permissions or services.
3. Save, reload the spreadsheet, and reopen **Realm tools → Locations and rails**.
   No deployment is needed. Confirm the new **Edit place** section appears.
4. In **Edit place**, choose the existing world and place, edit the fields, then
   **Preview edits → Save reviewed changes**. Owner changes apply to this one
   place and its matching claim, not all places owned by that player.
5. In **Rails**, choose the source, check destinations to add and uncheck existing
   destinations to remove, then preview and save. Removals require a separate
   confirmation. Filtering the list does not discard hidden checked destinations.
6. Verify the changed points, labels, and routes in Tableau, then follow the
   snapshot preparation/approval flow below. Edits never automatically approve
   or replace the frozen app export.

#### Preview mismatch fix

If adding a place works but every previewed edit fails with
"The edit does not match its preview", update `Code.gs` to the version that uses
`previewJson_` in `editPlan_`. The earlier fingerprint depended on object property
order across separate requests, so unchanged inputs could be rejected.

For an installation that already has **Edit place** and rail removal controls,
only `Code.gs` needs replacing for this fix. Save the script, close the sidebar,
reload the spreadsheet, reopen Realm tools, and make a fresh preview. Existing
previews are not valid after the update. No deployment, new permissions, Sheet
replacement, or manual removal of the places already added is required.

Required original headers, in this order:

| Tab | Columns |
| --- | --- |
| Master Locations | World, Location, X, Z, Type, Owner |
| Tableau Data / Nether Data / End Data | Origin/Destination, Path, Location, X, Z, Type, Owner |
| Land Claim Data | shapeId, shapeType, shapeLabel, pointId, X, Z, Type, Owner |

The editor expects literal values and whole block X/Z coordinates. It stops on
unexpected schemas, formulas, conflicting metadata, or malformed existing paths.
Whitespace is normalized for comparisons, as in the Python app. Only affected
source ranges are rewritten. Removals compact affected tables and blank obsolete
tail cells without deleting/recreating tabs or changing column headings. Names
are unique within a world, ignoring case. Claims match by location name within
Overworld; the claim sheet has no world column. Polygon IDs, point IDs, types of
shapes, coordinates, and vertex order are preserved.

### Preserve the Tableau connection

Record the original spreadsheet URL and connected tab names. Confirm Tableau uses
the intended named tabs, not a wildcard union that could include internal export
tabs. Verify that its source ranges include newly appended rows: a fixed range
ending at row 65 does not grow just because the Sheet does. The editor does not
change Tableau configuration.

After the first real addition, request a Tableau update and verify both the point
and rail segment. Confirm the app's exact Path value highlights the same segment.
Local tests do not establish this end-to-end result.

## Publish a data release

1. Finish editing and select **Publish → Prepare new snapshot**.
2. Request a Tableau refresh, wait for it to complete, and check the changed places
   and paths. Avoid source edits during this step.
3. Check the verification box and choose **Approve for GitHub**. This is your
   attestation, not an automated Tableau check. A changed source or snapshot is
   refused; prepare and verify again.
4. Run **Publish approved Sheet data** in GitHub Actions, or wait for the optional
   hourly schedule after configuration. Check Actions and Render afterward.
   Approval does not itself mean the app has deployed.

First preparation creates `_App Export` and `_App Release` in the **same spreadsheet**.
They contain the frozen data and release ID/status/fingerprint/timestamps. They are
not Tableau inputs. Their ownership is recorded in document properties; preexisting
tabs with those names are never overwritten automatically. Do not manually edit them.
You may move these tabs to the end or hide them. Lookups use names/IDs, not tab
positions or visibility. Do not rename, recreate, or move them to another file.
Preparing again replaces only this internal snapshot and invalidates its old approval
before writing data. Original source tabs are never cleared.

The document lock serializes sidebar saves, not direct manual Sheet edits. Avoid
editing the same rows manually during a sidebar save. If a master write succeeds
but a map write fails, the error explains this; retrying the identical form completes
it without duplicating the master entry. This retry rule applies to **adding** a place.

Edits/removals use a source fingerprint, a verified preview, and a protected-range
preflight. If anything changed since loading or previewing, reload and review again.
Reported write failures trigger restoration of the original values. Apps Script
does not provide a multi-tab transaction: a process interruption or failed rollback
can still leave partial source changes. A persistent recovery marker then blocks
further sidebar actions, including preparing/approving a new release, until version
history restores the original data or the complete intended edit is recovered.
The marker clears automatically when the source matches either complete state.
Do not clear it manually or publish partially recovered data. The existing frozen
approved export is never changed by a source edit, and GitHub may still read that
previously approved snapshot while recovery is pending.

Only the approved Overworld export goes into GitHub. Master, Nether, End, and
land-claim tabs are excluded. The public app still needs no Google credentials.

## Configure GitHub publication

Owner setup is required; the code does not create cloud resources or change sharing,
GitHub settings, or Render configuration. Use
[Workload Identity Federation through a service account](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account)
to avoid storing a long-lived Google private key.

1. In a Google Cloud project you control, enable Google Sheets, IAM Service Account
   Credentials, and Security Token Service APIs. Create a dedicated service account
   such as `realms-sheet-reader`, with no broad project data role.
2. Share only the intended spreadsheet with its email as **Viewer**. Do not make the
   Sheet public, grant Editor, or enable domain-wide delegation.
3. Configure a GitHub OIDC provider (`https://token.actions.githubusercontent.com`).
   Map `google.subject=assertion.sub` and repository/owner ID attributes. Restrict
   its condition to the repository's numeric ID, owner's numeric ID,
   `refs/heads/main`, and this workflow's `workflow_ref`. Use actual GitHub IDs,
   not names alone. Follow Google's
   [deployment-pipeline setup guide](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines).
4. Give only that restricted principal `roles/iam.workloadIdentityUser` on this
   service account. Do not grant project-wide administrative roles.
5. Create a GitHub environment named `sheet-publishing`. Restrict its deployment
   branches to `main`; optionally require owner approval. Add these environment variables:

   | Variable | Value |
   | --- | --- |
   | `REALMS_SHEET_ID` | ID between `/d/` and `/edit` in the existing Sheet URL |
   | `GOOGLE_WORKLOAD_IDENTITY_PROVIDER` | `projects/NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER` |
   | `GOOGLE_SHEETS_READER` | Dedicated service account email |

6. Merge the reviewed implementation and manually run the workflow against an approved
   snapshot. It authenticates with short-lived credentials, reads with the Sheets
   read-only scope, verifies the release fingerprint, exports Excel, reads it back,
   and runs Python/JavaScript tests before committing the export and `data-release.json`.
   A concurrent main-branch update makes the push fail instead of force-pushing.
   If branch protection requires pull requests, adapt the direct-commit workflow to
   that policy before enabling it; do not disable protection to make it work.
7. Verify Render deploys that commit. Its settings are not changed by this workflow.
   GitHub-token pushes do not automatically trigger ordinary push-based Actions CI,
   so tests run in the publishing job. No Render hook is enabled, avoiding duplicate
   deployments alongside existing auto-deploy settings.

After one successful manual release, set the **repository variable**
`SHEET_SYNC_ENABLED=true` to enable the hourly poll. It must be repository-level:
the job's enable condition runs before environment variables are loaded. Draft
snapshots and unchanged data are no-ops. Invalid exports fail without changing the
committed workbook. Schedules can be delayed; GitHub disables scheduled workflows
in inactive public repositories after 60 days. The manual option remains available.
[GitHub schedule limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

## Local checks

```sh
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
python -m ruff check .
python -m ruff format --check .
node --test tests/sheets/*.test.cjs
node tools/sheets-preview.cjs
```

Open `http://127.0.0.1:8522` for a synthetic in-memory preview. Restarting resets it.
It runs the real rules and server functions with fake Google services; no live data
is accessed. Google authorization, native Apps Script behavior/quotas, GitHub OIDC,
Tableau refresh, and Render deployment require separate integration checks.

## Recovery

- For a bad Sheet edit, use version history or restore the affected data from backup
  while keeping the original spreadsheet and connected tab IDs.
- Failed export/tests stop before committing. Correct the source, prepare a fresh
  snapshot, verify Tableau, and approve again.
- For a bad publication, disable `SHEET_SYNC_ENABLED`, revert the data commit, and
  redeploy the known-good version. Correct the source and approval before reenabling
  sync, or the previous approved snapshot could be republished.
- To remove the editor, preserve other bound code, remove its menu/script, and
  deliberately remove internal export tabs only after disabling sync. Leave the
  original source tabs and Tableau connection in place.
