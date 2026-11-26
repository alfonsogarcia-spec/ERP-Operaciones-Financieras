/* lib/solicitudes/pos.js — Portal de solicitudes: lo que ya sabe POS (grupos de cliente, afiliaciones, tasas pactadas, cuentas de liquidación, bancos) y las
   validaciones de negocio que se apoyan en eso. Así el cliente elige sus afiliaciones de una lista, la tasa y la CLABE se heredan y no se capturan dos veces. */
'use strict';
const V = require('./validar.js');
const CAT = require('./catalogo.js');

const pct = n => (n == null ? null : Math.round(Number(n) * 100 * 10000) / 10000);   // 0.012 → 1.2
const ult4 = c => String(c || '').slice(-4);

// Afiliaciones del grupo con sus tasas pactadas y su cuenta de liquidación.
async function afiliacionesDe(db, idGrupo) {
  const af = (await db.query(
    `select a.numero_afiliacion, a.razon_social, a.mcc, a.descripcion_giro, ag.tasa_pac_tdd, ag.tasa_pac_tdc, ag.tasa_pac_amex, ag.tasa_pac_int, ag.costo_x_trx
       from afil_grupo ag join afiliaciones a on a.numero_afiliacion = ag.numero_afiliacion where ag.id_grupo = $1 order by a.numero_afiliacion`, [idGrupo])).rows;
  const cu = (await db.query(`select numero_afiliacion, nombre_comercial, razon_social_beneficiario, banco, clabe from cuentas where id_grupo = $1 order by id`, [idGrupo])).rows;
  return af.map(a => {
    const c = cu.find(x => String(x.numero_afiliacion) === String(a.numero_afiliacion)) || null;
    return { numero: String(a.numero_afiliacion), razon_social: a.razon_social, mcc: a.mcc, giro: a.descripcion_giro,
      tasas: { tdd: pct(a.tasa_pac_tdd), tdc: pct(a.tasa_pac_tdc), amex: pct(a.tasa_pac_amex), int: pct(a.tasa_pac_int), costo_x_trx: a.costo_x_trx == null ? null : Number(a.costo_x_trx) },
      cuenta: c ? { banco: c.banco, clabe: c.clabe, titular: c.razon_social_beneficiario || a.razon_social, comercio: c.nombre_comercial } : null };
  });
}

async function bancos(db) {
  return (await db.query('select nombre, codigo_spei from bancos order by nombre')).rows.map(b => ({ nombre: b.nombre, codigo: b.codigo_spei, prefijo: V.prefijoBanco(b.codigo_spei) }));
}

// Comercios que POS conoce de un grupo: los de sus cuentas de liquidación y los que ya vendieron bajo sus afiliaciones.
async function comerciosDe(db, idGrupo, numeros) {
  const a = (await db.query('select distinct nombre_comercial n from cuentas where id_grupo = $1 and coalesce(nombre_comercial, \'\') <> \'\' and ($2::text[] is null or numero_afiliacion = any($2::text[]))', [idGrupo, numeros && numeros.length ? numeros : null])).rows.map(r => r.n);
  let b = [];
  if (numeros && numeros.length) { try { b = (await db.query('select distinct comercio n from transacciones where numero_afiliacion = any($1::text[]) and coalesce(comercio, \'\') <> \'\'', [numeros])).rows.map(r => r.n); } catch (_e) { b = []; } }
  return [...new Set([...a, ...b])].sort((x, y) => String(x).localeCompare(String(y), 'es'));
}
const unidadesDe = async (db, idGrupo, soloActivas) => (await db.query(`select id, nombre, afiliaciones, comercios, activo from sc_unidades where id_grupo = $1${soloActivas ? ' and activo' : ''} order by nombre`, [idGrupo])).rows;

// Crea las unidades de negocio que faltan a partir de POS: una por afiliación (con su razón social como nombre y sus comercios). Lo ya definido no se toca.
async function importarUnidades(db, idGrupo, usuario) {
  const afs = await afiliacionesDe(db, idGrupo); const ya = await unidadesDe(db, idGrupo);
  const cubiertas = new Set(ya.flatMap(u => u.afiliaciones || [])); const nombres = new Set(ya.map(u => u.nombre.toLowerCase())); let creadas = 0;
  for (const a of afs) {
    if (cubiertas.has(a.numero)) continue;
    let nombre = a.razon_social || ('Afiliación ' + a.numero); if (nombres.has(nombre.toLowerCase())) nombre = `${nombre} (${a.numero})`;
    await db.query('insert into sc_unidades(id_grupo, nombre, afiliaciones, comercios, creado_por) values($1,$2,$3,$4,$5)', [idGrupo, nombre, [a.numero], await comerciosDe(db, idGrupo, [a.numero]), usuario || null]);
    nombres.add(nombre.toLowerCase()); creadas++;
  }
  return creadas;
}

