-- Migration 005: precio dual por tipo de cliente (comercio/particular)
-- Run in Supabase SQL Editor.

-- `precio` (la columna vieja) NO se borra: queda como respaldo hasta confirmar que el
-- código nuevo funciona bien. El código de la app ya usa precio_comercio/precio_particular
-- con fallback a `precio` si alguna de las dos está NULL (ver lib/pricing.js).
ALTER TABLE catalogo
  ADD COLUMN IF NOT EXISTS precio_comercio   NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS precio_particular NUMERIC(10,2);

-- Backfill: solo los productos que siguen activos hoy (Hielo en bolsa 2kg id=1,
-- Hielo en bolsa 5kg id=2). No hay diferencia de precio para estos por ahora, así que
-- ambas columnas quedan iguales al precio actual. Los demás (ids 3, 4, 5 -- que se dan
-- de baja en el mismo cambio) quedan con precio_comercio/precio_particular en NULL.
UPDATE catalogo
  SET precio_comercio = precio, precio_particular = precio
  WHERE id IN (1, 2);
