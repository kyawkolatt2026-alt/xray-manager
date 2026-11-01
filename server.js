
'use strict';

const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3188);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'xray-manager.db');
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET must be set to at least 32 characters.');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    uuid TEXT NOT NULL UNIQUE,
    protocol TEXT NOT NULL DEFAULT 'vless',
    enabled INTEGER NOT NULL DEFAULT 1,
    traffic_limit_gb REAL NOT NULL DEFAULT 0,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const adminCount = db.prepare('SELECT COUNT(*) AS count FROM admins').get().count;

if (adminCount === 0) {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password || password.length < 12) {
    console.error('First setup requires ADMIN_USERNAME and ADMIN_PASSWORD (12+ characters).');
    process.exit(1);
  }

  const hash = bcrypt.hashSync(password, 12);
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
    .run(username, hash);

  console.log('Initial administrator account created.');
}

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '32kb' }));

const publicDir = path.join(__dirname, 'public');

app.use(express.static(publicDir, {
  index: 'index.html',
  dotfiles: 'deny'
}));

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createSession(adminId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 12 * 60 * 60 * 1000;

  db.prepare(`
    INSERT INTO sessions (token_hash, admin_id, expires_at)
    VALUES (?, ?, ?)
  `).run(hashToken(token), adminId, expiresAt);

  return { token, expiresAt };
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token || token.length > 200) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const session = db.prepare(`
    SELECT admins.id, admins.username
    FROM sessions
    JOIN admins ON admins.id = sessions.admin_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(hashToken(token), Date.now());

  if (!session) {
    return res.status(401).json({ error: 'Session expired or invalid' });
  }

  req.admin = session;
  next();
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', name: 'Xray Manager' });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};

  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);

  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const session = createSession(admin.id);

  res.json({
    token: session.token,
    expiresAt: session.expiresAt,
    admin: { id: admin.id, username: admin.username }
  });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const token = req.headers.authorization.slice(7);
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.json({ success: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ admin: req.admin });
});

app.get('/api/dashboard', requireAuth, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const enabled = db.prepare('SELECT COUNT(*) AS n FROM users WHERE enabled = 1').get().n;

  const memory = os.totalmem();
  const free = os.freemem();

  res.json({
    users: { total, enabled, disabled: total - enabled },
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      uptime: os.uptime(),
      cpuCores: os.cpus().length,
      memoryTotal: memory,
      memoryFree: free,
      memoryUsedPercent: Math.round(((memory - free) / memory) * 100)
    },
    xray: {
      connected: false,
      message: 'Xray Core integration is not configured yet'
    }
  });
});

app.get('/api/users', requireAuth, (req, res) => {
  const users = db.prepare(`
    SELECT id, username, uuid, protocol, enabled,
           traffic_limit_gb, expires_at, created_at
    FROM users ORDER BY id DESC
  `).all();

  res.json({ users });
});

app.post('/api/users', requireAuth, (req, res) => {
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const protocol = body.protocol || 'vless';
  const trafficLimit = Number(body.trafficLimitGb || 0);
  const expiresAt = body.expiresAt || null;

  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 letters, numbers, _ or -' });
  }

  if (!['vless', 'vmess', 'trojan', 'shadowsocks'].includes(protocol)) {
    return res.status(400).json({ error: 'Unsupported protocol' });
  }

  if (!Number.isFinite(trafficLimit) || trafficLimit < 0 || trafficLimit > 1000000) {
    return res.status(400).json({ error: 'Invalid traffic limit' });
  }

  if (expiresAt !== null &&
      (typeof expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt))) {
    return res.status(400).json({ error: 'Expiry must use YYYY-MM-DD format' });
  }

  const uuid = crypto.randomUUID();

  try {
    const result = db.prepare(`
      INSERT INTO users (username, uuid, protocol, traffic_limit_gb, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(username, uuid, protocol, trafficLimit, expiresAt);

    res.status(201).json({
      success: true,
      user: {
        id: result.lastInsertRowid,
        username,
        uuid,
        protocol,
        enabled: true,
        trafficLimitGb: trafficLimit,
        expiresAt
      },
      message: 'User saved. Xray configuration has not yet been applied.'
    });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    throw error;
  }
});

app.patch('/api/users/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);

  if (!user) return res.status(404).json({ error: 'User not found' });

  if (typeof body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be true or false' });
  }

  db.prepare('UPDATE users SET enabled = ? WHERE id = ?')
    .run(body.enabled ? 1 : 0, id);

  res.json({ success: true });
});

app.delete('/api/users/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(id);

  if (!result.changes) return res.status(404).json({ error: 'User not found' });

  res.json({
    success: true,
    message: 'User removed from database. Xray configuration is not changed yet.'
  });
});

app.get('/api/users/:id/qr', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT username, uuid, protocol FROM users WHERE id = ?')
    .get(Number(req.params.id));

  if (!user) return res.status(404).json({ error: 'User not found' });

  const data = JSON.stringify({
    username: user.username,
    uuid: user.uuid,
    protocol: user.protocol
  });

  try {
    const image = await QRCode.toDataURL(data);
    res.json({ qr: image });
  } catch {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

app.get('/api/settings', requireAuth, (req, res) => {
  const settings = db.prepare('SELECT key, value FROM settings').all();
  res.json({ settings: Object.fromEntries(settings.map(x => [x.key, x.value])) });
});

app.put('/api/settings', requireAuth, (req, res) => {
  const body = req.body || {};

  for (const key of ['panelName']) {
    if (typeof body[key] !== 'string' || body[key].length > 60) {
      return res.status(400).json({ error: `Invalid ${key}` });
    }

    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, body[key]);
  }

  res.json({ success: true });
});

app.use((err, req, res, next) => {
  console.error('Request error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Xray Manager backend listening on ${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
