"""Streamlit entry point. Run with: streamlit run main.py."""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from zipfile import BadZipFile

import streamlit as st
import streamlit.components.v1 as components

from realms.data import load_dataset
from realms.journeys import (
    MODE_LABELS,
    ROUTE_PARAMS,
    JourneyQuery,
    format_time,
    journey_url,
    parse_journey,
    route_directions,
)
from realms.models import Dataset, Route, TravelMode
from realms.routing import build_graph, fastest_route
from realms.tableau import map_url

DATA_PATH = Path(__file__).resolve().parent / "Realms Map Dataset.xlsx"
LOGGER = logging.getLogger(__name__)
EXAMPLE = JourneyQuery("Community Base", "Dorne")


@st.cache_data(show_spinner=False)
def cached_dataset(path: str, content_hash: str) -> Dataset:
    """The content hash invalidates the cache when the workbook changes."""
    return load_dataset(path)


def route_params() -> dict[str, list[str]]:
    return {key: st.query_params.get_all(key) for key in ROUTE_PARAMS if key in st.query_params}


def update_journey_url(query: JourneyQuery | None) -> None:
    params = {
        key: st.query_params.get_all(key) for key in st.query_params if key not in ROUTE_PARAMS
    }
    if query is not None:
        params.update(query.params())
    st.query_params.from_dict(params)
    st.session_state.seen_route_params = route_params()


def restore_shared_journey(dataset: Dataset) -> bool:
    params = route_params()
    if st.session_state.get("seen_route_params") == params:
        return False
    st.session_state.seen_route_params = params
    st.session_state.route_results = None
    st.session_state.completed_query = None
    st.session_state.link_error = None
    st.session_state.origin = ""
    st.session_state.destination = ""
    st.session_state.include_ice = False
    try:
        query = parse_journey(params, dataset)
    except ValueError as exc:
        st.session_state.link_error = str(exc)
        return False
    if query is None:
        return False
    st.session_state.origin = query.origin
    st.session_state.destination = query.destination
    st.session_state.include_ice = query.include_ice
    return True


def swap_endpoints() -> None:
    st.session_state.origin, st.session_state.destination = (
        st.session_state.destination,
        st.session_state.origin,
    )


def use_example() -> None:
    st.session_state.origin = EXAMPLE.origin
    st.session_state.destination = EXAMPLE.destination
    st.session_state.include_ice = EXAMPLE.include_ice


def render_route(route: Route, dataset: Dataset, query: JourneyQuery) -> None:
    details, map_column = st.columns(2)
    with details:
        st.subheader("Route details")
        st.success(
            f"Route from **{dataset.locations[route.origin].name}** to **{dataset.locations[route.destination].name}**"
        )
        time_column, distance_column = st.columns(2)
        time_column.metric("Estimated travel time", format_time(route.total_time))
        distance_column.metric("Estimated distance", f"{route.total_distance:.0f} blocks")
        copy_column, share_column = st.columns(2)
        with copy_column.popover("Copy directions", use_container_width=True):
            st.caption("Use the copy icon in the top-right corner, or select the text.")
            st.code(
                route_directions(route, dataset, query.include_ice), language=None, wrap_lines=True
            )
        with share_column.popover("Share journey", use_container_width=True):
            st.caption("Copy this link to reopen the journey, including its ice setting.")
            url = journey_url(st.context.url or "https://realms-map-app.onrender.com/", query)
            st.code(url, language=None, wrap_lines=True)
            st.caption("Journeys are recalculated with the current workbook when opened.")
        st.subheader("Route steps")
        for number, segment in enumerate(route.segments, start=1):
            edge = segment.edge
            location = dataset.locations[edge.destination]
            label = f"{MODE_LABELS[edge.mode]} to {location.label}"
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
        st.session_state.completed_query = None
        st.session_state.seen_route_params = None
        st.session_state.data_version = version
        for key in ("origin", "destination"):
            if st.session_state.get(key) not in dataset.locations:
                st.session_state[key] = ""
    if not isinstance(st.session_state.get("route_results"), Route) or not isinstance(
        st.session_state.get("completed_query"), JourneyQuery
    ):
        st.session_state.route_results = None

    from_link = restore_shared_journey(dataset)

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
        find_column, swap_column, example_column = st.columns(3)
        submitted = find_column.form_submit_button(
            "Find fastest route", type="primary", use_container_width=True
        )
        swapped = swap_column.form_submit_button(
            "Swap endpoints", on_click=swap_endpoints, use_container_width=True
        )
        example_available = all(
            key in dataset.locations for key in (EXAMPLE.origin, EXAMPLE.destination)
        )
        example = example_column.form_submit_button(
            "Try an example journey",
            on_click=use_example,
            disabled=not example_available,
            use_container_width=True,
            help="Community Base to Dorne, using the existing rail network.",
        )
        if not example_available:
            st.caption("The example is unavailable because its locations have changed.")

    if swapped:
        st.session_state.route_results = None
        st.session_state.completed_query = None
        st.session_state.link_error = None
        update_journey_url(None)
    if submitted or example or from_link or (swapped and origin and destination):
        st.session_state.route_results = None
        st.session_state.completed_query = None
        st.session_state.link_error = None
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
                else:
                    st.session_state.completed_query = JourneyQuery(
                        origin, destination, include_ice
                    )
            except ValueError as exc:
                LOGGER.exception("Could not calculate a route")
                st.error(f"The route could not be calculated: {exc}")
        update_journey_url(st.session_state.completed_query)

    if st.session_state.get("link_error"):
        st.warning(st.session_state.link_error)

    route = st.session_state.route_results
    if route is not None:
        render_route(route, dataset, st.session_state.completed_query)
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
