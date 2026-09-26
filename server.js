import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import cors from 'cors';
import multer from 'multer';
import PDFDocument from 'pdfkit';
import { v4 as uuid } from 'uuid';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import Groq from 'groq-sdk';
import { matchReports } from './services/matching.js';

const app = express();
const PORT = process.env.PORT || 5000;
const MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD || 55);
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_MB || 8) * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const allowedOrigins = (process.env.CORS_ORIGINS || `http://localhost:${PORT},http://127.0.0.1:${PORT}`)
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed by CORS.'));
  },
}));
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public', {
  maxAge: 0,
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES },
  fileFilter(req, file, cb) {
    if (!IMAGE_TYPES.has(file.mimetype)) return cb(new Error('INVALID_IMAGE_TYPE'));
    return cb(null, true);
  },
});

let auth = null;
let db = null;
let s3 = null;
let groq = null;

function configured(v) {
  return !!v && !/^YOUR_|^$/.test(String(v));
}

try {
  if (configured(process.env.FIREBASE_PROJECT_ID) && configured(process.env.FIREBASE_CLIENT_EMAIL) && configured(process.env.FIREBASE_PRIVATE_KEY)) {
    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
      });
    }
    auth = getAuth();
    db = getFirestore();
  }
} catch (error) {
  console.error('Firebase initialization:', error.message);
}

if (configured(process.env.B2_ENDPOINT) && configured(process.env.B2_REGION) && configured(process.env.B2_KEY_ID) && configured(process.env.B2_APPLICATION_KEY)) {
  s3 = new S3Client({
    endpoint: process.env.B2_ENDPOINT,
    region: process.env.B2_REGION,
    credentials: {
      accessKeyId: process.env.B2_KEY_ID,
      secretAccessKey: process.env.B2_APPLICATION_KEY,
    },
  });
}

if (configured(process.env.GROQ_API_KEY)) groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const memory = { users: new Map(), reports: new Map(), notifications: new Map(), matches: new Map(), audit: [] };
const col = (name) => db?.collection(name);
const now = () => Date.now();
const adminUid = () => process.env.ADMIN_UID || '';
const isAdminUid = (uid) => !!adminUid() && uid === adminUid();

function firebaseClientConfig() {
  return {
    apiKey: process.env.FIREBASE_WEB_API_KEY || process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || (process.env.FIREBASE_PROJECT_ID ? `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com` : ''),
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.FIREBASE_APP_ID || '',
  };
}

async function verify(req, res, next) {
  if (!auth) return res.status(503).json({ error: 'Firebase Admin is not configured on the server.' });
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required.' });
  try {
    req.user = await auth.verifyIdToken(header.slice(7));
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid session. Please sign in again.' });
  }
}

function requireAdmin(req, res, next) {
  if (!isAdminUid(req.user.uid)) return res.status(403).json({ error: 'Admin access required.' });
  return next();
}

function imageUrlForKey(key) {
  return `/api/images/${String(key).split('/').map(encodeURIComponent).join('/')}`;
}

// --- High-Performance In-Memory Accelerators ---
const profileCache = new Map();
const PROFILE_CACHE_TTL = 60000;

let cachedUsers = null;
let cachedUsersExpiry = 0;
const USERS_CACHE_TTL = 30000;

let cachedReports = null;
let cachedReportsExpiry = 0;
const REPORTS_CACHE_TTL = 20000;
const reportByIdCache = new Map();
const reportByImageKeyCache = new Map();

const imageBufferCache = new Map();
const MAX_IMAGE_CACHE_ENTRIES = 50;

function invalidateReportCaches() {
  cachedReports = null;
  cachedReportsExpiry = 0;
  reportByIdCache.clear();
  reportByImageKeyCache.clear();
}

function invalidateUserCaches(uid = null) {
  cachedUsers = null;
  cachedUsersExpiry = 0;
  if (uid) profileCache.delete(uid);
  else profileCache.clear();
}

async function profile(uid) {
  if (!uid) return null;
  const cached = profileCache.get(uid);
  if (cached && now() < cached.expiry) {
    return cached.data;
  }
  let p = null;
  if (db) {
    const snap = await col('users').doc(uid).get();
    p = snap.exists ? { uid, ...snap.data() } : null;
  } else {
    p = memory.users.get(uid) || null;
  }
  if (p) {
    profileCache.set(uid, { data: p, expiry: now() + PROFILE_CACHE_TTL });
  }
  return p;
}

async function saveProfile(p) {
  if (db) await col('users').doc(p.uid).set(p, { merge: true });
  else memory.users.set(p.uid, p);
  profileCache.set(p.uid, { data: p, expiry: now() + PROFILE_CACHE_TTL });
  cachedUsers = null;
}

async function listUsers() {
  const currentTime = now();
  if (cachedUsers && currentTime < cachedUsersExpiry) {
    return cachedUsers;
  }
  if (db) {
    const snap = await col('users').get();
    cachedUsers = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  } else {
    cachedUsers = [...memory.users.values()];
  }
  cachedUsersExpiry = currentTime + USERS_CACHE_TTL;
  return cachedUsers;
}

