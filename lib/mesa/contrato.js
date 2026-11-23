/* lib/mesa/contrato.js — Mesa de control: documentos imprimibles (contrato de apertura de crédito simple y estado de cuenta) generados como HTML.
   El texto del contrato es una BASE de trabajo: el área legal debe revisarlo y adaptarlo antes de usarlo con clientes (cláusulas, domicilios, jurisdicción,
   avales, garantías y datos del representante de la SOFOM). Cada firma guarda la huella del documento que se firmó. */
'use strict';
const { esc, mxn, fechaLarga } = require('./util.js');

const CSS = `body{font:13px/1.55 Georgia,serif;color:#1c1a17;max-width:820px;margin:32px auto;padding:0 20px}h1{font-size:20px;text-align:center;margin:0 0 4px}h2{font-size:14px;margin:22px 0 6px;text-transform:uppercase;letter-spacing:.04em}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #bbb;padding:4px 8px;font-size:12px;text-align:right}th:first-child,td:first-child{text-align:center}th{background:#f1ece3}.k td:first-child{text-align:left;width:38%;font-weight:600}.k td{text-align:left}
.aviso{border:1px solid #c9a25c;background:#fbf4e4;padding:8px 12px;font-size:12px;margin:12px 0}.firmas{display:flex;gap:40px;margin-top:60px}.firmas div{flex:1;border-top:1px solid #333;padding-top:6px;text-align:center;font-size:12px}small{color:#666}@media print{.aviso{display:none}}`;

