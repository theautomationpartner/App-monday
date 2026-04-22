const { Pool } = require('pg');
require('dotenv').config();

// Config tuneada para Neon (Postgres serverless con auto-suspend).
// Sin estos timeouts, el pool reusa conexiones que Neon ya cerró
// y tira "Connection terminated unexpectedly" en la primera query.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 30000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// Sin este handler, un cliente idle que se cae crashea el proceso entero.
pool.on('error', (err) => {
  console.error('[db pool] idle client error:', err.message);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
