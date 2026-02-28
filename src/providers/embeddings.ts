/**
 * Embedding generation via Workers AI.
 *
 * Uses @cf/baai/bge-base-en-v1.5 (768 dimensions) by default.
 */

import type { Env } from '../env';

/**
 * Generate embeddings for a batch of texts.
 *
 * Workers AI supports batched embedding requests.
 */
export async function generateEmbeddings(
  env: Env,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const model = env.DEFAULT_EMBEDDING_MODEL;

  // Workers AI embedding models accept { text: string[] }
  const result = await env.AI.run(model as Parameters<Ai['run']>[0], {
    text: texts,
  });

  const data = result as { data?: number[][] };
  if (!data.data || data.data.length !== texts.length) {
    throw new Error(
      `Embedding model returned ${data.data?.length ?? 0} vectors for ${texts.length} texts`,
    );
  }

  return data.data;
}

/**
 * Generate a single embedding.
 */
export async function generateEmbedding(
  env: Env,
  text: string,
): Promise<number[]> {
  const [embedding] = await generateEmbeddings(env, [text]);
  return embedding;
}
