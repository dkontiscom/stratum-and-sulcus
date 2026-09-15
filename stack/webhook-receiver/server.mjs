// SPDX-License-Identifier: MIT
import { createServer } from 'http';
import { spawn } from 'child_process';

const PORT = parseInt(process.env.PORT || '9000');
const HOST_PROJECT_DIR = process.env.HOST_PROJECT_DIR;
const PROJECT_NAME = 'stratum-sulcus-mac';

let syncing = false;

function ts() { return new Date().toISOString(); }

function buildSync() {
  console.log(`[${ts()}] Building sync image...`);
  const proc = spawn('docker', [
    'compose',
    '--file', '/project/docker-compose.yml',
    '--env-file', '/project/.env',
    '--project-directory', '/project',
    '--project-name', PROJECT_NAME,
    'build', 'sync'
  ], { stdio: 'inherit' });
  proc.on('close', code => console.log(`[${ts()}] Sync image build finished (exit ${code})`));
}

function runSync() {
  if (syncing) {
    console.log(`[${ts()}] Sync already running — skipping`);
    return;
  }
  syncing = true;
  console.log(`[${ts()}] Starting sync...`);

  const proc = spawn('docker', [
    'compose',
    '--file', '/project/docker-compose.yml',
    '--env-file', '/project/.env',
    '--project-directory', HOST_PROJECT_DIR,
    '--project-name', PROJECT_NAME,
    '--profile', 'sync',
    'run', '--rm', 'sync'
  ], { stdio: 'inherit' });

  proc.on('close', code => {
    syncing = false;
    console.log(`[${ts()}] Sync finished (exit ${code})`);
  });
  proc.on('error', err => {
    syncing = false;
    console.error(`[${ts()}] Sync error: ${err.message}`);
  });
}

createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    console.log(`[${ts()}] Webhook received: ${body.slice(0, 300)}`);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    runSync();
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[${ts()}] Webhook receiver listening on :${PORT}`);
  if (!HOST_PROJECT_DIR) console.error('WARNING: HOST_PROJECT_DIR not set');
  buildSync();
});
