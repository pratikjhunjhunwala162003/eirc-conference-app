const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = 'eirc-demo-secret-change-in-real-deployment';
const DB_FILE = path.join(__dirname, 'db.json');

// ---------- "Database" (a JSON file on disk — swap for real MySQL/Postgres in production) ----------

function loadDB(){
  if(fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const seed = {
    users: [
      // role: 'admin' | 'member' | 'shadow'
      // m2m/logistics permission only meaningful for 'member': 'none' | 'view' | 'edit'
      { id: 'u1', name: 'CA Mayur Agarwal', phone: '9903349773', role: 'admin' },
      { id: 'u2', name: 'CA Aditya Maheshwari', phone: '9733044550', role: 'admin' },
    ],
    sessions: [],
    guests: [],
    statusLog: [],
    otps: {}, // phone -> { code, expires }
    // Real calendar date behind each M2M day label. Editable by admin in the app (Manage access).
    dayDates: { 'Day 1': '2026-12-19', 'Day 2': '2026-12-20' }
  };
  fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
  return seed;
}
function saveDB(db){ fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
let db = loadDB();

// The M2M schedule is the single source of truth for who counts as a guest/speaker.
// Logistics can only be finalized for a name that actually appears in the M2M — never invented independently.
function speakerNamesFromM2M(){
  const names = new Set();
  db.sessions.forEach(s => {
    (s.speakers || '').split(',').map(x => x.trim()).filter(Boolean).forEach(n => names.add(n));
  });
  return [...names];
}
function sessionForSpeaker(name){
  return db.sessions.find(s => (s.speakers || '').split(',').map(x => x.trim()).includes(name));
}

// If a guest's name no longer appears in ANY session's speaker list — because a session was
// deleted, or their name was edited out of one — their finalized logistics shouldn't exist
// either, and no shadow should still be pointed at them.
function pruneOrphanedGuests(){
  const validNames = speakerNamesFromM2M();
  const removed = db.guests.filter(g => !validNames.includes(g.name));
  if(!removed.length) return;
  const removedIds = removed.map(g => g.id);
  db.guests = db.guests.filter(g => validNames.includes(g.name));
  let usersChanged = false;
  db.users.forEach(u => {
    if(u.role === 'shadow' && Array.isArray(u.guestIds)){
      const before = u.guestIds.length;
      u.guestIds = u.guestIds.filter(id => !removedIds.includes(id));
      if(u.guestIds.length !== before) usersChanged = true;
    }
  });
  saveDB(db);
  io.emit('guests:updated', db.guests);
  if(usersChanged) io.emit('users:updated', db.users.map(publicUser));
}

// ---------- Auth middleware ----------

function auth(req, res, next){
  const header = req.headers.authorization;
  if(!header) return res.status(401).json({ error: 'Not logged in' });
  try {
    const payload = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET);
    req.user = db.users.find(u => u.id === payload.id);
    if(!req.user) return res.status(401).json({ error: 'User no longer exists' });
    next();
  } catch(e) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}
function requireM2MEdit(req, res, next){
  if(req.user.role === 'admin' || (req.user.role === 'member' && req.user.m2m === 'edit')) return next();
  return res.status(403).json({ error: 'You do not have edit rights on the M2M schedule' });
}
function requireLogisticsEdit(req, res, next){
  if(req.user.role === 'admin' || (req.user.role === 'member' && req.user.logistics === 'edit')) return next();
  return res.status(403).json({ error: 'You do not have edit rights on logistics' });
}
function requireAdmin(req, res, next){
  if(req.user.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin only' });
}

// ---------- Auth routes: real phone + OTP flow ----------

app.post('/api/auth/request-otp', (req, res) => {
  const { phone } = req.body;
  const user = db.users.find(u => u.phone === phone);
  if(!user) return res.status(404).json({ error: 'This phone number is not registered for the conference app. Ask the admin to add you.' });
  // In real deployment: call an SMS gateway (e.g. MSG91) here to actually send this code by text.
  const code = '1234'; // fixed demo code, since no paid SMS provider is wired up yet
  db.otps[phone] = { code, expires: Date.now() + 5*60*1000 };
  saveDB(db);
  console.log(`[SMS SIMULATION] OTP for ${phone} (${user.name}): ${code}`);
  res.json({ ok: true, message: 'OTP sent (demo mode: code is 1234 for every number)' });
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { phone, code } = req.body;
  const entry = db.otps[phone];
  if(!entry || entry.code !== code || Date.now() > entry.expires)
    return res.status(401).json({ error: 'Incorrect or expired OTP' });
  const user = db.users.find(u => u.phone === phone);
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
  delete db.otps[phone];
  saveDB(db);
  res.json({ token, user: publicUser(user) });
});

function publicUser(u){
  const { id, name, role, m2m, logistics, guestIds } = u;
  return { id, name, role, m2m, logistics, guestIds };
}

// ---------- M2M ----------

app.get('/api/sessions', auth, (req, res) => res.json(db.sessions));

app.post('/api/sessions', auth, requireM2MEdit, (req, res) => {
  const s = { id: 'sn' + Date.now(), ...req.body };
  db.sessions.push(s);
  saveDB(db);
  io.emit('sessions:updated', db.sessions);
  res.json(s);
});

app.put('/api/sessions/:id', auth, requireM2MEdit, (req, res) => {
  const s = db.sessions.find(x => x.id === req.params.id);
  if(!s) return res.status(404).json({ error: 'Not found' });
  Object.assign(s, req.body);
  saveDB(db);
  io.emit('sessions:updated', db.sessions);
  pruneOrphanedGuests();
  res.json(s);
});

app.delete('/api/sessions/:id', auth, requireM2MEdit, (req, res) => {
  db.sessions = db.sessions.filter(x => x.id !== req.params.id);
  saveDB(db);
  io.emit('sessions:updated', db.sessions);
  pruneOrphanedGuests();
  res.json({ ok: true });
});

// ---------- Logistics ----------

app.get('/api/guests', auth, (req, res) => {
  if(req.user.role === 'shadow') return res.json(db.guests.filter(g => (req.user.guestIds||[]).includes(g.id)));
  res.json(db.guests);
});

// The logistics head's dashboard: who still needs their itinerary finalized (pulled straight
// from the M2M), and who is already done. Nothing here is typed in manually — it's derived.
app.get('/api/logistics/dashboard', auth, (req, res) => {
  const allNames = speakerNamesFromM2M();
  const doneNames = db.guests.map(g => g.name);
  const pending = allNames.filter(n => !doneNames.includes(n)).map(n => {
    const s = sessionForSpeaker(n);
    return { name: n, session: s ? (s.topic + ' - ' + s.day + ', ' + s.time) : 'Not yet in a session' };
  });
  res.json({ pending, completed: db.guests });
});

// Finalize logistics for a pending name. The name MUST already exist in the M2M — this
// endpoint refuses to create a guest out of thin air, by design.
app.post('/api/guests', auth, requireLogisticsEdit, (req, res) => {
  const { name, role, arrivalDay, arrivalTime, arrivalDetail, departDay, departTime, departDetail, hotel, cabDriver, cabPhone, shadowName, shadowPhone } = req.body;
  if(!name) return res.status(400).json({ error: 'Name is required' });
  const validNames = speakerNamesFromM2M();
  if(!validNames.includes(name)) return res.status(400).json({ error: 'This name is not on the M2M schedule. Ask the M2M coordinator to add the session first — logistics cannot add a name that is not speaking.' });
  if(db.guests.find(g => g.name === name)) return res.status(409).json({ error: 'Logistics for this person is already finalized.' });
  const s = sessionForSpeaker(name);
  const g = { id: 'g' + Date.now(), name, role: role || '', sessionId: s ? s.id : null, arrivalDay, arrivalTime, arrivalDetail, departDay, departTime, departDetail, hotel, cabDriver, cabPhone, shadowName, shadowPhone };
  db.guests.push(g);
  saveDB(db);
  io.emit('guests:updated', db.guests);
  res.json(g);
});

// Amend an already-finalized guest's logistics. Admin, or whoever holds logistics edit rights.
app.put('/api/guests/:id', auth, requireLogisticsEdit, (req, res) => {
  const g = db.guests.find(x => x.id === req.params.id);
  if(!g) return res.status(404).json({ error: 'Not found' });
  Object.assign(g, req.body);
  saveDB(db);
  io.emit('guests:updated', db.guests);
  res.json(g);
});

// ---------- Live status ----------

app.get('/api/status', auth, (req, res) => {
  if(req.user.role === 'shadow'){
    const myNames = db.guests.filter(g => (req.user.guestIds||[]).includes(g.id)).map(g => g.name);
    return res.json(db.statusLog.filter(s => myNames.includes(s.guest)));
  }
  res.json(db.statusLog);
});

app.post('/api/status', auth, (req, res) => {
  if(req.user.role !== 'shadow') return res.status(403).json({ error: 'Only a shadow can post status, for their own guest' });
  const g = db.guests.find(x => x.id === req.body.guestId && (req.user.guestIds||[]).includes(x.id));
  if(!g) return res.status(403).json({ error: 'That guest is not assigned to you' });
  const entry = { guest: g.name, status: req.body.status, time: new Date().toLocaleString() };
  db.statusLog.push(entry);
  saveDB(db);
  io.emit('status:updated', db.statusLog);
  res.json(entry);
});

// ---------- Admin: manage users ----------

app.get('/api/users', auth, requireAdmin, (req, res) => res.json(db.users.map(publicUser)));

app.post('/api/users', auth, requireAdmin, (req, res) => {
  const { name, phone, role, m2m, logistics, guestIds } = req.body;
  if(!name || !phone) return res.status(400).json({ error: 'Name and phone are both required' });
  if(db.users.find(u => u.phone === phone)) return res.status(409).json({ error: 'This phone number is already registered' });
  const u = { id: 'u' + Date.now(), name, phone, role: role || 'member', m2m: m2m || 'none', logistics: logistics || 'none', guestIds: guestIds || [] };
  db.users.push(u);
  saveDB(db);
  io.emit('users:updated', db.users.map(publicUser));
  res.json(publicUser(u));
});

app.put('/api/users/:id', auth, requireAdmin, (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if(!u) return res.status(404).json({ error: 'Not found' });
  Object.assign(u, req.body);
  saveDB(db);
  io.emit('users:updated', db.users.map(publicUser));
  res.json(publicUser(u));
});

// Revoke someone's access entirely.
app.delete('/api/users/:id', auth, requireAdmin, (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if(!u) return res.status(404).json({ error: 'Not found' });
  if(u.role === 'admin' && db.users.filter(x => x.role === 'admin').length <= 1){
    return res.status(400).json({ error: 'Cannot remove the last remaining admin — add another admin first.' });
  }
  db.users = db.users.filter(x => x.id !== req.params.id);
  saveDB(db);
  io.emit('users:updated', db.users.map(publicUser));
  res.json({ ok: true });
});

// The real calendar date behind "Day 1" / "Day 2" — this is what makes next-2-hours,
// and every other time comparison, reliable instead of guessing from typed text.
app.get('/api/day-dates', auth, (req, res) => res.json(db.dayDates));

app.put('/api/day-dates', auth, requireAdmin, (req, res) => {
  Object.assign(db.dayDates, req.body);
  saveDB(db);
  io.emit('daydates:updated', db.dayDates);
  res.json(db.dayDates);
});

io.on('connection', (socket) => {
  console.log('[SOCKET] A device connected:', socket.id);
  socket.on('disconnect', () => console.log('[SOCKET] A device disconnected:', socket.id));
});

const PORT = 4000;
server.listen(PORT, () => console.log(`EIRC conference app backend running on http://localhost:${PORT}`));
