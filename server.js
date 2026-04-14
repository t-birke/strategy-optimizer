import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { initWebSocket } from './api/websocket.js';
import routes from './api/routes.js';
import { getConn } from './db/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// BigInt JSON serialization support
BigInt.prototype.toJSON = function() { return Number(this); };

const app = express();
app.use(express.json());

// Serve static UI files
app.use(express.static(resolve(__dirname, 'ui')));

// API routes
app.use(routes);

// SPA fallback — serve index.html for /data and /optimizer
app.get(/^\/(data|optimizer)?$/, (req, res) => {
  res.sendFile(resolve(__dirname, 'ui/index.html'));
});

const server = createServer(app);
initWebSocket(server);

// Initialize DB on startup
await getConn();

// Reset any runs left in 'running' state from a previous crash
import { query, exec } from './db/connection.js';
const staleRuns = await query("SELECT id FROM runs WHERE status = 'running'");
if (staleRuns.length > 0) {
  await exec("UPDATE runs SET status = 'failed', error = 'Server restarted during run' WHERE status = 'running'");
  console.log(`Reset ${staleRuns.length} stale 'running' run(s) to 'failed'`);
}

server.listen(PORT, () => {
  console.log(`Strategy Optimizer running at http://localhost:${PORT}`);
});