async function listReports() {
  const currentTime = now();
  if (cachedReports && currentTime < cachedReportsExpiry) {
    return cachedReports;
  }
  let reports = [];
  if (db) {
    const snap = await col('reports').orderBy('createdAt', 'desc').limit(500).get();
    reports = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } else {
    reports = [...memory.reports.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  cachedReports = reports;
  cachedReportsExpiry = currentTime + REPORTS_CACHE_TTL;
  reportByIdCache.clear();
  reportByImageKeyCache.clear();
  for (const r of reports) {
    reportByIdCache.set(r.id, r);
    if (r.imageKey) reportByImageKeyCache.set(r.imageKey, r);
  }
  return reports;
}

async function getReport(id) {
  if (!id) return null;
  if (reportByIdCache.has(id)) {
    return reportByIdCache.get(id);
  }
  if (db) {
    const snap = await col('reports').doc(id).get();
    const r = snap.exists ? { id: snap.id, ...snap.data() } : null;
    if (r) reportByIdCache.set(r.id, r);
    return r;
  }
  return memory.reports.get(id) || null;
}

async function saveReport(report) {
  if (db) await col('reports').doc(report.id).set(report, { merge: true });
  else memory.reports.set(report.id, report);
  invalidateReportCaches();
}

async function saveMatch(match) {
  if (db) await col('matches').doc(match.id).set(match, { merge: true });
  else memory.matches.set(match.id, match);
}

async function getMatch(id) {
  if (!id) return null;
  if (db) {
    const snap = await col('matches').doc(id).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  }
  return memory.matches.get(id) || null;
}

async function writeAudit(uid, action, reportId = null, metadata = {}) {
  const entry = { timestamp: now(), userId: uid, action, reportId, metadata };
  if (db) await col('auditLogs').add(entry);
  else memory.audit.push(entry);
}

async function listAuditLogs(options = {}) {
  let logs = [];
  if (db) {
    const snap = await col('auditLogs').limit(1000).get();
    logs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } else {
    logs = [...memory.audit];
  }
  if (options.action) logs = logs.filter((x) => x.action === options.action);
  if (options.userId) logs = logs.filter((x) => x.userId === options.userId);
  logs.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  if (options.limit) logs = logs.slice(0, options.limit);
  return logs;
}

async function notify(uid, notification) {
  if (!uid) return;
  const n = { id: uuid(), uid, ...notification, read: false, createdAt: now() };
  if (db) await col('notifications').doc(n.id).set(n);
  else {
    const list = memory.notifications.get(uid) || [];
    list.unshift(n);
    memory.notifications.set(uid, list);
  }
}

async function notifyAdmin(notification) {
  const adminId = adminUid();
  if (adminId) {
    await notify(adminId, notification);
  }
}

async function uploadB2(file, key) {
  if (!s3) return { key, url: null };
  await s3.send(new PutObjectCommand({
    Bucket: process.env.B2_BUCKET_NAME,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
    CacheControl: 'private, max-age=0',
  }));
  imageBufferCache.set(key, { buffer: file.buffer, type: file.mimetype, etag: `"${now()}"` });
  return { key, url: imageUrlForKey(key) };
}

async function deleteB2(key) {
  if (!key) return;
  imageBufferCache.delete(key);
  if (!s3) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.B2_BUCKET_NAME, Key: key }));
  } catch (error) {
    console.error('B2 delete skipped:', error.message);
  }
}

async function imageBuffer(key) {
  if (!s3 || !key) return null;
  if (imageBufferCache.has(key)) {
    return imageBufferCache.get(key);
  }
  const object = await s3.send(new GetObjectCommand({ Bucket: process.env.B2_BUCKET_NAME, Key: key }));
  const chunks = [];
  for await (const chunk of object.Body) chunks.push(Buffer.from(chunk));
  const bufferData = { buffer: Buffer.concat(chunks), type: object.ContentType || 'image/jpeg', etag: object.ETag };
  if (imageBufferCache.size >= MAX_IMAGE_CACHE_ENTRIES) {
    const firstKey = imageBufferCache.keys().next().value;
    imageBufferCache.delete(firstKey);
  }
  imageBufferCache.set(key, bufferData);
  return bufferData;
}

