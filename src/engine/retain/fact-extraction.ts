/**
 * Fact extraction from content using LLM.
 *
 * Ported from hindsight-api/engine/retain/fact_extraction.py.
 * Extracts structured facts from text using LLM with detailed prompts.
 */

import type { Env } from '../../env';
import { llmChatJson, type ChatMessage } from '../../providers/llm';
import type { ExtractedFact, RetainContent, ChunkMetadata, LLMUsage } from './types';

// =============================================================================
// Prompt Templates — ported from the original Python
// =============================================================================

const BASE_FACT_EXTRACTION_PROMPT = `You are a fact extraction engine. Your job is to extract discrete, atomic facts from the given text.

CRITICAL RULES:
1. Output MUST be in the SAME LANGUAGE as the input text. If input is in Spanish, output in Spanish. If Japanese, output in Japanese. This is mandatory.
2. Each fact must be self-contained and understandable without the original text.
3. Resolve all pronouns and references to their actual names/entities. "He went to the store" should become "John went to the store" if John is the referent.
4. Preserve temporal information. Convert relative dates to absolute dates when possible using the provided event_date.
5. Extract entities mentioned in each fact.

FACT TYPES:
- "world": Objective facts about the world, events, or states of affairs
- "experience": Personal experiences, things that happened to someone
- "opinion": Subjective opinions, preferences, or beliefs

TEMPORAL HANDLING:
- "yesterday" → subtract 1 day from event_date
- "last week" → subtract 7 days from event_date
- "last month" → subtract 1 month from event_date
- "last night" → same day or previous day, evening
- "this morning" → same day, morning
- Provide occurred_start and occurred_end as ISO 8601 strings when temporal info is available

ENTITY EXTRACTION:
- Extract all named entities (people, organizations, places, products, etc.)
- Include implicit references resolved to names
- List entity names as strings

OUTPUT FORMAT: JSON array of objects, each with:
{
  "fact_text": "The self-contained fact statement",
  "fact_type": "world" | "experience" | "opinion",
  "entities": ["Entity1", "Entity2"],
  "occurred_start": "ISO datetime or null",
  "occurred_end": "ISO datetime or null",
  "where": "location or null"
}`;

const CONCISE_GUIDELINES = `
SELECTIVITY GUIDELINES:
- Only extract facts worth remembering long-term
- Skip greetings, filler, process chatter, pleasantries
- Skip meta-commentary about the conversation itself
- Focus on substantive information: decisions, preferences, plans, events, relationships
- When in doubt, skip it — quality over quantity
- Aim for 1-5 facts per chunk of text, not exhaustive extraction`;

const CAUSAL_SECTION = `
CAUSAL RELATIONSHIPS:
When one fact is caused by or leads to another fact IN THIS SAME BATCH, add:
  "causal_relations": [{"target_fact_index": <index>, "relation_type": "caused_by", "strength": 0.0-1.0}]
where target_fact_index is the 0-based index of the target fact in your output array.
Only reference facts within this same response. Omit if no causal relations exist.`;

const CONCISE_PROMPT = BASE_FACT_EXTRACTION_PROMPT + CONCISE_GUIDELINES;

// =============================================================================
// Text Chunking
// =============================================================================

const DEFAULT_CHUNK_SIZE = 4000; // characters

/**
 * Split text into chunks at sentence boundaries.
 */
