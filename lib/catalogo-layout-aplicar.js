/* ============================================================================
   lib/catalogo-layout-aplicar.js — Simula y APLICA el layout de grupos y afiliaciones contra la base de datos.
   Las reglas de validación/comparación viven en lib/catalogo-layout.js (puras); aquí solo se lee el estado, se escribe y se arma la bitácora.

   Garantías al aplicar:
     · TODO EN UNA TRANSACCIÓN: o se guarda el archivo completo o no se guarda nada.
     · Candado exclusivo (advisory lock) durante la aplicación: dos administradores no aplican layouts a la vez.
     · Dentro del candado se VUELVE A LEER el catálogo y se replanifica; si lo que se va a escribir ya no coincide con lo que se simuló
       (huella: archivo + cada fila con sus valores finales + renombres + grupos nuevos), no se escribe y se pide volver a simular.
     · Solo se escriben las columnas que cambian (un cambio de otro administrador en una columna que el archivo no toca no se pisa).
     · Los datos propios de la afiliación (razón social, MCC, costos) se fusionan de TODAS las filas de esa afiliación y se escriben una vez.
   ctx = { db: { query(sql, params), tx(fn({ query })) }, params(), descifra(cifrado, plano), cifra(texto), ult3(afil), MCC }
   ========================================================================= */
'use strict';
const crypto = require('crypto');
const L = require('./catalogo-layout.js');

const LOCK_ID = 7420110001;                  // clave del advisory lock del catálogo de grupos
const MAX_FILAS = 5000;

class ErrorLayout extends Error {
  constructor(codigo, mensaje, extra) { super(mensaje || codigo); this.codigo = codigo; Object.assign(this, extra || {}); }
}

const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const hashArchivo = fuente => sha(Buffer.isBuffer(fuente) ? fuente : Buffer.from(String(fuente), 'utf8'));

async function cargarActual(q, ctx) {
  const grupos = await q('select * from grupos'), afilGrupo = await q('select * from afil_grupo');
  const afiliaciones = await q('select * from afiliaciones'), costos = await q('select * from costos');
  return { grupos: grupos.rows, afilGrupo: afilGrupo.rows, costos: costos.rows,
    afiliaciones: afiliaciones.rows.map(a => ({ ...a, razon_social: ctx.descifra ? ctx.descifra(a.razon_social_cifrada, a.razon_social) : a.razon_social })) };
}

function planDe(parsed, actual, params) {
  const pp = L.prepararLayout(parsed);                  // encabezados con «%» → _pct; avisos de formato de celda
  const plan = L.planificar(pp.objs, actual, { headers: pp.headers, params: { tasa_int_amex: params.tasa_int_amex, tasa_int_int: params.tasa_int_int, fee_broxel: params.fee_broxel } });
  plan.avisos_archivo = [...pp.avisos, ...plan.avisos_archivo];
  return plan;
}

/* Huella de lo que se va a escribir: cambia si cambia el archivo, el catálogo actual (vía los «antes») o cualquier valor final. */
function huellaDe(plan, archivo) {
  return sha(JSON.stringify([archivo, plan.filas.map(f => [f.n, f.id_grupo, f.numero_afiliacion, f.accion, f.cambios, f.final && f.final.relacion]),
    plan.afiliaciones, plan.renombres, plan.grupos_nuevos, plan.modo_tasas])).slice(0, 24);
}

const vistaDe = (plan, huella) => ({ ...plan, filas: plan.filas.map(({ final, ...f }) => f), afiliaciones: undefined, huella });

/* Paso 1: simula. No escribe nada. */
async function simular(ctx, parsed) {
  if (parsed.objs.length > MAX_FILAS) throw new ErrorLayout('demasiadas_filas', `El archivo trae ${parsed.objs.length} filas; el máximo por layout es ${MAX_FILAS}. Divídelo en varios.`);
  const actual = await cargarActual(ctx.db.query, ctx);
  const plan = planDe(parsed, actual, await ctx.params());
  const impactos = await impactoRenombres(ctx.db.query, plan);
  bloquearRenombres(plan, impactos);
  const vista = vistaDe(plan, huellaDe(plan, parsed.hash));
  vista.impacto_renombres = impactos;
  return { plan, vista };
}

/* Renombrar un grupo rompe la liga con las transacciones ya cargadas (llegan con el nombre anterior). Se cuentan todas y las PENDIENTES DE CORTE
   (aprobadas, con fecha de liquidación sin corte vigente): esas son las que se liquidarían mal en el siguiente corte.
   efecto: 'ninguno' si solo cambian mayúsculas/minúsculas (la liga por nombre ignora mayúsculas), 'sin_grupo' en cualquier otro caso. */
