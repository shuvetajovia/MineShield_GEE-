/**
 * ============================================================================
 * MINESHIELD — 4D SPATIO-TEMPORAL FEATURE EXTRACTION ENGINE (LOCKED VERSION)
 * ============================================================================
 *
 * INPUT:
 *   ~1,000 mine polygons / points
 *
 * OUTPUT:
 *   20 spatial samples per mine
 *   × 36 monthly observations
 *   × ~40 environmental features
 *
 * Period:
 *   January 2023 → December 2025 (Monthly steps)
 *
 * Features:
 *   - Static Terrain (NASA NASADEM)
 *   - Current Month Sentinel-2 Optical (NDVI, EVI, NDMI, NDWI, BSI, Rock Exposure)
 *   - Current Month Sentinel-1 SAR (VV, VH, VV-VH Diff, StdDev, Temporal Changes)
 *   - Current Month Weather & Soil Moisture (ERA5-Land)
 *   - Preceding Lookback Windows CHIRPS Rainfall (3d, 7d, 14d, 30d, 60d, Max, Heavy Days)
 *   - Land Cover (ESA WorldCover 2021)
 *
 * Exports:
 *   MineShield_4D_Dataset_2023.csv
 *   MineShield_4D_Dataset_2024.csv
 *   MineShield_4D_Dataset_2025.csv
 * ============================================================================
 */


// ============================================================================
// 1. CONFIGURATION
// ============================================================================

var MINE_ASSET_ID =
    "projects/angular-array-498017-n1/assets/india_mining_polygons";

var START_YEAR = 2023;
var END_YEAR   = 2025;

var NUM_SPATIAL_SAMPLES = 20;

var mineCollection = ee.FeatureCollection(MINE_ASSET_ID);

print("==========================================");
print("MINESHIELD 4D FEATURE ENGINE (LOCKED)");
print("==========================================");

print("Total mine features:", mineCollection.size());
print("Example mine:", mineCollection.first());


// ============================================================================
// 2. CREATE 20 REPRODUCIBLE SPATIAL SAMPLES PER MINE
// ============================================================================

var structuredSamples = mineCollection.map(function(mine) {

  var geom = mine.geometry();

  var area = ee.Number(
      ee.Algorithms.If(
        mine.propertyNames().contains("Area_km2"),
        mine.get("Area_km2"),
        0.5
      )
  );

  // Convert area to approximate radius
  var radius = ee.Number(
      area.multiply(1000000)
           .divide(Math.PI)
           .sqrt()
  ).max(200);

  var isPoint = geom.type().equals("Point");

  var samplingGeometry = ee.Geometry(
      ee.Algorithms.If(
        isPoint,
        geom.buffer(radius),
        geom
      )
  );

  // 20 reproducible spatial points per mine
  var points = ee.FeatureCollection.randomPoints({
    region: samplingGeometry,
    points: NUM_SPATIAL_SAMPLES,
    seed: 42,
    maxError: 10
  });

  // Copy mine metadata to every spatial sample
  return points.map(function(point) {

    var coords = point.geometry().coordinates();

    return point.set({
      "mine_id": mine.get("mine_id"),
      "state": mine.get("state"),
      "mine_type": mine.get("mine_type"),
      "Area_km2": area,

      "LONGITUDE": coords.get(0),
      "LATITUDE": coords.get(1)
    });

  });

}).flatten();


print("Spatial sample count:", structuredSamples.size());
print("Expected approximately:",
      mineCollection.size().multiply(NUM_SPATIAL_SAMPLES));

Map.centerObject(mineCollection, 5);

Map.addLayer(
  mineCollection,
  {color: "red"},
  "Mine Locations"
);

Map.addLayer(
  structuredSamples.limit(5000),
  {color: "yellow"},
  "Spatial Samples"
);


// ============================================================================
// 3. STATIC TERRAIN FEATURES
// ============================================================================

var dem = ee.Image("NASA/NASADEM_HGT/001")
    .select("elevation");

