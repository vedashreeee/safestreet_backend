BEGIN;

ALTER TABLE reports
ADD COLUMN IF NOT EXISTS location_name TEXT;

ALTER TABLE reports
ADD COLUMN IF NOT EXISTS capture_lat DECIMAL(10, 7);

ALTER TABLE reports
ADD COLUMN IF NOT EXISTS capture_lng DECIMAL(10, 7);

ALTER TABLE reports
ADD COLUMN IF NOT EXISTS capture_accuracy DECIMAL(8, 2);

ALTER TABLE reports
ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ;

ALTER TABLE reports
ADD COLUMN IF NOT EXISTS capture_method VARCHAR(30) DEFAULT 'live_camera';

ALTER TABLE reports
ADD COLUMN IF NOT EXISTS geolocation_captured BOOLEAN DEFAULT FALSE;

ALTER TABLE reports
ADD COLUMN IF NOT EXISTS ml_severity VARCHAR(30);

ALTER TABLE reports
ADD COLUMN IF NOT EXISTS ml_confidence DECIMAL(6, 4);

ALTER TABLE reports
ADD COLUMN IF NOT EXISTS cvi_verified BOOLEAN DEFAULT FALSE;

ALTER TABLE reports
ADD COLUMN IF NOT EXISTS evidence_pdf_url TEXT;

ALTER TABLE danger_zones
ADD COLUMN IF NOT EXISTS location_name TEXT;

ALTER TABLE reports
ADD COLUMN IF NOT EXISTS danger_zone_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE c.conname = 'fk_reports_danger_zone'
      AND t.relname = 'reports'
  ) THEN
    ALTER TABLE reports
    ADD CONSTRAINT fk_reports_danger_zone
    FOREIGN KEY (danger_zone_id)
    REFERENCES danger_zones(id)
    ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE reports
ADD COLUMN IF NOT EXISTS severity_score INTEGER DEFAULT 0;

ALTER TABLE reports
ADD COLUMN IF NOT EXISTS is_pothole BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_reports_danger_zone
  ON reports (danger_zone_id)
  WHERE danger_zone_id IS NOT NULL;

COMMIT;