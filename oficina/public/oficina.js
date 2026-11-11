/* Oficina Virtual Polipay — mapa animado del equipo de agentes.
   Lee ../agentes.json, ../tareas.json y ../estado/actividad.json cada 2 s. */
(() => {
'use strict';

// ---------------------------------------------------------------- geometría
const T = 16, W = 21, H = 13, MX = 3, MY = 3, HALL = 4, COLS = 4;
const TW = MX + COLS * (W + 1) + 1 + MX;           // ancho en tiles
const TOP_Y0 = MY + 1, HALL_Y0 = TOP_Y0 + H + 1, BOT_Y0 = HALL_Y0 + HALL + 1;
const TH = BOT_Y0 + H + 1 + MY;                     // alto en tiles
const MAP_W = TW * T, MAP_H = TH * T;
const HALL_Y = (HALL_Y0 + HALL / 2) * T;
const CORR = 10.5;                                  // pasillo central de salas de línea (x local)
const SPINE_TOP = H - 1.2;                          // pasillo inferior de salas superiores (y local)
const DESK_COLS = [1, 5, 13.2, 17.2], DESK_ROWS = [1.4, 5.2, 9.0];
const AISLES = DESK_ROWS.map(r => r + 2.6);
const ORDEN_ROLES = ['ceo','cfo','coo','cro-riesgos','cco','cto','cpo','cdo-caio','ciso','clo','cro-ingresos','cmo'];

const LINEAS = {
  emisor:    { nombre: 'Emisor · BSO',        col: 0, piso: ['#e7f0fe','#dce9fd'], acento: '#3083F4' },
  agregador: { nombre: 'Agregador · MCEB',    col: 1, piso: ['#e3f6ee','#d5f0e4'], acento: '#10b981' },
  banca:     { nombre: 'Banca · Telematic',   col: 2, piso: ['#ede9fb','#e3ddf8'], acento: '#8b5cf6' },
  credito:   { nombre: 'Crédito · SAYO',      col: 3, piso: ['#fbf1e1','#f6e6cc'], acento: '#f59e0b' },
};
const COLOR_ROL = {
  ceo:'#1e3a8a', cfo:'#0f766e', coo:'#b45309', 'cro-riesgos':'#b91c1c', cco:'#6d28d9', cto:'#0369a1',
  cpo:'#be185d', 'cdo-caio':'#4d7c0f', ciso:'#334155', clo:'#7c2d12', 'cro-ingresos':'#c2410c', cmo:'#db2777',
  especialista:'#ca8a04', recepcion:'#3083F4',
};
const PIELES = ['#f5d0b5','#eab68f','#d39a6e','#b57a4f','#8d5a36','#f1c7a3'];
const PELOS  = ['#2b1d14','#4a2f1d','#7a4a24','#c58b3c','#1f2937','#6b7280','#a0522d','#e7c27a','#3b2a4a'];

const room = (id, nombre, col, fila, kind, extra = {}) => {
  const x0 = MX + 1 + col * (W + 1), y0 = fila === 0 ? TOP_Y0 : BOT_Y0;
  const door = kind === 'top' ? { x: (x0 + CORR) * T, y: (y0 + H + 0.5) * T } : { x: (x0 + CORR) * T, y: (y0 - 0.5) * T };
  return { id, nombre, col, fila, kind, x0, y0, door, spots: [], ...extra };
};
const ROOMS = {
  recepcion: room('recepcion', 'Recepción', 0, 0, 'top', { piso: ['#eef2f7','#e4e9f1'] }),
  comites:   room('comites', 'Sala de Comités', 1, 0, 'top', { piso: ['#d9b48a','#d0a97d'], madera: true }),
  copa:      room('copa', 'Copa', 2, 0, 'top', { piso: ['#ffffff','#dbe7f7'], ajedrez: true }),
  lounge:    room('lounge', 'Lounge', 3, 0, 'top', { piso: ['#c99a6b','#bf8f60'], madera: true }),
};
for (const [k, l] of Object.entries(LINEAS)) ROOMS[k] = room(k, l.nombre, l.col, 1, 'line', { piso: l.piso, acento: l.acento, linea: k });

const P = (r, lx, ly) => ({ x: (r.x0 + lx) * T, y: (r.y0 + ly) * T });
const spot = (r, lx, ly, dir, sit, tipo = 'idle') => { const s = { ...P(r, lx, ly), dir, sit, room: r.id, tipo, occ: null }; r.spots.push(s); return s; };

// asientos y lugares para estar
const R = ROOMS;
const SEAT_RECEPCION = spot(R.recepcion, CORR, 3.4, 'down', true, 'fijo');
[2.2, 3.6, 5.0].forEach(x => spot(R.recepcion, x, 9.7, 'down', true));
spot(R.recepcion, 18.6, 9.7, 'down', true);
const MEETING = [];
[6.5, 8.5, 10.5, 12.5, 14.5].forEach(x => MEETING.push(spot(R.comites, x, 8.6, 'up', true, 'junta')));
MEETING.push(spot(R.comites, 4.0, 6.0, 'right', true, 'junta'), spot(R.comites, 17.0, 6.0, 'left', true, 'junta'));
MEETING.push(spot(R.comites, 2.3, 3.4, 'right', false, 'junta'), spot(R.comites, 18.7, 3.4, 'left', false, 'junta'));
[3.5, 5.2, 6.9, 11.5, 13.2, 14.9].forEach(x => spot(R.copa, x, 8.3, 'up', true));
spot(R.copa, 1.5, 3.3, 'up', false); spot(R.copa, 9.0, 3.3, 'up', false); spot(R.copa, 17.2, 3.3, 'up', false);
[3.6, 5.6, 7.2].forEach(x => spot(R.lounge, x, 4.4, 'down', true));
spot(R.lounge, 11.2, 6.4, 'right', false); spot(R.lounge, 17.8, 6.4, 'left', false);
[2.6, 4.6, 6.6].forEach(x => spot(R.lounge, x, 9.6, 'down', true));
spot(R.lounge, 19.0, 3.2, 'up', false); spot(R.lounge, 9.5, 3.0, 'up', false);
for (const k of Object.keys(LINEAS)) { const r = R[k]; spot(r, 20.4, AISLES[0], 'up', false); spot(r, 0.6, AISLES[2], 'left', false); spot(r, 20.4, AISLES[2], 'right', false); }

// escritorios de cada línea
const DESKS = {};
for (const k of Object.keys(LINEAS)) {
  const r = R[k];
  ORDEN_ROLES.forEach((rol, i) => {
    const lx = DESK_COLS[i % 4], ly = DESK_ROWS[Math.floor(i / 4)];
    DESKS[`${k}-${rol}`] = { room: k, lx, ly, seat: { ...P(r, lx + 1.4, ly + 1.75), dir: 'up', sit: true, room: k, tipo: 'escritorio' }, facing: 'up' };
  });
  DESKS[`${k}-especialista`] = { room: k, lx: CORR - 1.4, ly: 12.0, seat: { ...P(r, CORR, 11.45), dir: 'down', sit: true, room: k, tipo: 'escritorio' }, facing: 'down', jefe: true };
}

// ---------------------------------------------------------------- rutas
const roomOf = (x, y) => {
  for (const r of Object.values(ROOMS)) {
    if (x >= r.x0 * T - 2 && x <= (r.x0 + W) * T + 2 && y >= (r.y0 - 0.6) * T && y <= (r.y0 + H + 0.6) * T) return r;
  }
  return null;
};
function reach(r, p) {
  const lx = p.x / T - r.x0, ly = p.y / T - r.y0;
  if (r.kind === 'top') return [{ x: p.x, y: (r.y0 + SPINE_TOP) * T }];
  if (Math.abs(lx - CORR) < 0.05) return [];
  let a = AISLES.find(a => a >= ly - 0.05); if (a === undefined) a = AISLES[AISLES.length - 1];
  return [{ x: p.x, y: (r.y0 + a) * T }, { x: (r.x0 + CORR) * T, y: (r.y0 + a) * T }];
}
const inner = (r, p, q) => [...reach(r, p), ...reach(r, q).reverse(), { x: q.x, y: q.y }];
function ruta(from, to) {
  const A = roomOf(from.x, from.y), B = ROOMS[to.room];
  if (!A) return [{ x: from.x, y: HALL_Y }, { x: B.door.x, y: HALL_Y }, ...inner(B, B.door, to)];
  if (A === B) return inner(A, from, to);
  return [...inner(A, from, A.door), { x: A.door.x, y: HALL_Y }, { x: B.door.x, y: HALL_Y }, ...inner(B, B.door, to)];
}

// ---------------------------------------------------------------- utilidades
const hash = s => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const dur = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60; return h ? `${h} h ${m} min` : m ? `${m}min ${ss}s` : `${ss}s`; };
const hace = s => s < 60 ? 'hace un momento' : s < 3600 ? `hace ${Math.floor(s / 60)} min` : s < 86400 ? `hace ${Math.floor(s / 3600)} h` : `hace ${Math.floor(s / 86400)} d`;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const corto = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

// ---------------------------------------------------------------- fondo estático
const bg = document.createElement('canvas'); bg.width = MAP_W; bg.height = MAP_H;
function pintarFondo() {
  const g = bg.getContext('2d');
  // pasto con textura
  g.fillStyle = '#4c9a45'; g.fillRect(0, 0, MAP_W, MAP_H);
  for (let i = 0; i < 1400; i++) { const h = hash('g' + i); g.fillStyle = h % 3 ? '#57a84f' : '#43903d'; g.fillRect(h % MAP_W, (h >> 11) % MAP_H, 2, 1); }
  // camino de entrada
  g.fillStyle = '#d8d2c4'; g.fillRect(0, (HALL_Y0 + 1) * T, MX * T, 2 * T);
  g.fillStyle = '#c9c2b1'; for (let x = 0; x < MX * T; x += 8) g.fillRect(x, (HALL_Y0 + 1) * T + ((x / 8) % 2 ? 4 : 18), 4, 3);
  // árboles alrededor
  const arbol = (x, y, s) => {
    g.fillStyle = 'rgba(0,0,0,.18)'; g.beginPath(); g.ellipse(x, y + 2, 8 * s, 3 * s, 0, 0, 7); g.fill();
    g.fillStyle = '#6b4423'; g.fillRect(x - 2, y - 6 * s, 4, 6 * s + 2);
    g.fillStyle = '#2f7d32'; g.beginPath(); g.arc(x, y - 11 * s, 8 * s, 0, 7); g.fill();
    g.fillStyle = '#3d9a3f'; g.beginPath(); g.arc(x - 2 * s, y - 13 * s, 5 * s, 0, 7); g.fill();
  };
  for (let x = 12; x < MAP_W; x += 44) { arbol(x + (hash('a' + x) % 14), 2.2 * T, 1); arbol(x + 20 + (hash('b' + x) % 12), MAP_H - 0.6 * T, 1); }
  for (let y = 3 * T; y < MAP_H - 2 * T; y += 46) { if (Math.abs(y - (HALL_Y0 + 2) * T) > 40) arbol(1.3 * T, y + 20, .9); arbol(MAP_W - 1.4 * T, y + 24, .9); }
  // flores
  for (let i = 0; i < 90; i++) { const h = hash('f' + i), x = h % MAP_W, y = (h >> 9) % MAP_H; if (y < 2.8 * T || y > MAP_H - 2.8 * T || x < 2.5 * T || x > MAP_W - 2.5 * T) { g.fillStyle = ['#fde047', '#f9a8d4', '#ffffff'][h % 3]; g.fillRect(x, y, 2, 2); } }

  // edificio: muros
  const bx = MX * T, by = MY * T, bw = (COLS * (W + 1) + 1) * T, bh = (TH - 2 * MY) * T;
  g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(bx + 4, by + 6, bw, bh);
  g.fillStyle = '#0B2E59'; g.fillRect(bx, by, bw, bh);
  // pasillo
  const hy = HALL_Y0 * T;
  for (let x = bx + T; x < bx + bw - T; x += T) for (let y = hy; y < hy + HALL * T; y += T) { g.fillStyle = ((x + y) / T) % 2 ? '#e9edf3' : '#e2e7ee'; g.fillRect(x, y, T, T); }
  g.fillStyle = '#e9edf3'; g.fillRect(bx, hy + T, T, 2 * T); // entrada
  for (let c = 0; c < COLS; c++) { const x = (MX + 1 + c * (W + 1) + 4) * T; g.fillStyle = '#123a6b'; g.fillRect(x, HALL_Y - 5, (W - 8) * T, 10); g.fillStyle = '#3083F4'; g.fillRect(x + 3, HALL_Y - 2, (W - 8) * T - 6, 4); }
  g.fillStyle = '#7a5c3e'; g.fillRect(bx + 2, hy + T + 4, 10, 2 * T - 8); // tapete de entrada
  // salas
  for (const r of Object.values(ROOMS)) pintarSala(g, r);
  // muros (cara superior clara)
  g.fillStyle = '#1d4b85';
  for (const r of Object.values(ROOMS)) g.fillRect(r.x0 * T, r.y0 * T - 5, W * T, 5);
  g.fillRect(bx + T, hy - 5, bw - 2 * T, 5);
  // puertas
  for (const r of Object.values(ROOMS)) {
    const dx = r.door.x - 1.5 * T;
    if (r.kind === 'top') { g.fillStyle = '#e9edf3'; g.fillRect(dx, (r.y0 + H) * T, 3 * T, T); g.fillStyle = '#b9c2cf'; g.fillRect(dx, (r.y0 + H) * T, 3 * T, 2); }
    else { g.fillStyle = r.piso[0]; g.fillRect(dx, (r.y0 - 1) * T, 3 * T, T); g.fillStyle = '#b9c2cf'; g.fillRect(dx, (r.y0 - 1) * T, 3 * T, 2); }
  }
}

function pintarSala(g, r) {
  const x0 = r.x0 * T, y0 = r.y0 * T;
  for (let i = 0; i < W; i++) for (let j = 0; j < H; j++) {
    const alt = r.ajedrez ? (i + j) % 2 : r.madera ? (j % 2 ? (i + 1) % 3 === 0 : i % 3 === 0) : (i + j) % 2;
    g.fillStyle = alt ? r.piso[1] : r.piso[0]; g.fillRect(x0 + i * T, y0 + j * T, T, T);
    if (r.madera) { g.fillStyle = 'rgba(0,0,0,.06)'; g.fillRect(x0 + i * T, y0 + j * T + T - 1, T, 1); }
  }
  // ventanas en el muro superior
  if (r.fila === 0) for (let i = 2; i < W - 2; i += 5) { g.fillStyle = '#9EC5F5'; g.fillRect(x0 + i * T, y0 - 12, 2 * T, 7); g.fillStyle = '#E7F0FE'; g.fillRect(x0 + i * T + 3, y0 - 11, 6, 2); }
  const L = (lx, ly) => [(r.x0 + lx) * T, (r.y0 + ly) * T];
  const planta = (lx, ly) => { const [x, y] = L(lx, ly); g.fillStyle = '#8b5a2b'; g.fillRect(x - 4, y - 2, 8, 7); g.fillStyle = '#2f8f46'; g.beginPath(); g.arc(x, y - 6, 6, 0, 7); g.fill(); g.fillStyle = '#46b35c'; g.beginPath(); g.arc(x - 2, y - 8, 3, 0, 7); g.fill(); };
  const garrafon = (lx, ly) => { const [x, y] = L(lx, ly); g.fillStyle = '#e5e7eb'; g.fillRect(x - 4, y - 4, 8, 10); g.fillStyle = '#93c5fd'; g.fillRect(x - 3, y - 12, 6, 8); };
  const rect = (lx, ly, w, h, c) => { const [x, y] = L(lx, ly); g.fillStyle = c; g.fillRect(x, y, w * T, h * T); };
  const sombra = (lx, ly, w, h) => { const [x, y] = L(lx, ly); g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(x + 2, y + h * T, w * T, 3); };

  if (r.kind === 'line') {
    for (const [id, d] of Object.entries(DESKS)) if (d.room === r.id) pintarEscritorio(g, r, d);
    // librero, garrafón e impresora
    rect(0.3, 0.2, 0.9, 1.0, '#7c5a3a'); planta(20.4, 0.9); garrafon(20.4, AISLES[0] - 0.6);
    rect(0.2, AISLES[2] - 1.3, 0.8, 0.9, '#7c5a3a'); rect(19.8, AISLES[2] - 1.1, 1.0, 0.7, '#cbd5e1');
    planta(8.2, 0.9); planta(12.8, 0.9);
    // franja de color de la empresa
    g.fillStyle = r.acento; g.fillRect(x0, y0, W * T, 3);
  }
  if (r.id === 'recepcion') {
    sombra(5.5, 4.2, 10, 1.2); rect(5.5, 4.2, 10, 1.2, '#f8fafc'); rect(5.5, 5.1, 10, 0.3, '#0B2E59'); rect(5.5, 4.2, 10, 0.2, '#3083F4');
    const [mx, my] = L(CORR, 4.3); g.fillStyle = '#1f2633'; g.fillRect(mx - 14, my - 6, 12, 8); g.fillStyle = '#5b8fd6'; g.fillRect(mx - 13, my - 5, 10, 5);
    // logo
    const [lx, ly] = L(CORR, 0.9); g.fillStyle = '#3083F4'; g.fillRect(lx - 9, ly - 6, 18, 14); g.fillStyle = '#fff'; g.fillRect(lx - 4, ly - 3, 3, 9); g.fillRect(lx - 4, ly - 3, 7, 2); g.fillRect(lx + 1, ly - 3, 2, 5); g.fillRect(lx - 4, ly + 1, 7, 2);
    // sala de espera
    rect(1.4, 9.1, 4.4, 0.9, '#0B2E59'); rect(1.4, 8.8, 4.4, 0.4, '#123a6b'); rect(17.9, 9.1, 1.6, 0.9, '#0B2E59'); rect(17.9, 8.8, 1.6, 0.4, '#123a6b');
    rect(7.5, 9.2, 2.2, 1.1, '#cbd5e1'); planta(1.0, 6.5); planta(20.0, 6.5); garrafon(20.2, 2.4);
    rect(15.8, 1.2, 3.5, 0.3, '#1f2937');
  }
  if (r.id === 'comites') {
    sombra(5, 4, 11, 3.6); rect(5, 4, 11, 3.6, '#5b3a22'); rect(5.2, 4.2, 10.6, 3.2, '#7a5032');
    for (let i = 0; i < 5; i++) { const [x, y] = L(6.5 + i * 2, 3.4); g.fillStyle = '#334155'; g.fillRect(x - 5, y - 4, 10, 6); }
    rect(6, 0.2, 9, 1.3, '#f8fafc'); rect(6, 0.2, 9, 0.15, '#94a3b8');
    g.fillStyle = '#3083F4'; const [wx, wy] = L(7, 0.6); g.fillRect(wx, wy, 20, 2); g.fillRect(wx, wy + 5, 34, 2); g.fillStyle = '#ef4444'; g.fillRect(wx + 60, wy, 30, 10);
    planta(1.0, 1.2); planta(20.0, 1.2); planta(1.0, 11.0); planta(20.0, 11.0);
    const [tx, ty] = L(CORR, 5.6); g.fillStyle = '#1f2937'; g.fillRect(tx - 6, ty - 3, 12, 6);
  }
  if (r.id === 'copa') {
    rect(0.5, 0.3, 12.5, 2.0, '#cbd5e1'); rect(0.5, 0.3, 12.5, 0.4, '#94a3b8');
    const [cx, cy] = L(4, 1.0); g.fillStyle = '#1f2937'; g.fillRect(cx - 5, cy - 4, 10, 12); g.fillStyle = '#ef4444'; g.fillRect(cx - 2, cy, 4, 2);
    const [sx, sy] = L(9, 1.0); g.fillStyle = '#94a3b8'; g.fillRect(sx - 7, sy, 14, 6); g.fillStyle = '#e5e7eb'; g.fillRect(sx - 1, sy - 4, 2, 4);
    rect(16.3, 0.2, 1.8, 2.6, '#e5e7eb'); rect(16.3, 1.3, 1.8, 0.1, '#94a3b8');
    rect(18.6, 0.2, 1.8, 2.6, '#dc2626'); rect(18.8, 0.5, 1.4, 1.4, '#fde68a');
    for (const x0t of [2.6, 10.6]) { sombra(x0t, 6, 5.2, 1.6); rect(x0t, 6, 5.2, 1.6, '#f1f5f9'); rect(x0t, 7.4, 5.2, 0.2, '#94a3b8'); }
    planta(20.3, 11.0); planta(0.8, 11.0);
  }
  if (r.id === 'lounge') {
    rect(1.5, 7.6, 7, 3.6, '#3083F4'); rect(1.8, 7.9, 6.4, 3.0, '#5b9cf6');
    rect(2.4, 3.2, 5.2, 1.0, '#0B2E59'); rect(2.4, 3.0, 5.2, 0.4, '#123a6b'); rect(2.2, 3.0, 0.4, 1.4, '#123a6b'); rect(7.4, 3.0, 0.4, 1.4, '#123a6b');
    sombra(12, 5.4, 5, 2); rect(12, 5.4, 5, 2, '#1d6b3a'); rect(12, 6.35, 5, 0.1, '#ffffff'); rect(14.45, 5.4, 0.1, 2, '#e5e7eb');
    rect(18.2, 0.2, 2.4, 2.2, '#7c5a3a'); for (let i = 0; i < 4; i++) rect(18.4 + i * 0.5, 0.5, 0.35, 0.7, ['#ef4444', '#3083F4', '#f59e0b', '#22c55e'][i]); for (let i = 0; i < 4; i++) rect(18.4 + i * 0.5, 1.4, 0.35, 0.7, ['#a855f7', '#22c55e', '#ef4444', '#0ea5e9'][i]);
    rect(8.8, 0.3, 1.4, 1.9, '#4c1d95'); rect(9.0, 0.6, 1.0, 0.7, '#22d3ee');
    for (const x of [2.6, 4.6, 6.6]) { const [bx2, by2] = L(x, 9.9); g.fillStyle = ['#ef4444', '#f59e0b', '#22c55e'][Math.round(x) % 3]; g.beginPath(); g.ellipse(bx2, by2 - 2, 8, 6, 0, 0, 7); g.fill(); }
    planta(20.3, 11.0); planta(11.0, 11.0); planta(0.8, 1.0);
  }
}

function pintarEscritorio(g, r, d) {
  const x = (r.x0 + d.lx) * T, y = (r.y0 + d.ly) * T, w = 2.8 * T;
  g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(x + 2, y + T, w, 3);
  g.fillStyle = d.jefe ? '#7a5032' : '#f8fafc'; g.fillRect(x, y, w, T);
  g.fillStyle = d.jefe ? '#5b3a22' : '#cbd5e1'; g.fillRect(x, y + T - 3, w, 3);
  if (d.jefe) { g.fillStyle = '#ca8a04'; g.fillRect(x, y, w, 2); }
  const cx = x + w / 2;
  // monitor (la pantalla se pinta en vivo)
  g.fillStyle = '#1f2633'; g.fillRect(cx - 7, y - 6, 14, 9); g.fillStyle = '#374151'; g.fillRect(cx - 1, y + 3, 2, 2);
  g.fillStyle = '#e5e7eb'; g.fillRect(cx - 5, y + 6, 10, 3);
  g.fillStyle = '#94a3b8'; g.fillRect(x + 4, y + 5, 4, 5); // papeles
  // silla
  const sy = d.facing === 'up' ? y + T + 6 : y - 14;
  g.fillStyle = '#334155'; g.fillRect(cx - 5, sy, 10, 7); g.fillStyle = '#1f2937'; g.fillRect(cx - 1, sy + 7, 2, 3);
}

// ---------------------------------------------------------------- personajes
function apariencia(a) {
  const h = hash(a.id);
  return { piel: PIELES[h % PIELES.length], pelo: PELOS[(h >> 4) % PELOS.length], camisa: COLOR_ROL[a.rolId] || '#475569',
    pantalon: ['#0B2E59', '#1f2937', '#374151', '#3f3f46'][(h >> 8) % 4], largo: (h >> 12) % 3 === 0, lentes: (h >> 15) % 5 === 0,
    diadema: a.tipo === 'recepcion' };
}

function dibujarPersonaje(g, x, y, ap, o) {
  x = Math.round(x); y = Math.round(y);
  const f = o.frame || 0, dir = o.dir || 'down';
  g.fillStyle = 'rgba(0,0,0,.2)'; g.fillRect(x - 4, y - 1, 8, 2);
  if (!o.sit) {
    const a = o.walking ? (f % 2 ? 1 : -1) : 0;
    g.fillStyle = ap.pantalon; g.fillRect(x - 3, y - 5 + Math.min(0, a), 2, 4 - Math.abs(Math.min(0, a))); g.fillRect(x + 1, y - 5 + Math.min(0, -a), 2, 4 - Math.abs(Math.min(0, -a)));
    g.fillStyle = '#111827'; g.fillRect(x - 3, y - 1 + Math.min(0, a), 2, 1); g.fillRect(x + 1, y - 1 + Math.min(0, -a), 2, 1);
  } else if (dir !== 'up') {
    g.fillStyle = ap.pantalon; g.fillRect(x - 3, y - 4, 6, 2); g.fillStyle = '#111827'; g.fillRect(x - 3, y - 2, 2, 1); g.fillRect(x + 1, y - 2, 2, 1);
  }
  const by = o.sit ? y - 4 : y - 5;
  g.fillStyle = ap.camisa; g.fillRect(x - 4, by - 5, 8, 5);
  // brazos
  const sw = o.walking ? (f % 2 ? 1 : -1) : 0, tp = o.typing ? (f % 2) : 0;
  g.fillStyle = ap.camisa; g.fillRect(x - 5, by - 5 + sw, 1, 3); g.fillRect(x + 4, by - 5 - sw, 1, 3);
  g.fillStyle = ap.piel; g.fillRect(x - 5, by - 2 + sw - tp, 1, 1); g.fillRect(x + 4, by - 2 - sw - (1 - tp) * (o.typing ? 1 : 0), 1, 1);
  // cabeza
  const hy = by - 11;
  if (dir === 'up') {
    g.fillStyle = ap.pelo; g.fillRect(x - 4, hy, 8, 7); if (ap.largo) g.fillRect(x - 4, hy + 7, 8, 2);
  } else {
    g.fillStyle = ap.piel; g.fillRect(x - 3, hy + 1, 6, 6);
    g.fillStyle = ap.pelo; g.fillRect(x - 4, hy, 8, 2);
    if (ap.largo) { g.fillRect(x - 4, hy + 2, 1, 6); g.fillRect(x + 3, hy + 2, 1, 6); } else { g.fillRect(x - 4, hy + 2, 1, 2); g.fillRect(x + 3, hy + 2, 1, 2); }
    g.fillStyle = '#111827';
    const parpadeo = (o.t + (hash(o.id) % 50) / 10) % 4 < 0.12;
    if (!parpadeo) {
      if (dir === 'down') { g.fillRect(x - 2, hy + 4, 1, 1); g.fillRect(x + 1, hy + 4, 1, 1); }
      else if (dir === 'left') g.fillRect(x - 2, hy + 4, 1, 1); else g.fillRect(x + 1, hy + 4, 1, 1);
    }
    if (ap.lentes && dir === 'down') { g.fillStyle = 'rgba(17,24,39,.55)'; g.fillRect(x - 3, hy + 3, 6, 1); }
    if (dir === 'left') { g.fillStyle = ap.pelo; g.fillRect(x + 1, hy + 2, 3, 3); }
    if (dir === 'right') { g.fillStyle = ap.pelo; g.fillRect(x - 4, hy + 2, 3, 3); }
  }
  if (ap.diadema) { g.fillStyle = '#111827'; g.fillRect(x - 5, hy + 2, 1, 4); g.fillRect(x + 4, hy + 2, 1, 4); g.fillRect(x - 4, hy - 1, 8, 1); }
  if (o.sit && dir === 'up') { g.fillStyle = '#334155'; g.fillRect(x - 5, y - 6, 10, 5); g.fillStyle = '#475569'; g.fillRect(x - 5, y - 6, 10, 1); }
}

function avatarURL(a) {
  const c = document.createElement('canvas'); c.width = 16; c.height = 16; const g = c.getContext('2d');
  dibujarPersonaje(g, 8, 18, apariencia(a), { dir: 'down', t: 0, id: 'x' });
  return c.toDataURL();
}

// ---------------------------------------------------------------- estado del mundo
let AGENTES = [], TAREAS = [], ACT = { activos: {}, recientes: [] }, conectado = false;
const PJ = new Map();           // id → personaje
let seleccion = null, hover = null, filtro = '', tab = 'equipo';
const DEMO = { on: new URLSearchParams(location.search).has('demo'), activos: {}, recientes: [], tareas: [] };

function crearPersonajes() {
  for (const a of AGENTES) {
    if (PJ.has(a.id)) { PJ.get(a.id).info = a; continue; }
    const desk = a.tipo === 'recepcion' ? null : DESKS[a.tipo === 'especialista' ? `${a.linea}-especialista` : a.id];
    const home = a.tipo === 'recepcion' ? SEAT_RECEPCION : desk?.seat;
    if (!home) continue;
    const p = { id: a.id, info: a, ap: apariencia(a), home, x: home.x, y: home.y, dir: home.dir, sit: home.sit, path: [], at: home, target: home,
      frame: 0, ft: 0, timer: rnd(2, 25), walking: false, estado: 'ocioso', img: avatarURL(a) };
    PJ.set(a.id, p);
  }
}

function estadoDe(id, ahora) {
  const fuentes = [ACT, DEMO.on ? DEMO : { activos: {}, recientes: [] }];
  for (const f of fuentes) for (const v of Object.values(f.activos)) if (v.agente === id) return { tipo: 'trabajando', desc: v.descripcion, desde: Date.parse(v.inicio) };
  const tareas = todasTareas().filter(t => t.estado === 'en-proceso' && t.agentes.includes(id));
  const recientes = [...ACT.recientes, ...(DEMO.on ? DEMO.recientes : [])].filter(r => r.agente === id).sort((a, b) => Date.parse(b.fin) - Date.parse(a.fin));
  const ult = recientes[0];
  if (ult && (ahora - Date.parse(ult.fin)) / 1000 < 120) return { tipo: 'concluyo', desc: ult.descripcion, dur: ult.duracion_s, tareas };
  if (tareas.length) return { tipo: 'asignado', desc: `${tareas[0].folio} · ${tareas[0].titulo}`, tareas };
  return { tipo: 'ocioso', desc: ult ? ult.descripcion : 'Sin actividad registrada', desde: ult ? Date.parse(ult.fin) : null, tareas };
}
const todasTareas = () => [...TAREAS, ...(DEMO.on ? DEMO.tareas : [])];
const enComite = id => todasTareas().some(t => t.tipo === 'comite' && t.estado === 'en-proceso' && t.agentes.includes(id));

function irA(p, destino) {
  if (p.at === destino && !p.path.length) return;
  if (p.at && p.at.occ === p.id) p.at.occ = null;
  if (destino.occ !== undefined) destino.occ = p.id;
  p.target = destino; p.at = null;
  p.path = ruta({ x: p.x, y: p.y }, destino); p.sit = false; p.walking = true;
}

function actualizar(dt, ahora) {
  const libres = s => s.occ === null;
  let paseando = 0; for (const p of PJ.values()) if (p.at && p.at.tipo === 'idle' || (p.walking && p.target?.tipo === 'idle')) paseando++;
  for (const p of PJ.values()) {
    const e = estadoDe(p.id, ahora); p.estado = e.tipo; p.e = e;
    if (p.info.tipo !== 'recepcion') {
      const ocupado = e.tipo === 'trabajando' || e.tipo === 'asignado';
      const comite = enComite(p.id);
      if (comite) {
        const asiento = MEETING.find(s => s.occ === p.id) || MEETING.find(libres);
        if (asiento && p.target !== asiento) irA(p, asiento);
      } else if (ocupado) {
        if (p.target !== p.home) irA(p, p.home);
      } else if (p.target && p.target.tipo === 'junta') {
        irA(p, p.home);
      } else if (!p.walking) {
        p.timer -= dt;
        if (p.timer <= 0) {
          if (p.at === p.home && paseando < 16 && Math.random() < 0.4) {
            const opciones = Object.values(ROOMS).flatMap(r => r.spots).filter(s => s.tipo === 'idle' && libres(s) && (s.room !== 'recepcion' || Math.random() < .3) && (ROOMS[s.room].kind === 'top' || s.room === p.info.linea));
            if (opciones.length) { irA(p, pick(opciones)); paseando++; }
            p.timer = rnd(8, 18);
          } else if (p.at !== p.home) { irA(p, p.home); p.timer = rnd(12, 40); }
          else p.timer = rnd(6, 20);
        }
      }
    }
    // movimiento
    if (p.path.length) {
      const sig = p.path[0], dx = sig.x - p.x, dy = sig.y - p.y, d = Math.hypot(dx, dy), v = 44 * dt;
      if (d <= v) { p.x = sig.x; p.y = sig.y; p.path.shift(); }
      else { p.x += dx / d * v; p.y += dy / d * v; p.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'); }
      if (!p.path.length) { p.walking = false; p.at = p.target; p.dir = p.target.dir; p.sit = p.target.sit; }
    }
    p.ft += dt; const ritmo = p.walking ? 0.16 : p.estado === 'trabajando' ? 0.12 : 0.5;
    if (p.ft > ritmo) { p.ft = 0; p.frame++; }
  }
}

// ---------------------------------------------------------------- render
const cv = document.getElementById('mapa'), ctx = cv.getContext('2d');
const capa = document.createElement('canvas'); capa.width = MAP_W; capa.height = MAP_H; const cg = capa.getContext('2d');
const cam = { x: MAP_W / 2, y: MAP_H / 2, z: 1, tx: null, ty: null, tz: null };
let dpr = 1, vw = 0, vh = 0, zFit = 1;

function ajustarTam() {
  const r = cv.getBoundingClientRect(); dpr = window.devicePixelRatio || 1; vw = r.width; vh = r.height;
  cv.width = Math.round(vw * dpr); cv.height = Math.round(vh * dpr);
  zFit = Math.min(vw / MAP_W, (vh - 50) / MAP_H) * 0.98;
}
function encuadrar() { cam.tx = MAP_W / 2; cam.ty = MAP_H / 2 + 12; cam.tz = zFit; }
const aPantalla = (x, y) => ({ x: (x - cam.x) * cam.z + vw / 2, y: (y - cam.y) * cam.z + vh / 2 });
const aMapa = (sx, sy) => ({ x: (sx - vw / 2) / cam.z + cam.x, y: (sy - vh / 2) / cam.z + cam.y });

function etiqueta(x, y, texto, { fondo = 'rgba(5,27,59,.92)', color = '#fff', punto = null, tam = 11, borde = null } = {}) {
  ctx.font = `600 ${tam}px Inter, system-ui, sans-serif`;
  const w = ctx.measureText(texto).width + (punto ? 18 : 12), h = tam + 9;
  const bx = Math.round(x - w / 2), by = Math.round(y - h);
  ctx.fillStyle = fondo; ctx.beginPath(); ctx.roundRect(bx, by, w, h, 6); ctx.fill();
  if (borde) { ctx.strokeStyle = borde; ctx.lineWidth = 1; ctx.stroke(); }
  if (punto) { ctx.fillStyle = punto; ctx.beginPath(); ctx.arc(bx + 9, by + h / 2, 3, 0, 7); ctx.fill(); }
  ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.fillText(texto, bx + (punto ? 15 : 6), by + h / 2 + .5);
  return { bx, by, w, h };
}

function render(t) {
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#3f8a3a'; ctx.fillRect(0, 0, cv.width, cv.height);
  // capa dinámica a 1x
  cg.clearRect(0, 0, MAP_W, MAP_H);
  for (const [id, d] of Object.entries(DESKS)) {
    const r = ROOMS[d.room], x = (r.x0 + d.lx) * T + 1.4 * T, y = (r.y0 + d.ly) * T;
    const ocupante = [...PJ.values()].find(p => p.home === d.seat && p.at === p.home);
    const activo = ocupante && ocupante.estado === 'trabajando';
    cg.fillStyle = activo ? (Math.floor(t * 6 + hash(id)) % 7 ? '#3083F4' : '#60a5fa') : ocupante ? '#1e3a5f' : '#111827';
    cg.fillRect(Math.round(x - 6), y - 5, 12, 7);
    if (activo) { cg.fillStyle = '#E7F0FE'; for (let i = 0; i < 3; i++) cg.fillRect(Math.round(x - 5), y - 4 + i * 2, 2 + (hash(id + i + Math.floor(t * 4)) % 9), 1); }
  }
  const rec = PJ.get('recepcion');
  if (rec) { const [mx, my] = [(R.recepcion.x0 + CORR) * T, (R.recepcion.y0 + 4.3) * T]; cg.fillStyle = rec.estado === 'trabajando' ? '#3083F4' : '#1e3a5f'; cg.fillRect(mx - 13, my - 5, 10, 5); }
  const orden = [...PJ.values()].sort((a, b) => a.y - b.y);
  for (const p of orden) dibujarPersonaje(cg, p.x, p.y, p.ap, { dir: p.dir, sit: p.sit && !p.walking, walking: p.walking, typing: p.estado === 'trabajando' && p.sit, frame: p.frame, t, id: p.id });
  for (const p of orden) if (p === seleccion || p === hover) { cg.strokeStyle = p === seleccion ? '#fde047' : '#ffffff'; cg.lineWidth = 1; cg.beginPath(); cg.ellipse(Math.round(p.x), Math.round(p.y) - 0.5, 7, 3, 0, 0, 7); cg.stroke(); }

  ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * (vw / 2 - cam.x * cam.z), dpr * (vh / 2 - cam.y * cam.z));
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bg, 0, 0); ctx.drawImage(capa, 0, 0);

  // superposiciones nítidas
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ts = Math.max(9, Math.min(13, 11 * cam.z / zFit * 0.75));
  for (const r of Object.values(ROOMS)) { const s = aPantalla((r.x0 + W / 2) * T, r.y0 * T - 3); etiqueta(s.x, s.y + 6, r.nombre, { tam: ts, fondo: 'rgba(5,27,59,.9)', borde: r.acento || '#16365f' }); }
  const ahora = Date.now();
  for (const p of orden) {
    const s = aPantalla(p.x, p.y - (p.sit ? 18 : 20));
    if (p.estado === 'trabajando') {
      const pts = '.'.repeat(1 + Math.floor(t * 2.5) % 3);
      etiqueta(s.x, s.y - 2, `${corto(p.e.desc, 24)} ${pts}`, { punto: '#3083F4', tam: ts, borde: '#3083F4' });
    } else if (p.estado === 'concluyo') {
      etiqueta(s.x, s.y - 2, `✓ Concluyó en ${dur(p.e.dur)}`, { fondo: 'rgba(21,128,61,.95)', tam: ts });
    } else if (p === hover || p === seleccion) {
      etiqueta(s.x, s.y - 2, nombreCorto(p.info), { punto: p.estado === 'asignado' ? '#f59e0b' : '#9DB0CC', tam: ts });
    } else if (p.estado === 'asignado' && cam.z > zFit * 1.4) {
      etiqueta(s.x, s.y - 2, '📋', { tam: ts, fondo: 'rgba(245,158,11,.9)' });
    }
  }
}
const nombreCorto = a => a.tipo === 'recepcion' ? 'Recepción (Claude)' : a.tipo === 'especialista' ? `Especialista · ${LINEAS[a.linea].nombre}` : `${a.rol} · ${LINEAS[a.linea].nombre.split(' · ')[0]}`;

