const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "[supabase] ERROR: credenciales no configuradas. " +
    "Definí SUPABASE_URL y SUPABASE_SECRET_KEY (o SUPABASE_SERVICE_ROLE_KEY) en las variables de entorno."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Clientes ────────────────────────────────────────────────────────────────

async function getClientByPhone(telefono) {
  const { data, error } = await supabase
    .from("clientes")
    .select("*")
    .eq("telefono", telefono)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertClient({ telefono, nombre, direccion, tipo_cliente, estado_aprobacion, codigo_legacy }) {
  const payload = { telefono, nombre, direccion };
  if (tipo_cliente !== undefined) payload.tipo_cliente = tipo_cliente;
  if (estado_aprobacion !== undefined) payload.estado_aprobacion = estado_aprobacion;
  if (codigo_legacy !== undefined) payload.codigo_legacy = codigo_legacy;

  const { data, error } = await supabase
    .from("clientes")
    .upsert(payload, { onConflict: "telefono" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getClientByCodigoLegacy(codigo_legacy) {
  const { data, error } = await supabase
    .from("clientes")
    .select("*")
    .eq("codigo_legacy", codigo_legacy)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Vincula un WhatsApp nuevo a un registro de comercio ya dado de alta (matcheado por
// codigo_legacy). El registro legacy ya tiene tipo_cliente/estado_aprobacion correctos
// desde el backfill, pero se reafirman acá por si el dato de alta manual llegara a faltar.
async function linkPhoneToClient(id, telefono) {
  const { data, error } = await supabase
    .from("clientes")
    .update({ telefono, tipo_cliente: "comercio", estado_aprobacion: "aprobado" })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Reclasifica un cliente YA existente (con su propia fila por teléfono real) a comercio,
// absorbiendo los datos de negocio de una fila legacy (telefono placeholder "imp_NNN") que
// matcheó por codigo_legacy. La fila real conserva su `id` -- así pedidos.cliente_id nunca
// se toca -- y la fila legacy se borra al final (nunca tiene pedidos propios, así que
// ON DELETE RESTRICT no debería bloquearlo nunca; si lo hiciera, mejor que falle fuerte acá
// que perder el error en silencio). `nombre` de la fila real NO se pisa a propósito: se
// preserva el nombre de WhatsApp de la persona, no el nombre del comercio.
async function mergeLegacyIntoClient(clientId, legacyRecord) {
  const { data: client, error: clientErr } = await supabase
    .from("clientes")
    .select("direccion")
    .eq("id", clientId)
    .single();
  if (clientErr) throw clientErr;

  const { error: deleteErr } = await supabase.from("clientes").delete().eq("id", legacyRecord.id);
  if (deleteErr) throw deleteErr;

  const payload = {
    tipo_cliente: "comercio",
    estado_aprobacion: "aprobado",
    codigo_legacy: legacyRecord.codigo_legacy,
    zona: legacyRecord.zona,
    saldo_inicial: legacyRecord.saldo_inicial,
  };
  if (!client.direccion) payload.direccion = legacyRecord.direccion;

  const { data, error } = await supabase
    .from("clientes")
    .update(payload)
    .eq("id", clientId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// codigo_legacy para comercios nuevos que se dan de alta desde WhatsApp sin match previo.
// Arranca en 900000 (los códigos legacy importados del Excel llegan hasta ~425) para que
// nunca choquen con altas futuras del sistema legacy, e incrementa desde el último usado.
const PENDING_CODIGO_BASE = 900000;

async function nextPendingCodigoLegacy() {
  const { data, error } = await supabase
    .from("clientes")
    .select("codigo_legacy")
    .gte("codigo_legacy", PENDING_CODIGO_BASE)
    .order("codigo_legacy", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data?.codigo_legacy || PENDING_CODIGO_BASE - 1) + 1;
}

async function getClientsWithoutRecentOrder(days = 7) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data: active, error } = await supabase
    .from("clientes")
    .select(`id, telefono, nombre, pedidos(id, created_at)`)
    .order("created_at", { foreignTable: "pedidos", ascending: false });
  if (error) throw error;

  return active.filter((c) => {
    if (!c.pedidos || c.pedidos.length === 0) return true;
    const last = new Date(c.pedidos[0].created_at);
    return last < since;
  });
}

// ── Pedidos ──────────────────────────────────────────────────────────────────

async function createOrder({ cliente_id, items, total }) {
  const { data, error } = await supabase
    .from("pedidos")
    .insert({ cliente_id, items, total, estado: "pendiente" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getOrdersByClient(cliente_id) {
  const { data, error } = await supabase
    .from("pedidos")
    .select("*")
    .eq("cliente_id", cliente_id)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

async function getLastOrderByClient(cliente_id) {
  const { data, error } = await supabase
    .from("pedidos")
    .select("*")
    .eq("cliente_id", cliente_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function updateOrderItems(id, { items, total }) {
  const { data, error } = await supabase
    .from("pedidos")
    .update({ items, total })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateOrderStatus(id, estado) {
  const VALID = ["pendiente", "confirmado", "en_camino", "entregado", "cancelado"];
  if (!VALID.includes(estado)) throw new Error(`Estado inválido: ${estado}`);

  const { data, error } = await supabase
    .from("pedidos")
    .update({ estado })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getAllOrders({ limit = 100, offset = 0, estado } = {}) {
  let query = supabase
    .from("pedidos")
    .select(`*, clientes(nombre, telefono)`)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (estado) query = query.eq("estado", estado);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function getDailySummary() {
  const today = new Date().toISOString().split("T")[0];
  const { data, error } = await supabase
    .from("pedidos")
    .select("estado, total")
    .gte("created_at", `${today}T00:00:00`)
    .lte("created_at", `${today}T23:59:59`);
  if (error) throw error;

  return data.reduce(
    (acc, p) => {
      acc.total += Number(p.total) || 0;
      acc.count += 1;
      acc.byStatus[p.estado] = (acc.byStatus[p.estado] || 0) + 1;
      return acc;
    },
    { total: 0, count: 0, byStatus: {} }
  );
}

// ── Sesiones de conversación (WhatsApp) ─────────────────────────────────────────
// Reemplaza el objeto en memoria del webhook: persiste el estado de la conversación
// (awaitingQuantityFor, pendingOrder, etc.) para que sobreviva a cold starts o a que
// dos mensajes seguidos del mismo cliente caigan en contenedores distintos.

async function getSession(telefono) {
  const { data, error } = await supabase
    .from("sesiones")
    .select("estado")
    .eq("telefono", telefono)
    .maybeSingle();
  if (error) throw error;
  return data?.estado || {};
}

async function saveSession(telefono, estado) {
  const { error } = await supabase
    .from("sesiones")
    .upsert({ telefono, estado, updated_at: new Date().toISOString() }, { onConflict: "telefono" });
  if (error) throw error;
}

async function clearSession(telefono) {
  const { error } = await supabase.from("sesiones").delete().eq("telefono", telefono);
  if (error) throw error;
}

// ── Catálogo ─────────────────────────────────────────────────────────────────

async function getCatalog(soloDisponible = true) {
  let query = supabase.from("catalogo").select("*").order("nombre");
  if (soloDisponible) query = query.eq("disponible", true);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// ── Repartidores ──────────────────────────────────────────────────────────────

async function getRepartidores() {
  const { data, error } = await supabase
    .from("repartidores")
    .select("*")
    .order("nombre");
  if (error) throw error;
  return data;
}

async function createRepartidor({ nombre, telefono, camioneta, turno, zona }) {
  const { data, error } = await supabase
    .from("repartidores")
    .insert({ nombre, telefono, camioneta, turno, zona })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateRepartidor(id, fields) {
  const allowed = ["nombre", "telefono", "camioneta", "turno", "disponible", "pedidos_del_dia", "zona"];
  const update = Object.fromEntries(
    Object.entries(fields).filter(([k]) => allowed.includes(k))
  );
  const { data, error } = await supabase
    .from("repartidores")
    .update(update)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateRepartidorLocation(id, latitud, longitud) {
  const { data, error } = await supabase
    .from("repartidores")
    .update({ latitud, longitud, ultima_actualizacion: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Archivado de pedidos ──────────────────────────────────────────────────────

async function getOrdersOlderThan(days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const { data, error } = await supabase
    .from("pedidos")
    .select("*, clientes(nombre, telefono)")
    .lt("created_at", cutoff.toISOString())
    .in("estado", ["entregado", "cancelado"])
    .eq("archived", false);
  if (error) throw error;
  return data;
}

async function markOrdersAsArchived(ids) {
  const { error } = await supabase
    .from("pedidos")
    .update({ archived: true })
    .in("id", ids);
  if (error) throw error;
}

module.exports = {
  supabase,
  getClientByPhone,
  createRepartidor,
  upsertClient,
  getClientByCodigoLegacy,
  linkPhoneToClient,
  mergeLegacyIntoClient,
  nextPendingCodigoLegacy,
  getClientsWithoutRecentOrder,
  createOrder,
  getOrdersByClient,
  getLastOrderByClient,
  updateOrderItems,
  updateOrderStatus,
  getAllOrders,
  getDailySummary,
  getSession,
  saveSession,
  clearSession,
  getCatalog,
  getRepartidores,
  updateRepartidor,
  updateRepartidorLocation,
  getOrdersOlderThan,
  markOrdersAsArchived,
};
