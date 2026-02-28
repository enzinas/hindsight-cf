/**
 * Retain pipeline orchestrator.
 *
 * Coordinates the full retain flow:
 *   1. Fact extraction (LLM)
 *   2. Embedding generation (Workers AI)
 *   3. ProcessedFact conversion
 *   4. Document tracking
 *   5. Chunk storage
 *   6. Deduplication
 *   7. Fact insertion (D1 + Vectorize)
 *   8. Entity processing
 *   9. Link creation (temporal, semantic, entity, causal)
 *
 * Ported from hindsight-api/engine/retain/orchestrator.py.
 */

import type { Env } from '../../env';
import type { RetainContent, ProcessedFact, EntityRef, RetainResult, LLMUsage } from './types';
import { extractFactsFromContents } from './fact-extraction';
import { generateEmbeddings } from '../../providers/embeddings';
import { ensureBank, handleDocumentTracking, insertFactsBatch } from './fact-storage';
import { storeChunksBatch, mapFactsToChunks } from './chunk-storage';
import { checkDuplicatesBatch, filterDuplicates } from './deduplication';
import { processEntitiesBatch } from './entity-processing';
import {
  createTemporalLinksBatch,
  createSemanticLinksBatch,
  createCausalLinksBatch,
  insertEntityLinksBatch,
} from './link-creation';

/**
 * Generate a UUID v4.
 */
function generateUUID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

/**
 * Run the full retain pipeline.
 *
 * This is the main entry point called from the route handler.
 */
