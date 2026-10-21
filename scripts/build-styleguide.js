#!/usr/bin/env node
// Genera docs/design-system.html: guía de estilos viva del sistema de diseño.
// Toma el <style> de index.html (única fuente de verdad) y le pone componentes de muestra,
// así la guía nunca se desfasa de la app.   Uso:  node scripts/build-styleguide.js
const fs = require('fs'), path = require('path');
const raiz = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));

const swatch = (v, nota) => `<div class="sw"><span class="sw-c" style="background:var(${v})"></span><code>${v}</code><small>${nota || ''}</small></div>`;
const grupoSw = (titulo, items) => `<h4>${titulo}</h4><div class="sw-grid">${items.map(i => swatch(i[0], i[1])).join('')}</div>`;
const tonos = [['neutral', 'Sin estado / cerrado'], ['info', 'Nuevo · notificado'], ['ok', 'Ganado · cerrado ok'], ['warn', 'Por atender'], ['danger', 'Perdido · vencido · error'], ['violet', 'Evidencia · dispersado'], ['teal', 'En revisión'], ['orange', 'En disputa con la marca'], ['indigo', 'Representado'], ['soft', 'Cerrado sin resultado']];

const pagina = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Sistema de diseño · Polipay</title>
<style>
${css}
/* --- solo para esta guía --- */
body{padding:var(--sp-6) var(--sp-6) 80px;max-width:1180px;margin:0 auto}
.g-head{display:flex;flex-wrap:wrap;gap:var(--sp-4);align-items:flex-end;justify-content:space-between;margin-bottom:var(--sp-6)}
.g-head h1{margin:0;font-size:var(--fs-3xl);letter-spacing:-.01em;color:var(--brand)}
.g-head p{margin:var(--sp-1) 0 0;color:var(--muted)}
.g-ctl{display:flex;gap:var(--sp-2);flex-wrap:wrap;align-items:center}
.g-ctl .tabs{margin:0}
section.panel h3{font-size:var(--fs-xl)}
section.panel h4{margin:var(--sp-5) 0 var(--sp-2);font-size:var(--fs-sm);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.row{display:flex;flex-wrap:wrap;gap:var(--sp-3);align-items:center}
.sw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:var(--sp-2) var(--sp-4)}
.sw{display:grid;grid-template-columns:28px 1fr;gap:0 var(--sp-2);align-items:center;font-size:var(--fs-sm)}
.sw-c{width:28px;height:28px;border-radius:var(--radius-xs);border:1px solid var(--line-strong);grid-row:span 2}
.sw code{font-size:var(--fs-xs)} .sw small{color:var(--muted);font-size:var(--fs-xs)}
.ts{display:grid;grid-template-columns:90px 1fr;gap:var(--sp-1) var(--sp-4);align-items:baseline}
.ts code{color:var(--muted);font-size:var(--fs-xs)}
.sp{display:flex;align-items:flex-end;gap:var(--sp-3);flex-wrap:wrap}
.sp div{background:var(--accent);border-radius:2px;min-width:4px}
.sp span{display:block;font-size:var(--fs-xs);color:var(--muted);margin-top:var(--sp-1)}
.rd{width:84px;height:56px;background:var(--glass-3);border:1px solid var(--line-strong);display:grid;place-items:center;font-size:var(--fs-xs)}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:var(--sp-5);align-items:start}
.dd{display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-3);margin-top:var(--sp-3)}
.dd>div{padding:var(--sp-3);border-radius:var(--radius-sm);font-size:var(--fs-md);line-height:1.5}
.dd .do{background:var(--ok-tint);border:1px solid var(--ok-edge)} .dd .dont{background:var(--danger-tint);border:1px solid var(--danger-edge)}
.dd b{display:block;margin-bottom:var(--sp-1)}
.ct{width:100%;font-size:var(--fs-sm)} .ct td,.ct th{padding:var(--sp-2) var(--sp-3)}
.ct .r{font-weight:var(--fw-bold);font-variant-numeric:tabular-nums}
.ok-r{color:var(--ok-ink)} .bad-r{color:var(--danger-ink)}
.stage{position:relative;padding:var(--sp-5);border:1px dashed var(--line-strong);border-radius:var(--radius);display:grid;place-items:center;min-height:200px;min-width:0}
.stage .modal{position:static;max-height:none;box-shadow:var(--shadow);width:100%;max-width:100%;min-width:0}
.toasts{display:flex;gap:var(--sp-3);flex-wrap:wrap}
.toasts .toast{position:static;opacity:1;transform:none}
@media(max-width:700px){.dd{grid-template-columns:1fr} body{padding:var(--sp-4) var(--sp-4) 60px}}
</style></head>
<body>
<header class="g-head">
  <div><h1>Sistema de diseño Polipay</h1><p>Guía viva generada desde <code>index.html</code> · vidrio translúcido · claro / oscuro · 3 paletas</p></div>
  <div class="g-ctl">
    <div class="tabs" role="group" aria-label="Modo"><button class="tab" data-m="sistema">Sistema</button><button class="tab" data-m="light">Claro</button><button class="tab" data-m="dark">Oscuro</button></div>
    <div class="tabs" role="group" aria-label="Paleta"><button class="tab" data-p="azul">Ártico</button><button class="tab" data-p="violeta">Violeta</button><button class="tab" data-p="grafito">Grafito</button></div>
  </div>