// ---------------------------------------------------------------- cámara e interacción
let arrastre = null;
cv.addEventListener('mousedown', e => { arrastre = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, movio: false }; });
window.addEventListener('mouseup', e => {
  cv.classList.remove('arrastrando');
  if (arrastre && !arrastre.movio) { const p = personajeEn(e); seleccionar(p ? p.id : null, false); }
  arrastre = null;
});
window.addEventListener('mousemove', e => {
  if (arrastre) {
    const dx = e.clientX - arrastre.x, dy = e.clientY - arrastre.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) { arrastre.movio = true; cv.classList.add('arrastrando'); cam.tx = cam.ty = cam.tz = null; }
    if (arrastre.movio) { cam.x = arrastre.cx - dx / cam.z; cam.y = arrastre.cy - dy / cam.z; }
  } else if (e.target === cv) { hover = personajeEn(e); cv.style.cursor = hover ? 'pointer' : 'grab'; }
});
cv.addEventListener('wheel', e => {
  e.preventDefault(); cam.tx = cam.ty = cam.tz = null;
  const r = cv.getBoundingClientRect(), m = aMapa(e.clientX - r.left, e.clientY - r.top);
  cam.z = Math.max(zFit * 0.8, Math.min(5, cam.z * Math.exp(-e.deltaY * 0.0015)));
  const m2 = aMapa(e.clientX - r.left, e.clientY - r.top); cam.x += m.x - m2.x; cam.y += m.y - m2.y;
}, { passive: false });
function personajeEn(e) {
  const r = cv.getBoundingClientRect(), m = aMapa(e.clientX - r.left, e.clientY - r.top);
  let mejor = null;
  for (const p of PJ.values()) if (m.x > p.x - 6 && m.x < p.x + 6 && m.y > p.y - 20 && m.y < p.y + 2) if (!mejor || p.y > mejor.y) mejor = p;
  return mejor;
}
document.getElementById('zMas').onclick = () => { cam.tz = Math.min(5, (cam.tz ?? cam.z) * 1.35); cam.tx = cam.tx ?? cam.x; cam.ty = cam.ty ?? cam.y; };
document.getElementById('zMenos').onclick = () => { cam.tz = Math.max(zFit * 0.8, (cam.tz ?? cam.z) / 1.35); cam.tx = cam.tx ?? cam.x; cam.ty = cam.ty ?? cam.y; };
document.getElementById('zAjustar').onclick = encuadrar;

