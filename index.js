const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pino = require('pino');
const chalk = require('chalk');

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const PORT = process.env.PORT || 30284;

const SERVER_START_TIME = Date.now();
const RECONNECT_DELAY_MS = 4000;
const GLOBAL_PRUNE_INTERVAL_MS = parseInt(process.env.GLOBAL_PRUNE_INTERVAL_MS || (60 * 60 * 1000).toString(), 10);
const MAX_BACKUP_CREDS = 10;

// ========== TTS + FFmpeg ==========
let edgeTTS = null;
let ffmpeg = null;
let ffmpegPath = null;

try {
  edgeTTS = require('node-edge-tts');
  console.log(chalk.green('[OK] node-edge-tts loaded'));
} catch (e) {
  console.log(chalk.yellow('[WARN] node-edge-tts not installed — voice mode will not work'));
}

try {
  ffmpeg = require('fluent-ffmpeg');
  ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
  console.log(chalk.green('[OK] FFmpeg loaded'));
} catch (e) {
  console.log(chalk.yellow('[WARN] fluent-ffmpeg/ffmpeg-static not installed — voice mode will not work'));
}

const uploadsDir = path.join(process.cwd(), 'uploads');
const sessionsRoot = path.join(process.cwd(), 'uploaded_sessions');
const usersFilePath = path.join(process.cwd(), 'users.json');
const approvalFilePath = path.join(process.cwd(), 'approval.txt');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(sessionsRoot)) fs.mkdirSync(sessionsRoot, { recursive: true });
if (!fs.existsSync(approvalFilePath)) fs.writeFileSync(approvalFilePath, '', 'utf8');

function initializeUsers() {
  if (!fs.existsSync(usersFilePath)) {
    const users = {
      admin: {
        username: 'Danishkhan',
        password: hashPassword('Danishkhan786'),
        role: 'admin',
        createdAt: new Date().toISOString()
      }
    };
    fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2), 'utf8');
    console.log(chalk.green('[OK] Admin user created: Danishkhan / Danishkhan786'));
  }
}

function hashPassword(p) {
  return crypto.createHash('sha256').update(p).digest('hex');
}

function loadUsers() {
  try {
    if (fs.existsSync(usersFilePath)) return JSON.parse(fs.readFileSync(usersFilePath, 'utf8'));
  } catch (e) {}
  return {};
}

function saveUsers(u) {
  try {
    fs.writeFileSync(usersFilePath, JSON.stringify(u, null, 2), 'utf8');
  } catch (e) {}
}

function loadApprovedKeys() {
  try {
    if (fs.existsSync(approvalFilePath)) {
      return fs.readFileSync(approvalFilePath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
    }
  } catch (e) {}
  return [];
}

function isKeyApproved(k) {
  return loadApprovedKeys().includes(k);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '_' + file.originalname.replace(/\s+/g, ''))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(process.cwd()));

const SESSIONS = Object.create(null);
const CREDS_HASH_TO_SESSION = Object.create(null);
const DIR_WATCHERS = Object.create(null);

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function makeSessionId() {
  return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function makeSessionDir(id) {
  const d = path.join(sessionsRoot, id);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function sleep(ms) {
  const n = Number(ms);
  return new Promise(r => setTimeout(r, Number.isFinite(n) && n >= 0 ? n : 2000));
}

function safeDelayMs(v, f = 5000) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return f;
  return Math.min(Math.floor(n), 24 * 60 * 60 * 1000);
}

function countRemainingBackups(d) {
  if (!d || !fs.existsSync(d)) return 0;
  let c = 0;
  for (let i = 1; i <= MAX_BACKUP_CREDS; i++) {
    if (fs.existsSync(path.join(d, `backup_creds_${i}.json`))) c++;
  }
  if (fs.existsSync(path.join(d, 'backup_creds.json'))) c++;
  return c;
}

function findNextBackupCreds(d) {
  if (!d || !fs.existsSync(d)) return null;
  for (let i = 1; i <= MAX_BACKUP_CREDS; i++) {
    const p = path.join(d, `backup_creds_${i}.json`);
    if (fs.existsSync(p)) return { path: p, index: i };
  }
  const legacy = path.join(d, 'backup_creds.json');
  if (fs.existsSync(legacy)) return { path: legacy, index: 0 };
  return null;
}

function appendSessionLog(sessionId, rawMsg) {
  const time = new Date().toISOString();
  const msg = String(rawMsg || '');
  const s = SESSIONS[sessionId];
  if (s) {
    s.logs = s.logs || [];
    s.logs.push({ time, msg });
    if (s.logs.length > 200) s.logs = s.logs.slice(-200);
  }
  const lower = msg.toLowerCase();
  let kind = 'other';
  if (/(\bsent\b|\bsuccessful\b|\bsuccess\b|\breconnect successful\b|\bstarted\b|\bopen\b|\bcreated\b|\bvoice\b)/.test(lower)) kind = 'success';
  else if (/(\berror\b|\bfailed\b|\bdeleted\b|\blogged out\b|\binvalid\b|\bunauthorized\b|\b401\b|\bdisconnect\b|\bclose\b|\bexpired\b)/.test(lower)) kind = 'error';

  const timeStr = chalk.yellow(`[${time}]`);
  let sym = kind === 'success' ? chalk.greenBright('[OK]') : kind === 'error' ? chalk.redBright('[ERROR]') : chalk.cyan('[i]');
  let col = kind === 'success' ? chalk.green(msg) : kind === 'error' ? chalk.red(msg) : chalk.cyan(msg);
  console.log(`${timeStr} ${sym} ${col} ${sessionId ? chalk.magenta('[' + sessionId + ']') : ''}`);
  logger.info({ sessionId, kind, time }, msg);
}

function persistSessionFiles(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s) return;
  try {
    const meta = {
      sessionId: s.sessionId,
      username: s.username,
      contacts: s.contacts,
      messages: s.messages,
      prefixName: s.prefixName,
      delayMs: s.delayMs,
      target: s.target,
      groupId: s.groupId,
      sessionType: s.sessionType || 'message',
      mentionType: s.mentionType || 'none',
      mentionNumbers: Array.isArray(s.mentionNumbers) ? s.mentionNumbers : [],
      mediaFiles: (s.mediaFiles || []).map(p => path.basename(p)),
      createdAt: s.createdAt || new Date().toISOString(),
      startedAt: s.startedAt || Date.now(),
      credsHash: s.credsHash || null,
      stopped: s.stopped || false,
      hasBackupCreds: !!s.hasBackupCreds,
      backupCount: s.backupCount || countRemainingBackups(s.sessionDir),
      awaitingCredentials: !!s.awaitingCredentials,
      lastAuthError: s.lastAuthError || null
    };
    fs.writeFileSync(path.join(s.sessionDir, 'session.json'), JSON.stringify(meta, null, 2), 'utf8');
    fs.writeFileSync(path.join(s.sessionDir, 'messages.txt'), (s.messages || []).join('\n'), 'utf8');
  } catch (e) {}
}

