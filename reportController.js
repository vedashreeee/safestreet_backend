// controllers/reportController.js

const pool = require('./db')
const { sendSMS } = require('./sms')
const path = require('path')

// ── Generate human-readable report ID ───────────────────────────
function generateReportId() {
  const num = Math.floor(100000 + Math.random() * 900000)
  return `SS-${num}`
}

// ── Convert different boolean formats safely ────────────────────
function isTrue(value) {
  return (
    value === true ||
    value === 'true' ||
    value === 1 ||
    value === '1'
  )
}

// ── POST /api/reports — Submit a new pothole report ──────────────
async function submitReport(req, res) {
  try {
    const {
      lat,
      lng,
      hazard,
      phone,
      address,

      // Live-camera evidence metadata
      capture_lat,
      capture_lng,
      capture_accuracy,
      captured_at,
      capture_method,
      geolocation_captured,

      // CVI / ML results
      ml_severity,
      ml_confidence,
      cvi_verified
    } = req.body

    // ────────────────────────────────────────────────────────────
    // 1. Validate report location
    // ────────────────────────────────────────────────────────────

    const parsedLat = parseFloat(lat)
    const parsedLng = parseFloat(lng)

    if (isNaN(parsedLat) || isNaN(parsedLng)) {
      return res.status(400).json({
        error: 'Valid latitude and longitude coordinates are required'
      })
    }

    if (
      parsedLat < 12 ||
      parsedLat > 20 ||
      parsedLng < 76 ||
      parsedLng > 85
    ) {
      return res.status(400).json({
        error: 'Coordinates appear to be outside Andhra Pradesh'
      })
    }

    // ────────────────────────────────────────────────────────────
    // 2. Only POTHOLE is allowed
    // ────────────────────────────────────────────────────────────

    if (hazard !== 'pothole') {
      return res.status(400).json({
        error: 'Currently only pothole reports are supported'
      })
    }

    // ────────────────────────────────────────────────────────────
    // 3. Validate live camera capture
    // ────────────────────────────────────────────────────────────

    if (capture_method !== 'live_camera') {
      return res.status(400).json({
        error: 'Evidence must be captured using the live camera'
      })
    }

    // ────────────────────────────────────────────────────────────
    // 4. Validate GPS geolocation
    // ────────────────────────────────────────────────────────────

    if (!isTrue(geolocation_captured)) {
      return res.status(400).json({
        error: 'GPS geolocation is required for evidence capture'
      })
    }

    const parsedCaptureLat = parseFloat(capture_lat)
    const parsedCaptureLng = parseFloat(capture_lng)
    const parsedAccuracy = parseFloat(capture_accuracy)

    if (
      isNaN(parsedCaptureLat) ||
      isNaN(parsedCaptureLng)
    ) {
      return res.status(400).json({
        error: 'Valid capture GPS coordinates are required'
      })
    }

    if (
      parsedCaptureLat < 12 ||
      parsedCaptureLat > 20 ||
      parsedCaptureLng < 76 ||
      parsedCaptureLng > 85
    ) {
      return res.status(400).json({
        error: 'Capture coordinates appear to be outside Andhra Pradesh'
      })
    }

    // ────────────────────────────────────────────────────────────
    // 5. Generate report ID
    // ────────────────────────────────────────────────────────────

    const reportId = generateReportId()

    // ────────────────────────────────────────────────────────────
    // 6. Build photo URL
    // ────────────────────────────────────────────────────────────

    let photoUrl = null

    if (req.file) {
      const relativePath = req.file.path
        .replace(path.join(__dirname, '..'), '')
        .replace(/\\/g, '/')

      photoUrl = relativePath.startsWith('/')
        ? relativePath
        : '/' + relativePath
    }

    // Live camera evidence is mandatory.
    if (!req.file) {
      return res.status(400).json({
        error: 'A live camera evidence photo is required'
      })
    }

    // ────────────────────────────────────────────────────────────
    // 7. Clean phone number
    // ────────────────────────────────────────────────────────────

    const cleanPhone = phone
      ? phone.replace(/\D/g, '').slice(-10)
      : null

    const fullPhone = cleanPhone
      ? `+91${cleanPhone}`
      : null

    // ────────────────────────────────────────────────────────────
    // 8. Insert report into PostgreSQL
    // ────────────────────────────────────────────────────────────

    const result = await pool.query(
      `INSERT INTO reports
      (
        report_id,
        lat,
        lng,
        hazard_type,
        photo_url,
        phone,
        location_name,

        capture_lat,
        capture_lng,
        capture_accuracy,
        captured_at,
        capture_method,
        geolocation_captured,

        ml_severity,
        ml_confidence,
        cvi_verified,

        status
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,

        $8,
        $9,
        $10,
        $11,
        $12,
        $13,

        $14,
        $15,
        $16,

        'received'
      )
      RETURNING
        id,
        report_id,
        lat,
        lng,
        hazard_type,
        photo_url,
        phone,
        location_name,

        capture_lat,
        capture_lng,
        capture_accuracy,
        captured_at,
        capture_method,
        geolocation_captured,

        ml_severity,
        ml_confidence,
        cvi_verified,

        status,
        created_at`,
      [
        reportId,
        parsedLat,
        parsedLng,
        hazard,
        photoUrl,
        fullPhone,
        address || null,

        parsedCaptureLat,
        parsedCaptureLng,
        isNaN(parsedAccuracy) ? null : parsedAccuracy,
        captured_at ? new Date(captured_at) : new Date(),
        capture_method,
        true,

        ml_severity || null,
        ml_confidence || null,
        isTrue(cvi_verified)
      ]
    )

    const report = result.rows[0]

    // ────────────────────────────────────────────────────────────
    // 9. Send SMS confirmation
    // ────────────────────────────────────────────────────────────

    if (fullPhone) {
      sendSMS(
        fullPhone,
        'confirmation',
        reportId
      ).catch(err => {
        console.warn(
          `SMS failed for ${fullPhone}:`,
          err.message
        )
      })
    }

    // ────────────────────────────────────────────────────────────
    // 10. Count nearby reports
    //     This is ONLY informational.
    //     It does NOT wait for 5 reports.
    // ────────────────────────────────────────────────────────────

    const countResult = await pool.query(
      `SELECT COUNT(*) AS count
       FROM reports
       WHERE
         ABS(lat - $1) < 0.0005
         AND ABS(lng - $2) < 0.0005
         AND created_at > NOW() - INTERVAL '30 days'`,
      [
        parsedLat,
        parsedLng
      ]
    )

    const locationCount = parseInt(
      countResult.rows[0].count,
      10
    )

    // ────────────────────────────────────────────────────────────
    // 11. Return successful response
    // ────────────────────────────────────────────────────────────

    res.status(201).json({
      success: true,

      reportId: report.report_id,

      id: report.id,

      status: report.status,

      locationCount,

      // IMPORTANT:
      // Every report is processed individually.
      needed: 1,

      createdAt: report.created_at,

      message: 'Pothole report submitted successfully',

      evidence: {
        photoUrl: report.photo_url,

        captureMethod: report.capture_method,

        captureLatitude: report.capture_lat,

        captureLongitude: report.capture_lng,

        captureAccuracy: report.capture_accuracy,

        capturedAt: report.captured_at,

        geolocationCaptured:
          report.geolocation_captured
      },

      cvi: {
        severity: report.ml_severity,

        confidence: report.ml_confidence,

        verified: report.cvi_verified
      }
    })

  } catch (err) {

    // ────────────────────────────────────────────────────────────
    // Database table missing
    // ────────────────────────────────────────────────────────────

    if (err.code === '42P01') {

      console.warn(
        '⚠️ Database tables are not set up correctly.'
      )

      return res.status(500).json({
        error: 'Database table is not configured. Please check schema.'
      })
    }

    console.error(
      'submitReport error:',
      err
    )

    res.status(500).json({
      error: 'Failed to submit report. Please try again.'
    })
  }
}


