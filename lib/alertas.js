/* ============================================================================
   lib/alertas.js — Reglas de alertas de seguridad (Fase 3.2).

   Después de cada bit(), server.js llama alertas.evaluar(fila) con la fila
   recién insertada. Cada regla decide si el evento (por sí solo o combinado
   con recientes) amerita un correo a los admins.

   Deduplicación por (regla_id, clave) dentro de la ventana de la regla:
   - login_fail_ip:  ventana 10 min, clave = ip
   - login_fail_bulk: ventana 60 min, clave = 'global'
   - usuario_admin_cambio: ventana 5 min, clave = resource_id
   - corte_baja_final: ventana 0, clave = resource_id (siempre)
   - clabe_modify: ventana 5 min, clave = resource_id

   Es best-effort: si SES falla o la BD no responde, se ignora silencioso.
   Puede desactivarse globalmente con env ALERTAS_HABILITADAS=false.
   ========================================================================= */
'use strict';

const ALERTAS_HABILITADAS = String(process.env.ALERTAS_HABILITADAS || 'true').toLowerCase() !== 'false';

// Registro de reglas. Cada una: { id, match(fila), umbral(db,fila,now), sujeto/cuerpo, ventana_min, clave(fila) }
const REGLAS = [
  {
    id: 'login_fail_ip',
    titulo: 'Intentos de inicio de sesión repetidos desde una IP',
    match: (f) => f.accion === 'login_fail',
    ventana_min: 10,
    clave: (f) => f.ip || 'sin-ip',
    // ≥5 fallos desde la misma IP en los últimos 10 minutos
    umbral: async (db, f) => {
      if (!f.ip) return null;
      const r = await db.query("select count(*)::int as n from bitacora where accion='login_fail' and ip=$1 and ts > now() - interval '10 minutes'", [f.ip]);
      return r.rows[0].n >= 5 ? { n: r.rows[0].n } : null;
    },
    detalles: (f, ctx) => ({
      motivo: `Se detectaron ${ctx.n} intentos fallidos de inicio de sesión desde la misma IP en los últimos 10 minutos.`,
      campos: [
        ['IP origen', f.ip],
        ['Último detalle', f.detalle || '—'],
        ['Total en 10 min', ctx.n],
      ],
      sugerencia: 'Revisa la bitácora filtrando por esa IP. Si es tráfico legítimo (usuario que olvidó su contraseña), ignora. Si es sospechoso, considera bloquear la IP a nivel red o Cloudflare/WAF.',
    }),
  },
  {
    id: 'login_fail_bulk',
    titulo: 'Volumen anómalo de rechazos de inicio de sesión',
    match: (f) => f.accion === 'login_fail',
    ventana_min: 60,
    clave: () => 'global',
    // ≥10 rechazos de whitelist/dominio en la última hora (posible enumeración)
    umbral: async (db, _f) => {
      const r = await db.query("select count(*)::int as n from bitacora where accion='login_fail' and (detalle like 'no_autorizado%' or detalle like 'dominio_no_permitido%') and ts > now() - interval '60 minutes'");
      return r.rows[0].n >= 10 ? { n: r.rows[0].n } : null;
    },
    detalles: (_f, ctx) => ({
      motivo: `${ctx.n} rechazos de cuentas no autorizadas / dominio incorrecto en la última hora.`,
      campos: [['Rechazos en 60 min', ctx.n]],
      sugerencia: 'Puede ser una enumeración de correos (alguien probando qué cuentas tienen acceso). Revisa la bitácora filtrando accion=login_fail. Si el patrón continúa, considera reducir el rate limit de /api/login/google.',
    }),
  },
  {
    id: 'usuario_sensible_cambio',
    titulo: 'Cambio en usuario con rol sensible (admin o bancos)',
    // Alta, edición o baja de fila cuyo detalle indique rol=admin o rol=bancos (segregación de funciones).
    match: (f) => ['usuario_alta', 'usuario_editar', 'usuario_baja'].includes(f.accion) && /rol=(admin|bancos)/.test(f.detalle || ''),
    ventana_min: 5,
    clave: (f) => f.resource_id || 'sin-id',
    umbral: async (_db, _f) => ({ n: 1 }),
    detalles: (f) => ({
      motivo: `Un administrador realizó un cambio en un usuario con rol admin o bancos (roles que pueden mover dinero o gestionar el sistema).`,
      campos: [
        ['Acción', f.accion],
        ['Usuario administrador', f.usuario],
        ['Usuario afectado', f.detalle || '—'],
        ['ID afectado', f.resource_id || '—'],
        ['IP', f.ip || '—'],
      ],
      sugerencia: 'Cambios en roles admin o bancos son de máxima sensibilidad (dispersión de fondos o control del sistema). Confirma con el usuario administrador que realizó la acción que fue intencional.',
    }),
  },
  {
    id: 'corte_baja_final',
    titulo: 'Corte Dispersado/Cerrado marcado como obsoleto',
    // Baja de corte cuyo detalle indique estado Dispersado o Cerrado
    match: (f) => f.accion === 'corte_baja' && /Dispersado|Cerrado/.test(f.detalle || ''),
    ventana_min: 0,
    clave: (f) => f.resource_id || 'sin-id',
    umbral: async () => ({ n: 1 }),
    detalles: (f) => ({
      motivo: `Se marcó como borrado un corte que ya estaba en estado final (Dispersado o Cerrado).`,
      campos: [
        ['Usuario', f.usuario],
        ['Corte ID', f.resource_id || '—'],
        ['Estado previo', (f.detalle || '').replace('estado ', '')],
        ['IP', f.ip || '—'],
      ],
      sugerencia: 'Los cortes ya dispersados o cerrados son inmutables en el negocio. Si se borró por error, restaura desde backup. Si fue intencional, documenta la causa.',
    }),
  },
  {
    id: 'clabe_modify',
    titulo: 'Modificación en CLABE de cuenta de liquidación',
    match: (f) => ['cuenta_alta', 'cuenta_editar'].includes(f.accion),
    ventana_min: 5,
    clave: (f) => f.resource_id || 'sin-id',
    umbral: async () => ({ n: 1 }),
    detalles: (f) => ({
      motivo: `Se dio de alta o modificó una CLABE en el catálogo de cuentas de liquidación.`,
      campos: [
        ['Acción', f.accion],
        ['Usuario', f.usuario],
        ['Cuenta ID', f.resource_id || '—'],
        ['Detalle', f.detalle || '—'],
        ['IP', f.ip || '—'],
      ],
      sugerencia: 'Un cambio de CLABE es un evento de riesgo (redirige dispersiones). Confirma con tesorería que el destino de dispersión es el correcto antes del próximo corte.',
    }),
  },
];