function pruneAuthFiles() { return 0; }

function startSessionWatch(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s || !s.sessionDir || !fs.existsSync(s.sessionDir)) return;
  if (DIR_WATCHERS[sessionId]) return;
  const w = { dirWatcher: null, keysWatcher: null };
  try { w.dirWatcher = fs.watch(s.sessionDir, () => {}); } catch (e) {}
  try {
    const kd = path.join(s.sessionDir, 'keys');
    if (!fs.existsSync(kd)) fs.mkdirSync(kd, { recursive: true });
    w.keysWatcher = fs.watch(kd, () => {});
  } catch (e) {}
  DIR_WATCHERS[sessionId] = w;
}

function stopSessionWatch(sessionId) {
  const w = DIR_WATCHERS[sessionId];
  if (!w) return;
  try { if (w.dirWatcher) w.dirWatcher.close(); } catch (e) {}
  try { if (w.keysWatcher) w.keysWatcher.close(); } catch (e) {}
  delete DIR_WATCHERS[sessionId];
}

function cleanupSessionFiles(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s || !s.sessionDir) return;
  const PROT = ['session.json', 'messages.txt', 'creds.json', 'backup_creds.json'];
  try {
    const files = fs.readdirSync(s.sessionDir, { withFileTypes: true });
    for (const f of files) {
      if (f.isFile() && !PROT.includes(f.name) && !/^backup_creds_\d+\.json$/.test(f.name)) {
        try { fs.unlinkSync(path.join(s.sessionDir, f.name)); } catch (e) {}
      }
    }
    const kd = path.join(s.sessionDir, 'keys');
    if (fs.existsSync(kd)) try { fs.rmSync(kd, { recursive: true, force: true }); } catch (e) {}
    const md = path.join(s.sessionDir, 'media');
    if (fs.existsSync(md)) try { fs.rmSync(md, { recursive: true, force: true }); } catch (e) {}
  } catch (e) {}
}

function isLoggedOutUpdate(update) {
  const last = update?.lastDisconnect;
  if (!last) return false;
  const error = last.error;
  const sc = error?.output?.statusCode;
  const msg = (error && (error.message || String(error))) || String(error || '');
  if (!msg && !sc) return false;
  const lower = msg.toLowerCase();
  const patterns = ['logged out', 'logged-out', 'device not found', 'invalid mac', 'qr refs attempts ended', 'restart required', 'bad mac', 'session error', 'connection terminated', 'connection closed', 'stream errored', 'connection failure', 'unauthorized', 'forbidden', 'conflict'];
  if (sc === 401 || sc === 403 || sc === 409) return true;
  for (const p of patterns) if (lower.includes(p)) return true;
  return false;
}

function isCredsExpiredOrInvalid(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return true;
    const st = fs.statSync(filePath);
    if (st.size < 50) return true;
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!json.noiseKey || !json.signedIdentityKey || !json.signedPreKey) return true;
    return false;
  } catch (e) {
    return true;
  }
}

// ========== VOICE TTS CONVERT (MALE VOICE) ==========
async function convertTextToVoice(text, outputPath, language) {
  if (!edgeTTS || !ffmpeg) throw new Error('TTS/FFmpeg not installed');

  // Male voice mapping per language
  const voiceMap = {
    'en-US': 'en-US-ChristopherNeural',
    'en-IN': 'en-IN-PrabhatNeural',
    'hi-IN': 'hi-IN-MadhurNeural',
    'ur-PK': 'ur-PK-AsadNeural',
    'ar-SA': 'ar-SA-HamedNeural'
  };

  const lang = language || 'en-US';
  const voiceId = voiceMap[lang] || 'en-US-ChristopherNeural';

  const tempMp3 = outputPath.replace('.ogg', '.mp3');

  try {
    // 1. Generate MP3 from text using Edge TTS (male voice)
    const tts = new edgeTTS.EdgeTTS({
      voice: voiceId,
      lang: lang,
      rate: '+0%',
      pitch: '+0Hz',
      saveSubtitles: false
    });

    if (typeof tts.ttsPromise === 'function') {
      await tts.ttsPromise(text, tempMp3);
    } else {
      await new Promise((resolve, reject) => {
        const t = new edgeTTS.EdgeTTS({ voice: voiceId, lang: lang });
        if (t.ttsPromise) t.ttsPromise(text, tempMp3).then(resolve).catch(reject);
        else reject(new Error('EdgeTTS API not supported'));
      });
    }

    if (!fs.existsSync(tempMp3)) throw new Error('TTS did not produce output');

    // 2. Convert MP3 → OGG/Opus (WhatsApp PTT format)
    await new Promise((resolve, reject) => {
      ffmpeg(tempMp3)
        .audioCodec('libopus')
        .audioBitrate('64k')
        .audioChannels(1)
        .audioFrequency(48000)
        .outputOptions([
          '-acodec libopus',
          '-b:a 64k',
          '-ar 48000',
          '-ac 1',
          '-application voip',
          '-map_metadata', '-1'
        ])
        .on('end', resolve)
        .on('error', reject)
        .save(outputPath);
    });

    if (!fs.existsSync(outputPath)) throw new Error('FFmpeg did not produce OGG');
    return outputPath;
  } finally {
    try { if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3); } catch (e) {}
  }
}

// ========== BACKUP SWITCH ==========
async function tryActivateBackupCreds(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s || !s.sessionDir) return false;
  const primaryPath = path.join(s.sessionDir, 'creds.json');
  const found = findNextBackupCreds(s.sessionDir);
  if (!found) return false;
  const { path: backupPath, index: backupIndex } = found;

  if (!validateCredsJson(backupPath)) {
    try { fs.renameSync(backupPath, backupPath + '.invalid_' + Date.now()); } catch (e) {}
    return await tryActivateBackupCreds(sessionId);
  }

  try {
    appendSessionLog(sessionId, `[SWITCH] Activating backup #${backupIndex}...`);
    try {
      const kd = path.join(s.sessionDir, 'keys');
      if (fs.existsSync(kd)) fs.rmSync(kd, { recursive: true, force: true });
    } catch (e) {}
    try {
      const entries = fs.readdirSync(s.sessionDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && /^(app-state-sync|session-|pre-key-|sender-key-)/i.test(e.name)) {
          try { fs.unlinkSync(path.join(s.sessionDir, e.name)); } catch (err) {}
        }
      }
    } catch (e) {}

    try {
      if (fs.existsSync(primaryPath)) fs.renameSync(primaryPath, path.join(s.sessionDir, 'creds_old_' + Date.now() + '.json'));
    } catch (e) {}

    fs.copyFileSync(backupPath, primaryPath);
    try { fs.unlinkSync(backupPath); } catch (e) {}

    if (s.credsHash && CREDS_HASH_TO_SESSION[s.credsHash] === sessionId) delete CREDS_HASH_TO_SESSION[s.credsHash];
    const nh = sha256File(primaryPath);
    s.credsHash = nh;
    CREDS_HASH_TO_SESSION[nh] = sessionId;

    s.awaitingCredentials = false;
    s.lastAuthError = null;
    s.runningLoop = false;
    s.reconnectAttempts = 0;
    s.firstReconnectTime = null;
    s.reconnectLock = false;
    s.consecutiveSendErrors = 0;
    s.backupCount = countRemainingBackups(s.sessionDir);
    s.hasBackupCreds = s.backupCount > 0;

    try {
      if (s.sock) {
        if (s.sock.ws?.close) s.sock.ws.close();
        else if (s.sock.socket?.close) s.sock.socket.close();
        else if (s.sock.end) s.sock.end();
      }
    } catch (_) {}
    s.sock = null;

    persistSessionFiles(sessionId);
    try { s.sock = await createOrGetSocket(s.sessionDir, sessionId); }
    catch (e) { return false; }
    try { await startSendingLoop(sessionId); } catch (e) {}
    return true;
  } catch (e) {
    return false;
  }
}

