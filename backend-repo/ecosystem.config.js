// Configuración de PM2 para correr el backend en producción.
// Optimizada para droplet de 512 MB de RAM en DigitalOcean.
//
// Uso:
//   pm2 start ecosystem.config.js
//   pm2 save  (persiste la lista para que sobreviva reboots)
//
// Logs:
//   /var/log/pm2/tap-monday-out.log
//   /var/log/pm2/tap-monday-error.log

module.exports = {
  apps: [{
    name: "tap-monday",
    script: "./src/server.js",
    cwd: "/opt/apps/App-monday/backend-repo",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    watch: false,
    // Límite de memoria: si la app supera 350 MB, PM2 la reinicia.
    // Margen pensado para 512 MB total - Nginx (~20 MB) - sistema (~80 MB).
    max_memory_restart: "350M",
    // Limita el heap de V8 al mismo umbral para que Node falle antes de OOM.
    node_args: "--max-old-space-size=350",
    kill_timeout: 5000,
    listen_timeout: 10000,
    env: {
      NODE_ENV: "production"
    },
    error_file: "/var/log/pm2/tap-monday-error.log",
    out_file: "/var/log/pm2/tap-monday-out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    merge_logs: true,
    // Si la app crashea más de 10 veces antes de estar 30s arriba, PM2 desiste.
    // Evita loops de restart si hay un bug que rompe en startup.
    max_restarts: 10,
    min_uptime: "30s"
  }]
};
