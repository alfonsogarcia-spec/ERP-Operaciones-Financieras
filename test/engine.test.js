/* Pruebas del motor (BRD): RF-02 fecha de liquidación, anexo 13.3, RN-09.
   Ejecuta: node test/engine.test.js  → sale con código ≠0 si algo falla. */
'use strict';
const E = require('../engine.js');
const P = E.PARAMS_DEF();
const out = [];
const casoFecha = (desc,fecha,hora,prod,esperado,feriados) => {
  const got = E.fmtFecha(E.fechaLiquidacion(fecha,hora,prod,P,feriados||[]));
  out.push({desc, got, esperado, pass: got===esperado});
};
const num2 = n => Number(E.round2(n)).toFixed(2);
const chk = (desc,val,esp) => out.push({desc, got:num2(val), esperado:num2(esp), pass: Math.abs(val-esp)<=0.01});

// RF-02 — fecha de liquidación (AMEX corte 23:00 por defecto)
casoFecha('Nacional viernes 22:00 → lunes','07/08/2026','22:00','Débito','10/08/2026');
casoFecha('Nacional viernes 23:30 (post-corte) → lunes','07/08/2026','23:30','Débito','10/08/2026');
casoFecha('Nacional lunes 23:30 (post-corte) → miércoles','03/08/2026','23:30','Débito','05/08/2026');
casoFecha('Internacional viernes 22:00 → lunes (=Nacional)','07/08/2026','22:00','Internacional','10/08/2026');
casoFecha('AMEX lunes 19:00 → jueves (T+3)','03/08/2026','19:00','American Express','06/08/2026');
casoFecha('AMEX lunes 23:30 (post-corte 23:00) → viernes','03/08/2026','23:30','American Express','07/08/2026');
casoFecha('AMEX 28/04 con feriado 01/05 → 04/05','28/04/2026','10:00','American Express','04/05/2026',['2026-05-01']);
// Precisión de segundos: 23:00:06 pasa el corte, 23:00:00 no
casoFecha('AMEX 30/07 23:00:06 (post) → 05/08','30/07/2026','23:00:06','American Express','05/08/2026');

// Anexo 13.3 — control DEAL/afiliación solo TDD
const tasas={pac_tdd:0.025,pac_tdc:0,pac_amex:0,pac_int:0,costo_x_trx:0,pct_banca:0};
const costos={int_tdd:0.011,int_tdc:0,int_amex:0.0247,int_int:0.0302,fee_broxel:0.0028};
const r=E.calcularCompensacion([{producto:'Débito',monto:1000},{producto:'Débito',monto:500}],{tasas,costos},P,{});
const m=1500, com=m*0.025, comp=m-(com+com*0.16);
chk('13.3 comp_tdd = comp_total',r.comp_tdd,r.comp_total);
chk('13.3 comp_total = disp_total',r.comp_total,r.disp_total);
chk('13.3 diferencia = 0',r.diferencia,0);
chk('13.3 comp_tdd = m − (com+IVA)',r.comp_tdd,comp);
chk('13.3 utilidad = com − int − broxel',r.utilidad, com-(m*0.011)-(m*0.0028));

// RN-09 con financiamientos y contracargos (cuadre en 0)
const r2=E.calcularCompensacion(
  [{producto:'Débito',monto:2000},{producto:'Crédito',monto:1500},{producto:'Internacional',monto:800},{producto:'American Express',monto:1200}],
  {tasas:{pac_tdd:0.02,pac_tdc:0.02,pac_amex:0.03,pac_int:0.03,costo_x_trx:1,pct_banca:0.005},
   costos:{int_tdd:0.01,int_tdc:0.012,int_amex:0.0247,int_int:0.0302,fee_broxel:0.0028}},
  P,{financiamientos:50,contracargos_dom:30,contracargos_amex:20});
out.push({desc:'RN-09 diferencia=0 con fin/CC>0',got:num2(r2.diferencia),esperado:'0.00',pass:Math.abs(r2.diferencia)<=0.01});
out.push({desc:'RN-09 disp_dom+disp_amex=disp_total',got:num2(r2.disp_dom+r2.disp_amex),esperado:num2(r2.disp_total),pass:Math.abs((r2.disp_dom+r2.disp_amex)-r2.disp_total)<=0.01});

let pass=0;
for(const t of out){ console.log(`${t.pass?'PASS':'FAIL'}  ${t.desc}  (obtenido ${t.got}${t.pass?'':` · esperado ${t.esperado}`})`); if(t.pass)pass++; }
console.log(`\n${pass}/${out.length} pruebas correctas`);
process.exit(pass===out.length?0:1);
