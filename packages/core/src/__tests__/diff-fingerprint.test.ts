import { describe, it, expect } from 'vitest';
import { analyzeDiff, compareToCodingStyle } from '../diff-fingerprint.js';
import type { DiffFingerprint } from '../diff-fingerprint.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────
//
// AI_DIFF: realistic AI-generated TypeScript — structured, well-commented,
//   uniform naming, full error handling, lots of boilerplate.
//
// HUMAN_DIFF: realistic human edit — small, inconsistent, quick-and-dirty fix.

const AI_DIFF = `\
diff --git a/src/api/userService.ts b/src/api/userService.ts
--- a/src/api/userService.ts
+++ b/src/api/userService.ts
@@ -0,0 +1,65 @@
+import { Injectable } from '@nestjs/common';
+import { InjectRepository } from '@nestjs/typeorm';
+import { Repository } from 'typeorm';
+import { User } from './entities/user.entity';
+import { CreateUserDto } from './dto/create-user.dto';
+import { UpdateUserDto } from './dto/update-user.dto';
+import { UserNotFoundException } from './exceptions/user-not-found.exception';
+
+/**
+ * Service responsible for all user-related business logic.
+ * Handles CRUD operations and delegates persistence to the repository layer.
+ */
+@Injectable()
+export class UserService {
+  constructor(
+    @InjectRepository(User)
+    private readonly userRepository: Repository<User>,
+  ) {}
+
+  /**
+   * Retrieve all users from the database.
+   * @returns Promise resolving to an array of User entities.
+   */
+  async findAll(): Promise<User[]> {
+    try {
+      return await this.userRepository.find();
+    } catch (error) {
+      throw new Error(\`Failed to retrieve users: \${error}\`);
+    }
+  }
+
+  /**
+   * Find a single user by their unique identifier.
+   * @param userId - The UUID of the user to retrieve.
+   */
+  async findById(userId: string): Promise<User> {
+    const user = await this.userRepository.findOne({ where: { id: userId } });
+    if (user === null || user === undefined) {
+      throw new UserNotFoundException(userId);
+    }
+    return user;
+  }
+
+  /**
+   * Create a new user record.
+   * @param createUserDto - Validated DTO containing user creation data.
+   */
+  async create(createUserDto: CreateUserDto): Promise<User> {
+    try {
+      const newUser = this.userRepository.create(createUserDto);
+      return await this.userRepository.save(newUser);
+    } catch (error) {
+      throw new Error(\`Failed to create user: \${error}\`);
+    }
+  }
+
+  /**
+   * Update an existing user's data.
+   * @param userId - The UUID of the user to update.
+   * @param updateUserDto - Partial DTO with fields to update.
+   */
+  async update(userId: string, updateUserDto: UpdateUserDto): Promise<User> {
+    const existingUser = await this.findById(userId);
+    const updatedUser = this.userRepository.merge(existingUser, updateUserDto);
+    return await this.userRepository.save(updatedUser);
+  }
+
+  /**
+   * Remove a user by ID.
+   * @param userId - The UUID of the user to delete.
+   */
+  async remove(userId: string): Promise<void> {
+    const user = await this.findById(userId);
+    await this.userRepository.remove(user);
+  }
+}
`;

const HUMAN_DIFF = `\
diff --git a/src/utils/format.ts b/src/utils/format.ts
--- a/src/utils/format.ts
+++ b/src/utils/format.ts
@@ -12,6 +12,14 @@
-const old_value = cache[key]
+const oldValue = cache[key]
+if (!oldValue) {
+  cache[key] = computeValue(key)
+  return cache[key]
+}
+// temp fix for the date bug reported by Mike
+const d = new Date(oldValue.ts)
+if (d.getFullYear() < 2020) {
+  cache[key] = null
+}
+return oldValue
`;

const EMPTY_DIFF = `\
diff --git a/src/noop.ts b/src/noop.ts
--- a/src/noop.ts
+++ b/src/noop.ts
@@ -1 +1 @@
-// old comment
+// new comment
`;

