/* ============================================================================
   engine.js — Motor de Polipay POS Settlement (BRD-OP-AGR-001)
   Funciones PURAS: única fuente de verdad del cálculo. Movidas verbatim del
   front. Las consume server.js y test/engine.test.js.
   Sección 6 / RN-01..RN-16. IVA = fracción, tasas = fracción (0.025 = 2.5%).
   ========================================================================= */
'use strict';

const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* ---------- fechas dd/mm/yyyy ---------- */
function parseFecha(str){
  if(str instanceof Date) return new Date(str.getFullYear(),str.getMonth(),str.getDate());
  if(str==null||str==='') return null; str=String(str).trim();
  let m=str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if(m){let[,d,mo,y]=m;y=+y;if(y<100)y+=2000;return new Date(y,+mo-1,+d);}
  m=str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/); // yyyy-mm-dd
  if(m){let[,y,mo,d]=m;return new Date(+y,+mo-1,+d);}
  const d=new Date(str); return isNaN(d)?null:new Date(d.getFullYear(),d.getMonth(),d.getDate());
}
const fmtFecha=d=>{if(!d)return'';const dd=String(d.getDate()).padStart(2,'0'),mm=String(d.getMonth()+1).padStart(2,'0');return `${dd}/${mm}/${d.getFullYear()}`;};
const isoFecha=d=>{if(!d)return'';return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const addDays=(d,n)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x;};

// Hora → SEGUNDOS del día (incluye segundos: "23:00:06" cuenta como posterior a "23:00").
const parseHoraSeg=h=>{if(h==null||h==='')return 0;const m=String(h).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);return m?((+m[1])*3600+(+m[2])*60+(+(m[3]||0))):0;};
// Normaliza hora desde texto, Date (celda Excel) o número (fracción de día) → "HH:MM:SS"/"HH:MM"
function horaStr(v){ if(v==null||v==='')return'';
  if(v instanceof Date) return String(v.getHours()).padStart(2,'0')+':'+String(v.getMinutes()).padStart(2,'0')+':'+String(v.getSeconds()).padStart(2,'0');
  if(typeof v==='number'){ let s=Math.round((v%1)*86400); const h=Math.floor(s/3600)%24,m=Math.floor((s%3600)/60),ss=s%60; return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0'); }
  return String(v).trim(); }

/* ---------- monto robusto ---------- */
function parseMonto(v){
  if(typeof v==='number') return isFinite(v)?v:0;
  let s=String(v==null?'':v).trim(); if(!s) return 0;
  const neg=/^\(.*\)$/.test(s)||/-/.test(s);
  s=s.replace(/[^\d.,]/g,''); if(!s) return 0;
  if(s.includes(',')&&s.includes('.')){
    if(s.lastIndexOf(',')>s.lastIndexOf('.')) s=s.replace(/\./g,'').replace(',','.');
    else s=s.replace(/,/g,'');
  } else if(s.includes(',')){
    const p=s.split(','); s=(p.length===2 && p[1].length<=2) ? p[0]+'.'+p[1] : s.replace(/,/g,'');
  }
  let n=parseFloat(s); if(isNaN(n)) return 0; return neg?-Math.abs(n):n;
}

/* ---------- producto (insensible a acentos) ---------- */
function normStr(s){ return String(s==null?'':s).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g,' '); }
const PROD={
  'debito':'tdd','tdd':'tdd','td':'tdd','tarjeta de debito':'tdd','debito nacional':'tdd','nacional debito':'tdd',
  'credito':'tdc','tdc':'tdc','tc':'tdc','tarjeta de credito':'tdc','credito nacional':'tdc','nacional credito':'tdc',
  'american express':'amex','americanexpress':'amex','amex':'amex','ax':'amex',
  'internacional':'int','int':'int','internac':'int','intl':'int','international':'int' };
function prodKey(p){ if(p==null||p==='') return null; return PROD[normStr(p)]||null; }

/* ---------- fecha de liquidación T+n (RN-12) ---------- */
let _ferKey=null,_ferSet=null;
function feriadoSet(feriados){ const arr=feriados||[]; const key=arr.join(','); if(key===_ferKey&&_ferSet) return _ferSet;
  _ferKey=key; _ferSet=new Set(arr.map(f=>typeof f==='string'?f:isoFecha(parseFecha(f)))); return _ferSet; }
function esHabil(d,fset){ const w=d.getDay(); if(w===0||w===6) return false; return !fset.has(isoFecha(d)); }
function nEsimoDiaHabil(base,n,fset){ let d=new Date(base),c=0,guard=0;
  while(c<n && guard++<3660){ d=addDays(d,1); if(esHabil(d,fset)) c++; } return d; }
function fechaLiquidacion(fecha,hora,producto,params,feriados){
  const pk=prodKey(producto);
  const esAmex = pk==='amex';
  const pp = esAmex ? params.prodParams.amex : params.prodParams.nacional;
  const fset=feriadoSet(feriados);
  let base=parseFecha(fecha); if(!base) return null;
  if(parseHoraSeg(hora) > parseHoraSeg(pp.corte)) base=addDays(base,1);
  return nEsimoDiaHabil(base, pp.n, fset);
}

