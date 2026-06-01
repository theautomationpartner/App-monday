const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// SSL para DigitalOcean Managed PostgreSQL: si el CA cert esta presente
// (en certs/do-pg-ca.crt del droplet), verificamos contra el (verify-full).
// En dev local o entornos sin el cert, fallback a rejectUnauthorized:false
// para no romper el flujo de desarrollo.
const caCertPath = path.join(__dirname, '..', 'certs', 'do-pg-ca.crt');
const sslConfig = fs.existsSync(caCertPath)
  ? { ca: fs.readFileSync(caCertPath, 'utf8'), rejectUnauthorized: true }
  : { rejectUnauthorized: false };

// Pool config: timeouts moderados (DO managed PG mantiene compute siempre
// activa, pero igual queremos resiliencia ante drops de red transitorios).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
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

// M8: forzar timezone UTC en cada conexion nueva del pool.
// Los conteos mensuales (getMonthlyEmissionCount) hacen AT TIME ZONE
// 'America/Argentina/Buenos_Aires' explicito asumiendo que NOW() devuelve
// UTC. Si DigitalOcean cambia el default del cluster en algun upgrade,
// esos calculos se desplazan en silencio. Setear UTC por sesion blinda
// ante ese caso sin tocar las queries.
pool.on('connect', async (client) => {
  try {
    await client.query("SET TIME ZONE 'UTC'");
  } catch (err) {
    console.error('[db pool] failed to SET TIME ZONE:', err.message);
  }
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
