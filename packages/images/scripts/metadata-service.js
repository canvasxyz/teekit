#!/usr/bin/env node

/**
 * Local metadata service for QEMU testing
 * This service mimics cloud metadata services and provides manifests to the VM
 * Supports multiple manifests as comma-separated base64 strings
 */

import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 8090;
const HOST = '0.0.0.0';

// Default manifest for testing
// This manifest points to the app.js that's baked into the VM at /usr/lib/kettle/app.js
const DEFAULT_MANIFEST = {
  app: "file:///usr/lib/kettle/app.js",
  // The SHA256 will be calculated during VM build, but for testing we use a placeholder
  // The actual hash will be verified by the launcher
  sha256: "0000000000000000000000000000000000000000000000000000000000000000"
};

// Try to load manifests from files if provided as arguments
// Usage: node metadata-service.js [manifest1.json] [manifest2.json] ...
let manifests = [DEFAULT_MANIFEST];
const manifestPaths = process.argv.slice(2);

if (manifestPaths.length > 0) {
  manifests = [];
  for (const manifestPath of manifestPaths) {
    try {
      const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent);
      manifests.push(manifest);
      console.log(`[metadata-service] Loaded manifest from ${manifestPath}`);
    } catch (err) {
      console.error(`[metadata-service] Warning: Failed to load manifest from ${manifestPath}: ${err.message}`);
      console.log('[metadata-service] Skipping this manifest');
    }
  }

  if (manifests.length === 0) {
    console.log('[metadata-service] No manifests loaded, using default manifest');
    manifests = [DEFAULT_MANIFEST];
  }
}

// Encode manifests as base64
// If single manifest, return single base64 string
// If multiple manifests, return comma-separated base64 strings
const manifestBase64 = manifests.length === 1
  ? Buffer.from(JSON.stringify(manifests[0])).toString('base64')
  : manifests.map(m => Buffer.from(JSON.stringify(m)).toString('base64')).join(',');

const server = http.createServer((req, res) => {
  const now = new Date().toISOString();
  console.log(`[metadata-service] ${now} ${req.method} ${req.url}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Metadata');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/manifest' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(manifestBase64);
    console.log(`[metadata-service] Served manifest config (${manifestBase64.length} bytes)`);
  } else if (req.url === '/manifest/decoded' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const decoded = manifests.length === 1 ? manifests[0] : manifests;
    res.end(JSON.stringify(decoded, null, 2));
    console.log('[metadata-service] Served decoded manifest config');
  } else if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[metadata-service] Local metadata service listening on http://${HOST}:${PORT}`);
  console.log('[metadata-service] Endpoints:');
  console.log('[metadata-service]   GET /manifest         - Returns base64-encoded manifest(s)');
  console.log('[metadata-service]   GET /manifest/decoded - Returns decoded manifest(s) (debug)');
  console.log('[metadata-service]   GET /health           - Health check');
  console.log('[metadata-service]');
  console.log(`[metadata-service] Loaded ${manifests.length} manifest(s):`);
  for (let i = 0; i < manifests.length; i++) {
    console.log(`[metadata-service] Manifest ${i}:`);
    console.log(JSON.stringify(manifests[i], null, 2).split('\n').map(line => `  ${line}`).join('\n'));
  }
  console.log('[metadata-service]');
  console.log(`[metadata-service] Manifest config:`);
  console.log(manifestBase64);
});

// Handle shutdown gracefully
process.on('SIGINT', () => {
  console.log('\n[metadata-service] Shutting down...');
  server.close(() => {
    console.log('[metadata-service] Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n[metadata-service] Shutting down...');
  server.close(() => {
    console.log('[metadata-service] Server closed');
    process.exit(0);
  });
});
