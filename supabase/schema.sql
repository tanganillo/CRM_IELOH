-- ── Extensiones ─────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Tabla: clientes ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clientes (
  id         BIGSERIAL PRIMARY KEY,
  telefono   TEXT UNIQUE NOT NULL,           -- número E.164, ej: "5491100000000"
  nombre     TEXT NOT NULL DEFAULT '',
  direccion  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clientes_telefono ON clientes(telefono);

-- ── Tabla: catalogo ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalogo (
  id          BIGSERIAL PRIMARY KEY,
  nombre      TEXT NOT NULL,
  descripcion TEXT,
  precio      NUMERIC(10,2) NOT NULL,
  disponible  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Tabla: pedidos ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pedidos (
  id         BIGSERIAL PRIMARY KEY,
  cliente_id BIGINT NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
  items      JSONB NOT NULL DEFAULT '[]',    -- [{ nombre, cantidad, precio }]
  total      NUMERIC(10,2) NOT NULL DEFAULT 0,
  estado     TEXT NOT NULL DEFAULT 'pendiente'
               CHECK (estado IN ('pendiente','confirmado','en_camino','entregado','cancelado')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pedidos_cliente_id  ON pedidos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_estado      ON pedidos(estado);
CREATE INDEX IF NOT EXISTS idx_pedidos_created_at  ON pedidos(created_at DESC);

-- ── Datos de ejemplo ─────────────────────────────────────────────────────────
INSERT INTO catalogo (nombre, descripcion, precio) VALUES
  ('Hielo en bolsa 2kg',   'Bolsa de hielo picado 2 kg',         350),
  ('Hielo en bolsa 5kg',   'Bolsa de hielo picado 5 kg',         750),
  ('Hielo en cubo 2kg',    'Cubos de hielo premium 2 kg',        420),
  ('Hielo en cubo 5kg',    'Cubos de hielo premium 5 kg',        900),
  ('Bloque de hielo 10kg', 'Bloque entero 10 kg para events',   1800)
ON CONFLICT DO NOTHING;

-- ── Tabla: repartidores ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS repartidores (
  id                   BIGSERIAL PRIMARY KEY,
  nombre               TEXT NOT NULL,
  telefono             TEXT UNIQUE NOT NULL,
  camioneta            TEXT NOT NULL CHECK (camioneta IN ('camioneta_1', 'camioneta_2')),
  turno                TEXT NOT NULL DEFAULT 'manana' CHECK (turno IN ('manana', 'tarde')),
  latitud              DOUBLE PRECISION,
  longitud             DOUBLE PRECISION,
  disponible           BOOLEAN NOT NULL DEFAULT TRUE,
  pedidos_del_dia      INTEGER NOT NULL DEFAULT 0,
  zona                 TEXT,
  ultima_actualizacion TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- (repartidores se cargan desde el dashboard, no hay seed de prueba)

-- Campo para marcar pedidos archivados (>90 días)
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_pedidos_archived ON pedidos(archived);

-- ── Row Level Security (RLS) — usar con service_role en funciones serverless ──
ALTER TABLE clientes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogo      ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos       ENABLE ROW LEVEL SECURITY;
ALTER TABLE repartidores  ENABLE ROW LEVEL SECURITY;

-- La SUPABASE_SECRET_KEY (service role) bypassea RLS automáticamente.
-- Para el dashboard público añadirías políticas específicas aquí.

-- ── Migración 002: columnas legacy para importación de clientes ───────────────
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS codigo_legacy  INTEGER UNIQUE,
  ADD COLUMN IF NOT EXISTS zona           TEXT,
  ADD COLUMN IF NOT EXISTS saldo_inicial  NUMERIC(10,2) DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_clientes_codigo_legacy ON clientes(codigo_legacy);
