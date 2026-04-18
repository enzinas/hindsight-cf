/**
 * File processing for the file retain pipeline.
 *
 * Uses Cloudflare's env.AI.toMarkdown() for structured text extraction from
 * all supported formats (PDF, images, DOCX, XLSX, PPTX, CSV, HTML, XML).
 *
 * For visually-rich formats (PDF, PPTX, images), a second pass with a vision
 * model captures charts, diagrams, scanned content, and other visual elements
 * that text extraction alone would miss. Both outputs are combined before
 * feeding into the retain pipeline.
 *
 * ## Parser field
 *
 * Upstream hindsight has a pluggable parser registry (iris, markitdown) with
 * per-file fallback chains. The `parser` field in FileMetadata is accepted for
 * API compatibility but has no effect — Cloudflare's native `toMarkdown()` API
 * replaces all upstream parsers with a single, more capable extraction that
 * handles every supported format. There is no benefit to routing through
 * different parsers when toMarkdown already produces optimal output for all
 * file types it supports.
 *
 * ## Strategy field
 *
 * Named strategies are config presets stored in bank config under the
 * `strategies` key. When a strategy name is provided, its overrides
 * (chunk_size, extraction_mode, retain_mission, custom_instructions,
 * extract_causal_links) are applied to the retain pipeline for that file.
 */

import type { Env } from '../../env';
import { aiRunWithRetry } from '../../providers/ai-retry';
import type { RetainContent, StrategyConfig } from './types';
import { retainBatch } from './orchestrator';

/** Shape of the task_payload for file_retain queue messages. */
export interface FileRetainPayload {
  r2_key: string;
  file_name: string;
  content_type: string;
  document_id: string;
  context: string | null;
  metadata: Record<string, string>;
  tags: string[];
  timestamp: string;
  /**
   * Named strategy to apply during retention. Looked up from bank config
   * `strategies` map. Controls chunk_size, extraction_mode, retain_mission,
   * custom_instructions, and extract_causal_links.
   */
  strategy: string | null;
}

/** Result returned by processFileRetain. */
export interface FileRetainResult {
  factsStored: number;
  memoryIds: string[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/** Content types that are plain text — read directly, no conversion needed. */
const DIRECT_TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'application/json',
  'application/x-yaml',
  'text/yaml',
]);

/** Content types that get toMarkdown only (text-centric, no visual content). */
const MARKDOWN_ONLY_TYPES = new Set([
  'text/csv',
  'text/html',
  'text/xml',
  'application/xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel.sheet.macroenabled.12', // .xlsm
  'application/vnd.ms-excel.sheet.binary.macroenabled.12', // .xlsb
  'application/vnd.ms-excel', // .xls
  'application/vnd.oasis.opendocument.spreadsheet', // .ods
  'application/vnd.oasis.opendocument.text', // .odt
  'application/vnd.apple.numbers', // .numbers
]);

/** Content types that get transcribed via speech-to-text model. */
const AUDIO_TYPES = new Set([
  'audio/mpeg', // .mp3
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/flac',
  'audio/webm',
  'audio/mp4', // .m4a
]);

/** Content types that get toMarkdown + vision model (visually rich). */
const VISUAL_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/svg+xml',
]);

/**
 * Process a file retain operation from the queue.
 *
 * Fetches the file from R2, extracts text using the appropriate strategy,
 * then calls retainBatch() to chunk, extract facts, embed, and store.
 */
