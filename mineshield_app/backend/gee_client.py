# -*- coding: utf-8 -*-
"""
gee_client.py — Google Earth Engine Feature Extraction for MineShield
======================================================================
Provides real geospatial feature extraction from GEE satellite datasets:
  - Copernicus GLO-30 DEM / SRTM  → terrain metrics
  - Sentinel-2 SR                 → spectral indices (NDVI, NDWI, BSI, Rock Exposure)
  - Sentinel-1 GRD                → SAR backscatter (VV, VH)
  - ESA WorldCover                → land cover class
  - ERA5 / MODIS NDVI proxy       → soil moisture proxy

Authentication strategy (auto-detected, in order):
  1. GOOGLE_APPLICATION_CREDENTIALS env var → service account JSON
  2. EE_PRIVATE_KEY + EE_SERVICE_ACCOUNT env vars → inline service account
  3. GEE_TOKEN_FILE env var → existing token file path
  4. ~/.config/earthengine/credentials → user-authenticated token (ee.Authenticate())
  5. Fallback → simulated data (GEE_AVAILABLE = False)

Caching: results are cached in-memory keyed by (lat_r, lon_r, date) with a
30-minute TTL to avoid redundant GEE calls.
"""

import os
import math
import time
import random
import logging
from datetime import datetime, timedelta
from typing import Dict, Any, Optional, Tuple

logger = logging.getLogger("gee_client")

# ──────────────────────────────────────────────────────────────────────────────
# GEE availability flag + init
# ──────────────────────────────────────────────────────────────────────────────
GEE_AVAILABLE = False
_GEE_INIT_ATTEMPTED = False

# Default GEE project (can be overridden by EE_PROJECT env var)
DEFAULT_GEE_PROJECT = os.getenv("EE_PROJECT", "angular-array-498017-n1")

def _try_init_gee() -> bool:
    """Attempt to initialize the Earth Engine API. Returns True on success."""
    global GEE_AVAILABLE, _GEE_INIT_ATTEMPTED
    if _GEE_INIT_ATTEMPTED:
        return GEE_AVAILABLE
    _GEE_INIT_ATTEMPTED = True

    try:
        import ee  # type: ignore
    except ImportError:
        logger.warning("[GEE] earthengine-api not installed. Using simulated terrain data.")
        return False

    # Strategy 1: Service account via GOOGLE_APPLICATION_CREDENTIALS
    sa_json = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    service_account = os.getenv("EE_SERVICE_ACCOUNT")
    private_key = os.getenv("EE_PRIVATE_KEY")

    project = DEFAULT_GEE_PROJECT

    try:
        if sa_json and os.path.isfile(sa_json):
            credentials = ee.ServiceAccountCredentials(
                email=None,  # will be read from JSON
                key_file=sa_json
            )
            # Read email from the JSON file
            import json
            with open(sa_json) as f:
                sa_info = json.load(f)
            credentials = ee.ServiceAccountCredentials(
                email=sa_info.get("client_email"),
                key_file=sa_json
            )
            ee.Initialize(credentials, project=project)
            logger.info(f"[GEE] Initialized via GOOGLE_APPLICATION_CREDENTIALS service account (project={project}).")
            GEE_AVAILABLE = True
            return True

        # Strategy 2: Inline env-var service account
        if service_account and private_key:
            credentials = ee.ServiceAccountCredentials(
                email=service_account,
                key_data=private_key
            )
            ee.Initialize(credentials, project=project)
            logger.info(f"[GEE] Initialized via EE_SERVICE_ACCOUNT env vars (project={project}).")
            GEE_AVAILABLE = True
            return True

        # Strategy 3: Custom token file
        token_file = os.getenv("GEE_TOKEN_FILE")
        if token_file and os.path.isfile(token_file):
            ee.Initialize(credentials_file=token_file, project=project)
            logger.info(f"[GEE] Initialized via GEE_TOKEN_FILE: {token_file} (project={project})")
            GEE_AVAILABLE = True
            return True

        # Strategy 4: Default user credentials (~/.config/earthengine/credentials)
        ee.Initialize(project=project)
        logger.info(f"[GEE] Initialized via default user credentials (project={project}).")
        GEE_AVAILABLE = True
        return True

    except Exception as e:
        logger.warning(f"[GEE] Initialization failed: {e}. Falling back to simulated data.")
        GEE_AVAILABLE = False
        return False


# ──────────────────────────────────────────────────────────────────────────────
# In-memory TTL cache
# ──────────────────────────────────────────────────────────────────────────────
_CACHE: Dict[Tuple, Dict] = {}
_CACHE_TTL_SECONDS = 1800  # 30 minutes