// A medium-size diff with mixed indicators
const MEDIUM_DIFF = `\
diff --git a/src/auth/middleware.ts b/src/auth/middleware.ts
--- a/src/auth/middleware.ts
+++ b/src/auth/middleware.ts
@@ -0,0 +1,28 @@
+import { Request, Response, NextFunction } from 'express';
+import { verifyToken } from '../utils/jwt';
+import { logger } from '../utils/logger';
+
+// Auth middleware — validates JWT on protected routes
+export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
+  const authHeader = req.headers['authorization'];
+  if (!authHeader || !authHeader.startsWith('Bearer ')) {
+    res.status(401).json({ error: 'Missing or invalid authorization header' });
+    return;
+  }
+  const token = authHeader.slice(7);
+  try {
+    const decoded = verifyToken(token);
+    if (decoded === null || decoded === undefined) {
+      res.status(401).json({ error: 'Token verification returned null' });
+      return;
+    }
+    // Attach the decoded payload to the request for downstream handlers
+    (req as any).user = decoded;
+    next();
+  } catch (error) {
+    logger.error('Token verification failed', { error });
+    res.status(401).json({ error: 'Invalid token' });
+  }
+}
`;

// ── analyzeDiff: basic parsing ────────────────────────────────────────────────

describe('analyzeDiff — diff parsing', () => {
  it('counts added lines correctly', () => {
    const fp = analyzeDiff(AI_DIFF);
    // The AI diff has 65 + lines (excluding the +++ header)
    expect(fp.linesAdded).toBeGreaterThan(50);
  });

  it('counts removed lines correctly', () => {
    const fp = analyzeDiff(HUMAN_DIFF);
    // HUMAN_DIFF removes the "const old_value" line
    expect(fp.linesRemoved).toBe(1);
  });

  it('excludes +++ and --- headers from counts', () => {
    const fp = analyzeDiff(AI_DIFF);
    // The +++ / --- header lines must not be counted as added/removed code lines
    expect(fp.linesAdded).toBeLessThan(90);   // fixture has ~76 code lines
    expect(fp.linesRemoved).toBe(0);          // no - lines in this hunk
  });

  it('returns zero counts for an empty diff string', () => {
    const fp = analyzeDiff('');
    expect(fp.linesAdded).toBe(0);
    expect(fp.linesRemoved).toBe(0);
  });

  it('handles a diff with only removal lines', () => {
    const deletionOnly = `--- a/x.ts\n+++ b/x.ts\n-const x = 1;\n-const y = 2;\n`;
    const fp = analyzeDiff(deletionOnly);
    expect(fp.linesAdded).toBe(0);
    expect(fp.linesRemoved).toBe(2);
  });
});

// ── analyzeDiff: coherenceScore ───────────────────────────────────────────────

describe('analyzeDiff — coherenceScore', () => {
  it('AI diff has high coherence score', () => {
    const fp = analyzeDiff(AI_DIFF);
    expect(fp.coherenceScore).toBeGreaterThan(0.70);
  });

  it('AI diff coherence is above 0.70', () => {
    // AI-generated code is highly self-consistent in indentation and style
    expect(analyzeDiff(AI_DIFF).coherenceScore).toBeGreaterThan(0.70);
  });

  it('a mixed-style diff scores lower coherence than a uniform one', () => {
    // Mixed: tabs AND spaces, semicolons AND no semicolons, single AND double quotes
    const mixedDiff = [
      '--- a/x.ts', '+++ b/x.ts',
      "+\tconst x = 'hello';",   // tab-indented, single quote, semicolon
      '+  const y = "world"',    // space-indented, double quote, no semicolon
      "+\tconst z = 'foo'",      // tab-indented, single quote, no semicolon
      '+  const w = "bar";',     // space-indented, double quote, semicolon
    ].join('\n');
    // Uniform: all spaces, all single quotes, all without semicolons
    const uniformDiff = [
      '--- a/x.ts', '+++ b/x.ts',
      "+  const x = 'hello'",
      "+  const y = 'world'",
      "+  const z = 'foo'",
      "+  const w = 'bar'",
    ].join('\n');
    expect(analyzeDiff(uniformDiff).coherenceScore).toBeGreaterThan(
      analyzeDiff(mixedDiff).coherenceScore,
    );
  });

  it('coherenceScore is in [0, 1]', () => {
    for (const diff of [AI_DIFF, HUMAN_DIFF, EMPTY_DIFF]) {
      const { coherenceScore } = analyzeDiff(diff);
      expect(coherenceScore).toBeGreaterThanOrEqual(0);
      expect(coherenceScore).toBeLessThanOrEqual(1);
    }
  });

  it('all-tabs diff does not score lower than all-spaces diff', () => {
    const tabDiff   = '--- a\n+++ b\n' + '\t'.repeat(1) + '+\tconst x = 1;\n+\tconst y = 2;\n';
    const spaceDiff = '--- a\n+++ b\n' + '+  const x = 1;\n+  const y = 2;\n';
    // both are internally consistent so coherence should be similarly high
    expect(analyzeDiff(tabDiff).coherenceScore).toBeGreaterThanOrEqual(0.5);
    expect(analyzeDiff(spaceDiff).coherenceScore).toBeGreaterThanOrEqual(0.5);
  });
});

