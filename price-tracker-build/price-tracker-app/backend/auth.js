const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./database');

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function createSession(userId) {
  const sessionId = generateSessionId();
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(sessionId, userId, expiresAt);
  return sessionId;
}

function getSession(sessionId) {
  return db.prepare(
    "SELECT s.*, u.id as user_id, u.username, u.is_admin FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ? AND s.expires_at > datetime('now')"
  ).get(sessionId);
}

function deleteSession(sessionId) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

function isRateLimited(username, ip) {
  const result = db.prepare(
    "SELECT COUNT(*) as count FROM login_attempts WHERE (username = ? OR ip = ?) AND attempted_at > datetime('now', '-15 minutes')"
  ).get(username, ip);
  return result.count >= 5;
}

function recordLoginAttempt(username, ip) {
  db.prepare('INSERT INTO login_attempts (username, ip) VALUES (?, ?)').run(username, ip);
}

function requireAuth(req, res, next) {
  const sessionId = req.cookies?.session;
  if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return res.status(401).json({ error: 'Session expired' });
  req.user = { id: session.user_id, username: session.username, isAdmin: !!session.is_admin };
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  deleteSession,
  isRateLimited,
  recordLoginAttempt,
  requireAuth,
};