// Qué puede tocar un contacto dentro de un cliente: null = todo; si tiene unidades asignadas, solo sus afiliaciones, comercios y unidades.
async function restriccionDe(db, usuarioId, idGrupo) {
  const r = (await db.query('select u.id, u.nombre, u.afiliaciones, u.comercios from sc_contacto_unidades c join sc_unidades u on u.id = c.unidad_id where c.usuario_id = $1 and c.id_grupo = $2 and u.activo', [usuarioId, idGrupo])).rows;
  if (!r.length) return null;
  return { unidades: r.map(x => ({ id: x.id, nombre: x.nombre })), afiliaciones: new Set(r.flatMap(x => x.afiliaciones || [])), comercios: new Set(r.flatMap(x => x.comercios || [])), nombres: new Set(r.map(x => x.nombre)) };
}

// Catálogo que usa la pantalla: sus afiliaciones, unidades de negocio, comercios y bancos (acotado a lo que el contacto tiene asignado).
async function catalogoGrupo(db, idGrupo, restr) {
  const g = (await db.query('select id_grupo, nombre_cliente from grupos where id_grupo = $1', [idGrupo])).rows[0];
  if (!g) return null;
  let afiliaciones = await afiliacionesDe(db, idGrupo);
  let unidades = (await unidadesDe(db, idGrupo, true)).map(u => ({ id: u.id, nombre: u.nombre, afiliaciones: u.afiliaciones || [], comercios: u.comercios || [] }));
  if (restr) { afiliaciones = afiliaciones.filter(a => restr.afiliaciones.has(a.numero)); unidades = unidades.filter(u => restr.nombres.has(u.nombre)); }
  const comercios = unidades.length ? [...new Set(unidades.flatMap(u => u.comercios))].sort((x, y) => x.localeCompare(y, 'es'))
    : [...new Set(afiliaciones.map(a => a.cuenta && a.cuenta.comercio).filter(Boolean))];
  return { grupo: { id_grupo: g.id_grupo, nombre: g.nombre_cliente }, afiliaciones, unidades, bancos: await bancos(db), comercios, empresas: [g.nombre_cliente], acotado: !!restr };
}

// Lo que un contacto con unidades asignadas no puede salirse de elegir. Devuelve { key: mensaje }.
function fueraDeAlcance(restr, d) {
  const e = {}; if (!restr) return e;
  if (!V.vacio(d.afil_principal) && !restr.afiliaciones.has(String(d.afil_principal))) e.afil_principal = 'Esa afiliación no es de tus unidades de negocio.';
  if (!V.vacio(d.unidad_negocio) && !restr.nombres.has(String(d.unidad_negocio))) e.unidad_negocio = 'Esa unidad de negocio no es de las que tienes asignadas.';
  const fuera = (k, set) => (Array.isArray(d[k]) ? d[k] : []).filter(x => !set.has(x));
  const u = fuera('nivel_udn', restr.nombres); if (u.length) e.nivel_udn = 'Solo puedes pedir unidades de negocio de las que tienes asignadas.';
  const c = fuera('nivel_comercios', restr.comercios); if (c.length) e.nivel_comercios = 'Solo puedes pedir comercios de tus unidades de negocio.';
  return e;
}

// Lo que POS tenía de la afiliación elegida, para congelarlo en la solicitud.
async function referenciaPos(db, idGrupo, numero) {
  if (!numero) return {};
  const a = (await afiliacionesDe(db, idGrupo)).find(x => x.numero === String(numero));
  return a ? { afiliacion: { numero: a.numero, razon_social: a.razon_social, mcc: a.mcc, giro: a.giro }, tasas: a.tasas, cuenta: a.cuenta, tomada_at: new Date().toISOString() } : {};
}

