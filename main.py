import math
import heapq
import pandas as pd
from collections import defaultdict
import streamlit as st
import webbrowser
import urllib.parse
import streamlit.components.v1 as components

# --- Graph & Pathfinding Logic ---

def euclidean_distance(p1, p2):
    return math.hypot(p1[0] - p2[0], p1[1] - p2[1])

def manhattan_distance(p1, p2):
    return abs(p1[0] - p2[0]) + abs(p1[1] - p2[1])

def build_graph_from_excel(filepath, sheet_name="Tableau Data", include_ice_highways=False):
    df = pd.read_excel(filepath, sheet_name=sheet_name)
    graph = defaultdict(list)
    ice_highways = []
    types_lookup = {}

    name_to_coord = {}
    owner_lookup = {}
    # Track path names for map viewing
    coord_pair_to_path = {}

    # First, collect ALL locations (including those without paths)
    for _, row in df.iterrows():
        location = row["Location"]
        coord = (row["X"], row["Z"])
        
        # Only add if we haven't seen this location before
        if location not in name_to_coord:
            name_to_coord[location] = coord
            owner_lookup[location] = row.get("Owner", "")
            types_lookup[coord] = str(row.get("Type", ""))
            
            # Check for ice highways
            if "Ice Highway" in types_lookup[coord]:
                ice_highways.append(coord)

    # Then, add rail connections from paths
    grouped = df.groupby("Path")
    for path, group in grouped:
        if len(group) != 2 or pd.isna(path):
            continue

        p1_row, p2_row = group.iloc[0], group.iloc[1]
        p1 = (p1_row["X"], p1_row["Z"])
        p2 = (p2_row["X"], p2_row["Z"])
        distance = manhattan_distance(p1, p2)
        travel_time = distance / 8  # 8 units/sec normal
        graph[p1].append((p2, travel_time, "normal"))
        graph[p2].append((p1, travel_time, "normal"))
        
        # Store the path name for both directions
        coord_pair_to_path[(p1, p2)] = path
        coord_pair_to_path[(p2, p1)] = path

    # Add Ice Highway connections
    if include_ice_highways:
        for i in range(len(ice_highways)):
            for j in range(i + 1, len(ice_highways)):
                p1, p2 = ice_highways[i], ice_highways[j]
                distance = euclidean_distance(p1, p2)
                travel_time = distance / 72  # Ice Highway speed
                graph[p1].append((p2, travel_time, "ice"))
                graph[p2].append((p1, travel_time, "ice"))

    # Add walking connections between all nodes
    coords = list(name_to_coord.values())
    for i in range(len(coords)):
        for j in range(i + 1, len(coords)):
            p1, p2 = coords[i], coords[j]
            distance = euclidean_distance(p1, p2)
            travel_time = distance / 3  # Walking speed (changed to 3)
            graph[p1].append((p2, travel_time, "walk"))
            graph[p2].append((p1, travel_time, "walk"))

    return graph, name_to_coord, owner_lookup, types_lookup, coord_pair_to_path

def dijkstra(graph, start, goal):
    queue = [(0, start, [])]
    seen = set()

    while queue:
        (time_so_far, node, path) = heapq.heappop(queue)
        if node in seen:
            continue
        seen.add(node)
        path = path + [(node, time_so_far)]
        if node == goal:
            return path
        for (neighbor, weight, mode) in graph.get(node, []):
            if neighbor not in seen:
                heapq.heappush(queue, (time_so_far + weight, neighbor, path + [("mode", mode)]))
    return None

def coordinates_to_names(path, coord_to_name):
    return [coord_to_name.get(coord, str(coord)) for coord in path]

