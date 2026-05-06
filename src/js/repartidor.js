/* ── Service Worker ────────────────────────────────────────────────────────── */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(() => {});
}

/* ── Estado ─────────────────────────────────────────────────────────────────── */
let repartidorId   = null;
let repartidorData = null;
let gpsWatchId     = null;
let refreshTimer   = null;
const GPS_INTERVAL_MS  = 30_000;
const ORDER_REFRESH_MS = 60_000;

/* ── Helpers ─────────────────────────────────────────────────────────────────── */
function toast(msg) {
  const el = document.getElementById("toast-rep");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 3000);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

/* ── Setup: identificar repartidor ──────────────────────────────────────────── */
document.getElementById("btnSetupConfirm").addEventListener("click", async () => {
  const id = parseInt(document.getElementById("repIdInput").value, 10);
  if (!id || id < 1 || id > 10) {
    toast("Número inválido");
    return;
  }
  localStorage.setItem("rep_id", id);
  await initApp(id);
});

/* ── Init ────────────────────────────────────────────────────────────────────── */
async function initApp(id) {
  repartidorId = id;

  // Cargar datos del repartidor
  const reps = await api("GET", "/api/repartidores");
  repartidorData = reps.find((r) => r.id === id);

  if (!repartidorData) {
    toast(`Repartidor #${id} no encontrado`);
    localStorage.removeItem("rep_id");
    return;
  }

  // Mostrar pantalla principal
  document.getElementById("setupScreen").style.display = "none";
  document.getElementById("appScreen").style.display  = "block";
  document.getElementById("repName").textContent = repartidorData.nombre;
  document.getElementById("repSub").textContent  =
    `${repartidorData.camioneta.replace("_", " ")} · Turno ${repartidorData.turno}`;

  // Iniciar GPS
  startGPS();

  // Cargar pedidos y programar refresco
  await loadOrders();
  refreshTimer = setInterval(loadOrders, ORDER_REFRESH_MS);
}

/* ── GPS ─────────────────────────────────────────────────────────────────────── */
function startGPS() {
  if (!navigator.geolocation) {
    setGPSBadge(false);
    return;
  }

  gpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      setGPSBadge(true);
      sendLocation(pos.coords.latitude, pos.coords.longitude);
    },
    () => setGPSBadge(false),
    { enableHighAccuracy: true, maximumAge: GPS_INTERVAL_MS, timeout: 10_000 }
  );
}

function setGPSBadge(on) {
  const el = document.getElementById("gpsBadge");
  el.textContent = on ? "GPS activo" : "GPS off";
  el.className   = `gps-badge gps-badge--${on ? "on" : "off"}`;
}

let lastSendTime = 0;
async function sendLocation(lat, lng) {
  const now = Date.now();
  if (now - lastSendTime < GPS_INTERVAL_MS) return; // throttle
  lastSendTime = now;
  try {
    await api("POST", "/api/location-update", { id: repartidorId, latitud: lat, longitud: lng });
  } catch (_) {}
}

/* ── Pedidos ─────────────────────────────────────────────────────────────────── */
async function loadOrders() {
  try {
    const orders = await api("GET", "/api/orders?estado=confirmado");
    const pending = await api("GET", "/api/orders?estado=pendiente");
    const all = [...(orders || []), ...(pending || [])];
    renderOrders(all);
  } catch (err) {
    toast("Error al cargar pedidos");
  }
}

function renderOrders(orders) {
  const el = document.getElementById("ordersList");
  if (!orders.length) {
    el.innerHTML = `<div class="empty-state"><p>No hay pedidos pendientes</p></div>`;
    return;
  }

  el.innerHTML = orders
    .map((o) => {
      const cliente  = o.clientes?.nombre   || "Cliente";
      const telefono = o.clientes?.telefono || "";
      const direccion = o.clientes?.direccion || "";
      const mapsUrl  = direccion
        ? `https://maps.google.com/?q=${encodeURIComponent(direccion)}`
        : `https://wa.me/${telefono}`;
      const items    = Array.isArray(o.items) ? o.items : [];
      const resumen  = items.map((i) => `${i.cantidad}x ${i.nombre}`).join(", ");

      const showCamino    = o.estado === "pendiente" || o.estado === "confirmado";
      const showEntregado = o.estado === "en_camino";

      return `
      <div class="order-card" id="order-${o.id}">
        <div class="order-card-header">
          <span class="order-card-id">#${o.id}</span>
          <span class="badge badge--${o.estado}">${o.estado.replace("_", " ")}</span>
        </div>
        <div class="order-card-client">${cliente} · ${telefono}</div>
        ${direccion ? `<div class="order-card-addr">📍 <a href="${mapsUrl}" target="_blank">${direccion}</a></div>` : ""}
        <div class="order-card-items">${resumen || "—"} · <strong>$${Number(o.total).toLocaleString("es-AR")}</strong></div>
        <div class="order-card-actions">
          ${showCamino    ? `<button class="btn-rep btn-rep--camino"    onclick="cambiarEstado(${o.id},'en_camino')">🚚 En camino</button>` : ""}
          ${showEntregado ? `<button class="btn-rep btn-rep--entregado" onclick="cambiarEstado(${o.id},'entregado')">✅ Entregado</button>` : ""}
          ${direccion     ? `<button class="btn-rep btn-rep--maps" onclick="window.open('${mapsUrl}','_blank')">🗺️ Mapa</button>` : ""}
        </div>
      </div>`;
    })
    .join("");
}

async function cambiarEstado(id, estado) {
  try {
    await api("PATCH", "/api/orders", { id, estado });
    toast(`Pedido #${id} → ${estado.replace("_", " ")}`);
    await loadOrders();
  } catch (err) {
    toast("Error al actualizar estado");
  }
}

// Exponer globalmente para onclick en HTML
window.cambiarEstado = cambiarEstado;

/* ── Logout ──────────────────────────────────────────────────────────────────── */
document.getElementById("btnLogout").addEventListener("click", () => {
  clearInterval(refreshTimer);
  if (gpsWatchId != null) navigator.geolocation.clearWatch(gpsWatchId);
  localStorage.removeItem("rep_id");
  document.getElementById("setupScreen").style.display = "block";
  document.getElementById("appScreen").style.display   = "none";
});

/* ── Auto-inicio si ya estaba identificado ───────────────────────────────────── */
const savedId = parseInt(localStorage.getItem("rep_id") || "", 10);
if (savedId) initApp(savedId);