async function streamB2(key, req, res) {
  if (!s3) return res.status(404).end();
  try {
    const img = await imageBuffer(key);
    if (!img) return res.status(404).end();

    const etag = img.etag || `"${Buffer.from(key).toString('base64').slice(0, 16)}"`;
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    res.setHeader('Content-Type', img.type || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('ETag', etag);
    return res.end(img.buffer);
  } catch (err) {
    console.error('Image stream error:', err.message);
    return res.status(404).end();
  }
}

async function imageDataUrl(key) {
  const data = await imageBuffer(key);
  if (!data || data.buffer.length > 15 * 1024 * 1024) return null;
  return `data:${data.type};base64,${data.buffer.toString('base64')}`;
}

async function enrichVisionImage(report, fallbackFile = null) {
  if (fallbackFile?.buffer) return { ...report, _visionImageData: `data:${fallbackFile.mimetype};base64,${fallbackFile.buffer.toString('base64')}` };
  if (report?.imageKey && s3) {
    try {
      return { ...report, _visionImageData: await imageDataUrl(report.imageKey) };
    } catch (error) {
      console.error('B2 vision image read:', error.message);
    }
  }
  return report;
}

function canReadReport(report, uid) {
  if (!report) return false;
  if (isAdminUid(uid)) return true;
  if (report.ownerUid === uid) return true;
  return report.visibility !== 'private' && report.status !== 'removed';
}

function canReadImage(report, uid) {
  if (!report) return false;
  if (isAdminUid(uid)) return true;
  if (report.status === 'removed') return false;
  return report.ownerUid === uid || report.visibility !== 'private';
}

function canMutateReport(report, uid) {
  return !!report && (report.ownerUid === uid || isAdminUid(uid));
}

function isCompleteProfile(p) {
  return !!(p?.fullName && p?.role && ['Student', 'Staff', 'Worker'].includes(p.role));
}

function publicProfile(p) {
  return { fullName: p?.fullName || '', phoneNumber: p?.phoneNumber || '' };
}

async function generatePossibleMatch(report, file) {
  const all = await listReports();
  const candidates = all.filter((candidate) => (
    candidate.id !== report.id
    && candidate.type !== report.type
    && candidate.visibility !== 'private'
    && !['removed', 'resolved'].includes(candidate.status)
    && !candidate.matchId
  ));

  let best = null;
  const reportWithImage = await enrichVisionImage(report, file);

  for (const candidate of candidates) {
    const existing = all.find((r) => (
      r.matchId
      && ((r.id === report.id && r.matchedReportId === candidate.id) || (r.id === candidate.id && r.matchedReportId === report.id))
    ));
    if (existing) continue;

    const candidateWithImage = await enrichVisionImage(candidate);
    const match = await matchReports(reportWithImage, candidateWithImage);
    if (!best || match.score > best.score) best = { candidate, ...match };
  }

  if (!best || best.score < MATCH_THRESHOLD) return report;

  const matchId = uuid();
  const other = {
    ...best.candidate,
    status: 'possible_match',
    matchScore: best.score,
    matchExplanation: best.explanation,
    matchingFactors: best.factors,
    matchId,
    matchedReportId: report.id,
    confirmations: { lostUserConfirmed: false, foundUserConfirmed: false },
    returns: { lost: false, found: false },
    updatedAt: now(),
  };

  const updated = {
    ...report,
    status: 'possible_match',
    matchScore: best.score,
    matchExplanation: best.explanation,
    matchingFactors: best.factors,
    matchId,
    matchedReportId: other.id,
    confirmations: { lostUserConfirmed: false, foundUserConfirmed: false },
    returns: { lost: false, found: false },
    updatedAt: now(),
  };

  const matchRecord = {
    id: matchId,
    lostId: updated.type === 'lost' ? updated.id : other.id,
    foundId: updated.type === 'found' ? updated.id : other.id,
    lostUserConfirmed: false,
    foundUserConfirmed: false,
    returnLostConfirmed: false,
    returnFoundConfirmed: false,
    score: best.score,
    explanation: best.explanation,
    factors: best.factors,
    createdAt: now(),
    updatedAt: now(),
  };

  await saveReport(updated);
  await saveReport(other);
  await saveMatch(matchRecord);
  await writeAudit(updated.ownerUid, 'Match generated', updated.id, { matchId, matchedReportId: other.id, score: best.score, ai: best.ai });
  await notify(updated.ownerUid, { type: 'possible_match', title: 'Possible match found', message: `A possible match was found for ${updated.itemName}. Review it to confirm.`, reportId: updated.id });
  await notify(other.ownerUid, { type: 'possible_match', title: 'Possible match found', message: `A possible match was found for ${other.itemName}. Review it to confirm.`, reportId: other.id });
  await notifyAdmin({ type: 'possible_match', title: 'Possible match found', message: `A possible match was found between "${updated.itemName}" and "${other.itemName}" (${best.score}%).`, reportId: updated.id });
  return updated;
}

async function runMatching(report, file = null) {
  try {
    return await generatePossibleMatch(report, file);
  } catch (error) {
    console.error('Automatic matching failed:', error.message);
    await writeAudit(report.ownerUid, 'Automatic matching failed', report.id, { error: error.message });
    return report;
  }
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'FindBack', firebase: !!db, b2: !!s3, groq: configured(process.env.GROQ_API_KEY) });
});

app.get('/api/config', (req, res) => {
  res.json({ appName: 'FindBack', firebase: !!db, b2: !!s3, groq: configured(process.env.GROQ_API_KEY), firebaseClient: firebaseClientConfig() });
});

app.post('/api/assistant', verify, async (req, res) => {
  const question = String(req.body.question || '').trim();
  if (!question) return res.status(400).json({ error: 'Ask a question first.' });
  if (!groq) return res.json({ answer: 'The FindBack assistant is not configured yet. You can still report lost or found items, search reports, and review notifications.' });
  try {
    const completion = await groq.chat.completions.create({
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      temperature: 0.2,
      max_tokens: 350,
      messages: [
        { role: 'system', content: 'You are the FindBack assistant. Answer questions only about this campus lost-and-found software: reporting lost or found items, searching, matching, notifications, profiles, and navigation. Be concise, practical, and honest. If asked about unrelated topics, say you can only help with FindBack.' },
        { role: 'user', content: question },
      ],
    });
    return res.json({ answer: completion.choices?.[0]?.message?.content?.trim() || 'I could not generate an answer.' });
  } catch (error) {
    console.error('Assistant error:', error.message);
    return res.status(502).json({ error: 'The assistant is temporarily unavailable.' });
  }
});

app.get('/api/profile', verify, async (req, res) => {
  const isAdm = isAdminUid(req.user.uid);
  const p = await profile(req.user.uid);
  if (!p) {
    const defaultProfile = {
      uid: req.user.uid,
      email: req.user.email || '',
      role: isAdm ? 'Admin' : 'Student',
      fullName: isAdm ? 'Administrator' : '',
      profileComplete: isAdm,
      isAdmin: isAdm,
      accountStatus: 'active',
      createdAt: now(),
      updatedAt: now(),
    };
    if (isAdm) {
      await saveProfile(defaultProfile);
    }
    return res.json(defaultProfile);
  }
  return res.json({
    ...p,
    role: isAdm ? 'Admin' : (p.role || 'Student'),
    profileComplete: isAdm ? true : isCompleteProfile(p),
    isAdmin: isAdm,
  });
});

app.post('/api/profile', verify, async (req, res) => {
  try {
    const isAdm = isAdminUid(req.user.uid);
    const old = await profile(req.user.uid);
    const role = isAdm ? 'Admin' : (req.body.role || old?.role || 'Student');
    if (!isAdm && !['Student', 'Staff', 'Worker'].includes(role)) return res.status(400).json({ error: 'Invalid public role.' });
    const p = {
      uid: req.user.uid,
      email: req.user.email || old?.email || '',
      fullName: String(req.body.fullName || old?.fullName || (isAdm ? 'Administrator' : '')).trim(),
      phoneNumber: String(req.body.phoneNumber ?? old?.phoneNumber ?? '').trim(),
      role,
      department: String(req.body.department ?? old?.department ?? '').trim(),
      campusId: String(req.body.campusId ?? old?.campusId ?? '').trim(),
      accountStatus: old?.accountStatus || 'active',
      createdAt: old?.createdAt || now(),
      updatedAt: now(),
    };
    await saveProfile(p);
    await writeAudit(req.user.uid, old ? 'User profile updated' : 'User created');
    if (!old && !isAdm) {
      await notifyAdmin({
        type: 'user_registered',
        title: 'New User Registered',
        message: `${p.fullName || p.email} (${p.role}) created an account.`,
      });
    }
    return res.json({ ...p, profileComplete: isAdm ? true : isCompleteProfile(p), isAdmin: isAdm });
  } catch (error) {
    console.error('Profile save error:', error);
    return res.status(500).json({ error: 'Could not save profile.' });
  }
});

