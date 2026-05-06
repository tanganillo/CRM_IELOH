"""
Generates:
  supabase/migrations/002_clientes_legacy_columns.sql  — ALTER TABLE
  supabase/seed_clientes.sql                           — 356 INSERT statements
"""
import xlrd, sys, os

sys.stdout.reconfigure(encoding='utf-8')

XLS = r'C:\proyectos\Clientes\Clientes-2026.05.06-12.59.23.xls'
OUT_MIGRATION = r'C:\proyectos\CRM_IELOH\supabase\migrations\002_clientes_legacy_columns.sql'
OUT_SEED      = r'C:\proyectos\CRM_IELOH\supabase\seed_clientes.sql'

wb = xlrd.open_workbook(XLS, encoding_override='cp1252')
sh = wb.sheet_by_index(0)

def esc(s):
    return str(s).strip().replace("'", "''").replace("  ", " ").rstrip()

rows = []
for r in range(2, sh.nrows):
    row = sh.row_values(r)
    if not any(v for v in row):
        continue
    codigo = int(row[0])
    if codigo == -1:
        continue  # skip "Consumidor Final"
    nombre    = esc(row[2])
    domicilio = esc(row[3])
    zona      = esc(row[5]) if row[5] else ''
    saldo     = float(row[6]) if row[6] else 0.0
    rows.append((codigo, nombre, domicilio, zona, saldo))

print(f"Clientes a migrar: {len(rows)}")

# ── 1. Migration SQL ──────────────────────────────────────────────────────────
os.makedirs(os.path.dirname(OUT_MIGRATION), exist_ok=True)

migration_sql = """\
-- Migration 002: add legacy import columns to clientes
-- Run in Supabase SQL Editor before running seed_clientes.sql

ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS codigo_legacy  INTEGER UNIQUE,
  ADD COLUMN IF NOT EXISTS zona           TEXT,
  ADD COLUMN IF NOT EXISTS saldo_inicial  NUMERIC(10,2) DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_clientes_codigo_legacy ON clientes(codigo_legacy);
"""

with open(OUT_MIGRATION, 'w', encoding='utf-8') as f:
    f.write(migration_sql)
print(f"Escrito: {OUT_MIGRATION}")

# ── 2. Seed SQL ───────────────────────────────────────────────────────────────
lines = [
    "-- seed_clientes.sql — 356 clientes importados desde Excel (2026-05-06)",
    "-- Run AFTER migration 002.",
    "-- telefono uses placeholder 'imp_{codigo}' since the source has no phone data.",
    "",
    "INSERT INTO clientes (telefono, nombre, direccion, codigo_legacy, zona, saldo_inicial)",
    "VALUES",
]

values = []
for i, (codigo, nombre, domicilio, zona, saldo) in enumerate(rows):
    telefono = f"imp_{codigo}"
    v = f"  ('{ telefono }', '{nombre}', '{domicilio}', {codigo}, '{zona}', {saldo:.2f})"
    values.append(v)

lines.append(",\n".join(values))
lines.append("ON CONFLICT (telefono) DO NOTHING;")
lines.append("")
lines.append(f"-- Total: {len(rows)} clientes")

with open(OUT_SEED, 'w', encoding='utf-8') as f:
    f.write("\n".join(lines))
print(f"Escrito: {OUT_SEED}")
print("Listo.")
