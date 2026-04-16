/**
 * Tests for the shared tag filtering logic, including recursive TagGroup support.
 */

import { describe, it, expect } from 'vitest';
import { matchesTags, evaluateTagGroup, evaluateTagGroups, filterByTags } from '../src/engine/tag-filter';
import type { TagGroup } from '../src/types';

// =============================================================================
// matchesTags (flat)
// =============================================================================

describe('matchesTags — flat tag matching', () => {
  it('returns true when no filter tags', () => {
    expect(matchesTags(['a', 'b'], [], 'any')).toBe(true);
  });

  it('any — matches if any tag present', () => {
    expect(matchesTags(['a', 'b'], ['b', 'c'], 'any')).toBe(true);
    expect(matchesTags(['a'], ['b', 'c'], 'any')).toBe(false);
  });

  it('all — matches only if all filter tags present', () => {
    expect(matchesTags(['a', 'b', 'c'], ['a', 'b'], 'all')).toBe(true);
    expect(matchesTags(['a'], ['a', 'b'], 'all')).toBe(false);
  });

  it('any — includes untagged rows', () => {
    expect(matchesTags([], ['a'], 'any')).toBe(true);
  });

  it('all — includes untagged rows', () => {
    expect(matchesTags([], ['a'], 'all')).toBe(true);
  });

  it('any_strict — excludes untagged rows', () => {
    expect(matchesTags([], ['a'], 'any_strict')).toBe(false);
  });

  it('all_strict — excludes untagged rows', () => {
    expect(matchesTags([], ['a'], 'all_strict')).toBe(false);
  });
});

// =============================================================================
// evaluateTagGroup — recursive boolean expressions
// =============================================================================

describe('evaluateTagGroup — leaf nodes', () => {
  it('leaf with default match (any)', () => {
    const group: TagGroup = { tags: ['a', 'b'] };
    expect(evaluateTagGroup(['a'], group)).toBe(true);
    expect(evaluateTagGroup(['c'], group)).toBe(false);
  });

  it('leaf with explicit match mode', () => {
    const group: TagGroup = { tags: ['a', 'b'], match: 'all' };
    expect(evaluateTagGroup(['a', 'b', 'c'], group)).toBe(true);
    expect(evaluateTagGroup(['a'], group)).toBe(false);
  });

  it('leaf with strict mode excludes untagged', () => {
    const group: TagGroup = { tags: ['a'], match: 'any_strict' };
    expect(evaluateTagGroup([], group)).toBe(false);
    expect(evaluateTagGroup(['a'], group)).toBe(true);
  });
});

describe('evaluateTagGroup — AND', () => {
  it('all children must match', () => {
    const group: TagGroup = {
      and: [
        { tags: ['frontend'] },
        { tags: ['v2'] },
      ],
    };
    expect(evaluateTagGroup(['frontend', 'v2'], group)).toBe(true);
    expect(evaluateTagGroup(['frontend'], group)).toBe(false);
    expect(evaluateTagGroup(['v2'], group)).toBe(false);
  });

  it('empty AND matches everything', () => {
    const group: TagGroup = { and: [] };
    expect(evaluateTagGroup(['anything'], group)).toBe(true);
    expect(evaluateTagGroup([], group)).toBe(true);
  });
});

describe('evaluateTagGroup — OR', () => {
  it('any child can match', () => {
    const group: TagGroup = {
      or: [
        { tags: ['frontend'] },
        { tags: ['backend'] },
      ],
    };
    expect(evaluateTagGroup(['frontend'], group)).toBe(true);
    expect(evaluateTagGroup(['backend'], group)).toBe(true);
    expect(evaluateTagGroup(['infra'], group)).toBe(false);
  });

  it('empty OR matches nothing', () => {
    const group: TagGroup = { or: [] };
    expect(evaluateTagGroup(['anything'], group)).toBe(false);
  });
});

describe('evaluateTagGroup — NOT', () => {
  it('inverts child match', () => {
    const group: TagGroup = { not: { tags: ['deprecated'] } };
    expect(evaluateTagGroup(['active'], group)).toBe(true);
    expect(evaluateTagGroup(['deprecated'], group)).toBe(false);
    expect(evaluateTagGroup(['deprecated', 'active'], group)).toBe(false);
  });
});

