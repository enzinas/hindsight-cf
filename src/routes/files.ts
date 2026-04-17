/**
 * File upload endpoint for retaining file contents as memories.
 *
 * Accepts multipart file uploads, stores files in R2, and enqueues
 * async operations to extract text, chunk, and retain as memories.
 *
 * Maximum file size: 20MB per file.
 *
 * Supported formats:
 *   - PDF (.pdf) — text extraction via toMarkdown + vision model for visual content
 *   - Images (.jpg, .png, .webp, .svg) — OCR via toMarkdown + vision model description
 *   - PPTX (.pptx) — text extraction via toMarkdown + vision model for slide visuals
 *   - DOCX (.docx) — text extraction via toMarkdown
 *   - Excel (.xlsx, .xls, .xlsm, .xlsb) — text extraction via toMarkdown
 *   - CSV (.csv) — text extraction via toMarkdown
 *   - HTML (.html) — text extraction via toMarkdown
 *   - XML (.xml) — text extraction via toMarkdown
 *   - Audio (.mp3, .wav, .ogg, .flac, .m4a, .webm) — transcription via Whisper
 *   - Plain text, markdown, JSON, YAML — read directly
 */
import { Hono } from 'hono';
import type { Env } from '../env';
import type { FileMetadata } from '../types';

const app = new Hono<{ Bindings: Env }>();

/** Maximum file size in bytes (20MB). */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

// POST /files/retain — upload files for retention
app.post('/retain', async (c) => {
  const bankId = c.req.param('bank_id') ?? '';
  if (!bankId) {
    return c.json({ error: 'invalid_request', message: 'Missing bank_id' }, 400);
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Expected multipart/form-data' }, 400);
  }

  // Get uploaded files — in Workers, formData entries are string | File
  interface UploadedFile {
    name: string;
    type: string;
    size: number;
    stream(): ReadableStream;
    arrayBuffer(): Promise<ArrayBuffer>;
  }
  const rawFiles = formData.getAll('files');
  const files: UploadedFile[] = [];
  for (const f of rawFiles) {
    if (typeof f !== 'string' && f && 'name' in f && 'stream' in f) {
      files.push(f as unknown as UploadedFile);
    }
  }
  if (files.length === 0) {
    return c.json({ error: 'invalid_request', message: 'No files provided. Include one or more files in the "files" field.' }, 400);
  }

  // Validate file sizes
  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      return c.json({
        error: 'file_too_large',
        message: `File "${file.name}" is ${sizeMB}MB which exceeds the 20MB limit. Reduce the file size and try again.`,
        file_name: file.name,
        file_size: file.size,
        max_size: MAX_FILE_SIZE,
      }, 413);
    }
  }

  // Parse optional request metadata
  let filesMetadata: FileMetadata[] = [];
  const requestJson = formData.get('request');
  if (requestJson && typeof requestJson === 'string') {
    try {
      const parsed = JSON.parse(requestJson);
      filesMetadata = parsed.files_metadata ?? [];
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON in "request" field' }, 400);
    }
  }

  // Validate files_metadata length if provided
  if (filesMetadata.length > 0 && filesMetadata.length !== files.length) {
    return c.json({
      error: 'invalid_request',
      message: `files_metadata length (${filesMetadata.length}) must match number of files (${files.length})`,
    }, 400);
  }

  const now = new Date().toISOString();
  const operationIds: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const meta = filesMetadata[i] ?? {};
    const operationId = crypto.randomUUID();
    const documentId = meta.document_id ?? crypto.randomUUID();
    const fileName = file.name;
    const contentType = file.type || 'application/octet-stream';

    // Upload file to R2
    const r2Key = `file-retain/${bankId}/${operationId}/${fileName}`;
    await c.env.R2.put(r2Key, file.stream(), {
      httpMetadata: { contentType },
      customMetadata: { bankId, operationId, originalName: fileName },
    });

    const taskPayload = {
      r2_key: r2Key,
      file_name: fileName,
      content_type: contentType,
      document_id: documentId,
      context: meta.context ?? null,
      metadata: meta.metadata ?? {},
      tags: meta.tags ?? [],
      timestamp: meta.timestamp ?? now,
    };

    // Create async operation record
    await c.env.DB.prepare(
      `INSERT INTO async_operations (operation_id, bank_id, operation_type, status, created_at, updated_at, task_payload)
       VALUES (?, ?, 'file_retain', 'pending', ?, ?, ?)`,
    )
      .bind(operationId, bankId, now, now, JSON.stringify(taskPayload))
      .run();

    // Enqueue for processing
    await c.env.QUEUE.send({
      operation_id: operationId,
      operation_type: 'file_retain',
      bank_id: bankId,
      task_payload: taskPayload,
    });

    operationIds.push(operationId);
  }

  return c.json({ operation_ids: operationIds });
});

export { app as filesRoutes };