def format_time(seconds):
    """Helper function to format time as mm:ss"""
    minutes = int(seconds // 60)
    secs = int(seconds % 60)
    return f"{minutes:02d}:{secs:02d}"

def view_on_map(rail_paths):
    """Generate the map URL with the rail paths - formatted for embedding"""
    if not rail_paths:
        return None
    
    # Use the embed URL format for Tableau Public
    base_url = "https://public.tableau.com/views/MinecraftRealmsAioniaMapTest/AioniaWayfinder?Show%20Trains=1&"
    
    # Join paths with commas and encode only special characters (not commas)
    paths_param = ",".join(rail_paths)
    # Use quote with safe=',' to preserve commas
    encoded_paths = urllib.parse.quote(paths_param, safe=',')
    
    # Construct the full URL with embed parameters
    full_url = f"{base_url}Path={encoded_paths}&:embed=yes&:showVizHome=no&:host_url=https%3A%2F%2Fpublic.tableau.com%2F&:embed_code_version=3&:tabs=no&:toolbar=yes&:showAppBanner=false&:display_spinner=no"
    
    return full_url

# --- Streamlit App ---

def main():
    st.set_page_config(
        page_title="Shortest Route Finder",
        page_icon="🗺️",
        layout="wide"
    )
    
    # File path configuration
    filepath = "Realms Map Dataset.xlsx"
    
    # Initialize session state
    if 'locations' not in st.session_state:
        try:
            graph, name_to_coord, owner_lookup, types_lookup, coord_pair_to_path = build_graph_from_excel(filepath)
            coord_to_name = {v: k for k, v in name_to_coord.items()}
            
            # Format locations with owner info
            locations = []
            for name in name_to_coord.keys():
                owner = owner_lookup.get(name, "")
                if owner and owner != "Public Land" and owner.lower() not in name.lower():
                    locations.append(f"{name} ({owner})")
                else:
                    locations.append(name)
            
            st.session_state.locations = sorted(locations)
            st.session_state.filepath = filepath
            
        except Exception as e:
            st.error(f"Error loading data: {e}")
            st.session_state.locations = []
    
    # Initialize route results in session state
    if 'route_results' not in st.session_state:
        st.session_state.route_results = None
    
    # Initialize map URL in session state
    if 'map_url' not in st.session_state:
        st.session_state.map_url = None
    
    # Route Planning section (above columns)
    st.subheader("Route Planning")
    
    # Origin selection
    origin = st.selectbox(
        "🏠 Origin:",
        options=[""] + st.session_state.locations,
        index=0,
        help="Select your starting location"
    )

    # Destination selection
    destination = st.selectbox(
        "🎯 Destination:",
        options=[""] + st.session_state.locations,
        index=0,
        help="Select your destination"
    )
    
    # Ice Highway toggle
    include_ice_highways = st.checkbox(
        "❄️ Include Ice Highway routes",
        help="Enable this to include faster ice highway connections in pathfinding"
    )
    
    # Find path button
    find_path = st.button("🔍 Find Shortest Path", type="primary")
    
    # Create two columns for the results layout
    left_col, right_col = st.columns([1, 1])
    
    with left_col:

        # Route Details section
        if (find_path and origin and destination) or (st.session_state.route_results and st.session_state.route_results.get('path_found')):
            st.subheader("Route Details")
            
            # If we have stored results and no new search, use stored results
            if not find_path and st.session_state.route_results and st.session_state.route_results.get('path_found'):
                # Display stored route results
                stored = st.session_state.route_results
                st.success(f"✅ Route from **{stored['origin_name']}** to **{stored['dest_name']}**!")
                
                col_time, col_dist = st.columns(2)
                with col_time:
                    st.metric("🕐 Total Time", format_time(stored['total_time']))
                with col_dist:
                    st.metric("📏 Total Distance", f"{stored['total_distance']:.0f} blocks")
                
                st.subheader("📋 Route Steps")
                for i, step in enumerate(stored['route_steps'], 1):
                    with st.expander(f"Step {i}: {step['step']}", expanded=False):
                        st.markdown(f"**Distance:** {step['distance']}")
                        st.markdown(f"**Time:** ~{step['time']}")
                
                # Map view button that updates session state
                if stored['rail_paths']:
                    if st.button("🗺️ View Train Route on Interactive Map", key="view_map_stored"):
                        st.session_state.map_url = view_on_map(stored['rail_paths'])
                        st.rerun()
            
            elif find_path:
                if origin == destination:
                    st.warning("Origin and destination cannot be the same!")
                else:
                    # Extract location names (remove owner info if present)
                    def extract_location_name(display_name):
                        if " (" in display_name and display_name.endswith(")"):
                            return display_name.split(" (")[0]
                        return display_name
                    
                    origin_name = extract_location_name(origin)
                    dest_name = extract_location_name(destination)
                    
                    try:
                        # Rebuild graph with current settings
                        graph, name_to_coord, owner_lookup, types_lookup, coord_pair_to_path = build_graph_from_excel(
                            filepath, include_ice_highways=include_ice_highways
                        )
                        coord_to_name = {v: k for k, v in name_to_coord.items()}
                        
                        # More robust location matching
                        if origin_name not in name_to_coord:
                            # Try to find a match in the actual location names
                            possible_matches = [loc for loc in name_to_coord.keys() if origin_name.lower() in loc.lower() or loc.lower() in origin_name.lower()]
                            if possible_matches:
                                origin_name = possible_matches[0]
                            else:
                                st.error(f"Could not find origin location: '{origin_name}'. Available locations: {list(name_to_coord.keys())[:5]}...")
                                return
                        
                        if dest_name not in name_to_coord:
                            # Try to find a match in the actual location names
                            possible_matches = [loc for loc in name_to_coord.keys() if dest_name.lower() in loc.lower() or loc.lower() in dest_name.lower()]
                            if possible_matches:
                                dest_name = possible_matches[0]
                            else:
                                st.error(f"Could not find destination location: '{dest_name}'. Available locations: {list(name_to_coord.keys())[:5]}...")
                                return
                        
                        start = name_to_coord[origin_name]
                        end = name_to_coord[dest_name]
                        
                        path = dijkstra(graph, start, end)
                            
                        if not path:
                                st.error(f"No path found between '{origin_name}' and '{dest_name}'.")
                                # Clear any previous route results
                                st.session_state.route_results = None
                        else:
                                total_time = 0
                                total_distance = 0
                                route_steps = []
                                rail_paths = []
                                
                                # Process each segment
                                for i in range(0, len(path) - 2, 2):
                                    if i + 2 >= len(path):
                                        break
                                    (coord, _), (_, mode) = path[i], path[i + 1]
                                    next_coord, next_time = path[i + 2]
                                    
                                    segment_time = next_time - path[i][1]
                                    speed = {"normal": 8, "ice": 72, "walk": 3}.get(mode, 1)
                                    distance = segment_time * speed
                                    total_time = next_time
                                    total_distance += distance
                                    
                                    current_name = coord_to_name.get(coord, str(coord))
                                    next_name = coord_to_name.get(next_coord, str(next_coord))
                                    next_owner = owner_lookup.get(next_name, "Unknown")
                                    
                                    # Store rail paths for map viewing
                                    if mode == "normal":
                                        path_name = coord_pair_to_path.get((coord, next_coord))
                                        if path_name:
                                            rail_paths.append(path_name)
                                    
                                    # Format step description
                                    if mode == "walk":
                                        if next_owner and next_owner != "Public Land" and next_owner.lower() not in next_name.lower():
                                            step_desc = f"🚶 Walk to **{next_name}** ({next_owner}) `({next_coord[0]},{next_coord[1]})`"
                                        else:
                                            step_desc = f"🚶 Walk to **{next_name}** `({next_coord[0]},{next_coord[1]})`"
                                    else:
                                        mode_icon = {"normal": "🚂", "ice": "🧊"}.get(mode, "🚀")
                                        mode_name = {"normal": "Rail", "ice": "Ice Highway"}.get(mode, mode.title())
                                        
                                        if next_owner and next_owner != "Public Land" and next_owner.lower() not in next_name.lower():
                                            step_desc = f"{mode_icon} {mode_name} to **{next_name}** ({next_owner})"
                                        else:
                                            step_desc = f"{mode_icon} {mode_name} to **{next_name}**"
                                    
                                    route_steps.append({
                                        'step': step_desc,
                                        'distance': f"{distance:.0f} blocks",
                                        'time': format_time(segment_time)
                                    })
                                
                                # Store route results in session state to persist across reruns
                                st.session_state.route_results = {
                                    'origin_name': origin_name,
                                    'dest_name': dest_name,
                                    'total_time': total_time,
                                    'total_distance': total_distance,
                                    'route_steps': route_steps,
                                    'rail_paths': rail_paths,
                                    'path_found': True
                                }
                                
                                # Display route summary
                                st.success(f"✅ Route found from **{origin_name}** to **{dest_name}**!")
                                
                                # Summary metrics
                                col_time, col_dist = st.columns(2)
                                with col_time:
                                    st.metric("🕐 Total Time", format_time(total_time))
                                with col_dist:
                                    st.metric("📏 Total Distance", f"{total_distance:.0f} blocks")
                                
                                # Route steps
                                st.subheader("📋 Route Steps")
                                for i, step in enumerate(route_steps, 1):
                                    with st.expander(f"Step {i}: {step['step']}", expanded=False):
                                        st.markdown(f"**Distance:** {step['distance']}")
                                        st.markdown(f"**Time:** ~{step['time']}")
                                
                                # Map view button that updates session state
                                if rail_paths:
                                    if st.button("🗺️ View Train Route on Interactive Map", key="view_map_new"):
                                        st.session_state.map_url = view_on_map(rail_paths)
                                        st.rerun()
                    
                    except Exception as e:
                        st.error(f"Error finding path: {e}")
                        # Clear any previous route results on error
                        st.session_state.route_results = None

        elif find_path:
            st.subheader("Route Details")
            st.warning("Please select both origin and destination.")
            # Clear any previous route results
            st.session_state.route_results = None

    # Right column for the map iframe
    with right_col:
        st.subheader("Interactive Map")
        
        if st.session_state.map_url:
            # Display the map in an iframe with proper Tableau embedding
            components.iframe(
                st.session_state.map_url,
                width=None,  # Use full width of the column
                height=700,
                scrolling=False
            )
            
            # Add a button to clear the map
            if st.button("❌ Clear Map", key="clear_map"):
                st.session_state.map_url = None
                st.rerun()
                
            # Fallback link in case iframe doesn't work
            st.markdown(f"[🔗 Open in full screen]({st.session_state.map_url})")
            
        else:
            st.info("🗺️ Click 'View Train Route on Interactive Map' after finding a route to display the map here.")

if __name__ == "__main__":
    main()