/* ---------- concepto de dispersión (RN-13) ---------- */
const ult3=af=>{const s=String(af||'').replace(/\D/g,'');return s.slice(-3).padStart(3,'0');};
const concepto=(af,idGrupo)=>`DISPERSION ${ult3(af)}CPPX00${idGrupo}`;

/* ---------- compensación y dispersión (RN-02..RN-11 / sección 6) ---------- */
// txs: transacciones APROBADAS de un CLIENTE+AFILIACION del corte
// cat: {tasas:{pac_tdd,...,costo_x_trx,pct_banca}, costos:{int_tdd,int_tdc,int_amex,int_int,fee_broxel}}
// ajustes: {financiamientos, contracargos_dom, contracargos_amex}
function calcularCompensacion(txs,cat,params,ajustes){
  const IVA=params.IVA;
  const t=cat.tasas||{}, c=cat.costos||{}, aj=ajustes||{};
  const fin=+aj.financiamientos||0, cc_dom=+aj.contracargos_dom||0, cc_amex=+aj.contracargos_amex||0;
  let num_trx=txs.length, m_tdd=0,m_tdc=0,m_amex=0,m_int=0;
  for(const x of txs){ const k=prodKey(x.producto); const mo=+x.monto||0;
    if(k==='tdd')m_tdd+=mo; else if(k==='tdc')m_tdc+=mo; else if(k==='amex')m_amex+=mo; else if(k==='int')m_int+=mo; }
  const _int_tdd=m_tdd*(c.int_tdd||0), _int_tdc=m_tdc*(c.int_tdc||0),
        _int_amex=m_amex*(c.int_amex!=null?c.int_amex:params.tasa_int_amex),
        _int_int=m_int*(c.int_int!=null?c.int_int:params.tasa_int_int);
  const feeB=(c.fee_broxel!=null?c.fee_broxel:params.fee_broxel);
  const broxel=(m_tdd+m_tdc+m_amex+m_int)*feeB;
  const com_tdd=m_tdd*(t.pac_tdd||0), com_tdc=m_tdc*(t.pac_tdc||0),
        com_amex=m_amex*(t.pac_amex||0), com_int=m_int*(t.pac_int||0),
        com_trx=num_trx*(t.costo_x_trx||0);
  const iva_com_tdd=com_tdd*IVA, iva_com_tdc=com_tdc*IVA, iva_com_amex=com_amex*IVA,
        iva_com_int=com_int*IVA, iva_com_trx=com_trx*IVA;
  const comp_tdd=m_tdd-(com_tdd+iva_com_tdd)-(com_trx+iva_com_trx);
  const comp_tdc=m_tdc-(com_tdc+iva_com_tdc);
  const comp_amex=m_amex-(com_amex+iva_com_amex);
  const comp_int=m_int-(com_int+iva_com_int);
  const comp_total=comp_tdd+comp_tdc+comp_amex+comp_int;
  const pct_banca=(t.pct_banca||0);
  const banca=comp_total*pct_banca, iva_banca=banca*IVA;
  const base_dom=comp_tdd+comp_tdc+comp_int;
  const banca_dom=base_dom*pct_banca, iva_banca_dom=banca_dom*IVA;
  const disp_dom=base_dom-banca_dom-iva_banca_dom-fin-cc_dom;
  const banca_amex=comp_amex*pct_banca, iva_banca_amex=banca_amex*IVA;
  const disp_amex=comp_amex-banca_amex-iva_banca_amex-cc_amex;
  const disp_total=disp_dom+disp_amex;
  const comprobacion=disp_dom+disp_amex;
  const diferencia=comprobacion-disp_total;
  const utilidad=(com_tdd+com_tdc+com_amex+com_int)-(_int_tdd+_int_tdc+_int_amex+_int_int)-broxel;
  return {num_trx,m_tdd,m_tdc,m_amex,m_int,
    int_tdd:_int_tdd,int_tdc:_int_tdc,int_amex:_int_amex,int_int:_int_int,broxel,
    com_tdd,com_tdc,com_amex,com_int,com_trx,
    iva_com_tdd,iva_com_tdc,iva_com_amex,iva_com_int,iva_com_trx,
    comp_tdd,comp_tdc,comp_amex,comp_int,comp_total,
    pct_banca,banca,iva_banca,
    financiamientos:fin,contracargos_dom:cc_dom,contracargos_amex:cc_amex,
    base_dom,disp_dom,disp_amex,disp_total,comprobacion,diferencia,utilidad};
}

/* ---------- parámetros por defecto del ciclo ---------- */
const PARAMS_DEF=()=>({IVA:0.16,tasa_int_amex:0.0247,tasa_int_int:0.0302,fee_broxel:0.0028,
  prodParams:{nacional:{n:1,corte:'23:00'},amex:{n:3,corte:'23:00'}}});

module.exports={
  round2, parseFecha, fmtFecha, isoFecha, addDays, parseHoraSeg, horaStr,
  parseMonto, normStr, prodKey, PROD,
  feriadoSet, esHabil, nEsimoDiaHabil, fechaLiquidacion,
  ult3, concepto, calcularCompensacion, PARAMS_DEF,
};
