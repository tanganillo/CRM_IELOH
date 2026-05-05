/* ── API helpers ─────────────────────────────────────────────────────────── */
const API = {
  get:   (path)       => fetch(path).then(r => r.json()),
  post:  (path, body) => fetch(path, { method: "POST",  headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json()),
  patch: (path, body) => fetch(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json()),
};

/* ── Toast ───────────────────────────────────────────────────────────────── */
function toast(msg, type = "ok") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast toast--${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 3500);
}

/* ── Tabs ────────────────────────────────────────────────────────────────── */
const LOADERS = {
  dashboard: loadDashboard,
  orders:    loadOrders,
  clients:   loadClients,
  catalog:   loadCatalog,
};

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.getElementById(`tab-${tab}`).classList.add("active");
    LOADERS[tab]?.();
  });
});

/* ── Dashboard ───────────────────────────────────────────────────────────── */
async function loadDashboard() {
  const data = await API.get("/api/dashboard");
  document.getElementById("statCount").textContent   = data.today.count;
  document.getElementById("statTotal").textContent   = `$${data.today.total.toLocaleString("es-AR")}`;
  document.getElementById("statClients").textContent = data.totalClients;
  document.getElementById("statPending").textContent = data.today.byStatus.pendiente || 0;
  renderOrderRows("recentBody", data.recentOrders);
}

/* ── Orders ──────────────────────────────────────────────────────────────── */
async function loadOrders() {
  const estado = document.getElementById("filterEstado").value;
  const url    = estado ? `/api/orders?estado=${estado}` : "/api/orders";
  const orders = await API.get(url);
  renderOrderRows("ordersBody", orders);
}

document.getElementById("filterEstado").addEventListener("change", loadOrders);