// Verifica si ya se emitió una alerta con (regla_id, clave) dentro de la ventana.
async function deduplicada(db, reglaId, clave, ventanaMin) {
  if (!ventanaMin) return false;
  const r = await db.query(
    "select 1 from alertas_dedup where regla_id=$1 and clave=$2 and emitida_at > now() - ($3 || ' minutes')::interval limit 1",
    [reglaId, clave, String(ventanaMin)]
  );
  return r.rows.length > 0;
}
async function marcarEmitida(db, reglaId, clave) {
  await db.query('insert into alertas_dedup(regla_id, clave) values($1, $2)', [reglaId, clave]);
}

// Evalúa reglas contra la fila de bitácora recién insertada.
// server.js: llama alertas.evaluar({ db, C, armarAlertaHTML, sendSES, adminEmails }, fila)
async function evaluar(dep, fila) {
  if (!ALERTAS_HABILITADAS) return { emitidas: [] };
  const emitidas = [];
  for (const r of REGLAS) {
    try {
      if (!r.match(fila)) continue;
      const clave = r.clave(fila);
      if (await deduplicada(dep.db, r.id, clave, r.ventana_min)) continue;
      const ctx = await r.umbral(dep.db, fila);
      if (!ctx) continue;
      // Emitir
      const det = r.detalles(fila, ctx);
      await marcarEmitida(dep.db, r.id, clave);
      const to = await dep.adminEmails();
      if (!to.length) { emitidas.push({ regla: r.id, ok: false, motivo: 'sin_admins' }); continue; }
      const { subject, html, textFallback } = dep.armarAlertaHTML({
        regla_titulo: r.titulo,
        motivo: det.motivo,
        campos: det.campos,
        sugerencia: det.sugerencia,
        cuando: fila.ts || new Date().toISOString(),
      }, dep.logoSrc || 'cid:polipay-logo');
      const messageId = await dep.sendSES({ to, subject, html, textFallback, inlineImages: dep.inlineImages });
      emitidas.push({ regla: r.id, ok: true, messageId });
    } catch (e) {
      emitidas.push({ regla: r.id, ok: false, motivo: 'error', error: e.message });
    }
  }
  return { emitidas };
}

module.exports = { REGLAS, evaluar, ALERTAS_HABILITADAS };
