'use strict';
// Monto de un caso de disputa (contracargo, devolución o duplicado).
// Contracargos y devoluciones guardan el monto del caso (disputed_amount_cifrado / amount_cifrado).
// Los DUPLICADOS lo guardan por transacción (tx_a_monto_cifrado / tx_b_monto_cifrado): el cobro que se
// reclama es el duplicado (B); si solo se capturó el de la primera (A), se usa ese. Antes el correo y las
// pantallas solo leían los dos primeros campos y un duplicado salía con "Monto: —" aunque se hubiera capturado.
// `descifrar` es C.decryptString (se inyecta para poder probar esto sin llaves).
function montoDelCaso(caso, descifrar) {
  const comoNumero = cifrado => {
    if (!cifrado) return null;
    const v = descifrar(cifrado);
    if (v == null || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  for (const c of [caso.disputed_amount_cifrado, caso.amount_cifrado, caso.tx_b_monto_cifrado, caso.tx_a_monto_cifrado]) {
    const n = comoNumero(c);
    if (n != null) return n;
  }
  return null;
}
module.exports = { montoDelCaso };