def _cache_key(lat: float, lon: float) -> Tuple:
    """Round to 4 decimal places (~11m) for cache keying."""
    date_str = datetime.utcnow().strftime("%Y-%m-%d-%H")  # hourly bucket
    return (round(lat, 4), round(lon, 4), date_str)

def _cache_get(key: Tuple) -> Optional[Dict]:
    entry = _CACHE.get(key)
    if entry and (time.time() - entry["_ts"]) < _CACHE_TTL_SECONDS:
        return entry["data"]
    return None

def _cache_set(key: Tuple, data: Dict):
    _CACHE[key] = {"data": data, "_ts": time.time()}
    # Prune old entries (keep max 200)
    if len(_CACHE) > 200:
        oldest = min(_CACHE, key=lambda k: _CACHE[k]["_ts"])
        _CACHE.pop(oldest, None)


# ──────────────────────────────────────────────────────────────────────────────
# Land cover class mapping
# ──────────────────────────────────────────────────────────────────────────────
WORLDCOVER_CLASSES = {
    10: "Tree Cover",
    20: "Shrubland",
    30: "Grassland",
    40: "Cropland",
    50: "Built-up Area",
    60: "Bare / Sparse Veg.",
    70: "Snow & Ice",
    80: "Permanent Water",
    90: "Herbaceous Wetland",
    95: "Mangrove",
    100: "Moss & Lichen",
}

MINING_LAND_COVERS = {
    60: "Bare Rock / Excavated Area",
    50: "Industrial / Built-up",
    30: "Sparse Grassland",
    20: "Scrub / Degraded Shrubland",
    40: "Waste Dump / Overburden",
}

def _lc_class_name(value: int) -> str:
    # Prioritize mining-specific labels
    for k in sorted(MINING_LAND_COVERS.keys(), key=lambda x: abs(x - value)):
        if abs(k - value) <= 10:
            return MINING_LAND_COVERS[k]
    return WORLDCOVER_CLASSES.get(value, f"Class {value}")


# ──────────────────────────────────────────────────────────────────────────────
# GEE feature extraction functions
# ──────────────────────────────────────────────────────────────────────────────

def _gee_get_terrain(lat: float, lon: float) -> Dict[str, Any]:
    """
    Extract DEM-derived terrain metrics using Copernicus GLO-30 DEM.
    Falls back to SRTM if Copernicus unavailable for region.
    Returns: elevation_m, slope_deg, aspect_deg, slope_stddev, tri, tpi,
             curvature, terrain_roughness, source, acquisition_date
    """
    import ee  # type: ignore

    point = ee.Geometry.Point([lon, lat])
    buffer = point.buffer(500)  # 500m radius for neighbourhood stats

    # Primary: Copernicus GLO-30 DEM 2024 (supersedes GLO30)
    try:
        dem = ee.ImageCollection("COPERNICUS/DEM/GLO30_2024_1").select("DEM").mosaic().clip(buffer)
        src = "Copernicus GLO-30 DEM 2024"
        acq = "2024 (mosaic)"
    except Exception:
        dem = ee.Image("USGS/SRTMGL1_003").select("elevation").clip(buffer)
        src = "SRTM v3"
        acq = "Feb 2000"

    # Terrain analysis — use the DEM band (GLO30 exposes 'DEM'; SRTM exposes 'elevation')
    # Rename to a common name so downstream code is dataset-agnostic
    dem_renamed = dem.rename("elevation")
    terrain = ee.Algorithms.Terrain(dem_renamed)
    elevation = terrain.select("elevation")
    slope     = terrain.select("slope")
    aspect    = terrain.select("aspect")

    # Neighbourhood stats for stddev / TRI / TPI / roughness
    kernel = ee.Kernel.circle(radius=5, units="pixels")

    slope_mean   = slope.reduceNeighborhood(ee.Reducer.mean(), kernel)
    slope_sd     = slope.reduceNeighborhood(ee.Reducer.stdDev(), kernel)
    elev_mean    = elevation.reduceNeighborhood(ee.Reducer.mean(), kernel)
    elev_max     = elevation.reduceNeighborhood(ee.Reducer.max(), kernel)
    elev_min     = elevation.reduceNeighborhood(ee.Reducer.min(), kernel)

    # TRI = mean absolute deviation of elevation in neighbourhood
    tri_img = elevation.subtract(elev_mean).abs()
    # TPI = centre elevation minus mean neighbourhood elevation
    tpi_img = elevation.subtract(elev_mean)
    # Roughness = max - min
    roughness_img = elev_max.subtract(elev_min)

    # Curvature via focal stats approximation
    curvature_img = slope.subtract(slope_mean)

    # Sample all at point
    reducer = ee.Reducer.mean()
    sample = ee.Image.cat([
        elevation.rename("elev"),
        slope.rename("slope"),
        aspect.rename("aspect"),
        slope_sd.rename("slope_sd"),
        tri_img.rename("tri"),
        tpi_img.rename("tpi"),
        roughness_img.rename("roughness"),
        curvature_img.rename("curvature"),
    ]).reduceRegion(reducer=reducer, geometry=point.buffer(300), scale=30, maxPixels=1e6)

    vals = sample.getInfo()
    return {
        "elevation_m":       round(vals.get("elev", 0) or 0, 1),
        "slope_deg":         round(vals.get("slope", 0) or 0, 2),
        "aspect_deg":        round(vals.get("aspect", 0) or 0, 1),
        "slope_stddev":      round(vals.get("slope_sd", 0) or 0, 3),
        "tri":               round(abs(vals.get("tri", 0) or 0), 3),
        "tpi":               round(vals.get("tpi", 0) or 0, 3),
        "curvature":         round(vals.get("curvature", 0) or 0, 4),
        "terrain_roughness": round(abs(vals.get("roughness", 0) or 0), 2),
        "_src_terrain":      src,
        "_acq_terrain":      acq,
    }