// ────────────────────────────────────────────────────────────────
// GET /api/reports — List reports
// ────────────────────────────────────────────────────────────────

async function getReports(req, res) {

  try {

    const {
      status,
      hazard,
      limit = 100,
      offset = 0,
      days = 30
    } = req.query

    let query = `
      SELECT
        id,
        report_id,
        lat,
        lng,
        hazard_type,
        photo_url,
        status,
        cluster_id,
        location_name,

        capture_lat,
        capture_lng,
        capture_accuracy,
        captured_at,
        capture_method,
        geolocation_captured,

        ml_severity,
        ml_confidence,
        cvi_verified,

        created_at

      FROM reports

      WHERE created_at >
        NOW() - INTERVAL '${parseInt(days)} days'
    `

    const params = []

    if (status) {

      params.push(status)

      query += `
        AND status = $${params.length}
      `
    }

    if (hazard) {

      // Only pothole is currently supported
      if (hazard !== 'pothole') {

        return res.json({
          reports: [],
          total: 0
        })
      }

      params.push(hazard)

      query += `
        AND hazard_type = $${params.length}
      `
    }

    params.push(parseInt(limit))

    params.push(parseInt(offset))

    query += `
      ORDER BY created_at DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `

    const result = await pool.query(
      query,
      params
    )

    res.json({
      reports: result.rows,
      total: result.rows.length
    })

  } catch (err) {

    console.error(
      'getReports error:',
      err
    )

    res.status(500).json({
      error: 'Failed to fetch reports'
    })
  }
}


