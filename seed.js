// utils/seed.js — Setup DB and insert demo data for development
// Run: node utils/seed.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })
const pool = require('./db')
const bcrypt   = require('bcryptjs')
const fs       = require('fs')
const path     = require('path')

async function seed() {
  console.log('\n🌱 SafeStreet — Database Setup & Seed\n')

  const client = await pool.connect()

  try {
    // ── Run schema ──────────────────────────────────────────────
    console.log('📋 Creating tables from schema.sql...')
    const schemaSQL = fs.readFileSync(
      path.join(__dirname, './schema.sql'), 'utf8'
    )
    // Run schema statements (skip the dummy INSERT)
    const schemaCleaned = schemaSQL
      .replace(/--.*$/gm, '')        // remove comments
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 10)

    for (const stmt of schemaCleaned) {
      try {
        await client.query(stmt)
      } catch (e) {
        // Ignore "already exists" errors
        if (!e.message.includes('already exists')) {
          console.warn('  ⚠️ ', e.message.slice(0, 80))
        }
      }
    }
    console.log('  ✅ Tables ready\n')

    // ── Create secretary account ─────────────────────────────────
    console.log('👤 Creating secretary account...')
    const hash = await bcrypt.hash('secretary123', 10)
    await client.query(
      `INSERT INTO users (username, password_hash, role, name)
       VALUES ('secretary', $1, 'secretary', 'Gram Panchayat Secretary')
       ON CONFLICT (username) DO UPDATE SET password_hash = $1`,
      [hash]
    )
    console.log('  ✅ Secretary account ready')
    console.log('     Username: secretary')
    console.log('     Password: secretary123\n')

    // ── Insert demo reports around Vijayawada ────────────────────
    console.log('📍 Inserting demo reports...')

    // 5 reports at same location (will trigger danger zone on clustering)
    const demoReports = [
      // Cluster 1 — 6 pothole reports near Eluru Road
      { lat: 16.5075, lng: 80.6395, hazard: 'pothole',      phone: '+919876543210' },
      { lat: 16.5076, lng: 80.6396, hazard: 'pothole',      phone: null            },
      { lat: 16.5074, lng: 80.6394, hazard: 'pothole',      phone: '+919876543211' },
      { lat: 16.5077, lng: 80.6397, hazard: 'pothole',      phone: null            },
      { lat: 16.5073, lng: 80.6393, hazard: 'pothole',      phone: '+919876543212' },
      { lat: 16.5075, lng: 80.6395, hazard: 'pothole',      phone: null            },
      // Cluster 2 — 5 speedbreaker reports near MG Road
      { lat: 16.5120, lng: 80.6450, hazard: 'speedbreaker', phone: '+919876543213' },
      { lat: 16.5121, lng: 80.6451, hazard: 'speedbreaker', phone: null            },
      { lat: 16.5119, lng: 80.6449, hazard: 'speedbreaker', phone: '+919876543214' },
      { lat: 16.5122, lng: 80.6452, hazard: 'speedbreaker', phone: null            },
      { lat: 16.5118, lng: 80.6448, hazard: 'speedbreaker', phone: null            },
      // Scattered individual reports (noise — won't cluster)
      { lat: 16.5000, lng: 80.6300, hazard: 'lighting',     phone: null            },
      { lat: 16.5200, lng: 80.6600, hazard: 'blindcurve',   phone: '+919876543215' },
      { lat: 16.5300, lng: 80.6700, hazard: 'collapse',     phone: null            },
    ]

    let inserted = 0
    for (const r of demoReports) {
      const reportId = `SS-${Math.floor(100000 + Math.random() * 900000)}`
      // Spread timestamps over the last 20 days
      const daysAgo = Math.floor(Math.random() * 20)
      await client.query(
        `INSERT INTO reports (report_id, lat, lng, hazard_type, phone, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'received', NOW() - INTERVAL '${daysAgo} days')`,
        [reportId, r.lat, r.lng, r.hazard, r.phone]
      )
      inserted++
    }
    console.log(`  ✅ ${inserted} demo reports inserted\n`)

    // ── Run clustering on demo data ──────────────────────────────
    console.log('🔍 Running DBSCAN clustering on demo data...')
    const { runClustering } = require('./clustering')
    const clusterResult = await runClustering()
    console.log(`  ✅ ${clusterResult.newZones} danger zones detected\n`)

    console.log('🎉 Database seeded successfully!')
    console.log('\nYou can now start the server with: npm run dev\n')

  } catch (err) {
    console.error('❌ Seed failed:', err.message)
    console.error(err.stack)
  } finally {
    client.release()
    await pool.end()
  }
}

seed()
