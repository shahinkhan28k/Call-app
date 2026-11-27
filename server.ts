import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import JSZip from 'jszip';
import { WebSocketServer, WebSocket } from 'ws';

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const ADMIN_EMAIL = 'shahinkhan28ddd@gmail.com';
const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
const ANDROID_SOURCE_DIR = path.resolve(process.cwd(), 'android-source');
const ANDROID_RELEASES_DIR = path.resolve(process.cwd(), 'android-releases');
const FIREBASE_CONFIG_PATH = path.resolve(process.cwd(), 'firebase-applet-config.json');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

interface FirebaseClientConfig {
  apiKey: string;
  projectId: string;
  firestoreDatabaseId?: string;
}

function loadFirebaseConfig(): FirebaseClientConfig | null {
  try {
    if (!fs.existsSync(FIREBASE_CONFIG_PATH)) return null;
    return JSON.parse(fs.readFileSync(FIREBASE_CONFIG_PATH, 'utf8')) as FirebaseClientConfig;
  } catch {
    return null;
  }
}

interface VerifiedUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  phoneNumber: string;
}

const tokenCache = new Map<string, { user: VerifiedUser; expiresAt: number }>();

async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedUser | null> {
  if (!idToken || idToken.length > 4096) return null;

  const cached = tokenCache.get(idToken);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  const fbConfig = loadFirebaseConfig();
  if (!fbConfig?.apiKey) return null;

  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(fbConfig.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );

    if (!response.ok) return null;
    const data = (await response.json()) as {
      users?: Array<{
        localId?: string;
        email?: string;
        emailVerified?: boolean;
        phoneNumber?: string;
      }>;
    };

    const record = data.users?.[0];
    if (!record?.localId) return null;

    const user: VerifiedUser = {
      uid: record.localId,
      email: record.email || '',
      emailVerified: Boolean(record.emailVerified),
      phoneNumber: record.phoneNumber || '',
    };

    tokenCache.set(idToken, { user, expiresAt: Date.now() + 5 * 60 * 1000 });
    return user;
  } catch {
    return null;
  }
}

function extractBearerToken(req: express.Request): string {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return '';
  return header.slice(7).trim();
}

const ALLOWED_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/webm': 'weba',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

const uploadRateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkUploadRateLimit(uid: string): boolean {
  const now = Date.now();
  const bucket = uploadRateBuckets.get(uid);
  if (!bucket || bucket.resetAt < now) {
    uploadRateBuckets.set(uid, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (bucket.count >= 40) return false;
  bucket.count += 1;
  return true;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Allow Android bundled WebView (http://localhost:*) to reach /api/upload and /api/ice-servers
app.use(['/api/upload', '/api/ice-servers'], (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-File-Name, X-File-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// ICE Server configuration (STUN + optional TURN from environment variables)
app.get('/api/ice-servers', (_req, res) => {
  const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];

  const turnUrl = (process.env.TURN_URL || '').trim();
  const turnUsername = (process.env.TURN_USERNAME || '').trim();
  const turnCredential = (process.env.TURN_CREDENTIAL || '').trim();

  if (turnUrl) {
    iceServers.push({
      urls: turnUrl,
      ...(turnUsername ? { username: turnUsername } : {}),
      ...(turnCredential ? { credential: turnCredential } : {}),
    });
  }

  res.json({
    iceServers,
    turnConfigured: Boolean(turnUrl && turnUsername && turnCredential),
  });
});

// Secure authenticated media & document upload
app.post(
  '/api/upload',
  express.raw({ type: '*/*', limit: '25mb' }),
  async (req, res) => {
    const token = extractBearerToken(req);
    const user = await verifyFirebaseIdToken(token);
    if (!user || (!user.emailVerified && !user.phoneNumber)) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!checkUploadRateLimit(user.uid)) {
      res.status(429).json({ error: 'Upload rate limit exceeded. Please wait a minute.' });
      return;
    }

    const rawMime = String(req.headers['x-file-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = ALLOWED_MIME_EXT[rawMime];
    if (!ext) {
      res.status(400).json({ error: 'Unsupported file type' });
      return;
    }

    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buffer.length === 0 || buffer.length > 25 * 1024 * 1024) {
      res.status(400).json({ error: 'File must be between 1 byte and 25 MB' });
      return;
    }

    const safeFileName = `${crypto.randomUUID()}.${ext}`;
    const targetPath = path.resolve(UPLOADS_DIR, safeFileName);
    if (!targetPath.startsWith(UPLOADS_DIR + path.sep)) {
      res.status(400).json({ error: 'Invalid upload path' });
      return;
    }

    fs.writeFileSync(targetPath, buffer);

    const rawOriginalName = String(req.headers['x-file-name'] || `attachment.${ext}`);
    const sanitizedName = rawOriginalName.replace(/[^a-zA-Z0-9._\- ]/g, '_').slice(0, 120);

    res.status(201).json({
      url: `/uploads/${safeFileName}`,
      name: sanitizedName,
      size: buffer.length,
      mime: rawMime,
    });
  }
);

// Serve uploaded media safely with nosniff + sandbox CSP
app.get('/uploads/:filename', (req, res) => {
  const filename = String(req.params.filename || '');
  if (!/^[a-zA-Z0-9_\-]+\.[a-z0-9]{2,5}$/.test(filename)) {
    res.status(400).json({ error: 'Invalid filename' });
    return;
  }

  const targetPath = path.resolve(UPLOADS_DIR, filename);
  if (!targetPath.startsWith(UPLOADS_DIR + path.sep) || !fs.existsSync(targetPath)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(targetPath);
});

// Connected WebSocket map
const wsClients = new Map<string, Set<WebSocket>>();

// Server & Call Infrastructure Health (detailed telemetry strictly for verified Admin)
app.get('/api/health', async (req, res) => {
  const token = extractBearerToken(req);
  const user = token ? await verifyFirebaseIdToken(token) : null;
  const isAdmin = Boolean(user && user.email === ADMIN_EMAIL && user.emailVerified);

  if (!isAdmin) {
    res.json({ ok: true });
    return;
  }

  let uploadsCount = 0;
  let uploadsBytes = 0;
  try {
    const files = fs.readdirSync(UPLOADS_DIR);
    uploadsCount = files.length;
    for (const file of files) {
      const fp = path.resolve(UPLOADS_DIR, file);
      if (fp.startsWith(UPLOADS_DIR + path.sep)) {
        uploadsBytes += fs.statSync(fp).size;
      }
    }
  } catch {
    // Ignore read errors
  }

  let totalSockets = 0;
  for (const set of wsClients.values()) {
    totalSockets += set.size;
  }

  res.json({
    ok: true,
    uptimeSeconds: Math.floor(process.uptime()),
    memoryUsageMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    activeUsersConnected: wsClients.size,
    activeWsSockets: totalSockets,
    uploadsCount,
    uploadsStorageMb: Number((uploadsBytes / (1024 * 1024)).toFixed(2)),
    turnConfigured: Boolean(process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL),
    nodeVersion: process.version,
  });
});

// Android Native Source Code Viewer API (reads strictly from ./android-source)
function collectAndroidFiles(dir: string, baseDir: string): Array<{ path: string; content: string }> {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: Array<{ path: string; content: string }> = [];
  for (const entry of entries) {
    const full = path.resolve(dir, entry.name);
    if (!full.startsWith(baseDir + path.sep)) continue;
    if (entry.isDirectory()) {
      results.push(...collectAndroidFiles(full, baseDir));
    } else if (entry.isFile()) {
      const rel = path.relative(baseDir, full).replace(/\\/g, '/');
      results.push({ path: rel, content: fs.readFileSync(full, 'utf8') });
    }
  }
  return results;
}

app.get('/api/android-source', async (req, res) => {
  const token = extractBearerToken(req);
  const user = await verifyFirebaseIdToken(token);
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const files = collectAndroidFiles(ANDROID_SOURCE_DIR, ANDROID_SOURCE_DIR);
  res.json({ files });
});

app.get('/api/download-android-source', async (req, res) => {
  const token = extractBearerToken(req);
  const user = await verifyFirebaseIdToken(token);
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const zip = new JSZip();
  const files = collectAndroidFiles(ANDROID_SOURCE_DIR, ANDROID_SOURCE_DIR);
  for (const f of files) {
    zip.file(`android-source/${f.path}`, f.content);
  }

  const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
  if (fs.existsSync(rulesPath)) {
    zip.file('firestore.rules', fs.readFileSync(rulesPath, 'utf8'));
  }
  const bpPath = path.resolve(process.cwd(), 'firebase-blueprint.json');
  if (fs.existsSync(bpPath)) {
    zip.file('firebase-blueprint.json', fs.readFileSync(bpPath, 'utf8'));
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="claro-android-project.zip"');
  res.send(buffer);
});

app.get('/api/android-releases', async (req, res) => {
  const token = extractBearerToken(req);
  const user = await verifyFirebaseIdToken(token);
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const apkPath = path.resolve(ANDROID_RELEASES_DIR, 'claro-release.apk');
  const aabPath = path.resolve(ANDROID_RELEASES_DIR, 'claro-release.aab');

  res.json({
    packageName: 'com.claro.messenger',
    versionName: '1.0.1',
    versionCode: 2,
    minSdk: 24,
    targetSdk: 35,
    apkReady: fs.existsSync(apkPath),
    apkSizeBytes: fs.existsSync(apkPath) ? fs.statSync(apkPath).size : 0,
    aabReady: fs.existsSync(aabPath),
    aabSizeBytes: fs.existsSync(aabPath) ? fs.statSync(aabPath).size : 0,
  });
});

app.get('/api/download-apk', async (req, res) => {
  const token = extractBearerToken(req);
  const user = await verifyFirebaseIdToken(token);
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const apkPath = path.resolve(ANDROID_RELEASES_DIR, 'claro-release.apk');
  if (!apkPath.startsWith(ANDROID_RELEASES_DIR + path.sep) || !fs.existsSync(apkPath)) {
    res.status(404).json({ error: 'APK package not found' });
    return;
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', 'attachment; filename="claro-v1.0.1.apk"');
  res.sendFile(apkPath);
});

app.get('/api/download-aab', async (req, res) => {
  const token = extractBearerToken(req);
  const user = await verifyFirebaseIdToken(token);
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const aabPath = path.resolve(ANDROID_RELEASES_DIR, 'claro-release.aab');
  if (!aabPath.startsWith(ANDROID_RELEASES_DIR + path.sep) || !fs.existsSync(aabPath)) {
    res.status(404).json({ error: 'AAB bundle not found' });
    return;
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="claro-v1.0.1.aab"');
  res.sendFile(aabPath);
});

async function startServer() {
  const server = http.createServer(app);

  // Real-Time WebSocket Server for presence pings, typing indicators, & fast signaling relay
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    let authedUid: string | null = null;

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as {
          type?: string;
          token?: string;
          to?: string;
          chatId?: string;
          payload?: unknown;
        };

        if (msg.type === 'auth' && typeof msg.token === 'string') {
          const user = await verifyFirebaseIdToken(msg.token);
          if (!user) {
            ws.send(JSON.stringify({ type: 'auth_error' }));
            ws.close();
            return;
          }
          authedUid = user.uid;
          if (!wsClients.has(authedUid)) {
            wsClients.set(authedUid, new Set());
          }
          wsClients.get(authedUid)?.add(ws);
          ws.send(JSON.stringify({ type: 'auth_ok', uid: authedUid }));
          return;
        }

        if (!authedUid) return;

        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          return;
        }

        if (
          (msg.type === 'typing' || msg.type === 'call_signal' || msg.type === 'delivery_ack') &&
          typeof msg.to === 'string'
        ) {
          const targets = wsClients.get(msg.to);
          if (targets) {
            const envelope = JSON.stringify({
              type: msg.type,
              from: authedUid,
              chatId: msg.chatId || '',
              payload: msg.payload ?? null,
            });
            for (const targetWs of targets) {
              if (targetWs.readyState === WebSocket.OPEN) {
                targetWs.send(envelope);
              }
            }
          }
        }
      } catch {
        // Ignore malformed frames
      }
    });

    ws.on('close', () => {
      if (authedUid) {
        const set = wsClients.get(authedUid);
        if (set) {
          set.delete(ws);
          if (set.size === 0) wsClients.delete(authedUid);
        }
      }
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Claro server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
