/* lib/mesa/ejemplos.js — Mesa de control: datos de EJEMPLO para probar el flujo completo en local (solicitudes en cada etapa, listas PLD ficticias,
   productos de muestra). Todo queda marcado es_ejemplo y se borra con un clic; los asientos de la bitácora no se borran (es inalterable). */
'use strict';
const F = require('./flujo.js');
const M = require('./motor.js');
const P = require('./pld.js');
const B = require('./bitacora.js');
const K = require('./core.js');

const S = K.S;
const EJEC = { usuario: 'ejemplo.ejecutivo@ejemplo.local', nombre: 'Ejecutivo Ejemplo' };
const A = require('./amortiza.js');
const U = require('./util.js');
const http = (status, msg) => Object.assign(new Error(msg), { status });

const PRODUCTOS = [
  { clave: 'ejemplo_simple_pyme', nombre: 'Crédito simple PyME (ejemplo)', tipo: 'simple', monto_min: 50000, monto_max: 1500000, plazo_min: 6, plazo_max: 48, tasa_min: 0.24, tasa_max: 0.48, tasa_default: 0.36, tasa_moratoria: 0.72, periodicidades: ['mensual', 'quincenal'], comision_apertura: 0.02 },
  { clave: 'ejemplo_revolvente', nombre: 'Línea revolvente (ejemplo)', tipo: 'revolvente', monto_min: 20000, monto_max: 600000, plazo_min: 6, plazo_max: 24, tasa_min: 0.3, tasa_max: 0.54, tasa_default: 0.42, tasa_moratoria: 0.8, periodicidades: ['mensual'], comision_apertura: 0.015 },
];
const LISTAS = [
  { fuente: 'UIF (ejemplo)', nombre: 'María Guadalupe Ficticia Robles', rfc: 'FIRM800101AB1' },
  { fuente: 'UIF (ejemplo)', nombre: 'Distribuidora Fantasma del Pacífico SA de CV' },
  { fuente: 'OFAC (ejemplo)', nombre: 'Alberto Inexistente Saldaña' },
  { fuente: 'SAT 69-B (ejemplo)', nombre: 'Servicios Sombra Integrales SA de CV', rfc: 'SSI180505XY2' },
  { fuente: 'Interna (ejemplo)', nombre: 'Rogelio Marmolejo Quintanar' },
];
// días = antigüedad en la etapa actual (para ver los semáforos); estado = hasta dónde llega el ejemplo
const CASOS = [
  { estado: 'borrador', dias: 1, tipo: 'moral', nombre: 'Panadería La Espiga Dorada SA de CV', rfc: 'PED150312AB4', monto: 150000, plazo: 12, ing: 95000, egr: 52000, deu: 0, antig: 60, score: null, docs: 1, nota: 'Captura en curso: aún faltan documentos.' },
  { estado: 'devuelta', dias: 4, tipo: 'fisica', nombre: 'Carlos Alberto Mendoza Vidal', rfc: 'MEVC850214HJ3', curp: 'MEVC850214HJCNDR08', nac: '1985-02-14', monto: 90000, plazo: 12, ing: 38000, egr: 17000, deu: 3000, antig: 36, score: 640, docs: 'todos', devolucion: 'El comprobante de domicilio está vencido; sube uno de los últimos 3 meses.' },
  { estado: 'verificacion', dias: 3, tipo: 'fisica', nombre: 'María Guadalupe Ficticia Robles', rfc: 'FIRM800101AB1', curp: 'FIRM800101MJCCBR02', nac: '1980-01-01', monto: 120000, plazo: 18, ing: 52000, egr: 21000, deu: 2500, antig: 48, score: 655, docs: 'todos', pld: true, nota: 'Coincidencia de lista por resolver (ejemplo de PLD).' },
  { estado: 'verificacion', dias: 1, tipo: 'moral', nombre: 'Ferretería y Materiales Norte SA de CV', rfc: 'FMN120730KL5', monto: 320000, plazo: 24, ing: 210000, egr: 118000, deu: 15000, antig: 84, score: 701, docs: 'validados' },
  { estado: 'decision', dias: 0, tipo: 'moral', nombre: 'Transportes Rápidos del Bajío SA de CV', rfc: 'TRB100415QW8', monto: 180000, plazo: 12, ing: 175000, egr: 80000, deu: 8000, antig: 96, score: 712, docs: 'validados', pld: 'limpia' },
  { estado: 'decision', dias: 2, tipo: 'moral', nombre: 'Constructora Altavista SA de CV', rfc: 'CAL090921MN6', monto: 520000, plazo: 24, ing: 360000, egr: 205000, deu: 30000, antig: 120, score: 575, docs: 'validados', pld: 'limpia', riesgoAlto: true },
  { estado: 'autorizada', dias: 5, tipo: 'fisica', nombre: 'Laura Patricia Ibarra Soto', rfc: 'IASL900630PQ2', curp: 'IASL900630MJCBTR05', nac: '1990-06-30', monto: 110000, plazo: 12, ing: 61000, egr: 24000, deu: 0, antig: 72, score: 735, docs: 'validados', pld: 'limpia' },
  { estado: 'autorizada', dias: 40, tipo: 'moral', nombre: 'Distribuidora El Sol SA de CV', rfc: 'DSO100203AB7', monto: 240000, plazo: 12, ing: 260000, egr: 120000, deu: 6000, antig: 90, score: 720, docs: 'validados', pld: 'limpia', credito: { fase: 'vigente', desembolso: 45, pagadas: 1 } },
  { estado: 'autorizada', dias: 120, tipo: 'moral', nombre: 'Muebles Regiomontanos SA de CV', rfc: 'MRE090611QT3', monto: 180000, plazo: 12, ing: 190000, egr: 95000, deu: 4000, antig: 70, score: 640, docs: 'validados', pld: 'limpia', credito: { fase: 'vigente', desembolso: 190, pagadas: 1, gestion: true } },
  { estado: 'rechazada', dias: 6, tipo: 'fisica', nombre: 'Jorge Luis Camacho Rivas', rfc: 'CARJ780912TT4', curp: 'CARJ780912HJCMVR01', nac: '1978-09-12', monto: 200000, plazo: 12, ing: 22000, egr: 15000, deu: 4000, antig: 10, score: 520, docs: 'validados', pld: 'limpia', motivo: 'Capacidad de pago', rechazo: 'El pago mensual rebasa por mucho el ingreso comprobado y el score es bajo.' },
];

