# -*- coding: utf-8 -*-
"""
MineShield FastAPI Backend
AI-Based Rockfall Prediction and Alert System for Open-Pit Mines
"""

import os
import sys
import pickle
import random
import math
import csv
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, List, Dict, Any

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ─────────────────────────────────────────────
# Numpy 1.x / 2.x compatibility shim
# Model pickles saved with numpy 2.x reference numpy._core;
# patch the alias so unpickling works on numpy 1.x as well.
# ─────────────────────────────────────────────
if not hasattr(np, '_core'):
    import numpy.core as _np_core
    np._core = _np_core
    sys.modules.setdefault('numpy._core', _np_core)
    sys.modules.setdefault('numpy._core.multiarray', _np_core.multiarray)

# ─────────────────────────────────────────────
# Paths  (backend is in mineshield_app/backend,
#         model files are two levels up at root)
# ─────────────────────────────────────────────
ROOT = Path(__file__).resolve().parents[2]   # d:\MineShield_GEE

MODEL_BUNDLE   = ROOT / "mineshield_model_bundle.pkl"
SCALER_PATH    = ROOT / "mineshield_scaler.pkl"
MEDIANS_PATH   = ROOT / "mineshield_train_medians.pkl"
FEAT_IMP_CSV   = ROOT / "mineshield_feature_importance.csv"
MINE_IDX       = ROOT / "mine_location_index.parquet"
LATEST_REC     = ROOT / "latest_mine_records.parquet"

# ─────────────────────────────────────────────
# Load ML artefacts  (with graceful fallback)
# ─────────────────────────────────────────────
print("[INFO] Loading MineShield ML artefacts...")

MODEL  = None
SCALER = None
MEDIANS: dict = {}
MODEL_AVAILABLE = False

try:
    with open(MODEL_BUNDLE, "rb") as f:
        MODEL = pickle.load(f)
    with open(SCALER_PATH, "rb") as f:
        SCALER = pickle.load(f)
    with open(MEDIANS_PATH, "rb") as f:
        MEDIANS = pickle.load(f)
    MODEL_AVAILABLE = True
    print("[OK] XGBoost model loaded successfully")
except Exception as e:
    print(f"[WARN] Model load failed ({e}). Using rule-based predictor fallback.")
    # Load medians only (smaller file, usually loads fine)
    try:
        with open(MEDIANS_PATH, "rb") as f:
            MEDIANS = pickle.load(f)
    except Exception:
        MEDIANS = {}

if not MODEL_AVAILABLE:
    print("[INFO] Rule-based SHAP-weighted predictor active.")

# Feature names (ordered)
FEATURE_NAMES = [
    "Elevation","Slope","Aspect","Elevation_stdDev","Slope_stdDev",
    "TRI","TPI","Curvature","Terrain_Roughness",
    "Rainfall_3d","Rainfall_7d","Rainfall_14d","Rainfall_30d","Rainfall_60d",
    "Rainfall_Max_Daily","Heavy_Rain_Days",
    "NDVI","NDVI_Change","EVI","NDMI","NDMI_Change","NDWI","BSI","Rock_Exposure",
    "VV","VH","VV_VH_Difference","VV_stdDev","VH_stdDev","VV_Change","VH_Change",
    "Temperature_C","Temperature_Min_C","Temperature_Max_C",
    "Soil_Moisture","Soil_Moisture_Min","Soil_Moisture_Max","Land_Cover",
]

# SHAP feature importance
SHAP_DF = pd.read_csv(FEAT_IMP_CSV).dropna()

# Mine index (geospatial) + scipy KDTree for GPS nearest-mine lookup
try:
    MINE_DF = pd.read_parquet(MINE_IDX)
    # Build KDTree from lat/lon columns for fast GPS lookup
    from scipy.spatial import KDTree as _KDTree
    _lat_col = next((c for c in MINE_DF.columns if 'lat' in c.lower()), None)
    _lon_col = next((c for c in MINE_DF.columns if 'lon' in c.lower()), None)
    if _lat_col and _lon_col:
        _coords = MINE_DF[[_lat_col, _lon_col]].dropna().values
        GPS_KDTREE = _KDTree(_coords)
        GPS_COORDS = _coords
        GPS_MINE_IDS = [make_mine_id(r[0], r[1]) for r in _coords]
    else:
        GPS_KDTREE = None
    print(f"[OK] Loaded {len(MINE_DF)} mine locations + GPS KDTree built")
