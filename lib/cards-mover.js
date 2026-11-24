/* lib/cards-mover.js — Cards: mover una rama de la estructura (empresa → unidad de negocio → tarjeta) para corregir una captura equivocada.
   - Una EMPRESA se convierte en UNIDAD DE NEGOCIO de otra empresa (sus unidades de negocio pasan a colgar directo de la empresa destino; sus tarjetas se quedan con ella).
   - Una UNIDAD DE NEGOCIO se mueve a otra empresa (con sus tarjetas).
   - Una TARJETA se mueve a otra empresa o unidad de negocio.
   Siempre se revisa primero (sin guardar) y se confirma después. Los fondeos de lo movido pasan a la empresa nueva; los cortes de comisión ya generados no cambian
   (guardan su propia copia). Si algo se contradice (destino dentro de la propia rama, correo de tarjeta repetido, otro tipo de operación, cobros de Post fondeo…), no se mueve nada. */
'use strict';

const NIVEL_TXT = { EMPRESA: 'empresa', UN: 'unidad de negocio', TARJETA: 'tarjeta' };
const num = v => (v == null ? null : Number(v));

// Calcula qué pasaría. No escribe nada. Devuelve { error, mensaje } o { ok:{ ...plan } }.
async function planear(db, id, parentId) {
  const rows = (await db.query('select * from cards.entidades')).rows;
  const porId = new Map(rows.map(r => [r.id, r]));
  const ex = porId.get(id), dest = porId.get(parentId);
  if (!ex) return { error: 'no_existe', mensaje: 'Esa entrada no existe.' };
  if (!dest) return { error: 'destino_no_existe', mensaje: 'Elige a dónde se mueve.' };
  if (dest.id === ex.id) return { error: 'destino_invalido', mensaje: 'No se puede mover a sí misma.' };

  // Toda la rama que cuelga de ex.
  const hijos = new Map(); rows.forEach(r => { if (r.parent_id != null) { if (!hijos.has(r.parent_id)) hijos.set(r.parent_id, []); hijos.get(r.parent_id).push(r); } });
  const rama = []; const visto = new Set([ex.id]); const cola = [ex];
  while (cola.length) { const n = cola.shift(); rama.push(n); for (const h of (hijos.get(n.id) || [])) if (!visto.has(h.id)) { visto.add(h.id); cola.push(h); } }
  if (visto.has(dest.id)) return { error: 'destino_invalido', mensaje: 'El destino está dentro de lo que quieres mover.' };

  // Reglas de nivel.
  let nivelNuevo = ex.nivel;
  if (ex.nivel === 'EMPRESA') {
    if (dest.nivel !== 'EMPRESA') return { error: 'destino_invalido', mensaje: 'Una empresa solo puede pasar a ser unidad de negocio de otra empresa.' };
    nivelNuevo = 'UN';
  } else if (ex.nivel === 'UN') {
    if (dest.nivel !== 'EMPRESA') return { error: 'destino_invalido', mensaje: 'Una unidad de negocio solo se mueve a una empresa.' };
  } else if (dest.nivel === 'TARJETA') return { error: 'destino_invalido', mensaje: 'Una tarjeta se mueve a una empresa o a una unidad de negocio.' };
  if (ex.nivel !== 'EMPRESA' && ex.parent_id === dest.id) return { error: 'sin_cambio', mensaje: `Ya está en «${dest.nombre}».` };

  const empresaNueva = dest.nivel === 'EMPRESA' ? dest.id : dest.empresa_id;
  const empresaVieja = ex.nivel === 'EMPRESA' ? ex.id : ex.empresa_id;
  const empresaDest = porId.get(empresaNueva);
  // El destino y toda su cadena deben estar activos.
  for (let n = dest, k = 0; n && k++ < 10; n = n.parent_id != null ? porId.get(n.parent_id) : null) if (!n.activo) return { error: 'destino_inactivo', mensaje: `«${n.nombre}» está desactivada: reactívala antes de mover algo a ella.` };

  // Tipo de operación (Post fondeo / Dispersa): solo existe en versiones con Post fondeo; si es distinto entre origen y destino no se mueve.
  const tipoDe = e => (e && e.tipo_operacion) || 'DISPERSA';
  const eVieja = porId.get(empresaVieja);
  if (tipoDe(eVieja) !== tipoDe(empresaDest)) return { error: 'operacion_distinta', mensaje: `«${eVieja.nombre}» opera con ${tipoDe(eVieja) === 'POST_FONDEO' ? 'Post fondeo' : 'dispersión'} y «${empresaDest.nombre}» con ${tipoDe(empresaDest) === 'POST_FONDEO' ? 'Post fondeo' : 'dispersión'}: no se pueden mezclar. Cambia primero el tipo de operación.` };

  // Cobros y gastos de Post fondeo cuelgan de la empresa: una empresa que pasa a ser unidad de negocio no puede tenerlos.
  if (ex.nivel === 'EMPRESA') {
    const hay = (await db.query("select to_regclass('cards.cobros') c, to_regclass('cards.gastos') g")).rows[0];
    let n = 0;
    if (hay && hay.c) n += (await db.query('select count(*)::int n from cards.cobros where empresa_id=$1', [ex.id])).rows[0].n;
    if (hay && hay.g) n += (await db.query('select count(*)::int n from cards.gastos where empresa_id=$1', [ex.id])).rows[0].n;
    if (n) return { error: 'tiene_cobros', mensaje: `«${ex.nombre}» tiene ${n} cobro(s) o gasto(s) de Post fondeo registrados a su nombre. No se puede convertir en unidad de negocio sin perder ese historial.` };
  }

  // Correo de tarjeta repetido en la empresa destino (una persona, una tarjeta por empresa).
  const idsRama = [...visto];
  const correosDest = new Map();
  rows.filter(r => r.nivel === 'TARJETA' && r.activo && r.correo_usuario && r.empresa_id === empresaNueva && !visto.has(r.id)).forEach(r => correosDest.set(String(r.correo_usuario).toLowerCase(), r));
  const choques = rama.filter(r => r.nivel === 'TARJETA' && r.activo && r.correo_usuario && correosDest.has(String(r.correo_usuario).toLowerCase())).map(r => r.correo_usuario);
  if (choques.length) return { error: 'correo_duplicado', mensaje: `Ese correo ya tiene tarjeta en «${empresaDest.nombre}»: ${[...new Set(choques)].join(', ')}. Cambia o desactiva una de las dos primero.` };

  // Unidades de negocio de una empresa que se convierte: pasan a colgar directo de la empresa destino.
  const subir = ex.nivel === 'EMPRESA' ? (hijos.get(ex.id) || []).filter(h => h.nivel === 'UN') : [];

  // Qué se arrastra.
  const f = (await db.query(
    `select count(*)::int total, count(*) filter (where estatus in ('SOLICITADO','POR_ASIGNAR'))::int en_proceso, count(*) filter (where corte_comision_id is not null)::int en_corte
       from cards.fondeos where entidad_id = any($1::int[])`, [idsRama])).rows[0];
  const conteo = n => rama.filter(r => r.nivel === n && r.id !== ex.id).length;
  return { ok: {
    id: ex.id, nombre: ex.nombre, nivel: ex.nivel, nivel_nuevo: nivelNuevo,
    destino: { id: dest.id, nombre: dest.nombre, nivel: dest.nivel }, empresa_origen: eVieja ? { id: eVieja.id, nombre: eVieja.nombre } : null, empresa_destino: { id: empresaDest.id, nombre: empresaDest.nombre },
    empresa_nueva_id: empresaNueva, ids_rama: idsRama, ids_subir: subir.map(h => h.id),
    arrastra: { unidades: conteo('UN'), tarjetas: conteo('TARJETA') },
    subir: subir.map(h => h.nombre),
    fondeos: { total: f.total, en_proceso: f.en_proceso, en_corte: f.en_corte },
    conserva_comision: ex.nivel === 'EMPRESA' && ex.comision_pct != null ? { comision_pct: num(ex.comision_pct), iva_pct: num(ex.iva_pct) } : null,
    conserva_cuenta: !!ex.clabe,
  } };
}