def _gee_get_sentinel2(lat: float, lon: float) -> Dict[str, Any]:
    """
    Extract Sentinel-2 SR spectral indices for a 500m buffer around the point.
    Uses a 90-day cloud-masked composite.
    Returns: ndvi, ndwi, bsi, rock_exposure, evi, ndmi, source, acquisition_date
    """
    import ee  # type: ignore

    point = ee.Geometry.Point([lon, lat])
    region = point.buffer(500)

    # Date range: most recent 90 days
    end_date   = datetime.utcnow()
    start_date = end_date - timedelta(days=90)
    end_str    = end_date.strftime("%Y-%m-%d")
    start_str  = start_date.strftime("%Y-%m-%d")

    def mask_s2_clouds(image):
        qa = image.select("QA60")
        cloud_bit_mask   = 1 << 10
        cirrus_bit_mask  = 1 << 11
        mask = qa.bitwiseAnd(cloud_bit_mask).eq(0).And(
               qa.bitwiseAnd(cirrus_bit_mask).eq(0))
        return image.updateMask(mask).divide(10000)

    s2 = (ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
            .filterBounds(region)
            .filterDate(start_str, end_str)
            .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 30))
            .map(mask_s2_clouds)
            .median())

    # Build named-band composite for reliable band references
    b2  = s2.select("B2").rename("Blue")
    b3  = s2.select("B3").rename("Green")
    b4  = s2.select("B4").rename("Red")
    b8  = s2.select("B8").rename("NIR")
    b11 = s2.select("B11").rename("SWIR1")
    b12 = s2.select("B12").rename("SWIR2")
    s2n = ee.Image.cat([b2, b3, b4, b8, b11, b12])

    # NDVI  = (NIR - Red) / (NIR + Red)
    ndvi = s2n.normalizedDifference(["NIR", "Red"]).rename("ndvi")
    # NDWI  = (Green - NIR) / (Green + NIR)
    ndwi = s2n.normalizedDifference(["Green", "NIR"]).rename("ndwi")
    # NDMI  = (NIR - SWIR1) / (NIR + SWIR1)
    ndmi = s2n.normalizedDifference(["NIR", "SWIR1"]).rename("ndmi")
    # BSI   = ((SWIR1 + Red) - (NIR + Blue)) / ((SWIR1 + Red) + (NIR + Blue))
    bsi  = (s2n.select("SWIR1").add(s2n.select("Red"))
              .subtract(s2n.select("NIR").add(s2n.select("Blue")))
              .divide(s2n.select("SWIR1").add(s2n.select("Red"))
                        .add(s2n.select("NIR")).add(s2n.select("Blue")))
              .rename("bsi"))
    # EVI   = 2.5 * (NIR - Red) / (NIR + 6*Red - 7.5*Blue + 1)
    evi  = (s2n.expression(
                "2.5 * ((NIR - RED) / (NIR + 6 * RED - 7.5 * BLUE + 1))",
                {"NIR": s2n.select("NIR"), "RED": s2n.select("Red"), "BLUE": s2n.select("Blue")}
            ).rename("evi"))
    # Rock Exposure Index: REI = (SWIR2 - NIR) / (SWIR2 + NIR)
    # High SWIR2 + low NIR = exposed bare rock / excavated surface
    rei  = s2n.normalizedDifference(["SWIR2", "NIR"]).rename("rei")

    composite = ee.Image.cat([ndvi, ndwi, ndmi, bsi, evi, rei])
    vals = composite.reduceRegion(
        reducer=ee.Reducer.mean(),
        geometry=region,
        scale=10,
        maxPixels=1e6
    ).getInfo()

    # Normalize REI to rock exposure percentage:
    # REI range is [-1, 1]; bare rock sites typically 0.1–0.6
    # Map [0.05, 0.65] → [0%, 100%]
    rei_raw = vals.get("rei", 0) or 0
    rock_pct = max(0.0, min(1.0, (rei_raw - 0.05) / 0.60))

    # EVI clamp to reasonable range
    evi_val = vals.get("evi", 0) or 0
    evi_val = max(-1.0, min(1.0, evi_val))

    # Get the actual image date range
    first_date = (ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
                    .filterBounds(region)
                    .filterDate(start_str, end_str)
                    .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 30))
                    .sort("system:time_start", False)
                    .first()
                    .date()
                    .format("YYYY-MM-dd")
                    .getInfo())

    return {
        "ndvi":          round(vals.get("ndvi", 0) or 0, 4),
        "ndwi":          round(vals.get("ndwi", 0) or 0, 4),
        "ndmi":          round(vals.get("ndmi", 0) or 0, 4),
        "bsi":           round(vals.get("bsi", 0) or 0, 4),
        "evi":           round(evi_val, 4),
        "rock_exposure": round(rock_pct, 4),
        "_src_s2":       "Sentinel-2 SR Harmonized",
        "_acq_s2":       first_date or f"{start_str} to {end_str} (composite)",
    }