// Validaciones de negocio contra POS. `d` = datos de todas las etapas juntos. Devuelve { errores:{key:msg}, alertas:[texto] }.
async function validarNegocio(db, tipoId, d, ctx) {
  const t = CAT.tipo(tipoId); const errores = {}, alertas = [];
  const idGrupo = ctx.id_grupo;
  let afs = null;
  const afil = async () => (afs = afs || await afiliacionesDe(db, idGrupo));
  let bcs = null; const bancosC = async () => (bcs = bcs || await bancos(db));

  if (t.requiere_afiliacion) {
    if (!V.vacio(d.afil_principal)) {
      const a = (await afil()).find(x => x.numero === String(d.afil_principal));
      if (!a) errores.afil_principal = 'Esa afiliación no pertenece a tu grupo o no está activa en POS.';
    }
  }
  const banco = async nombre => (await bancosC()).find(b => b.nombre === nombre);
  const revisaClabe = async (kClabe, kBanco) => {
    if (V.vacio(d[kClabe]) || V.validarValor({ tipo: 'clabe' }, d[kClabe])) return;
    if (!V.vacio(d[kBanco])) {
      const b = await banco(d[kBanco]);
      if (!b) errores[kBanco] = 'Elige un banco del catálogo.';
      else if (String(d[kClabe]).slice(0, 3) !== b.prefijo) errores[kClabe] = `La CLABE no pertenece a ${b.nombre} (debería empezar con ${b.prefijo}).`;
    }
    const otra = (await db.query('select id_grupo, numero_afiliacion from cuentas where clabe = $1 limit 1', [String(d[kClabe])])).rows[0];
    if (otra) alertas.push(`Esa CLABE ya está registrada en POS (grupo ${otra.id_grupo}, afiliación ${otra.numero_afiliacion || '—'}).`);
  };

  if (tipoId === 'alta_afiliacion') {
    await revisaClabe('liq_clabe', 'liq_banco');
    if (!V.vacio(d.liq_titular) && !V.vacio(d.razon_social) && V.nombresCoinciden(d.liq_titular, d.razon_social) === false) alertas.push('El titular de la cuenta no coincide con la razón social del comercio.');
    if (!V.vacio(d.razon_social)) {
      const dup = (await db.query('select numero_afiliacion, razon_social from afiliaciones')).rows.find(r => V.nombresCoinciden(r.razon_social, d.razon_social) === true);
      if (dup) alertas.push(`Ya existe en POS una afiliación con una razón social parecida (${dup.numero_afiliacion} · ${dup.razon_social}).`);
    }
  }
  if (tipoId === 'cambio_clabe') {
    await revisaClabe('clabe_nueva', 'banco_nuevo');
    const a = !V.vacio(d.afil_principal) ? (await afil()).find(x => x.numero === String(d.afil_principal)) : null;
    if (a && a.cuenta && !V.vacio(d.clabe_nueva) && String(d.clabe_nueva) === String(a.cuenta.clabe)) errores.clabe_nueva = 'La nueva CLABE es la misma que ya tiene la afiliación.';
    const titularActual = a && ((a.cuenta && a.cuenta.titular) || a.razon_social);
    if (titularActual && !V.vacio(d.nuevo_titular) && V.nombresCoinciden(d.nuevo_titular, titularActual) === false) alertas.push(`El titular de la nueva cuenta («${d.nuevo_titular}») no coincide con el de la afiliación («${titularActual}»). La CLABE nueva debe ser del mismo titular.`);
  }
  if (tipoId === 'alta_subafiliado' && !V.vacio(d.nombre_comercial) && !V.vacio(d.afil_principal)) {
    const dup = (await db.query(
      `select folio, estado from sc_solicitudes where tipo = 'alta_subafiliado' and afiliacion = $1 and lower(titulo) = lower($2) and id <> $3 and estado not in ('cancelada','rechazada') limit 1`,
      [String(d.afil_principal), String(d.nombre_comercial), ctx.id || 0])).rows[0];
    if (dup) alertas.push(`Ya hay una solicitud para ese nombre comercial bajo la misma afiliación (${dup.folio}, ${dup.estado}).`);
  }
  if (tipoId === 'usuario_suite' && !V.vacio(d.usuario_email)) {
    const dup = (await db.query(
      `select folio, estado from sc_solicitudes where tipo = 'usuario_suite' and lower(datos->>'usuario_email') = lower($1) and id <> $2 and estado in ('revision_comercial','devuelta','operacion','ejecucion','validacion') limit 1`,
      [String(d.usuario_email), ctx.id || 0])).rows[0];
    if (dup) alertas.push(`Ya hay una solicitud abierta para ese correo (${dup.folio}, ${dup.estado}).`);
  }
  if (tipoId === 'cambio_condiciones' && d.tasa_nueva_debito !== undefined) {
    const a = !V.vacio(d.afil_principal) ? (await afil()).find(x => x.numero === String(d.afil_principal)) : null;
    if (a) {
      const cmp = [['TDD', d.tasa_nueva_debito, a.tasas.tdd], ['TDC', d.tasa_nueva_credito, a.tasas.tdc], ['INT', d.tasa_nueva_internacional, a.tasas.int], ['AMEX', d.tasa_nueva_amex, a.tasas.amex]]
        .filter(([, n, v]) => !V.vacio(n) && v != null && Number(n) !== Number(v)).map(([k, n, v]) => `${k}: ${v}% → ${Number(n)}%`);
      if (cmp.length) alertas.push('Cambio de tasa respecto a la pactada en POS · ' + cmp.join(' · '));
    }
  }
  return { errores, alertas };
}

module.exports = { afiliacionesDe, bancos, catalogoGrupo, referenciaPos, validarNegocio, comerciosDe, unidadesDe, importarUnidades, restriccionDe, fueraDeAlcance, pct, ult4 };