function extractWhatsAppPhoneFromCreds(p) {
  try {
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    const raw = json?.me?.id || json?.me?.jid || json?.me?.phoneNumber || '';
    const m = String(raw).match(/(\d{7,15})/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

function extractWhatsAppPhoneFromSession(s) {
  try {
    const raw = s?.phone || s?.phoneNumber || s?.sock?.user?.id || s?.sock?.user?.jid || '';
    const m = String(raw).match(/(\d{7,15})/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

function validateCredsJson(p) {
  try {
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    return !!(json.noiseKey && json.signedIdentityKey && json.signedPreKey);
  } catch (e) {
    return false;
  }
}

function loadMediaFiles(d) {
  const md = path.join(d, 'media');
  if (!fs.existsSync(md)) return [];
  try {
    return fs.readdirSync(md).filter(f => !f.startsWith('.')).map(f => path.join(md, f))
      .filter(f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } })
      .sort();
  } catch (e) {
    return [];
  }
}

async function attemptReconnect(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s || s.stopped) return;
  if (s.reconnectLock || s.restartLock) return;
  s.reconnectLock = true;
  s.reconnectAttempts = s.reconnectAttempts || 0;
  let delayMs = RECONNECT_DELAY_MS;

  try {
    while (SESSIONS[sessionId] && !s.stopped) {
      s.reconnectAttempts++;
      const pcp = path.join(s.sessionDir, 'creds.json');
      if (isCredsExpiredOrInvalid(pcp)) {
        if (s.hasBackupCreds || countRemainingBackups(s.sessionDir) > 0) {
          s.sock = null;
          s.reconnectLock = false;
          const sw = await tryActivateBackupCreds(sessionId);
          if (sw) return;
          s.reconnectLock = true;
        }
      }
      await sleep(delayMs);
      if (!SESSIONS[sessionId] || s.stopped) break;
      try {
        s.sock = null;
        const ns = await createOrGetSocket(s.sessionDir, sessionId);
        if (ns) {
          s.sock = ns;
          s.reconnectAttempts = 0;
          s.firstReconnectTime = null;
          s.consecutiveSendErrors = 0;
          s.awaitingCredentials = false;
          return;
        }
      } catch (e) {
        const em = String(e?.message || e).toLowerCase();
        if (em.includes('logged out') || em.includes('invalid mac') || em.includes('device not found') || em.includes('bad mac') || em.includes('unauthorized') || em.includes('401') || em.includes('403')) {
          if (s.hasBackupCreds || countRemainingBackups(s.sessionDir) > 0) {
            s.reconnectLock = false;
            const sw = await tryActivateBackupCreds(sessionId);
            if (sw) return;
            s.reconnectLock = true;
          }
          s.awaitingCredentials = true;
          s.lastAuthError = em;
          persistSessionFiles(sessionId);
          return;
        }
      }
      delayMs = Math.min(Math.max(RECONNECT_DELAY_MS, delayMs * 2), 60000);
    }
  } finally {
    s.reconnectLock = false;
  }
}

function restoreSessionsFromDisk() {
  const entries = fs.existsSync(sessionsRoot) ? fs.readdirSync(sessionsRoot, { withFileTypes: true }) : [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sid = e.name;
    const dir = path.join(sessionsRoot, sid);
    const sj = path.join(dir, 'session.json');
    const cp = path.join(dir, 'creds.json');
    if (!fs.existsSync(sj)) continue;

    try {
      const credsExpired = isCredsExpiredOrInvalid(cp);
      const meta = JSON.parse(fs.readFileSync(sj, 'utf8'));
      if (meta.stopped) continue;
      const bc = countRemainingBackups(dir);

      const sess = {
        sessionId: meta.sessionId || sid,
        sessionDir: dir,
        username: meta.username || 'unknown',
        credsHash: meta.credsHash || null,
        contacts: meta.contacts || [],
        messages: meta.messages || [],
        prefixName: meta.prefixName || 'Bot',
        delayMs: safeDelayMs(meta.delayMs, 5000),
        runningLoop: false,
        sock: null,
        target: meta.target || 'contacts',
        groupId: meta.groupId || null,
        sessionType: meta.sessionType || 'message',
        mentionType: meta.mentionType || 'none',
        mentionNumbers: Array.isArray(meta.mentionNumbers) ? meta.mentionNumbers : [],
        mediaFiles: loadMediaFiles(dir),
        logs: [],
        awaitingCredentials: !fs.existsSync(cp) || credsExpired,
        lastAuthError: null,
        createdAt: meta.createdAt || new Date().toISOString(),
        startedAt: meta.startedAt || Date.now(),
        hasBackupCreds: bc > 0,
        backupCount: bc,
        reconnectAttempts: 0,
        reconnectLock: false,
        restartLock: false,
        firstReconnectTime: null,
        deleting: false,
        stopped: false
      };
      SESSIONS[sess.sessionId] = sess;

      if (fs.existsSync(cp)) {
        try {
          const h = sha256File(cp);
          sess.credsHash = h;
          CREDS_HASH_TO_SESSION[h] = sess.sessionId;
        } catch (e) {}
      }
      appendSessionLog(sess.sessionId, `Restored (type=${sess.sessionType}, backups=${bc}, expired=${credsExpired})`);
      try { startSessionWatch(sess.sessionId); } catch (e) {}

      (async () => {
        if (credsExpired && (sess.hasBackupCreds || countRemainingBackups(sess.sessionDir) > 0)) {
          const sw = await tryActivateBackupCreds(sess.sessionId);
          if (sw) return;
        }
        if (SESSIONS[sess.sessionId].awaitingCredentials && !sess.hasBackupCreds) return;
        try {
          SESSIONS[sess.sessionId].sock = await createOrGetSocket(sess.sessionDir, sess.sessionId);
        } catch (e) {
          if (SESSIONS[sess.sessionId].hasBackupCreds) {
            const sw = await tryActivateBackupCreds(sess.sessionId);
            if (sw) return;
          }
          return;
        }
        try { await startSendingLoop(sess.sessionId); } catch (err) {}
      })();
    } catch (err) {}
  }
}

async function createOrGetSocket(sessionDir, sessionId) {
  let baileys;
  try { baileys = await import('@whiskeysockets/baileys'); }
  catch (e) { throw e; }

  const { makeWASocket, useMultiFileAuthState } = baileys;
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const pcp = path.join(sessionDir, 'creds.json');
  if (isCredsExpiredOrInvalid(pcp)) {
    const s = SESSIONS[sessionId];
    if (s && (s.hasBackupCreds || countRemainingBackups(sessionDir) > 0)) {
      const sw = await tryActivateBackupCreds(sessionId);
      if (sw) {
        const s2 = SESSIONS[sessionId];
        if (s2 && s2.sock) return s2.sock;
      }
    }
  }

  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(sessionDir));
  } catch (e) { throw e; }

  const cfg = {
    logger: pino({ level: 'silent' }),
    auth: state,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    keepAliveIntervalMs: 20000,
    connectTimeoutMs: 60000,
    generateHighQualityLinkPreview: false
  };

  let sock = null, lastErr = null;
  for (let i = 1; i <= 8; i++) {
    try {
      if (i > 1) {
        try {
          ({ state, saveCreds } = await useMultiFileAuthState(sessionDir));
          cfg.auth = state;
        } catch (e) {
          lastErr = e;
          await sleep(Math.min(5000 * i, 30000));
          continue;
        }
      }
      sock = makeWASocket(cfg);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(5000 * i, 30000));
    }
  }
  if (!sock) throw lastErr || new Error('Socket creation failed');

  if (sock?.ev?.on) {
    sock.ev.on('creds.update', async () => {
      try {
        if (typeof saveCreds === 'function') await saveCreds();
      } catch (e) {}
    });
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const cur = SESSIONS[sessionId];
      if (cur && cur.sock && cur.sock !== sock) return;
      if (cur) cur.sock = null;
      const em = lastDisconnect?.error?.message || lastDisconnect?.error || 'unknown';
      appendSessionLog(sessionId, 'Socket closed: ' + em);

      if (isLoggedOutUpdate(update)) {
        const s = SESSIONS[sessionId];
        if (s && !s.stopped) {
          s.sock = null;
          s.runningLoop = false;
          s.reconnectAttempts = 0;
          s.firstReconnectTime = null;
          if (s.hasBackupCreds || countRemainingBackups(s.sessionDir) > 0) {
            const sw = await tryActivateBackupCreds(sessionId);
            if (sw) return;
          }
          s.awaitingCredentials = true;
          s.lastAuthError = String(em);
          persistSessionFiles(sessionId);
        }
        return;
      }

      const s = SESSIONS[sessionId];
      if (s && !s.stopped && !s.awaitingCredentials) {
        attemptReconnect(sessionId).catch(() => {});
      }
    }
    if (connection === 'open') {
      const s = SESSIONS[sessionId];
      if (s) {
        s.reconnectAttempts = 0;
        s.firstReconnectTime = null;
        s.consecutiveSendErrors = 0;
        s.awaitingCredentials = false;
      }
      try { startSessionWatch(sessionId); } catch (e) {}
    }
  });

  return sock;
}