var slope = ee.Terrain.slope(dem);

var aspect = ee.Terrain.aspect(dem);


// Local elevation variability
var elevationStd = dem.reduceNeighborhood({
  reducer: ee.Reducer.stdDev(),
  kernel: ee.Kernel.square(3)
}).rename("Elevation_stdDev");


// Local slope variability
var slopeStd = slope.reduceNeighborhood({
  reducer: ee.Reducer.stdDev(),
  kernel: ee.Kernel.square(3)
}).rename("Slope_stdDev");


// Local mean elevation
var meanElevation3 = dem.reduceNeighborhood({
  reducer: ee.Reducer.mean(),
  kernel: ee.Kernel.square(3)
});

var meanElevation11 = dem.reduceNeighborhood({
  reducer: ee.Reducer.mean(),
  kernel: ee.Kernel.square(11)
});


// Terrain Ruggedness Index proxy
var tri = dem
    .subtract(meanElevation3)
    .abs()
    .rename("TRI");


// Topographic Position Index
var tpi = dem
    .subtract(meanElevation11)
    .rename("TPI");


// Curvature proxy
var curvature = ee.Terrain.slope(slope)
    .rename("Curvature");


// Terrain roughness
var terrainRoughness =
    elevationStd
    .divide(ee.Image.constant(1).add(slope))
    .rename("Terrain_Roughness");


var terrainStack =
    dem.rename("Elevation")
    .addBands(slope.rename("Slope"))
    .addBands(aspect.rename("Aspect"))
    .addBands(elevationStd)
    .addBands(slopeStd)
    .addBands(tri)
    .addBands(tpi)
    .addBands(curvature)
    .addBands(terrainRoughness);


// ============================================================================
// 4. LAND COVER (UPPERCASE "Map")
// ============================================================================

var landCover = ee.Image(
    "ESA/WorldCover/v200/2021"
).select("Map")
 .rename("Land_Cover");


// ============================================================================
// 5. SENTINEL-2 CLOUD MASK
// ============================================================================

function maskS2(image) {

  var scl = image.select("SCL");

  var mask = scl.neq(1)
      .and(scl.neq(3))
      .and(scl.neq(7))
      .and(scl.neq(8))
      .and(scl.neq(9))
      .and(scl.neq(10))
      .and(scl.neq(11));

  return image
      .updateMask(mask)
      .divide(10000)
      .copyProperties(image, ["system:time_start"]);
}


// ============================================================================
// 6. MONTHLY IMAGE CREATION (36 MONTHS)
// ============================================================================

var monthSequence = ee.List.sequence(
    0,
    (END_YEAR - START_YEAR + 1) * 12 - 1
);