async function crear(db, { quien, cfg }) {
  const ya = Number((await db.query(`select count(*)::int n from ${S}mc_solicitudes where es_ejemplo`)).rows[0].n);
  if (ya) throw http(409, 'Ya hay solicitudes de ejemplo cargadas. Bórralas primero si quieres volver a generarlas.');
  const res = { productos: 0, listas: 0, solicitudes: 0, creditos: 0, fondeos: 0 };
  await db.tx(async t => {
    // productos de muestra (solo si no hay ninguno propio con esas claves)
    const prod = {};
    for (const p of PRODUCTOS) {
      let r = (await t.query(`select id from ${S}mc_productos where clave=$1`, [p.clave])).rows[0];
      if (!r) {
        r = (await t.query(`insert into ${S}mc_productos(clave,nombre,tipo,monto_min,monto_max,plazo_min,plazo_max,tasa_min,tasa_max,tasa_default,tasa_moratoria,periodicidades,comision_apertura,es_ejemplo,actualizado_por)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14) returning id`, [p.clave, p.nombre, p.tipo, p.monto_min, p.monto_max, p.plazo_min, p.plazo_max, p.tasa_min, p.tasa_max, p.tasa_default, p.tasa_moratoria, p.periodicidades, p.comision_apertura, quien.usuario])).rows[0];
        res.productos++;
      }
      prod[p.clave] = r.id;
    }
    // listas ficticias
    for (const l of LISTAS) { await t.query(`insert into ${S}mc_listas(fuente,tipo,nombre,nombre_norm,rfc,es_ejemplo,cargado_por) values($1,'persona',$2,$3,$4,true,$5)`, [l.fuente, l.nombre, P.normalizar(l.nombre), l.rfc || null, quien.usuario]); res.listas++; }
    const listas = (await t.query(`select id, fuente, tipo, nombre, rfc, curp from ${S}mc_listas where vigente`)).rows;

    for (const c of CASOS) {
      const producto = K.mapProducto((await t.query(`select * from ${S}mc_productos where id=$1`, [prod.ejemplo_simple_pyme])).rows[0]);
      const sl = (await t.query(`insert into ${S}mc_solicitantes(tipo,nombre,rfc_hash,rfc_cifrado,curp_cifrado,fecha_nacimiento,nacionalidad,actividad,domicilio_cifrado,telefono_cifrado,email_cifrado,pep,beneficiario_controlador,origen_recursos,es_ejemplo)
        values($1,$2,$3,$4,$5,$6,'MX',$7,$8,$9,$10,$13,$11,$12,true) returning id`,
      [c.tipo, c.nombre, K.rfcHash(c.rfc), K.cif(c.rfc), K.cif(c.curp), c.nac || null, c.riesgoAlto ? 'Inmobiliaria y construcción' : c.tipo === 'moral' ? 'Comercio y servicios' : 'Servicios profesionales', K.cif('Calle Ejemplo 123, Col. Centro, Guadalajara, Jal.'), K.cif('3300000000'), K.cif('contacto@ejemplo.local'),
        c.tipo === 'moral' ? 'Socio mayoritario (ejemplo)' : null, 'Ventas de su negocio', !!c.riesgoAlto])).rows[0].id;
      const folio = `SOL-${new Date().getUTCFullYear()}-${String(Number((await t.query(`select nextval('${S}mc_folio_seq') n`)).rows[0].n)).padStart(4, '0')}`;
      const sid = (await t.query(`insert into ${S}mc_solicitudes(folio,solicitante_id,producto_id,monto,plazo_meses,periodicidad,tasa_anual,destino,ingresos_mensuales,egresos_mensuales,otras_deudas_mensuales,antiguedad_meses,score_buro,notas,ejecutivo,ejecutivo_nombre,es_ejemplo,creado_at,estado_desde)
        values($1,$2,$3,$4,$5,'mensual',$6,'Capital de trabajo',$7,$8,$9,$10,$11,$12,$13,$14,true, now() - make_interval(days => $15::int) - interval '2 days', now() - make_interval(days => $15::int)) returning id`,
      [folio, sl, prod.ejemplo_simple_pyme, c.monto, c.plazo, producto.tasa_default, c.ing, c.egr, c.deu, c.antig, c.score, c.nota || 'Solicitud de ejemplo', EJEC.usuario, EJEC.nombre, String(c.dias)])).rows[0].id;
      // expediente
      const reqs = K.docsRequeridos(cfg, c.tipo, producto);
      for (let i = 0; i < reqs.length; i++) {
        const estado = c.docs === 'validados' || c.docs === 'todos' && c.estado !== 'devuelta' ? 'validado' : c.docs === 'todos' ? (i === 1 ? 'rechazado' : 'recibido') : i < (c.docs || 0) ? 'recibido' : 'pendiente';
        const recibido = estado !== 'pendiente';
        await t.query(`insert into ${S}mc_documentos(solicitud_id,tipo,estado,archivo_nombre,archivo_mime,comentario,subido_por,subido_at,revisado_por,revisado_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [sid, reqs[i], estado, recibido ? 'ejemplo.pdf' : null, recibido ? 'application/pdf' : null, estado === 'rechazado' ? (c.devolucion || 'Documento ilegible') : null, recibido ? EJEC.usuario : null, recibido ? new Date().toISOString() : null,
            estado === 'validado' || estado === 'rechazado' ? 'analista.ejemplo@ejemplo.local' : null, estado === 'validado' || estado === 'rechazado' ? new Date().toISOString() : null]);
      }
      const asiento = (accion, resumen, detalle, usuario, rol) => B.anotar(t, { usuario: usuario || EJEC.usuario, rol: rol || 'ejecutivo', accion, entidad: 'solicitud', entidad_id: sid, resumen, detalle });
      await asiento('solicitud_alta', `[EJEMPLO] Creó la solicitud ${folio} por ${c.monto} para ${c.nombre}`, { ejemplo: true });

      if (c.estado === 'borrador') { res.solicitudes++; continue; }
      if (c.estado === 'devuelta') {
        await t.query(`insert into ${S}mc_decisiones(solicitud_id,nivel,decision,comentario,usuario,usuario_nombre,rol,creado_at) values($1,'devolucion','devuelve',$2,'analista.ejemplo@ejemplo.local','Analista Ejemplo','analista', now() - interval '1 day')`, [sid, c.devolucion]);
        await t.query(`update ${S}mc_solicitudes set estado='devuelta' where id=$1`, [sid]);
        await asiento('solicitud_devolver', `[EJEMPLO] Devolvió ${folio}: ${c.devolucion}`, { ejemplo: true }, 'analista.ejemplo@ejemplo.local', 'analista');
        res.solicitudes++; continue;
      }
      // PLD
      if (c.pld) {
        const sol = { nombre: c.nombre, rfc: c.rfc, curp: c.curp };
        const hits = P.buscarCoincidencias(sol, listas, cfg.pld);
        const cid = (await t.query(`insert into ${S}mc_pld_consultas(solicitud_id,huella,listas_vigentes,coincidencias,ejecutada_por) values($1,$2,$3,$4,'analista.ejemplo@ejemplo.local') returning id`, [sid, K.huellaPersona(sol), listas.length, hits.length])).rows[0].id;
        for (const h of hits) await t.query(`insert into ${S}mc_pld_coincidencias(consulta_id,solicitud_id,lista_id,fuente,nombre,rfc,score,nivel,motivo) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [cid, sid, h.lista_id, h.fuente, h.nombre, h.rfc, h.score, h.nivel, h.motivo]);
      }
      await t.query(`update ${S}mc_solicitudes set estado='verificacion' where id=$1`, [sid]);
      if (c.estado === 'verificacion') { await asiento('solicitud_enviar', `[EJEMPLO] Envió ${folio} a verificación`, { ejemplo: true }); res.solicitudes++; continue; }
      // decisión / autorizada / rechazada: se evalúa con el motor y se registra la verificación
      const cx = await K.contexto(t, sid, cfg);
      const ev = (await t.query(`insert into ${S}mc_evaluaciones(solicitud_id,huella,entrada,reglas,politica,recomendacion,creado_por) values($1,$2,$3,$4,$5,$6,'analista.ejemplo@ejemplo.local') returning id`,
        [sid, cx.evaluacion.huella, JSON.stringify(cx.entrada), JSON.stringify(cx.evaluacion.reglas), JSON.stringify(cx.evaluacion.politica), cx.evaluacion.recomendacion])).rows[0].id;
      await t.query(`insert into ${S}mc_decisiones(solicitud_id,nivel,decision,usuario,usuario_nombre,rol,evaluacion_id,recomendacion,creado_at) values($1,'verificacion','verifica','analista.ejemplo@ejemplo.local','Analista Ejemplo','analista',$2,$3, now() - make_interval(days => $4::int))`, [sid, ev, cx.evaluacion.recomendacion, String(c.dias)]);
      await asiento('solicitud_verificar', `[EJEMPLO] Cerró la verificación de ${folio}; el motor recomienda: ${M.RECOMENDACIONES[cx.evaluacion.recomendacion]}`, { ejemplo: true, evaluacion: ev }, 'analista.ejemplo@ejemplo.local', 'analista');
      if (c.estado === 'decision') { await t.query(`update ${S}mc_solicitudes set estado='decision' where id=$1`, [sid]); res.solicitudes++; continue; }
      if (c.estado === 'autorizada') {
        await t.query(`insert into ${S}mc_decisiones(solicitud_id,nivel,decision,comentario,usuario,usuario_nombre,rol,evaluacion_id,recomendacion,monto,tasa,plazo) values($1,'mesa','aprueba','Perfil sólido.','mesa.ejemplo@ejemplo.local','Mesa Ejemplo','mesa',$2,$3,$4,$5,$6)`, [sid, ev, cx.evaluacion.recomendacion, c.monto, producto.tasa_default, c.plazo]);
        await t.query(`update ${S}mc_solicitudes set estado='autorizada', monto_autorizado=$2, tasa_autorizada=$3, plazo_autorizado=$4, autorizada_en=now() - make_interval(days => $5::int), vigencia_hasta=current_date + $6::int, comentario_cierre='Perfil sólido.' where id=$1`,
          [sid, c.monto, producto.tasa_default, c.plazo, String(c.dias), Math.max(1, (cfg.facultades.vigencia_dias || 30) - c.dias)]);
        await asiento('solicitud_autorizar', `[EJEMPLO] Autorizó ${folio} por ${c.monto} (firma mesa)`, { ejemplo: true }, 'mesa.ejemplo@ejemplo.local', 'mesa');
      } else if (c.estado === 'rechazada') {
        await t.query(`insert into ${S}mc_decisiones(solicitud_id,nivel,decision,comentario,usuario,usuario_nombre,rol,evaluacion_id,recomendacion) values($1,'rechazo','rechaza',$2,'mesa.ejemplo@ejemplo.local','Mesa Ejemplo','mesa',$3,$4)`, [sid, c.rechazo, ev, cx.evaluacion.recomendacion]);
        await t.query(`update ${S}mc_solicitudes set estado='rechazada', motivo_rechazo=$2, comentario_cierre=$3 where id=$1`, [sid, c.motivo, c.rechazo]);
        await asiento('solicitud_rechazar', `[EJEMPLO] Rechazó ${folio} (${c.motivo}): ${c.rechazo}`, { ejemplo: true }, 'mesa.ejemplo@ejemplo.local', 'mesa');
      }
      res.solicitudes++;
    }

    // ---- créditos de ejemplo: uno por formalizar/desembolsar, uno al corriente y uno con atraso (con fondeo, pagos, gestiones, UIF y conciliación) ----
    const fondeo = (await t.query(`insert into ${S}mc_fondeos(nombre,tipo,monto_linea,tasa_anual,revolvente,fecha_inicio,fecha_vencimiento,notas,es_ejemplo,creado_por) values('Línea institucional (ejemplo)','institucional',1000000,0.22,true,current_date - 200,current_date + 500,'Línea de ejemplo',true,$1) returning id`, [quien.usuario])).rows[0].id;
    await t.query(`insert into ${S}mc_fondeo_mov(fondeo_id,fecha,tipo,monto,referencia,comentario,registrado_por) values($1,current_date - 150,'disposicion',600000,'DISP-EJ-1','Primera disposición (ejemplo)',$2)`, [fondeo, quien.usuario]);
    res.fondeos = 1;
    const hoy = U.hoyMx(), rfcMask = '01218000000000001', clabe = rfcMask + U.digitoClabe(rfcMask);
    const sols = (await t.query(`select s.id, s.folio, s.monto_autorizado, s.tasa_autorizada, s.plazo_autorizado, s.periodicidad, s.solicitante_id, s.producto_id, c.nombre from ${S}mc_solicitudes s join ${S}mc_solicitantes c on c.id=s.solicitante_id where s.es_ejemplo and s.estado='autorizada' order by s.id`)).rows;
    const plan = { 'Laura Patricia Ibarra Soto': { fase: 'desembolso' }, 'Distribuidora El Sol SA de CV': CASOS.find(c => c.credito && c.nombre.startsWith('Distribuidora')).credito, 'Muebles Regiomontanos SA de CV': CASOS.find(c => c.credito && c.nombre.startsWith('Muebles')).credito };
    const dia = n => A.iso(A.parse(hoy) - n * 864e5);
    for (const s of sols) {
      const cp = plan[s.nombre]; if (!cp) continue;
      const pr = K.mapProducto((await t.query(`select * from ${S}mc_productos where id=$1`, [s.producto_id])).rows[0]), monto = Number(s.monto_autorizado), tasa = Number(s.tasa_autorizada), plazo = s.plazo_autorizado;
      const fd = cp.desembolso ? dia(cp.desembolso) : hoy, filas = A.tabla({ monto, tasaAnual: tasa, plazoMeses: plazo, periodicidad: s.periodicidad, fechaDesembolso: fd, ivaPct: 0.16 });
      const cat = A.cat(monto, A.r2(monto * pr.comision_apertura), filas, fd);
      const n = Number((await t.query(`select nextval('${S}mc_credito_seq') n`)).rows[0].n), folio = `CR-${new Date().getUTCFullYear()}-${String(n).padStart(4, '0')}`;
      const cid = (await t.query(`insert into ${S}mc_creditos(folio,solicitud_id,solicitante_id,producto_id,estado,monto,plazo_meses,periodicidad,tasa_anual,tasa_moratoria,comision_apertura,iva_pct,cat,fecha_contrato,fecha_desembolso,beneficiario,clabe_cifrada,banco_codigo,banco_nombre,fondeo_id,creado_por,es_ejemplo)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0.16,$12,$13,$14,$15,$16,'90646','STP',$17,$18,true) returning id`,
      [folio, s.id, s.solicitante_id, s.producto_id, cp.fase === 'desembolso' ? 'desembolso' : 'vigente', monto, plazo, s.periodicidad, tasa, pr.tasa_moratoria, pr.comision_apertura, cat, fd, fd, s.nombre, K.cif(clabe), cp.fase === 'vigente' ? fondeo : null, EJEC.usuario])).rows[0].id;
      const asi = (accion, resumen) => B.anotar(t, { usuario: 'ejemplo@ejemplo.local', rol: 'admin', accion, entidad: 'credito', entidad_id: cid, resumen: '[EJEMPLO] ' + resumen, detalle: { ejemplo: true } });
      await asi('credito_alta', `Abrió el crédito ${folio} desde ${s.folio} por ${monto}`);
      const doc = U.sha256('ejemplo-' + folio);
      for (const [fir, cal] of [[s.nombre, 'representante_legal'], ['Representante de la SOFOM', 'la_sofom']]) await t.query(`insert into ${S}mc_firmas(credito_id,firmante,calidad,metodo,fecha,doc_hash,registrado_por) values($1,$2,$3,'electronica',$4,$5,$6)`, [cid, fir, cal, fd, doc, 'analista.ejemplo@ejemplo.local']);
      await asi('credito_formalizar', `Formalizó el crédito ${folio}`);
      const comision = A.r2(monto * pr.comision_apertura * 1.16);
      if (cp.fase === 'desembolso') {
        await t.query(`insert into ${S}mc_desembolsos(credito_id,monto,comision,neto,estado,fecha_prevista,solicitado_por) values($1,$2,$3,$4,'solicitado',current_date,'tesoreria.ejemplo@ejemplo.local')`, [cid, monto, comision, A.r2(monto - comision)]);
        await asi('desembolso_solicitar', `Solicitó el desembolso de ${folio} por ${monto}`); res.creditos = (res.creditos || 0) + 1; continue;
      }
      for (const f of filas) await t.query(`insert into ${S}mc_amortizacion(credito_id,num,fecha,capital,interes,iva,total,saldo) values($1,$2,$3,$4,$5,$6,$7,$8)`, [cid, f.num, f.fecha, f.capital, f.interes, f.iva, f.total, f.saldo]);
      await t.query(`insert into ${S}mc_desembolsos(credito_id,monto,comision,neto,estado,fecha_prevista,solicitado_por,autorizado_por,autorizado_at,enviado_por,enviado_at,referencia,confirmado_por,confirmado_at,fecha_real) values($1,$2,$3,$4,'confirmado',$5,'tesoreria.ejemplo@ejemplo.local','mesa.ejemplo@ejemplo.local',now(),'tesoreria.ejemplo@ejemplo.local',now(),$6,'tesoreria.ejemplo@ejemplo.local',now(),$5)`, [cid, monto, comision, A.r2(monto - comision), fd, 'SPEI-EJ-' + cid]);
      await asi('desembolso_confirmar', `Confirmó el desembolso de ${folio}: crédito vigente con ${filas.length} pagos`);
      for (let i = 0; i < (cp.pagadas || 0); i++) {
        const pid = (await t.query(`insert into ${S}mc_pagos(credito_id,fecha,monto,medio,referencia,registrado_por) values($1,$2,$3,'spei',$4,'cobranza.ejemplo@ejemplo.local') returning id`, [cid, filas[i].fecha, filas[i].total, `PAGO-EJ-${cid}-${i + 1}`])).rows[0].id;
        await asi('pago_registrar', `Registró el pago ${i + 1} de ${folio} por ${filas[i].total}`); void pid;
      }
      if (cp.gestion) {
        await t.query(`insert into ${S}mc_gestiones(credito_id,fecha,tipo,resultado,comentario,promesa_fecha,promesa_monto,proxima,usuario) values($1,current_date - 25,'llamada','Promesa de pago','Dijo que pagaría la semana siguiente.',current_date - 18,$2,current_date + 2,'cobranza.ejemplo@ejemplo.local')`, [cid, filas[1].total]);
        await t.query(`insert into ${S}mc_gestiones(credito_id,fecha,tipo,resultado,comentario,usuario) values($1,current_date - 4,'visita','No localizado','Se visitó el domicilio fiscal; cerrado.','cobranza.ejemplo@ejemplo.local')`, [cid]);
      }
      res.creditos = (res.creditos || 0) + 1;
    }
    await t.query(`insert into ${S}mc_uif(tipo,regla,fecha,monto,descripcion,es_ejemplo) values('relevante','relevante_efectivo',current_date - 3,185000,'[EJEMPLO] Pago en efectivo de $185,000.00 a un crédito de ejemplo',true)`);
    await t.query(`insert into ${S}mc_movimientos_banco(lote,fecha,descripcion,referencia,monto,importado_por) values('EJEMPLO',current_date - 1,'SPEI recibido de cliente','Abono CR de ejemplo',18500,$1), ('EJEMPLO',current_date,'Depósito sin identificar','DEP-9981',7200,$1)`, [quien.usuario]);
    await B.anotar(t, { usuario: quien.usuario, rol: quien.rol, accion: 'ejemplos_crear', entidad: 'ejemplos', entidad_id: 'ejemplos', resumen: `Cargó datos de ejemplo: ${res.solicitudes} solicitudes, ${res.listas} registros de listas y ${res.productos} producto(s)`, detalle: res });
  });
  return res;
}

