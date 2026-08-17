"""Generate a small demo latest_mine_records.parquet for local testing.
Run in the project root inside a Python 3.11 venv:

python demo/generate_demo_parquet.py

This will create `latest_mine_records.parquet` in the project root.
"""
import pandas as pd
from pathlib import Path
import random
from datetime import datetime

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'latest_mine_records.parquet'

FEATURES = [
    'LATITUDE','LONGITUDE','Elevation','Slope','TRI','Rock_Exposure','Rainfall_7d','Slope_stdDev'
]

rows = []
for i in range(20):
    lat = 20.5 + random.uniform(-0.5, 0.5)
    lon = 78.9 + random.uniform(-0.5, 0.5)
    row = {
        'LATITUDE': lat,
        'LONGITUDE': lon,
        'Elevation': random.uniform(200, 900),
        'Slope': random.uniform(5, 60),
        'TRI': random.uniform(0.1, 3.0),
        'Rock_Exposure': random.uniform(0.1, 0.95),
        'Rainfall_7d': random.uniform(0, 300),
        'Slope_stdDev': random.uniform(0.1, 6.0),
        'timestamp': datetime.utcnow().isoformat(),
    }
    rows.append(row)

df = pd.DataFrame(rows)
print('Writing', OUT)
df.to_parquet(OUT)
print('Done')