app.post('/api/reports', verify, upload.single('image'), async (req, res) => {
  try {
    if (isAdminUid(req.user.uid)) {
      return res.status(403).json({ error: 'Administrators are not permitted to report lost or found items.' });
    }
    const b = req.body;
    if (!b.itemName || !b.type) return res.status(400).json({ error: 'Item name and report type are required.' });
    if (!['lost', 'found'].includes(b.type)) return res.status(400).json({ error: 'Invalid report type.' });
    if (req.file && (!req.file.buffer?.length || !IMAGE_TYPES.has(req.file.mimetype))) return res.status(422).json({ error: `Please upload a JPG, PNG, or WEBP image smaller than ${process.env.MAX_IMAGE_MB || 8} MB.` });

    const id = uuid();
    let image = null;
    if (req.file) {
      const ext = req.file.mimetype.split('/')[1].replace('jpeg', 'jpg');
      image = await uploadB2(req.file, `reports/${id}.${ext}`);
    }

    const report = {
      id,
      ownerUid: req.user.uid,
      type: b.type,
      itemName: String(b.itemName).trim(),
      category: b.category || '',
      brand: b.brand || '',
      color: b.color || '',
      description: b.description || '',
      location: b.location || '',
      date: b.date || '',
      approxTime: b.approxTime || '',
      additionalInfo: b.additionalInfo || '',
      imageKey: image?.key || null,
      imageUrl: image?.url || null,
      status: 'active',
      visibility: 'public',
      matchScore: 0,
      matchExplanation: 'Matching is being evaluated.',
      matchingFactors: [],
      confirmations: { lostUserConfirmed: false, foundUserConfirmed: false },
      returns: { lost: false, found: false },
      createdAt: now(),
      updatedAt: now(),
    };

    await saveReport(report);
    await writeAudit(req.user.uid, 'Report created', id, { type: report.type, image: !!report.imageKey });
    await notify(req.user.uid, { type: 'report_submitted', title: 'Report submitted', message: `Your ${report.type} report for ${report.itemName} was submitted.`, reportId: id });
    await notifyAdmin({ type: 'report_submitted', title: `New ${report.type === 'lost' ? 'Lost' : 'Found'} Item Reported`, message: `"${report.itemName}" was reported at ${report.location || 'campus'} by ${req.user.email || 'a student'}.`, reportId: id });
    void runMatching(report, req.file);
    return res.status(201).json(report);
  } catch (error) {
    console.error('Report creation error:', error);
    return res.status(500).json({ error: 'Report could not be created. Please try again.' });
  }
});

app.get('/api/reports', verify, async (req, res) => {
  const reports = await listReports();
  const mine = req.query.mine === 'true';
  const out = reports.filter((r) => (mine ? r.ownerUid === req.user.uid : canReadReport(r, req.user.uid)));
  res.json(out);
});

app.get('/api/reports/:id', verify, async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  if (!canReadReport(report, req.user.uid)) return res.status(403).json({ error: 'Access denied.' });

  const isAdm = isAdminUid(req.user.uid);
  const out = { ...report };
  const match = await getMatch(report.matchId);
  const partner = report.matchedReportId ? await getReport(report.matchedReportId) : null;
  if (match && partner) {
    out.match = { id: match.id, lostId: match.lostId, foundId: match.foundId, lostUserConfirmed: !!match.lostUserConfirmed, foundUserConfirmed: !!match.foundUserConfirmed };
  }
  if ((match?.lostUserConfirmed && match?.foundUserConfirmed && partner) || (isAdm && partner)) {
    const partnerProfile = await profile(partner.ownerUid);
    out.contact = isAdm
      ? {
          fullName: partnerProfile?.fullName || '',
          email: partnerProfile?.email || '',
          phoneNumber: partnerProfile?.phoneNumber || '',
          role: partnerProfile?.role || '',
          department: partnerProfile?.department || '',
          campusId: partnerProfile?.campusId || '',
        }
      : publicProfile(partnerProfile);
  }
  if (isAdm) {
    const ownerProfile = await profile(report.ownerUid);
    out.owner = {
      uid: report.ownerUid,
      fullName: ownerProfile?.fullName || '',
      email: ownerProfile?.email || '',
      phoneNumber: ownerProfile?.phoneNumber || '',
      role: ownerProfile?.role || 'Student',
      department: ownerProfile?.department || '',
      campusId: ownerProfile?.campusId || '',
      accountStatus: ownerProfile?.accountStatus || 'active',
    };
  }
  return res.json(out);
});

app.get('/api/images/*key', verify, async (req, res) => {
  try {
    const rawKey = Array.isArray(req.params.key) ? req.params.key.join('/') : req.params.key;
    const key = decodeURIComponent(rawKey);
    let report = reportByImageKeyCache.get(key);
    if (!report) {
      const reports = await listReports();
      report = reports.find((r) => r.imageKey === key);
    }
    if (!report) return res.status(404).end();
    if (!canReadImage(report, req.user.uid)) return res.status(403).end();
    return streamB2(key, req, res);
  } catch (error) {
    console.error('Image proxy error:', error.message);
    return res.status(404).end();
  }
});

