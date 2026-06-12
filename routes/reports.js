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
   CREATE REPORT
========================================= */
router.post('/', upload.single('photo'), async (req, res) => {
  try {
    const { lat, lng, hazard, phone, address } = req.body

    if (!lat || !lng || !hazard) {
      return res.status(400).json({ success: false, error: 'Missing required fields' })
    }

    let photoUrl = null;

    // --- SAFELY UPLOAD FROM RAM TO CLOUDINARY ---
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

    const reportId = 'SS-' + Math.floor(100000 + Math.random() * 900000)
    const placeName = address || `GPS: ${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`;

    /* ─── INSERT REPORT ─── */
    const result = await pool.query(
      `
      INSERT INTO reports
      (report_id, lat, lng, hazard_type, phone, photo_url, status, location_name, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'received', $7, NOW())
      RETURNING *
      `,
      [reportId, lat, lng, hazard, phone || null, photoUrl, placeName]
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