-- MineShield Supabase / PostgreSQL Schema
-- Project ID: pwycckoqmmmczsvpqgak
-- Enables PostGIS extension for geospatial features
CREATE EXTENSION IF NOT EXISTS postgis;

-- 1. MINES TABLE
CREATE TABLE IF NOT EXISTS mines (
    mine_id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    location GEOMETRY(Point, 4326),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for spatial queries on mines
CREATE INDEX IF NOT EXISTS mines_location_idx ON mines USING GIST (location);

-- 2. WORKERS TABLE
CREATE TABLE IF NOT EXISTS workers (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    mobile VARCHAR(15),
    email VARCHAR(100),
    role VARCHAR(50) CHECK (role IN ('Worker', 'Supervisor', 'Safety Officer', 'Administrator')),
    status VARCHAR(50) DEFAULT 'Safe' CHECK (status IN ('Safe', 'Monitoring', 'At Risk', 'Evacuating', 'Reached Safe Zone')),
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    location GEOMETRY(Point, 4326),
    speed_kmh DOUBLE PRECISION DEFAULT 0.0,
    battery INT DEFAULT 100,
    heading INT DEFAULT 0,
    distance_to_safe_zone_m DOUBLE PRECISION,
    last_update TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for spatial queries on workers
CREATE INDEX IF NOT EXISTS workers_location_idx ON workers USING GIST (location);

-- 3. SENSORS TABLE
CREATE TABLE IF NOT EXISTS sensors (
    id VARCHAR(50) PRIMARY KEY,
    type VARCHAR(100) NOT NULL, -- 'Pore Pressure', 'Slope Tilt', 'Crack Width', 'Vibration', 'Rain Gauge'
    unit VARCHAR(10) NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    location GEOMETRY(Point, 4326),
    value DOUBLE PRECISION NOT NULL,
    threshold DOUBLE PRECISION NOT NULL,
    status VARCHAR(20) DEFAULT 'OK' CHECK (status IN ('OK', 'WARNING', 'CRITICAL')),
    trend DOUBLE PRECISION DEFAULT 0.0,
    last_update TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS sensors_location_idx ON sensors USING GIST (location);

-- 4. SENSOR READINGS TABLE (Historical telemetry)
CREATE TABLE IF NOT EXISTS sensor_readings (
    id BIGSERIAL PRIMARY KEY,
    sensor_id VARCHAR(50) REFERENCES sensors(id) ON DELETE CASCADE,
    value DOUBLE PRECISION NOT NULL,
    status VARCHAR(20) NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS sensor_readings_sensor_id_timestamp_idx ON sensor_readings(sensor_id, timestamp DESC);

-- 5. SAFE ZONES TABLE
CREATE TABLE IF NOT EXISTS safe_zones (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    location GEOMETRY(Point, 4326),
    polygon GEOMETRY(Polygon, 4326), -- Optional specific safe zone boundary
    radius_m DOUBLE PRECISION DEFAULT 50.0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS safe_zones_location_idx ON safe_zones USING GIST (location);

-- 6. ALERTS TABLE (Intelligent alerts with AI verification)
CREATE TABLE IF NOT EXISTS alerts (
    id VARCHAR(50) PRIMARY KEY,
    level VARCHAR(20) NOT NULL CHECK (level IN ('INFO', 'WARNING', 'HIGH', 'CRITICAL')),
    type VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    location_desc VARCHAR(255) NOT NULL,
    time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    action TEXT,
    is_anomaly BOOLEAN DEFAULT FALSE,
    confidence_score DOUBLE PRECISION DEFAULT 1.0,
    reasoning TEXT,
    acknowledged BOOLEAN DEFAULT FALSE,
    dismissed BOOLEAN DEFAULT FALSE
);

-- 7. RISK PREDICTIONS TABLE (AI Rockfall predictions)
CREATE TABLE IF NOT EXISTS risk_predictions (
    id BIGSERIAL PRIMARY KEY,
    mine_id VARCHAR(50) REFERENCES mines(mine_id) ON DELETE CASCADE,
    observation_date DATE NOT NULL,
    vulnerability_probability DOUBLE PRECISION NOT NULL,
    risk_level VARCHAR(20) NOT NULL, -- 'LOW', 'MODERATE', 'HIGH', 'CRITICAL'
    confidence_score DOUBLE PRECISION NOT NULL,
    contributing_factors JSONB, -- Shapley features and impact
    recommendations JSONB, -- Recommended actions
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. INCIDENT REPORTS TABLE
CREATE TABLE IF NOT EXISTS incident_reports (
    id VARCHAR(50) PRIMARY KEY,
    alert_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    worker_id VARCHAR(50) REFERENCES workers(id) ON DELETE SET NULL,
    worker_name VARCHAR(100),
    worker_role VARCHAR(50),
    sensor_analysis JSONB, -- Outlier/Anomalies data
    ai_prediction JSONB, -- Rockfall risk factors
    evacuation_timeline JSONB, -- Alert time, safe zone entry time
    safe_zone_confirmation BOOLEAN DEFAULT FALSE,
    preventive_actions TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 9. NOTIFICATIONS LOG
CREATE TABLE IF NOT EXISTS notifications_log (
    id BIGSERIAL PRIMARY KEY,
    worker_id VARCHAR(50) REFERENCES workers(id) ON DELETE CASCADE,
    type VARCHAR(10) CHECK (type IN ('SMS', 'EMAIL', 'IN-APP')),
    message TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'Sent',
    sent_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Spatial Geometry triggers to auto-populate point geometry columns from lat/lon
CREATE OR REPLACE FUNCTION update_geometry_from_coords()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
        NEW.location := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply triggers
CREATE OR REPLACE TRIGGER update_mine_geom BEFORE INSERT OR UPDATE ON mines
    FOR EACH ROW EXECUTE FUNCTION update_geometry_from_coords();

CREATE OR REPLACE TRIGGER update_worker_geom BEFORE INSERT OR UPDATE ON workers
    FOR EACH ROW EXECUTE FUNCTION update_geometry_from_coords();

CREATE OR REPLACE TRIGGER update_sensor_geom BEFORE INSERT OR UPDATE ON sensors
    FOR EACH ROW EXECUTE FUNCTION update_geometry_from_coords();

CREATE OR REPLACE TRIGGER update_safe_zone_geom BEFORE INSERT OR UPDATE ON safe_zones
    FOR EACH ROW EXECUTE FUNCTION update_geometry_from_coords();


-- SEED DATA
-- Insert default mines
INSERT INTO mines (mine_id, name, latitude, longitude) VALUES
('MINE-OB-001', 'Odisha Bauxite Mine — Sector 7', 20.5937, 83.9629),
('MINE-JH-001', 'Jharkhand Iron & Steel Mine — Pit A', 23.6102, 85.2799),
('MINE-RJ-001', 'Rajasthan Marble Mine — Quarry 4', 25.2138, 75.8648)
ON CONFLICT (mine_id) DO NOTHING;

-- Insert safe zones near default mine
INSERT INTO safe_zones (id, name, latitude, longitude, radius_m) VALUES
('SZ-OB-001', 'Odisha Central Admin Safe Zone', 20.5925, 83.9600, 100.0),
('SZ-OB-002', 'Sector 7 Emergency Muster Point', 20.5950, 83.9650, 80.0)
ON CONFLICT (id) DO NOTHING;

-- Insert sensors
INSERT INTO sensors (id, type, unit, latitude, longitude, value, threshold) VALUES
('S001', 'Pore Pressure', 'kPa', 20.5941, 83.9633, 145.2, 300.0),
('S002', 'Slope Tilt', '°', 20.5945, 83.9626, 1.2, 4.5),
('S003', 'Crack Width', 'mm', 20.5949, 83.9620, 0.5, 12.0),
('S004', 'Vibration', 'mm/s', 20.5953, 83.9614, 1.8, 6.0),
('S005', 'Rain Gauge', 'mm', 20.5957, 83.9608, 12.5, 100.0)
ON CONFLICT (id) DO NOTHING;

-- Insert workers
INSERT INTO workers (id, name, mobile, email, role, status, latitude, longitude) VALUES
('W001', 'Arjun Sharma', '+919876543210', 'arjun.sharma@mineshield.local', 'Worker', 'Safe', 20.5938, 83.9630),
('W002', 'Priya Mehta', '+919876543211', 'priya.mehta@mineshield.local', 'Supervisor', 'Safe', 20.5935, 83.9635),
('W003', 'Ravi Kumar', '+919876543212', 'ravi.kumar@mineshield.local', 'Worker', 'Safe', 20.5939, 83.9625)
ON CONFLICT (id) DO NOTHING;
