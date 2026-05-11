/* ── Supabase Auth ─────────────────────────────────────────────────────────── */
let sb = null; // Supabase client (inicializado después de cargar config)

async function initAuth() {
  const cfg = await fetch("/api/config").then((r) => r.json());
  sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  sb.auth.onAuthStateChange((_event, session) => {
    if (session) {
      document.getElementById("authScreen").style.display    = "none";
      document.getElementById("dashboardApp").style.display  = "block";
      const email = session.user?.email || "";
      document.getElementById("userEmail").textContent = email;
      loadDashboard();
    } else {
      document.getElementById("authScreen").style.display    = "flex";
      document.getElementById("dashboardApp").style.display  = "none";
    }
  });

  // Verificar sesión inicial
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    document.getElementById("authScreen").style.display = "flex";
  }
}

document.getElementById("btnGoogleLogin").addEventListener("click", async () => {
  if (!sb) return;
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
  if (error) {
    const el = document.getElementById("authError");
    el.textContent = error.message;
    el.classList.remove("hidden");
  }
});

document.getElementById("btnLogout").addEventListener("click", async () => {
  await sb?.auth.signOut();
});

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
  map:       loadMap,
  orders:    loadOrders,
  drivers:   loadDrivers,
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
      <td>
        <button class="btn btn--outline btn--sm" onclick="openStatusModal(${o.id}, '${o.estado}')">Cambiar</button>
        ${["pendiente","confirmado"].includes(o.estado)
          ? `<button class="btn btn--outline btn--sm" onclick="notifyNearby(${o.id})" title="Notificar repartidor cercano">📍</button>`
          : ""}
      </td>
    </tr>`).join("");
}

function formatItems(items) {
  if (!items) return "—";
  const list = Array.isArray(items) ? items : [items];
  return list.map(i => `${i.cantidad}x ${i.nombre}`).join(", ");
}

/* ── Notificar repartidor cercano ───────────────────────────────────────── */
async function notifyNearby(pedidoId) {
  try {
    const res = await API.post("/api/nearby-delivery", { pedido_id: pedidoId });
    if (res.found) {
      toast(`✅ ${res.repartidor} notificado (${res.distancia} km)`);
    } else {
      toast(`Sin repartidores cercanos: ${res.reason}`, "err");
    }
  } catch (err) {
    toast("Error al buscar repartidor: " + err.message, "err");
  }
}

window.notifyNearby = notifyNearby;

/* ── Status modal ────────────────────────────────────────────────────────── */
let _currentOrderId = null;

function openStatusModal(id, currentStatus) {
  _currentOrderId = id;
  document.getElementById("modalOrderId").textContent = `#${id}`;
  document.getElementById("modalStatus").value = currentStatus;
  document.getElementById("statusModal").classList.remove("hidden");
}

window.openStatusModal = openStatusModal;

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

/* ── Repartidores ────────────────────────────────────────────────────────── */
async function loadDrivers() {
  const drivers = await API.get("/api/repartidores");
  const grid    = document.getElementById("driversGrid");
  if (!drivers?.length) {
    grid.innerHTML = `<p class="loading">Sin repartidores</p>`;
    return;
  }
  grid.innerHTML = drivers.map(d => {
    const lastSeen = d.ultima_actualizacion
      ? new Date(d.ultima_actualizacion).toLocaleString("es-AR")
      : "Sin datos";
    const gpsAge   = d.ultima_actualizacion
      ? Math.floor((Date.now() - new Date(d.ultima_actualizacion)) / 60_000)
      : null;
    const gpsOk   = gpsAge != null && gpsAge < 15;
    return `
    <div class="driver-card">
      <div class="driver-card__header">
        <span class="driver-card__name">${d.nombre}</span>
        <span class="badge ${d.disponible ? "badge--confirmado" : "badge--cancelado"}">
          ${d.disponible ? "Disponible" : "No disponible"}
        </span>
      </div>
      <div class="driver-card__info">
        <span>🚐 ${d.camioneta.replace("_", " ")}</span>
        <span>⏰ Turno ${d.turno}</span>
        <span>📦 ${d.pedidos_del_dia} pedidos hoy</span>
      </div>
      <div class="driver-card__gps">
        <span class="gps-dot ${gpsOk ? "gps-dot--on" : "gps-dot--off"}"></span>
        ${gpsOk ? `GPS activo (${gpsAge}min atrás)` : `GPS inactivo · ${lastSeen}`}
      </div>
      <div class="driver-card__actions">
        <button class="btn btn--outline btn--sm"
          onclick="toggleDriver(${d.id}, ${d.disponible})">
          ${d.disponible ? "Marcar no disponible" : "Marcar disponible"}
        </button>
      </div>
    </div>`;
  }).join("");
}