def _gee_get_sentinel1(lat: float, lon: float) -> Dict[str, Any]:
    """
    Extract Sentinel-1 GRD SAR backscatter (VV, VH) in dB.
    Uses a 30-day composite, IW mode, VV+VH polarization.
    """
    import ee  # type: ignore

    point = ee.Geometry.Point([lon, lat])
    region = point.buffer(500)

    end_date   = datetime.utcnow()
    start_date = end_date - timedelta(days=30)
    end_str    = end_date.strftime("%Y-%m-%d")
    start_str  = start_date.strftime("%Y-%m-%d")

    s1 = (ee.ImageCollection("COPERNICUS/S1_GRD")
            .filterBounds(region)
            .filterDate(start_str, end_str)
            .filter(ee.Filter.eq("instrumentMode", "IW"))
            .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VV"))
            .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VH"))
            .select(["VV", "VH"])
            .mean())

    # Also compute stddev for texture
    s1_std = (ee.ImageCollection("COPERNICUS/S1_GRD")
                .filterBounds(region)
                .filterDate(start_str, end_str)
                .filter(ee.Filter.eq("instrumentMode", "IW"))
                .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VV"))
                .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VH"))
                .select(["VV", "VH"])
                .reduce(ee.Reducer.stdDev()))

    vals = s1.reduceRegion(
        reducer=ee.Reducer.mean(),
        geometry=region,
        scale=10,
        maxPixels=1e6
    ).getInfo()

    std_vals = s1_std.reduceRegion(
        reducer=ee.Reducer.mean(),
        geometry=region,
        scale=10,
        maxPixels=1e6
    ).getInfo()

    vv = vals.get("VV", -15.0) or -15.0
    vh = vals.get("VH", -22.0) or -22.0

    # Acquisition date
    first_date = (ee.ImageCollection("COPERNICUS/S1_GRD")
                    .filterBounds(region)
                    .filterDate(start_str, end_str)
                    .filter(ee.Filter.eq("instrumentMode", "IW"))
                    .sort("system:time_start", False)
                    .first()
                    .date()
                    .format("YYYY-MM-dd")
                    .getInfo())

    return {
        "vv_db":       round(vv, 2),
        "vh_db":       round(vh, 2),
        "vv_vh_diff":  round(vv - vh, 2),
        "vv_stddev":   round(std_vals.get("VV_stdDev", 0) or 0, 3),
        "vh_stddev":   round(std_vals.get("VH_stdDev", 0) or 0, 3),
        "_src_s1":     "Sentinel-1 GRD (IW, C-Band)",
        "_acq_s1":     first_date or f"{start_str} to {end_str} (composite)",
    }