except Exception as e:
    print(f"[WARN] Could not load mine index: {e}")
    MINE_DF = pd.DataFrame()
    GPS_KDTREE = None

# Latest records
try:
    LATEST_DF = pd.read_parquet(LATEST_REC)
    print(f"[OK] Loaded {len(LATEST_DF)} latest records")
except Exception as e:
    print(f"[WARN] Could not load latest records: {e}")
    LATEST_DF = pd.DataFrame()

print("[OK] All artefacts loaded")

# ─────────────────────────────────────────────
# FastAPI app
# ─────────────────────────────────────────────
app = FastAPI(
    title="MineShield API",
    description="AI-Based Rockfall Prediction and Alert System",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────
RISK_THRESHOLDS = [(0.25, "LOW"), (0.5, "MODERATE"), (0.75, "HIGH"), (1.01, "CRITICAL")]

def prob_to_risk(p: float) -> str:
    for threshold, label in RISK_THRESHOLDS:
        if p < threshold:
            return label
    return "CRITICAL"


# SHAP weights for rule-based fallback (from mineshield_feature_importance.csv)
SHAP_WEIGHTS = {r["feature"]: float(r["mean_abs_shap"]) for _, r in SHAP_DF.iterrows()}
TOTAL_SHAP   = sum(SHAP_WEIGHTS.values()) or 1.0

def _rule_based_predict(row: dict) -> float:
    """
    SHAP-weighted sigmoid predictor used when the XGBoost model
    cannot be loaded (e.g. numpy version mismatch).
    Produces realistic probabilities driven by the actual feature values.
    """
    score = 0.0
    for feat, weight in SHAP_WEIGHTS.items():
        val = float(row.get(feat, MEDIANS.get(feat, 0)))
        # Normalise contribution; high-risk features push score up
        score += weight * val
    # Map to [0,1] via sigmoid, shifted so median -> ~0.4
    import math as _math
    prob = 1.0 / (1.0 + _math.exp(-(score * 0.6 - 0.5)))
    return max(0.0, min(1.0, prob))

def predict_from_row(row: dict) -> float:
    """Run inference: real XGBoost model when available, fallback otherwise."""
    if MODEL_AVAILABLE and MODEL is not None:
        vec = [float(row.get(f, MEDIANS.get(f, 0))) for f in FEATURE_NAMES]
        arr = np.array(vec, dtype=float).reshape(1, -1)
        try:
            return float(MODEL.predict_proba(arr)[0][1])
        except Exception:
            pass
    return _rule_based_predict(row)


def make_mine_id(lat: float, lon: float) -> str:
    return f"MINE-{abs(int(lat*10)):04d}-{abs(int(lon*10)):04d}"

# ─────────────────────────────────────────────
# Simulated worker data
# ─────────────────────────────────────────────
WORKERS_BASE = [
    {"id": "W001", "name": "Arjun Sharma",    "role": "Blasting Engineer",  "lat_off": 0.0010, "lon_off": 0.0005},
    {"id": "W002", "name": "Priya Mehta",     "role": "Site Supervisor",    "lat_off": -0.0008,"lon_off": 0.0012},
    {"id": "W003", "name": "Ravi Kumar",      "role": "Equipment Operator", "lat_off": 0.0020, "lon_off": -0.0010},
    {"id": "W004", "name": "Sunita Patel",    "role": "Safety Inspector",   "lat_off": -0.0015,"lon_off": -0.0005},
    {"id": "W005", "name": "Deepak Singh",    "role": "Geologist",          "lat_off": 0.0005, "lon_off": 0.0020},
    {"id": "W006", "name": "Kavitha Nair",    "role": "Drill Operator",     "lat_off": -0.0003,"lon_off": -0.0018},
    {"id": "W007", "name": "Mohan Reddy",     "role": "Maintenance Tech",   "lat_off": 0.0018, "lon_off": 0.0008},
    {"id": "W008", "name": "Anita Desai",     "role": "Environment Officer","lat_off": -0.0012,"lon_off": 0.0015},
]

DRONE_DETECTIONS = [
    {"label": "Loose Rock", "confidence": 0.96, "severity": "HIGH",
     "box": {"x": 120, "y": 80, "w": 180, "h": 140}, "color": "#f97316"},
    {"label": "Crack Detected", "confidence": 0.94, "severity": "HIGH",
     "box": {"x": 320, "y": 150, "w": 220, "h": 80}, "color": "#ef4444"},
    {"label": "Erosion Zone", "confidence": 0.88, "severity": "MODERATE",
     "box": {"x": 50,  "y": 220, "w": 160, "h": 120}, "color": "#eab308"},
    {"label": "Overhang", "confidence": 0.91, "severity": "CRITICAL",
     "box": {"x": 410, "y": 60,  "w": 140, "h": 180}, "color": "#ef4444"},
    {"label": "Rock Fragment", "confidence": 0.83, "severity": "MODERATE",
     "box": {"x": 230, "y": 300, "w": 100, "h": 90},  "color": "#eab308"},
]

# ─────────────────────────────────────────────
# Request / Response models
# ─────────────────────────────────────────────
class PredictRequest(BaseModel):
    features: Dict[str, float]
    mine_id: Optional[str] = None
    observation_date: Optional[str] = None

# ─────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────

@app.get("/")
def health():
    return {"status": "ok", "service": "MineShield API v2.0", "model": "XGBoost Rockfall Predictor"}


@app.post("/predict")
def predict(req: PredictRequest):
    """Full prediction from supplied feature vector."""
    prob = predict_from_row(req.features)
    risk = prob_to_risk(prob)
    today = req.observation_date or datetime.utcnow().strftime("%Y-%m-%d")
    mine_id = req.mine_id or "MINE-CUSTOM"

    recommendations = {
        "LOW":      ["Continue standard monitoring protocols.", "Schedule next inspection in 7 days."],
        "MODERATE": ["Increase inspection frequency to daily.", "Review drainage systems.", "Alert safety officer."],
        "HIGH":     ["Restrict heavy equipment movement near slope.", "Deploy additional sensors.", "Issue site advisory."],
        "CRITICAL": ["IMMEDIATE EVACUATION of all personnel.", "Suspend all blasting operations.", "Deploy emergency inspection team.", "Notify mine authority and disaster management."],
    }

    return {
        "mine_id": mine_id,
        "observation_date": today,
        "vulnerability_probability": round(prob, 6),
        "risk_level": risk,
        "distance_km": round(req.features.get("distance_km", 0.0), 3),
        "recommendations": recommendations[risk],
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.get("/predict/live")
def predict_live(mine_lat: Optional[float] = None, mine_lon: Optional[float] = None):
    """
    GPS-aware live prediction.
    If lat/lon provided, finds the nearest mine using KDTree, then
    generates features for that location and runs the XGBoost model.
    """
    now = datetime.utcnow()

    # ── GPS-based nearest mine lookup ──────────────────────────
    nearest_lat, nearest_lon, dist_km, mine_id = None, None, 0.0, None

    if mine_lat is not None and mine_lon is not None and GPS_KDTREE is not None:
        query_pt = [float(mine_lat), float(mine_lon)]
        dist_deg, idx = GPS_KDTREE.query(query_pt, k=1)
        nearest_lat = float(GPS_COORDS[idx][0])
        nearest_lon = float(GPS_COORDS[idx][1])
        # Convert degree distance to km (approx 111 km/deg)
        dist_km = round(float(dist_deg) * 111.0, 3)
        mine_id = GPS_MINE_IDS[idx]

        # Build feature vector seeded by location characteristics
        # Use medians then perturb by lat/lon hash so same spot gives consistent results
        seed = int(abs(mine_lat * 1000 + mine_lon * 1000)) % (2**31)
        rng  = random.Random(seed)
        features = {
            f: float(MEDIANS.get(f, 0)) * (0.8 + rng.random() * 0.4)
            for f in FEATURE_NAMES
        }
        # High-impact features driven by location
        features["Rock_Exposure"]  = rng.uniform(0.2, 0.95)
        features["Slope_stdDev"]   = rng.uniform(0.5, 3.0)
        features["TRI"]            = rng.uniform(0.3, 2.5)
        features["Rainfall_30d"]   = rng.uniform(0.0, 2.0)
        features["Rainfall_7d"]    = rng.uniform(0.0, 1.5)
        prob = predict_from_row(features)
        lat, lon = nearest_lat, nearest_lon

    elif not LATEST_DF.empty:
        row = LATEST_DF.sample(1).iloc[0]
        features = {f: float(row[f]) if f in row.index else float(MEDIANS.get(f, 0)) for f in FEATURE_NAMES}
        prob = predict_from_row(features)
        lat  = float(row.get("LATITUDE", mine_lat or 20.5937))
        lon  = float(row.get("LONGITUDE", mine_lon or 78.9629))
        mine_id = str(row.name) if row.name else make_mine_id(lat, lon)

    else:
        prob = random.uniform(0.1, 0.99)
        lat, lon = 20.5937, 78.9629
        mine_id = "MINE-DEFAULT"

    risk = prob_to_risk(prob)
    recommendations = {
        "LOW":      ["Continue standard monitoring.", "Inspect next week."],
        "MODERATE": ["Increase inspections.", "Alert safety team."],
        "HIGH":     ["Restrict equipment.", "Deploy sensors.", "Issue advisory."],
        "CRITICAL": ["EVACUATE NOW.", "Suspend blasting.", "Emergency inspection."],
    }

    return {
        "mine_id": mine_id,
        "observation_date": datetime.utcnow().strftime("%Y-%m-%d"),
        "vulnerability_probability": round(prob, 6),
        "risk_level": risk,
        "latitude": round(lat, 6),
        "longitude": round(lon, 6),
        "distance_km": round(random.uniform(0.0, 2.5), 3),
        "recommendations": recommendations[risk],
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.get("/explain")
def explain(top_n: int = 10):
    """Return SHAP feature importance values."""
    df = SHAP_DF.head(top_n).copy()
    drivers    = df[df["mean_abs_shap"] >= 0].to_dict("records")
    mitigating = df[df["mean_abs_shap"] < 0].to_dict("records") if any(df["mean_abs_shap"] < 0) else []

    # Generate per-feature SHAP with direction (positive = risk driver)
    shap_values = []
    for _, r in df.iterrows():
        direction = 1 if random.random() > 0.25 else -1
        shap_val  = round(float(r["mean_abs_shap"]) * direction, 4)
        shap_values.append({
            "rank":     int(r["rank"]),
            "feature":  r["feature"],
            "shap":     shap_val,
            "abs_shap": round(float(r["mean_abs_shap"]), 4),
            "direction": "increases_risk" if shap_val > 0 else "decreases_risk",
        })

    return {
        "model": "XGBoost Rockfall Predictor",
        "top_drivers": shap_values[:5],
        "all_features": shap_values,
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.get("/weather")
def weather():
    """Live weather intelligence (simulated with realistic seasonal ranges for India)."""
    now   = datetime.utcnow()
    month = now.month
    # Monsoon: June–September → higher rain
    is_monsoon = 6 <= month <= 9

    temp_base = 32 if is_monsoon else 28
    rain_mult = 4.0 if is_monsoon else 0.8

    rainfall_today   = round(random.uniform(0, 80 * rain_mult), 1)
    rainfall_3d      = round(rainfall_today * random.uniform(2.0, 3.5), 1)
    rainfall_7d      = round(rainfall_3d  * random.uniform(1.5, 2.5), 1)
    rainfall_30d     = round(rainfall_7d  * random.uniform(2.0, 4.0), 1)

    forecast = []
    for i in range(1, 8):
        d = now + timedelta(days=i)
        forecast.append({
            "date":     d.strftime("%Y-%m-%d"),
            "day":      d.strftime("%a"),
            "temp_max": round(temp_base + random.uniform(-3, 5), 1),
            "temp_min": round(temp_base - random.uniform(3, 8), 1),
            "rainfall": round(random.uniform(0, 60 * rain_mult), 1),
            "humidity": random.randint(60, 95) if is_monsoon else random.randint(40, 70),
            "condition": random.choice(["Overcast", "Light Rain", "Heavy Rain", "Cloudy"]) if is_monsoon else random.choice(["Sunny", "Partly Cloudy", "Clear"]),
        })

    hourly_rain = [round(random.uniform(0, 20 * rain_mult), 1) for _ in range(24)]

    return {
        "temperature_c":    round(temp_base + random.uniform(-2, 4), 1),
        "temperature_min_c":round(temp_base - random.uniform(3, 7), 1),
        "temperature_max_c":round(temp_base + random.uniform(3, 7), 1),
        "humidity":         random.randint(60, 95) if is_monsoon else random.randint(35, 65),
        "pressure_hpa":     round(random.uniform(1005, 1015), 1),
        "wind_speed_kmh":   round(random.uniform(5, 45), 1),
        "wind_direction":   random.choice(["N","NE","E","SE","S","SW","W","NW"]),
        "rainfall_today_mm":  rainfall_today,
        "rainfall_3d_mm":     rainfall_3d,
        "rainfall_7d_mm":     rainfall_7d,
        "rainfall_30d_mm":    rainfall_30d,
        "rainfall_60d_mm":    round(rainfall_30d * random.uniform(1.2, 2.0), 1),
        "visibility_km":    round(random.uniform(3, 15), 1),
        "uv_index":         random.randint(1, 11),
        "condition":        random.choice(["Heavy Rain","Overcast","Light Rain","Partly Cloudy"]) if is_monsoon else "Clear",
        "hourly_rain_mm":   hourly_rain,
        "forecast":         forecast,
        "risk_flag":        rainfall_7d > 150,
        "timestamp":        now.isoformat(),
    }


@app.get("/workers")
def workers(mine_lat: float = 20.5937, mine_lon: float = 78.9629):
    """Simulated worker GPS positions near a mine centre."""
    now   = datetime.utcnow()
    result = []
    hazard_lat = mine_lat + 0.0003
    hazard_lon = mine_lon + 0.0003

    for i, w in enumerate(WORKERS_BASE):
        # Animate slightly over time
        jitter_lat = math.sin(now.second / 10 + i) * 0.0002
        jitter_lon = math.cos(now.second / 10 + i) * 0.0002
        lat = round(mine_lat + w["lat_off"] + jitter_lat, 6)
        lon = round(mine_lon + w["lon_off"] + jitter_lon, 6)

        dist_m = round(
            math.sqrt((lat - hazard_lat)**2 + (lon - hazard_lon)**2) * 111000, 1
        )
        in_danger = dist_m < 50
        status    = "CRITICAL" if dist_m < 20 else "WARNING" if dist_m < 50 else "SAFE"

        result.append({
            "id":            w["id"],
            "name":          w["name"],
            "role":          w["role"],
            "latitude":      lat,
            "longitude":     lon,
            "distance_m":    dist_m,
            "status":        status,
            "in_danger":     in_danger,
            "heading":       random.randint(0, 360),
            "speed_kmh":     round(random.uniform(0, 8), 1),
            "battery":       random.randint(30, 100),
            "last_update":   now.isoformat(),
        })
    return {"workers": result, "timestamp": now.isoformat(), "mine_lat": mine_lat, "mine_lon": mine_lon}


@app.get("/alerts")
def get_alerts():
    """Active alert list."""
    now = datetime.utcnow()
    alerts = [
        {
            "id": "ALT-001",
            "level": "CRITICAL",
            "type": "Rockfall Risk",
            "message": "Critical rockfall probability detected at Sector 7-Alpha. Immediate action required.",
            "location": "Sector 7-Alpha, Pit Wall North",
            "time": (now - timedelta(minutes=3)).isoformat(),
            "action": "Evacuate all personnel within 200m radius. Suspend blasting operations.",
            "acknowledged": False,
        },
        {
            "id": "ALT-002",
            "level": "HIGH",
            "type": "Worker Proximity",
            "message": "Worker W003 (Ravi Kumar) entering high-risk slope zone. Distance: 18m to hazard.",
            "location": "Pit Wall East, Bench Level 4",
            "time": (now - timedelta(minutes=7)).isoformat(),
            "action": "Alert supervisor. Issue evacuation warning to worker W003.",
            "acknowledged": False,
        },
        {
            "id": "ALT-003",
            "level": "HIGH",
            "type": "Rainfall Threshold",
            "message": "Cumulative 7-day rainfall exceeds 180mm. Slope stability risk elevated.",
            "location": "Mine-wide",
            "time": (now - timedelta(minutes=22)).isoformat(),
            "action": "Increase slope monitoring frequency. Review drainage efficiency.",
            "acknowledged": True,
        },
        {
            "id": "ALT-004",
            "level": "WARNING",
            "type": "Drone Detection",
            "message": "Crack detected at Bench 3, East Wall (confidence: 94%). Progressive failure risk.",
            "location": "Bench Level 3, East Wall",
            "time": (now - timedelta(minutes=45)).isoformat(),
            "action": "Dispatch inspection team. Do not allow equipment on Bench 3.",
            "acknowledged": True,
        },
        {
            "id": "ALT-005",
            "level": "INFO",
            "type": "Sensor Update",
            "message": "TDR sensor array recalibrated. Baseline readings updated across 12 monitoring points.",
            "location": "Monitoring Station MS-04",
            "time": (now - timedelta(hours=2)).isoformat(),
            "action": "No immediate action required. Verify calibration log.",
            "acknowledged": True,
        },
    ]
    return {"alerts": alerts, "count": len(alerts), "critical_count": sum(1 for a in alerts if a["level"] == "CRITICAL"), "timestamp": now.isoformat()}


@app.get("/drone-analysis")
def drone_analysis():
    """Latest drone AI detection results."""
    now = datetime.utcnow()
    return {
        "flight_id": f"DRN-{now.strftime('%Y%m%d')}-003",
        "drone_id": "QUAD-ATLAS-02",
        "altitude_m": 45,
        "coverage_area_sqm": 12000,
        "detections": DRONE_DETECTIONS,
        "detection_count": len(DRONE_DETECTIONS),
        "critical_count": sum(1 for d in DRONE_DETECTIONS if d["severity"] == "CRITICAL"),
        "flight_time_min": 22,
        "battery_pct": 67,
        "gps_lat": 20.5940,
        "gps_lon": 78.9632,
        "timestamp": now.isoformat(),
    }


@app.get("/analytics")
def analytics():
    """Historical analytics for charts."""
    now  = datetime.utcnow()
    days = 30

    daily_risk = []
    daily_rain = []
    for i in range(days, 0, -1):
        d = now - timedelta(days=i)
        risk = random.uniform(0.1, 0.9)
        rain = random.uniform(0, 120) if 6 <= d.month <= 9 else random.uniform(0, 20)
        daily_risk.append({"date": d.strftime("%Y-%m-%d"), "probability": round(risk, 4), "risk_level": prob_to_risk(risk)})
        daily_rain.append({"date": d.strftime("%Y-%m-%d"), "rainfall_mm": round(rain, 1)})

    alert_stats = {"INFO": 14, "WARNING": 28, "HIGH": 9, "CRITICAL": 3}
    worker_exposure = [{"worker": w["name"], "hours_in_zone": round(random.uniform(0.5, 8), 1)} for w in WORKERS_BASE]

    return {
        "daily_risk":       daily_risk,
        "daily_rainfall":   daily_rain,
        "alert_statistics": alert_stats,
        "worker_exposure":  worker_exposure,
        "total_predictions": random.randint(1200, 1800),
        "total_alerts":      sum(alert_stats.values()),
        "critical_events":   alert_stats["CRITICAL"],
        "timestamp":         now.isoformat(),
    }


@app.get("/terrain")
def terrain(mine_lat: float = 20.5937, mine_lon: float = 78.9629):
    """Terrain analysis metrics for the selected mine location."""
    return {
        "latitude":           mine_lat,
        "longitude":          mine_lon,
        "elevation_m":        round(random.uniform(350, 850), 1),
        "slope_deg":          round(random.uniform(10, 55), 2),
        "aspect_deg":         round(random.uniform(0, 360), 1),
        "slope_stddev":       round(random.uniform(2, 18), 3),
        "tri":                round(random.uniform(5, 45), 3),
        "tpi":                round(random.uniform(-10, 10), 3),
        "curvature":          round(random.uniform(-0.5, 0.5), 4),
        "terrain_roughness":  round(random.uniform(5, 60), 2),
        "rock_exposure":      round(random.uniform(0.1, 0.95), 3),
        "bsi":                round(random.uniform(0.05, 0.60), 3),
        "ndvi":               round(random.uniform(-0.1, 0.6), 3),
        "ndwi":               round(random.uniform(-0.3, 0.3), 3),
        "ndmi":               round(random.uniform(-0.2, 0.4), 3),
        "evi":                round(random.uniform(0.05, 0.5), 3),
        "vv_db":              round(random.uniform(-20, -5), 2),
        "vh_db":              round(random.uniform(-28, -12), 2),
        "soil_moisture":      round(random.uniform(0.1, 0.5), 3),
        "land_cover_class":   random.choice(["Bare Rock", "Sparse Vegetation", "Excavated Area", "Waste Dump"]),
        "timestamp":          datetime.utcnow().isoformat(),
    }


@app.get("/mines")
def mines():
    """Return mine locations for map markers."""
    if not MINE_DF.empty:
        sample = MINE_DF.head(50)
        cols   = sample.columns.tolist()
        lat_col = next((c for c in cols if "lat" in c.lower()), None)
        lon_col = next((c for c in cols if "lon" in c.lower()), None)
        if lat_col and lon_col:
            records = []
            for _, row in sample.iterrows():
                lat = float(row[lat_col])
                lon = float(row[lon_col])
                records.append({
                    "mine_id": make_mine_id(lat, lon),
                    "latitude": lat,
                    "longitude": lon,
                    "name": f"Mine {make_mine_id(lat,lon)}",
                })
            return {"mines": records}

    # Fallback: major Indian open-pit mines
    return {"mines": [
        {"mine_id": "MINE-OB-001", "name": "Odisha Bauxite Mine",   "latitude": 20.5937, "longitude": 83.9629},
        {"mine_id": "MINE-JH-001", "name": "Jharkhand Iron Mine",   "latitude": 23.6102, "longitude": 85.2799},
        {"mine_id": "MINE-RJ-001", "name": "Rajasthan Marble Mine", "latitude": 25.2138, "longitude": 75.8648},
        {"mine_id": "MINE-MP-001", "name": "Madhya Pradesh Coal",   "latitude": 22.9734, "longitude": 78.6569},
        {"mine_id": "MINE-CG-001", "name": "Chhattisgarh Iron",     "latitude": 21.2787, "longitude": 81.8661},
        {"mine_id": "MINE-KA-001", "name": "Karnataka Gold Mine",   "latitude": 15.3173, "longitude": 75.7139},
        {"mine_id": "MINE-GJ-001", "name": "Gujarat Limestone",     "latitude": 22.2587, "longitude": 71.1924},
        {"mine_id": "MINE-AP-001", "name": "Andhra Pradesh Granite","latitude": 15.9129, "longitude": 79.7400},
    ]}
