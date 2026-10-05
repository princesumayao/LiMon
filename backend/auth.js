const crypto = require('crypto');
require('dotenv').config();

// Falls back to a dev-only secret if none is set, so this still works
// out of the box - but for anything beyond a capstone demo, set
// SESSION_SECRET in your .env to something random instead.
const SESSION_SECRET = process.env.SESSION_SECRET || 'limon-dev-secret-change-me';
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60; // 8 hours

// ---- Password hashing (scrypt, built into Node - no bcrypt install needed) ----

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidateHash = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(candidateHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b); // constant-time, avoids timing attacks
}

// ---- Session tokens (HMAC-signed, same idea as a JWT but with zero
// extra dependencies - a base64url payload plus an HMAC-SHA256
// signature over it, so it can't be tampered with client-side) ----

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(input) {
  input = input.replace(/-/g, '+').replace(/_/g, '/');
  while (input.length % 4) input += '=';
  return Buffer.from(input, 'base64').toString('utf8');
}

function signToken(payload) {
  const body = { ...payload, exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000 };
  const encoded = base64url(JSON.stringify(body));
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('hex');
  return `${encoded}.${signature}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [encoded, signature] = token.split('.');
  const expectedSignature = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('hex');

  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expectedSignature, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null; // tampered or wrong secret

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(encoded));
  } catch {
    return null;
  }
  if (!payload.exp || Date.now() > payload.exp) return null; // expired
  return payload;
}

// ---- Cookie helpers (no cookie-parser dependency needed for this) ----

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

function setSessionCookie(res, token) {
  // HttpOnly so client-side JS can't read/steal it. No `Secure` flag
  // since this runs over plain http on localhost for the capstone demo -
  // add `Secure` if this ever gets deployed behind https.
  res.setHeader(
    'Set-Cookie',
    `limon_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; SameSite=Lax`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'limon_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
}

function getCurrentUser(req) {
  const cookies = parseCookies(req);
  return verifyToken(cookies.limon_session); // { staff_id, role, exp } or null
}

// Express middleware - blocks the request unless the logged-in user's
// role is 'admin'. Used on write endpoints that staff shouldn't be able
// to reach, not just hidden in the UI.
function requireAdmin(req, res, next) {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  req.user = user;
  next();
}

// Express middleware - blocks any request that has no valid session.
function requireLogin(req, res, next) {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Access denied: please log in.' });
  req.user = user;
  next();
}

// Machine-to-machine key for devices that write over HTTP (the table-status
// simulator now, the CS department's camera system later). Set DEVICE_API_KEY
// in backend/.env. If it isn't set, no key is ever accepted (fails closed).
function hasValidDeviceKey(req) {
  const expected = process.env.DEVICE_API_KEY;
  const given = req.headers['x-api-key'];
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Write access for table status: a device with the key, or a logged-in admin.
function requireDeviceKeyOrAdmin(req, res, next) {
  if (hasValidDeviceKey(req)) return next();
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Access denied: please log in.' });
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  req.user = user;
  next();
}

module.exports = {
  requireLogin,
  hasValidDeviceKey,
  requireDeviceKeyOrAdmin,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  setSessionCookie,
  clearSessionCookie,
  getCurrentUser,
  requireAdmin,
};