def _gee_get_land_cover(lat: float, lon: float) -> Dict[str, Any]:
    """
    Extract ESA WorldCover 10m land cover class.
    """
    import ee  # type: ignore

    point = ee.Geometry.Point([lon, lat])

    lc = ee.ImageCollection("ESA/WorldCover/v200").first().select("Map")
    val = lc.reduceRegion(
        reducer=ee.Reducer.mode(),
        geometry=point.buffer(200),
        scale=10,
        maxPixels=1e6
    ).getInfo()

    lc_int = int(val.get("Map", 60) or 60)
    return {
        "land_cover_value": lc_int,
        "land_cover_class": _lc_class_name(lc_int),
        "_src_lc":           "ESA WorldCover v2 (2021)",
        "_acq_lc":           "2021",
    }


def _gee_get_soil_moisture(lat: float, lon: float) -> Dict[str, Any]:
    """
    Extract soil moisture proxy from NASA SMAP Level-4 (or ERA5 fallback).
    SMAP L4 volumetric soil moisture [m³/m³] at 9km resolution.
    """
    import ee  # type: ignore

    point = ee.Geometry.Point([lon, lat])
    region = point.buffer(5000)  # SMAP is coarse resolution (9km)

    end_date   = datetime.utcnow()
    start_date = end_date - timedelta(days=14)
    end_str    = end_date.strftime("%Y-%m-%d")
    start_str  = start_date.strftime("%Y-%m-%d")

    try:
        smap = (ee.ImageCollection("NASA/SMAP/SPL4SMGP/008")
                  .filterDate(start_str, end_str)
                  .select("sm_surface")
                  .mean())

        vals = smap.reduceRegion(
            reducer=ee.Reducer.mean(),
            geometry=region,
            scale=9000,
            maxPixels=1e6
        ).getInfo()

        sm = vals.get("sm_surface", None)
        if sm is not None:
            sm_min_max = (ee.ImageCollection("NASA/SMAP/SPL4SMGP/008")
                            .filterDate(start_str, end_str)
                            .select("sm_surface")
                            .reduce(ee.Reducer.minMax())
                            .reduceRegion(ee.Reducer.mean(), geometry=region, scale=9000, maxPixels=1e6)
                            .getInfo())
            sm_min = sm_min_max.get("sm_surface_min", sm * 0.5) or (sm * 0.5)
            sm_max = sm_min_max.get("sm_surface_max", sm * 1.5) or (sm * 1.5)
            return {
                "soil_moisture":     round(sm, 4),
                "soil_moisture_min": round(sm_min, 4),
                "soil_moisture_max": round(sm_max, 4),
                "_src_sm":           "NASA SMAP Level-4",
                "_acq_sm":           f"{start_str} to {end_str} (composite)",
            }
    except Exception as e:
        logger.warning(f"[GEE] SMAP soil moisture failed: {e}. Trying ERA5.")

    # Fallback: ERA5 volumetric soil water layer 1
    try:
        era5 = (ee.ImageCollection("ECMWF/ERA5_LAND/HOURLY")
                  .filterDate(start_str, end_str)
                  .select("volumetric_soil_water_layer_1")
                  .mean())
        vals = era5.reduceRegion(
            reducer=ee.Reducer.mean(),
            geometry=region,
            scale=9000,
            maxPixels=1e6
        ).getInfo()
        sm = vals.get("volumetric_soil_water_layer_1", 0.2) or 0.2
        return {
            "soil_moisture":     round(sm, 4),
            "soil_moisture_min": round(sm * 0.7, 4),
            "soil_moisture_max": round(sm * 1.3, 4),
            "_src_sm":           "ERA5-Land (ECMWF)",
            "_acq_sm":           f"{start_str} to {end_str} (composite)",
        }
    except Exception as e2:
        logger.warning(f"[GEE] ERA5 soil moisture also failed: {e2}.")
        return {
            "soil_moisture":     0.2,
            "soil_moisture_min": 0.1,
            "soil_moisture_max": 0.35,
            "_src_sm":           "Simulated",
            "_acq_sm":           "N/A",
        }


# ──────────────────────────────────────────────────────────────────────────────
# Physics-based simulation fallback (realistic, location-seeded)
# ──────────────────────────────────────────────────────────────────────────────

LAND_COVER_BY_SEED = [
    "Bare Rock / Excavated Area",
    "Sparse Grassland",
    "Industrial / Built-up",
    "Scrub / Degraded Shrubland",
    "Waste Dump / Overburden",
    "Bare Rock / Excavated Area",
]

