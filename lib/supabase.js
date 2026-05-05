const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

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

async function upsertClient({ telefono, nombre, direccion }) {
  const { data, error } = await supabase
    .from("clientes")
    .upsert({ telefono, nombre, direccion }, { onConflict: "telefono" })
    .select()
    .single();
  if (error) throw error;
  return data;
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

// ── Catálogo ─────────────────────────────────────────────────────────────────

async function getCatalog(soloDisponible = true) {
  let query = supabase.from("catalogo").select("*").order("nombre");
  if (soloDisponible) query = query.eq("disponible", true);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

module.exports = {
  supabase,
  getClientByPhone,
  upsertClient,
  getClientsWithoutRecentOrder,
  createOrder,
  getOrdersByClient,
  getLastOrderByClient,
  updateOrderStatus,
  getAllOrders,
  getDailySummary,
  getCatalog,
};
