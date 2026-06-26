const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 8443;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css'
};

// Explicit allowlist: the only files this server will ever serve.
// Request paths are looked up here directly, never used to build a
// filesystem path, so traversal/null-byte tricks have nothing to act on.
const ALLOWED_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/style.css': 'style.css',
  '/app.js': 'app.js'
};

const options = {
  key: fs.readFileSync(path.join(ROOT, 'key.pem')),
  cert: fs.readFileSync(path.join(ROOT, 'cert.pem'))
};

function lanIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const server = https.createServer(options, (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }

  const urlPath = req.url.split('?')[0];
  const filename = ALLOWED_FILES[urlPath];
  if (!filename) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  fs.readFile(path.join(ROOT, filename), (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Server error');
      return;
    }
    const ext = path.extname(filename);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? null : data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('ASCII-CAM server running.');
  console.log(`On this Mac:  https://localhost:${PORT}`);
  console.log(`On your phone (same WiFi):  https://${lanIP()}:${PORT}`);
  console.log('The browser will warn about the self-signed certificate — tap "Advanced" then "Proceed" (Chrome) or "Visit Website" (Safari).');
});
