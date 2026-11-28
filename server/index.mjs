// The online-duel server. It hands out the game page and hosts the rooms. Each room with two players runs its own copy
// of the game (the script inside index.html, loaded with no screen) 60 steps a second and sends both players what
// happened 30 times a second. Players send only the keys they are holding.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8791);
const TICK = 1 / 60, SNAP_EVERY = 2, MAX_ROOMS = 60;
const PAGE = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const GAME = new vm.Script(PAGE.match(/<script>([\s\S]*?)<\/script>/)[1] + '\n;({ netHost, coopHost, coopDrop, netInput, netTick, netSnap, netOver })', { filename: 'index.html.js' });

// a copy of the game with stand-ins for the browser things it touches while loading
function newGame() {
  const noop = () => {}, grad = { addColorStop: noop };
  const ctx2d = new Proxy({}, { get: (t, k) => k in t ? t[k] : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => grad : noop, set: (t, k, v) => { t[k] = v; return true; } });
  const box = {
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, console,
    document: { getElementById: () => ({ getContext: () => ctx2d, addEventListener: noop }) },
    addEventListener: noop, requestAnimationFrame: noop, performance: { now: () => 0 },
    location: { search: '', protocol: 'http:', host: '', hostname: '', port: '', origin: '', pathname: '/' },
    localStorage: { getItem: () => null, setItem: noop }
  };
  box.window = box;
  return GAME.runInContext(vm.createContext(box));
}

const rooms = new Map();
const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) { let c = ''; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)]; if (!rooms.has(c)) return c; }
}
// everyone in the room is told who is in it; the first seat is the host
function lobby(r) {
  const players = r.seats.map(s => ({ w: s.weapon }));
  r.seats.forEach((s, i) => send(s.ws, { t: 'lobby', code: r.code, mode: r.mode, players, me: i, playing: !!r.game }));
}
function startMatch(r) {
  stopMatch(r);
  r.playing = r.seats.slice();                               // seat order at the start is the player order for the whole match
  const blades = r.seats.map(s => s.blade), weapons = r.seats.map(s => s.weapon);
  try { r.game = newGame(); if (r.mode === 'coop') r.game.coopHost(weapons); else r.game.netHost(blades); }
  catch (e) { console.error('game failed to start', e); r.game = null; return; }
  r.seats.forEach((s, i) => send(s.ws, { t: 'start', mode: r.mode, me: i, b: blades, w: weapons }));
  const every = r.mode === 'coop' ? 3 : 2;                     // messages per second: 20 for co-op (more to send), 30 for a duel
  let last = Date.now(), owed = 0, ticks = 0;
  r.timer = setInterval(() => {
    const now = Date.now(); owed = Math.min(owed + (now - last) / 1000, 0.1); last = now;
    try {
      while (owed >= TICK) {
        owed -= TICK; r.game.netTick(TICK);
        if (++ticks % every === 0) { const m = JSON.stringify({ t: 'snap', s: r.game.netSnap() }); for (const s of r.seats) if (s.ws.readyState === 1) s.ws.send(m); }
      }
    } catch (e) { console.error('room ' + r.code + ' crashed', e); stopMatch(r); for (const s of r.seats) send(s.ws, { t: 'error', msg: 'The match hit an error on the server' }); }
  }, 1000 / 120);
}
function stopMatch(r) { if (r.timer) clearInterval(r.timer); r.timer = null; r.game = null; r.playing = null; }

const http = createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path === '/health') { res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); return res.end('stick-sabers server ok — ' + rooms.size + ' rooms\n'); }
  if (path === '/' || path === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(PAGE); }
  if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found\n');
});
const wss = new WebSocketServer({ server: http, maxPayload: 4096 });

wss.on('connection', (ws) => {
  let room = null, seat = null;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'create' || m.t === 'join') {
      if (room) return;
      if (m.t === 'join') {
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) return send(ws, { t: 'error', msg: 'No room with that code' });
        if (r.seats.length >= (r.mode === 'coop' ? 4 : 2)) return send(ws, { t: 'error', msg: 'That room is full' });
        if (r.game) return send(ws, { t: 'error', msg: 'That game has already started; try again when it ends' });
        room = r;
      } else {
        if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', msg: 'The server is full; try again later' });
        room = { code: newCode(), mode: m.mode === 'coop' ? 'coop' : 'duel', seats: [], game: null, timer: null, playing: null };
        rooms.set(room.code, room);
      }
      let weapon = Math.max(0, Math.min(4, Math.round(+m.w) || 0));
      if (!weapon) weapon = [1, 2, 3, 4].find(w => !room.seats.some(s => s.weapon === w)) || 1;   // no turtle chosen: take a weapon nobody has yet
      seat = { ws, blade: Math.max(0, Math.min(4, Math.round(+m.b) || 0)), weapon };
      room.seats.push(seat);
      lobby(room);
      if (room.mode === 'duel' && room.seats.length === 2) startMatch(room);
      return;
    }
    if (!room) return;
    if (m.t === 'w' && !room.game) { seat.weapon = Math.max(1, Math.min(4, Math.round(+m.w) || 1)); return lobby(room); }
    if (m.t === 'start' && !room.game && room.mode === 'coop' && room.seats[0] === seat) return startMatch(room);
    if (!room.game) return;
    if (m.t === 'i' && Array.isArray(m.h) && Array.isArray(m.p) && m.h.length <= 40 && m.p.length <= 40) { const i = room.playing.indexOf(seat); if (i >= 0) room.game.netInput(i, m.h.map(String), m.p.map(String)); }
    else if (m.t === 'again' && room.game.netOver() && (room.mode === 'duel' || room.seats[0] === seat)) startMatch(room);
  });
  ws.on('close', () => {
    if (!room) return;
    const r = room, i = r.seats.indexOf(seat); if (i >= 0) r.seats.splice(i, 1);
    if (!r.seats.length) { stopMatch(r); rooms.delete(r.code); return; }
    if (r.mode === 'coop' && r.game) { try { r.game.coopDrop(r.playing.indexOf(seat)); } catch (e) {} return lobby(r); }   // the others play on without that turtle
    if (r.game) { stopMatch(r); for (const s of r.seats) send(s.ws, { t: 'left' }); }
    lobby(r);
  });
  ws.on('error', () => {});
});

http.listen(PORT, () => console.log('stick-sabers server on :' + PORT));