export async function retainBatch(
  env: Env,
  bankId: string,
  contents: RetainContent[],
  options?: {
    documentId?: string | null;
    documentTags?: string[];
    extractCausalLinks?: boolean;
  },
): Promise<RetainResult> {
  const documentId = options?.documentId ?? generateUUID();
  const documentTags = options?.documentTags ?? [];
  const totalUsage: LLMUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  // Merge document_tags into content-level tags
  if (documentTags.length > 0) {
    for (const content of contents) {
      const tagSet = new Set([...content.tags, ...documentTags]);
      content.tags = [...tagSet];
    }
  }

  // Get bank config for mission
  const bankRow = await env.DB.prepare('SELECT mission, config FROM banks WHERE bank_id = ?')
    .bind(bankId)
    .first<{ mission: string; config: string }>();

  const bankConfig = {
    mission: bankRow?.mission ?? '',
    extractCausalLinks: options?.extractCausalLinks ?? false,
  };

  // Step 1: Ensure bank exists
  await ensureBank(env.DB, bankId);

  // Step 2: Fact extraction (LLM call)
  console.log(`[retain] Extracting facts from ${contents.length} content items...`);
  const {
    facts: extractedFacts,
    chunks,
    usage: extractionUsage,
  } = await extractFactsFromContents(env, contents, bankConfig);

  totalUsage.inputTokens += extractionUsage.inputTokens;
  totalUsage.outputTokens += extractionUsage.outputTokens;
  totalUsage.totalTokens += extractionUsage.totalTokens;

  if (extractedFacts.length === 0) {
    console.log('[retain] No facts extracted, returning empty result');
    return {
      unitIdsByContent: contents.map(() => []),
      usage: totalUsage,
    };
  }

  console.log(`[retain] Extracted ${extractedFacts.length} facts from ${chunks.length} chunks`);

  // Step 3: Generate embeddings with date augmentation
  const augmentedTexts = extractedFacts.map((fact) => {
    const date = fact.occurredStart ?? fact.mentionedAt;
    try {
      const formatted = new Date(date).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      return `${fact.factText} (happened on ${formatted})`;
    } catch {
      return fact.factText;
    }
  });

  console.log(`[retain] Generating embeddings for ${augmentedTexts.length} facts...`);
  const embeddings = await generateEmbeddings(env, augmentedTexts);

  // Step 4: Convert to ProcessedFact objects
  const processedFacts: ProcessedFact[] = extractedFacts.map((fact, i) => ({
    factText: fact.factText,
    factType: fact.factType,
    embedding: embeddings[i],
    occurredStart: fact.occurredStart,
    occurredEnd: fact.occurredEnd,
    mentionedAt: fact.mentionedAt,
    context: fact.context,
    metadata: fact.metadata,
    where: fact.where,
    entities: fact.entities.map((name) => ({ name }) as EntityRef),
    causalRelations: fact.causalRelations,
    chunkId: null,
    documentId: null,
    unitId: null,
    contentIndex: fact.contentIndex,
    tags: fact.tags,
  }));

  // Step 5: Document tracking
  console.log('[retain] Tracking document...');
  const fullText = contents.map((c) => c.content).join('\n\n');
  const allMetadata = contents[0]?.metadata ?? {};
  await handleDocumentTracking(env.DB, bankId, documentId, fullText, allMetadata, documentTags);

  // Step 6: Chunk storage
  console.log(`[retain] Storing ${chunks.length} chunks...`);
  const chunkIdMap = await storeChunksBatch(env.DB, bankId, documentId, chunks);

  // Assign chunk IDs and document IDs to facts
  const chunkIds = mapFactsToChunks(
    processedFacts.map((f) => extractedFacts[processedFacts.indexOf(f)].chunkIndex),
    chunkIdMap,
  );
  for (let i = 0; i < processedFacts.length; i++) {
    processedFacts[i].chunkId = chunkIds[i];
    processedFacts[i].documentId = documentId;
  }

  // Step 7: Deduplication
  console.log('[retain] Checking for duplicates...');
  const isDuplicate = await checkDuplicatesBatch(env.VECTORIZE, bankId, processedFacts);
  const nonDuplicateFacts = filterDuplicates(processedFacts, isDuplicate);

  console.log(
    `[retain] ${processedFacts.length - nonDuplicateFacts.length} duplicates filtered, ${nonDuplicateFacts.length} facts to store`,
  );

  if (nonDuplicateFacts.length === 0) {
    return {
      unitIdsByContent: mapResultsToContents(contents, extractedFacts, isDuplicate, []),
      usage: totalUsage,
    };
  }

  // Step 8: Insert facts into D1 + Vectorize
  console.log(`[retain] Inserting ${nonDuplicateFacts.length} facts...`);
  const unitIds = await insertFactsBatch(env.DB, env.VECTORIZE, bankId, nonDuplicateFacts, documentId);

  // Step 9: Entity processing
  console.log('[retain] Processing entities...');
  const userEntitiesPerContent = new Map<number, Array<{ text: string; type?: string }>>();
  for (let i = 0; i < contents.length; i++) {
    if (contents[i].entities.length > 0) {
      userEntitiesPerContent.set(i, contents[i].entities);
    }
  }

  const entityLinks = await processEntitiesBatch(env.DB, bankId, unitIds, nonDuplicateFacts, userEntitiesPerContent);

  // Step 10: Temporal links
  console.log('[retain] Creating temporal links...');
  await createTemporalLinksBatch(env.DB, bankId, unitIds);

  // Step 11: Semantic links
  console.log('[retain] Creating semantic links...');
  const nonDupEmbeddings = nonDuplicateFacts.map((f) => f.embedding);
  await createSemanticLinksBatch(env.DB, env.VECTORIZE, bankId, unitIds, nonDupEmbeddings);

  // Step 12: Entity links
  console.log('[retain] Inserting entity links...');
  await insertEntityLinksBatch(env.DB, entityLinks);

  // Step 13: Causal links
  console.log('[retain] Creating causal links...');
  await createCausalLinksBatch(env.DB, unitIds, nonDuplicateFacts);

  console.log(`[retain] Complete: ${unitIds.length} facts stored`);

  // Map results back to contents
  const unitIdsByContent = mapResultsToContents(contents, extractedFacts, isDuplicate, unitIds);

  return { unitIdsByContent, usage: totalUsage };
}

/**
 * Map created unit IDs back to original content items.
 *
 * Accounts for filtered duplicates.
 */
function mapResultsToContents(
  contents: RetainContent[],
  extractedFacts: Array<{ contentIndex: number }>,
  isDuplicate: boolean[],
  unitIds: string[],
): string[][] {
  const result: string[][] = contents.map(() => []);

  let unitIdIndex = 0;
  for (let factIndex = 0; factIndex < extractedFacts.length; factIndex++) {
    if (!isDuplicate[factIndex]) {
      if (unitIdIndex < unitIds.length) {
        const contentIndex = extractedFacts[factIndex].contentIndex;
        if (contentIndex < result.length) {
          result[contentIndex].push(unitIds[unitIdIndex]);
        }
        unitIdIndex++;
      }
    }
  }

  return result;
}
