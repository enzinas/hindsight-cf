/**
 * Utility for batched Vectorize vector deletion.
 *
 * Vectorize may impose per-call limits on deleteByIds (upsert is documented
 * at 1000). We chunk conservatively at 500 IDs per call to stay well within
 * any undocumented ceiling.
 */

const DELETE_BATCH_SIZE = 500;

/**
 * Delete vectors from a Vectorize index in batches.
 *
 * Logs warnings on partial failures but does not throw, so callers can
 * proceed with the D1 side of the delete without leaving the request in
 * a half-applied state.
 *
 * @returns The total number of vectors confirmed deleted.
 */
export async function deleteVectorsBatched(
  vectorize: VectorizeIndex,
  ids: string[],
): Promise<{ deletedCount: number; errors: string[] }> {
  if (ids.length === 0) return { deletedCount: 0, errors: [] };

  let deletedCount = 0;
  const errors: string[] = [];

  for (let i = 0; i < ids.length; i += DELETE_BATCH_SIZE) {
    const batch = ids.slice(i, i + DELETE_BATCH_SIZE);
    try {
      const result = await vectorize.deleteByIds(batch);
      deletedCount += result.count;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[vectorize] deleteByIds failed for batch at offset ${i} (${batch.length} ids): ${msg}`);
      errors.push(msg);
    }
  }

  return { deletedCount, errors };
}