// Aplica el plan en una sola transacción.
async function aplicar(db, plan) {
  await db.tx(async t => {
    const q = (sql, p) => t.query(sql, p);
    await q('update cards.entidades set nivel=$2, parent_id=$3, empresa_id=$4, actualizado_at=now() where id=$1', [plan.id, plan.nivel_nuevo, plan.destino.id, plan.empresa_nueva_id]);
    if (plan.ids_subir.length) await q('update cards.entidades set parent_id=$2, empresa_id=$2, actualizado_at=now() where id = any($1::int[])', [plan.ids_subir, plan.empresa_nueva_id]);
    await q('update cards.entidades set empresa_id=$2 where id = any($1::int[]) and id<>$3 and not (id = any($4::int[]))', [plan.ids_rama, plan.empresa_nueva_id, plan.id, plan.ids_subir]);
    await q('update cards.fondeos set empresa_id=$2 where entidad_id = any($1::int[])', [plan.ids_rama, plan.empresa_nueva_id]);
  });
}

function resumenTxt(p) {
  const partes = [`${NIVEL_TXT[p.nivel]} «${p.nombre}» → ${p.nivel_nuevo !== p.nivel ? 'unidad de negocio' : NIVEL_TXT[p.nivel]} de «${p.destino.nombre}»`];
  if (p.arrastra.unidades) partes.push(`${p.arrastra.unidades} unidad(es)`);
  if (p.arrastra.tarjetas) partes.push(`${p.arrastra.tarjetas} tarjeta(s)`);
  if (p.fondeos.total) partes.push(`${p.fondeos.total} fondeo(s)`);
  return partes.join(' · ');
}