</header>

<section class="panel" id="tokens"><h3>1 · Tokens</h3>
  <p class="muted">Los componentes solo leen tokens. Cambiar un token cambia toda la app (y las 3 paletas, y el modo oscuro).</p>
  ${grupoSw('Marca y acento', [['--accent', 'Bordes, foco, acentos gráficos'], ['--accent-fill', 'Relleno con texto blanco (≥4.5:1)'], ['--accent-fill-hi', 'Inicio del degradado del botón'], ['--accent-ink', 'Acento como TEXTO'], ['--accent-soft', 'Fondo suave / hover'], ['--brand', 'Títulos y énfasis']])}
  ${grupoSw('Superficies de vidrio', [['--bg', 'Fondo de página'], ['--panel', 'Panel, tarjeta'], ['--panel-strong', 'Modal, login'], ['--glass-1', 'Discreto (ghost)'], ['--glass-2', 'Controles'], ['--glass-3', 'Hover de controles'], ['--glass-4', 'Campo con foco'], ['--bar', 'Cabecera/pie fijos'], ['--line', 'Divisores'], ['--line-strong', 'Bordes de campo']])}
  ${grupoSw('Texto', [['--ink', 'Texto principal'], ['--muted', 'Secundario (≥4.5:1)'], ['--on-fill', 'Texto sobre relleno']])}
  ${grupoSw('Semánticos (relleno · texto)', [['--ok', 'Positivo'], ['--ok-ink', 'Texto positivo'], ['--danger', 'Error / destructivo'], ['--danger-ink', 'Texto error'], ['--warn-fill', 'Atención (amarillo)'], ['--warn', 'Texto ámbar'], ['--violet', 'Evidencia'], ['--c-teal', 'En revisión'], ['--c-orange', 'En disputa'], ['--c-indigo', 'Representado'], ['--c-neutral', 'Neutro'], ['--c-deep', 'Acción profunda']])}
  <h4>Tipografía (Montserrat) — escala de 8 pasos, mínimo 11px</h4>
  <div class="ts">${[['--fs-xs', '11px · etiquetas, badges, encabezados de tabla'], ['--fs-sm', '12px · apoyo, hints, botón sm'], ['--fs-md', '13px · tablas, botones, formularios'], ['--fs-base', '14px · cuerpo'], ['--fs-lg', '16px · títulos de panel y de diálogo'], ['--fs-xl', '20px · título de login / sección'], ['--fs-2xl', '24px · título de página'], ['--fs-3xl', '28px · cifras KPI']].map(([t, n]) => `<code>${t}</code><div style="font-size:var(${t})">${n}</div>`).join('')}</div>
  <h4>Espaciado (base 4px)</h4>
  <div class="sp">${[1, 2, 3, 4, 5, 6, 8, 10].map(n => `<div style="width:var(--sp-${n});height:var(--sp-${n})"></div><span>--sp-${n}</span>`).join('')}</div>
  <h4>Radios y elevación</h4>
  <div class="row">${[['--radius-xs', '8'], ['--radius-sm', '12'], ['--radius', '18'], ['--radius-lg', '24'], ['--radius-pill', 'pill']].map(([t, n]) => `<div class="rd" style="border-radius:var(${t})">${n}</div>`).join('')}
    <div class="rd" style="box-shadow:var(--shadow)">--shadow</div><div class="rd" style="box-shadow:var(--shadow-lg)">--shadow-lg</div></div>
