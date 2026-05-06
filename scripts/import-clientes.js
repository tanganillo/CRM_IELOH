/**
 * import-clientes.js
 * Migrates 356 legacy clients from Excel to Supabase.
 *
 * Prerequisites:
 *   1. Run supabase/migrations/002_clientes_legacy_columns.sql in Supabase SQL Editor.
 *   2. Create .env at project root with SUPABASE_URL and SUPABASE_SECRET_KEY.
 *
 * Usage:
 *   node scripts/import-clientes.js
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const XLSX = require("xlsx");
const path = require("path");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const XLS_PATH = path.resolve(__dirname, "../../Clientes/Clientes-2026.05.06-12.59.23.xls");

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Error: SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

function cleanStr(s) {
  return String(s || "").trim().replace(/\s{2,}/g, " ");
}

async function main() {
  console.log("Reading Excel…");
  const wb = XLSX.readFile(XLS_PATH, { codepage: 1252 });
  const sh = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sh, { header: 1, defval: "" });

  // raw[0] = header, raw[1] = empty, raw[2..] = data
  const clients = [];
  for (let i = 2; i < raw.length; i++) {
    const [codigo, , nombre, domicilio, , zona, saldo] = raw[i];
    const cod = parseInt(codigo, 10);
    if (!cod || cod === -1) continue; // skip blank rows and "Consumidor Final"
    clients.push({
      telefono:      `imp_${cod}`,
      nombre:        cleanStr(nombre),
      direccion:     cleanStr(domicilio),
      codigo_legacy: cod,
      zona:          cleanStr(zona) || null,
      saldo_inicial: parseFloat(saldo) || 0,
    });
  }

  console.log(`Parsed ${clients.length} clients. Uploading in batches…`);

  // Upsert in batches of 100 to avoid request size limits
  const BATCH = 100;
  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < clients.length; i += BATCH) {
    const batch = clients.slice(i, i + BATCH);
    const { data, error } = await sb
      .from("clientes")
      .upsert(batch, { onConflict: "telefono", ignoreDuplicates: true })
      .select("id");

    if (error) {
      console.error(`Batch ${i / BATCH + 1} error:`, error.message);
      process.exit(1);
    }
    inserted += data?.length || 0;
    skipped  += batch.length - (data?.length || 0);
    process.stdout.write(`  ${Math.min(i + BATCH, clients.length)} / ${clients.length}\r`);
  }

  console.log(`\nDone. Inserted: ${inserted} | Already existed (skipped): ${skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