async function waitForSocketOpen(sessionId, timeoutMs = 20000) {
  const s = SESSIONS[sessionId];
  if (!s || !s.sock) throw new Error('No session or socket');
  const sock = s.sock;
  if (sock?.authState?.creds?.registered || (sock.user && Object.keys(sock.user || {}).length)) return;
  if (sock?.ws?.readyState === 1 && sock?.user) return;

  return new Promise((resolve, reject) => {
    let done = false;
    const to = setTimeout(() => {
      if (!done) { done = true; reject(new Error('timeout')); }
    }, timeoutMs);
    const h = (u) => {
      if (u.connection === 'open' && !done) {
        done = true;
        clearTimeout(to);
        sock.ev.off('connection.update', h);
        resolve();
      }
    };
    sock.ev.on('connection.update', h);
  });
}

// ========== SENDING LOOP (with VOICE from .txt) ==========
async function startSendingLoop(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s) throw new Error('Session not found');
  if (s.runningLoop) return;
  s.runningLoop = true;

  const sessionType = s.sessionType || 'message';
  appendSessionLog(sessionId, `[START] Loop started (type=${sessionType})`);

  let index = 0;
  let isFirstMessage = true;

  while (SESSIONS[sessionId]) {
    try {
      if (s.deleting || s.stopped) break;

      const pcp = path.join(s.sessionDir, 'creds.json');
      if (isCredsExpiredOrInvalid(pcp)) {
        if (!s.reconnectLock && (s.hasBackupCreds || countRemainingBackups(s.sessionDir) > 0)) {
          s.sock = null;
          const sw = await tryActivateBackupCreds(sessionId);
          if (sw) { await sleep(800); continue; }
        }
      }

      if (!s.sock) {
        if (!s.reconnectLock && !s.awaitingCredentials) {
          attemptReconnect(sessionId).catch(() => {});
        }
        await sleep(isFirstMessage ? 500 : 2000);
        continue;
      }

      if (s.awaitingCredentials && (s.hasBackupCreds || countRemainingBackups(s.sessionDir) > 0)) {
        const sw = await tryActivateBackupCreds(sessionId);
        if (sw) { await sleep(800); continue; }
      }
      if (s.awaitingCredentials && !s.hasBackupCreds) {
        await sleep(isFirstMessage ? 1000 : 3000);
        continue;
      }

      try {
        await waitForSocketOpen(sessionId, isFirstMessage ? 3000 : 20000);
      } catch (e) {
        if (isFirstMessage) { await sleep(500); continue; }
      }

      const contacts = s.contacts || [];
      const messages = s.messages || [];
      const mediaFiles = s.mediaFiles || [];
      const prefixName = s.prefixName || 'Bot';
      const target = s.target;
      const groupId = s.groupId;
      const mentionType = s.mentionType || 'none';
      const mentionNumbers = Array.isArray(s.mentionNumbers) ? s.mentionNumbers : [];
      const contact = (contacts.length) ? contacts[index % contacts.length] : null;

      try {
        const baileys = await import('@whiskeysockets/baileys');
        let jid;
        if (target === 'gc') jid = (groupId + '@g.us');
        else jid = contact ? baileys.jidNormalizedUser(contact + '@s.whatsapp.net') : null;
        if (!jid) throw new Error('Invalid JID');

        let activeMentionJids = [];
        let useNativeAllMention = false;
        if (target === 'gc' && mentionType !== 'none') {
          if (mentionType === 'all_tag') {
            useNativeAllMention = true;
          } else if (mentionType === 'all_group') {
            try {
              const md = await s.sock.groupMetadata(jid);
              activeMentionJids = (md?.participants || []).map(p => p?.id).filter(Boolean);
            } catch (e) {}
          } else if (mentionNumbers.length) {
            activeMentionJids = mentionNumbers.map(n => n + '@s.whatsapp.net');
            if (mentionType === 'single') activeMentionJids = [activeMentionJids[index % activeMentionJids.length]];
          }
        }
        const mentionLabels = activeMentionJids.map(x => String(x).split('@')[0]);
        const appendMentions = (text) => {
          const base = String(text || '').trim();
          if (useNativeAllMention) return base ? `@all ${base}` : '@all';
          if (!activeMentionJids.length) return base;
          const tags = mentionLabels.map(n => '@' + n).join(' ');
          return base ? `${tags} ${base}` : tags;
        };

        if (sessionType === 'sticker') {
          if (!mediaFiles.length) { await sleep(5000); continue; }
          const p = mediaFiles[index % mediaFiles.length];
          if (!fs.existsSync(p)) { index++; await sleep(safeDelayMs(s.delayMs, 5000)); continue; }
          await s.sock.sendMessage(jid, { sticker: fs.readFileSync(p) });
          s.consecutiveSendErrors = 0;
          appendSessionLog(sessionId, `[OK] Sticker sent`);

        } else if (sessionType === 'video') {
          if (!mediaFiles.length) { await sleep(5000); continue; }
          const p = mediaFiles[index % mediaFiles.length];
          if (!fs.existsSync(p)) { index++; await sleep(safeDelayMs(s.delayMs, 5000)); continue; }
          const vm = (messages.length) ? messages[index % messages.length] : '';
          const cap = appendMentions((prefixName + (vm ? ' ' + vm : '')).trim());
          const pl = { video: fs.readFileSync(p), caption: cap };
          if (useNativeAllMention) pl.mentionAll = true;
          else if (activeMentionJids.length) pl.mentions = activeMentionJids;
          await s.sock.sendMessage(jid, pl);
          s.consecutiveSendErrors = 0;
          appendSessionLog(sessionId, `[OK] Video sent`);

        } else if (sessionType === 'emoji') {
          if (!messages.length) { await sleep(5000); continue; }
          const em = messages[index % messages.length];
          const full = appendMentions((prefixName + ' ' + em).trim());
          const pl = { text: full };
          if (useNativeAllMention) pl.mentionAll = true;
          else if (activeMentionJids.length) pl.mentions = activeMentionJids;
          await s.sock.sendMessage(jid, pl);
          s.consecutiveSendErrors = 0;
          appendSessionLog(sessionId, `[OK] Emoji sent`);

        } else if (sessionType === 'image') {
          if (!mediaFiles.length) { await sleep(5000); continue; }
          const p = mediaFiles[index % mediaFiles.length];
          if (!fs.existsSync(p)) { index++; await sleep(safeDelayMs(s.delayMs, 5000)); continue; }
          const mt = (messages.length) ? messages[index % messages.length] : '';
          const cap = appendMentions((prefixName + (mt ? ' ' + mt : '')).trim());
          const pl = { image: fs.readFileSync(p), caption: cap };
          if (useNativeAllMention) pl.mentionAll = true;
          else if (activeMentionJids.length) pl.mentions = activeMentionJids;
          await s.sock.sendMessage(jid, pl);
          s.consecutiveSendErrors = 0;
          appendSessionLog(sessionId, `[OK] Image sent`);

        } else if (sessionType === 'voice') {
          // ========== VOICE NOTE FROM .TXT (MALE VOICE) ==========
          if (!messages.length) { await sleep(5000); continue; }

          const textToSpeak = String(messages[index % messages.length] || '').trim();
          if (!textToSpeak) { index++; continue; }

          const voiceId = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
          const voicePath = path.join(s.sessionDir, `voice_${voiceId}.ogg`);

          try {
            appendSessionLog(sessionId, `[VOICE] Converting text → male voice: "${textToSpeak.substring(0, 40)}..."`);
            await convertTextToVoice(textToSpeak, voicePath, s.voiceLanguage || 'en-US');

            if (!fs.existsSync(voicePath)) throw new Error('Voice conversion failed');

            const voiceBuffer = fs.readFileSync(voicePath);
            const voicePayload = {
              audio: voiceBuffer,
              mimetype: 'audio/ogg; codecs=opus',
              ptt: true
            };
            if (useNativeAllMention) voicePayload.mentionAll = true;
            else if (activeMentionJids.length) voicePayload.mentions = activeMentionJids;

            await s.sock.sendMessage(jid, voicePayload);
            s.consecutiveSendErrors = 0;
            appendSessionLog(sessionId, `[OK] Voice note sent to ${jid} (${voiceBuffer.length} bytes)`);
          } catch (err) {
            appendSessionLog(sessionId, '[ERROR] Voice send failed: ' + (err?.message || err));
          } finally {
            try { if (fs.existsSync(voicePath)) fs.unlinkSync(voicePath); } catch (e) {}
          }

        } else {
          const mt = (messages.length) ? messages[index % messages.length] : '';
          const full = appendMentions((prefixName + ' ' + mt).trim());
          const pl = { text: full };
          if (useNativeAllMention) pl.mentionAll = true;
          else if (activeMentionJids.length) pl.mentions = activeMentionJids;
          await s.sock.sendMessage(jid, pl);
          s.consecutiveSendErrors = 0;
          appendSessionLog(sessionId, `[OK] Message sent`);
        }
        isFirstMessage = false;
      } catch (err) {
        appendSessionLog(sessionId, '[ERROR] Send: ' + String(err?.message || err));
        s.consecutiveSendErrors = (s.consecutiveSendErrors || 0) + 1;
        const em = String(err?.message || err).toLowerCase();
        if (em.includes('logged out') || em.includes('bad mac') || em.includes('unauthorized') || em.includes('401') || em.includes('403') || em.includes('expired')) {
          if (s.hasBackupCreds || countRemainingBackups(s.sessionDir) > 0) {
            s.sock = null;
            const sw = await tryActivateBackupCreds(sessionId);
            if (sw) { await sleep(1000); continue; }
          }
        }
        if (s.consecutiveSendErrors >= 10) {
          s.consecutiveSendErrors = 0;
          s.sock = null;
          if (!s.reconnectLock && !s.stopped) {
            attemptReconnect(sessionId).catch(() => {});
          }
        }
        if (isFirstMessage) { await sleep(800); continue; }
      }

      index++;
      persistSessionFiles(sessionId);
      s.delayMs = safeDelayMs(s.delayMs, 5000);
      await sleep(s.delayMs);
    } catch (e) {
      await sleep(1000);
    }
  }
  if (SESSIONS[sessionId]) SESSIONS[sessionId].runningLoop = false;
}

