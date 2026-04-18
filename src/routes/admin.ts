/**
 * Admin backup/restore endpoints with HTML UI.
 *
 * Mounted at /admin — requires HINDSIGHT_ADMIN_KEY secret for data endpoints.
 * GET  /admin/backup           — HTML page (no auth, key entered in UI)
 * GET  /admin/backup/export    — full data dump as JSON
 * POST /admin/backup/import    — restore from JSON dump
 */
import { Hono } from 'hono';
import type { Env } from '../env';

const app = new Hono<{ Bindings: Env }>();

function timingSafeCompare(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.byteLength !== bb.byteLength) {
    // Compare against self to keep constant time
    crypto.subtle.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.subtle.timingSafeEqual(ab, bb);
}

function requireAdminKey(env: Env, authHeader: string | undefined): Response | null {
  if (!env.HINDSIGHT_ADMIN_KEY) {
    return new Response(JSON.stringify({ error: 'Admin not configured. Set HINDSIGHT_ADMIN_KEY secret.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const token = authHeader?.replace(/^Bearer\s+/i, '');
  if (!token || !timingSafeCompare(token, env.HINDSIGHT_ADMIN_KEY)) {
    return new Response(JSON.stringify({ error: 'Invalid admin key' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return null;
}

// ─── HTML page ─────────────────────────────────────────────────────────────────

app.get('/backup', (c) => {
  return c.html(BACKUP_PAGE_HTML);
});

// ─── Export full dump ──────────────────────────────────────────────────────────

app.get('/backup/export', async (c) => {
  const denied = requireAdminKey(c.env, c.req.header('Authorization'));
  if (denied) return denied;

  const bankId = c.req.query('bank_id');
  if (!bankId) return c.json({ error: 'bank_id query param required' }, 400);

  const bank = await c.env.DB.prepare('SELECT * FROM banks WHERE bank_id = ?').bind(bankId).first();
  if (!bank) return c.json({ error: 'not_found', message: 'Bank not found' }, 404);

  const [memories, entities, directives, documents] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM memory_units WHERE bank_id = ? ORDER BY created_at ASC').bind(bankId).all(),
    c.env.DB.prepare('SELECT * FROM entities WHERE bank_id = ? ORDER BY canonical_name ASC').bind(bankId).all(),
    c.env.DB.prepare('SELECT * FROM directives WHERE bank_id = ? ORDER BY priority DESC').bind(bankId).all(),
    c.env.DB.prepare('SELECT id, bank_id, content_hash, metadata, created_at FROM documents WHERE bank_id = ?').bind(bankId).all(),
  ]);

  const safeParseJson = (v: unknown) => {
    if (!v || v === '{}' || v === '[]') return typeof v === 'string' && v.startsWith('[') ? [] : {};
    try { return JSON.parse(v as string); } catch { return v; }
  };

  const dump = {
    version: '1.0',
    exported_at: new Date().toISOString(),
    bank: {
      bank_id: bank.bank_id,
      name: bank.name || bank.bank_id,
      disposition: safeParseJson(bank.disposition),
      mission: bank.mission,
      background: bank.background || null,
      config: safeParseJson(bank.config),
    },
    memories: memories.results.map((row: Record<string, unknown>) => ({
      id: row.id,
      text: row.text,
      context: row.context,
      event_date: row.event_date,
      fact_type: row.fact_type,
      metadata: safeParseJson(row.metadata),
      tags: safeParseJson(row.tags),
      proof_count: row.proof_count,
      source_memory_ids: safeParseJson(row.source_memory_ids),
      created_at: row.created_at,
    })),
    entities: entities.results.map((row: Record<string, unknown>) => ({
      id: row.id,
      canonical_name: row.canonical_name,
      metadata: safeParseJson(row.metadata),
      mention_count: row.mention_count,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
    })),
    directives: directives.results.map((row: Record<string, unknown>) => ({
      id: row.id,
      name: row.name,
      content: row.content,
      priority: row.priority,
      is_active: row.is_active === 1,
      tags: safeParseJson(row.tags),
    })),
    documents: documents.results.map((row: Record<string, unknown>) => ({
      id: row.id,
      content_hash: row.content_hash,
      metadata: safeParseJson(row.metadata),
      created_at: row.created_at,
    })),
  };

  return c.json(dump);
});

// ─── Import full dump ──────────────────────────────────────────────────────────

app.post('/backup/import', async (c) => {
  const denied = requireAdminKey(c.env, c.req.header('Authorization'));
  if (denied) return denied;

  const bankId = c.req.query('bank_id');
  if (!bankId) return c.json({ error: 'bank_id query param required' }, 400);

  const dryRun = c.req.query('dry_run') === 'true';

  const template = await c.req.json<{
    version?: string;
    bank?: Record<string, unknown>;
    memories?: Array<Record<string, unknown>>;
    entities?: Array<Record<string, unknown>>;
    directives?: Array<Record<string, unknown>>;
  }>();

  const MAX_IMPORT_MEMORIES = 10000;
  const MAX_IMPORT_ENTITIES = 5000;
  const MAX_IMPORT_DIRECTIVES = 500;

  if (template.memories && template.memories.length > MAX_IMPORT_MEMORIES)
    return c.json({ error: 'validation_error', message: `memories exceeds max ${MAX_IMPORT_MEMORIES}` }, 400);
  if (template.entities && template.entities.length > MAX_IMPORT_ENTITIES)
    return c.json({ error: 'validation_error', message: `entities exceeds max ${MAX_IMPORT_ENTITIES}` }, 400);
  if (template.directives && template.directives.length > MAX_IMPORT_DIRECTIVES)
    return c.json({ error: 'validation_error', message: `directives exceeds max ${MAX_IMPORT_DIRECTIVES}` }, 400);

  const summary = {
    bank_updated: false,
    memories_imported: 0,
    entities_imported: 0,
    directives_imported: 0,
  };

  if (dryRun) {
    if (template.bank) summary.bank_updated = true;
    summary.memories_imported = template.memories?.length ?? 0;
    summary.entities_imported = template.entities?.length ?? 0;
    summary.directives_imported = template.directives?.length ?? 0;
    return c.json({ dry_run: true, summary });
  }

  // Ensure bank exists
  const { ensureBank } = await import('./banks');
  await ensureBank(c.env.DB, bankId);

  // Bank profile
  if (template.bank) {
    const b = template.bank;
    const updates: string[] = [];
    const vals: unknown[] = [];
    if (b.disposition) {
      updates.push('disposition = ?');
      vals.push(typeof b.disposition === 'string' ? b.disposition : JSON.stringify(b.disposition));
    }
    if (b.mission) { updates.push('mission = ?'); vals.push(b.mission); }
    if (b.name) { updates.push('name = ?'); vals.push(b.name); }
    if (b.config) { updates.push('config = ?'); vals.push(typeof b.config === 'string' ? b.config : JSON.stringify(b.config)); }
    if (updates.length > 0) {
      updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
      vals.push(bankId);
      await c.env.DB.prepare(`UPDATE banks SET ${updates.join(', ')} WHERE bank_id = ?`).bind(...vals).run();
      summary.bank_updated = true;
    }
  }

  // Directives
  if (template.directives) {
    for (const d of template.directives) {
      const id = crypto.randomUUID();
      await c.env.DB.prepare(
        'INSERT INTO directives (id, bank_id, name, content, priority, is_active, tags) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(id, bankId, d.name, d.content, d.priority ?? 0, d.is_active !== false ? 1 : 0, JSON.stringify(d.tags ?? []))
        .run();
      summary.directives_imported++;
    }
  }

  // Entities
  if (template.entities) {
    for (const e of template.entities) {
      await c.env.DB.prepare(
        'INSERT OR IGNORE INTO entities (id, canonical_name, bank_id, metadata, mention_count) VALUES (?, ?, ?, ?, ?)',
      )
        .bind(e.id ?? crypto.randomUUID(), e.canonical_name, bankId, JSON.stringify(e.metadata ?? {}), e.mention_count ?? 1)
        .run();
      summary.entities_imported++;
    }
  }

  // Memories (raw insert, no re-embedding)
  if (template.memories) {
    for (const m of template.memories) {
      await c.env.DB.prepare(
        'INSERT OR IGNORE INTO memory_units (id, bank_id, text, context, event_date, fact_type, metadata, tags, proof_count, source_memory_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(
          m.id ?? crypto.randomUUID(),
          bankId,
          m.text,
          m.context ?? '',
          m.event_date ?? new Date().toISOString(),
          m.fact_type ?? 'world',
          JSON.stringify(m.metadata ?? {}),
          JSON.stringify(m.tags ?? []),
          m.proof_count ?? 1,
          JSON.stringify(m.source_memory_ids ?? []),
        )
        .run();
      summary.memories_imported++;
    }
  }

  return c.json({ dry_run: false, summary });
});

// ─── HTML ──────────────────────────────────────────────────────────────────────

const BACKUP_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hindsight — Admin Backup &amp; Restore</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; max-width: 700px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #f8fafc; }
  .subtitle { color: #94a3b8; margin-bottom: 2rem; font-size: 0.9rem; }
  label { display: block; font-size: 0.85rem; color: #94a3b8; margin-bottom: 0.3rem; }
  input[type="text"], input[type="password"] { width: 100%; padding: 0.6rem 0.8rem; border: 1px solid #334155; border-radius: 6px; background: #1e293b; color: #f1f5f9; font-size: 0.95rem; margin-bottom: 1rem; }
  input:focus { outline: none; border-color: #3b82f6; }
  .row { display: flex; gap: 1rem; }
  .row > * { flex: 1; }
  .section { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; }
  .section h2 { font-size: 1.1rem; margin-bottom: 1rem; color: #f8fafc; }
  button { padding: 0.6rem 1.2rem; border: none; border-radius: 6px; font-size: 0.9rem; cursor: pointer; font-weight: 500; }
  .btn-primary { background: #3b82f6; color: white; }
  .btn-primary:hover { background: #2563eb; }
  .btn-primary:disabled { background: #475569; cursor: not-allowed; }
  .btn-warn { background: #f59e0b; color: #1e293b; }
  .btn-warn:hover { background: #d97706; }
  .btn-warn:disabled { background: #475569; color: #94a3b8; cursor: not-allowed; }
  input[type="file"] { margin-bottom: 1rem; }
  #status { margin-top: 1.5rem; padding: 1rem; border-radius: 6px; font-family: 'SF Mono', monospace; font-size: 0.85rem; white-space: pre-wrap; display: none; max-height: 300px; overflow-y: auto; }
  #status.ok { display: block; background: #064e3b; border: 1px solid #065f46; color: #6ee7b7; }
  #status.err { display: block; background: #7f1d1d; border: 1px solid #991b1b; color: #fca5a5; }
  #status.info { display: block; background: #1e293b; border: 1px solid #334155; color: #94a3b8; }
  .warn { color: #fbbf24; font-size: 0.8rem; margin-top: 0.5rem; }
</style>
</head>
<body>

<h1>Hindsight Admin</h1>
<p class="subtitle">Backup &amp; Restore — full data dump (memories, entities, directives, documents)</p>

<div class="row">
  <div>
    <label for="adminKey">Admin Key</label>
    <input type="password" id="adminKey" placeholder="Enter HINDSIGHT_ADMIN_KEY" autocomplete="off">
  </div>
  <div>
    <label for="bankId">Bank ID</label>
    <input type="text" id="bankId" placeholder="e.g. default" value="default">
  </div>
</div>

<div class="section">
  <h2>Export Backup</h2>
  <p style="color:#94a3b8;font-size:0.85rem;margin-bottom:1rem">Download all data for this bank as a JSON file.</p>
  <button class="btn-primary" id="btnExport" onclick="doExport()">Export &amp; Download</button>
</div>

<div class="section">
  <h2>Restore from Backup</h2>
  <p style="color:#94a3b8;font-size:0.85rem;margin-bottom:1rem">Upload a previously exported JSON file to restore data.</p>
  <input type="file" id="fileInput" accept=".json">
  <div style="display:flex;gap:0.75rem">
    <button class="btn-primary" id="btnDryRun" onclick="doImport(true)">Dry Run</button>
    <button class="btn-warn" id="btnImport" onclick="doImport(false)">Import</button>
  </div>
  <p class="warn">Import inserts raw data without re-embedding. Existing records with the same ID are skipped.</p>
</div>

<div id="status"></div>

<script>
function getKey() { return document.getElementById('adminKey').value.trim(); }
function getBank() { return document.getElementById('bankId').value.trim(); }

function setStatus(msg, cls) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = cls;
}

function setButtons(disabled) {
  document.getElementById('btnExport').disabled = disabled;
  document.getElementById('btnDryRun').disabled = disabled;
  document.getElementById('btnImport').disabled = disabled;
}

async function doExport() {
  const key = getKey(), bank = getBank();
  if (!key || !bank) { setStatus('Admin key and bank ID are required.', 'err'); return; }
  setButtons(true);
  setStatus('Exporting...', 'info');
  try {
    const resp = await fetch('/admin/backup/export?bank_id=' + encodeURIComponent(bank), {
      headers: { 'Authorization': 'Bearer ' + key }
    });
    if (!resp.ok) { setStatus('Export failed: HTTP ' + resp.status + '\\n' + await resp.text(), 'err'); return; }
    const data = await resp.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hindsight-backup-' + bank + '-' + new Date().toISOString().slice(0,10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    const counts = 'Memories: ' + (data.memories||[]).length
      + '  Entities: ' + (data.entities||[]).length
      + '  Directives: ' + (data.directives||[]).length
      + '  Documents: ' + (data.documents||[]).length;
    setStatus('Export complete — downloaded.\\n' + counts, 'ok');
  } catch (e) { setStatus('Export error: ' + e.message, 'err'); }
  finally { setButtons(false); }
}

async function doImport(dryRun) {
  const key = getKey(), bank = getBank();
  if (!key || !bank) { setStatus('Admin key and bank ID are required.', 'err'); return; }
  const file = document.getElementById('fileInput').files[0];
  if (!file) { setStatus('Select a backup file first.', 'err'); return; }
  setButtons(true);
  setStatus(dryRun ? 'Running dry run...' : 'Importing...', 'info');
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const url = '/admin/backup/import?bank_id=' + encodeURIComponent(bank) + (dryRun ? '&dry_run=true' : '');
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!resp.ok) { setStatus('Import failed: HTTP ' + resp.status + '\\n' + await resp.text(), 'err'); return; }
    const result = await resp.json();
    setStatus((dryRun ? 'DRY RUN — nothing written.\\n' : 'Import complete.\\n') + JSON.stringify(result.summary || result, null, 2), dryRun ? 'info' : 'ok');
  } catch (e) { setStatus('Import error: ' + e.message, 'err'); }
  finally { setButtons(false); }
}
</script>
</body>
</html>`;

export { app as adminRoutes };