var monthlyImages = ee.ImageCollection(
  monthSequence.map(function(n) {

    // Target Month Boundaries (e.g., Jan 1 -> Jan 31)
    var targetDate =
        ee.Date.fromYMD(START_YEAR, 1, 1)
               .advance(n, "month");

    var monthEnd =
        targetDate.advance(1, "month");

    var previousMonthStart =
        targetDate.advance(-1, "month");

    var year =
        targetDate.get("year");

    var month =
        targetDate.get("month");

    var dateString =
        targetDate.format("YYYY-MM-dd");


    // ========================================================================
    // 6A. CHIRPS RAINFALL (PRECEDING LOOKBACK WINDOWS)
    // ========================================================================

    var chirps =
        ee.ImageCollection("UCSB-CHG/CHIRPS/DAILY")
        .filterBounds(structuredSamples.geometry())
        .filterDate(
            targetDate.advance(-60, "day"),
            targetDate
        );


    var rain3d =
        chirps
        .filterDate(
            targetDate.advance(-3, "day"),
            targetDate
        )
        .sum()
        .select("precipitation")
        .rename("Rainfall_3d");


    var rain7d =
        chirps
        .filterDate(
            targetDate.advance(-7, "day"),
            targetDate
        )
        .sum()
        .select("precipitation")
        .rename("Rainfall_7d");


    var rain14d =
        chirps
        .filterDate(
            targetDate.advance(-14, "day"),
            targetDate
        )
        .sum()
        .select("precipitation")
        .rename("Rainfall_14d");


    var rain30d =
        chirps
        .filterDate(
            targetDate.advance(-30, "day"),
            targetDate
        )
        .sum()
        .select("precipitation")
        .rename("Rainfall_30d");


    var rain60d =
        chirps
        .filterDate(
            targetDate.advance(-60, "day"),
            targetDate
        )
        .sum()
        .select("precipitation")
        .rename("Rainfall_60d");


    // Maximum daily rainfall during preceding 30 days
    var maxDailyRain =
        chirps
        .filterDate(
            targetDate.advance(-30, "day"),
            targetDate
        )
        .max()
        .select("precipitation")
        .rename("Rainfall_Max_Daily");


    // Number of heavy rainfall days (>= 30mm) in preceding 30 days
    var heavyRainDays =
        chirps
        .filterDate(
            targetDate.advance(-30, "day"),
            targetDate
        )
        .map(function(image) {

          return image
              .select("precipitation")
              .gte(30)
              .rename("HeavyRain");

        })
        .sum()
        .rename("Heavy_Rain_Days");


    // ========================================================================
    // 6B. SENTINEL-2 OPTICAL (CURRENT MONTH EXACT)
    // ========================================================================

    var s2Current =
        ee.ImageCollection(
          "COPERNICUS/S2_SR_HARMONIZED"
        )
        .filterBounds(structuredSamples.geometry())
        .filterDate(
          targetDate,
          monthEnd
        )
        .filter(
          ee.Filter.lt(
            "CLOUDY_PIXEL_PERCENTAGE",
            60
          )
        )
        .map(maskS2);


    var s2Previous =
        ee.ImageCollection(
          "COPERNICUS/S2_SR_HARMONIZED"
        )
        .filterBounds(structuredSamples.geometry())
        .filterDate(
          previousMonthStart,
          targetDate
        )
        .filter(
          ee.Filter.lt(
            "CLOUDY_PIXEL_PERCENTAGE",
            60
          )
        )
        .map(maskS2);


    var s2Curr = s2Current.median();
    var s2Prev = s2Previous.median();


    // NDVI & Change
    var ndvi =
        s2Curr
        .normalizedDifference(["B8", "B4"])
        .rename("NDVI");


    var ndviPrev =
        s2Prev
        .normalizedDifference(["B8", "B4"]);


    var ndviChange =
        ndvi
        .subtract(ndviPrev)
        .rename("NDVI_Change");


    // EVI
    var evi =
        s2Curr.expression(
          "2.5 * ((NIR - RED) / " +
          "(NIR + 6 * RED - 7.5 * BLUE + 1))",
          {
            "NIR": s2Curr.select("B8"),
            "RED": s2Curr.select("B4"),
            "BLUE": s2Curr.select("B2")
          }
        )
        .rename("EVI");


    // NDMI & Change
    var ndmi =
        s2Curr
        .normalizedDifference(["B8", "B11"])
        .rename("NDMI");


    var ndmiPrev =
        s2Prev
        .normalizedDifference(["B8", "B11"]);


    var ndmiChange =
        ndmi
        .subtract(ndmiPrev)
        .rename("NDMI_Change");


    // NDWI
    var ndwi =
        s2Curr
        .normalizedDifference(["B3", "B8"])
        .rename("NDWI");


    // Bare Soil Index
    var bsi =
        s2Curr.expression(
          "((SWIR + RED) - (NIR + BLUE)) / " +
          "((SWIR + RED) + (NIR + BLUE))",
          {
            "SWIR": s2Curr.select("B11"),
            "RED": s2Curr.select("B4"),
            "NIR": s2Curr.select("B8"),
            "BLUE": s2Curr.select("B2")
          }
        )
        .rename("BSI");


    // Rock exposure
    var rockExposure =
        bsi
        .subtract(ndvi)
        .rename("Rock_Exposure");


    // ========================================================================
    // 6C. SENTINEL-1 SAR (CURRENT MONTH EXACT)
    // ========================================================================

    var s1Current =
        ee.ImageCollection(
          "COPERNICUS/S1_GRD"
        )
        .filterBounds(structuredSamples.geometry())
        .filterDate(
          targetDate,
          monthEnd
        )
        .filter(
          ee.Filter.eq(
            "instrumentMode",
            "IW"
          )
        )
        .filter(
          ee.Filter.listContains(
            "transmitterReceiverPolarisation",
            "VV"
          )
        )
        .filter(
          ee.Filter.listContains(
            "transmitterReceiverPolarisation",
            "VH"
          )
        );


    var s1Previous =
        ee.ImageCollection(
          "COPERNICUS/S1_GRD"
        )
        .filterBounds(structuredSamples.geometry())
        .filterDate(
          previousMonthStart,
          targetDate
        )
        .filter(
          ee.Filter.eq(
            "instrumentMode",
            "IW"
          )
        )
        .filter(
          ee.Filter.listContains(
            "transmitterReceiverPolarisation",
            "VV"
          )
        )
        .filter(
          ee.Filter.listContains(
            "transmitterReceiverPolarisation",
            "VH"
          )
        );


    var vv =
        s1Current
        .select("VV")
        .median()
        .rename("VV");


    var vh =
        s1Current
        .select("VH")
        .median()
        .rename("VH");


    var vvPrevious =
        s1Previous
        .select("VV")
        .median();


    var vhPrevious =
        s1Previous
        .select("VH")
        .median();


    var vvChange =
        vv
        .subtract(vvPrevious)
        .rename("VV_Change");


    var vhChange =
        vh
        .subtract(vhPrevious)
        .rename("VH_Change");


    var vvVhDifference =
        vv
        .subtract(vh)
        .rename("VV_VH_Difference");


    var vvStd =
        s1Current
        .select("VV")
        .reduce(ee.Reducer.stdDev())
        .rename("VV_stdDev");


    var vhStd =
        s1Current
        .select("VH")
        .reduce(ee.Reducer.stdDev())
        .rename("VH_stdDev");


    // ========================================================================
    // 6D. ERA5-LAND WEATHER & SOIL (CURRENT MONTH EXACT)
    // ========================================================================

    var era5 =
        ee.ImageCollection(
          "ECMWF/ERA5_LAND/MONTHLY_AGGR"
        )
        .filterDate(
          targetDate,
          monthEnd
        )
        .first();


    var temperature =
        era5
        .select("temperature_2m")
        .subtract(273.15)
        .rename("Temperature_C");


    var temperatureMin =
        era5
        .select("temperature_2m_min")
        .subtract(273.15)
        .rename("Temperature_Min_C");


    var temperatureMax =
        era5
        .select("temperature_2m_max")
        .subtract(273.15)
        .rename("Temperature_Max_C");


    var soilMoisture =
        era5
        .select("volumetric_soil_water_layer_1")
        .rename("Soil_Moisture");


    var soilMoistureMin =
        era5
        .select(
          "volumetric_soil_water_layer_1_min"
        )
        .rename("Soil_Moisture_Min");


    var soilMoistureMax =
        era5
        .select(
          "volumetric_soil_water_layer_1_max"
        )
        .rename("Soil_Moisture_Max");


    // ========================================================================
    // 6E. COMBINE ALL BANDS
    // ========================================================================

    var masterImage =
        terrainStack

        // Rainfall
        .addBands(rain3d)
        .addBands(rain7d)
        .addBands(rain14d)
        .addBands(rain30d)
        .addBands(rain60d)
        .addBands(maxDailyRain)
        .addBands(heavyRainDays)

        // Sentinel-2
        .addBands(ndvi)
        .addBands(ndviChange)
        .addBands(evi)
        .addBands(ndmi)
        .addBands(ndmiChange)
        .addBands(ndwi)
        .addBands(bsi)
        .addBands(rockExposure)

        // Sentinel-1
        .addBands(vv)
        .addBands(vh)
        .addBands(vvVhDifference)
        .addBands(vvStd)
        .addBands(vhStd)
        .addBands(vvChange)
        .addBands(vhChange)

        // Weather / soil
        .addBands(temperature)
        .addBands(temperatureMin)
        .addBands(temperatureMax)
        .addBands(soilMoisture)
        .addBands(soilMoistureMin)
        .addBands(soilMoistureMax)

        // Land cover
        .addBands(landCover);


    // Metadata Properties
    return masterImage.set({
      "OBSERVATION_DATE": dateString,
      "YEAR": year,
      "MONTH": month
    });

  })
);


