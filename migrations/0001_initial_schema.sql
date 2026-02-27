-- Migration: 0001_initial_schema
-- Description: Initial D1 schema for hindsight-cf
-- Ported from PostgreSQL (hindsight-api) to SQLite/D1

-- =============================================================================
-- Banks
-- =============================================================================
CREATE TABLE IF NOT EXISTS banks (
  bank_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  disposition TEXT NOT NULL DEFAULT '{"skepticism":3,"literalism":3,"empathy":3}',
  mission TEXT NOT NULL DEFAULT '',
  background TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- =============================================================================
-- Documents
-- =============================================================================
CREATE TABLE IF NOT EXISTS documents (
  id TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  original_text TEXT,
  content_hash TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (id, bank_id),
  FOREIGN KEY (bank_id) REFERENCES banks(bank_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_documents_bank_id ON documents(bank_id);
CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash);

-- =============================================================================
-- Chunks
-- =============================================================================
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (document_id, bank_id) REFERENCES documents(id, bank_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_bank_id ON chunks(bank_id);

-- =============================================================================
-- Memory Units
-- =============================================================================
CREATE TABLE IF NOT EXISTS memory_units (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  bank_id TEXT NOT NULL,
  document_id TEXT,
  chunk_id TEXT,
  text TEXT NOT NULL,
  context TEXT,
  event_date TEXT NOT NULL,
  occurred_start TEXT,
  occurred_end TEXT,
  mentioned_at TEXT,
  fact_type TEXT NOT NULL DEFAULT 'world'
    CHECK (fact_type IN ('world', 'experience', 'opinion', 'observation', 'mental_model')),
  confidence_score REAL
    CHECK (confidence_score IS NULL OR (confidence_score >= 0.0 AND confidence_score <= 1.0)),
  metadata TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '[]',
  proof_count INTEGER DEFAULT 1,
  source_memory_ids TEXT DEFAULT '[]',
  history TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (bank_id) REFERENCES banks(bank_id) ON DELETE CASCADE,
  FOREIGN KEY (chunk_id) REFERENCES chunks(chunk_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_units_bank_id ON memory_units(bank_id);
CREATE INDEX IF NOT EXISTS idx_memory_units_document_id ON memory_units(document_id);
CREATE INDEX IF NOT EXISTS idx_memory_units_chunk_id ON memory_units(chunk_id);
CREATE INDEX IF NOT EXISTS idx_memory_units_event_date ON memory_units(event_date DESC);
CREATE INDEX IF NOT EXISTS idx_memory_units_bank_date ON memory_units(bank_id, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_memory_units_fact_type ON memory_units(fact_type);
CREATE INDEX IF NOT EXISTS idx_memory_units_bank_fact_type ON memory_units(bank_id, fact_type);
CREATE INDEX IF NOT EXISTS idx_memory_units_bank_type_date ON memory_units(bank_id, fact_type, event_date DESC);

-- =============================================================================
-- Entities
-- =============================================================================
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  canonical_name TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  mention_count INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (bank_id) REFERENCES banks(bank_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entities_bank_id ON entities(bank_id);
CREATE INDEX IF NOT EXISTS idx_entities_canonical_name ON entities(canonical_name);
CREATE INDEX IF NOT EXISTS idx_entities_bank_name ON entities(bank_id, canonical_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_bank_lower_name ON entities(bank_id, canonical_name COLLATE NOCASE);

-- =============================================================================
-- Unit Entities (junction table)
-- =============================================================================
CREATE TABLE IF NOT EXISTS unit_entities (
  unit_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (unit_id, entity_id),
  FOREIGN KEY (unit_id) REFERENCES memory_units(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_unit_entities_unit ON unit_entities(unit_id);
CREATE INDEX IF NOT EXISTS idx_unit_entities_entity ON unit_entities(entity_id);

-- =============================================================================
-- Entity Cooccurrences (materialized cache)
-- =============================================================================
CREATE TABLE IF NOT EXISTS entity_cooccurrences (
  entity_id_1 TEXT NOT NULL,
  entity_id_2 TEXT NOT NULL,
  cooccurrence_count INTEGER NOT NULL DEFAULT 1,
  last_cooccurred TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (entity_id_1, entity_id_2),
  CHECK (entity_id_1 < entity_id_2),
  FOREIGN KEY (entity_id_1) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_id_2) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entity_cooccurrences_entity1 ON entity_cooccurrences(entity_id_1);
CREATE INDEX IF NOT EXISTS idx_entity_cooccurrences_entity2 ON entity_cooccurrences(entity_id_2);
CREATE INDEX IF NOT EXISTS idx_entity_cooccurrences_count ON entity_cooccurrences(cooccurrence_count DESC);

-- =============================================================================
-- Memory Links
-- =============================================================================
CREATE TABLE IF NOT EXISTS memory_links (
  from_unit_id TEXT NOT NULL,
  to_unit_id TEXT NOT NULL,
  link_type TEXT NOT NULL
    CHECK (link_type IN ('temporal', 'semantic', 'entity', 'causes', 'caused_by', 'enables', 'prevents')),
  entity_id TEXT,
  weight REAL NOT NULL DEFAULT 1.0
    CHECK (weight >= 0.0 AND weight <= 1.0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (from_unit_id, to_unit_id, link_type, entity_id),
  FOREIGN KEY (from_unit_id) REFERENCES memory_units(id) ON DELETE CASCADE,
  FOREIGN KEY (to_unit_id) REFERENCES memory_units(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_links_from ON memory_links(from_unit_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_to ON memory_links(to_unit_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_type ON memory_links(link_type);
CREATE INDEX IF NOT EXISTS idx_memory_links_entity ON memory_links(entity_id);

-- =============================================================================
-- Directives
-- =============================================================================
CREATE TABLE IF NOT EXISTS directives (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  bank_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (bank_id) REFERENCES banks(bank_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_directives_bank_id ON directives(bank_id);
CREATE INDEX IF NOT EXISTS idx_directives_bank_active ON directives(bank_id, is_active);

-- =============================================================================
-- Async Operations
-- =============================================================================
CREATE TABLE IF NOT EXISTS async_operations (
  operation_id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  bank_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  error_message TEXT,
  result_metadata TEXT NOT NULL DEFAULT '{}',
  task_payload TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (bank_id) REFERENCES banks(bank_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_async_operations_bank_id ON async_operations(bank_id);
CREATE INDEX IF NOT EXISTS idx_async_operations_status ON async_operations(status);
CREATE INDEX IF NOT EXISTS idx_async_operations_bank_status ON async_operations(bank_id, status);

-- =============================================================================
-- FTS5 Virtual Tables for Full-Text Search
-- =============================================================================

-- Full-text search on memory unit text
CREATE VIRTUAL TABLE IF NOT EXISTS memory_units_fts USING fts5(
  text,
  context,
  content='memory_units',
  content_rowid='rowid'
);

-- Triggers to keep FTS in sync with memory_units
CREATE TRIGGER IF NOT EXISTS memory_units_ai AFTER INSERT ON memory_units BEGIN
  INSERT INTO memory_units_fts(rowid, text, context)
  VALUES (new.rowid, new.text, new.context);
END;

CREATE TRIGGER IF NOT EXISTS memory_units_ad AFTER DELETE ON memory_units BEGIN
  INSERT INTO memory_units_fts(memory_units_fts, rowid, text, context)
  VALUES ('delete', old.rowid, old.text, old.context);
END;

CREATE TRIGGER IF NOT EXISTS memory_units_au AFTER UPDATE ON memory_units BEGIN
  INSERT INTO memory_units_fts(memory_units_fts, rowid, text, context)
  VALUES ('delete', old.rowid, old.text, old.context);
  INSERT INTO memory_units_fts(rowid, text, context)
  VALUES (new.rowid, new.text, new.context);
END;