function renderOrderRows(tbodyId, orders) {
  const tbody = document.getElementById(tbodyId);
  if (!orders?.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="loading">Sin pedidos</td></tr>`;
    return;
  }
  tbody.innerHTML = orders.map(o => `
    <tr>
      <td>${o.id}</td>
      <td>${o.clientes?.nombre || "—"}</td>
      <td>${o.clientes?.telefono || "—"}</td>
      <td>${formatItems(o.items)}</td>
      <td>$${Number(o.total).toLocaleString("es-AR")}</td>
      <td><span class="badge badge--${o.estado}">${o.estado.replace("_"," ")}</span></td>
      <td>${new Date(o.created_at).toLocaleString("es-AR")}</td>
      <td><button class="btn btn--outline btn--sm" onclick="openStatusModal(${o.id}, '${o.estado}')">Cambiar</button></td>
    </tr>`).join("");
}

function formatItems(items) {
  if (!items) return "—";
  const list = Array.isArray(items) ? items : [items];
  return list.map(i => `${i.cantidad}x ${i.nombre}`).join(", ");
}

/* ── Status modal ────────────────────────────────────────────────────────── */
let _currentOrderId = null;

function openStatusModal(id, currentStatus) {
  _currentOrderId = id;
  document.getElementById("modalOrderId").textContent = `#${id}`;
  document.getElementById("modalStatus").value = currentStatus;
  document.getElementById("statusModal").classList.remove("hidden");
}

document.getElementById("btnStatusCancel").addEventListener("click", () => {
  document.getElementById("statusModal").classList.add("hidden");
});

document.getElementById("btnStatusSave").addEventListener("click", async () => {
  const estado = document.getElementById("modalStatus").value;
  try {
    await API.patch("/api/orders", { id: _currentOrderId, estado });
    document.getElementById("statusModal").classList.add("hidden");
    toast(`Pedido #${_currentOrderId} → ${estado}`);
    loadDashboard();
    if (document.getElementById("tab-orders").classList.contains("active")) loadOrders();
  } catch (err) {
    toast("Error al actualizar: " + err.message, "err");
  }
});

/* ── Clients ─────────────────────────────────────────────────────────────── */
async function loadClients() {
  const clients = await API.get("/api/clients");
  const tbody = document.getElementById("clientsBody");
  if (!clients?.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="loading">Sin clientes</td></tr>`;
    return;
  }
  tbody.innerHTML = clients.map(c => `
    <tr>
      <td>${c.id}</td>
      <td>${c.nombre}</td>
      <td>${c.telefono}</td>
      <td>${c.direccion || "—"}</td>
      <td>${new Date(c.created_at).toLocaleDateString("es-AR")}</td>
    </tr>`).join("");
}

/* ── Catalog ─────────────────────────────────────────────────────────────── */
async function loadCatalog() {
  const products = await API.get("/api/catalog?all=true");
  const grid = document.getElementById("catalogGrid");
  if (!products?.length) {
    grid.innerHTML = `<p class="loading">Sin productos</p>`;
    return;
  }
  grid.innerHTML = products.map(p => `
    <div class="product-card">
      <p class="product-card__name">${p.nombre}</p>
      <p class="product-card__desc">${p.descripcion || "Sin descripción"}</p>
      <p class="product-card__price">$${Number(p.precio).toLocaleString("es-AR")}</p>
      <div class="product-card__footer">
        <span class="badge ${p.disponible ? "badge--confirmado" : "badge--cancelado"}">${p.disponible ? "Disponible" : "Oculto"}</span>
        <button class="btn btn--outline btn--sm" onclick="toggleProduct(${p.id}, ${p.disponible})">${p.disponible ? "Ocultar" : "Activar"}</button>
      </div>
    </div>`).join("");
}

async function toggleProduct(id, current) {
  await API.patch("/api/catalog", { id, disponible: !current });
  toast(`Producto ${!current ? "activado" : "ocultado"}`);
  loadCatalog();
}

/* ── Add product modal ───────────────────────────────────────────────────── */
document.getElementById("btnAddProduct").addEventListener("click", () => {
  document.getElementById("productModal").classList.remove("hidden");
});
document.getElementById("btnProdCancel").addEventListener("click", () => {
  document.getElementById("productModal").classList.add("hidden");
});
document.getElementById("btnProdSave").addEventListener("click", async () => {
  const nombre = document.getElementById("pNombre").value.trim();
  const descripcion = document.getElementById("pDesc").value.trim();
  const precio = Number(document.getElementById("pPrecio").value);
  if (!nombre || !precio) { toast("Nombre y precio son requeridos", "err"); return; }
  try {
    await API.post("/api/catalog", { nombre, descripcion, precio });
    document.getElementById("productModal").classList.add("hidden");
    toast("Producto agregado");
    loadCatalog();
  } catch (err) {
    toast("Error: " + err.message, "err");
  }
});

/* ── Sync Sheets ─────────────────────────────────────────────────────────── */
document.getElementById("btnSync").addEventListener("click", async () => {
  document.getElementById("btnSync").textContent = "Sincronizando…";
  try {
    const res = await API.post("/api/sync-sheets", {});
    toast(`Sincronizado: ${res.orders} pedidos, ${res.clients} clientes`);
  } catch (err) {
    toast("Error al sincronizar: " + err.message, "err");
  } finally {
    document.getElementById("btnSync").textContent = "⟳ Sync Sheets";
  }
});

/* ── Broadcast ───────────────────────────────────────────────────────────── */
document.getElementById("btnBroadcast").addEventListener("click", async () => {
  if (!confirm("¿Enviar difusión a clientes sin pedido en los últimos 7 días?")) return;
  document.getElementById("btnBroadcast").textContent = "Enviando…";
  try {
    const res = await API.post("/api/broadcast", { days: 7 });
    toast(`Difusión enviada: ${res.sent}/${res.total} mensajes`);
  } catch (err) {
    toast("Error en difusión: " + err.message, "err");
  } finally {
    document.getElementById("btnBroadcast").textContent = "📣 Difusión";
  }
});

/* ── Init ────────────────────────────────────────────────────────────────── */
loadDashboard();