function seleccionar(id, centrar = true) {
  seleccion = id ? PJ.get(id) : null;
  if (seleccion && centrar) { cam.tx = seleccion.x; cam.ty = seleccion.y - 10; cam.tz = Math.max(cam.z, zFit * 2.4); }
  pintarLista(); pintarFicha();
}

// ---------------------------------------------------------------- panel lateral
const lista = document.getElementById('lista');
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { tab = b.dataset.tab; document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b)); pintarLista(); });
document.getElementById('buscar').oninput = e => { filtro = e.target.value.trim().toLowerCase(); pintarLista(); };
const cerrados = new Set();

function textoEstado(p, ahora) {
  const e = p.e || { tipo: 'ocioso' };
  if (e.tipo === 'trabajando') return `<span class="badge b-trab">Trabajando · ${dur((ahora - e.desde) / 1000)}</span>`;
  if (e.tipo === 'concluyo') return `<span class="badge b-ok">Concluyó en ${dur(e.dur)}</span>`;
  if (e.tipo === 'asignado') return `<span class="badge b-asig">En proceso</span>`;
  return `<span class="badge b-ocio">${e.desde ? 'Ocioso ' + hace((ahora - e.desde) / 1000) : 'Ocioso'}</span>`;
}

function pintarLista() {
  const ahora = Date.now();
  if (tab === 'equipo') {
    const grupos = [['oficina', 'Recepción', '#3083F4'], ...Object.entries(LINEAS).map(([k, l]) => [k, l.nombre, l.acento])];
    let html = '';
    const ses = SESIONES.filter(s => !filtro || `${s.proyecto} ${s.usuario} ${s.prompt}`.toLowerCase().includes(filtro));
    if (ses.length) {
      const rec = PJ.get('recepcion');
      html += `<section class="grupo ${cerrados.has('sesiones') && !filtro ? 'cerrado' : ''}" data-g="sesiones"><header><span class="dot" style="background:#22C55E"></span><b>Sesiones de Claude Code</b><span class="cnt">${ses.filter(s => s.estado === 'trabajando').length} activas · ${ses.length}</span></header><div class="filas">`;
      for (const s of ses) {
        const seg = (ahora - Date.parse(s.ultimo_evento)) / 1000;
        const est = s.estado === 'trabajando' ? `<span class="badge b-trab">Trabajando · ${dur((ahora - Date.parse(s.inicio_turno || s.ultimo_evento)) / 1000)}</span>`
          : s.ultima_duracion_s != null && seg < 120 ? `<span class="badge b-ok">Concluyó en ${dur(s.ultima_duracion_s)}</span>` : `<span class="badge b-ocio">Ociosa ${hace(seg)}</span>`;
        html += `<div class="fila" data-id="recepcion"><img src="${rec ? rec.img : ''}" alt=""><div class="info"><div class="top"><span class="nom">${esc(s.proyecto || 'Sesión')}</span><span class="est">${est}</span></div><div class="desc">${esc((s.usuario || '').split('@')[0])}${s.maquina ? ' · ' + esc(s.maquina) : ''}${s.prompt ? ' — ' + esc(s.prompt) : ''}</div></div></div>`;
      }
      html += '</div></section>';
    }
    for (const [k, nombre, color] of grupos) {
      const miembros = [...PJ.values()].filter(p => p.info.linea === k && (!filtro || `${nombreCorto(p.info)} ${p.id} ${p.e?.desc || ''}`.toLowerCase().includes(filtro)));
      if (!miembros.length) continue;
      const orden = { trabajando: 0, concluyo: 1, asignado: 2, ocioso: 3 };
      miembros.sort((a, b) => (orden[a.estado] - orden[b.estado]) || (a.info.tipo === 'especialista' ? -1 : 0));
      const trab = miembros.filter(p => p.estado === 'trabajando').length;
      html += `<section class="grupo ${cerrados.has(k) && !filtro ? 'cerrado' : ''}" data-g="${k}"><header><span class="dot" style="background:${color}"></span><b>${esc(nombre)}</b><span class="cnt">${trab ? trab + ' trabajando · ' : ''}${miembros.length}</span></header><div class="filas">`;
      for (const p of miembros) html += `<div class="fila ${seleccion === p ? 'sel' : ''}" data-id="${p.id}"><img src="${p.img}" alt=""><div class="info"><div class="top"><span class="nom">${esc(p.info.tipo === 'recepcion' ? 'Recepción (Claude)' : p.info.tipo === 'especialista' ? 'Especialista de línea' : p.info.rol)}</span><span class="est">${textoEstado(p, ahora)}</span></div><div class="desc">${p.estado === 'trabajando' ? '<span class="pulso" style="display:inline-block;margin-right:5px"></span>' : ''}${esc(p.e?.desc || '')}</div></div></div>`;
      html += '</div></section>';
    }
    lista.innerHTML = html || '<div class="vacio">Sin resultados.</div>';
  } else if (tab === 'conexiones') {
    pintarConexiones();
  } else if (tab === 'tareas') {
    const ts = todasTareas().filter(t => !filtro || `${t.folio} ${t.titulo} ${t.agentes.join(' ')}`.toLowerCase().includes(filtro))
      .sort((a, b) => ['en-proceso', 'en-revision', 'pendiente', 'entregada', 'cancelada'].indexOf(a.estado) - ['en-proceso', 'en-revision', 'pendiente', 'entregada', 'cancelada'].indexOf(b.estado) || b.folio.localeCompare(a.folio));
    const cls = { 'en-proceso': 'b-asig', 'en-revision': 'b-rev', pendiente: 'b-pend', entregada: 'b-ok', cancelada: 'b-ocio' };
    lista.innerHTML = ts.length ? ts.map(t => `<div class="tarea"><div class="t1"><span class="folio">${esc(t.folio)}</span>${t.tipo === 'comite' ? '<span class="badge b-rev">Comité</span>' : ''}<span class="badge ${cls[t.estado] || 'b-pend'}" style="margin-left:auto">${esc(t.estado)}</span></div><div class="tit">${esc(t.titulo)}</div><div class="chips">${t.agentes.map(a => `<span class="chip" data-id="${esc(a)}">${esc(PJ.get(a) ? nombreCorto(PJ.get(a).info) : a)}</span>`).join('')}</div>${t.entregable ? `<div class="ruta" style="margin-top:6px;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#9EC5F5">${esc(t.entregable)}</div>` : ''}</div>`).join('')
      : '<div class="vacio">Aún no hay tareas registradas.<br>Pídele algo al equipo en Claude Code y Recepción la registrará con <code>oficina.py nueva</code>.</div>';
  } else {
    const rs = [...ACT.recientes, ...(DEMO.on ? DEMO.recientes : [])].sort((a, b) => Date.parse(b.fin) - Date.parse(a.fin)).slice(0, 60);
    lista.innerHTML = rs.length ? rs.map(r => { const p = PJ.get(r.agente); return `<div class="act"><span class="hora">${new Date(r.fin).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}</span><div><b>${esc(p ? nombreCorto(p.info) : r.agente)}</b><div style="color:var(--texto2)">${esc(r.descripcion)} · ${dur(r.duracion_s)}</div></div></div>`; }).join('')
      : '<div class="vacio">Sin actividad todavía. Cuando Claude Code delegue a un agente, aparecerá aquí.</div>';
  }
}
lista.addEventListener('click', e => {
  const h = e.target.closest('.grupo>header'); if (h) { const g = h.parentElement.dataset.g; cerrados.has(g) ? cerrados.delete(g) : cerrados.add(g); pintarLista(); return; }
  const f = e.target.closest('[data-id]'); if (f && PJ.has(f.dataset.id)) seleccionar(f.dataset.id);
});