// ============================================================================
// 7. FEATURE SELECTORS (LOCKED SCHEMA)
// ============================================================================

var featureSelectors = [

  // Metadata
  "mine_id",
  "state",
  "mine_type",
  "Area_km2",
  "LONGITUDE",
  "LATITUDE",

  // Time
  "OBSERVATION_DATE",

  // Terrain
  "Elevation",
  "Slope",
  "Aspect",
  "Elevation_stdDev",
  "Slope_stdDev",
  "TRI",
  "TPI",
  "Curvature",
  "Terrain_Roughness",

  // Rainfall
  "Rainfall_3d",
  "Rainfall_7d",
  "Rainfall_14d",
  "Rainfall_30d",
  "Rainfall_60d",
  "Rainfall_Max_Daily",
  "Heavy_Rain_Days",

  // Sentinel-2
  "NDVI",
  "NDVI_Change",
  "EVI",
  "NDMI",
  "NDMI_Change",
  "NDWI",
  "BSI",
  "Rock_Exposure",

  // Sentinel-1
  "VV",
  "VH",
  "VV_VH_Difference",
  "VV_stdDev",
  "VH_stdDev",
  "VV_Change",
  "VH_Change",

  // Weather / soil
  "Temperature_C",
  "Temperature_Min_C",
  "Temperature_Max_C",
  "Soil_Moisture",
  "Soil_Moisture_Min",
  "Soil_Moisture_Max",

  // Land cover
  "Land_Cover"
];


