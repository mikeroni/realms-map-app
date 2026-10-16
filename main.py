"""Streamlit entry point. Run with: streamlit run main.py."""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from zipfile import BadZipFile

import streamlit as st
import streamlit.components.v1 as components

from realms.data import load_dataset
from realms.models import Dataset, Route, TravelMode
from realms.routing import build_graph, fastest_route
from realms.tableau import map_url

DATA_PATH = Path(__file__).resolve().parent / "Realms Map Dataset.xlsx"
LOGGER = logging.getLogger(__name__)


@st.cache_data(show_spinner=False)
def cached_dataset(path: str, content_hash: str) -> Dataset:
    """The content hash invalidates the cache when the workbook changes."""
    return load_dataset(path)


def format_time(seconds: float) -> str:
    minutes, remaining = divmod(int(seconds), 60)
    return f"{minutes:02d}:{remaining:02d}"


def render_route(route: Route, dataset: Dataset) -> None:
    details, map_column = st.columns(2)
    with details:
        st.subheader("Route details")
        st.success(
            f"Route from **{dataset.locations[route.origin].name}** to **{dataset.locations[route.destination].name}**"
        )
        time_column, distance_column = st.columns(2)
        time_column.metric("Estimated travel time", format_time(route.total_time))
        distance_column.metric("Estimated distance", f"{route.total_distance:.0f} blocks")
        st.subheader("Route steps")
        labels = {TravelMode.WALK: "Walk", TravelMode.RAIL: "Rail", TravelMode.ICE: "Ice highway"}
        for number, segment in enumerate(route.segments, start=1):
            edge = segment.edge
            location = dataset.locations[edge.destination]
            label = f"{labels[edge.mode]} to {location.label}"
            if edge.mode is TravelMode.WALK:
                label += f" ({location.x:g}, {location.z:g})"
            with st.expander(f"Step {number}: {label}"):
                st.write(f"Distance: {edge.distance:.0f} blocks")
                st.write(f"Estimated time: {format_time(edge.duration)}")
    with map_column:
        st.subheader("Interactive map")
        url = map_url(route.rail_paths)
        if url:
            st.caption("The map highlights the rail portion of this route.")
            components.iframe(url, height=700, scrolling=False)
            st.markdown(f"[Open map in a new tab]({url})")
        else:
            st.info("This route has no rail segments to highlight on the map.")


def main() -> None:
    st.set_page_config(page_title="Realms Route Planner", page_icon="🗺️", layout="wide")
    st.title("Realms Route Planner")
    st.caption(
        "Find the fastest estimated journey across the Realm by rail, on foot, or by ice highway."
    )
    try:
        version = hashlib.sha256(DATA_PATH.read_bytes()).hexdigest()
        dataset = cached_dataset(str(DATA_PATH), version)
    except (OSError, ValueError, BadZipFile) as exc:
        st.error(f"The route data could not be loaded: {exc}")
        st.stop()

    # Discard old results when the workbook changes, including in a live session.
    if st.session_state.get("data_version") != version:
        st.session_state.route_results = None
        st.session_state.data_version = version
        for key in ("origin", "destination"):
            if st.session_state.get(key) not in dataset.locations:
                st.session_state[key] = ""
    if not isinstance(st.session_state.get("route_results"), Route):
        st.session_state.route_results = None

    locations = sorted(dataset.locations, key=lambda key: dataset.locations[key].label.casefold())

    def label(key: str) -> str:
        return dataset.locations[key].label if key else "Choose a location"

    with st.form("route_query"):
        st.subheader("Route planning")
        origin_column, destination_column = st.columns(2)
        origin = origin_column.selectbox(
            "Origin", [""] + locations, format_func=label, key="origin"
        )
        destination = destination_column.selectbox(
            "Destination", [""] + locations, format_func=label, key="destination"
        )
        include_ice = st.checkbox("Include ice highway routes", key="include_ice")
        submitted = st.form_submit_button("Find fastest route", type="primary")

    if submitted:
        st.session_state.route_results = None
        if not origin or not destination:
            st.warning("Please select both origin and destination.")
        elif origin == destination:
            st.warning("Choose two different locations.")
        elif origin not in dataset.locations or destination not in dataset.locations:
            st.warning("The location list has changed. Please choose the endpoints again.")
        else:
            try:
                graph = build_graph(dataset, include_ice_highways=include_ice)
                st.session_state.route_results = fastest_route(graph, origin, destination)
                if st.session_state.route_results is None:
                    st.warning("No route connects these locations.")
            except ValueError as exc:
                LOGGER.exception("Could not calculate a route")
                st.error(f"The route could not be calculated: {exc}")

    route = st.session_state.route_results
    if route is not None:
        render_route(route, dataset)
    with st.expander("How estimates work"):
        st.write(
            "Routes minimize estimated travel time, not distance. Rail uses 8 blocks/second, walking 3, and ice highways 72."
        )
        st.write(
            "Rail distances follow X/Z grid distance. Walking and ice estimates use straight-line X/Z distance. Walking is allowed between all locations; enabling ice connects every ice station to every other station."
        )
        st.write(
            "These estimates do not model terrain, elevation, waiting time, or dimension changes. The map highlights rail segments only."
        )


if __name__ == "__main__":
    main()