async function impactoRenombre(q, antes, despues) {
  const t = (await q(`select count(*)::int n,
        count(*) filter (where upper(t.estatus) = 'APROBADO' and t.fecha_liq is not null
                           and not exists (select 1 from cortes c where c.fecha_liq_iso = t.fecha_liq and c.estado <> 'Rechazado'))::int pendientes,
        max(t.fecha_liq)::text ultima,
        min(t.fecha_liq) filter (where upper(t.estatus) = 'APROBADO' and t.fecha_liq is not null
                           and not exists (select 1 from cortes c where c.fecha_liq_iso = t.fecha_liq and c.estado <> 'Rechazado'))::text primera_pendiente
      from transacciones t where lower(btrim(t.cliente)) = lower(btrim($1))`, [antes])).rows[0];
  const efecto = String(antes).trim().toLowerCase() === String(despues).trim().toLowerCase() ? 'ninguno' : 'sin_grupo';
  return { transacciones: t.n, pendientes: t.pendientes, ultima_fecha_liq: t.ultima || null, primera_pendiente: t.primera_pendiente || null, efecto };
}
async function impactoRenombres(q, plan) {
  const out = [];
  for (const r of plan.renombres || []) out.push({ id_grupo: r.id_grupo, antes: r.antes, despues: r.despues, ...(await impactoRenombre(q, r.antes, r.despues)) });
  return out;
}
const mensajeBloqueo = (nombre, im) => `El grupo se llama «${nombre}» y tiene ${im.pendientes} transacciones aprobadas PENDIENTES DE CORTE (desde la liquidación del ${im.primera_pendiente}) con ese nombre. Renombrarlo ahora las dejaría SIN GRUPO (sin tasas ni cuenta) en el siguiente corte. Haz el renombre después de generar el corte de esas fechas, o deja el nombre actual en el archivo.`;
/* Bloquea (como error) los renombres con transacciones pendientes de corte. */
function bloquearRenombres(plan, impactos) {
  for (const im of impactos) if (im.efecto !== 'ninguno' && im.pendientes > 0) L.marcarError(plan, im.id_grupo, mensajeBloqueo(im.antes, im));
}

const detalleBitacora = (f, accion) => {
  // Valores con su unidad (1.5%, $2.00), no fracciones: así se lee igual en la pantalla y en la auditoría.
  const pares = f.cambios.map(c => [c.campo, c.antes == null && (f.nueva_relacion || f.afiliacion_nueva) ? '(nuevo)' : L.textoValor(c.campo, c.antes), L.textoValor(c.campo, c.despues)]);
  let txt = JSON.stringify(pares);
  if (txt.length > 2500) { let k = pares.length; while (k > 1 && JSON.stringify(pares.slice(0, k)).length > 2400) k--; txt = JSON.stringify(pares.slice(0, k)) + ` …(+${pares.length - k} cambios no mostrados)`; }
  return `layout ${accion} grupo ${f.id_grupo} afiliación ${f.numero_afiliacion} ${txt}`;
};

