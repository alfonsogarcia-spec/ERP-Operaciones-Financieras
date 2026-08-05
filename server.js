/* Polipay · Conciliación y Liquidación T+1 — servidor mínimo (modo dual)
 * Sirve el SPA (index.html) + /public y expone /api/estado.
 * En este MVP el estado vive en localStorage del navegador (db:false).
 * El endpoint /api/estado deja el hueco para Supabase en una fase posterior
 * (mismo patrón que polipay-gestion-operaciones: db:true => modo API).
 */
'use strict';
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 4174;

app.use(express.json({ limit: '30mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));

function estadoServicio() {
  return {
    ok: true,
    service: 'conciliacion-liquidacion',
    db: false,      // MVP sandbox: sin base; el frontend usa localStorage
    mail: false,
    ts: new Date().toISOString(),
  };
}
// Nombre neutral (evita filtros de ad-block sobre "healthz") + healthz para checks
app.get('/api/estado', (_req, res) => res.json(estadoServicio()));
app.get('/healthz', (_req, res) => res.json(estadoServicio()));

// SPA catch-all: cualquier ruta no-API devuelve index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Conciliación y Liquidación T+1 en http://localhost:${PORT}`);
});