app.post('/api/reports/:id/image', verify, upload.single('image'), async (req, res) => {
  if (isAdminUid(req.user.uid)) {
    return res.status(403).json({ error: 'Administrators cannot upload or modify report images.' });
  }
  const report = await getReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  if (!canMutateReport(report, req.user.uid)) return res.status(403).json({ error: 'Only the owner or admin can replace this image.' });
  if (!req.file?.buffer?.length || !IMAGE_TYPES.has(req.file.mimetype)) return res.status(422).json({ error: `Please upload a JPG, PNG, or WEBP image smaller than ${process.env.MAX_IMAGE_MB || 8} MB.` });
  const oldKey = report.imageKey;
  const ext = req.file.mimetype.split('/')[1].replace('jpeg', 'jpg');
  const image = await uploadB2(req.file, `reports/${report.id}-${Date.now()}.${ext}`);
  const updated = { ...report, imageKey: image.key, imageUrl: image.url, updatedAt: now() };
  await saveReport(updated);
  await deleteB2(oldKey);
  await writeAudit(req.user.uid, 'Report image replaced', report.id, { oldKey, newKey: image.key });
  const rematched = !updated.matchId && updated.status === 'active' ? await runMatching(updated, req.file) : updated;
  res.json(rematched);
});

app.post('/api/reports/:id/confirm', verify, async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report || !report.matchId) return res.status(404).json({ error: 'Match not found.' });
  if (report.ownerUid !== req.user.uid && !isAdminUid(req.user.uid)) return res.status(403).json({ error: 'Only the report owner can confirm this match.' });
  const partner = await getReport(report.matchedReportId);
  const match = await getMatch(report.matchId);
  if (!partner || !match) return res.status(404).json({ error: 'Match partner not found.' });

  const confirmed = req.body.confirmed === true;
  if (!confirmed) {
    const reset = (r) => ({ ...r, status: 'active', matchId: null, matchedReportId: null, matchRejected: true, confirmations: { lostUserConfirmed: false, foundUserConfirmed: false }, updatedAt: now() });
    await saveReport(reset(report));
    await saveReport(reset(partner));
    await saveMatch({ ...match, rejected: true, rejectedBy: req.user.uid, updatedAt: now() });
    await writeAudit(req.user.uid, 'Match rejected', report.id, { matchId: match.id });
    await notify(partner.ownerUid, { type: 'match_rejected', title: 'Match rejected', message: 'The possible match was rejected.', reportId: partner.id });
    return res.json(reset(report));
  }

  const field = report.type === 'lost' ? 'lostUserConfirmed' : 'foundUserConfirmed';
  const updatedMatch = { ...match, [field]: true, updatedAt: now() };
  const both = updatedMatch.lostUserConfirmed && updatedMatch.foundUserConfirmed;
  const confirmations = { lostUserConfirmed: !!updatedMatch.lostUserConfirmed, foundUserConfirmed: !!updatedMatch.foundUserConfirmed };
  const status = both ? 'confirmed_match' : 'possible_match';
  const updatedReport = { ...report, status, confirmations, updatedAt: now() };
  const updatedPartner = { ...partner, status, confirmations, updatedAt: now() };
  await saveReport(updatedReport);
  await saveReport(updatedPartner);
  await saveMatch(updatedMatch);
  await writeAudit(req.user.uid, 'Match confirmed', report.id, { matchId: match.id, both });
  await notify(partner.ownerUid, { type: both ? 'match_confirmed' : 'other_user_confirmed', title: both ? 'Match confirmed' : 'Other user confirmed', message: both ? 'Both parties confirmed the possible match. Contact information is now available.' : 'The other party confirmed the possible match.', reportId: partner.id });
  if (both) {
    await notify(report.ownerUid, { type: 'contact_unlocked', title: 'Contact unlocked', message: 'Both parties confirmed. You can now coordinate the return.', reportId: report.id });
    await notifyAdmin({ type: 'match_confirmed', title: 'Match Confirmed', message: `Both parties confirmed match between "${updatedReport.itemName}" and "${updatedPartner.itemName}".`, reportId: updatedReport.id });
  }
  return res.json(updatedReport);
});

app.post('/api/reports/:id/return', verify, async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report || !['confirmed_match', 'return_pending'].includes(report.status)) return res.status(400).json({ error: 'Return workflow is not available yet.' });
  if (report.ownerUid !== req.user.uid && !isAdminUid(req.user.uid)) return res.status(403).json({ error: 'Only the report owner can confirm return.' });
  const partner = await getReport(report.matchedReportId);
  const match = await getMatch(report.matchId);
  if (!partner || !match) return res.status(404).json({ error: 'Match partner not found.' });

  const field = report.type === 'lost' ? 'returnLostConfirmed' : 'returnFoundConfirmed';
  const updatedMatch = { ...match, [field]: true, returnDate: req.body.returnDate || new Date().toISOString().slice(0, 10), returnNote: req.body.returnNote || '', updatedAt: now() };
  const returns = { lost: !!updatedMatch.returnLostConfirmed, found: !!updatedMatch.returnFoundConfirmed };
  const resolved = returns.lost && returns.found;
  const status = resolved ? 'resolved' : 'return_pending';
  const updatedReport = { ...report, status, returns, returnDate: updatedMatch.returnDate, returnNote: updatedMatch.returnNote, resolvedAt: resolved ? now() : report.resolvedAt || null, updatedAt: now() };
  const updatedPartner = { ...partner, status, returns, resolvedAt: resolved ? updatedReport.resolvedAt : partner.resolvedAt || null, updatedAt: now() };
  await saveReport(updatedReport);
  await saveReport(updatedPartner);
  await saveMatch(updatedMatch);
  await writeAudit(req.user.uid, resolved ? 'Report resolved' : 'Return confirmed', report.id, { matchId: match.id });
  await notify(partner.ownerUid, { type: resolved ? 'report_resolved' : 'return_pending', title: resolved ? 'Report resolved' : 'Return confirmation recorded', message: resolved ? 'Both parties confirmed the return.' : 'The other party marked the item returned.', reportId: partner.id });
  if (resolved) {
    await notifyAdmin({ type: 'report_resolved', title: 'Item Resolved', message: `Item "${updatedReport.itemName}" was marked resolved and returned.`, reportId: updatedReport.id });
  }
  return res.json(updatedReport);
});