export async function processFileRetain(
  env: Env,
  bankId: string,
  payload: FileRetainPayload,
): Promise<FileRetainResult> {
  const r2Object = await env.R2.get(payload.r2_key);
  if (!r2Object) {
    throw new Error(`File not found in R2: ${payload.r2_key}`);
  }

  const contentType = payload.content_type.split(';')[0].trim().toLowerCase();
  let text: string;

  if (DIRECT_TEXT_TYPES.has(contentType) || (contentType.startsWith('text/') && !MARKDOWN_ONLY_TYPES.has(contentType) && !VISUAL_TYPES.has(contentType))) {
    // Plain text — read directly
    text = await r2Object.text();
  } else if (AUDIO_TYPES.has(contentType)) {
    // Audio — transcribe via Whisper speech-to-text
    text = await transcribeAudio(env, r2Object, payload.file_name);
  } else if (VISUAL_TYPES.has(contentType)) {
    // Visually rich formats — toMarkdown + vision model
    const fileBlob = new Blob([await r2Object.arrayBuffer()], { type: contentType });
    const [markdownText, visionText] = await Promise.all([
      convertToMarkdown(env, fileBlob, payload.file_name),
      describeWithVision(env, fileBlob, payload.file_name),
    ]);
    text = combineExtractions(markdownText, visionText, payload.file_name);
  } else if (MARKDOWN_ONLY_TYPES.has(contentType)) {
    // Text-centric formats — toMarkdown only
    const fileBlob = new Blob([await r2Object.arrayBuffer()], { type: contentType });
    text = await convertToMarkdown(env, fileBlob, payload.file_name);
  } else {
    // Unknown format — try toMarkdown, fall back to raw text
    try {
      const fileBlob = new Blob([await r2Object.arrayBuffer()], { type: contentType });
      text = await convertToMarkdown(env, fileBlob, payload.file_name);
    } catch {
      text = await r2Object.text();
    }
  }

  if (!text || text.trim().length === 0) {
    await env.R2.delete(payload.r2_key);
    return {
      factsStored: 0,
      memoryIds: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }

  // Build RetainContent from extracted text
  const content: RetainContent = {
    content: text,
    context: payload.context || `File: ${payload.file_name}`,
    eventDate: payload.timestamp || new Date().toISOString(),
    metadata: {
      ...payload.metadata,
      source_file: payload.file_name,
      source_type: contentType,
    },
    entities: [],
    tags: payload.tags,
  };

  // Load named strategy from bank config if specified
  let strategy: StrategyConfig | undefined;
  if (payload.strategy) {
    const bankRow = await env.DB.prepare('SELECT config FROM banks WHERE bank_id = ?')
      .bind(bankId)
      .first<{ config: string }>();
    if (bankRow?.config) {
      const config = JSON.parse(bankRow.config) as { strategies?: Record<string, StrategyConfig> };
      strategy = config.strategies?.[payload.strategy];
    }
  }

  // Run through existing retain pipeline
  const result = await retainBatch(env, bankId, [content], {
    documentId: payload.document_id,
    documentTags: payload.tags,
    strategy,
  });

  const memoryIds = result.unitIdsByContent.flat();

  // Clean up R2 object after successful processing
  await env.R2.delete(payload.r2_key);

  return {
    factsStored: memoryIds.length,
    memoryIds,
    usage: result.usage,
  };
}

/**
 * Convert a file to markdown using Cloudflare's AI toMarkdown API.
 *
 * Handles PDF, images, DOCX, XLSX, PPTX, CSV, HTML, XML, and more.
 */
async function convertToMarkdown(env: Env, blob: Blob, fileName: string): Promise<string> {
  const result = await (env.AI as unknown as {
    toMarkdown(files: Array<{ name: string; blob: Blob }>): Promise<Array<{ name: string; data: string }>>;
  }).toMarkdown([{ name: fileName, blob }]);

  if (Array.isArray(result) && result.length > 0) {
    return result.map((r) => r.data).join('\n\n');
  }
  return '';
}

/**
 * Generate a rich description of visual content using the vision model.
 *
 * Used for PDFs, PPTX, and images to capture charts, diagrams, scanned
 * text, and other visual elements that text extraction misses.
 */
async function describeWithVision(env: Env, blob: Blob, fileName: string): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const imageData = [...new Uint8Array(buffer)];

  const visionModel = env.DEFAULT_VISION_MODEL || '@cf/meta/llama-3.2-11b-vision-instruct';
  const result = await aiRunWithRetry(
    env,
    visionModel as Parameters<typeof env.AI.run>[0],
    {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analyze this file and describe all visual content in detail. Include:
- Any text visible in the image that might not be captured by OCR
- Charts, graphs, and their data/trends
- Diagrams, flowcharts, and their relationships
- Tables and their content
- Screenshots and what they show
- Any other visual elements
File: ${fileName}`,
            },
            {
              type: 'image',
              image: imageData,
            },
          ],
        },
      ],
      max_tokens: 4096,
    } as Parameters<typeof env.AI.run>[1],
  );

  if (result && typeof result === 'object' && 'response' in result) {
    return (result as { response: string }).response;
  }
  return String(result);
}

/**
 * Transcribe audio using Whisper speech-to-text model.
 */
async function transcribeAudio(env: Env, r2Object: R2ObjectBody, fileName: string): Promise<string> {
  const buffer = await r2Object.arrayBuffer();
  const audioData = [...new Uint8Array(buffer)];

  const speechModel = env.DEFAULT_SPEECH_MODEL || '@cf/openai/whisper';
  const result = await aiRunWithRetry(
    env,
    speechModel as Parameters<typeof env.AI.run>[0],
    { audio: audioData } as Parameters<typeof env.AI.run>[1],
  );

  if (result && typeof result === 'object' && 'text' in result) {
    const text = (result as { text: string }).text;
    return `## Audio Transcription: ${fileName}\n\n${text}`;
  }
  return '';
}

/**
 * Combine markdown extraction and vision model output into a single text.
 */
function combineExtractions(markdownText: string, visionText: string, fileName: string): string {
  const parts: string[] = [];

  if (markdownText.trim()) {
    parts.push(`## Extracted Content from ${fileName}\n\n${markdownText.trim()}`);
  }

  if (visionText.trim()) {
    parts.push(`## Visual Content Description\n\n${visionText.trim()}`);
  }

  return parts.join('\n\n---\n\n');
}
