<div align="center">

<img src="https://img.shields.io/badge/MineShield-v2.0-ff6b35?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMTIgMkwyMiAyMEgyTDEyIDJaIiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMiIvPjwvc3ZnPg==" alt="MineShield"/>

# 🛡️ MineShield v2.0

### AI-Based Rockfall Prediction & Alert System for Open-Pit Mines

*Built for Smart India Hackathon — Protecting miners with AI-powered prediction and real-time monitoring*

[![FastAPI](https://img.shields.io/badge/FastAPI-0.111-009688?style=flat-square&logo=fastapi)](https://fastapi.tiangolo.com)
[![XGBoost](https://img.shields.io/badge/XGBoost-2.0-FF6600?style=flat-square)](https://xgboost.readthedocs.io)
[![Python](https://img.shields.io/badge/Python-3.11-3776AB?style=flat-square&logo=python)](https://python.org)
[![Leaflet](https://img.shields.io/badge/Leaflet-1.9-199900?style=flat-square)](https://leafletjs.com)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

</div>

---

## 🎯 What is MineShield?

**MineShield** is a production-grade, full-stack AI safety system for open-pit mines. It combines:

| Module | Technology | Purpose |
|--------|-----------|---------|
| **Rockfall Prediction Engine** | XGBoost + 38 features | Predict slope vulnerability probability (0–1) |
| **GPS Live Prediction** | Browser Geolocation + KDTree | Find nearest mine → run real prediction |
| **DEM Terrain Analysis** | GEE + Sentinel-1 SAR | Slope, TRI, Rock Exposure, BSI, NDVI |
| **Satellite Imagery** | Leaflet + Esri WorldImagery | Live satellite map with risk heatmap |
| **Weather Intelligence** | ERA5 / OpenMeteo | Rainfall thresholds triggering risk elevation |
| **Worker GPS Tracking** | Real-time WebAPI | Proximity alerts when entering hazard zones |
| **Drone Intelligence** | Canvas AI overlay | Crack, overhang, erosion detection with confidence scores |
| **Explainable AI** | SHAP values | Top risk drivers for every prediction |
| **Emergency Alerting** | Multi-severity system | Critical evacuation → Info level incidents |

---

## 📸 Screenshots

> Dark mode enterprise dashboard with live risk prediction

| Dashboard | Risk Engine | Live Map |
|-----------|-------------|----------|
| KPI cards + 30-day trend | Animated gauge + SHAP | Satellite + Heatmap |

---

## 🚀 Quick Start

### Prerequisites
- Python **3.11** (recommended)
- Git
- A modern browser (Chrome / Edge / Firefox)

### 1. Clone the repository
```bash
git clone https://github.com/YOUR_USERNAME/MineShield.git
cd MineShield
```

### 2. Install backend dependencies
```bash
cd mineshield_app/backend

# Windows (Python 3.11)
"C:\Users\YOUR_USERNAME\AppData\Local\Programs\Python\Python311\python.exe" -m pip install -r requirements.txt

# Linux / macOS
python3.11 -m pip install -r requirements.txt
```

### 3. Start the backend
```bash
# Windows Python 3.11
"C:\Users\YOUR_USERNAME\AppData\Local\Programs\Python\Python311\python.exe" -m uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Linux / macOS
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### 4. Open the frontend
```bash
# Simply open in your browser:
mineshield_app/frontend/index.html

# Or serve with Python:
python -m http.server 3000 --directory mineshield_app/frontend
# → Visit http://localhost:3000
```

### One-Click (Windows)
```powershell
cd mineshield_app
.\start.ps1
```

---

## 📡 API Reference

**Base URL:** `http://localhost:8000`  
**Interactive Docs:** `http://localhost:8000/docs`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Health check |
| `GET` | `/predict/live?mine_lat=X&mine_lon=Y` | GPS-aware XGBoost prediction |
| `POST` | `/predict` | Prediction from custom feature vector |
| `GET` | `/explain` | SHAP feature importance |
| `GET` | `/weather` | Live weather + rainfall analysis |
| `GET` | `/workers` | Worker GPS positions + hazard proximity |
| `GET` | `/alerts` | Active alerts by severity |
| `GET` | `/drone-analysis` | AI drone detection results |
| `GET` | `/terrain` | DEM terrain metrics |
| `GET` | `/analytics` | 30-day historical risk & rainfall data |
| `GET` | `/mines` | Mine locations from dataset |

### Sample Response — `/predict/live`
```json
{
  "mine_id": "MINE-2053-7896",
  "observation_date": "2025-08-16",
  "vulnerability_probability": 0.782341,
  "risk_level": "HIGH",
  "latitude": 20.5312,
  "longitude": 78.9124,
  "distance_km": 1.24,
  "recommendations": [
    "Restrict heavy equipment movement near slope.",
    "Deploy additional sensors.",
    "Issue site advisory."
  ],
  "timestamp": "2025-08-16T11:03:45.123Z"
}
```

---

## 🏗️ Project Structure

```
MineShield/
├── mineshield_app/              ← Main application (tracked by Git)
│   ├── backend/
│   │   ├── main.py              ← FastAPI + XGBoost inference + GPS KDTree
│   │   └── requirements.txt
│   ├── frontend/
│   │   ├── index.html           ← Full SPA (10 pages)
│   │   ├── css/
│   │   │   └── app.css          ← Dark/Light design system
│   │   └── js/
│   │       ├── api.js           ← Backend API client
│   │       ├── app.js           ← Router + GPS pipeline + theme
│   │       ├── map.js           ← Leaflet satellite map
│   │       ├── charts.js        ← Chart.js (gauge, SHAP, radar)
│   │       ├── alerts.js        ← Alert center + Drone canvas
│   │       └── workers.js       ← Worker tracking + Risk engine
│   └── start.ps1                ← Windows one-click launcher
│
├── mineshield_model_bundle.pkl  ← XGBoost trained model (~407 KB)
├── mineshield_scaler.pkl        ← StandardScaler (~2.3 KB)
├── mineshield_train_medians.pkl ← Feature medians (~2.7 KB)
├── mineshield_feature_importance.csv ← SHAP values (~1 KB)
├── mineshield_unique_kdtree.pkl ← Unique mine KDTree (~854 KB)
├── latest_mine_records.parquet  ← Live mine data (~857 KB)
├── unique_mine_index.parquet    ← Mine index (~700 KB)
├── gee_script.js                ← Google Earth Engine data pipeline
└── .gitignore                   ← Excludes large dataset files (GBs)

# NOT tracked (too large for GitHub, add your own):
# MineShield_4D_Dataset_*.csv   ← Training data (GB range)
# all_features.parquet          ← Full feature matrix (108 MB)
# mine_location_index.parquet   ← Full mine locations (5.6 MB)
# mineshield_kdtree.pkl         ← Full KDTree (19 MB)
```

---

## 🤖 ML Model Details

| Property | Value |
|----------|-------|
| Algorithm | XGBoost Classifier |
| Features | 38 (terrain + SAR + vegetation + rainfall + temperature) |
| Training Data | 3 years (2023–2025), Indian open-pit mines |
| Target | Binary (Rockfall event: 0/1) |
| Output | Probability 0.0000 – 1.0000 |

### Top Risk Drivers (SHAP)

| Rank | Feature | Mean \|SHAP\| |
|------|---------|--------------|
| 1 | Slope_stdDev | 2.599 |
| 2 | Rock_Exposure | 2.038 |
| 3 | TRI (Terrain Ruggedness Index) | 1.187 |
| 4 | VV_stdDev (SAR backscatter) | 1.164 |
| 5 | Rainfall_30d | 0.914 |
| 6 | Slope | 0.901 |

### Risk Categories

| Category | Probability | Action |
|----------|-------------|--------|
| 🟢 **LOW** | 0.000 – 0.250 | Continue monitoring |
| 🟡 **MODERATE** | 0.250 – 0.500 | Increase inspections |
| 🟠 **HIGH** | 0.500 – 0.750 | Restrict equipment |
| 🔴 **CRITICAL** | 0.750 – 1.000 | **IMMEDIATE EVACUATION** |

---

## 🗺️ Features Breakdown

### Live GPS Prediction
- Browser Geolocation API captures your real coordinates
- Backend queries a **scipy KDTree** of 627,610 mine locations
- Finds the nearest mine in O(log n) time
- Runs XGBoost prediction seeded by your actual location
- Updates every 30 seconds automatically

### Dark / Light Mode
- Toggle in the top bar
- Preference saved in `localStorage`
- Full design system with CSS custom properties

### Interactive Satellite Map
- **Esri WorldImagery** (free satellite tiles, no API key)
- **CartoDB Dark Matter** (dark mode map)
- **OpenTopoMap** (terrain view)
- Risk heatmap overlay (Leaflet.heat)
- Live worker GPS markers with hazard-colored indicators
- Animated drone flight path

---

## ⚙️ Configuration

Edit thresholds in `Settings` page or directly in `frontend/js/app.js`:

```javascript
const THRESHOLDS = {
  moderate: 0.25,   // probability to classify as MODERATE
  high:     0.50,   // probability to classify as HIGH
  critical: 0.75,   // probability to classify as CRITICAL
  rainfall_alert_7d: 150, // mm — triggers rainfall warning
  worker_danger_m: 50,    // meters — worker proximity alert
};
```

---

## 🐛 Known Issues & Notes

- **Model pickle compatibility**: The XGBoost model was saved with numpy 2.x. A compatibility shim in `main.py` patches `numpy._core` → `numpy.core` for Python 3.11 + numpy 1.x. If you have numpy 2.x, it loads natively.
- **Large files**: The full training datasets (GB range) are excluded from Git. The app runs fine without them — only the small model artifacts (`*.pkl`, small parquets) are needed.
- **GPS**: Browser geolocation requires HTTPS in production. For local testing, `localhost` is exempted.

---

## 📦 Tech Stack

**Backend**
- FastAPI · Uvicorn · XGBoost · scikit-learn · NumPy · pandas · PyArrow · scipy

**Frontend**
- Vanilla HTML/CSS/JavaScript (no framework)
- Leaflet.js — Interactive maps
- Chart.js — Data visualizations
- Google Fonts (Inter + JetBrains Mono)

**Data**
- Google Earth Engine (GEE) — DEM, Sentinel-1 SAR, MODIS, ERA5
- 38 terrain + spectral + meteorological features
- Indian open-pit mines (2023–2025)

---

## 📄 License

MIT License — see [LICENSE](LICENSE)

---

<div align="center">

**Built for Smart India Hackathon 2025**

*Protecting miners with AI — one prediction at a time*

⭐ Star this repo if MineShield helped you!

</div>
