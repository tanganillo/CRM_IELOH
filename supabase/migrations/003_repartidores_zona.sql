-- Migration 003: add zona column to repartidores, remove test seed data
ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS zona TEXT;

-- Remove the 4 placeholder drivers inserted by schema.sql seed
DELETE FROM repartidores
WHERE telefono IN ('5491100000001','5491100000002','5491100000003','5491100000004');