async function borrar(db, { quien }) {
  const res = {};
  await db.tx(async t => {
    await t.query(`delete from ${S}mc_pagos where credito_id in (select id from ${S}mc_creditos where es_ejemplo)`);
    await t.query(`delete from ${S}mc_corte_items where credito_id in (select id from ${S}mc_creditos where es_ejemplo)`);
    res.creditos = (await t.query(`delete from ${S}mc_creditos where es_ejemplo returning id`)).rows.length;
    await t.query(`delete from ${S}mc_cortes_ingreso where id not in (select corte_id from ${S}mc_corte_items where corte_id is not null)`);
    await t.query(`delete from ${S}mc_movimientos_banco where lote='EJEMPLO'`);
    await t.query(`delete from ${S}mc_uif where es_ejemplo`);
    res.fondeos = (await t.query(`delete from ${S}mc_fondeos where es_ejemplo returning id`)).rows.length;
    res.solicitudes = (await t.query(`delete from ${S}mc_solicitudes where es_ejemplo returning id`)).rows.length;
    res.solicitantes = (await t.query(`delete from ${S}mc_solicitantes where es_ejemplo and id not in (select solicitante_id from ${S}mc_solicitudes) returning id`)).rows.length;
    res.productos = (await t.query(`delete from ${S}mc_productos where es_ejemplo and id not in (select producto_id from ${S}mc_solicitudes) returning id`)).rows.length;
    res.listas = (await t.query(`delete from ${S}mc_listas where es_ejemplo returning id`)).rows.length;
    await B.anotar(t, { usuario: quien.usuario, rol: quien.rol, accion: 'ejemplos_borrar', entidad: 'ejemplos', entidad_id: 'ejemplos', resumen: `Borró los datos de ejemplo: ${res.solicitudes} solicitudes, ${res.listas} registros de listas, ${res.productos} producto(s)`, detalle: res });
  });
  return res;
}

module.exports = { crear, borrar };
void F;