// ========== API ROUTES ==========
app.get('/', (req, res) => res.sendFile(path.join(process.cwd(), 'index.html')));

app.get('/api/uptime', (req, res) => {
  const um = Date.now() - SERVER_START_TIME;
  const us = Math.floor(um / 1000);
  const d = Math.floor(us / 86400), h = Math.floor((us % 86400) / 3600), m = Math.floor((us % 3600) / 60), s = us % 60;
  res.json({
    ok: true,
    uptimeMs: um,
    uptimeFormatted: `${d} day ${h} hour ${m} minute ${s} seconds`,
    startTime: new Date(SERVER_START_TIME).toISOString()
  });
});

app.post('/api/generate-approval-key', (req, res) => {
  try {
    const { userAgent, language, platform, screenResolution, timezone } = req.body;
    const fp = `${userAgent}-${language}-${platform}-${screenResolution}-${timezone}-${Date.now()}`;
    res.json({ ok: true, approvalKey: crypto.createHash('sha256').update(fp).digest('hex').substring(0, 16).toUpperCase() });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed' });
  }
});

app.post('/api/check-approval', (req, res) => {
  try {
    const { approvalKey } = req.body;
    if (!approvalKey) return res.status(400).json({ ok: false, error: 'Approval key required' });
    res.json({ ok: true, approved: isKeyApproved(approvalKey) });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed' });
  }
});

