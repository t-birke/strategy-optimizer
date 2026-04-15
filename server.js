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

// Phase 4.2b: sweep any rows left in 'running' state from a prior session.
// In single-process mode there are no other workers, so every `running`
// row at boot is definitionally stale — no heartbeat could have fired
// while we were down. recoverStaleRuns sends them back to `pending` (not
// `failed`) so the queue can pick them up again, which is the right
// default: the user enqueued the run, a crash/restart shouldn't silently
// drop it.
//
// If you want crashed rows to stay failed instead, change the follow-up
// in processQueue() to cap re-claim attempts (e.g. increment an `attempts`
// counter and mark failed at N).
import { recoverStaleRuns } from './db/queue.js';
const recovered = await recoverStaleRuns({ timeoutMs: 1_000 });
if (recovered > 0) {
  console.log(`Recovered ${recovered} stale 'running' run(s) → 'pending'`);
}

server.listen(PORT, () => {
  console.log(`Strategy Optimizer running at http://localhost:${PORT}`);
});