function montar(app, { rol, bit, db, actor, ESTRUCTURA, ESTRUCTURA_UN }) {
  app.post('/api/cards/entidades/:id/mover', ...rol(...ESTRUCTURA_UN), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10), parentId = parseInt((req.body || {}).parent_id, 10);
      const ex = Number.isFinite(id) ? (await db.query('select nivel from cards.entidades where id=$1', [id])).rows[0] : null;
      if (!ex) return res.status(404).json({ error: 'no_existe', mensaje: 'Esa entrada no existe.' });
      // Mover una empresa cambia la estructura completa: solo quien administra empresas (igual que crearlas o editarlas).
      if (ex.nivel === 'EMPRESA' && !ESTRUCTURA.includes(req.user.rol_cards)) return res.status(403).json({ error: 'rol_no_autorizado', mensaje: 'Solo un administrador mueve empresas.' });
      const pl = await planear(db, id, parentId);
      if (pl.error) return res.status(pl.error === 'no_existe' ? 404 : 400).json(pl);
      const plan = pl.ok;
      if (!(req.body || {}).confirmar) return res.json({ simulado: true, plan: { ...plan, ids_rama: undefined, ids_subir: undefined }, resumen: resumenTxt(plan) });
      try { await aplicar(db, plan); }
      catch (e) { if (e && e.code === '23505') return res.status(409).json({ error: 'duplicado', mensaje: 'Un dato único (correo o CLABE) se repetiría con este cambio. No se movió nada.' }); throw e; }
      await bit(req, 'cards_entidad_mover', `${resumenTxt(plan)} · de «${plan.empresa_origen ? plan.empresa_origen.nombre : '—'}» a «${plan.empresa_destino.nombre}»`, { resource_type: 'cards_entidad', resource_id: id });
      res.json({ ok: true, resumen: resumenTxt(plan) });
    } catch (e) { console.error('[cards-mover]', e); res.status(500).json({ error: 'error_interno', mensaje: 'No se pudo mover. No se cambió nada.' }); }
  });
}

module.exports = { planear, aplicar, montar, resumenTxt };