// ============================================================================
// 8. YEARLY EXPORTS (OPTIMIZED FOR BATCH PROCESSING)
// ============================================================================

[2023, 2024, 2025].forEach(function(year) {

  var yearImages =
      monthlyImages.filter(
        ee.Filter.eq("YEAR", year)
      );


  var yearFeatures =
      yearImages.map(function(image) {

        var dateString =
            image.get("OBSERVATION_DATE");


        var samples =
            image.sampleRegions({
              collection: structuredSamples,
              scale: 30,
              geometries: false,
              tileScale: 4
            });


        return samples.map(function(feature) {

          return feature.set({
            "OBSERVATION_DATE": dateString
          });

        });

      }).flatten();


  // NOTE: Interactive print(yearFeatures.size()) removed to prevent browser memory limits.

  Export.table.toDrive({
    collection: yearFeatures,
    description:
      "MineShield_4D_Dataset_" + year,

    folder:
      "MineShield_GEE",

    fileNamePrefix:
      "MineShield_4D_Dataset_" + year,

    fileFormat:
      "CSV",

    selectors:
      featureSelectors,

    maxVertices:
      100000
  });

});


print("==========================================");
print("ALL 3 EXPORT TASKS CREATED SUCCESSFULLY");
print("==========================================");
print("Check the 'Tasks' tab on the right to start the export jobs.");
print("2023 → MineShield_4D_Dataset_2023.csv");
print("2024 → MineShield_4D_Dataset_2024.csv");
print("2025 → MineShield_4D_Dataset_2025.csv");
print("==========================================");