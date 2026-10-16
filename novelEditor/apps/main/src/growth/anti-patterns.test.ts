/** 反模式库（§10.2/验收）单测：高频不满意标签 → 约束文本；improve 提示词组装 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../db/index.js';
import { PromptVersionsRepository } from '../db/repositories/prompt-versions.js';
import { SatisfactionTagsRepository } from '../db/repositories/satisfaction-tags.js';
import { ANTI_PATTERN_MIN_COUNT, appendAntiPattern, buildAntiPatternConstraints } from './anti-patterns.js';
import { buildImproveSystemPrompt } from './prompt-evolution.js';

let db: AppDatabase;

beforeEach(async () => {
  db = await openDatabase(':memory:');
  db.prepare(
    "INSERT INTO projects (id, name, genre, created_at, updated_at) VALUES ('p1', '测试', '仙侠', 1, 1)",
  ).run();
});

describe('buildAntiPatternConstraints', () => {
  it('negative 标签 count ≥ 阈值 → 组装约束文本（按 count 降序、含次数）', () => {
    const tags = new SatisfactionTagsRepository(db);
    tags.increment('p1', '节奏太快', 'negative');
    tags.increment('p1', '节奏太快', 'negative');
    tags.increment('p1', '节奏太快', 'negative');
    tags.increment('p1', '人设崩', 'negative');
    tags.increment('p1', '人设崩', 'negative');
    tags.increment('p1', '太水', 'negative'); // 1 次 < 阈值，不入库

    const text = buildAntiPatternConstraints(db, 'p1');
    expect(text).toContain('以下问题被用户多次标记为不满意，生成时务必避免：');
    expect(text).toContain('- 节奏太快（出现 3 次）');
    expect(text).toContain('- 人设崩（出现 2 次）');
    expect(text).not.toContain('太水');
    // 降序：节奏太快在前
    expect(text.indexOf('节奏太快')).toBeLessThan(text.indexOf('人设崩'));
  });

  it('count 低于阈值或无 negative 标签 → 空串', () => {
    const tags = new SatisfactionTagsRepository(db);
    tags.increment('p1', '节奏太快', 'negative'); // 仅 1 次
    expect(buildAntiPatternConstraints(db, 'p1')).toBe('');
    tags.increment('p1', '节奏太快', 'negative');
    expect(buildAntiPatternConstraints(db, 'p1')).not.toBe('');
    // positive 标签不参与
    tags.increment('p1', '张力足', 'positive');
    tags.increment('p1', '张力足', 'positive');
    expect(buildAntiPatternConstraints(db, 'p1')).not.toContain('张力足');
    // 其他项目隔离
    expect(buildAntiPatternConstraints(db, 'p2')).toBe('');
  });

  it('阈值常量口径：ANTI_PATTERN_MIN_COUNT=2', () => {
    expect(ANTI_PATTERN_MIN_COUNT).toBe(2);
  });
});

describe('appendAntiPattern / buildImproveSystemPrompt', () => {
  it('空约束原样返回，非空追加', () => {
    expect(appendAntiPattern('基础', '')).toBe('基础');
    expect(appendAntiPattern('基础', '约束')).toBe('基础\n\n约束');
  });

  it('improve 提示词 = prompt_versions 最新演化模板 + 反模式段（§10.5 消费点）', () => {
    new PromptVersionsRepository(db).insert({ projectId: 'p1', nodeType: 'improve', content: '演化后的改进提示词' });
    const tags = new SatisfactionTagsRepository(db);
    tags.increment('p1', '节奏太快', 'negative');
    tags.increment('p1', '节奏太快', 'negative');
    const prompt = buildImproveSystemPrompt(db, 'p1');
    expect(prompt).toContain('演化后的改进提示词');
    expect(prompt).toContain('务必避免');
  });

  it('无演化模板 → 回退缺省提示词', () => {
    expect(buildImproveSystemPrompt(db, 'p1')).toBe('你是小说作家。');
  });
});
