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

-- ── Row Level Security (RLS) — usar con service_role en funciones serverless ──
ALTER TABLE clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogo  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos   ENABLE ROW LEVEL SECURITY;

-- La SUPABASE_SECRET_KEY (service role) bypassea RLS automáticamente.
-- Para el dashboard público añadirías políticas específicas aquí.
