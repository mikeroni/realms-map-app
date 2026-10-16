"""Build Tableau filters from the current route, never from earlier UI state."""

from __future__ import annotations

from urllib.parse import quote, urlencode

TABLEAU_URL = "https://public.tableau.com/views/WayfinderEmbed/Wayfinder"


def map_url(rail_paths: tuple[str, ...]) -> str | None:
    if not rail_paths:
        return None
    params = {
        "Show Trains": "1",
        "Path": ",".join(rail_paths),
        ":embed": "yes",
        ":showVizHome": "no",
        ":host_url": "https://public.tableau.com/",
        ":embed_code_version": "3",
        ":tabs": "no",
        ":toolbar": "no",
        ":showAppBanner": "false",
        ":display_spinner": "no",
    }
    return f"{TABLEAU_URL}?{urlencode(params, quote_via=quote, safe=',')}"