def _simulated_features(lat: float, lon: float) -> Dict[str, Any]:
    """
    Deterministic simulation seeded by (lat, lon). Produces realistic mining
    terrain values that are consistent across calls for the same location.
    """
    seed = int(abs(lat * 10000 + lon * 10000)) % (2**31)
    rng  = random.Random(seed)

    # Elevation influenced by latitude (tropical highlands vs plains)
    elev_base = 400 + abs(lat - 20) * 15 + abs(lon - 80) * 5
    elevation = round(rng.gauss(elev_base, 80), 1)
    elevation = max(50.0, min(2500.0, elevation))

    slope     = round(rng.uniform(8, 52), 2)
    aspect    = round(rng.uniform(0, 360), 1)
    slope_sd  = round(rng.uniform(2, 15), 3)
    tri       = round(rng.uniform(3, 42), 3)
    tpi       = round(rng.gauss(0, 4), 3)
    curvature = round(rng.gauss(0, 0.15), 4)
    roughness = round(rng.uniform(8, 65), 2)

    # Spectral: mining areas have low NDVI, higher BSI and rock exposure
    ndvi    = round(rng.uniform(-0.05, 0.35), 4)
    ndwi    = round(rng.uniform(-0.35, 0.15), 4)
    ndmi    = round(rng.uniform(-0.25, 0.30), 4)
    bsi     = round(rng.uniform(0.05, 0.55), 4)
    evi     = round(rng.uniform(0.03, 0.35), 4)
    rock    = round(rng.uniform(0.25, 0.88), 4)  # mining areas: high rock exposure

    # SAR: typical for rocky open-pit mines
    vv      = round(rng.uniform(-18, -6), 2)
    vh      = round(rng.uniform(-26, -12), 2)
    vv_sd   = round(rng.uniform(0.5, 3.5), 3)
    vh_sd   = round(rng.uniform(0.5, 3.0), 3)

    # Soil moisture: low in dry mining areas
    sm      = round(rng.uniform(0.08, 0.38), 4)
    sm_min  = round(sm * 0.6, 4)
    sm_max  = round(sm * 1.4, 4)

    lc_class = LAND_COVER_BY_SEED[seed % len(LAND_COVER_BY_SEED)]

    return {
        # Terrain
        "elevation_m":        elevation,
        "slope_deg":          slope,
        "aspect_deg":         aspect,
        "slope_stddev":       slope_sd,
        "tri":                tri,
        "tpi":                tpi,
        "curvature":          curvature,
        "terrain_roughness":  roughness,
        "_src_terrain":       "Simulated (physics-based)",
        "_acq_terrain":       "N/A",
        # Sentinel-2
        "ndvi":               ndvi,
        "ndwi":               ndwi,
        "ndmi":               ndmi,
        "bsi":                bsi,
        "evi":                evi,
        "rock_exposure":      rock,
        "_src_s2":            "Simulated (Sentinel-2 proxy)",
        "_acq_s2":            "N/A",
        # Sentinel-1
        "vv_db":              vv,
        "vh_db":              vh,
        "vv_vh_diff":         round(vv - vh, 2),
        "vv_stddev":          vv_sd,
        "vh_stddev":          vh_sd,
        "_src_s1":            "Simulated (SAR proxy)",
        "_acq_s1":            "N/A",
        # Land cover
        "land_cover_value":   60,
        "land_cover_class":   lc_class,
        "_src_lc":            "Simulated",
        "_acq_lc":            "N/A",
        # Soil moisture
        "soil_moisture":      sm,
        "soil_moisture_min":  sm_min,
        "soil_moisture_max":  sm_max,
        "_src_sm":            "Simulated",
        "_acq_sm":            "N/A",
    }


# ──────────────────────────────────────────────────────────────────────────────
# Confidence scoring
# ──────────────────────────────────────────────────────────────────────────────

def _confidence(source: str, is_gee: bool) -> float:
    """Return a confidence score [0, 1] based on data source."""
    if not is_gee:
        return 0.55  # simulation
    if "Copernicus" in source:
        return 0.97
    if "Sentinel-2" in source:
        return 0.93
    if "Sentinel-1" in source:
        return 0.91
    if "SMAP" in source:
        return 0.85
    if "ERA5" in source:
        return 0.80
    if "WorldCover" in source:
        return 0.90
    return 0.75


# ──────────────────────────────────────────────────────────────────────────────
# Main public API
# ──────────────────────────────────────────────────────────────────────────────