const ficha = document.getElementById('ficha');
function pintarFicha() {
  if (!seleccion) { ficha.classList.remove('on'); return; }
  const p = seleccion, a = p.info, ahora = Date.now(), e = p.e || {};
  const tareas = todasTareas().filter(t => t.agentes.includes(p.id) && !['entregada', 'cancelada'].includes(t.estado));
  ficha.innerHTML = `<button class="cerrar" aria-label="Cerrar">×</button><h3>${esc(nombreCorto(a))}</h3><div class="sub">${a.tipo === 'recepcion' ? 'Sesión principal de Claude Code' : `Agente <code>${esc(a.id)}</code>`}</div>
    <div class="renglon"><span>Estado</span>${textoEstado(p, ahora)}</div>
    <div class="renglon"><span>Última</span><div>${esc(e.desc || '—')}</div></div>
    <div class="renglon"><span>Tareas</span><div>${tareas.length ? tareas.map(t => `${esc(t.folio)} · ${esc(t.titulo)}`).join('<br>') : 'Ninguna abierta'}</div></div>
    ${a.tipo !== 'recepcion' ? `<div class="renglon"><span>Escritorio</span><div class="ruta">10_oficina/escritorios/${esc(a.id)}/</div></div>` : ''}`;
  ficha.classList.add('on');
  ficha.querySelector('.cerrar').onclick = () => seleccionar(null);
}