// ── analyzeDiff: boilerplateRatio ─────────────────────────────────────────────

describe('analyzeDiff — boilerplateRatio', () => {
  it('AI diff has elevated boilerplate ratio', () => {
    const fp = analyzeDiff(AI_DIFF);
    // The AI diff has many imports, try/catch, JSDoc, decorators
    expect(fp.boilerplateRatio).toBeGreaterThan(0.20);
  });

  it('boilerplateRatio is higher for AI diff than human diff', () => {
    const aiFp    = analyzeDiff(AI_DIFF);
    const humanFp = analyzeDiff(HUMAN_DIFF);
    expect(aiFp.boilerplateRatio).toBeGreaterThan(humanFp.boilerplateRatio);
  });

  it('boilerplateRatio is in [0, 1]', () => {
    for (const diff of [AI_DIFF, HUMAN_DIFF, MEDIUM_DIFF]) {
      const { boilerplateRatio } = analyzeDiff(diff);
      expect(boilerplateRatio).toBeGreaterThanOrEqual(0);
      expect(boilerplateRatio).toBeLessThanOrEqual(1);
    }
  });

  it('diff with only imports scores near 1.0 boilerplate ratio', () => {
    const importOnly = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '+import { A } from "./a";',
      '+import { B } from "./b";',
      '+import { C } from "./c";',
    ].join('\n');
    expect(analyzeDiff(importOnly).boilerplateRatio).toBeGreaterThan(0.8);
  });
});

// ── analyzeDiff: commentDensity ───────────────────────────────────────────────

describe('analyzeDiff — commentDensity', () => {
  it('AI diff (with JSDoc) has higher comment density than human quick-fix', () => {
    const aiFp    = analyzeDiff(AI_DIFF);
    const humanFp = analyzeDiff(HUMAN_DIFF);
    expect(aiFp.commentDensity).toBeGreaterThan(humanFp.commentDensity);
  });

  it('diff with no comments has commentDensity = 0', () => {
    const noComment = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '+const a = 1;',
      '+const b = 2;',
      '+const c = a + b;',
    ].join('\n');
    expect(analyzeDiff(noComment).commentDensity).toBe(0);
  });

  it('commentDensity is non-negative', () => {
    for (const diff of [AI_DIFF, HUMAN_DIFF, EMPTY_DIFF]) {
      expect(analyzeDiff(diff).commentDensity).toBeGreaterThanOrEqual(0);
    }
  });

  it('detects Python # comments', () => {
    const pyDiff = [
      'diff --git a/util.py b/util.py',
      '--- a/util.py',
      '+++ b/util.py',
      '+# Helper function for formatting',
      '+def format_value(val):',
      '+    # strip whitespace',
      '+    return val.strip()',
    ].join('\n');
    expect(analyzeDiff(pyDiff).commentDensity).toBeGreaterThan(0);
  });
});

// ── analyzeDiff: namingConsistency ────────────────────────────────────────────

describe('analyzeDiff — namingConsistency', () => {
  it('AI diff has high naming consistency', () => {
    // AI diff uses camelCase throughout (findAll, findById, createUserDto…)
    expect(analyzeDiff(AI_DIFF).namingConsistency).toBeGreaterThan(0.60);
  });

  it('namingConsistency is in [0, 1]', () => {
    for (const diff of [AI_DIFF, HUMAN_DIFF, MEDIUM_DIFF]) {
      const { namingConsistency } = analyzeDiff(diff);
      expect(namingConsistency).toBeGreaterThanOrEqual(0);
      expect(namingConsistency).toBeLessThanOrEqual(1);
    }
  });

  it('returns 0.5 for a diff with fewer than 4 identifiable names', () => {
    const tinyDiff = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '+x = 1;',
    ].join('\n');
    expect(analyzeDiff(tinyDiff).namingConsistency).toBe(0.5);
  });

  it('mixed snake_case and camelCase lowers consistency vs pure camelCase', () => {
    const pureCamel = [
      '--- a/x.ts', '+++ b/x.ts',
      '+const getUserName = () => {};',
      '+const fetchUserData = () => {};',
      '+const updateUserProfile = () => {};',
      '+const deleteUserAccount = () => {};',
    ].join('\n');
    const mixed = [
      '--- a/x.ts', '+++ b/x.ts',
      '+const get_user_name = () => {};',
      '+const fetchUserData = () => {};',
      '+const update_user_profile = () => {};',
      '+const deleteUserAccount = () => {};',
    ].join('\n');
    expect(analyzeDiff(pureCamel).namingConsistency).toBeGreaterThan(
      analyzeDiff(mixed).namingConsistency,
    );
  });
});