app.post('/api/reports/:id/remove', verify, async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  if (!canMutateReport(report, req.user.uid)) return res.status(403).json({ error: 'Only the owner or admin can remove this report.' });

  const isAdm = isAdminUid(req.user.uid);
  const updated = {
    ...report,
    status: 'removed',
    visibility: 'private',
    removedBy: req.user.uid,
    removedAt: now(),
    updatedAt: now(),
  };

  // If this report had an active / unresolved match, dissolve the match safely!
  if (report.matchId && report.matchedReportId) {
    try {
      const partner = await getReport(report.matchedReportId);
      const match = await getMatch(report.matchId);
      if (partner && partner.status !== 'removed') {
        const resetPartner = {
          ...partner,
          status: 'active',
          matchId: null,
          matchedReportId: null,
          matchScore: 0,
          matchExplanation: 'Previous match was cancelled because the counterpart item was removed.',
          confirmations: { lostUserConfirmed: false, foundUserConfirmed: false },
          returns: { lost: false, found: false },
          updatedAt: now(),
        };
        await saveReport(resetPartner);
        await notify(partner.ownerUid, {
          type: 'match_cancelled',
          title: 'Match Cancelled',
          message: `The item matched with your "${partner.itemName}" was removed. Your item is active again for matching.`,
          reportId: partner.id,
        });
      }
      if (match) {
        await saveMatch({
          ...match,
          cancelled: true,
          cancelledBy: req.user.uid,
          cancelledReason: `Report ${report.id} removed by ${isAdm ? 'admin' : 'owner'}`,
          updatedAt: now(),
        });
      }
    } catch (e) {
      console.error('Error dissolving match on report removal:', e);
    }
  }

  await saveReport(updated);
  await writeAudit(req.user.uid, isAdm ? 'Admin removed report' : 'Report removed', report.id, { itemName: report.itemName, ownerUid: report.ownerUid });

  if (isAdm && report.ownerUid !== req.user.uid) {
    await notify(report.ownerUid, {
      type: 'admin_action',
      title: 'Report Removed by Administrator',
      message: `Your report for "${report.itemName}" was removed by an administrator.`,
      reportId: report.id,
    });
  } else if (!isAdm) {
    await notifyAdmin({
      type: 'report_removed',
      title: 'Report Removed by User',
      message: `User removed report "${report.itemName}".`,
      reportId: report.id,
    });
  }

  return res.json(updated);
});

app.get('/api/notifications', verify, async (req, res) => {
  if (db) {
    const snap = await col('notifications').where('uid', '==', req.user.uid).limit(100).get();
    return res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)));
  }
  return res.json(memory.notifications.get(req.user.uid) || []);
});

app.post('/api/notifications/:id/read', verify, async (req, res) => {
  if (db) {
    const ref = col('notifications').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().uid !== req.user.uid) return res.status(404).json({ error: 'Notification not found.' });
    await ref.set({ read: true }, { merge: true });
  } else {
    const list = memory.notifications.get(req.user.uid) || [];
    const n = list.find((x) => x.id === req.params.id);
    if (!n) return res.status(404).json({ error: 'Notification not found.' });
    n.read = true;
  }
  return res.json({ ok: true });
});

app.post('/api/notifications/read-all', verify, async (req, res) => {
  if (db) {
    const snap = await col('notifications').where('uid', '==', req.user.uid).limit(100).get();
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.set(doc.ref, { read: true }, { merge: true }));
    await batch.commit();
  } else {
    (memory.notifications.get(req.user.uid) || []).forEach((n) => { n.read = true; });
  }
  return res.json({ ok: true });
});

app.post('/api/audit/login', verify, async (req, res) => {
  try {
    const isAdm = isAdminUid(req.user.uid);
    const p = await profile(req.user.uid);
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Unknown client';

    const loginRecord = {
      id: uuid(),
      timestamp: now(),
      userId: req.user.uid,
      email: req.user.email || p?.email || '',
      fullName: p?.fullName || (isAdm ? 'Administrator' : 'Campus User'),
      role: isAdm ? 'Admin' : (p?.role || 'Student'),
      action: 'User login',
      ip,
      userAgent,
      metadata: { ip, userAgent },
    };

    if (db) {
      await col('auditLogs').add(loginRecord);
    } else {
      memory.audit.unshift(loginRecord);
    }

    if (p) {
      await saveProfile({
        ...p,
        lastLoginAt: now(),
        lastLoginIp: ip,
        updatedAt: now(),
      });
    }

    return res.json({ ok: true, timestamp: loginRecord.timestamp });
  } catch (error) {
    console.error('Login audit error:', error);
    return res.status(500).json({ error: 'Could not record login audit.' });
  }
});