// ---------------------------------------------------------------- datos
async function leer(url) { const r = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) throw new Error(url); return r.json(); }
// Modo "remoto" (servidor en Render + Supabase) o "local" (archivos JSON servidos por python http.server).
let MODO = 'local', CONFIG = null, SESIONES = [], YO = null;
async function detectarModo() {
  try { const r = await fetch('/api/config', { cache: 'no-store' }); if (r.ok) { CONFIG = await r.json(); if (CONFIG.modo === 'remoto') MODO = 'remoto'; } } catch { /* local */ }
}
async function sondear() {
  try {
    if (MODO === 'remoto') {
      const r = await fetch('/api/estado', { cache: 'no-store', credentials: 'same-origin' });
      if (r.status === 401) { conectado = false; mostrarLogin(); document.getElementById('vivo').classList.add('off'); return; }
      if (!r.ok) throw new Error('estado ' + r.status);
      const d = await r.json(); ocultarLogin();
      if (d.agentes.length) AGENTES = d.agentes;
      TAREAS = d.tareas || []; SESIONES = d.sesiones || []; YO = d.usuario;
      ACT = { activos: { ...d.actividad.activos }, recientes: d.actividad.recientes || [] };
      for (const s of SESIONES) if (s.estado === 'trabajando' && Date.now() - Date.parse(s.ultimo_evento) < 3 * 3600e3)
        ACT.activos['s' + s.sesion] = { agente: 'recepcion', descripcion: `${s.proyecto || 'Sesión'} · ${s.prompt || 'Atendiendo petición'}`, inicio: s.inicio_turno || s.ultimo_evento };
      document.getElementById('tabConexiones').style.display = YO?.admin ? '' : 'none';
      const salir = document.getElementById('salir'); salir.style.display = CONFIG?.dev ? 'none' : ''; salir.title = YO?.email || '';
    } else {
      const [ag, ta, ac] = await Promise.all([leer('../agentes.json'), leer('../tareas.json').catch(() => ({ tareas: [] })), leer('../estado/actividad.json').catch(() => ({ activos: {}, recientes: [] }))]);
      AGENTES = ag.agentes; TAREAS = ta.tareas || []; ACT = { activos: ac.activos || {}, recientes: ac.recientes || [] };
    }
    conectado = true; crearPersonajes();
  } catch { conectado = false; }
  document.getElementById('vivo').classList.toggle('off', !conectado);
}