describe('evaluateTagGroup — nested expressions', () => {
  it('AND with nested NOT — include frontend but exclude deprecated', () => {
    const group: TagGroup = {
      and: [
        { tags: ['frontend'] },
        { not: { tags: ['deprecated'] } },
      ],
    };
    expect(evaluateTagGroup(['frontend', 'active'], group)).toBe(true);
    expect(evaluateTagGroup(['frontend', 'deprecated'], group)).toBe(false);
    expect(evaluateTagGroup(['backend'], group)).toBe(false);
  });

  it('OR with nested AND — complex filter', () => {
    const group: TagGroup = {
      or: [
        { and: [{ tags: ['frontend'] }, { tags: ['v2'] }] },
        { and: [{ tags: ['backend'] }, { tags: ['v2'] }] },
      ],
    };
    expect(evaluateTagGroup(['frontend', 'v2'], group)).toBe(true);
    expect(evaluateTagGroup(['backend', 'v2'], group)).toBe(true);
    expect(evaluateTagGroup(['frontend', 'v1'], group)).toBe(false);
    expect(evaluateTagGroup(['infra', 'v2'], group)).toBe(false);
  });

  it('deeply nested — NOT inside OR inside AND', () => {
    const group: TagGroup = {
      and: [
        { tags: ['project-x'] },
        {
          or: [
            { tags: ['frontend'] },
            { not: { tags: ['legacy'] } },
          ],
        },
      ],
    };
    // project-x + frontend -> true (AND: has project-x, OR: has frontend)
    expect(evaluateTagGroup(['project-x', 'frontend'], group)).toBe(true);
    // project-x + backend -> true (AND: has project-x, OR: NOT legacy passes)
    expect(evaluateTagGroup(['project-x', 'backend'], group)).toBe(true);
    // project-x + legacy -> true (AND: has project-x, OR: NOT legacy fails but... legacy doesn't have frontend)
    // Actually: OR checks frontend (false) then NOT legacy (false) -> OR is false -> AND is false
    expect(evaluateTagGroup(['project-x', 'legacy'], group)).toBe(false);
    // no project-x -> false
    expect(evaluateTagGroup(['frontend'], group)).toBe(false);
  });
});

// =============================================================================
// evaluateTagGroups — multiple top-level groups (AND)
// =============================================================================

describe('evaluateTagGroups — multiple groups combined with AND', () => {
  it('all groups must pass', () => {
    const groups: TagGroup[] = [
      { tags: ['frontend'] },
      { not: { tags: ['deprecated'] } },
    ];
    expect(evaluateTagGroups(['frontend', 'active'], groups)).toBe(true);
    expect(evaluateTagGroups(['frontend', 'deprecated'], groups)).toBe(false);
    expect(evaluateTagGroups(['backend'], groups)).toBe(false);
  });

  it('empty groups array matches everything', () => {
    expect(evaluateTagGroups(['anything'], [])).toBe(true);
  });
});

// =============================================================================
// filterByTags — combined flat + groups
// =============================================================================

describe('filterByTags — combined filter', () => {
  it('no options matches everything', () => {
    expect(filterByTags(['a'])).toBe(true);
    expect(filterByTags([])).toBe(true);
  });

  it('flat tags only', () => {
    expect(filterByTags(['a', 'b'], { tags: ['a'], tagsMatch: 'any' })).toBe(true);
    expect(filterByTags(['c'], { tags: ['a'], tagsMatch: 'any' })).toBe(false);
  });

  it('tag groups only', () => {
    expect(filterByTags(['a'], { tagGroups: [{ tags: ['a'] }] })).toBe(true);
    expect(filterByTags(['b'], { tagGroups: [{ tags: ['a'] }] })).toBe(false);
  });

  it('both flat and groups — both must pass', () => {
    expect(filterByTags(['a', 'b'], {
      tags: ['a'],
      tagsMatch: 'any',
      tagGroups: [{ not: { tags: ['deprecated'] } }],
    })).toBe(true);

    // flat passes but groups fail
    expect(filterByTags(['a', 'deprecated'], {
      tags: ['a'],
      tagsMatch: 'any',
      tagGroups: [{ not: { tags: ['deprecated'] } }],
    })).toBe(false);

    // groups pass but flat fails
    expect(filterByTags(['b'], {
      tags: ['a'],
      tagsMatch: 'any_strict',
      tagGroups: [{ not: { tags: ['deprecated'] } }],
    })).toBe(false);
  });
});