// ────────────────────────────────────────────────────────────────
// GET /api/reports/:id — Single report
// ────────────────────────────────────────────────────────────────

async function getReport(req, res) {

  try {

    const { id } = req.params

    const result = await pool.query(
      `SELECT
        id,
        report_id,
        lat,
        lng,
        hazard_type,
        photo_url,
        phone,
        status,
        cluster_id,
        location_name,

        capture_lat,
        capture_lng,
        capture_accuracy,
        captured_at,
        capture_method,
        geolocation_captured,

        ml_severity,
        ml_confidence,
        cvi_verified,

        created_at

       FROM reports

       WHERE report_id = $1
          OR id::text = $1`,
      [id]
    )

    if (result.rows.length === 0) {

      return res.status(404).json({
        error: 'Report not found'
      })
    }

    res.json({
      report: result.rows[0]
    })

  } catch (err) {

    console.error(
      'getReport error:',
      err
    )

    res.status(500).json({
      error: 'Failed to fetch report'
    })
  }
}


// ────────────────────────────────────────────────────────────────
// PATCH /api/reports/:id/status
// ────────────────────────────────────────────────────────────────

async function updateReportStatus(req, res) {

  try {

    const { id } = req.params

    const { status } = req.body

    const valid = [
      'received',
      'under_review',
      'complaint_sent',
      'under_repair',
      'resolved'
    ]

    if (!valid.includes(status)) {

      return res.status(400).json({
        error:
          `Invalid status. Must be one of: ${valid.join(', ')}`
      })
    }

    const result = await pool.query(
      `UPDATE reports

       SET
         status = $1,
         updated_at = NOW()

       WHERE
         report_id = $2
         OR id::text = $2

       RETURNING
         report_id,
         status,
         phone`,
      [
        status,
        id
      ]
    )

    if (result.rows.length === 0) {

      return res.status(404).json({
        error: 'Report not found'
      })
    }

    const report = result.rows[0]

    // Send resolution SMS
    if (
      status === 'resolved' &&
      report.phone
    ) {

      sendSMS(
        report.phone,
        'resolution',
        report.report_id
      ).catch(err => {

        console.warn(
          'Resolution SMS failed:',
          err.message
        )
      })
    }

    res.json({
      success: true,
      report
    })

  } catch (err) {

    console.error(
      'updateReportStatus error:',
      err
    )

    res.status(500).json({
      error: 'Failed to update status'
    })
  }
}


// ────────────────────────────────────────────────────────────────
// GET /api/reports/heatmap
// ────────────────────────────────────────────────────────────────

async function getHeatmapData(req, res) {

  try {

    const {
      days = 30
    } = req.query

    const result = await pool.query(
      `SELECT
        lat,
        lng,
        hazard_type,
        status,
        cluster_id

       FROM reports

       WHERE created_at >
         NOW() - INTERVAL '${parseInt(days)} days'

       ORDER BY created_at DESC`
    )

    res.json({
      points: result.rows
    })

  } catch (err) {

    console.error(
      'getHeatmapData error:',
      err
    )

    res.status(500).json({
      error: 'Failed to fetch heatmap data'
    })
  }
}


// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
  submitReport,
  getReports,
  getReport,
  updateReportStatus,
  getHeatmapData
}