</section>

<section class="panel" id="botones"><h3>2 · Botón</h3>
  <p class="muted">Una acción principal por pantalla. Destructivo = contorno rojo; estado = relleno.</p>
  <h4>Variantes</h4><div class="row"><button class="btn">Primario</button><button class="btn secondary">Secundario</button><button class="btn ghost">Ghost</button><button class="btn danger">Eliminar</button><button class="btn ok">Confirmar</button><button class="btn deep">Profundo</button><button class="btn violet">Violeta</button><button class="btn amber">Ámbar</button></div>
  <h4>Tamaño y estados</h4><div class="row"><button class="btn sm">Pequeño</button><button class="btn" disabled>Deshabilitado</button><button class="btn loading" aria-busy="true">Cargando</button><button class="btn" id="foco-demo">Foco (pulsa Tab)</button></div>
  <div class="dd"><div class="do"><b>Hacer</b>Verbo concreto: “Enviar correo”, “Liberar contracargo”. El diálogo de confirmación repite el verbo.</div><div class="dont"><b>Evitar</b>Estilos en línea con hex (<code>background:#0F56AC</code>). Usa <code>.btn.deep</code> u otra variante.</div></div>
</section>

<section class="panel" id="badges"><h3>3 · Badge y pill</h3>
  <p class="muted">Un solo componente; el tono se nombra por significado, no por letra. Texto siempre con ≥4.5:1.</p>
  <div class="row">${tonos.map(([t, n]) => `<span class="badge ${t}">${t}</span>`).join('')}<span class="pill">pill</span><span class="dept">dept</span></div>
  <h4>Uso por estado de disputa</h4>
  <table class="ct"><tbody>${tonos.map(([t, n]) => `<tr><td><span class="badge ${t}">${t}</span></td><td>${n}</td></tr>`).join('')}</tbody></table>
  <div class="dd"><div class="do"><b>Hacer</b><code>class="badge danger"</code> · mapa estado→tono en un solo lugar (<code>badgeEstadoDisp</code>).</div><div class="dont"><b>Evitar</b>Nombres por letra (<code>badge g</code>, <code>badge d</code>) o color directo en línea.</div></div>
</section>

<section class="panel" id="datos"><h3>4 · Tarjetas, tablas y pasos</h3>
  <div class="cards"><div class="card"><div class="label">Monto transaccionado</div><div class="value">$1,104,510.37</div><div class="hint">942 aprobadas</div></div><div class="card ok"><div class="label">A dispersar</div><div class="value">$500.00</div><div class="hint">Borrador</div></div><div class="card alert"><div class="label">CB vencidos</div><div class="value">3</div><div class="hint">Más de 3 días</div></div></div>
  <div class="tablewrap"><table><thead><tr><th>Corte</th><th class="num">A dispersar</th><th>Estado</th></tr></thead><tbody>
    <tr tabindex="0" style="cursor:pointer"><td><div class="tt">#98<small>01/10/2026</small></div></td><td class="num">$500.00</td><td><span class="badge neutral">Borrador</span></td></tr>
    <tr tabindex="0" style="cursor:pointer"><td><div class="tt">#97<small>30/09/2026</small></div></td><td class="num">$12,480.10</td><td><span class="badge ok">Cerrado</span></td></tr></tbody></table></div>
  <h4>Pasos y tabs</h4><div class="steps"><div class="step done"><span class="n">✓</span>Ingesta</div><div class="step cur"><span class="n">2</span>Corte</div><div class="step"><span class="n">3</span>Dispersión</div></div>
  <div class="tabs" role="tablist"><button class="tab active" role="tab" aria-selected="true">PLD</button><button class="tab" role="tab" aria-selected="false">Antifraude</button><button class="tab" role="tab" aria-selected="false">Alertas</button></div>
</section>

<section class="panel" id="forms"><h3>5 · Formularios y avisos</h3>
  <div class="form-grid"><label class="field">Normal<input value="Texto"></label><label class="field">Con foco (pulsa Tab)<input id="in-foco" value="Foco"></label><label class="field">Deshabilitado<input value="No editable" disabled></label><label class="field invalid">Con error<input value="abc" aria-invalid="true"><span class="field-err">Escribe un importe válido, por ejemplo 1,250.00</span></label></div>
  <div class="banner">Información: el corte se calcula con la hora configurada.</div><div class="banner ok">Correcto: el corte cuadra.</div><div class="banner warn">Atención: faltan datos de 2 afiliaciones.</div><div class="banner err">Error: la CLABE debe tener 18 dígitos.</div>
</section>

<section class="panel" id="dialogos"><h3>6 · Diálogos y avisos flotantes</h3>
  <p class="muted">Todos con <code>role</code>, Escape para cerrar, foco atrapado y devuelto a quien lo abrió. En la app: <code>modal()</code>, <code>confirmar()</code>, <code>pedir()</code> y <code>toast()</code>.</p>
  <div class="cols"><div class="stage"><div class="modal confirm" role="alertdialog" aria-label="Confirmar"><div class="mh"><h3>Confirma esta acción</h3></div><div class="mb"><p>¿Eliminar contracargo 2026-000039?</p></div><div class="mf"><button class="btn secondary">Volver</button><button class="btn danger">Eliminar</button></div></div></div>
  <div class="stage"><div class="modal" role="dialog" aria-label="Editar"><div class="mh"><h3>Editar cuenta</h3><button class="x" aria-label="Cerrar">×</button></div><div class="mb"><label class="field">Banco<input value="BBVA"></label></div><div class="mf"><button class="btn secondary">Cancelar</button><button class="btn">Guardar</button></div></div></div></div>
  <h4>Toast</h4><div class="toasts"><div class="toast">Guardado</div><div class="toast ok">Corte validado</div><div class="toast err">No se pudo enviar el correo</div></div>
</section>

<section class="panel" id="contraste"><h3>7 · Contraste en vivo</h3>
  <p class="muted">Se recalcula con el modo y la paleta activos. Meta: ≥4.5:1 en texto normal.</p>
  <table class="ct"><thead><tr><th>Par</th><th class="num">Ratio</th><th>AA</th></tr></thead><tbody id="ct-body"></tbody></table>
</section>

<script>
(function(){
  var R=document.documentElement;
  function setM(m){ if(m==='sistema')R.removeAttribute('data-theme'); else R.setAttribute('data-theme',m); mark(); calc(); }
  function setP(p){ if(p==='azul')R.removeAttribute('data-palette'); else R.setAttribute('data-palette',p); mark(); calc(); }
  function mark(){
    var m=R.getAttribute('data-theme')||'sistema', p=R.getAttribute('data-palette')||'azul';
    document.querySelectorAll('[data-m]').forEach(function(b){var on=b.dataset.m===m;b.classList.toggle('active',on);b.setAttribute('aria-pressed',on);});
    document.querySelectorAll('[data-p]').forEach(function(b){var on=b.dataset.p===p;b.classList.toggle('active',on);b.setAttribute('aria-pressed',on);});
  }
  document.querySelectorAll('[data-m]').forEach(function(b){b.onclick=function(){setM(b.dataset.m)}});
  document.querySelectorAll('[data-p]').forEach(function(b){b.onclick=function(){setP(b.dataset.p)}});
  var q=new URLSearchParams(location.search); if(q.get('m'))setM(q.get('m')); if(q.get('p'))setP(q.get('p'));
  function parse(c){var m=c.match(/rgba?\\(([^)]+)\\)/);if(!m)return null;var p=m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);return{r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1};}
  function over(t,b){var a=t.a;return{r:t.r*a+b.r*(1-a),g:t.g*a+b.g*(1-a),b:t.b*a+b.b*(1-a),a:1};}
  function lum(c){var f=function(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return .2126*f(c.r)+.7152*f(c.g)+.0722*f(c.b);}
  function cr(a,b){var x=lum(a),y=lum(b);if(x<y){var t=x;x=y;y=t;}return(x+.05)/(y+.05);}
  function bgOf(el,root){var ch=[];for(var n=el;n&&n.nodeType===1;n=n.parentElement){var c=parse(getComputedStyle(n).backgroundColor);if(c&&c.a>0)ch.push(c);}var base=root;for(var i=ch.length-1;i>=0;i--)base=over(ch[i],base);return base;}
  function calc(){
    var root=parse(getComputedStyle(document.body).backgroundColor), rows=[];
    var pares=[['Texto principal sobre panel','.card .value'],['Texto secundario (muted) sobre panel','.card .label'],['Botón primario (blanco / degradado)','.btn:not(.secondary):not(.ghost):not(.danger):not(:disabled)'],['Botón ok','.btn.ok'],['Botón ámbar','.btn.amber']]
      .concat(${JSON.stringify(tonos.map(t => ['Badge ' + t[0], '.badge.' + t[0]]))})
      .concat([['Banner info','.banner:not(.ok):not(.warn):not(.err)'],['Banner ok','.banner.ok'],['Banner atención','.banner.warn'],['Banner error','.banner.err'],['Enlace/acento como texto','.step.cur'],['Encabezado de tabla','thead th']]);
    pares.forEach(function(p){var el=document.querySelector(p[1]);if(!el)return;var cs=getComputedStyle(el),bg=bgOf(el,root),fg=over(parse(cs.color),bg);
      // si el fondo es degradado, evalúa el extremo más claro
      var bi=cs.backgroundImage; if(bi&&bi.indexOf('gradient')>-1){var cols=bi.match(/rgba?\\([^)]+\\)/g)||[];cols.forEach(function(c){var b2=over(parse(c),root);var r2=cr(fg,b2);rows.push([p[0]+' (extremo)',r2]);});return;}
      rows.push([p[0],cr(fg,bg)]);});
    document.getElementById('ct-body').innerHTML=rows.map(function(r){var ok=r[1]>=4.5;return '<tr><td>'+r[0]+'</td><td class="num r '+(ok?'ok-r':'bad-r')+'">'+r[1].toFixed(2)+'</td><td>'+(ok?'✓':'✗')+'</td></tr>';}).join('');
    window.__ctFail=rows.filter(function(r){return r[1]<4.5}).map(function(r){return r[0]+' '+r[1].toFixed(2)});
  }
  mark(); calc();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',calc);
})();
</script></body></html>
`;
fs.mkdirSync(path.join(raiz, 'docs'), { recursive: true });
fs.writeFileSync(path.join(raiz, 'docs', 'design-system.html'), pagina);
console.log('docs/design-system.html generado (' + Math.round(pagina.length / 1024) + ' KB)');