// ── analyzeDiff: aiLikelihood ─────────────────────────────────────────────────

describe('analyzeDiff — aiLikelihood', () => {
  it('AI diff scores higher likelihood than human diff', () => {
    const aiFp    = analyzeDiff(AI_DIFF);
    const humanFp = analyzeDiff(HUMAN_DIFF);
    expect(aiFp.aiLikelihood).toBeGreaterThan(humanFp.aiLikelihood);
  });

  it('AI diff has aiLikelihood > 0.50', () => {
    expect(analyzeDiff(AI_DIFF).aiLikelihood).toBeGreaterThan(0.50);
  });

  it('empty diff has aiLikelihood = 0', () => {
    expect(analyzeDiff('').aiLikelihood).toBe(0);
  });

  it('aiLikelihood is in [0, 1]', () => {
    for (const diff of [AI_DIFF, HUMAN_DIFF, MEDIUM_DIFF, EMPTY_DIFF]) {
      const { aiLikelihood } = analyzeDiff(diff);
      expect(aiLikelihood).toBeGreaterThanOrEqual(0);
      expect(aiLikelihood).toBeLessThanOrEqual(1);
    }
  });

  it('size bonus applies: >50 lines adds 0.20', () => {
    // Build a diff > 50 pure code lines (no comments, no boilerplate, low coherence variety)
    const bigLines = Array.from({ length: 55 }, (_, i) => `+const x${i} = ${i};`).join('\n');
    const smallLines = Array.from({ length: 5 },  (_, i) => `+const x${i} = ${i};`).join('\n');
    const bigDiff   = `--- a/x.ts\n+++ b/x.ts\n${bigLines}`;
    const smallDiff = `--- a/x.ts\n+++ b/x.ts\n${smallLines}`;
    expect(analyzeDiff(bigDiff).aiLikelihood).toBeGreaterThan(analyzeDiff(smallDiff).aiLikelihood);
  });

  it('high comment density triggers +0.15 bonus', () => {
    const heavyComment = [
      '--- a/x.ts', '+++ b/x.ts',
      '+// Step 1: validate input',
      '+const a = validate(input);',
      '+// Step 2: process result',
      '+const b = process(a);',
      '+// Step 3: return',
      '+return b;',
    ].join('\n');
    const noComment = [
      '--- a/x.ts', '+++ b/x.ts',
      '+const a = validate(input);',
      '+const b = process(a);',
      '+return b;',
    ].join('\n');
    expect(analyzeDiff(heavyComment).aiLikelihood).toBeGreaterThan(
      analyzeDiff(noComment).aiLikelihood,
    );
  });
});

// ── analyzeDiff: indicators ───────────────────────────────────────────────────

describe('analyzeDiff — indicators', () => {
  it('AI diff produces at least two indicator strings', () => {
    expect(analyzeDiff(AI_DIFF).indicators.length).toBeGreaterThanOrEqual(2);
  });

  it('large insertion indicator mentions line count', () => {
    const fp = analyzeDiff(AI_DIFF);
    const sizeIndicator = fp.indicators.find(i => /large insertion/i.test(i));
    expect(sizeIndicator).toBeDefined();
    expect(sizeIndicator).toMatch(/\d+ lines/);
  });

  it('empty diff produces no indicators', () => {
    expect(analyzeDiff('').indicators).toHaveLength(0);
  });

  it('indicators is always an array', () => {
    for (const diff of [AI_DIFF, HUMAN_DIFF, MEDIUM_DIFF]) {
      expect(Array.isArray(analyzeDiff(diff).indicators)).toBe(true);
    }
  });

  it('boilerplate indicator fires when ratio is above 0.25', () => {
    const importHeavy = Array.from({ length: 10 }, (_, i) =>
      `+import { Thing${i} } from './thing${i}';`,
    ).join('\n');
    const diff = `--- a/x.ts\n+++ b/x.ts\n${importHeavy}`;
    const fp = analyzeDiff(diff);
    expect(fp.indicators.some(i => /boilerplate/i.test(i))).toBe(true);
  });
});

// ── analyzeDiff: full shape ───────────────────────────────────────────────────

