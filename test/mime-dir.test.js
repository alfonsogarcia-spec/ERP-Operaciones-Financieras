/* Pruebas de las direcciones del correo (nombres con acentos, comas, comillas, inyección de encabezados).
   Ejecuta: node test/mime-dir.test.js  → sale con código ≠0 si algo falla. */
'use strict';
const { parseDir, fmtDir } = require('../lib/mime-dir.js');
const out = []; const chk = (desc, got, esp) => out.push({ desc, got: JSON.stringify(got), esperado: JSON.stringify(esp), pass: JSON.stringify(got) === JSON.stringify(esp) });
const dec = h => h.replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));

chk('correo suelto', fmtDir('a@b.com'), 'a@b.com');
chk('parse: nombre y correo', parseDir('José <j@x.com>'), { name: 'José', email: 'j@x.com' });
chk('parse: nombre entre comillas', parseDir('"Ana" <a@x.com>'), { name: 'Ana', email: 'a@x.com' });
chk('acentos: el encabezado queda en ASCII', /^[\x00-\x7F]+$/.test(fmtDir('María Núñez <m@x.com>')), true);
chk('acentos: decodifica al nombre original', dec(fmtDir('María Núñez <m@x.com>')), 'María Núñez <m@x.com>');
chk('coma en el nombre no parte la dirección', fmtDir('Pérez, José <j@x.com>').split(',').length, 1);
chk('comillas internas no rompen el encabezado', /"/.test(fmtDir('Ana "La Jefa" Ruiz <a@x.com>')), false);
let err = null; try { fmtDir('x@y.com\r\nBcc: otro@z.com'); } catch (e) { err = e.message; }
chk('inyección de encabezado por saltos de línea se rechaza', /destinatario_invalido/.test(err || ''), true);
err = null; try { fmtDir('Nombre <a@b.com, c@d.com>'); } catch (e) { err = e.message; }
chk('dos correos en un mismo destinatario se rechaza', /destinatario_invalido/.test(err || ''), true);
chk('Destinations usa solo el correo', parseDir('Pérez, José <j@x.com>').email, 'j@x.com');

let pass = 0;
for (const t of out) { console.log((t.pass ? 'PASS  ' : 'FAIL  ') + t.desc + (t.pass ? '' : `  → obtenido ${t.got}, esperado ${t.esperado}`)); if (t.pass) pass++; }
console.log(`\n${pass}/${out.length} pruebas correctas`);
process.exit(pass === out.length ? 0 : 1);