// ---------------------------------------------------------------- login (modo remoto)
const login = document.getElementById('login');
let gisCargado = false;
function mostrarLogin() {
  if (login.classList.contains('on')) return;
  login.classList.add('on');
  const msg = document.getElementById('loginMsg');
  if (!CONFIG?.googleClientId) { msg.textContent = 'El servidor no tiene configurado el inicio de sesión con Google.'; return; }
  const iniciar = () => {
    google.accounts.id.initialize({ client_id: CONFIG.googleClientId, hd: CONFIG.dominio || undefined, callback: async ({ credential }) => {
      const r = await fetch('/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { ocultarLogin(); sondear(); } else msg.textContent = d.mensaje || 'No fue posible iniciar sesión.';
    } });
    google.accounts.id.renderButton(document.getElementById('gBoton'), { theme: 'filled_blue', size: 'large', text: 'signin_with', locale: 'es' });
  };
  if (gisCargado) return iniciar();
  const sc = document.createElement('script'); sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
  sc.onload = () => { gisCargado = true; iniciar(); }; document.head.appendChild(sc);
}
function ocultarLogin() { login.classList.remove('on'); }
document.getElementById('salir').onclick = async () => { await fetch('/api/auth/salir', { method: 'POST' }); location.reload(); };

// ---------------------------------------------------------------- conexiones (tokens de dispositivo, solo admins)
async function pintarConexiones() {
  const r = await fetch('/api/tokens', { cache: 'no-store' }); if (!r.ok) { lista.innerHTML = '<div class="vacio">Solo administradores.</div>'; return; }
  const { tokens } = await r.json();
  lista.innerHTML = `<div class="tarea"><b>Conectar una computadora</b><div class="desc" style="color:var(--texto2);margin:6px 0 8px">Genera un token por computadora y guárdalo en <code>~/.config/oficina-polipay/config.json</code> de esa Mac (ver README del repo).</div>
    <input id="tkCorreo" class="campo" placeholder="correo@polipay.io" value="${esc(YO?.email || '')}"><input id="tkEtiq" class="campo" placeholder="Etiqueta, p. ej. MacBook Alfonso"><button class="btn on" id="tkGenerar" style="width:100%">Generar token</button><div id="tkNuevo"></div></div>
    ${tokens.map(t => `<div class="tarea"><div class="t1"><b>${esc(t.etiqueta)}</b><span class="badge ${t.revocado ? 'b-ocio' : 'b-ok'}" style="margin-left:auto">${t.revocado ? 'revocado' : 'activo'}</span></div><div style="color:var(--texto2);font-size:12px;margin:4px 0">${esc(t.usuario)} · ${t.ultimo_uso ? 'último uso ' + hace((Date.now() - Date.parse(t.ultimo_uso)) / 1000) : 'sin uso'}</div>${t.revocado ? '' : `<button class="btn" data-revocar="${t.id}">Revocar</button>`}</div>`).join('')}`;
  document.getElementById('tkGenerar').onclick = async () => {
    const r2 = await fetch('/api/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: document.getElementById('tkCorreo').value, etiqueta: document.getElementById('tkEtiq').value }) });
    const d = await r2.json();
    document.getElementById('tkNuevo').innerHTML = r2.ok ? `<div class="token-nuevo"><code>${esc(d.token)}</code><div>${esc(d.aviso)}</div></div>` : `<div class="vacio">${esc(d.mensaje || 'Error')}</div>`;
  };
  lista.querySelectorAll('[data-revocar]').forEach(b => b.onclick = async () => { if (!confirm('¿Revocar este token? Esa computadora dejará de reportar.')) return; await fetch('/api/tokens/' + b.dataset.revocar, { method: 'DELETE' }); pintarConexiones(); });
}

// ---------------------------------------------------------------- modo demo
const TRABAJOS = {
  emisor: ['Cálculo de comisión de fondeo', 'Revisión de depósitos por autorizar', 'BRD dispersión automática PA-07', 'Conciliación TAPI', 'Inventario de plásticos My Card', 'Límites operativos BSO-CARDS-POL'],
  agregador: ['Compensación diaria POL-OP-M01', 'Conciliación Broxel AMEX', 'Perfil TPV_Propina_restaurante', 'Análisis corte AMEX 20:00 h', 'Migración comercios NOVEK', 'Tasas Empresa → UN → Comercio'],
  banca: ['Auto-generación de UDN', 'Revisión API ASP Integra', 'Handoff POL-BAN-MO-001', 'Plan Grupo DEAL', 'Conciliación SPEI del día'],
  credito: ['Cotizador CAT vía TIR', 'Tabla de amortización francesa', 'Contrato RECA dos columnas', 'Reserva NIF D-1 / B-6', 'Registro en herramienta de cartera'],
};
function tickDemo() {
  if (!DEMO.on) return;
  const ahora = Date.now(), iso = ms => new Date(ms).toISOString();
  for (const [k, v] of Object.entries(DEMO.activos)) if (ahora > v.finMs) {
    DEMO.recientes.unshift({ agente: v.agente, descripcion: v.descripcion, inicio: v.inicio, fin: iso(ahora), duracion_s: (ahora - Date.parse(v.inicio)) / 1000 });
    delete DEMO.activos[k];
  }
  DEMO.recientes.length = Math.min(DEMO.recientes.length, 40);
  const ids = AGENTES.filter(a => a.tipo !== 'recepcion').map(a => a.id);
  if (Object.keys(DEMO.activos).length < 7 && ids.length && Math.random() < 0.6) {
    const id = pick(ids), a = AGENTES.find(x => x.id === id);
    if (!Object.values(DEMO.activos).some(v => v.agente === id)) {
      DEMO.activos['d' + ahora] = { agente: id, descripcion: pick(TRABAJOS[a.linea]), inicio: iso(ahora), finMs: ahora + rnd(9000, 30000) };
      DEMO.activos.rec = DEMO.activos.rec || { agente: 'recepcion', descripcion: 'Repartiendo tareas al equipo', inicio: iso(ahora), finMs: ahora + 5000 };
    }
  }
  const comite = DEMO.tareas.find(t => t.tipo === 'comite');
  if (!comite && Math.random() < 0.08) {
    const l = pick(Object.keys(LINEAS));
    DEMO.tareas.push({ folio: 'DEMO-1', titulo: `Comité de riesgos · ${LINEAS[l].nombre}`, tipo: 'comite', estado: 'en-proceso', agentes: [`${l}-cro-riesgos`, `${l}-cco`, `${l}-cfo`, `${l}-coo`], fin: ahora + 35000 });
  } else if (comite && ahora > comite.fin) DEMO.tareas.length = 0;
}
document.getElementById('demo').classList.toggle('on', DEMO.on);
document.getElementById('demo').onclick = () => {
  DEMO.on = !DEMO.on; DEMO.activos = {}; DEMO.recientes = []; DEMO.tareas = [];
  document.getElementById('demo').classList.toggle('on', DEMO.on);
  const u = new URL(location); DEMO.on ? u.searchParams.set('demo', '') : u.searchParams.delete('demo'); history.replaceState(null, '', u);
};

// ---------------------------------------------------------------- arranque
function contadores() {
  const ps = [...PJ.values()], hoy = new Date().toDateString();
  document.getElementById('nTrab').textContent = ps.filter(p => p.estado === 'trabajando').length;
  document.getElementById('nTareas').textContent = todasTareas().filter(t => !['entregada', 'cancelada'].includes(t.estado)).length;
  document.getElementById('nHoy').textContent = [...ACT.recientes, ...(DEMO.on ? DEMO.recientes : [])].filter(r => new Date(r.fin).toDateString() === hoy).length;
  document.getElementById('reloj').textContent = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

pintarFondo();
ajustarTam(); cam.z = zFit; encuadrar(); cam.x = cam.tx; cam.y = cam.ty;
window.addEventListener('resize', () => { const ajustado = Math.abs(cam.z - zFit) < 1e-3; ajustarTam(); if (ajustado) encuadrar(); });

let ultimo = performance.now();
function bucle(ms) {
  const dt = Math.min(0.1, (ms - ultimo) / 1000); ultimo = ms;
  if (cam.tz != null) { const k = 1 - Math.pow(0.001, dt); cam.x += (cam.tx - cam.x) * k; cam.y += (cam.ty - cam.y) * k; cam.z += (cam.tz - cam.z) * k; if (Math.abs(cam.tz - cam.z) < 1e-3 && Math.hypot(cam.tx - cam.x, cam.ty - cam.y) < .3) cam.tx = cam.ty = cam.tz = null; }
  actualizar(dt, Date.now()); render(ms / 1000);
  requestAnimationFrame(bucle);
}
(async () => {
  await detectarModo(); await sondear(); actualizar(0, Date.now()); pintarLista(); contadores(); requestAnimationFrame(bucle);
  setInterval(async () => { await sondear(); tickDemo(); }, 2000);
  setInterval(() => { tickDemo(); contadores(); if (tab !== 'conexiones' && (!lista.matches(':hover') || tab !== 'equipo')) pintarLista(); if (seleccion) pintarFicha(); }, 1000);
})();
})();
