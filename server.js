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
    // Raw state synced from EIRC's official M2M Program Builder — this app never writes to it directly.
    m2mBuilder: { days: [], halls: [], sessions: [], eventName: '', venue: '' },
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
if(!db.m2mBuilder) db.m2mBuilder = { days: [], halls: [], sessions: [], eventName: '', venue: '' }; // migration safety for existing deployments

// The M2M schedule now comes from EIRC's own official Program Builder (public/m2m-builder.html),
// synced in via /api/m2m-sync. We never generate or edit session data ourselves — we only read
// it and derive the guest list from it. Per Mayur: Dais members, Judges and Speakers count as
// people needing logistics. MoC and Vote of Thanks proposers do not (usually local, no travel/hotel).
function guestCandidatesFromM2M(){
  const list = []; // { name, role, session, topic? }
  (db.m2mBuilder.sessions || []).forEach(s => {
    (s.daisMembers || []).forEach(p => { if(p.name && p.name.trim()) list.push({ name: p.name.trim(), role: p.role || 'Dais', session: s }); });
    (s.judges || []).forEach(p => { if(p.name && p.name.trim()) list.push({ name: p.name.trim(), role: 'Judge', session: s }); });
    (s.speakers || []).forEach(p => { if(p.name && p.name.trim()) list.push({ name: p.name.trim(), role: 'Speaker', session: s, topic: p.topic }); });
  });
  return list;
}
function speakerNamesFromM2M(){
  const seen = new Set();
  guestCandidatesFromM2M().forEach(c => seen.add(c.name));
  return [...seen];
}
function sessionForSpeaker(name){
  const found = guestCandidatesFromM2M().find(c => c.name === name);
  return found ? found.session : null;
}
function roleForSpeaker(name){
  const found = guestCandidatesFromM2M().find(c => c.name === name);
  return found ? found.role : '';
}
function dayNameOf(dayId){
  const d = (db.m2mBuilder.days || []).find(x => x.id === dayId);
  return d ? d.name : '';
}
function hallNameOf(hallId){
  const h = (db.m2mBuilder.halls || []).find(x => x.id === hallId);
  return h ? h.name : (db.m2mBuilder.mainHallName || 'Main hall');
}
// A simplified read-only schedule view for anyone without edit rights on the builder itself
// (view-only M2M members, and every non-M2M screen that just needs to display the schedule).
function derivedSessionsView(){
  return (db.m2mBuilder.sessions || []).map(s => ({
    id: s.id,
    day: dayNameOf(s.dayId),
    time: s.startTime,
    sessionName: s.sessionName,
    topic: s.topic,
    hall: hallNameOf(s.hallId),
    dais: (s.daisMembers || []).filter(p => p.name).map(p => ({ name: p.name, role: p.role })),
    judges: (s.judges || []).filter(p => p.name).map(p => ({ name: p.name })),
    speakers: (s.speakers || []).filter(p => p.name).map(p => ({ name: p.name, topic: p.topic })),
    moc: s.mocNames || '',
    vot: s.voteOfThanksBy || ''
  }));
}

// If a guest's name no longer appears anywhere in the synced M2M — because a session was
// deleted, or their name was removed from it in the builder — their finalized logistics
// shouldn't exist either, and no shadow should still be pointed at them.
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
// The M2M schedule is authored exclusively in EIRC's official Program Builder
// (served at /m2m-builder.html, completely unmodified from the file EIRC provided).
// This app never creates or edits sessions itself — it only receives a live sync of
// whatever the builder currently holds, and derives the guest list and a read-only
// display from it.

app.get('/api/sessions', auth, (req, res) => res.json(derivedSessionsView()));

// Only whoever holds M2M edit rights can push a sync (they're the one with the builder open).
app.post('/api/m2m-sync', auth, requireM2MEdit, (req, res) => {
  db.m2mBuilder = {
    days: req.body.days || [],
    halls: req.body.halls || [],
    sessions: req.body.sessions || [],
    eventName: req.body.eventName || '',
    venue: req.body.venue || ''
  };
  saveDB(db);
  io.emit('sessions:updated', derivedSessionsView());
  pruneOrphanedGuests();
  res.json({ ok: true, sessionCount: db.m2mBuilder.sessions.length });
});

// ---------- Logistics ----------

app.get('/api/guests', auth, (req, res) => {
  if(req.user.role === 'shadow') return res.json(db.guests.filter(g => (req.user.guestIds||[]).includes(g.id)));
  res.json(db.guests);
});

// The logistics head's dashboard: who still needs their itinerary finalized (pulled straight
// from the M2M), and who is already done. Nothing here is typed in manually — it's derived,
// including their role, which comes from what the M2M coordinator assigned in the builder.
app.get('/api/logistics/dashboard', auth, (req, res) => {
  const allNames = speakerNamesFromM2M();
  const doneNames = db.guests.map(g => g.name);
  const pending = allNames.filter(n => !doneNames.includes(n)).map(n => {
    const s = sessionForSpeaker(n);
    const role = roleForSpeaker(n);
    return {
      name: n,
      role,
      session: s ? ((s.sessionName || s.topic || 'Session') + ' - ' + dayNameOf(s.dayId) + ', ' + s.startTime) : 'Not yet in a session'
    };
  });
  res.json({ pending, completed: db.guests });
});

// Finalize logistics for a pending name. The name MUST already exist in the M2M — this
// endpoint refuses to create a guest out of thin air, by design.
app.post('/api/guests', auth, requireLogisticsEdit, (req, res) => {
  const { name, role, arrivalDate, arrivalTime, arrivalDetail, departDate, departTime, departDetail, hotel, cabDriver, cabPhone, shadowName, shadowPhone } = req.body;
  if(!name) return res.status(400).json({ error: 'Name is required' });
  const validNames = speakerNamesFromM2M();
  if(!validNames.includes(name)) return res.status(400).json({ error: 'This name is not on the M2M schedule. Ask the M2M coordinator to add the session first — logistics cannot add a name that is not speaking.' });
  if(db.guests.find(g => g.name === name)) return res.status(409).json({ error: 'Logistics for this person is already finalized.' });
  const s = sessionForSpeaker(name);
  const g = { id: 'g' + Date.now(), name, role: role || roleForSpeaker(name) || '', sessionId: s ? s.id : null, arrivalDate, arrivalTime, arrivalDetail, departDate, departTime, departDetail, hotel, cabDriver, cabPhone, shadowName, shadowPhone };
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