app.get('/api/search', verify, async (req, res) => {
  const reports = (await listReports()).filter((r) => canReadReport(r, req.user.uid));
  const q = String(req.query.keyword || '').toLowerCase();
  const has = (value, needle) => !needle || String(value || '').toLowerCase().includes(String(needle).toLowerCase());

  const parsedFrom = req.query.dateFrom ? Date.parse(String(req.query.dateFrom)) : NaN;
  const dateFrom = !Number.isNaN(parsedFrom) ? parsedFrom : null;

  const parsedTo = req.query.dateTo ? Date.parse(String(req.query.dateTo)) : NaN;
  const dateTo = !Number.isNaN(parsedTo) ? parsedTo + 86400000 - 1 : null;

  let out = reports.filter((r) => {
    const reportDateParsed = r.date ? Date.parse(r.date) : NaN;
    const hasValidReportDate = !Number.isNaN(reportDateParsed);

    return (
      (!q || [r.itemName, r.description, r.brand, r.color, r.category, r.location, r.additionalInfo].join(' ').toLowerCase().includes(q))
      && (!req.query.type || r.type === req.query.type)
      && (!req.query.category || r.category === req.query.category)
      && (!req.query.status || r.status === req.query.status)
      && has(r.brand, req.query.brand)
      && has(r.color, req.query.color)
      && has(r.location, req.query.location)
      && (!dateFrom || (hasValidReportDate && reportDateParsed >= dateFrom))
      && (!dateTo || (hasValidReportDate && reportDateParsed <= dateTo))
    );
  });
  if (req.query.sort === 'oldest') out = out.sort((a, b) => a.createdAt - b.createdAt);
  else if (req.query.sort === 'relevance') out = out.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
  else out = out.sort((a, b) => b.createdAt - a.createdAt);
  return res.json(out);
});

app.get('/api/admin/stats', verify, requireAdmin, async (req, res) => {
  const [reports, usersCount] = await Promise.all([
    listReports(),
    db ? col('users').count().get().then((c) => c.data().count).catch(() => memory.users.size) : Promise.resolve(memory.users.size),
  ]);
  const count = (status) => reports.filter((r) => r.status === status).length;
  return res.json({
    users: usersCount,
    lost: reports.filter((r) => r.type === 'lost').length,
    found: reports.filter((r) => r.type === 'found').length,
    active: count('active'),
    possibleMatch: count('possible_match'),
    confirmed: count('confirmed_match'),
    returned: count('return_pending'),
    resolved: count('resolved'),
    removed: count('removed'),
  });
});

app.get('/api/admin/users', verify, requireAdmin, async (req, res) => {
  try {
    const [users, reports, auditLogs] = await Promise.all([
      listUsers(),
      listReports(),
      listAuditLogs({ action: 'User login', limit: 1000 }),
    ]);

    const userSummaries = users.map((u) => {
      const userReports = reports.filter((r) => r.ownerUid === u.uid);
      const userLogins = auditLogs.filter((a) => a.userId === u.uid);
      const lastLogin = userLogins.length > 0 ? userLogins[0].timestamp : (u.lastLoginAt || null);

      return {
        uid: u.uid,
        email: u.email || '',
        fullName: u.fullName || '',
        role: isAdminUid(u.uid) ? 'Admin' : (u.role || 'Student'),
        phoneNumber: u.phoneNumber || '',
        department: u.department || '',
        campusId: u.campusId || '',
        accountStatus: u.accountStatus || 'active',
        createdAt: u.createdAt || null,
        lastLoginAt: lastLogin,
        reportsCount: userReports.length,
        activeReportsCount: userReports.filter((r) => r.status === 'active' || r.status === 'possible_match').length,
        resolvedReportsCount: userReports.filter((r) => r.status === 'resolved').length,
        removedReportsCount: userReports.filter((r) => r.status === 'removed').length,
        isAdmin: isAdminUid(u.uid),
      };
    });

    return res.json(userSummaries);
  } catch (error) {
    console.error('List users error:', error);
    return res.status(500).json({ error: 'Could not retrieve users.' });
  }
});

app.get('/api/admin/users/:uid', verify, requireAdmin, async (req, res) => {
  try {
    const targetUid = req.params.uid;
    const [u, allReports, auditLogs] = await Promise.all([
      profile(targetUid),
      listReports(),
      listAuditLogs({ userId: targetUid, limit: 100 }),
    ]);
    if (!u) return res.status(404).json({ error: 'User not found.' });

    const reports = allReports.filter((r) => r.ownerUid === targetUid);

    return res.json({
      user: {
        ...u,
        role: isAdminUid(targetUid) ? 'Admin' : (u.role || 'Student'),
        isAdmin: isAdminUid(targetUid),
      },
      reports,
      loginHistory: auditLogs.filter((a) => a.action === 'User login'),
      activityHistory: auditLogs,
    });
  } catch (error) {
    console.error('Get user details error:', error);
    return res.status(500).json({ error: 'Could not retrieve user details.' });
  }
});

app.post('/api/admin/users/:uid/remove', verify, requireAdmin, async (req, res) => {
  try {
    const targetUid = req.params.uid;
    if (isAdminUid(targetUid) || targetUid === req.user.uid) {
      return res.status(400).json({ error: 'Cannot remove administrator accounts.' });
    }

    const targetUser = await profile(targetUid);
    if (!targetUser) return res.status(404).json({ error: 'User not found.' });

    if (auth) {
      try {
        await auth.updateUser(targetUid, { disabled: true });
      } catch (authErr) {
        console.warn('Firebase Auth disable failed:', authErr.message);
      }
    }

    const updatedUser = {
      ...targetUser,
      accountStatus: 'removed',
      removedAt: now(),
      removedBy: req.user.uid,
      updatedAt: now(),
    };
    await saveProfile(updatedUser);

    const allReports = await listReports();
    const userReports = allReports.filter((r) => r.ownerUid === targetUid && r.status !== 'removed');

    for (const rep of userReports) {
      const removedReport = {
        ...rep,
        status: 'removed',
        visibility: 'private',
        removedBy: req.user.uid,
        removedAt: now(),
        updatedAt: now(),
      };

      if (rep.matchId && rep.matchedReportId) {
        try {
          const partner = await getReport(rep.matchedReportId);
          const match = await getMatch(rep.matchId);
          if (partner && partner.status !== 'removed') {
            const resetPartner = {
              ...partner,
              status: 'active',
              matchId: null,
              matchedReportId: null,
              matchScore: 0,
              confirmations: { lostUserConfirmed: false, foundUserConfirmed: false },
              returns: { lost: false, found: false },
              updatedAt: now(),
            };
            await saveReport(resetPartner);
            await notify(partner.ownerUid, {
              type: 'match_cancelled',
              title: 'Match Cancelled',
              message: `The item matched with your "${partner.itemName}" is no longer available because the user account was removed. Your item is active again for matching.`,
              reportId: partner.id,
            });
          }
          if (match) {
            await saveMatch({
              ...match,
              cancelled: true,
              cancelledBy: req.user.uid,
              cancelledReason: 'User account removed by administrator',
              updatedAt: now(),
            });
          }
        } catch (e) {
          console.error('Error dissolving match on user removal:', e);
        }
      }

      await saveReport(removedReport);
    }

    await writeAudit(req.user.uid, 'Admin removed user', null, {
      targetUid,
      targetEmail: targetUser.email,
      targetName: targetUser.fullName,
      reportsRemovedCount: userReports.length,
    });

    await notifyAdmin({
      type: 'admin_action',
      title: 'User Removed',
      message: `User ${targetUser.fullName || targetUser.email} was removed and their ${userReports.length} reports were deactivated.`,
    });

    return res.json({ ok: true, removedUid: targetUid, reportsRemoved: userReports.length });
  } catch (error) {
    console.error('Remove user error:', error);
    return res.status(500).json({ error: 'Could not remove user.' });
  }
});

