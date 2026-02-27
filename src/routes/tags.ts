/**
 * Tags endpoint.
 */
import { Hono } from 'hono';
import type { Env } from '../env';

const app = new Hono<{ Bindings: Env }>();

// GET /tags — list all unique tags for a bank
app.get('/', async (c) => {
  const bankId = c.req.param('bank_id');

  // Tags are stored as JSON arrays in memory_units.tags
  // We need to extract unique tags across all memory units
  const results = await c.env.DB.prepare(
    "SELECT DISTINCT tags FROM memory_units WHERE bank_id = ? AND tags != '[]'"
  ).bind(bankId).all();

  const tagSet = new Set<string>();
  for (const row of results.results) {
    const tags = JSON.parse(row.tags as string) as string[];
    for (const tag of tags) {
      tagSet.add(tag);
    }
  }

  return c.json({
    tags: Array.from(tagSet).sort(),
  });
});

export { app as tagsRoutes };
