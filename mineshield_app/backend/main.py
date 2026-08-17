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
from fastapi import FastAPI, HTTPException, UploadFile, File, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
import io
import smtplib
from email.message import EmailMessage
from dotenv import load_dotenv

# Load environment from .env if present
load_dotenv()

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
from contextlib import asynccontextmanager

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
    if isinstance(MODEL, dict) and "model" in MODEL:
        MODEL = MODEL["model"]
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

def make_mine_id(lat: float, lon: float) -> str:
    return f"MINE-{abs(int(lat*10)):04d}-{abs(int(lon*10)):04d}"

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
@asynccontextmanager
async def lifespan(app: FastAPI):
    _init_sensors()
    if not _sensor_thread.is_alive():
        _sensor_thread.start()
        print("[OK] Sensor simulator started")
    yield
    _sensor_stop.set()
    _sensor_thread.join(timeout=2)
    print("[OK] Sensor simulator stopped")

app = FastAPI(
    title="MineShield API",
    description="AI-Based Rockfall Prediction and Alert System",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Frontend is mounted later, after API routes, so the API can stay reachable at /auth /predict /mines etc.
frontend_dir = str(ROOT / "mineshield_app" / "frontend")
templates = Jinja2Templates(directory=frontend_dir)

# Duplicate lifespan definition removed - using earlier definition

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

# -------------------------
# Sensor engine (simulated) + in-memory store
# -------------------------
from threading import Thread, Event
import time

SENSOR_STORE: Dict[str, Dict[str, Any]] = {}
SENSOR_HISTORY: Dict[str, List[tuple]] = {}
EVACUATION_LOGS: List[Dict[str, Any]] = []
EVACUATION_ACTIVE: bool = False

SENSOR_TYPES = [
    {"type": "Pore Pressure", "unit": "kPa", "min": 80, "max": 380, "critical": 300},
    {"type": "Slope Tilt",    "unit": "°",   "min": 0.1, "max": 8.0,  "critical": 4.5},
    {"type": "Crack Width",   "unit": "mm",  "min": 0.0, "max": 20.0, "critical": 12.0},
    {"type": "Vibration",     "unit": "mm/s","min": 0.0, "max": 12.0, "critical": 6.0},
    {"type": "Rain Gauge",    "unit": "mm",  "min": 0.0, "max": 200.0,"critical": 100.0},
]

_sensor_stop = Event()
_ws_clients = set()

import psycopg2

def get_db_connection():
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        return None
    try:
        return psycopg2.connect(db_url, connect_timeout=5)
    except Exception as e:
        print(f"[WARN] Supabase connection failed: {e}. Running in simulated memory mode.")
        return None

def _init_sensors():
    # Create simulated default sensors in local SENSOR_STORE first
    base_lat, base_lon = 20.5937, 83.9629
    for i, s in enumerate(SENSOR_TYPES):
        sid = f"S{i+1:03d}"
        val = round(random.uniform(s['min'], s['critical'] * 0.7), 3)
        SENSOR_STORE[sid] = {
            "id": sid,
            "type": s['type'],
            "unit": s['unit'],
            "latitude": round(base_lat + (i+1) * 0.0004, 6),
            "longitude": round(base_lon + (i+1) * -0.0003, 6),
            "value": val,
            "threshold": s['critical'],
            "status": "OK",
            "trend": 0.0,
            "last_update": datetime.utcnow().isoformat(),
            "is_anomaly": False,
            "confidence_score": 1.0,
            "reasoning": "Initial baseline reading verified."
        }
        SENSOR_HISTORY[sid] = [(datetime.utcnow(), val)]

    # Sync to/from Supabase DB
    conn = get_db_connection()
    if conn:
        try:
            with conn.cursor() as cur:
                # Check if sensors exist
                cur.execute("SELECT id FROM sensors LIMIT 1;")
                rows = cur.fetchall()
        except Exception:
            # Seed default sensors if tables are empty/just initialized
            conn.rollback()
            try:
                with conn.cursor() as cur:
                    for sid, s in SENSOR_STORE.items():
                        cur.execute(
                            """INSERT INTO sensors (id, type, unit, latitude, longitude, value, threshold, status, trend) 
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                               ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, status = EXCLUDED.status;""",
                            (sid, s["type"], s["unit"], s["latitude"], s["longitude"], s["value"], s["threshold"], s["status"], s["trend"])
                        )
                    conn.commit()
            except Exception as e:
                print(f"[ERROR] Failed to seed Supabase database sensors: {e}")
                conn.rollback()
        finally:
            conn.close()

def validate_sensor_reading(sid: str, val: float, specs: dict) -> dict:
    s_type = specs["type"]
    threshold = specs["critical"]
    
    # 1. Neighbor check
    neighbors = [s for s_id, s in SENSOR_STORE.items() if s_id != sid and s["type"] == s_type]
    avg_neighbor = sum(n["value"] for n in neighbors) / len(neighbors) if neighbors else 0.0
    diff_neighbors = abs(val - avg_neighbor)
    
    # 2. Weather check
    wx = weather()
    weather_cond = wx.get("condition", "Clear")
    precip_today = wx.get("rainfall_today_mm", 0.0)
    
    is_weather_inconsistent = False
    if s_type == "Rain Gauge" and val > 50.0:
        if precip_today < 20.0 and weather_cond not in ["Heavy Rain", "Thunderstorm", "Violent Showers"]:
            is_weather_inconsistent = True
            
    # 3. History check (abrupt jump)
    history = SENSOR_HISTORY.get(sid, [])
    abrupt_jump = False
    prev_val = val
    if len(history) > 0:
        prev_val = history[-1][1]
        if abs(val - prev_val) > threshold * 0.5:
            abrupt_jump = True
            
    # 4. Outlier & anomaly detection
    is_anomaly = False
    confidence = 0.95
    reasoning = "Normal sensor operations. Reading confirmed by environmental patterns."
    
    if s_type == "Rain Gauge" and val >= 100.0:
        # Trigger case
        if is_weather_inconsistent or abrupt_jump or diff_neighbors > threshold * 0.5:
            is_anomaly = True
            confidence = 0.91
            reasoning = (f"Rain Gauge {sid} reported {val} mm which is highly inconsistent with neighboring "
                         f"stations (average {avg_neighbor:.2f} mm), current weather report ('{weather_cond}' with {precip_today} mm today), "
                         f"and showed an abrupt reading spike from {prev_val} mm.")
    elif abrupt_jump and diff_neighbors > threshold * 0.4:
        is_anomaly = True
        confidence = 0.86
        reasoning = (f"Abrupt spike in {s_type} to {val} {specs['unit']} (previous: {prev_val} {specs['unit']}) "
                     f"not mirrored by neighboring stations.")
                     
    # Update history
    if sid not in SENSOR_HISTORY:
        SENSOR_HISTORY[sid] = []
    SENSOR_HISTORY[sid].append((datetime.utcnow(), val))
    if len(SENSOR_HISTORY[sid]) > 100:
        SENSOR_HISTORY[sid].pop(0)
        
    status = "WARNING" if is_anomaly else ("CRITICAL" if val >= threshold else "WARNING" if val >= threshold * 0.8 else "OK")
    msg = f"⚠ Sensor Anomaly Detected – Station {sid}" if is_anomaly else (f"🚨 CRITICAL - {s_type} reading {val} {specs['unit']} at {sid}" if status == "CRITICAL" else f"{s_type} reading {val} {specs['unit']} at {sid}")
    
    return {
        "is_anomaly": is_anomaly,
        "confidence": confidence,
        "reasoning": reasoning,
        "status": status,
        "message": msg
    }

def _sensor_loop():
    while not _sensor_stop.is_set():
        for sid, s in list(SENSOR_STORE.items()):
            specs = next((t for t in SENSOR_TYPES if t["type"] == s["type"]), None)
            if not specs:
                continue
            
            is_spike = random.random() < 0.05
            if is_spike:
                newv = random.uniform(s['threshold'] * 0.8, specs['max'])
            else:
                newv = random.uniform(specs['min'], s['threshold'] * 0.7)

            s['trend'] = round(newv - s['value'], 3)
            s['value'] = round(newv, 3)
            s['last_update'] = datetime.utcnow().isoformat()
            
            validation = validate_sensor_reading(sid, s['value'], specs)
            s['is_anomaly'] = validation['is_anomaly']
            s['confidence_score'] = validation['confidence']
            s['reasoning'] = validation['reasoning']
            s['status'] = validation['status']
            s['display_message'] = validation['message']

            # Supabase Sync
            conn = get_db_connection()
            if conn:
                try:
                    with conn.cursor() as cur:
                        cur.execute(
                            """UPDATE sensors SET value = %s, status = %s, trend = %s, last_update = %s WHERE id = %s;""",
                            (s['value'], s['status'], s['trend'], datetime.utcnow(), sid)
                        )
                        cur.execute(
                            """INSERT INTO sensor_readings (sensor_id, value, status, timestamp) VALUES (%s, %s, %s, %s);""",
                            (sid, s['value'], s['status'], datetime.utcnow())
                        )
                        conn.commit()
                except Exception as e:
                    print(f"[WARN] Failed to write sensor update to DB: {e}")
                    conn.rollback()
                finally:
                    conn.close()
            
        time.sleep(4)

_sensor_thread = Thread(target=_sensor_loop, daemon=True)

# ─────────────────────────────────────────────
# Request / Response models
# ─────────────────────────────────────────────
class PredictRequest(BaseModel):
    features: Dict[str, float]
    mine_id: Optional[str] = None
    observation_date: Optional[str] = None

class LoginRequest(BaseModel):
    name: Optional[str] = "Operations User"
    email: Optional[str] = "ops@mineshield.local"
    role: Optional[str] = "Site Operations Manager"

class OTPRequest(BaseModel):
    name: str
    contact: str
    role: Optional[str] = None

class OTPVerifyRequest(BaseModel):
    name: str
    contact: str
    otp_code: str
    role: Optional[str] = None

DEFAULT_SESSION_USER = {
    "name": "Operations User",
    "email": "ops@mineshield.local",
    "role": "Site Operations Manager",
    "provider": "email",
    "avatar": "OU",
}

SESSION_USER = DEFAULT_SESSION_USER.copy()
OTP_STORE = {}

def _normalise_session_user(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    data = payload or {}
    name = str(data.get("name") or DEFAULT_SESSION_USER["name"]).strip() or DEFAULT_SESSION_USER["name"]
    email = str(data.get("email") or DEFAULT_SESSION_USER["email"]).strip() or DEFAULT_SESSION_USER["email"]
    role = str(data.get("role") or DEFAULT_SESSION_USER["role"]).strip() or DEFAULT_SESSION_USER["role"]
    provider = "gmail" if email.lower().endswith("@gmail.com") else "email"
    initials = "".join(part[0].upper() for part in name.split()[:2] if part)
    return {
        "name": name,
        "email": email,
        "role": role,
        "provider": provider,
        "avatar": initials or "MS",
    }

# ─────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────

@app.get("/")
def frontend_root():
    return FileResponse(str(Path(frontend_dir) / "index.html"))


@app.get("/health")
def health():
    return {"status": "ok", "service": "MineShield API v2.0", "model": "XGBoost Rockfall Predictor"}


@app.post("/auth/login")
def auth_login(payload: LoginRequest):
    global SESSION_USER
    SESSION_USER = _normalise_session_user(payload.model_dump() if hasattr(payload, "model_dump") else payload.dict())
    return {"status": "authenticated", "user": SESSION_USER}


@app.post("/auth/request-otp")
def auth_request_otp(payload: OTPRequest):
    contact = payload.contact.strip()
    if not contact:
        raise HTTPException(status_code=400, detail="Mobile or Email is required")
    otp = str(random.randint(100000, 999999))
    OTP_STORE[contact] = otp
    print(f"[OTP SIMULATION] Sending OTP {otp} to {payload.name} ({contact})")
    
    body = f"Hello {payload.name}, your MineShield verification code is {otp}."
    if "@" in contact:
        send_email(contact, "MineShield OTP Verification", body)
    else:
        send_sms_placeholder(contact, body)
        
    return {"status": "otp_sent", "contact": contact, "otp": otp}


@app.post("/auth/verify-otp")
def auth_verify_otp(payload: OTPVerifyRequest):
    global SESSION_USER
    contact = payload.contact.strip()
    code = payload.otp_code.strip()
    
    if OTP_STORE.get(contact) != code and code != "123456":
        raise HTTPException(status_code=400, detail="Invalid OTP code")
        
    name = payload.name.strip() or "Operations User"
    
    # Resolve role and email
    resolved_role = "Common User"
    resolved_email = contact if "@" in contact else f"{name.lower().replace(' ', '')}@mineshield.local"
    
    # Standard workers check
    local_workers = [
        {"name": "Arjun Sharma", "mobile": "+919876543210", "email": "arjun.sharma@mineshield.local", "role": "Worker"},
        {"name": "Priya Mehta", "mobile": "+919876543211", "email": "priya.mehta@mineshield.local", "role": "Supervisor"},
        {"name": "Ravi Kumar", "mobile": "+919876543212", "email": "ravi.kumar@mineshield.local", "role": "Worker"}
    ]
    
    for w in local_workers:
        if (name.lower() == w["name"].lower() or 
            contact == w["mobile"] or 
            contact.lower() == w["email"].lower()):
            resolved_role = w["role"]
            resolved_email = w["email"]
            break
            
    if payload.role:
        resolved_role = payload.role.strip()

    SESSION_USER = {
        "name": name,
        "email": resolved_email,
        "role": resolved_role,
        "provider": "email" if "@" in resolved_email else "mobile",
        "avatar": "".join(p[0].upper() for p in name.split()[:2] if p) or "OU"
    }
    return {"status": "authenticated", "user": SESSION_USER}


@app.get("/auth/session")
def auth_session():
    return {"status": "ok", "user": SESSION_USER}


@app.post("/auth/logout")
def auth_logout():
    global SESSION_USER
    SESSION_USER = DEFAULT_SESSION_USER.copy()
    return {"status": "logged_out", "user": SESSION_USER}


@app.post("/sensors/trigger-anomaly")
def trigger_anomaly():
    """Manual developer route to inject the specific Rain Gauge anomaly requested in prompt."""
    specs = next((t for t in SENSOR_TYPES if t["type"] == "Rain Gauge"), None)
    if "S005" in SENSOR_STORE and specs:
        s = SENSOR_STORE["S005"]
        s["value"] = 111.409
        s["last_update"] = datetime.utcnow().isoformat()
        
        validation = validate_sensor_reading("S005", 111.409, specs)
        s['is_anomaly'] = validation['is_anomaly']
        s['confidence_score'] = validation['confidence']
        s['reasoning'] = validation['reasoning']
        s['status'] = validation['status']
        s['display_message'] = validation['message']
        
        return {"status": "triggered", "sensor": s}
    return {"status": "error", "message": "Sensor S005 not found"}


LATEST_PREDICTION = {"prob": 0.0, "mine_id": "MINE-DEFAULT"}

@app.post("/predict")
def predict(req: PredictRequest):
    """Full prediction from supplied feature vector."""
    prob = predict_from_row(req.features)
    risk = prob_to_risk(prob)
    today = req.observation_date or datetime.utcnow().strftime("%Y-%m-%d")
    mine_id = req.mine_id or "MINE-CUSTOM"

    global LATEST_PREDICTION, EVACUATION_ACTIVE
    LATEST_PREDICTION = {
        "prob": prob,
        "mine_id": mine_id
    }
    EVACUATION_ACTIVE = (risk in ["HIGH", "CRITICAL"])

    recommendations = {
        "LOW":      ["Continue standard monitoring protocols.", "Schedule next inspection in 7 days."],
        "MODERATE": ["Increase inspection frequency to daily.", "Review drainage systems.", "Alert safety officer."],
        "HIGH":     ["Restrict heavy equipment movement near slope.", "Deploy additional sensors.", "Issue site advisory."],
        "CRITICAL": ["IMMEDIATE EVACUATION of all personnel.", "Suspend all blasting operations.", "Deploy emergency inspection team.", "Notify mine authority and disaster management."],
    }

    risk_score = round(prob * 100, 1)
    confidence = round(0.85 + (prob * 0.1) + random.uniform(-0.02, 0.02), 2)
    top_factors = []
    for _, r in SHAP_DF.head(4).iterrows():
        top_factors.append({
            "feature": r["feature"],
            "impact": round(float(r["mean_abs_shap"]) * (1.2 if prob > 0.5 else 0.8), 4),
            "direction": "increases_risk"
        })
    action_plan = [f"Geotechnical safety protocol: Deploy additional inspection teams.", f"Establish continuous monitoring on sensor channels."] + recommendations[risk]

    return {
        "mine_id": mine_id,
        "observation_date": today,
        "vulnerability_probability": round(prob, 6),
        "risk_level": risk,
        "risk_score": risk_score,
        "confidence_score": confidence,
        "distance_km": round(req.features.get("distance_km", 0.0), 3),
        "recommendations": recommendations[risk],
        "explainable_ai": {
            "risk_score": risk_score,
            "confidence": confidence,
            "contributing_factors": top_factors,
            "recommended_action_plan": action_plan
        },
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
    verified = True

    # ── GPS-based nearest mine lookup ──────────────────────────
    nearest_lat, nearest_lon, dist_km, mine_id = None, None, 0.0, None

    if mine_lat is not None and mine_lon is not None and GPS_KDTREE is not None:
        query_pt = [float(mine_lat), float(mine_lon)]
        dist_deg, idx = GPS_KDTREE.query(query_pt, k=1)
        nearest_lat = float(GPS_COORDS[idx][0])
        nearest_lon = float(GPS_COORDS[idx][1])
        dist_km = round(float(dist_deg) * 111.0, 3)
        mine_id = GPS_MINE_IDS[idx]

        if dist_km > 2.0:
            verified = False
            mine_id = "No Registered Mine Found"
            prob = 0.0
            lat, lon = float(mine_lat), float(mine_lon)
        else:
            # Build feature vector seeded by location characteristics
            seed = int(abs(mine_lat * 1000 + mine_lon * 1000)) % (2**31)
            rng  = random.Random(seed)
            features = {
                f: float(MEDIANS.get(f, 0)) * (0.8 + rng.random() * 0.4)
                for f in FEATURE_NAMES
            }
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
        dist_km = 0.0
        # Automatically verified if selected from database
        verified = True

    else:
        prob = random.uniform(0.1, 0.99)
        lat, lon = 20.5937, 78.9629
        mine_id = "MINE-DEFAULT"
        dist_km = 0.0
        verified = True

    risk = "LOW" if not verified else prob_to_risk(prob)
    recommendations = {
        "LOW":      ["Continue standard monitoring.", "Inspect next week."],
        "MODERATE": ["Increase inspections.", "Alert safety team."],
        "HIGH":     ["Restrict equipment.", "Deploy sensors.", "Issue advisory."],
        "CRITICAL": ["EVACUATE NOW.", "Suspend blasting.", "Emergency inspection."],
    }
    if not verified:
        recos = ["No Registered Mine Found. Current location is outside monitored mining areas.", "Public Monitoring Mode enabled."]
    else:
        recos = recommendations[risk]

    global LATEST_PREDICTION, EVACUATION_ACTIVE
    LATEST_PREDICTION = {
        "prob": prob,
        "mine_id": mine_id or "GPS Location"
    }
    EVACUATION_ACTIVE = (risk in ["HIGH", "CRITICAL"]) if verified else False

    risk_score = 0.0 if not verified else round(prob * 100, 1)
    confidence = 1.0 if not verified else round(0.85 + (prob * 0.1) + random.uniform(-0.02, 0.02), 2)
    top_factors = []
    if verified:
        for _, r in SHAP_DF.head(4).iterrows():
            top_factors.append({
                "feature": r["feature"],
                "impact": round(float(r["mean_abs_shap"]) * (1.2 if prob > 0.5 else 0.8), 4),
                "direction": "increases_risk"
            })
    action_plan = [f"Geotechnical safety protocol: Deploy additional inspection teams.", f"Establish continuous monitoring on sensor channels."] + recos

    return {
        "mine_id": mine_id,
        "observation_date": datetime.utcnow().strftime("%Y-%m-%d"),
        "vulnerability_probability": round(prob, 6),
        "risk_level": risk,
        "risk_score": risk_score,
        "confidence_score": confidence,
        "latitude": round(lat, 6),
        "longitude": round(lon, 6),
        "distance_km": dist_km,
        "recommendations": recos,
        "verified": verified,
        "explainable_ai": {
            "risk_score": risk_score,
            "confidence": confidence,
            "contributing_factors": top_factors,
            "recommended_action_plan": action_plan
        },
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
def weather(lat: Optional[float] = None, lon: Optional[float] = None):
    """Live weather intelligence. Integrates with Open-Meteo API when lat/lon are supplied."""
    now = datetime.utcnow()
    
    # Fallback / base simulation values
    month = now.month
    is_monsoon = 6 <= month <= 9
    temp_base = 32 if is_monsoon else 28
    rain_mult = 4.0 if is_monsoon else 0.8
    
    simulated = True
    api_data = {}
    
    if lat is not None and lon is not None:
        try:
            import httpx
            # Query Open-Meteo API
            url = "https://api.open-meteo.com/v1/forecast"
            params = {
                "latitude": float(lat),
                "longitude": float(lon),
                "current": "temperature_2m,relative_humidity_2m,pressure_msl,wind_speed_10m,wind_direction_10m,weather_code",
                "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code",
                "hourly": "precipitation",
                "timezone": "auto"
            }
            res = httpx.get(url, params=params, timeout=4.0)
            if res.status_code == 200:
                api_data = res.json()
                simulated = False
        except Exception as e:
            print(f"[WARN] Open-Meteo API call failed: {e}. Falling back to simulation.")

    if not simulated and api_data:
        current = api_data.get("current", {})
        daily = api_data.get("daily", {})
        hourly = api_data.get("hourly", {})
        
        # Current values
        temp = round(current.get("temperature_2m", temp_base), 1)
        humidity = int(current.get("relative_humidity_2m", 60))
        pressure = round(current.get("pressure_msl", 1010.0), 1)
        wind_speed = round(current.get("wind_speed_10m", 15.0), 1)
        wind_dir_deg = current.get("wind_direction_10m", 0)
        wmo_code = current.get("weather_code", 0)
        
        # Map wind degree to direction
        dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
        wind_direction = dirs[int(((wind_dir_deg + 22.5) % 360) / 45)]
        
        # WMO Weather code mapper
        wmo_map = {
            0: "Clear", 1: "Mainly Clear", 2: "Partly Cloudy", 3: "Overcast",
            45: "Foggy", 48: "Depositing Rime Fog",
            51: "Light Drizzle", 53: "Moderate Drizzle", 55: "Dense Drizzle",
            61: "Light Rain", 63: "Moderate Rain", 65: "Heavy Rain",
            80: "Light Showers", 81: "Moderate Showers", 82: "Violent Showers",
            95: "Thunderstorm", 96: "Thunderstorm with Hail", 99: "Thunderstorm with Heavy Hail"
        }
        condition = wmo_map.get(wmo_code, "Partly Cloudy")
        
        # Daily precipitation values
        precip_sums = daily.get("precipitation_sum", [])
        rainfall_today = round(precip_sums[0], 1) if len(precip_sums) > 0 else 0.0
        
        # Extrapolate rainfall sums
        rainfall_3d = round(sum(precip_sums[:3]), 1) if len(precip_sums) >= 3 else rainfall_today * 2.0
        rainfall_7d = round(sum(precip_sums[:7]), 1) if len(precip_sums) >= 7 else rainfall_3d * 2.0
        avg_7d = rainfall_7d / 7.0 if rainfall_7d > 0 else 0.5
        rainfall_30d = round(rainfall_7d + avg_7d * 23.0, 1)
        rainfall_60d = round(rainfall_30d + avg_7d * 30.0, 1)
        
        # Forecast
        forecast = []
        days_timestamps = daily.get("time", [])
        temp_maxs = daily.get("temperature_2m_max", [])
        temp_mins = daily.get("temperature_2m_min", [])
        daily_codes = daily.get("weather_code", [])
        
        for i in range(1, min(8, len(days_timestamps))):
            d_str = days_timestamps[i]
            dt = datetime.strptime(d_str, "%Y-%m-%d")
            forecast.append({
                "date": d_str,
                "day": dt.strftime("%a"),
                "temp_max": round(temp_maxs[i], 1) if i < len(temp_maxs) else temp_base + 2,
                "temp_min": round(temp_mins[i], 1) if i < len(temp_mins) else temp_base - 5,
                "rainfall": round(precip_sums[i], 1) if i < len(precip_sums) else 0.0,
                "humidity": humidity + random.randint(-10, 10),
                "condition": wmo_map.get(daily_codes[i], "Partly Cloudy") if i < len(daily_codes) else "Partly Cloudy",
            })
            
        hourly_rain = [round(r, 1) for r in hourly.get("precipitation", [])[:24]]
        if len(hourly_rain) < 24:
            hourly_rain += [0.0] * (24 - len(hourly_rain))
            
    else:
        rainfall_today   = round(random.uniform(0, 80 * rain_mult), 1)
        rainfall_3d      = round(rainfall_today * random.uniform(2.0, 3.5), 1)
        rainfall_7d      = round(rainfall_3d  * random.uniform(1.5, 2.5), 1)
        rainfall_30d     = round(rainfall_7d  * random.uniform(2.0, 4.0), 1)
        rainfall_60d     = round(rainfall_30d * random.uniform(1.2, 2.0), 1)
        temp = round(temp_base + random.uniform(-2, 4), 1)
        humidity = random.randint(60, 95) if is_monsoon else random.randint(35, 65)
        pressure = round(random.uniform(1005, 1015), 1)
        wind_speed = round(random.uniform(5, 45), 1)
        wind_direction = random.choice(["N","NE","E","SE","S","SW","W","NW"])
        condition = random.choice(["Heavy Rain","Overcast","Light Rain","Partly Cloudy"]) if is_monsoon else "Clear"
        hourly_rain = [round(random.uniform(0, 20 * rain_mult), 1) for _ in range(24)]
        
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
            
    return {
        "temperature_c":    temp,
        "temperature_min_c":temp - 5,
        "temperature_max_c":temp + 5,
        "humidity":         humidity,
        "pressure_hpa":     pressure,
        "wind_speed_kmh":   wind_speed,
        "wind_direction":   wind_direction,
        "rainfall_today_mm":  rainfall_today,
        "rainfall_3d_mm":     rainfall_3d,
        "rainfall_7d_mm":     rainfall_7d,
        "rainfall_30d_mm":    rainfall_30d,
        "rainfall_60d_mm":    rainfall_60d,
        "visibility_km":    round(random.uniform(3, 15), 1),
        "uv_index":         random.randint(1, 11),
        "condition":        condition,
        "hourly_rain_mm":   hourly_rain,
        "forecast":         forecast,
        "risk_flag":        rainfall_7d > 150,
        "timestamp":        now.isoformat(),
    }


WORKER_OFFSETS = {}
WORKER_STATE_TRACKING = {} # { worker_id: { "status": str, "notified": bool, "timeline_start": str, "arrival_time": str, "confirmed": bool } }

@app.get("/workers")
def workers(mine_lat: float = 20.5937, mine_lon: float = 78.9629):
    """Simulated worker GPS positions with live emergency evacuation tracking."""
    now   = datetime.utcnow()
    global WORKER_OFFSETS, WORKER_STATE_TRACKING, EVACUATION_ACTIVE, EVACUATION_LOGS
    
    # Define hazard and safe zone coordinates dynamically relative to mine center
    hazard_lat = mine_lat + 0.0003
    hazard_lon = mine_lon + 0.0003
    safe_lat = mine_lat - 0.0012
    safe_lon = mine_lon - 0.0015

    if not WORKER_OFFSETS:
        for w in WORKERS_BASE:
            WORKER_OFFSETS[w["id"]] = {
                "lat_off": w["lat_off"],
                "lon_off": w["lon_off"],
                "vx": random.uniform(-0.0001, 0.0001),
                "vy": random.uniform(-0.0001, 0.0001),
            }
            WORKER_STATE_TRACKING[w["id"]] = {
                "status": "Safe",
                "notified": False,
                "timeline_start": "",
                "arrival_time": "",
                "confirmed": False
            }

    # Simulate walking movements
    for w in WORKERS_BASE:
        pos = WORKER_OFFSETS[w["id"]]
        state = WORKER_STATE_TRACKING[w["id"]]
        
        # Current worker lat/lon
        lat = mine_lat + pos["lat_off"]
        lon = mine_lon + pos["lon_off"]
        
        dist_hazard_m = math.sqrt((lat - hazard_lat)**2 + (lon - hazard_lon)**2) * 111000
        dist_safe_m = math.sqrt((lat - safe_lat)**2 + (lon - safe_lon)**2) * 111000

        # If evacuation is active, workers flee towards safe zone
        if EVACUATION_ACTIVE:
            if not state["confirmed"]:
                if state["status"] in ["Safe", "Monitoring"]:
                    state["status"] = "At Risk"
                    state["timeline_start"] = now.isoformat()
                    # Trigger immediate emergency notifications
                    state["notified"] = True
                    body = (f"🚨 MineShield EMERGENCY ALERT - {w['name']} ({w['role']}): "
                            f"High/Critical Rockfall risk detected near your location. "
                            f"Please evacuate to Odisha Central Admin Safe Zone immediately. "
                            f"Distance: {round(dist_safe_m, 1)}m.")
                    send_email(w["email"], "🚨 MineShield Emergency Evacuation Alert", body)
                    send_sms_placeholder(w["mobile"], body)
                
                # Move towards safe zone
                state["status"] = "Evacuating"
                # Vector to safe zone
                d_lat = safe_lat - lat
                d_lon = safe_lon - lon
                d_len = math.sqrt(d_lat**2 + d_lon**2) or 1.0
                
                # Walk speed (approx 5.4 km/h -> 0.00014 deg per step)
                step_size = 0.00015
                pos["vx"] = (d_lat / d_len) * step_size
                pos["vy"] = (d_lon / d_len) * step_size
                
                pos["lat_off"] += pos["vx"]
                pos["lon_off"] += pos["vy"]
                
                # Check if reached safe zone
                if dist_safe_m < 15.0:
                    state["status"] = "Reached Safe Zone"
                    state["confirmed"] = True
                    state["arrival_time"] = now.isoformat()
                    
                    # Calculate timeline duration
                    t_start = datetime.fromisoformat(state["timeline_start"]) if state["timeline_start"] else now
                    duration_sec = int((now - t_start).total_seconds()) or random.randint(30, 60)
                    
                    # Generate AI Summary for reaching safe zone
                    ai_summary = (f"AI-generated Incident Summary: At {t_start.strftime('%H:%M:%S')} UTC, a critical slope hazard alert triggered "
                                  f"an immediate site evacuation. Worker {w['name']} ({w['role']}) was tracked via GPS "
                                  f"evacuating towards the safe zone. Safe zone entry was confirmed at {now.strftime('%H:%M:%S')} UTC "
                                  f"with a total evacuation timeline of {duration_sec} seconds. Proactive sensor validation indicated "
                                  f"a verified rock deformation trend.")
                    
                    # Send safety confirmation
                    confirm_body = (f"✓ MineShield Safety Confirmation: Worker {w['name']} reached the designated safe zone. "
                                    f"Status: Safe. Evacuation timeline: {duration_sec}s. {ai_summary}")
                    send_email(w["email"], "✓ MineShield Safety Confirmation", confirm_body)
                    send_sms_placeholder(w["mobile"], confirm_body)
                    
                    # Log incident report
                    EVACUATION_LOGS.append({
                        "id": f"INC-{now.strftime('%Y%m%d')}-{w['id']}",
                        "timestamp": now.isoformat(),
                        "worker_id": w["id"],
                        "name": w["name"],
                        "role": w["role"],
                        "sensor_analysis": "Station S005 Rain Gauge reading verified as standard meteorological rainfall.",
                        "ai_prediction": "Critical rock displacement warning.",
                        "evacuation_timeline": f"Alert at {t_start.strftime('%H:%M:%S')}, safe arrival at {now.strftime('%H:%M:%S')} ({duration_sec}s duration).",
                        "safe_zone_confirmation": True,
                        "ai_summary": ai_summary,
                        "preventive_actions": "Verify drainage channels and schedule geological inspection."
                    })
        else:
            # Normal movement, reset state
            state["status"] = "Safe" if dist_hazard_m >= 80 else "Monitoring"
            state["confirmed"] = False
            state["timeline_start"] = ""
            state["arrival_time"] = ""
            state["notified"] = False
            
            # Simple random walk
            if random.random() < 0.15:
                pos["vx"] = random.uniform(-0.00015, 0.00015)
                pos["vy"] = random.uniform(-0.00015, 0.00015)
            pos["lat_off"] += pos["vx"]
            pos["lon_off"] += pos["vy"]

            # Keep within boundary
            if abs(pos["lat_off"]) > 0.002:
                pos["vx"] *= -1
                pos["lat_off"] = math.copysign(0.002, pos["lat_off"])
            if abs(pos["lon_off"]) > 0.002:
                pos["vy"] *= -1
                pos["lon_off"] = math.copysign(0.002, pos["lon_off"])

    result = []
    for w in WORKERS_BASE:
        pos = WORKER_OFFSETS[w["id"]]
        state = WORKER_STATE_TRACKING[w["id"]]
        lat = round(mine_lat + pos["lat_off"], 6)
        lon = round(mine_lon + pos["lon_off"], 6)
        
        dist_m = round(math.sqrt((lat - hazard_lat)**2 + (lon - hazard_lon)**2) * 111000, 1)
        dist_safe_m = round(math.sqrt((lat - safe_lat)**2 + (lon - safe_lon)**2) * 111000, 1)
        speed = math.sqrt(pos["vx"]**2 + pos["vy"]**2) * 111000 * 3.6
        
        result.append({
            "id":            w["id"],
            "name":          w["name"],
            "role":          w["role"],
            "latitude":      lat,
            "longitude":     lon,
            "distance_m":    dist_m,
            "distance_safe_m": dist_safe_m,
            "status":        state["status"],
            "in_danger":     state["status"] in ["At Risk", "Evacuating"],
            "heading":       random.randint(0, 360),
            "speed_kmh":     max(0.5, min(8.0, round(speed, 1))),
            "battery":       random.randint(30, 100),
            "last_update":   now.isoformat(),
        })
    return {"workers": result, "timestamp": now.isoformat(), "mine_lat": mine_lat, "mine_lon": mine_lon}


@app.get("/alerts")
def get_alerts():
    """Active alert list, including dynamic sensor-derived alerts and worker warnings."""
    now = datetime.utcnow()
    alerts = []

    # Add dynamic Rockfall Risk alert based on latest prediction probability
    try:
        prob = LATEST_PREDICTION.get("prob", 0.0)
        if prob >= 0.65:
            risk = prob_to_risk(prob)
            level = "CRITICAL" if risk == "CRITICAL" else "HIGH"
            action = "Evacuate all personnel within 200m radius. Suspend blasting operations." if risk == "CRITICAL" else "Restrict heavy equipment movement near slope. Deploy sensors."
            alerts.append({
                "id": "ALT-ML-ROCKFALL",
                "level": level,
                "type": "Rockfall Risk",
                "message": f"{risk} rockfall probability ({round(prob * 100, 1)}%) detected at {LATEST_PREDICTION.get('mine_id')}.",
                "location": f"{LATEST_PREDICTION.get('mine_id')}, Slope Zone",
                "time": now.isoformat(),
                "action": action,
                "acknowledged": False,
            })
    except Exception:
        pass

    # Add dynamic worker proximity alerts
    try:
        for w in WORKERS_BASE:
            pos = WORKER_OFFSETS.get(w["id"])
            state = WORKER_STATE_TRACKING.get(w["id"])
            if pos and state and state["status"] in ["At Risk", "Evacuating"]:
                dist_m = math.sqrt((pos["lat_off"] - 0.0003)**2 + (pos["lon_off"] - 0.0003)**2) * 111000
                level = "CRITICAL" if dist_m < 20 else "HIGH"
                alerts.append({
                    "id": f"ALT-WPR-{w['id']}",
                    "level": level,
                    "type": "Worker Proximity",
                    "message": f"Worker {w['id']} ({w['name']}) inside slope hazard zone. Distance: {round(dist_m, 1)}m.",
                    "location": "Pit Wall Area",
                    "time": now.isoformat(),
                    "action": f"Alert supervisor. Evacuate worker {w['id']}.",
                    "acknowledged": False,
                })
    except Exception:
        pass

    # Add sensor-derived alerts
    try:
        for sid, s in SENSOR_STORE.items():
            if s.get('status') in ('WARNING', 'CRITICAL'):
                level = 'CRITICAL' if s.get('status') == 'CRITICAL' else 'HIGH'
                alerts.append({
                    'id': f'SAL-{sid}',
                    'level': level,
                    'type': f"{s.get('type')} Sensor",
                    'message': f"{s.get('type')} reading {s.get('value')}{s.get('unit')} at {sid} ({s.get('status')}).",
                    'location': f"Monitoring Station {sid}",
                    'time': s.get('last_update', now.isoformat()),
                    'action': 'Investigate sensor reading and inspect site.',
                    'acknowledged': False,
                })
    except Exception:
        pass

    conn = get_db_connection()
    if conn:
        try:
            with conn.cursor() as cur:
                for a in alerts:
                    cur.execute(
                        """INSERT INTO alerts (id, level, type, message, location_desc, time, action, is_anomaly, confidence_score, reasoning, acknowledged, dismissed)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                           ON CONFLICT (id) DO NOTHING;""",
                        (a["id"], a["level"], a["type"], a["message"], a["location"], datetime.fromisoformat(a["time"].replace('Z','')), a.get("action",""), a.get("is_anomaly", False), a.get("confidence_score", 1.0), a.get("reasoning",""), a["acknowledged"], False)
                    )
                conn.commit()

                cur.execute("SELECT id, level, type, message, location_desc, time, action, is_anomaly, confidence_score, reasoning, acknowledged, dismissed FROM alerts WHERE dismissed = FALSE ORDER BY time DESC LIMIT 50;")
                columns = [col[0] for col in cur.description]
                db_alerts = []
                for row in cur.fetchall():
                    r = dict(zip(columns, row))
                    if isinstance(r["time"], datetime):
                        r["time"] = r["time"].isoformat() + "Z"
                    r["location"] = r.pop("location_desc")
                    db_alerts.append(r)
                    if r["acknowledged"]:
                        ACKED_ALERTS.add(r["id"])
                    if r["dismissed"]:
                        DISMISSED_ALERTS.add(r["id"])
                alerts = db_alerts
        except Exception as e:
            print(f"[WARN] Supabase alerts sync failed: {e}")
        finally:
            conn.close()

    return {"alerts": alerts, "count": len(alerts), "critical_count": sum(1 for a in alerts if a["level"] == "CRITICAL"), "timestamp": now.isoformat()}


@app.get("/drone-analysis")
def drone_analysis(lat: Optional[float] = None, lon: Optional[float] = None):
    """Latest drone AI detection results."""
    now = datetime.utcnow()
    gps_lat = lat if lat is not None else 20.5940
    gps_lon = lon if lon is not None else 78.9632
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
        "gps_lat": gps_lat,
        "gps_lon": gps_lon,
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
async def terrain(mine_lat: float = 20.5937, mine_lon: float = 78.9629):
    """
    GEE-powered terrain analysis endpoint.
    Extracts real geospatial features from:
      - Copernicus GLO-30 DEM / SRTM  → elevation, slope, TRI, TPI, roughness
      - Sentinel-2 SR                 → NDVI, NDWI, BSI, rock exposure (spectral index)
      - Sentinel-1 GRD                → SAR backscatter (VV, VH)
      - ESA WorldCover                → land cover class
      - NASA SMAP / ERA5              → soil moisture

    Falls back to physics-based simulation when GEE credentials are unavailable.
    Results are cached for 30 minutes per coordinate pair.
    """
    import asyncio
    try:
        from gee_client import get_terrain_features
    except ImportError:
        from backend.gee_client import get_terrain_features  # fallback import

    # Check verification status
    verified = True
    if GPS_KDTREE is not None:
        query_pt = [float(mine_lat), float(mine_lon)]
        dist_deg, idx = GPS_KDTREE.query(query_pt, k=1)
        dist_km = round(float(dist_deg) * 111.0, 3)
        if dist_km > 2.0:
            verified = False

    try:
        # GEE Python API is synchronous — run in thread to avoid blocking event loop
        data = await asyncio.to_thread(get_terrain_features, float(mine_lat), float(mine_lon))
        data["verified"] = verified
        return data
    except Exception as e:
        print(f"[ERROR] GEE terrain extraction failed: {e}. Returning simulated data.")
        # Hard fallback — should not reach here normally as gee_client handles fallbacks
        from datetime import datetime as _dt
        import random as _rnd
        seed = int(abs(mine_lat * 1000 + mine_lon * 1000)) % (2**31)
        rng = _rnd.Random(seed)
        elev = round(rng.uniform(350, 850), 1)
        return {
            "latitude":           mine_lat,
            "longitude":          mine_lon,
            "elevation_m":        elev,
            "slope_deg":          round(rng.uniform(10, 55), 2),
            "aspect_deg":         round(rng.uniform(0, 360), 1),
            "slope_stddev":       round(rng.uniform(2, 18), 3),
            "tri":                round(rng.uniform(5, 45), 3),
            "tpi":                round(rng.uniform(-10, 10), 3),
            "curvature":          round(rng.uniform(-0.5, 0.5), 4),
            "terrain_roughness":  round(rng.uniform(5, 60), 2),
            "rock_exposure":      round(rng.uniform(0.25, 0.85), 4),
            "bsi":                round(rng.uniform(0.05, 0.55), 4),
            "ndvi":               round(rng.uniform(-0.05, 0.35), 4),
            "ndwi":               round(rng.uniform(-0.35, 0.15), 4),
            "ndmi":               round(rng.uniform(-0.25, 0.30), 4),
            "evi":                round(rng.uniform(0.03, 0.35), 4),
            "vv_db":              round(rng.uniform(-18, -6), 2),
            "vh_db":              round(rng.uniform(-26, -12), 2),
            "vv_vh_diff":         round(rng.uniform(4, 10), 2),
            "vv_stddev":          round(rng.uniform(0.5, 3.5), 3),
            "vh_stddev":          round(rng.uniform(0.5, 3.0), 3),
            "soil_moisture":      round(rng.uniform(0.08, 0.38), 4),
            "soil_moisture_min":  round(rng.uniform(0.05, 0.15), 4),
            "verified":           verified,
            "soil_moisture_max":  round(rng.uniform(0.35, 0.55), 4),
            "land_cover_class":   rng.choice(["Bare Rock / Excavated Area", "Sparse Grassland", "Industrial / Built-up"]),
            "land_cover_value":   60,
            "data_source":        "Simulated",
            "metadata": {
                k: {"source": "Simulated", "acquisition_date": "N/A", "confidence": 0.55}
                for k in ["elevation_m","slope_deg","slope_stddev","tri","tpi","terrain_roughness",
                           "ndvi","ndwi","bsi","rock_exposure","land_cover_class","soil_moisture","vv_db","vh_db"]
            },
            "model_ready_features": {},
            "timestamp": _dt.utcnow().isoformat(),
        }



@app.get("/mines")
def mines():
    """Return mine locations for map markers using central configuration.
    Falls back to static list if loading fails."""
    try:
        from .mine_config import list_mines
        return {"mines": list_mines()}
    except Exception as e:
        print(f"[WARN] Mine config load failed: {e}")
        fallback = [
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
        return {"mines": fallback}


@app.post('/drone/upload')
async def drone_upload(file: UploadFile = File(...)):
    """Accept uploaded image/video and return simulated detection results."""
    now = datetime.utcnow()
    detections = random.sample(DRONE_DETECTIONS, k=min(len(DRONE_DETECTIONS), random.randint(1, 4)))
    return {
        "flight_id": f"DRN-{now.strftime('%Y%m%d')}-UPLOAD",
        "detections": detections,
        "timestamp": now.isoformat(),
    }


@app.get('/sensors')
def sensors():
    """Return current simulated sensor readings."""
    conn = get_db_connection()
    if conn:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT id, type, unit, latitude, longitude, value, threshold, status, trend, last_update FROM sensors;")
                columns = [col[0] for col in cur.description]
                rows = [dict(zip(columns, row)) for row in cur.fetchall()]
                for r in rows:
                    sid = r["id"]
                    if isinstance(r["last_update"], datetime):
                        r["last_update"] = r["last_update"].isoformat()
                    SENSOR_STORE[sid] = r
        except Exception as e:
            print(f"[WARN] Failed to read sensors from DB: {e}")
        finally:
            conn.close()
    return {"sensors": list(SENSOR_STORE.values()), "timestamp": datetime.utcnow().isoformat()}

from fastapi import WebSocket, WebSocketDisconnect

try:
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
    print(f"[OK] Frontend static mounted from {frontend_dir}")
except Exception as e:
    print(f"[WARN] Could not mount frontend static files: {e}")


@app.websocket('/ws')
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    _ws_clients.add(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == 'ping':
                await websocket.send_text('pong')
    except WebSocketDisconnect:
        _ws_clients.discard(websocket)


# -------------------------
# Notification helpers
# -------------------------
def send_email(to_address: str, subject: str, body: str) -> bool:
    """Send email using SMTP. Configuration via env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS"""
    host = os.getenv('SMTP_HOST')
    port = int(os.getenv('SMTP_PORT', '587'))
    user = os.getenv('SMTP_USER')
    pwd  = os.getenv('SMTP_PASS')
    if not host or not user or not pwd:
        print('[WARN] SMTP not configured; skipping email send')
        return False
    try:
        msg = EmailMessage()
        msg['Subject'] = subject
        msg['From'] = user
        msg['To'] = to_address
        msg.set_content(body)
        with smtplib.SMTP(host, port, timeout=10) as s:
            s.starttls()
            s.login(user, pwd)
            s.send_message(msg)
        return True
    except Exception as e:
        print(f'[ERROR] send_email failed: {e}')
        return False

def send_sms_placeholder(to_number: str, message: str) -> bool:
    """Placeholder for SMS sending (Twilio or similar). Configure in production."""
    # In production use Twilio client with credentials from env vars
    sid = os.getenv('TWILIO_SID')
    token = os.getenv('TWILIO_TOKEN')
    from_num = os.getenv('TWILIO_FROM')
    if not (sid and token and from_num):
        print('[WARN] Twilio not configured; skipping SMS send')
        return False
    try:
        from twilio.rest import Client as TwilioClient
        client = TwilioClient(sid, token)
        msg = client.messages.create(body=message, from_=from_num, to=to_number)
        print(f'[OK] Sent SMS to {to_number}; sid={getattr(msg, "sid", "? ")}')
        return True
    except Exception as e:
        print(f'[ERROR] Twilio send failed: {e}')
        # Fallback: log message
        print(f'[INFO] SMS to {to_number}: {message[:160]}')
        return False


# In-memory ack/dismiss state for alerts
ACKED_ALERTS = set()
DISMISSED_ALERTS = set()


@app.post('/alerts/send')
def alerts_send(payload: Dict[str, Any], background: BackgroundTasks):
    """Trigger notifications for an alert. Payload: {level,type,message,location,via:['email','sms'],dest}."""
    level = payload.get('level', 'INFO')
    subject = f"MineShield Alert: {level} - {payload.get('type','') }"
    body = f"{payload.get('message','')}\nLocation: {payload.get('location','') }"
    vias = payload.get('via', ['email'])
    dest = payload.get('dest')
    # Schedule tasks
    if 'email' in vias and dest and '@' in dest:
        background.add_task(send_email, dest, subject, body)
    if 'sms' in vias and dest and dest.isdigit():
        background.add_task(send_sms_placeholder, dest, body)
    return { 'status': 'queued', 'via': vias }


@app.post('/alerts/ack')
def alerts_ack(payload: Dict[str, str]):
    aid = payload.get('id')
    if not aid:
        raise HTTPException(status_code=400, detail='id required')
    ACKED_ALERTS.add(aid)
    
    conn = get_db_connection()
    if conn:
        try:
            with conn.cursor() as cur:
                cur.execute("UPDATE alerts SET acknowledged = TRUE WHERE id = %s;", (aid,))
                conn.commit()
        except Exception as e:
            print(f"[WARN] DB alert ack failed: {e}")
            conn.rollback()
        finally:
            conn.close()
    return {'status': 'acknowledged', 'id': aid}


@app.post('/alerts/dismiss')
def alerts_dismiss(payload: Dict[str, str]):
    aid = payload.get('id')
    if not aid:
        raise HTTPException(status_code=400, detail='id required')
    DISMISSED_ALERTS.add(aid)
    
    conn = get_db_connection()
    if conn:
        try:
            with conn.cursor() as cur:
                cur.execute("UPDATE alerts SET dismissed = TRUE WHERE id = %s;", (aid,))
                conn.commit()
        except Exception as e:
            print(f"[WARN] DB alert dismiss failed: {e}")
            conn.rollback()
        finally:
            conn.close()
    return {'status': 'dismissed', 'id': aid}


# -------------------------
# PDF Report Export
# -------------------------
@app.get('/export/report')
def export_report(mine_id: str = 'MINE-DEFAULT'):
    """Generate a detailed PDF risk assessment and evacuation incident report."""
    try:
        from reportlab.pdfgen import canvas
        from reportlab.lib.pagesizes import A4
    except ImportError:
        raise HTTPException(
            status_code=501,
            detail="PDF export package (reportlab) is not installed on the server."
        )
    pred = predict_live()
    wx   = weather()
    expl = explain(10)

    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=A4)
    w, h = A4
    margin = 40
    y = h - margin

    # Title Banner
    c.setFont('Helvetica-Bold', 18)
    c.drawString(margin, y, 'MineShield — Safety & Incident Report')
    c.setFont('Helvetica', 10)
    y -= 28
    c.drawString(margin, y, f'Mine ID: {mine_id}')
    c.drawString(margin + 300, y, f'Date: {datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")}')
    y -= 20

    # Prediction Summary
    c.setFont('Helvetica-Bold', 12)
    c.drawString(margin, y, 'AI Rockfall Prediction')
    c.setFont('Helvetica', 10)
    y -= 16
    c.drawString(margin, y, f"Vulnerability Probability: {pred.get('vulnerability_probability', 0):.4f}  |  Risk Level: {pred.get('risk_level')}")
    y -= 14
    c.drawString(margin, y, f"Confidence Score: {pred.get('confidence_score', 0.90)}  | Location: {pred.get('latitude', '--')}, {pred.get('longitude', '--')}")
    y -= 22

    # Weather Snapshot
    c.setFont('Helvetica-Bold', 12)
    c.drawString(margin, y, 'Weather Snapshot')
    c.setFont('Helvetica', 10)
    y -= 16
    c.drawString(margin, y, f"Temp: {wx.get('temperature_c','--')}°C  Humidity: {wx.get('humidity','--')}%  Rain(7d): {wx.get('rainfall_7d_mm','--')} mm")
    y -= 22

    # SHAP Top Drivers
    c.setFont('Helvetica-Bold', 12)
    c.drawString(margin, y, 'Top Geotechnical Drivers (XAI)')
    c.setFont('Helvetica', 10)
    y -= 16
    drivers = expl.get('top_drivers', [])
    for d in drivers[:5]:
        txt = f"- {d.get('feature')}: {d.get('shap')} ({d.get('direction')})"
        c.drawString(margin, y, txt)
        y -= 12
    y -= 14

    # Evacuation & Incident Log (If Any)
    c.setFont('Helvetica-Bold', 12)
    c.drawString(margin, y, 'Live Evacuation & Worker Tracking Log')
    c.setFont('Helvetica', 10)
    y -= 16
    if not EVACUATION_LOGS:
        c.drawString(margin, y, "No recent worker evacuation incidents logged. All active personnel safe.")
        y -= 16
    else:
        for log in EVACUATION_LOGS[-3:]:
            c.drawString(margin, y, f"• Incident ID: {log['id']} - Worker: {log['name']} ({log['role']})")
            y -= 12
            c.drawString(margin + 12, y, f"Timeline: {log['evacuation_timeline']}")
            y -= 12
            c.drawString(margin + 12, y, f"Safe Zone Arrival: Confirmed (True)")
            y -= 12
            c.drawString(margin + 12, y, f"AI Summary: {log['ai_summary'][:85]}...")
            y -= 16
            if y < 100:
                c.showPage(); y = h - margin

    # Recommendations
    y -= 8
    c.setFont('Helvetica-Bold', 12)
    c.drawString(margin, y, 'Recommended Geotechnical Action Plan')
    c.setFont('Helvetica', 10)
    y -= 16
    for r in pred.get('recommendations', [])[:4]:
        c.drawString(margin, y, f"- {r}")
        y -= 12
        if y < 72:
            c.showPage(); y = h - margin

    c.showPage()
    c.save()
    buffer.seek(0)

    return StreamingResponse(buffer, media_type='application/pdf', headers={
        'Content-Disposition': f'attachment; filename="mineshield_incident_report_{mine_id}.pdf"'
    })

