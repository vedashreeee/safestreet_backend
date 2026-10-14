const express  = require('express')
const multer   = require('multer')
const router   = express.Router()
const pool     = require('../db')
const { runClustering } = require('../clustering')
const cloudinary = require('../cloudinary')

/* =========================================
   MEMORY STORAGE
   Hold the image in RAM, then push to Cloudinary
========================================= */
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit

/* =========================================
   CREATE REPORT (Now with ML Severity Scoring)
========================================= */
router.post('/', upload.single('photo'), async (req, res) => {
  try {
    const {
      lat,
      lng,
      hazard,
      phone,
      address,
      capture_lat,
      capture_lng,
      capture_accuracy,
      captured_at,
      capture_method,
      geolocation_captured
    } = req.body

    if (!lat || !lng || !hazard) {
      return res.status(400).json({ success: false, error: 'Missing required fields' })
    }

    const parsedCaptureLat = capture_lat !== undefined && capture_lat !== '' && !isNaN(parseFloat(capture_lat))
      ? parseFloat(capture_lat)
      : null
    const parsedCaptureLng = capture_lng !== undefined && capture_lng !== '' && !isNaN(parseFloat(capture_lng))
      ? parseFloat(capture_lng)
      : null
    const parsedCaptureAccuracy = capture_accuracy !== undefined && capture_accuracy !== '' && !isNaN(parseFloat(capture_accuracy))
      ? parseFloat(capture_accuracy)
      : null
    const parsedCapturedAt = captured_at
      ? new Date(captured_at)
      : (req.file ? new Date() : null)
    const parsedCaptureMethod = capture_method || (req.file ? 'live_camera' : null)
    const isGeolocationCaptured = geolocation_captured === true || geolocation_captured === 'true' || geolocation_captured === 1 || geolocation_captured === '1'
      || (parsedCaptureLat !== null && parsedCaptureLng !== null)

    let photoUrl = null;

    // 1. --- SAFELY UPLOAD FROM RAM TO CLOUDINARY ---
    if (req.file) {
      photoUrl = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'safestreet/photos' },
          (error, result) => {
            if (error) reject(error);
            else resolve(result.secure_url);
          }
        );
        // Push the file buffer (RAM) into Cloudinary
        stream.end(req.file.buffer);
      });
    }

    // 2. --- ASK PYTHON FOR THE SEVERITY SCORE ---
    let severityScore = 0;
    let isPothole = false;
    let severityLevel = null;
    let mlConfidence = null;
    let cviVerified = false;

    // We only call the Flask ML server if a photo was actually uploaded
    if (photoUrl) {
      try {
        console.log(`🤖 Sending image to Python ML server for analysis...`);

        const rawMlUrl = process.env.ML_SERVICE_URL || 'http://127.0.0.1:5001/analyse';
        const mlEndpoint = rawMlUrl.endsWith('/analyse')
          ? rawMlUrl
          : `${rawMlUrl.replace(/\/+$/, '')}/analyse`;

        const mlResponse = await fetch(mlEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageUrl: photoUrl })
        });

        if (!mlResponse.ok) {
          throw new Error(`ML server returned HTTP ${mlResponse.status}: ${mlResponse.statusText}`);
        }

        const mlData = await mlResponse.json();

        if (mlData && mlData.is_pothole) {
          isPothole = Boolean(mlData.is_pothole);
          severityScore = Number.isFinite(Number(mlData.severity_score)) ? Number(mlData.severity_score) : 0;
          severityLevel = mlData.severity_level || null;
          cviVerified = true;
          if (mlData.confidence != null && !isNaN(Number(mlData.confidence))) {
            mlConfidence = Number(mlData.confidence);
          }
          console.log(`🎯 ML Score Calculated: ${severityScore} (${severityLevel})`);
        } else if (mlData) {
          isPothole = false;
          severityScore = Number.isFinite(Number(mlData.severity_score)) ? Number(mlData.severity_score) : 0;
          severityLevel = mlData.severity_level || 'none';
          cviVerified = false;
          if (mlData.confidence != null && !isNaN(Number(mlData.confidence))) {
            mlConfidence = Number(mlData.confidence);
          }
          console.log(`🎯 ML Result: No pothole detected in image.`);
        }
      } catch (mlErr) {
        console.error('⚠️ ML Server connection failed or timed out:', mlErr.message);
        // Do not fabricate prediction values or pretend a prediction succeeded
        severityScore = 0;
        severityLevel = null;
        isPothole = false;
        cviVerified = false;
        mlConfidence = null;
      }
    }

    const reportId = 'SS-' + Math.floor(100000 + Math.random() * 900000)
    const placeName = address || `GPS: ${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`;

    // 3. --- INSERT REPORT INTO POSTGRESQL (With ML & Evidence Columns) ---
    const result = await pool.query(
      `
      INSERT INTO reports
      (
        report_id,
        lat,
        lng,
        hazard_type,
        phone,
        photo_url,
        status,
        location_name,
        created_at,
        severity_score,
        is_pothole,
        capture_lat,
        capture_lng,
        capture_accuracy,
        captured_at,
        capture_method,
        geolocation_captured,
        ml_severity,
        ml_confidence,
        cvi_verified
      )
      VALUES
      (
        $1, $2, $3, $4, $5, $6, 'received', $7, NOW(), $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17, $18
      )
      RETURNING *
      `,
      [
        reportId,
        lat,
        lng,
        hazard,
        phone || null,
        photoUrl,
        placeName,
        severityScore,
        isPothole,
        parsedCaptureLat,
        parsedCaptureLng,
        parsedCaptureAccuracy,
        parsedCapturedAt,
        parsedCaptureMethod,
        isGeolocationCaptured,
        severityLevel,
        mlConfidence,
        cviVerified
      ]
    )

    console.log(`✅ Report created: ${reportId} at ${placeName}`)

    try {
      await runClustering()
    } catch (clusterErr) {
      console.error('CLUSTERING ERROR:', clusterErr)
    }

    res.json({
      success: true,
      reportId,
      report: result.rows[0],
      photoUrl,
      ml_data: { severityScore, severityLevel }
    })

  } catch (err) {
    console.error('REPORT ERROR:', err)
    res.status(500).json({ success: false, error: err.message || 'Server Error' })
  }
})

/* =========================================
   GET ALL REPORTS
========================================= */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        r.*,
        COALESCE(dz.location_name, r.location_name) AS location_name
      FROM reports r
      LEFT JOIN danger_zones dz
        ON r.danger_zone_id = dz.id
      ORDER BY r.created_at DESC
      `
    )
    res.json(result.rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ success: false, error: err.message })
  }
})

module.exports = router