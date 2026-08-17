"""Central configuration for mine locations.
Provides a single source of truth for the list of mines used
by the `/mines` endpoint and any other components.
"""

from typing import List, Dict

# List of mines with realistic Indian mining locations.
MINES: List[Dict[str, any]] = [
    {"mine_id": "MINE-OB-001", "name": "Odisha Bauxite Mine — Sector 7", "latitude": 20.5937, "longitude": 83.9629},
    {"mine_id": "MINE-JH-001", "name": "Jharkhand Iron & Steel Mine — Pit A", "latitude": 23.6102, "longitude": 85.2799},
    {"mine_id": "MINE-RJ-001", "name": "Rajasthan Marble Mine — Quarry 4", "latitude": 25.2138, "longitude": 75.8648},
    {"mine_id": "MINE-MP-001", "name": "Madhya Pradesh Coal Mine — Block 4", "latitude": 22.9734, "longitude": 78.6569},
    {"mine_id": "MINE-CG-001", "name": "Chhattisgarh Iron Mine — West Pit", "latitude": 21.2787, "longitude": 81.8661},
    {"mine_id": "MINE-KA-001", "name": "Karnataka Gold Mine — South Ridge", "latitude": 15.3173, "longitude": 75.7139},
    {"mine_id": "MINE-GJ-001", "name": "Gujarat Limestone Mine — North Quarry", "latitude": 22.2587, "longitude": 71.1924},
    {"mine_id": "MINE-AP-001", "name": "Andhra Pradesh Granite Mine — Kurnool", "latitude": 15.9129, "longitude": 79.7400},
    {"mine_id": "MINE-TN-001", "name": "Tamil Nadu Chromite Mine — Salem Belt", "latitude": 11.1271, "longitude": 78.6569},
    {"mine_id": "MINE-WB-001", "name": "West Bengal Copper Mine — Raniganj", "latitude": 23.5, "longitude": 87.12},
    {"mine_id": "MINE-ML-001", "name": "Meghalaya Coal Mine — Khasi Hills", "latitude": 25.467, "longitude": 91.3662},
    {"mine_id": "MINE-HR-001", "name": "Haryana Sand Mine — Industrial Zone", "latitude": 28.6139, "longitude": 77.209},
    {"mine_id": "MINE-OR-001", "name": "Odisha Iron Ore Mine — Keonjhar", "latitude": 21.6289, "longitude": 85.5815},
    {"mine_id": "MINE-MH-001", "name": "Maharashtra Limestone Mine — Satara", "latitude": 17.68, "longitude": 74.0183},
]


def list_mines() -> List[Dict[str, any]]:
    """Return a shallow copy of the mine list.
    Using a copy prevents accidental mutation of the global constant
    by callers.
    """
    return list(MINES)
