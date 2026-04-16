/**
 * Shared tag filtering logic.
 *
 * Supports both flat tags + tags_match and recursive TagGroup boolean expressions
 * (AND / OR / NOT) matching the upstream hindsight API.
 */

import type { TagGroup, TagsMatch } from '../types';

/**
 * Evaluate whether a row's tags pass a flat tags + match filter.
 *
 * Semantics match upstream:
 *   - 'any'        — OR logic, includes untagged items
 *   - 'all'        — AND logic, includes untagged items
 *   - 'any_strict' — OR logic, excludes untagged items
 *   - 'all_strict' — AND logic, excludes untagged items
 */
export function matchesTags(rowTags: string[], filterTags: string[], match: TagsMatch = 'any'): boolean {
  if (!filterTags.length) return true;
  if (!rowTags.length) return match === 'any' || match === 'all'; // non-strict includes untagged
  if (match === 'any' || match === 'any_strict') {
    return filterTags.some((t) => rowTags.includes(t));
  }
  // all / all_strict
  return filterTags.every((t) => rowTags.includes(t));
}

/**
 * Evaluate a single TagGroup against a row's tags.
 *
 * TagGroup is a recursive union:
 *   - { tags, match? } — leaf: flat tag match
 *   - { and: TagGroup[] } — all children must match
 *   - { or: TagGroup[] } — any child must match
 *   - { not: TagGroup } — child must NOT match
 */
export function evaluateTagGroup(rowTags: string[], group: TagGroup): boolean {
  if ('and' in group) {
    return group.and.every((child) => evaluateTagGroup(rowTags, child));
  }
  if ('or' in group) {
    return group.or.some((child) => evaluateTagGroup(rowTags, child));
  }
  if ('not' in group) {
    return !evaluateTagGroup(rowTags, group.not);
  }
  // Leaf node: { tags, match? }
  return matchesTags(rowTags, group.tags, group.match ?? 'any');
}

/**
 * Evaluate an array of TagGroups against a row's tags.
 *
 * Multiple top-level groups are combined with AND logic (all must pass),
 * matching upstream behavior.
 */
export function evaluateTagGroups(rowTags: string[], groups: TagGroup[]): boolean {
  return groups.every((group) => evaluateTagGroup(rowTags, group));
}

/**
 * Combined filter: checks both flat tags/tags_match and tag_groups.
 *
 * If both are provided, both must pass (AND). If neither is provided, returns true.
 */
export function filterByTags(
  rowTags: string[],
  options?: { tags?: string[]; tagsMatch?: TagsMatch; tagGroups?: TagGroup[] },
): boolean {
  if (!options) return true;

  // Flat tags filter
  if (options.tags?.length) {
    if (!matchesTags(rowTags, options.tags, options.tagsMatch ?? 'any')) return false;
  }

  // Tag groups filter
  if (options.tagGroups?.length) {
    if (!evaluateTagGroups(rowTags, options.tagGroups)) return false;
  }

  return true;
}
