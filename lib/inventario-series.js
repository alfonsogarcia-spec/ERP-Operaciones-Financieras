'use strict';
/* ============================================================================
   lib/inventario-series.js — Series (números de serie de terminales, lectores…) del inventario administrativo. Puro: sin base de datos.

   Igual que el costo PEPS, el ESTADO de cada serie no se guarda: se calcula reproduciendo los movimientos del artículo (los mismos, en el mismo orden):
     · una entrada la deja en ALMACÉN (si es una devolución de cliente, vuelve a almacén);
     · una salida de tipo «entrega» la deja ASIGNADA a la Empresa y Unidad del movimiento;
     · cualquier otra salida (merma, consumo, devolución a proveedor, ajuste) la da de BAJA.
   Reglas: una compra o inventario inicial solo admite series nuevas; una serie solo sale si está en almacén; una devolución de cliente solo admite
   series que estaban asignadas. Así anular un movimiento nunca deja una serie en un estado imposible: se revalida todo.
   ========================================================================= */
const P = require('./inventario-peps.js');

const normSerie = s => String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, '');
const SERIE_OK = /^[A-Z0-9][A-Z0-9._\-\/]{0,59}$/;

/* movs: movimientos vigentes de UN artículo serializado; cada uno con `series: [texto]`. */
function estadoSeries(movs) {
  const mapa = new Map();
  const errores = [];
  for (const m of P.ordenar(movs)) {
    const lista = (m.series || []).map(normSerie);
    const vistas = new Set();
    for (const s of lista) {
      if (vistas.has(s)) { errores.push({ folio: Number(m.id), fecha: m.fecha, serie: s, mensaje: `La serie ${s} viene repetida en el mismo movimiento.` }); continue; }
      vistas.add(s);
      const e = mapa.get(s);
      if (m.tipo === 'entrada') {
        if (e && !(m.concepto === 'devolucion_cliente' && e.estado === 'asignada')) {
          errores.push({ folio: Number(m.id), fecha: m.fecha, serie: s, mensaje: e.estado === 'almacen' ? `La serie ${s} ya está en almacén.` : e.estado === 'asignada' ? `La serie ${s} está asignada a ${e.empresa} / ${e.unidad}: para recibirla de vuelta usa «Devolución de cliente».` : `La serie ${s} ya se dio de baja antes.` });
          continue;
        }
        if (!e && m.concepto === 'devolucion_cliente') { errores.push({ folio: Number(m.id), fecha: m.fecha, serie: s, mensaje: `La serie ${s} nunca estuvo asignada: no puede ser una devolución de cliente.` }); continue; }
        mapa.set(s, { serie: s, estado: 'almacen', empresa_id: null, empresa: '', unidad: '', afiliacion: '', desde: m.fecha, folio: Number(m.id), concepto: m.concepto, entrada_folio: e ? e.entrada_folio : Number(m.id), historial: [...(e ? e.historial : []), { fecha: m.fecha, folio: Number(m.id), evento: m.concepto === 'devolucion_cliente' ? 'Regresó a almacén (devolución de cliente)' : 'Entró a almacén' }] });
      } else {
        if (!e || e.estado !== 'almacen') { errores.push({ folio: Number(m.id), fecha: m.fecha, serie: s, mensaje: !e ? `La serie ${s} no existe en el inventario.` : e.estado === 'asignada' ? `La serie ${s} ya está asignada a ${e.empresa} / ${e.unidad}.` : `La serie ${s} está dada de baja.` }); continue; }
        const asigna = m.concepto === 'entrega';
        mapa.set(s, { ...e, estado: asigna ? 'asignada' : 'baja', empresa_id: asigna ? (m.empresa_id == null ? null : Number(m.empresa_id)) : null, empresa: asigna ? (m.empresa || '') : '', unidad: asigna ? (m.unidad || '') : '', afiliacion: asigna ? (m.afiliacion || '') : '', desde: m.fecha, folio: Number(m.id), concepto: m.concepto,
          historial: [...e.historial, { fecha: m.fecha, folio: Number(m.id), evento: asigna ? `Asignada a ${m.empresa} / ${m.unidad}${m.afiliacion ? ' · afiliación ' + m.afiliacion : ''}` : `Baja (${m.concepto})` }] });
      }
    }
  }
  return { series: mapa, errores };
}

module.exports = { estadoSeries, normSerie, SERIE_OK };
