// controllers/reportController.js
const { pool }    = require('../utils/db')
const { v4: uuid} = require('uuid')
const { sendSMS } = require('../utils/sms')
const path        = require('path')

// ── Generate human-readable report ID ───────────────────────────
function generateReportId() {
  const num = Math.floor(100000 + Math.random() * 900000)
  return `SS-${num}`
}

// ── POST /api/reports — Submit a new hazard report ───────────────
async function submitReport(req, res) {
  try {
    const {
  lat,
  lng,
  hazard,
  phone,
  address
} = req.body

    // Validation
    const parsedLat = parseFloat(lat)
    const parsedLng = parseFloat(lng)

    if (isNaN(parsedLat) || isNaN(parsedLng)) {
      return res.status(400).json({ error: 'Valid lat/lng coordinates are required' })
    }
    if (parsedLat < 12 || parsedLat > 20 || parsedLng < 76 || parsedLng > 85) {
      return res.status(400).json({ error: 'Coordinates appear to be outside Andhra Pradesh' })
    }

    const validHazards = ['pothole', 'speedbreaker', 'blindcurve', 'lighting', 'collapse']
    if (!hazard || !validHazards.includes(hazard)) {
      return res.status(400).json({ error: `Hazard type must be one of: ${validHazards.join(', ')}` })
    }

    const reportId = generateReportId()

    // Build photo URL if file was uploaded
    let photoUrl = null
    if (req.file) {
      // Store relative path so it works across environments
      const relativePath = req.file.path
        .replace(path.join(__dirname, '..'), '')
        .replace(/\\/g, '/')
      photoUrl = relativePath.startsWith('/') ? relativePath : '/' + relativePath
    }

    // Clean phone number
    const cleanPhone = phone ? phone.replace(/\D/g, '').slice(-10) : null
    const fullPhone  = cleanPhone ? `+91${cleanPhone}` : null

    // Insert into database
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
       'received'
     )
   RETURNING
     id,
     report_id,
     lat,
     lng,
     hazard_type,
     location_name,
     status,
     created_at`,
  [
    reportId,
    parsedLat,
    parsedLng,
    hazard,
    photoUrl,
    fullPhone,
    address || null
  ]
)

    const report = result.rows[0]

    // Send SMS confirmation (non-blocking — don't fail the request if SMS fails)
    if (fullPhone) {
      sendSMS(fullPhone, 'confirmation', reportId).catch(err => {
        console.warn(`SMS failed for ${fullPhone}:`, err.message)
      })
    }

    // Get current report count for this location (for frontend progress display)
    const countResult = await pool.query(
      `SELECT COUNT(*) as count
       FROM reports
       WHERE
         ABS(lat - $1) < 0.0005
         AND ABS(lng - $2) < 0.0005
         AND created_at > NOW() - INTERVAL '30 days'`,
      [parsedLat, parsedLng]
    )
    const locationCount = parseInt(countResult.rows[0].count)

    res.status(201).json({
      success:       true,
      reportId:      report.report_id,
      id:            report.id,
      status:        report.status,
      locationCount, // How many reports at this spot so far
      needed:        5,
      createdAt:     report.created_at,
      message:       'Report submitted successfully',
    })

  } catch (err) {
    // Handle case where DB is not set up yet
    if (err.code === '42P01') {
      // Table doesn't exist — return mock response for dev
      console.warn('⚠️  Database tables not set up. Run schema.sql first.')
      return res.status(201).json({
        success:       true,
        reportId:      `SS-${Math.floor(100000 + Math.random() * 900000)}`,
        status:        'received',
        locationCount: 1,
        needed:        5,
        message:       'Report received (DB not configured — run schema.sql)',
      })
    }
    console.error('submitReport error:', err)
    res.status(500).json({ error: 'Failed to submit report. Please try again.' })
  }
}

// ── GET /api/reports — List reports (with optional filters) ──────
async function getReports(req, res) {
  try {
    const { status, hazard, limit = 100, offset = 0, days = 30 } = req.query

    let query = `
      SELECT
        id, report_id, lat, lng, hazard_type,
        photo_url, status, cluster_id, created_at
      FROM reports
      WHERE created_at > NOW() - INTERVAL '${parseInt(days)} days'
    `
    const params = []

    if (status) {
      params.push(status)
      query += ` AND status = $${params.length}`
    }
    if (hazard) {
      params.push(hazard)
      query += ` AND hazard_type = $${params.length}`
    }

    params.push(parseInt(limit), parseInt(offset))
    query += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`

    const result = await pool.query(query, params)
    res.json({ reports: result.rows, total: result.rows.length })

  } catch (err) {
    console.error('getReports error:', err)
    res.status(500).json({ error: 'Failed to fetch reports' })
  }
}

// ── GET /api/reports/:id — Single report detail ──────────────────
async function getReport(req, res) {
  try {
    const { id } = req.params
    const result = await pool.query(
      `SELECT id, report_id, lat, lng, hazard_type, photo_url, status, cluster_id, created_at
       FROM reports WHERE report_id = $1 OR id::text = $1`,
      [id]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' })
    }
    res.json({ report: result.rows[0] })
  } catch (err) {
    console.error('getReport error:', err)
    res.status(500).json({ error: 'Failed to fetch report' })
  }
}

// ── PATCH /api/reports/:id/status — Update report status ─────────
async function updateReportStatus(req, res) {
  try {
    const { id }     = req.params
    const { status } = req.body

    const valid = ['received','under_review','complaint_sent','under_repair','resolved']
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${valid.join(', ')}` })
    }

    const result = await pool.query(
      `UPDATE reports
       SET status = $1, updated_at = NOW()
       WHERE report_id = $2 OR id::text = $2
       RETURNING report_id, status, phone`,
      [status, id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' })
    }

    const report = result.rows[0]

    // Send resolution SMS when resolved
    if (status === 'resolved' && report.phone) {
      sendSMS(report.phone, 'resolution', report.report_id).catch(err => {
        console.warn(`Resolution SMS failed:`, err.message)
      })
    }

    res.json({ success: true, report: result.rows[0] })
  } catch (err) {
    console.error('updateReportStatus error:', err)
    res.status(500).json({ error: 'Failed to update status' })
  }
}

// ── GET /api/reports/heatmap — GPS points for heatmap ────────────
async function getHeatmapData(req, res) {
  try {
    const { days = 30 } = req.query
    const result = await pool.query(
      `SELECT lat, lng, hazard_type, status, cluster_id
       FROM reports
       WHERE created_at > NOW() - INTERVAL '${parseInt(days)} days'
       ORDER BY created_at DESC`,
    )
    res.json({ points: result.rows })
  } catch (err) {
    console.error('getHeatmapData error:', err)
    res.status(500).json({ error: 'Failed to fetch heatmap data' })
  }
}

module.exports = {
  submitReport,
  getReports,
  getReport,
  updateReportStatus,
  getHeatmapData,
}
