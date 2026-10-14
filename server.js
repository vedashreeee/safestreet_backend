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
// Paste this near the top of server.js with your other requirements
const PDFDocument = require('pdfkit');
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
// ---> PASTE ALL OF THIS RIGHT BEFORE app.listen <---

// Ensure you have your DB pool imported at the top of your file
// const pool = require('./db'); // Adjust the path if it's in a different folder

app.get('/api/export-audit', async (req, res) => {
    try {
        // 1. Fetch REAL data from your Neon PostgreSQL database
        // This query grabs everything from the last 6 months, sorted newest to oldest
        const query = `
            SELECT 
                report_id, 
                location_name, 
                hazard_type, 
                severity_score, 
                created_at 
            FROM reports 
            WHERE created_at >= NOW() - INTERVAL '6 months'
            ORDER BY created_at DESC;
        `;
        
        const dbResult = await pool.query(query);
        const dbRecords = dbResult.rows;

        // 2. Format the data for the PDF
        const records = dbRecords.map(row => {
            // Auto-calculate material indent based on the AI severity score
            let calculatedMaterials = 0;
            let severityLabel = 'Low';

            if (row.severity_score >= 80) {
                severityLabel = 'Critical';
                calculatedMaterials = 4; // 4 bags for critical
            } else if (row.severity_score >= 50) {
                severityLabel = 'Danger';
                calculatedMaterials = 2; // 2 bags for danger
            } else {
                calculatedMaterials = 1; // 1 bag for minor
            }

            // Clean up long addresses for the PDF table
            const shortLoc = row.location_name ? row.location_name.split(',').slice(0, 2).join(',') : 'GPS Location';

            return {
                // Use JS Date to format the timestamp cleanly
                date: new Date(row.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
                location: shortLoc,
                severity: severityLabel,
                materials: calculatedMaterials
            };
        });

        // Calculate totals dynamically from the live database
        const totalResolved = records.length;
        const totalBags = records.reduce((sum, record) => sum + record.materials, 0);

        // 3. Set headers so React knows it's downloading a PDF file
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=SafeStreet_6Month_Audit.pdf');

        // 4. Create the PDF Document
        const doc = new PDFDocument({ margin: 50 });
        doc.pipe(res);

        // --- Document Header ---
        doc.fontSize(16).fillColor('#243447').text('Tadigadapa Municipality - Road Infrastructure Audit', { align: 'center' });
        doc.fontSize(10).fillColor('#64748B').text(`Generated on: ${new Date().toLocaleDateString('en-IN')}`, { align: 'center' });
        doc.moveDown(2);

        // --- Executive Summary ---
        doc.fontSize(12).fillColor('black').text('Executive Summary (6-Month Fiscal Cycle)', { underline: true });
        doc.moveDown(0.5);
        doc.fontSize(11).text(`Total Hazards Recorded: ${totalResolved}`);
        doc.text(`Total Material Indent (Cold-Mix Asphalt): ${totalBags} Bags`);
        doc.moveDown(2);

        // --- Table Data ---
        records.forEach(row => {
            doc.fontSize(10).fillColor('black');
            doc.text(`Date: ${row.date} | Location: ${row.location}`);
            
            // Color code severity
            if (row.severity === 'Critical') doc.fillColor('red');
            else if (row.severity === 'Danger') doc.fillColor('orange');
            else doc.fillColor('green');
            
            doc.text(`Severity: ${row.severity}`);
            
            doc.fillColor('black').text(`Materials Required/Used: ${row.materials} Bags`);
            doc.moveDown(1);
            doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#E2E8F0').stroke(); // Divider line
            doc.moveDown(1);
        });

        // Finalize the PDF and end the response
        doc.end();

    } catch (error) {
        console.error("Error generating audit PDF from live DB:", error);
        res.status(500).json({ error: 'Failed to generate PDF' });
    }
});
// Your existing app.listen should be right here at the very end
// app.listen(PORT, ...)
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