/* d = { credito, solicitante, producto, filas, sofom:{nombre, representante} } */
function contrato(d) {
  const c = d.credito, s = d.solicitante, f = d.filas, tot = f.reduce((a, x) => ({ cap: a.cap + x.capital, int: a.int + x.interes, iva: a.iva + x.iva }), { cap: 0, int: 0, iva: 0 });
  const sofom = d.sofom || { nombre: 'SOLVENDOM, S.A. DE C.V., SOFOM, E.N.R.', representante: '[Representante legal de la SOFOM]' };
  const mor = c.tasa_moratoria == null ? null : c.tasa_moratoria;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Contrato ${esc(c.folio)}</title><style>${CSS}</style></head><body>
<div class="aviso"><b>Texto base para revisión legal.</b> Revísalo y adáptalo antes de usarlo con clientes. Esta nota no se imprime.</div>
<h1>CONTRATO DE APERTURA DE CRÉDITO SIMPLE</h1><div style="text-align:center"><small>Folio ${esc(c.folio)} · ${esc(fechaLarga(c.fecha_contrato || c.fecha_desembolso))}</small></div>
<p>Contrato que celebran, por una parte, <b>${esc(sofom.nombre)}</b> (en adelante «la SOFOM»), representada por ${esc(sofom.representante)}, y por la otra <b>${esc(s.nombre)}</b>${s.rfc ? `, con RFC ${esc(s.rfc)}` : ''}${s.domicilio ? ` y domicilio en ${esc(s.domicilio)}` : ''} (en adelante «el ACREDITADO»), al tenor de las siguientes cláusulas:</p>
<h2>Carátula del crédito</h2>
<table class="k"><tr><td>Producto</td><td>${esc(d.producto.nombre)}</td></tr><tr><td>Monto del crédito</td><td>${esc(mxn(c.monto))}</td></tr><tr><td>Plazo</td><td>${c.plazo_meses} meses · pagos ${esc(c.periodicidad)}es (${f.length})</td></tr>
<tr><td>Tasa de interés ordinaria anual</td><td>${(c.tasa_anual * 100).toFixed(2)}% fija, sobre saldos insolutos</td></tr><tr><td>Tasa moratoria anual</td><td>${mor == null ? 'No pactada' : (mor * 100).toFixed(2) + '% sobre el capital vencido'}</td></tr>
<tr><td>Comisión por apertura</td><td>${(c.comision_apertura * 100).toFixed(2)}% (${esc(mxn(c.monto * c.comision_apertura))} más IVA)</td></tr><tr><td>IVA</td><td>${(c.iva_pct * 100).toFixed(0)}% sobre intereses, comisiones y moratorios</td></tr>
<tr><td>CAT sin IVA (informativo)</td><td>${c.cat == null ? '—' : (c.cat * 100).toFixed(1) + '%'} anual</td></tr><tr><td>Fecha de desembolso</td><td>${esc(fechaLarga(c.fecha_desembolso))}</td></tr><tr><td>Cuenta de depósito</td><td>${esc(c.beneficiario || '—')} · CLABE ${esc(c.clabe_mascara || '—')}</td></tr></table>
<h2>Cláusulas</h2>
<p><b>Primera. Objeto.</b> La SOFOM abre al ACREDITADO un crédito simple hasta por el monto indicado, que dispone en una sola exhibición mediante depósito a la cuenta señalada en la carátula.</p>
<p><b>Segunda. Pago.</b> El ACREDITADO pagará capital, intereses e IVA en los pagos periódicos de la tabla de amortización que forma parte de este contrato. Los pagos se aplican en este orden: moratorios con su IVA, intereses, IVA y capital, comenzando por el pago vencido más antiguo.</p>
<p><b>Tercera. Intereses.</b> El crédito devenga intereses ordinarios a la tasa de la carátula, calculados sobre saldos insolutos, y se causa el IVA correspondiente.</p>
<p><b>Cuarta. Intereses moratorios.</b> ${mor == null ? 'No se pacta tasa moratoria.' : `Si el ACREDITADO no paga en la fecha pactada, el capital vencido devenga intereses moratorios a la tasa de la carátula, calculados sobre año de 360 días desde el día siguiente al vencimiento y hasta su pago total, más IVA.`}</p>
<p><b>Quinta. Pagos anticipados.</b> El ACREDITADO puede pagar anticipadamente. El excedente de un pago adelanta los pagos periódicos siguientes sin recalcular la tabla, salvo acuerdo por escrito.</p>
<p><b>Sexta. Vencimiento anticipado.</b> La SOFOM podrá dar por vencido anticipadamente el plazo si el ACREDITADO incumple dos o más pagos consecutivos o proporciona información falsa.</p>
<p><b>Séptima. Información y aviso de privacidad.</b> El ACREDITADO autoriza a la SOFOM a consultar y reportar su información crediticia a las sociedades de información crediticia y declara haber recibido el aviso de privacidad.</p>
<p><b>Octava. Jurisdicción.</b> Para la interpretación y cumplimiento de este contrato las partes se someten a los tribunales competentes de [ciudad y estado], renunciando a cualquier otro fuero.</p>
<h2>Tabla de amortización</h2>
<table><tr><th>No.</th><th>Fecha</th><th>Capital</th><th>Interés</th><th>IVA</th><th>Pago total</th><th>Saldo</th></tr>
${f.map(x => `<tr><td>${x.num}</td><td>${esc(x.fecha)}</td><td>${esc(mxn(x.capital))}</td><td>${esc(mxn(x.interes))}</td><td>${esc(mxn(x.iva))}</td><td>${esc(mxn(x.total))}</td><td>${esc(mxn(x.saldo))}</td></tr>`).join('')}
<tr><th colspan="2">Totales</th><th>${esc(mxn(tot.cap))}</th><th>${esc(mxn(tot.int))}</th><th>${esc(mxn(tot.iva))}</th><th>${esc(mxn(tot.cap + tot.int + tot.iva))}</th><th></th></tr></table>
<div class="firmas"><div>${esc(sofom.nombre)}<br><small>${esc(sofom.representante)}</small></div><div>${esc(s.nombre)}<br><small>EL ACREDITADO${s.tipo === 'moral' ? ' (por conducto de su representante legal)' : ''}</small></div></div>
</body></html>`;
}

/* d = { credito, solicitante, estado (de amortiza.estado), pagos:[{fecha, monto, referencia, medio}], fecha } */
function estadoCuenta(d) {
  const c = d.credito, e = d.estado;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Estado de cuenta ${esc(c.folio)}</title><style>${CSS}</style></head><body>
<h1>ESTADO DE CUENTA</h1><div style="text-align:center"><small>Crédito ${esc(c.folio)} · al ${esc(fechaLarga(d.fecha))}</small></div>
<h2>Acreditado</h2><table class="k"><tr><td>Nombre</td><td>${esc(d.solicitante.nombre)}</td></tr><tr><td>Monto original</td><td>${esc(mxn(c.monto))}</td></tr><tr><td>Tasa anual</td><td>${(c.tasa_anual * 100).toFixed(2)}%</td></tr></table>
<h2>Resumen</h2><table class="k"><tr><td>Saldo de capital</td><td>${esc(mxn(e.saldoCapital))}</td></tr><tr><td>Pagos vencidos (capital, interés e IVA)</td><td>${esc(mxn(e.vencido.cuotas))}</td></tr><tr><td>Moratorios más IVA</td><td>${esc(mxn(e.moratorios + e.ivaMoratorios))}</td></tr>
<tr><td>Total vencido a hoy</td><td><b>${esc(mxn(e.vencido.total))}</b></td></tr><tr><td>Días de atraso</td><td>${e.diasAtraso}</td></tr><tr><td>Próximo pago</td><td>${e.proximo ? esc(fechaLarga(e.proximo.fecha)) + ' · ' + esc(mxn(e.proximo.monto)) : '—'}</td></tr><tr><td>Para liquidar hoy</td><td>${esc(mxn(e.liquidar))}</td></tr></table>
<h2>Pagos recibidos</h2><table><tr><th>Fecha</th><th>Monto</th><th>Medio</th><th>Referencia</th></tr>${d.pagos.length ? d.pagos.map(p => `<tr><td>${esc(p.fecha)}</td><td>${esc(mxn(p.monto))}</td><td>${esc(p.medio)}</td><td>${esc(p.referencia || '')}</td></tr>`).join('') : '<tr><td colspan="4">Sin pagos</td></tr>'}</table>
<h2>Calendario de pagos</h2><table><tr><th>No.</th><th>Fecha</th><th>Pago total</th><th>Pendiente</th><th>Estado</th></tr>${e.filas.map(x => `<tr><td>${x.num}</td><td>${esc(x.fecha)}</td><td>${esc(mxn(x.total))}</td><td>${esc(mxn(x.pCap + x.pInt + x.pIva))}</td><td>${x.pagada ? 'Pagado' : x.vencida ? 'Vencido' : 'Por vencer'}</td></tr>`).join('')}</table>
</body></html>`;
}

module.exports = { contrato, estadoCuenta };
