-- ================================================================
-- SafeStreet — PostgreSQL Schema
-- Run this file once to create all tables:
--   psql -U postgres -d safestreet -f schema.sql
-- ================================================================

-- Enable PostGIS extension if available (optional, falls back to Haversine)
-- CREATE EXTENSION IF NOT EXISTS postgis;

-- ── Reports table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id       VARCHAR(20) UNIQUE NOT NULL,  -- Human-readable: SS-123456
  lat             DECIMAL(10, 7) NOT NULL,
  lng             DECIMAL(10, 7) NOT NULL,
  hazard_type     VARCHAR(30) NOT NULL
                    CHECK (hazard_type IN ('pothole','speedbreaker','blindcurve','lighting','collapse')),
  photo_url       TEXT,                          -- Relative path to uploaded photo
  phone           VARCHAR(15),                   -- Optional reporter phone
  status          VARCHAR(20) NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received','under_review','complaint_sent','under_repair','resolved')),
  cluster_id      INTEGER,                       -- Set by DBSCAN engine
  sms_sent        BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Spatial index for fast radius queries
CREATE INDEX IF NOT EXISTS idx_reports_location
  ON reports (lat, lng);

CREATE INDEX IF NOT EXISTS idx_reports_created_at
  ON reports (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reports_status
  ON reports (status);

CREATE INDEX IF NOT EXISTS idx_reports_cluster
  ON reports (cluster_id)
  WHERE cluster_id IS NOT NULL;

-- ── Danger zones table (output of DBSCAN) ───────────────────────
CREATE TABLE IF NOT EXISTS danger_zones (
  id              SERIAL PRIMARY KEY,
  cluster_id      INTEGER UNIQUE NOT NULL,
  center_lat      DECIMAL(10, 7) NOT NULL,
  center_lng      DECIMAL(10, 7) NOT NULL,
  hazard_type     VARCHAR(30) NOT NULL,          -- Most common hazard type in cluster
  report_count    INTEGER NOT NULL DEFAULT 0,
  severity        VARCHAR(20) NOT NULL DEFAULT 'verified'
                    CHECK (severity IN ('verified','critical')),
  status          VARCHAR(20) NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','complaint_sent','under_repair','resolved')),
  complaint_pdf_url TEXT,                        -- Path to generated PDF
  complaint_sent_at TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_danger_zones_location
  ON danger_zones (center_lat, center_lng);

CREATE INDEX IF NOT EXISTS idx_danger_zones_status
  ON danger_zones (status);

-- ── Complaint letters table ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS complaints (
  id              SERIAL PRIMARY KEY,
  danger_zone_id  INTEGER NOT NULL REFERENCES danger_zones(id) ON DELETE CASCADE,
  pdf_url         TEXT NOT NULL,
  report_count    INTEGER NOT NULL,
  hazard_type     VARCHAR(30) NOT NULL,
  center_lat      DECIMAL(10, 7) NOT NULL,
  center_lng      DECIMAL(10, 7) NOT NULL,
  acknowledged    BOOLEAN DEFAULT FALSE,
  acknowledged_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_complaints_zone
  ON complaints (danger_zone_id);

CREATE INDEX IF NOT EXISTS idx_complaints_acknowledged
  ON complaints (acknowledged);

-- ── Secretary users table ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  username        VARCHAR(50) UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  role            VARCHAR(20) NOT NULL DEFAULT 'secretary'
                    CHECK (role IN ('secretary','admin')),
  name            TEXT,
  phone           VARCHAR(15),
  last_login      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── SMS log table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_log (
  id              SERIAL PRIMARY KEY,
  phone           VARCHAR(15) NOT NULL,
  message_type    VARCHAR(30) NOT NULL,   -- 'confirmation' | 'resolution'
  message         TEXT NOT NULL,
  report_id       VARCHAR(20),
  twilio_sid      TEXT,
  status          VARCHAR(20) DEFAULT 'sent',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Auto-update updated_at trigger ──────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER reports_updated_at
  BEFORE UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER danger_zones_updated_at
  BEFORE UPDATE ON danger_zones
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Default secretary account ────────────────────────────────────
-- Password: secretary123 (bcrypt hash — change in production!)
INSERT INTO users (username, password_hash, role, name)
VALUES (
  'secretary',
  '$2b$10$YourHashHere',  -- Run utils/createAdmin.js to generate proper hash
  'secretary',
  'Gram Panchayat Secretary'
) ON CONFLICT (username) DO NOTHING;

-- ================================================================
-- Done. Tables created:
--   reports, danger_zones, complaints, users, sms_log
-- ================================================================