/* Paso 2: aplica. Devuelve { resultado, bitacora:[líneas] } o lanza ErrorLayout (layout_con_errores | plan_cambio). */
async function aplicar(ctx, parsed, { huella, renombrar, confirmoEscala }) {
  if (parsed.objs.length > MAX_FILAS) throw new ErrorLayout('demasiadas_filas', `El archivo trae ${parsed.objs.length} filas; el máximo por layout es ${MAX_FILAS}.`);
  const params = await ctx.params();
  return ctx.db.tx(async t => {
    const q = (sql, p) => t.query(sql, p);
    await q('select pg_advisory_xact_lock($1)', [LOCK_ID]);
    const actual = await cargarActual(q, ctx);
    const plan = planDe(parsed, actual, params);
    bloquearRenombres(plan, await impactoRenombres(q, plan));       // con datos frescos y el candado puesto
    const vista = vistaDe(plan, huellaDe(plan, parsed.hash));
    if (!plan.ok) throw new ErrorLayout('layout_con_errores', 'El archivo tiene errores: no se guardó nada.', { plan: vista });
    if (String(huella || '') !== vista.huella) throw new ErrorLayout('plan_cambio', 'El catálogo o el archivo cambió desde la simulación. Vuelve a simular para ver los cambios actuales.', { plan: vista });

    if (plan.requiere_confirmacion && !confirmoEscala) throw new ErrorLayout('confirma_escala', 'Hay avisos de escala (posible porcentaje mal capturado). Revísalos y marca la confirmación para aplicar.', { plan: vista });
    const bitacora = [];
    for (const g of plan.grupos_nuevos) await q('insert into grupos(id_grupo,nombre_cliente,activo) values($1,$2,true) on conflict(id_grupo) do nothing', [g.id_grupo, g.nombre]);
    if (renombrar) for (const r of plan.renombres) {
      await q('update grupos set nombre_cliente=$1 where id_grupo=$2', [r.despues, r.id_grupo]);
      bitacora.push(`RENOMBRÓ el grupo ${r.id_grupo} por layout: ${JSON.stringify([r.antes, r.despues])}`);
    }
    // Afiliaciones: razón social, MCC y costos (una vez por afiliación, solo lo que cambia).
    for (const [afil, a] of Object.entries(plan.afiliaciones)) {
      const tocaAlgo = a.nueva || Object.keys(a.cambios).length;
      if (!tocaAlgo) continue;
      if (a.nueva) {
        const rz = a.final.razon_social;
        await q('insert into afiliaciones(numero_afiliacion,razon_social,ult3,id_afiliacion,razon_social_cifrada) values($1,$2,$3,$4,$5) on conflict(numero_afiliacion) do nothing',
          [afil, rz, ctx.ult3(afil), ctx.ult3(afil) + 'CPPX00', ctx.cifra(rz)]);
      } else if ('razon_social' in a.cambios) {
        await q('update afiliaciones set razon_social=$1, razon_social_cifrada=$2 where numero_afiliacion=$3', [a.final.razon_social, ctx.cifra(a.final.razon_social), afil]);
      }
      if ('mcc' in a.cambios) await q('update afiliaciones set mcc=$1, descripcion_giro=$2 where numero_afiliacion=$3', [a.final.mcc, a.final.mcc == null ? null : ctx.MCC.descripcionDe(a.final.mcc), afil]);
      const colsCosto = a.nueva ? L.CAMPOS_COSTOS : L.CAMPOS_COSTOS.filter(c => c in a.cambios);
      if (colsCosto.length) {
        await q('insert into costos(numero_afiliacion) values($1) on conflict(numero_afiliacion) do nothing', [afil]);
        const set = colsCosto.map((c, i) => `${c}=$${i + 2}`).join(',');            // nombres de columna salen de una lista fija, no del archivo
        await q(`update costos set ${set} where numero_afiliacion=$1`, [afil, ...colsCosto.map(c => a.final.costos[c])]);
      }
    }
    // Relaciones grupo ↔ afiliación.
    let creadas = 0, modificadas = 0;
    for (const f of plan.filas) {
      if (f.accion !== 'crear' && f.accion !== 'modificar') continue;
      const r = f.final.relacion;
      if (f.accion === 'crear') {
        await q(`insert into afil_grupo(id_grupo,numero_afiliacion,tasa_pac_tdd,tasa_pac_tdc,tasa_pac_amex,tasa_pac_int,costo_x_trx,pct_banca) values($1,$2,$3,$4,$5,$6,$7,$8)
                 on conflict(id_grupo,numero_afiliacion) do update set tasa_pac_tdd=excluded.tasa_pac_tdd,tasa_pac_tdc=excluded.tasa_pac_tdc,tasa_pac_amex=excluded.tasa_pac_amex,tasa_pac_int=excluded.tasa_pac_int,costo_x_trx=excluded.costo_x_trx,pct_banca=excluded.pct_banca`,
          [f.id_grupo, f.numero_afiliacion, r.tasa_pac_tdd, r.tasa_pac_tdc, r.tasa_pac_amex, r.tasa_pac_int, r.costo_x_trx, r.pct_banca]);
        creadas++;
      } else {
        const cols = L.CAMPOS_RELACION.filter(c => f.cambios.some(x => x.campo === c));
        if (cols.length) await q(`update afil_grupo set ${cols.map((c, i) => `${c}=$${i + 3}`).join(',')} where id_grupo=$1 and numero_afiliacion=$2`, [f.id_grupo, f.numero_afiliacion, ...cols.map(c => r[c])]);
        modificadas++;
      }
      bitacora.push(detalleBitacora(f, f.accion === 'crear' ? 'CREÓ' : 'modificó'));
    }
    bitacora.push(`aplicó layout de grupos: ${creadas} relación(es) nuevas, ${modificadas} modificadas, ${plan.resumen.sin_cambio} sin cambio${renombrar && plan.renombres.length ? `, ${plan.renombres.length} grupo(s) renombrados` : ''}`);
    return { bitacora, resultado: { creadas, modificadas, sin_cambio: plan.resumen.sin_cambio, renombrados: renombrar ? plan.renombres.length : 0, renombres_pendientes: renombrar ? 0 : plan.renombres.length } };
  });
}

module.exports = { impactoRenombre, simular, aplicar, hashArchivo, ErrorLayout, MAX_FILAS, LOCK_ID };
