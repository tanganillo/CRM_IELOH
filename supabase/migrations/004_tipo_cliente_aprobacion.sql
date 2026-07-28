-- Migration 004: tipo de cliente (particular/comercio, extensible) + aprobación manual
-- Run in Supabase SQL Editor. Ejecutar en dos pasos:
--   PASO 1: corre hasta el bloque "CONTEO ESPERADO" inclusive y revisá que los números
--            coincidan con lo esperado antes de seguir.
--   PASO 2: corre el resto (los UPDATE de backfill).

-- Sin CHECK a propósito: la idea es poder sumar valores nuevos (ej. "mayorista",
-- "distribuidor") más adelante sin otra migración. La validación de valores permitidos,
-- si hace falta, se hace en el código de la app, no acá.
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS tipo_cliente      TEXT NOT NULL DEFAULT 'particular',
  ADD COLUMN IF NOT EXISTS estado_aprobacion TEXT NOT NULL DEFAULT 'aprobado';

CREATE INDEX IF NOT EXISTS idx_clientes_tipo_cliente      ON clientes(tipo_cliente);
CREATE INDEX IF NOT EXISTS idx_clientes_estado_aprobacion ON clientes(estado_aprobacion);

-- ── CONTEO ESPERADO ──────────────────────────────────────────────────────────
-- Corré esto primero y confirmá que "comercios_legacy" da 356 (los importados del Excel,
-- todos con codigo_legacy poblado) y que "particulares" es el resto de las filas.
SELECT
  COUNT(*) FILTER (WHERE codigo_legacy IS NOT NULL) AS comercios_legacy,
  COUNT(*) FILTER (WHERE codigo_legacy IS NULL)     AS particulares,
  COUNT(*)                                          AS total
FROM clientes;

-- ── BACKFILL (correr recién después de confirmar el conteo de arriba) ───────────
UPDATE clientes
  SET tipo_cliente = 'comercio', estado_aprobacion = 'aprobado'
  WHERE codigo_legacy IS NOT NULL;

UPDATE clientes
  SET tipo_cliente = 'particular', estado_aprobacion = 'aprobado'
  WHERE codigo_legacy IS NULL;