async function toggleDriver(id, current) {
  await API.patch("/api/repartidores", { id, disponible: !current });
  toast(`Repartidor ${!current ? "habilitado" : "deshabilitado"}`);
  loadDrivers();
  if (_map) refreshMapDrivers();
}

window.toggleDriver = toggleDriver;

/* ── Agregar repartidor modal ────────────────────────────────────────────── */
document.getElementById("btnAddDriver").addEventListener("click", () => {
  ["dNombre", "dTelefono"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("dCamioneta").value = "camioneta_1";
  document.getElementById("dTurno").value     = "manana";
  document.getElementById("dZona").value      = "";
  document.getElementById("driverModal").classList.remove("hidden");
});

document.getElementById("btnDriverCancel").addEventListener("click", () => {
  document.getElementById("driverModal").classList.add("hidden");
});

document.getElementById("btnDriverSave").addEventListener("click", async () => {
  const nombre    = document.getElementById("dNombre").value.trim();
  const telefono  = document.getElementById("dTelefono").value.trim();
  const camioneta = document.getElementById("dCamioneta").value;
  const turno     = document.getElementById("dTurno").value;
  const zona      = document.getElementById("dZona").value || null;

  if (!nombre || !telefono) {
    toast("Nombre y teléfono son requeridos", "err");
    return;
  }

  try {
    await API.post("/api/repartidores", { nombre, telefono, camioneta, turno, zona });
    document.getElementById("driverModal").classList.add("hidden");
    toast(`Repartidor ${nombre} agregado`);
    loadDrivers();
  } catch (err) {
    toast("Error al agregar: " + err.message, "err");
  }
});

/* ── Mapa Leaflet ────────────────────────────────────────────────────────── */
let _map           = null;
let _driverMarkers = [];
let _mapRefresh    = null;

const TRUCK_ICON = (color) => L.divIcon({
  className: "",
  html: `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='32' viewBox='0 0 48 32' style='filter:drop-shadow(0 2px 4px rgba(0,0,0,.4))'>
    <rect x='2' y='5' width='30' height='15' rx='2' fill='${color}'/>
    <path d='M32 5 L32 20 L46 20 L46 14 L40 5 Z' fill='${color}'/>
    <path d='M33 6.5 L39 6.5 L45 13 L45 19 L33 19 Z' fill='rgba(200,230,255,0.38)'/>
    <rect x='4' y='7' width='9' height='7' rx='1' fill='rgba(255,255,255,0.32)'/>
    <rect x='15' y='7' width='9' height='7' rx='1' fill='rgba(255,255,255,0.32)'/>
    <line x1='14' y1='6' x2='14' y2='20' stroke='rgba(0,0,0,0.15)' stroke-width='0.7'/>
    <rect x='2' y='13' width='2' height='4' rx='0.5' fill='#ef4444'/>
    <rect x='44' y='14' width='2' height='4' rx='0.5' fill='#fef9c3'/>
    <circle cx='10' cy='25' r='5.5' fill='#1a1a1a'/>
    <circle cx='10' cy='25' r='2.2' fill='#888'/>
    <circle cx='36' cy='25' r='5.5' fill='#1a1a1a'/>
    <circle cx='36' cy='25' r='2.2' fill='#888'/>
  </svg>`,
  iconSize: [48, 32],
  iconAnchor: [24, 30],
});

async function loadMap() {
  if (!_map) {
    _map = L.map("map").setView([-34.6037, -58.3816], 12); // Buenos Aires por defecto
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(_map);
  }

  await refreshMapDrivers();

  // Auto-refresh cada 30 segundos mientras el tab mapa está activo
  clearInterval(_mapRefresh);
  _mapRefresh = setInterval(refreshMapDrivers, 30_000);
}

async function refreshMapDrivers() {
  const drivers = await API.get("/api/repartidores");

  // Limpiar marcadores anteriores
  _driverMarkers.forEach(m => m.remove());
  _driverMarkers = [];

  const COLORS = {
    camioneta_1: "#FF663B",
    camioneta_2: "#f59e0b",
  };

  const withGPS = drivers.filter(d => d.latitud && d.longitud);

  withGPS.forEach(d => {
    const color  = COLORS[d.camioneta] || "#6b7280";
    const marker = L.marker([d.latitud, d.longitud], { icon: TRUCK_ICON(color) })
      .addTo(_map)
      .bindPopup(`
        <strong>${d.nombre}</strong><br>
        ${d.camioneta.replace("_", " ")} · Turno ${d.turno}<br>
        <span style="color:${d.disponible ? "#22c55e" : "#ef4444"}">
          ${d.disponible ? "Disponible" : "No disponible"}
        </span><br>
        📦 ${d.pedidos_del_dia} pedidos hoy
      `);
    _driverMarkers.push(marker);
  });

  // Centrar mapa si hay marcadores
  if (withGPS.length > 0) {
    const bounds = L.latLngBounds(withGPS.map(d => [d.latitud, d.longitud]));
    _map.fitBounds(bounds, { padding: [60, 60] });
  }

  // Lista debajo del mapa
  const listEl = document.getElementById("mapDriverList");
  listEl.innerHTML = drivers.map(d => {
    const gpsAge = d.ultima_actualizacion
      ? Math.floor((Date.now() - new Date(d.ultima_actualizacion)) / 60_000)
      : null;
    const gpsOk = gpsAge != null && gpsAge < 15;
    return `
    <div class="driver-list-item">
      <span class="gps-dot ${gpsOk ? "gps-dot--on" : "gps-dot--off"}"></span>
      <strong>${d.nombre}</strong>
      <span>${d.camioneta.replace("_", " ")}</span>
      <span>${gpsOk ? `${gpsAge}min` : "sin GPS"}</span>
      <span class="badge ${d.disponible ? "badge--confirmado" : "badge--cancelado"}">
        ${d.disponible ? "OK" : "No disp."}
      </span>
    </div>`;
  }).join("");
}

document.getElementById("btnRefreshMap").addEventListener("click", refreshMapDrivers);

// Detener auto-refresh al salir del tab mapa
document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.dataset.tab !== "map") {
      clearInterval(_mapRefresh);
      _mapRefresh = null;
    }
  });
});

