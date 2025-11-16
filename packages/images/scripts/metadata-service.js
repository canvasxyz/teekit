#!/usr/bin/env node

/**
 * Local metadata service for QEMU testing
 * This service mimics cloud metadata services and provides the manifest to the VM
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

// Try to load manifest from file if provided as argument
let manifest = DEFAULT_MANIFEST;
const manifestPath = process.argv[2];

if (manifestPath) {
  try {
    const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
    manifest = JSON.parse(manifestContent);
    console.log(`[metadata-service] Loaded manifest from ${manifestPath}`);
  } catch (err) {
    console.error(`[metadata-service] Warning: Failed to load manifest from ${manifestPath}: ${err.message}`);
    console.log('[metadata-service] Using default manifest');
  }
}

// Encode manifest as base64
const manifestBase64 = Buffer.from(JSON.stringify(manifest)).toString('base64');

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
    // Return base64-encoded manifest
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(manifestBase64);
    console.log(`[metadata-service] Served manifest (${manifestBase64.length} bytes, base64)`);
  } else if (req.url === '/manifest/decoded' && req.method === 'GET') {
    // Return decoded manifest for debugging
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manifest, null, 2));
    console.log('[metadata-service] Served decoded manifest (debug endpoint)');
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
  console.log('[metadata-service]   GET /manifest         - Returns base64-encoded manifest');
  console.log('[metadata-service]   GET /manifest/decoded - Returns decoded manifest (debug)');
  console.log('[metadata-service]   GET /health           - Health check');
  console.log('[metadata-service]');
  console.log('[metadata-service] Manifest:');
  console.log(JSON.stringify(manifest, null, 2));
  console.log('[metadata-service]');
  console.log('[metadata-service] Base64-encoded manifest:');
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
