require('dotenv').config()

const express =
  require('express')

const cors =
  require('cors')

const path =
  require('path')

const cron =
  require('node-cron')

const pool =
  require('./db')

const {
  runClustering,
} = require('./clustering')

/* =========================================
   ROUTES
========================================= */

const reportRoutes =
  require('./routes/reports')

const complaintsRoutes =
  require('./routes/complaints')

const locationCountRoute =
  require('./routes/locationCount')

const app = express()

const PORT =
  process.env.PORT || 5000

/* =========================================
   MIDDLEWARE
========================================= */

app.use(
  cors({
    origin: '*',
  })
)

app.use(
  express.json({
    limit: '10mb',
  })
)

app.use(
  express.urlencoded({
    extended: true,
  })
)

/* =========================================
   STATIC FILES
========================================= */

app.use(
  '/uploads',

  express.static(
    path.join(
      __dirname,
      'uploads'
    )
  )
)

app.use(
  '/complaints',

  express.static(
    path.join(
      __dirname,
      'uploads',
      'complaints'
    )
  )
)

/* =========================================
   LOGGER
========================================= */

app.use(
  (req, res, next) => {

    console.log(
      `[${new Date()
        .toISOString()
        .slice(11, 19)}] ${req.method} ${req.path}`
    )

    next()
  }
)

/* =========================================
   API ROUTES
========================================= */

app.use(
  '/api/reports',
  reportRoutes
)

app.use(
  '/api/complaints',
  complaintsRoutes
)

app.use(
  '/api/location-count',
  locationCountRoute
)

/* =========================================
   HEALTH CHECK
========================================= */

app.get(
  '/api/health',

  async (req, res) => {

    try {

      await pool.query(
        'SELECT 1'
      )

      res.json({

        success: true,

        database:
          'connected',
      })

    } catch (err) {

      console.error(err)

      res.status(500).json({

        success: false,

        error:
          err.message,
      })
    }
  }
)

/* =========================================
   DASHBOARD STATS
========================================= */

app.get(
  '/api/stats',

  async (req, res) => {

    try {

      const reports =
        await pool.query(`
          SELECT COUNT(*)::int AS count
          FROM reports
        `)

      const zones =
        await pool.query(`
          SELECT COUNT(*)::int AS count
          FROM danger_zones
        `)

      const critical =
        await pool.query(`
          SELECT COUNT(*)::int AS count
          FROM danger_zones
          WHERE severity = 'critical'
        `)

      res.json({

        totalReports:
          reports.rows[0].count,

        dangerZones:
          zones.rows[0].count,

        criticalAreas:
          critical.rows[0].count,
      })

    } catch (err) {

      console.error(err)

      res.status(500).json({
        error:
          err.message,
      })
    }
  }
)

/* =========================================
   DANGER ZONES
========================================= */

app.get(
  '/api/danger-zones',

  async (req, res) => {

    try {

      const result =
        await pool.query(`
          SELECT *
          FROM danger_zones
          ORDER BY report_count DESC
        `)

      res.json({

        success: true,

        dangerZones:
          result.rows,
      })

    } catch (err) {

      console.error(err)

      res.status(500).json({
        error:
          err.message,
      })
    }
  }
)

/* =========================================
   UPDATE STATUS
========================================= */

app.patch(
  '/api/danger-zones/:id/status',

  async (req, res) => {

    try {

      const { id } =
        req.params

      const { status } =
        req.body

      await pool.query(
        `
        UPDATE danger_zones
        SET
          status = $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [
          status,
          id,
        ]
      )

      res.json({
        success: true,
      })

    } catch (err) {

      console.error(err)

      res.status(500).json({
        error:
          err.message,
      })
    }
  }
)
// Delete danger zone + all reports in that cluster
// Delete danger zone + all reports in that cluster
app.delete('/api/danger-zones/:id', async (req, res) => {
  try {
    const { id } = req.params
    
    // Get cluster_id first
    const zoneResult = await pool.query(
      `SELECT cluster_id FROM danger_zones WHERE id = $1`,
      [id]
    )
    
    if (zoneResult.rows.length === 0) {
      return res.status(404).json({ error: 'Zone not found' })
    }
    
    const clusterId = zoneResult.rows[0].cluster_id
    
    // 1. Force delete ALL reports linked to this zone or cluster
    await pool.query(
      `DELETE FROM reports WHERE danger_zone_id = $1 OR cluster_id = $2`,
      [id, clusterId]
    )
    
    // 2. Delete complaints linked to this zone
    await pool.query(
      `DELETE FROM complaints WHERE danger_zone_id = $1`,
      [id]
    )
    
    // 3. Delete the danger zone itself
    await pool.query(
      `DELETE FROM danger_zones WHERE id = $1`,
      [id]
    )
    
    res.json({ success: true, message: 'Zone and all reports permanently deleted' })
    
  } catch (err) {
    console.error('Delete zone error:', err)
    res.status(500).json({ error: err.message })
  }
})
/* =========================================
   AUTO CLUSTERING
========================================= */
/*
cron.schedule(
  '0 * * * *',

  async () => {

    console.log(
      '⏰ Running clustering...'
    )

    try {

      await runClustering()

    } catch (err) {

      console.error(
        'CRON CLUSTER ERROR:',
        err
      )
    }
  }
)*/

/* =========================================
   START SERVER
========================================= */

app.listen(
  PORT,

  async () => {

    console.log(
      '\n🛣️ SafeStreet Backend Starting...\n'
    )

    try {

      await pool.query(
        'SELECT 1'
      )

      console.log(
        '✅ PostgreSQL connected'
      )

    } catch (err) {

      console.log(
        '❌ PostgreSQL failed'
      )
    }

    console.log(
      `✅ Server running on port ${PORT}`
    )

    console.log(
      `🌐 http://localhost:${PORT}/api/health`
    )
  }
)
module.exports = app;