/* ── Clients ─────────────────────────────────────────────────────────────── */
let _clientsPage = 0;
const CLIENTS_PER_PAGE = 100;

async function loadClients(page) {
  if (page !== undefined) _clientsPage = page;
  const offset  = _clientsPage * CLIENTS_PER_PAGE;
  const clients = await API.get(`/api/clients?limit=${CLIENTS_PER_PAGE}&offset=${offset}`);

  const tbody = document.getElementById("clientsBody");
  if (!clients?.length && _clientsPage === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="loading">Sin clientes</td></tr>`;
    renderClientsPagination(false);
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

  renderClientsPagination(clients.length === CLIENTS_PER_PAGE);
}

function renderClientsPagination(hasMore) {
  document.getElementById("btnClientsPrev").disabled = _clientsPage === 0;
  document.getElementById("btnClientsNext").disabled = !hasMore;
  document.getElementById("clientsPageInfo").textContent = `Página ${_clientsPage + 1}`;
}

document.getElementById("btnClientsPrev").addEventListener("click", () => loadClients(_clientsPage - 1));
document.getElementById("btnClientsNext").addEventListener("click", () => loadClients(_clientsPage + 1));

/* ── Catalog ─────────────────────────────────────────────────────────────── */
async function loadCatalog() {
  const products = await API.get("/api/catalog?all=true");
  const grid     = document.getElementById("catalogGrid");
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

window.toggleProduct = toggleProduct;

/* ── Add product modal ───────────────────────────────────────────────────── */
document.getElementById("btnAddProduct").addEventListener("click", () => {
  document.getElementById("productModal").classList.remove("hidden");
});
document.getElementById("btnProdCancel").addEventListener("click", () => {
  document.getElementById("productModal").classList.add("hidden");
});
document.getElementById("btnProdSave").addEventListener("click", async () => {
  const nombre      = document.getElementById("pNombre").value.trim();
  const descripcion = document.getElementById("pDesc").value.trim();
  const precio      = Number(document.getElementById("pPrecio").value);
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
    document.getElementById("btnSync").textContent = "⟳ Sheets";
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
initAuth();
