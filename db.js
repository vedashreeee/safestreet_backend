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

// --- THE SHOCK ABSORBER ---
// This stops Node.js from crashing when Neon goes to sleep
pool.on('error', (err, client) => {
  console.error('Neon DB hung up on an idle connection (this is normal):', err.message);
});

pool.connect()
  .then(() => {
    console.log('✅ PostgreSQL connected')
  })
  .catch((err) => {
    console.error('❌ Database connection error:', err.message)
  })

module.exports = pool