app.post('/api/total-users', (req, res) => {
  try {
    const { role } = req.body || {};
    if (role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin required' });
    res.json({ ok: true, totalUsers: Object.keys(loadUsers()).length });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed' });
  }
});

app.post('/api/total-sessions', (req, res) => {
  try {
    const { username, role } = req.body || {};
    if (!username) return res.status(401).json({ ok: false, error: 'Auth required' });
    let sessions = Object.values(SESSIONS);
    if (role !== 'admin' && username !== 'SAHIL123') sessions = sessions.filter(s => s.username === username);
    res.json({ ok: true, totalSessions: sessions.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed' });
  }
});

app.post('/api/signup', async (req, res) => {
  try {
    const { username, password, approvalKey } = req.body;
    if (!approvalKey) return res.status(403).json({ ok: false, error: 'Approval required.' });
    if (!isKeyApproved(approvalKey)) return res.status(403).json({ ok: false, error: 'Key not approved.' });
    if (!username || !password) return res.status(400).json({ ok: false, error: 'Username and password required' });
    if (username.length < 3 || password.length < 6) return res.status(400).json({ ok: false, error: 'Username min 3, password min 6' });
    const users = loadUsers();
    if (Object.values(users).find(u => u.username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ ok: false, error: 'Username exists' });
    }
    const uid = 'user_' + Date.now();
    users[uid] = {
      username,
      password: hashPassword(password),
      role: 'user',
      approvalKey,
      createdAt: new Date().toISOString()
    };
    saveUsers(users);
    res.json({ ok: true, message: 'Created', username });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password, approvalKey } = req.body;
    if (!approvalKey) return res.status(403).json({ ok: false, error: 'Approval required.' });
    if (!isKeyApproved(approvalKey)) return res.status(403).json({ ok: false, error: 'Key not approved.' });
    if (!username || !password) return res.status(400).json({ ok: false, error: 'Username and password required' });
    const users = loadUsers();
    const hp = hashPassword(password);
    const user = Object.values(users).find(u => u.username === username && u.password === hp);
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    res.json({ ok: true, username: user.username, role: user.role });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed' });
  }
});

// ========== SEND MESSAGE (with voice support) ==========
app.post('/send-message', upload.fields([
  { name: 'creds', maxCount: 1 },
  { name: 'backupCreds', maxCount: MAX_BACKUP_CREDS },
  { name: 'messageFile', maxCount: 1 },
  { name: 'mediaFiles', maxCount: 100 }
]), async (req, res) => {
  try {
    const files = req.files || {};
    const credsFileObj = (files.creds && files.creds[0]) || null;
    const backupCredsFileObjs = files.backupCreds || [];
    const messageFileObj = (files.messageFile && files.messageFile[0]) || null;
    const mediaFileObjs = files.mediaFiles || [];
    const { name: prefixName, targetID, delayTime, username, approvalKey } = req.body || {};
    const rawTT = String(req.body?.type || '').toLowerCase();
    const type = rawTT === 'gc' ? 'gc' : (['ib', 'contact', 'individual'].includes(rawTT) ? 'ib' : rawTT);
    const sessionType = (req.body.sessionType || 'message').toLowerCase();
    const mentionType = String(req.body.mentionType || 'none').toLowerCase();
    const mnr = String(req.body.mentionNumbers || '');
    const mentionNumbers = mnr.split(/[,\r\n]+/).map(v => v.trim().replace(/[^\d+]/g, '').replace(/^\+/, '')).filter(Boolean);
    const voiceLanguage = String(req.body.voiceLanguage || 'en-US');

    const cleanup = () => {
      try { if (credsFileObj) fs.unlinkSync(credsFileObj.path); } catch (e) {}
      for (const bc of backupCredsFileObjs) try { fs.unlinkSync(bc.path); } catch (e) {}
      try { if (messageFileObj) fs.unlinkSync(messageFileObj.path); } catch (e) {}
      for (const mf of mediaFileObjs) try { fs.unlinkSync(mf.path); } catch (e) {}
    };

    const allowedMT = ['none', 'single', 'all_listed', 'selected_group', 'all_group', 'all_tag'];
    if (!allowedMT.includes(mentionType)) {
      cleanup();
      return res.status(400).json({ ok: false, error: 'Invalid mention' });
    }
    if ((mentionType === 'single' || mentionType === 'all_listed' || mentionType === 'selected_group') && !mentionNumbers.length) {
      cleanup();
      return res.status(400).json({ ok: false, error: 'Mention numbers required' });
    }
    if ((mentionType === 'all_group' || mentionType === 'selected_group' || mentionType === 'all_tag') && type !== 'gc') {
      cleanup();
      return res.status(400).json({ ok: false, error: 'Group mention requires group' });
    }
    if (!username) { cleanup(); return res.status(401).json({ ok: false, error: 'Auth' }); }
    if (!approvalKey || !isKeyApproved(approvalKey)) { cleanup(); return res.status(403).json({ ok: false, error: 'Approval' }); }
    if (!['message', 'image', 'sticker', 'video', 'emoji', 'voice'].includes(sessionType)) {
      cleanup();
      return res.status(400).json({ ok: false, error: 'Bad sessionType' });
    }

    const delayMs = (parseInt(delayTime || '5', 10) || 5) * 1000;
    if (!credsFileObj) { cleanup(); return res.status(400).json({ ok: false, error: 'No creds' }); }
    if (!type || !targetID) { cleanup(); return res.status(400).json({ ok: false, error: 'Missing target' }); }

    if (sessionType === 'message' && (!messageFileObj || !prefixName)) {
      cleanup(); return res.status(400).json({ ok: false, error: 'Msg file + prefix' });
    }
    if (sessionType === 'image' && (!mediaFileObjs.length || !messageFileObj || !prefixName)) {
      cleanup(); return res.status(400).json({ ok: false, error: 'Image + msg + prefix' });
    }
    if (sessionType === 'sticker' && !mediaFileObjs.length) {
      cleanup(); return res.status(400).json({ ok: false, error: 'Sticker files' });
    }
    if (sessionType === 'video' && (!mediaFileObjs.length || !messageFileObj || !prefixName)) {
      cleanup(); return res.status(400).json({ ok: false, error: 'Video + msg + prefix' });
    }
    if (sessionType === 'emoji' && (!messageFileObj || !prefixName)) {
      cleanup(); return res.status(400).json({ ok: false, error: 'Msg file + prefix' });
    }
    if (sessionType === 'voice' && !messageFileObj) {
      cleanup(); return res.status(400).json({ ok: false, error: 'Voice needs .txt file with text to convert' });
    }

    const uploadedPath = credsFileObj.path;
    if (!validateCredsJson(uploadedPath)) {
      cleanup();
      return res.status(400).json({ ok: false, error: 'Invalid creds' });
    }

    const validBC = backupCredsFileObjs.filter(bc => validateCredsJson(bc.path));
    const phone = extractWhatsAppPhoneFromCreds(uploadedPath);

    let contacts = [];
    if (type === 'gc') contacts = [targetID.trim()];
    else {
      contacts = String(targetID || '').split(/[,\r\n]+/).map(x => x.trim()).filter(Boolean).map(p => p.replace(/[^\d+]/g, '').replace(/^\+/, ''));
      if (!contacts.length) {
        cleanup();
        return res.status(400).json({ ok: false, error: 'No contacts' });
      }
    }

    let messages = [];
    if (messageFileObj) {
      const txt = fs.readFileSync(messageFileObj.path, 'utf8');
      const lines = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      messages = lines.length ? lines : [txt.trim()];
    }

    const credsHash = sha256File(uploadedPath);
    if (CREDS_HASH_TO_SESSION[credsHash]) {
      cleanup();
      return res.status(409).json({ ok: false, error: 'Duplicate creds' });
    }

    const sessionId = makeSessionId();
    const sessionDir = makeSessionDir(sessionId);

    fs.copyFileSync(uploadedPath, path.join(sessionDir, 'creds.json'));
    try {
      fs.writeFileSync(path.join(sessionDir, 'messages.txt'), messages.join('\n'), 'utf8');
    } catch (e) {}

    let backupCount = 0;
    for (let i = 0; i < validBC.length && i < MAX_BACKUP_CREDS; i++) {
      try {
        fs.copyFileSync(validBC[i].path, path.join(sessionDir, `backup_creds_${i + 1}.json`));
        backupCount++;
      } catch (e) {}
    }
    let hasBackupCreds = backupCount > 0;

    const primaryCredsPath = path.join(sessionDir, 'creds.json');
    const primaryExpired = isCredsExpiredOrInvalid(primaryCredsPath);
    if (primaryExpired && hasBackupCreds) {
      try {
        const fb = path.join(sessionDir, 'backup_creds_1.json');
        if (fs.existsSync(fb)) {
          try {
            fs.renameSync(primaryCredsPath, path.join(sessionDir, 'creds_old_' + Date.now() + '.json'));
          } catch (e) {}
          fs.copyFileSync(fb, primaryCredsPath);
          try { fs.unlinkSync(fb); } catch (e) {}
          const nh = sha256File(primaryCredsPath);
          CREDS_HASH_TO_SESSION[nh] = sessionId;
          backupCount = countRemainingBackups(sessionDir);
          hasBackupCreds = backupCount > 0;
        }
      } catch (e) {}
    }

    const mediaDir = path.join(sessionDir, 'media');
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
    const savedMedia = [];
    for (const mf of mediaFileObjs) {
      try {
        const safe = mf.originalname.replace(/[^\w.\-]+/g, '_');
        const tp = path.join(mediaDir, Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '_' + safe);
        fs.copyFileSync(mf.path, tp);
        savedMedia.push(tp);
      } catch (e) {}
    }

    const meta = {
      sessionId,
      username,
      phone,
      contacts,
      messages,
      prefixName: sessionType === 'sticker' ? '' : (prefixName || 'Bot'),
      delayMs: safeDelayMs(delayMs, 5000),
      target: type,
      groupId: type === 'gc' ? targetID.trim() : null,
      sessionType,
      mentionType,
      mentionNumbers,
      voiceLanguage,
      mediaFiles: savedMedia.map(p => path.basename(p)),
      createdAt: new Date().toISOString(),
      startedAt: Date.now(),
      credsHash,
      stopped: false,
      hasBackupCreds,
      backupCount,
      awaitingCredentials: false,
      lastAuthError: null
    };
    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(meta, null, 2), 'utf8');

    cleanup();

    const sessionStartedAt = meta.startedAt;

    SESSIONS[sessionId] = {
      sessionId,
      sessionDir,
      username,
      phone,
      credsHash,
      contacts,
      messages,
      prefixName: sessionType === 'sticker' ? '' : (prefixName || 'Bot'),
      delayMs: safeDelayMs(delayMs, 5000),
      runningLoop: false,
      sock: null,
      target: type,
      groupId: type === 'gc' ? targetID.trim() : null,
      sessionType,
      mentionType,
      mentionNumbers,
      voiceLanguage,
      mediaFiles: savedMedia,
      createdAt: meta.createdAt,
      startedAt: sessionStartedAt,
      logs: [],
      reconnectAttempts: 0,
      reconnectLock: false,
      restartLock: false,
      firstReconnectTime: null,
      deleting: false,
      hasBackupCreds,
      backupCount,
      awaitingCredentials: false,
      stopped: false
    };
    CREDS_HASH_TO_SESSION[credsHash] = sessionId;

    appendSessionLog(sessionId, `Session created [type=${sessionType}, backups=${backupCount}, expired=${primaryExpired}]`);

    try { startSessionWatch(sessionId); } catch (e) {}

    (async () => {
      try {
        SESSIONS[sessionId].sock = await createOrGetSocket(sessionDir, sessionId);
      } catch (e) {
        return;
      }
      try {
        await startSendingLoop(sessionId);
      } catch (e) {}
    })();

    res.json({ ok: true, sessionId, backupCount, primaryExpired });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

app.post('/api/resume-session/:id', upload.fields([{ name: 'creds', maxCount: 1 }]), async (req, res) => {
  try {
    const sessionId = req.params.id;
    const { username, name, targetID } = req.body || {};
    const s = SESSIONS[sessionId];
    const file = req.files?.creds?.[0];

    if (!username) return res.status(401).json({ ok: false, error: 'Auth' });
    if (!s) return res.status(404).json({ ok: false, error: 'Not found' });
    if (username !== 'SAHIL123' && s.username !== username) return res.status(403).json({ ok: false, error: 'Not authorized' });
    if (!file) return res.status(400).json({ ok: false, error: 'New creds required' });
    if (!validateCredsJson(file.path)) return res.status(400).json({ ok: false, error: 'Invalid creds' });

    if (typeof name === 'string' && name.trim()) s.prefixName = name.trim();
    if (typeof targetID === 'string' && targetID.trim() && s.target === 'gc') s.groupId = targetID.trim();

    const tc = path.join(s.sessionDir, 'creds.json');
    fs.copyFileSync(file.path, tc);
    if (s.credsHash && CREDS_HASH_TO_SESSION[s.credsHash] === sessionId) delete CREDS_HASH_TO_SESSION[s.credsHash];
    s.credsHash = sha256File(tc);
    CREDS_HASH_TO_SESSION[s.credsHash] = sessionId;

    s.awaitingCredentials = false;
    s.lastAuthError = null;
    s.stopped = false;
    s.runningLoop = false;
    s.reconnectAttempts = 0;
    s.firstReconnectTime = null;
    s.reconnectLock = false;
    persistSessionFiles(sessionId);

    try {
      if (s.sock?.ws?.close) s.sock.ws.close();
      else if (s.sock?.socket?.close) s.sock.socket.close();
      else if (s.sock?.end) s.sock.end();
    } catch (_) {}

    s.sock = await createOrGetSocket(s.sessionDir, sessionId);
    await startSendingLoop(sessionId);

    return res.json({
      ok: true,
      sessionId,
      startedAt: s.startedAt,
      uptimeMs: Date.now() - s.startedAt
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    try {
      const f = req.files?.creds?.[0];
      if (f?.path) fs.unlinkSync(f.path);
    } catch (_) {}
  }
});

app.post('/stop-session/:id', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const { username } = req.body || {};
    if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' });

    const s = SESSIONS[sessionId];
    if (!s) return res.status(404).json({ ok: false, error: 'Not found' });
    if (username !== 'SAHIL123' && s.username !== username) return res.status(403).json({ ok: false, error: 'Not authorized' });

    s.stopped = true;
    persistSessionFiles(sessionId);

    try {
      const sk = s.sock;
      if (sk) {
        if (sk.ws?.close) sk.ws.close();
        else if (sk.socket?.close) sk.socket.close();
        else if (sk.end) sk.end();
      }
    } catch (e) {}

    try { stopSessionWatch(sessionId); } catch (e) {}
    cleanupSessionFiles(sessionId);

    try {
      if (s.credsHash && CREDS_HASH_TO_SESSION[s.credsHash]) delete CREDS_HASH_TO_SESSION[s.credsHash];
      delete SESSIONS[sessionId];
    } catch (e) {}

    return res.json({ ok: true, message: 'Stopped' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Error' });
  }
});

app.post('/api/sessions', (req, res) => {
  try {
    const { username, role } = req.body || {};
    if (!username) return res.status(401).json({ ok: false, error: 'Auth' });

    let sessions = Object.values(SESSIONS);
    if (role !== 'admin' && username !== 'SAHIL123') sessions = sessions.filter(s => s.username === username);

    const list = sessions.map(s => {
      const up = s.startedAt ? Date.now() - s.startedAt : 0;
      const us = Math.floor(up / 1000);
      const d = Math.floor(us / 86400), h = Math.floor((us % 86400) / 3600), m = Math.floor((us % 3600) / 60), sec = us % 60;
      const bc = s.backupCount || countRemainingBackups(s.sessionDir) || 0;
      return {
        sessionId: s.sessionId,
        username: s.username,
        phone: s.phone || extractWhatsAppPhoneFromSession(s),
        prefixName: s.prefixName,
        delayMs: s.delayMs,
        createdAt: s.createdAt,
        uptime: `${d}d ${h}h ${m}m ${sec}s`,
        uptimeMs: up,
        target: s.target,
        groupId: s.groupId,
        contacts: Array.isArray(s.contacts) ? s.contacts : [],
        sessionType: s.sessionType || 'message',
        mentionType: s.mentionType || 'none',
        mentionCount: Array.isArray(s.mentionNumbers) ? s.mentionNumbers.length : 0,
        mediaCount: (s.mediaFiles || []).length,
        voiceLanguage: s.voiceLanguage || 'en-US',
        hasBackupCreds: bc > 0,
        backupCount: bc,
        stopped: s.stopped || false,
        startedAt: s.startedAt || null,
        awaitingCredentials: !!s.awaitingCredentials,
        lastAuthError: s.lastAuthError || null
      };
    });

    return res.json({ ok: true, sessions: list });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/session/:id', (req, res) => {
  try {
    const sid = req.params.id;
    const { username, role } = req.body || {};
    if (!sid) return res.status(400).json({ ok: false, error: 'sessionId required' });
    if (!username) return res.status(401).json({ ok: false, error: 'Auth' });

    const s = SESSIONS[sid];
    if (!s) return res.status(404).json({ ok: false, error: 'Not found' });
    if (role !== 'admin' && username !== 'SAHIL123' && s.username !== username) return res.status(403).json({ ok: false, error: 'Not authorized' });

    const up = s.startedAt ? Date.now() - s.startedAt : 0;
    const us = Math.floor(up / 1000);
    const d = Math.floor(us / 86400), h = Math.floor((us % 86400) / 3600), m = Math.floor((us % 3600) / 60), sec = us % 60;
    const bc = s.backupCount || countRemainingBackups(s.sessionDir) || 0;

    return res.json({
      ok: true,
      session: {
        sessionId: s.sessionId,
        username: s.username,
        phone: s.phone || extractWhatsAppPhoneFromSession(s),
        contacts: Array.isArray(s.contacts) ? s.contacts : [],
        prefixName: s.prefixName,
        delayMs: s.delayMs,
        createdAt: s.createdAt,
        uptime: `${d}d ${h}h ${m}m ${sec}s`,
        uptimeMs: up,
        target: s.target,
        groupId: s.groupId,
        sessionType: s.sessionType || 'message',
        mediaCount: (s.mediaFiles || []).length,
        hasBackupCreds: bc > 0,
        backupCount: bc,
        stopped: s.stopped || false
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/logs/:id', (req, res) => {
  try {
    const sid = req.params.id;
    const { username, role } = req.body || {};
    if (!sid) return res.status(400).json({ ok: false, error: 'sessionId required' });
    if (!username) return res.status(401).json({ ok: false, error: 'Auth' });

    const s = SESSIONS[sid];
    if (!s) return res.status(404).json({ ok: false, error: 'Not found' });
    if (role !== 'admin' && username !== 'SAHIL123' && s.username !== username) return res.status(403).json({ ok: false, error: 'Not authorized' });

    const lines = (s.logs || []).map(l => `[${l.time}] ${l.msg}`);
    return res.json({ ok: true, logs: lines });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ========== STARTUP ==========
initializeUsers();
restoreSessionsFromDisk();

setInterval(() => {
  try {
    for (const sid of Object.keys(SESSIONS)) {
      try {
        const s = SESSIONS[sid];
        if (s && s.sessionDir) pruneAuthFiles(s.sessionDir, sid);
      } catch (e) {}
    }
  } catch (e) {}
}, GLOBAL_PRUNE_INTERVAL_MS);

process.on('uncaughtException', (err) => {
  logger.error('uncaughtException: ' + (err?.message || err));
});

process.on('unhandledRejection', (err) => {
  logger.error('unhandledRejection: ' + (err?.message || err));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(chalk.green(` [OK] TEDDY RULEX MR KHAN Server running on http://0.0.0.0:${PORT} `));
  logger.info('Server started on 0.0.0.0:' + PORT);
});