app.get('/api/admin/audit/logins', verify, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const q = String(req.query.search || '').toLowerCase().trim();

    let logs = [];
    if (db) {
      const snap = await col('auditLogs').limit(1000).get();
      logs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } else {
      logs = [...memory.audit];
    }

    logs = logs.filter((item) => item.action === 'User login');

    if (q) {
      logs = logs.filter((item) => (
        (item.email && item.email.toLowerCase().includes(q))
        || (item.fullName && item.fullName.toLowerCase().includes(q))
        || (item.userId && item.userId.toLowerCase().includes(q))
        || (item.ip && item.ip.toLowerCase().includes(q))
        || (item.role && item.role.toLowerCase().includes(q))
      ));
    }

    logs.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));

    return res.json(logs.slice(0, limit));
  } catch (error) {
    console.error('Get login audits error:', error);
    return res.status(500).json({ error: 'Could not retrieve login audit logs.' });
  }
});

app.get('/api/reports/:id/pdf', verify, async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  if (!canReadReport(report, req.user.uid)) return res.status(403).json({ error: 'Access denied.' });

  const match = await getMatch(report.matchId);
  const canSeeContact = !!(match?.lostUserConfirmed && match?.foundUserConfirmed);
  const partner = canSeeContact && report.matchedReportId ? await getReport(report.matchedReportId) : null;
  const contact = partner ? await profile(partner.ownerUid) : null;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="FindBack_Report_${report.id}.pdf"`);
  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);
  doc.fontSize(24).text('FindBack');
  doc.fontSize(10).fillColor('#666').text('Campus Lost & Found Report');
  doc.moveDown();
  doc.fillColor('#111').fontSize(15).text(report.itemName || 'Untitled report');
  doc.fontSize(10).text(`Report ID: ${report.id}`);
  doc.moveDown();

  if (report.imageKey) {
    try {
      const image = await imageBuffer(report.imageKey);
      if (image && ['image/jpeg', 'image/png'].includes(image.type)) {
        doc.image(image.buffer, { fit: [250, 180], align: 'center' });
      } else {
        doc.font('Helvetica-Oblique').text('Image unavailable in PDF preview.');
      }
      doc.moveDown();
    } catch (error) {
      console.error('PDF image error:', error.message);
      doc.font('Helvetica-Oblique').text('Image unavailable.');
      doc.moveDown();
    }
  }

  const fields = [
    ['Type', report.type],
    ['Category', report.category],
    ['Brand', report.brand],
    ['Color', report.color],
    ['Description', report.description],
    ['Location', report.location],
    ['Date', report.date],
    ['Approximate time', report.approxTime],
    ['Additional information', report.additionalInfo],
    ['Status', report.status],
    ['Match score', `${report.matchScore || 0}%`],
    ['Match explanation', report.matchExplanation || ''],
    ['Created', report.createdAt ? new Date(report.createdAt).toLocaleString() : ''],
    ['Updated', report.updatedAt ? new Date(report.updatedAt).toLocaleString() : ''],
  ];
  for (const [label, value] of fields) {
    doc.font('Helvetica-Bold').text(label);
    doc.font('Helvetica').text(value || '-');
    doc.moveDown(0.35);
  }
  doc.font('Helvetica-Bold').text('Confirmation state');
  doc.font('Helvetica').text(`Lost: ${!!match?.lostUserConfirmed} | Found: ${!!match?.foundUserConfirmed}`);
  if (canSeeContact) {
    doc.moveDown(0.35);
    doc.font('Helvetica-Bold').text('Unlocked contact');
    doc.font('Helvetica').text(`${contact?.fullName || ''} ${contact?.phoneNumber || ''}`.trim() || 'No phone number on profile.');
  }
  if (report.resolvedAt) {
    doc.moveDown(0.35);
    doc.font('Helvetica-Bold').text('Resolved');
    doc.font('Helvetica').text(new Date(report.resolvedAt).toLocaleString());
  }
  doc.end();
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError || error.message === 'INVALID_IMAGE_TYPE') {
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 422).json({ error: `Please upload a JPG, PNG, or WEBP image smaller than ${process.env.MAX_IMAGE_MB || 8} MB.` });
  }
  return next(error);
});

app.use((req, res, next) => {
  if (req.method === 'GET' && req.accepts('html') && !req.path.startsWith('/api/')) return res.sendFile(`${process.cwd()}/public/index.html`);
  return next();
});

app.use((error, req, res, next) => {
  console.error('Unhandled server error:', error);
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => console.log(`FindBack running on http://localhost:${PORT}`));
