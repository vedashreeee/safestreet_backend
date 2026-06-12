require('dotenv').config()
const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false 
  },
  connectionTimeoutMillis: 15000, // Increased to 15 seconds so Neon can wake up!
  idleTimeoutMillis: 30000       
});

pool.connect()
  .then(() => {
    console.log('✅ PostgreSQL connected')
  })
  .catch((err) => {
    console.error('❌ Database connection error:', err.message)
  })

module.exports = pool