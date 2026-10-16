/** SPEC §7.3 context.style：context → stylePrompt
 *
 * 风格注入：DB 读风格档案（params.styleId 指定，缺省取最近更新一条），
 * 拼「报告 markdown（截 maxReportChars）+ 指纹摘要行」作为下游 system prompt；
 * 风格库为空时输出缺省「你是小说作家。」。纯 DB 节点，不依赖 sidecar。
 */

import { StylesRepository } from '../../db/repositories/styles.js';
import type { StyleProfile } from '@novel-forge/shared';
import type { NodeDefinition } from '../types.js';

/** 无风格档案时的缺省 system prompt（与 generate.paragraph-multi 缺省一致） */
export const DEFAULT_STYLE_PROMPT = '你是小说作家。';

/** 指纹摘要行：句长 X.X · 对白 XX% · 短句比 XX% · 标志词 a/b/c */
export function fingerprintSummaryLine(profile: StyleProfile): string {
  const fp = profile.fingerprint;
  const signature = fp.signatureWords.slice(0, 3).join('/');
  return (
    `句长 ${fp.avgSentenceLength.toFixed(1)} · ` +
    `对白 ${(fp.dialogueRatio * 100).toFixed(0)}% · ` +
    `短句比 ${(fp.shortSentenceRatio * 100).toFixed(0)}% · ` +
    `标志词 ${signature !== '' ? signature : '无'}`
  );
}

/** 拼风格 system prompt：报告 markdown（截断）+ 指纹摘要行 */
export function buildStylePrompt(profile: StyleProfile, maxReportChars: number): string {
  const markdown = String(profile.report['markdown'] ?? profile.report['summary'] ?? '');
  const truncated =
    maxReportChars > 0 && markdown.length > maxReportChars
      ? `${markdown.slice(0, maxReportChars)}…`
      : markdown;
  const parts: string[] = [];
  if (truncated !== '') parts.push(truncated);
  parts.push(`【风格指纹】${fingerprintSummaryLine(profile)}`);
  return parts.join('\n\n');
}

export const contextStyleNode: NodeDefinition = {
  type: 'context.style',
  title: '风格注入',
  inputs: [{ name: 'context', dataType: 'GenerationContext' }],
  outputs: [{ name: 'stylePrompt', dataType: 'string' }],
  params: [
    { name: 'styleId', type: 'string', default: '', description: '风格档案 id（空则取最近更新一条）' },
    { name: 'maxReportChars', type: 'number', default: 1200, description: '报告 markdown 截断长度' },
  ],
  async execute(ctx) {
    const styles = new StylesRepository(ctx.db);
    const paramStyleId = String(ctx.node.params['styleId'] ?? '');
    const maxReportChars = Math.max(0, Number(ctx.node.params['maxReportChars'] ?? 1200));

    const profile =
      paramStyleId !== '' ? styles.getProfile(paramStyleId) : styles.latestProfile();
    if (!profile) {
      ctx.log(paramStyleId !== '' ? `风格档案 ${paramStyleId} 不存在，使用默认风格提示` : '风格库为空，使用默认风格提示');
      return { stylePrompt: DEFAULT_STYLE_PROMPT };
    }

    ctx.log(`风格注入：${profile.authorName}（${profile.id}）`);
    return { stylePrompt: buildStylePrompt(profile, maxReportChars) };
  },
};