describe('analyzeDiff — return shape', () => {
  it('returns all required fields', () => {
    const fp = analyzeDiff(HUMAN_DIFF);
    const keys: Array<keyof DiffFingerprint> = [
      'linesAdded', 'linesRemoved', 'coherenceScore', 'boilerplateRatio',
      'commentDensity', 'namingConsistency', 'aiLikelihood', 'indicators',
    ];
    for (const key of keys) {
      expect(fp).toHaveProperty(key);
    }
  });

  it('all numeric fields are finite numbers', () => {
    const fp = analyzeDiff(AI_DIFF);
    for (const key of ['linesAdded', 'linesRemoved', 'coherenceScore',
      'boilerplateRatio', 'commentDensity', 'namingConsistency', 'aiLikelihood'] as const) {
      expect(Number.isFinite(fp[key])).toBe(true);
    }
  });
});

// ── compareToCodingStyle ──────────────────────────────────────────────────────

describe('compareToCodingStyle', () => {
  // Build a baseline from several human-like diffs
  const humanFp = analyzeDiff(HUMAN_DIFF);

  // Baseline: three fingerprints that are close to the human diff
  const humanBaseline: DiffFingerprint[] = [
    humanFp,
    { ...humanFp, coherenceScore: humanFp.coherenceScore + 0.05, aiLikelihood: humanFp.aiLikelihood + 0.02, indicators: [] },
    { ...humanFp, boilerplateRatio: humanFp.boilerplateRatio + 0.03, aiLikelihood: humanFp.aiLikelihood - 0.01, indicators: [] },
  ];

  it('returns deviation = 0 with no baseline', () => {
    const { deviation, details } = compareToCodingStyle(HUMAN_DIFF, []);
    expect(deviation).toBe(0);
    expect(details.some(d => /no baseline/i.test(d))).toBe(true);
  });

  it('deviation is in [0, 1]', () => {
    const { deviation } = compareToCodingStyle(AI_DIFF, humanBaseline);
    expect(deviation).toBeGreaterThanOrEqual(0);
    expect(deviation).toBeLessThanOrEqual(1);
  });

  it('AI diff deviates more from a human baseline than another human diff does', () => {
    const aiDeviation    = compareToCodingStyle(AI_DIFF,    humanBaseline).deviation;
    const humanDeviation = compareToCodingStyle(HUMAN_DIFF, humanBaseline).deviation;
    expect(aiDeviation).toBeGreaterThan(humanDeviation);
  });

  it('diff similar to baseline has low deviation', () => {
    // Compare the exact diff that made the baseline — should be near-zero
    const { deviation } = compareToCodingStyle(HUMAN_DIFF, humanBaseline);
    expect(deviation).toBeLessThan(0.20);
  });

  it('returns details array', () => {
    const { details } = compareToCodingStyle(AI_DIFF, humanBaseline);
    expect(Array.isArray(details)).toBe(true);
    expect(details.length).toBeGreaterThan(0);
  });

  it('large deviation surfaces specific metric details', () => {
    const { details } = compareToCodingStyle(AI_DIFF, humanBaseline);
    // AI diff has much more boilerplate and higher AI likelihood — at least one metric reported
    const hasMetricDetail = details.some(d => /ratio|likelihood|coherence|naming|density|lines/i.test(d));
    expect(hasMetricDetail).toBe(true);
  });

  it('within-range deviation produces a "within normal range" message', () => {
    // Use a single-item baseline that exactly matches what the diff will produce
    const fp = analyzeDiff(MEDIUM_DIFF);
    const { details } = compareToCodingStyle(MEDIUM_DIFF, [fp]);
    expect(details.some(d => /within normal range/i.test(d))).toBe(true);
  });

  it('baseline of one fingerprint still works', () => {
    const { deviation } = compareToCodingStyle(HUMAN_DIFF, [humanFp]);
    expect(Number.isFinite(deviation)).toBe(true);
  });

  it('deviation is higher when comparing AI diff to a human-heavy baseline', () => {
    const aiFp = analyzeDiff(AI_DIFF);
    const aiBaseline: DiffFingerprint[] = [aiFp, aiFp, aiFp]; // baseline that matches AI style

    const deviationAgainstHuman = compareToCodingStyle(AI_DIFF, humanBaseline).deviation;
    const deviationAgainstAI    = compareToCodingStyle(AI_DIFF, aiBaseline).deviation;
    expect(deviationAgainstHuman).toBeGreaterThan(deviationAgainstAI);
  });
});
