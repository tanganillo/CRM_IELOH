-- Migration 002: add legacy import columns to clientes
-- Run in Supabase SQL Editor before running seed_clientes.sql

ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS codigo_legacy  INTEGER UNIQUE,
  ADD COLUMN IF NOT EXISTS zona           TEXT,
  ADD COLUMN IF NOT EXISTS saldo_inicial  NUMERIC(10,2) DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_clientes_codigo_legacy ON clientes(codigo_legacy);
