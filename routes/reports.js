const express  = require('express')
const multer   = require('multer')
const router   = express.Router()
const pool     = require('../db')
const { runClustering } = require('../clustering')
const { generateReportEvidencePDF } = require('../pdfGenerator')
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

    const reportRecord = result.rows[0];
    console.log(`✅ Report created: ${reportId} at ${placeName}`);

    // 4. --- GENERATE INDIVIDUAL EVIDENCE PDF ---
    let evidencePdfUrl = null;
    try {
      console.log(`📄 Generating Evidence PDF for report ${reportId}...`);
      const pdfResult = await generateReportEvidencePDF({
        ...reportRecord,
        photo_url: photoUrl,
        location_name: placeName,
        ml_severity: severityLevel,
        ml_confidence: mlConfidence,
        cvi_verified: cviVerified,
        severity_score: severityScore,
        is_pothole: isPothole
      });

      evidencePdfUrl = (pdfResult?.pdfUrl && typeof pdfResult.pdfUrl === 'string' && pdfResult.pdfUrl.startsWith('http'))
        ? pdfResult.pdfUrl
        : null;

      if (evidencePdfUrl) {
        console.log(`✅ Evidence PDF uploaded to cloud storage for ${reportId}: ${evidencePdfUrl}`);
        const updateResult = await pool.query(
          `
          UPDATE reports
          SET evidence_pdf_url = $1, updated_at = NOW()
          WHERE report_id = $2
          RETURNING *
          `,
          [evidencePdfUrl, reportId]
        );

        if (updateResult.rows.length > 0) {
          result.rows[0] = updateResult.rows[0];
          console.log(`💾 Persisted evidence_pdf_url for ${reportId} to database`);
        } else {
          result.rows[0].evidence_pdf_url = evidencePdfUrl;
        }
      } else {
        console.warn(`⚠️ Evidence PDF cloud upload unavailable for report ${reportId} (${pdfResult?.error || 'No public URL returned'}). PDF URL will not be persisted to ephemeral storage.`);
      }
    } catch (pdfErr) {
      console.error(`⚠️ Evidence PDF generation failed for report ${reportId}:`, pdfErr.message);
      // Non-fatal: Report was already safely created
    }

    try {
      await runClustering();
    } catch (clusterErr) {
      console.error('CLUSTERING ERROR:', clusterErr);
    }

    res.json({
      success: true,
      reportId,
      report: result.rows[0],
      photoUrl,
      evidence_pdf_url: evidencePdfUrl,
      evidencePdfUrl: evidencePdfUrl,
      ml_data: { severityScore, severityLevel }
    });

  } catch (err) {
    console.error('REPORT ERROR:', err);
    res.status(500).json({ success: false, error: err.message || 'Server Error' });
  }
});

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
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* =========================================
   GET / GENERATE INDIVIDUAL EVIDENCE PDF ON DEMAND
========================================= */
router.get('/:id/evidence-pdf', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `
      SELECT
        r.*,
        COALESCE(dz.location_name, r.location_name) AS location_name
      FROM reports r
      LEFT JOIN danger_zones dz
        ON r.danger_zone_id = dz.id
      WHERE r.report_id = $1 OR r.id::text = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }

    const report = result.rows[0];

    // If PDF URL already exists and is a valid public HTTP(S) URL, redirect to it
    if (report.evidence_pdf_url && typeof report.evidence_pdf_url === 'string' && report.evidence_pdf_url.startsWith('http')) {
      return res.redirect(report.evidence_pdf_url);
    }

    // Generate on demand for older reports or reports without a public URL
    console.log(`📄 Generating Evidence PDF on demand for report ${report.report_id}...`);
    const pdfResult = await generateReportEvidencePDF(report);
    const evidencePdfUrl = (pdfResult?.pdfUrl && typeof pdfResult.pdfUrl === 'string' && pdfResult.pdfUrl.startsWith('http'))
      ? pdfResult.pdfUrl
      : null;

    if (evidencePdfUrl) {
      await pool.query(
        `
        UPDATE reports
        SET evidence_pdf_url = $1, updated_at = NOW()
        WHERE report_id = $2
        `,
        [evidencePdfUrl, report.report_id]
      );
      console.log(`💾 Persisted on-demand evidence_pdf_url for ${report.report_id} to database`);
      return res.redirect(evidencePdfUrl);
    }

    // If Cloudinary upload failed or is unconfigured, return a clear error instead of a broken local link
    return res.status(503).json({
      success: false,
      error: `Evidence PDF unavailable: ${pdfResult?.error || 'Cloud storage upload failed or is not configured'}`
    });
  } catch (err) {
    console.error('EVIDENCE PDF ON DEMAND ERROR:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;