// Precio dual por tipo_cliente (particular/comercio). Ver migración 005 y CLAUDE.md.
//
// `precio_particular` es el fallback seguro por defecto (el más caro) para cualquier
// tipo_cliente que no sea exactamente "comercio" -- incluye clientes viejos sin el campo
// poblado o valores nuevos que se agreguen a futuro sin actualizar este archivo.
function priceForClient(product, tipoCliente) {
  const dual = tipoCliente === "comercio" ? product.precio_comercio : product.precio_particular;
  // dual puede venir NULL en productos que todavía no tienen precio dual cargado -- `precio`
  // (la columna vieja) queda de respaldo hasta confirmar que la migración está completa.
  return Number(dual != null ? dual : product.precio);
}

// Resuelve el precio de cada producto del catálogo para un cliente puntual, una sola vez,
// para que el resto del código (armar la lista de WhatsApp, calcular subtotales, el prompt
// de Claude, etc.) siga leyendo `producto.precio` sin tener que conocer tipo_cliente.
function withClientPricing(catalog, tipoCliente) {
  return catalog.map((p) => ({ ...p, precio: priceForClient(p, tipoCliente) }));
}

module.exports = { priceForClient, withClientPricing };