export function chunkText(text: string, maxChunkSize: number = DEFAULT_CHUNK_SIZE): string[] {
  if (text.length <= maxChunkSize) {
    return [text];
  }

  // Try to detect if this is a JSON conversation array
  const trimmed = text.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown[];
      if (Array.isArray(parsed)) {
        return chunkConversation(parsed, maxChunkSize);
      }
    } catch {
      // Not valid JSON, fall through to sentence splitting
    }
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxChunkSize) {
    // Find the last sentence boundary within maxChunkSize
    const segment = remaining.substring(0, maxChunkSize);
    let splitPoint = -1;

    // Try splitting at sentence boundaries: .\n, !\n, ?\n, then . ! ?
    for (const sep of ['. ', '.\n', '! ', '!\n', '? ', '?\n']) {
      const idx = segment.lastIndexOf(sep);
      if (idx > maxChunkSize * 0.3) {
        splitPoint = idx + sep.length;
        break;
      }
    }

    // Fallback: split at newline
    if (splitPoint === -1) {
      const nlIdx = segment.lastIndexOf('\n');
      if (nlIdx > maxChunkSize * 0.3) {
        splitPoint = nlIdx + 1;
      }
    }

    // Last resort: split at space
    if (splitPoint === -1) {
      const spaceIdx = segment.lastIndexOf(' ');
      splitPoint = spaceIdx > 0 ? spaceIdx + 1 : maxChunkSize;
    }

    chunks.push(remaining.substring(0, splitPoint).trim());
    remaining = remaining.substring(splitPoint).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Chunk a JSON conversation array.
 */
function chunkConversation(messages: unknown[], maxChunkSize: number): string[] {
  const chunks: string[] = [];
  let currentChunk: unknown[] = [];
  let currentSize = 0;

  for (const msg of messages) {
    const msgStr = JSON.stringify(msg);
    if (currentSize + msgStr.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(JSON.stringify(currentChunk));
      currentChunk = [];
      currentSize = 0;
    }
    currentChunk.push(msg);
    currentSize += msgStr.length;
  }

  if (currentChunk.length > 0) {
    chunks.push(JSON.stringify(currentChunk));
  }

  return chunks;
}

// =============================================================================
// Fact Extraction
// =============================================================================

interface RawFact {
  fact_text: string;
  fact_type: string;
  entities?: string[];
  occurred_start?: string | null;
  occurred_end?: string | null;
  where?: string | null;
  causal_relations?: Array<{
    target_fact_index: number;
    relation_type: string;
    strength?: number;
  }>;
}

/**
 * Extract facts from a single text chunk via LLM.
 */
async function extractFactsFromChunk(
  env: Env,
  chunkText: string,
  context: string,
  eventDate: string,
  mission: string,
  extractCausal: boolean,
): Promise<{ facts: RawFact[]; usage: LLMUsage }> {
  let systemPrompt = CONCISE_PROMPT;

  if (mission) {
    systemPrompt += `\n\nFOCUS: ${mission}`;
  }

  if (extractCausal) {
    systemPrompt += CAUSAL_SECTION;
  }

  let userMessage = `Event date: ${eventDate}\n\n`;
  if (context) {
    userMessage += `Context: ${context}\n\n`;
  }
  userMessage += `Text to extract facts from:\n${chunkText}`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  const response = await llmChatJson<RawFact[]>(env, messages, {
    maxTokens: 4096,
    temperature: 0.1,
  });

  // Ensure we got an array
  const facts = Array.isArray(response.data) ? response.data : [];

  return {
    facts,
    usage: {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      totalTokens: response.inputTokens + response.outputTokens,
    },
  };
}

/**
 * Sanitize text by removing null bytes and invalid unicode.
 */
function sanitizeText(text: string): string {
  return text.replace(/\0/g, '').replace(/[\uD800-\uDFFF]/g, '');
}

/**
 * Infer absolute date from relative temporal expressions.
 */
function inferTemporalDate(expression: string | null | undefined, eventDate: string): string | null {
  if (!expression) return null;

  // If it's already an ISO date, return as-is
  try {
    const d = new Date(expression);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch {
    // Not a valid date string
  }

  // Try relative expressions
  const baseDate = new Date(eventDate);
  const lower = expression.toLowerCase().trim();

  if (lower === 'yesterday') {
    baseDate.setDate(baseDate.getDate() - 1);
    return baseDate.toISOString();
  }
  if (lower === 'today' || lower === 'this morning' || lower === 'this afternoon') {
    return baseDate.toISOString();
  }
  if (lower === 'last week') {
    baseDate.setDate(baseDate.getDate() - 7);
    return baseDate.toISOString();
  }
  if (lower === 'last month') {
    baseDate.setMonth(baseDate.getMonth() - 1);
    return baseDate.toISOString();
  }
  if (lower === 'last night') {
    baseDate.setDate(baseDate.getDate() - 1);
    baseDate.setHours(21, 0, 0, 0);
    return baseDate.toISOString();
  }

  return null;
}

/**
 * Convert a RawFact from LLM to an ExtractedFact.
 */
function convertRawFact(
  raw: RawFact,
  contentIndex: number,
  chunkIndex: number,
  eventDate: string,
  context: string,
  metadata: Record<string, string>,
  tags: string[],
): ExtractedFact | null {
  // Validate required fields
  if (!raw.fact_text || typeof raw.fact_text !== 'string') return null;

  const factType = (['world', 'experience', 'opinion'] as const).includes(
    raw.fact_type as 'world' | 'experience' | 'opinion',
  )
    ? (raw.fact_type as 'world' | 'experience' | 'opinion')
    : 'world';

  return {
    factText: sanitizeText(raw.fact_text),
    factType,
    entities: (raw.entities ?? []).filter((e) => typeof e === 'string').map(sanitizeText),
    occurredStart: inferTemporalDate(raw.occurred_start, eventDate),
    occurredEnd: inferTemporalDate(raw.occurred_end, eventDate),
    where: raw.where ?? null,
    causalRelations: (raw.causal_relations ?? []).map((cr) => ({
      relationType: cr.relation_type ?? 'caused_by',
      targetFactIndex: cr.target_fact_index,
      strength: cr.strength ?? 1.0,
    })),
    contentIndex,
    chunkIndex,
    context,
    mentionedAt: eventDate,
    metadata,
    tags,
  };
}

/**
 * Extract facts from multiple content items.
 *
 * This is the main entry point for fact extraction.
 * Handles chunking, parallel LLM calls, and result aggregation.
 */
export async function extractFactsFromContents(
  env: Env,
  contents: RetainContent[],
  bankConfig: { mission?: string; extractCausalLinks?: boolean },
): Promise<{
  facts: ExtractedFact[];
  chunks: ChunkMetadata[];
  usage: LLMUsage;
}> {
  const allFacts: ExtractedFact[] = [];
  const allChunks: ChunkMetadata[] = [];
  const totalUsage: LLMUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  let globalChunkIndex = 0;

  // Process each content item
  // We could parallelize this with Promise.all, but for Workers AI rate limits,
  // sequential is safer for initial implementation
  for (let contentIndex = 0; contentIndex < contents.length; contentIndex++) {
    const content = contents[contentIndex];
    const textChunks = chunkText(content.content);

    // Extract facts from each chunk
    const chunkPromises = textChunks.map(async (chunk, localChunkIdx) => {
      const currentChunkIndex = globalChunkIndex + localChunkIdx;

      const { facts: rawFacts, usage } = await extractFactsFromChunk(
        env,
        chunk,
        content.context,
        content.eventDate,
        bankConfig.mission ?? '',
        bankConfig.extractCausalLinks ?? false,
      );

      // Convert raw facts to ExtractedFact objects
      const extractedFacts: ExtractedFact[] = [];
      for (const raw of rawFacts) {
        const fact = convertRawFact(
          raw,
          contentIndex,
          currentChunkIndex,
          content.eventDate,
          content.context,
          content.metadata,
          content.tags,
        );
        if (fact) {
          extractedFacts.push(fact);
        }
      }

      // Track chunk metadata
      const chunkMeta: ChunkMetadata = {
        chunkText: chunk,
        factCount: extractedFacts.length,
        contentIndex,
        chunkIndex: currentChunkIndex,
      };

      return { extractedFacts, chunkMeta, usage };
    });

    const results = await Promise.all(chunkPromises);

    for (const { extractedFacts, chunkMeta, usage } of results) {
      allFacts.push(...extractedFacts);
      allChunks.push(chunkMeta);
      totalUsage.inputTokens += usage.inputTokens;
      totalUsage.outputTokens += usage.outputTokens;
      totalUsage.totalTokens += usage.totalTokens;
    }

    globalChunkIndex += textChunks.length;
  }

  // Add microsecond offsets to preserve ordering within a document
  addTemporalOffsets(allFacts);

  return { facts: allFacts, chunks: allChunks, usage: totalUsage };
}

/**
 * Add microsecond offsets to mentionedAt to preserve ordering.
 */
function addTemporalOffsets(facts: ExtractedFact[]): void {
  for (let i = 0; i < facts.length; i++) {
    const date = new Date(facts[i].mentionedAt);
    // Add microsecond offset (1ms per fact) to preserve ordering
    date.setMilliseconds(date.getMilliseconds() + i);
    facts[i].mentionedAt = date.toISOString();
  }
}