def get_terrain_features(lat: float, lon: float) -> Dict[str, Any]:
    """
    Main entry point. Returns a full terrain feature dict for the given
    GPS coordinates. Uses GEE if available, otherwise simulation.

    The returned dict includes:
      - All 12 terrain/spectral/SAR/land/soil metrics
      - metadata: per-metric source, acquisition_date, confidence
      - model_ready_features: XGBoost-ready dict matching FEATURE_NAMES
      - data_source: "GEE" | "Simulated"
      - timestamp: ISO UTC string
    """
    # Check cache
    ckey = _cache_key(lat, lon)
    cached = _cache_get(ckey)
    if cached:
        logger.debug(f"[GEE] Cache hit for ({lat:.4f}, {lon:.4f})")
        return cached

    # Try GEE
    use_gee = _try_init_gee()
    now_str = datetime.utcnow().isoformat()

    if use_gee:
        logger.info(f"[GEE] Fetching live features for ({lat:.4f}, {lon:.4f})")
        raw = {}
        errors = []

        for fn, label in [
            (_gee_get_terrain, "terrain"),
            (_gee_get_sentinel2, "sentinel2"),
            (_gee_get_sentinel1, "sentinel1"),
            (_gee_get_land_cover, "land_cover"),
            (_gee_get_soil_moisture, "soil_moisture"),
        ]:
            try:
                raw.update(fn(lat, lon))
            except Exception as e:
                logger.warning(f"[GEE] {label} extraction failed: {e}")
                errors.append(label)

        # Fill any missing with simulation
        if errors:
            sim = _simulated_features(lat, lon)
            for k, v in sim.items():
                if k not in raw:
                    raw[k] = v

        data_source = "GEE"
        confidence_multiplier = 1.0
    else:
        logger.info(f"[GEE] Using simulation for ({lat:.4f}, {lon:.4f})")
        raw = _simulated_features(lat, lon)
        data_source = "Simulated"
        confidence_multiplier = 0.55

    # ── Build metadata dict ──
    is_gee = data_source == "GEE"
    metadata = {
        "elevation_m": {
            "source": raw.get("_src_terrain", "Unknown"),
            "acquisition_date": raw.get("_acq_terrain", "N/A"),
            "confidence": _confidence(raw.get("_src_terrain", ""), is_gee),
        },
        "slope_deg": {
            "source": raw.get("_src_terrain", "Unknown"),
            "acquisition_date": raw.get("_acq_terrain", "N/A"),
            "confidence": _confidence(raw.get("_src_terrain", ""), is_gee),
        },
        "slope_stddev": {
            "source": raw.get("_src_terrain", "Unknown"),
            "acquisition_date": raw.get("_acq_terrain", "N/A"),
            "confidence": _confidence(raw.get("_src_terrain", ""), is_gee),
        },
        "tri": {
            "source": raw.get("_src_terrain", "Unknown"),
            "acquisition_date": raw.get("_acq_terrain", "N/A"),
            "confidence": _confidence(raw.get("_src_terrain", ""), is_gee),
        },
        "tpi": {
            "source": raw.get("_src_terrain", "Unknown"),
            "acquisition_date": raw.get("_acq_terrain", "N/A"),
            "confidence": _confidence(raw.get("_src_terrain", ""), is_gee),
        },
        "terrain_roughness": {
            "source": raw.get("_src_terrain", "Unknown"),
            "acquisition_date": raw.get("_acq_terrain", "N/A"),
            "confidence": _confidence(raw.get("_src_terrain", ""), is_gee),
        },
        "ndvi": {
            "source": raw.get("_src_s2", "Unknown"),
            "acquisition_date": raw.get("_acq_s2", "N/A"),
            "confidence": _confidence(raw.get("_src_s2", ""), is_gee),
        },
        "ndwi": {
            "source": raw.get("_src_s2", "Unknown"),
            "acquisition_date": raw.get("_acq_s2", "N/A"),
            "confidence": _confidence(raw.get("_src_s2", ""), is_gee),
        },
        "bsi": {
            "source": raw.get("_src_s2", "Unknown"),
            "acquisition_date": raw.get("_acq_s2", "N/A"),
            "confidence": _confidence(raw.get("_src_s2", ""), is_gee),
        },
        "rock_exposure": {
            "source": raw.get("_src_s2", "Unknown"),
            "acquisition_date": raw.get("_acq_s2", "N/A"),
            "confidence": _confidence(raw.get("_src_s2", ""), is_gee),
        },
        "land_cover_class": {
            "source": raw.get("_src_lc", "Unknown"),
            "acquisition_date": raw.get("_acq_lc", "N/A"),
            "confidence": _confidence(raw.get("_src_lc", ""), is_gee),
        },
        "soil_moisture": {
            "source": raw.get("_src_sm", "Unknown"),
            "acquisition_date": raw.get("_acq_sm", "N/A"),
            "confidence": _confidence(raw.get("_src_sm", ""), is_gee),
        },
        "vv_db": {
            "source": raw.get("_src_s1", "Unknown"),
            "acquisition_date": raw.get("_acq_s1", "N/A"),
            "confidence": _confidence(raw.get("_src_s1", ""), is_gee),
        },
        "vh_db": {
            "source": raw.get("_src_s1", "Unknown"),
            "acquisition_date": raw.get("_acq_s1", "N/A"),
            "confidence": _confidence(raw.get("_src_s1", ""), is_gee),
        },
    }

    # ── XGBoost model-ready feature dict ──
    model_ready_features = {
        "Elevation":          raw.get("elevation_m", 0),
        "Slope":              raw.get("slope_deg", 0),
        "Aspect":             raw.get("aspect_deg", 0),
        "Elevation_stdDev":   raw.get("slope_stddev", 0),  # proxy
        "Slope_stdDev":       raw.get("slope_stddev", 0),
        "TRI":                raw.get("tri", 0),
        "TPI":                raw.get("tpi", 0),
        "Curvature":          raw.get("curvature", 0),
        "Terrain_Roughness":  raw.get("terrain_roughness", 0),
        "NDVI":               raw.get("ndvi", 0),
        "NDVI_Change":        0.0,   # requires temporal diff — filled at prediction time
        "EVI":                raw.get("evi", 0),
        "NDMI":               raw.get("ndmi", 0),
        "NDMI_Change":        0.0,
        "NDWI":               raw.get("ndwi", 0),
        "BSI":                raw.get("bsi", 0),
        "Rock_Exposure":      raw.get("rock_exposure", 0),
        "VV":                 raw.get("vv_db", -15.0),
        "VH":                 raw.get("vh_db", -22.0),
        "VV_VH_Difference":   raw.get("vv_vh_diff", 7.0),
        "VV_stdDev":          raw.get("vv_stddev", 0),
        "VH_stdDev":          raw.get("vh_stddev", 0),
        "VV_Change":          0.0,
        "VH_Change":          0.0,
        "Soil_Moisture":      raw.get("soil_moisture", 0.2),
        "Soil_Moisture_Min":  raw.get("soil_moisture_min", 0.1),
        "Soil_Moisture_Max":  raw.get("soil_moisture_max", 0.3),
        "Land_Cover":         float(raw.get("land_cover_value", 60)),
    }

    result = {
        # ── Primary values ──
        "latitude":           lat,
        "longitude":          lon,
        "elevation_m":        raw.get("elevation_m", 0),
        "slope_deg":          raw.get("slope_deg", 0),
        "aspect_deg":         raw.get("aspect_deg", 0),
        "slope_stddev":       raw.get("slope_stddev", 0),
        "tri":                raw.get("tri", 0),
        "tpi":                raw.get("tpi", 0),
        "curvature":          raw.get("curvature", 0),
        "terrain_roughness":  raw.get("terrain_roughness", 0),
        # Spectral
        "ndvi":               raw.get("ndvi", 0),
        "ndwi":               raw.get("ndwi", 0),
        "ndmi":               raw.get("ndmi", 0),
        "bsi":                raw.get("bsi", 0),
        "evi":                raw.get("evi", 0),
        "rock_exposure":      raw.get("rock_exposure", 0),
        # SAR
        "vv_db":              raw.get("vv_db", -15.0),
        "vh_db":              raw.get("vh_db", -22.0),
        "vv_vh_diff":         raw.get("vv_vh_diff", 7.0),
        "vv_stddev":          raw.get("vv_stddev", 0),
        "vh_stddev":          raw.get("vh_stddev", 0),
        # Land cover
        "land_cover_value":   raw.get("land_cover_value", 60),
        "land_cover_class":   raw.get("land_cover_class", "Unknown"),
        # Soil
        "soil_moisture":      raw.get("soil_moisture", 0.2),
        "soil_moisture_min":  raw.get("soil_moisture_min", 0.1),
        "soil_moisture_max":  raw.get("soil_moisture_max", 0.3),
        # ── Meta ──
        "data_source":        data_source,
        "metadata":           metadata,
        "model_ready_features": model_ready_features,
        "timestamp":          now_str,
        "cache_ttl_minutes":  _CACHE_TTL_SECONDS // 60,
    }

    _cache_set(ckey, result)
    return result
