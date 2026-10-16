/** style 域 IPC：Phase 5 真实实现（SPEC §4.1 style:import / style:get）
 *
 * style:import：校验 bookPaths 非空且文件存在 → sidecar /style/analyze SSE 逐事件
 *   emit style:import-progress（jobId 为本次导入预生成 uuid；Done 帧 styleId 才是档案 id，
 *   完成后补发一条 stage='done' 事件带 styleId 字段——SPEC-CHANGELOG 登记）
 *   → Done.profile（缺省回退 sidecar getStyle）→ StylesRepository.upsertProfile 落库
 *   → 返回 { ok: true, jobId: styleId }。
 * style:list / style:delete / style:pick-files：§4.1 未列（§12.4 风格库 UI 需要），
 *   SPEC-CHANGELOG 登记。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dialog, ipcMain } from 'electron';
import type {
  StreamEvent,
  StyleDeleteReq,
  StyleDeleteRes,
  StyleGetReq,
  StyleGetRes,
  StyleImportReq,
  StyleImportRes,
  StyleListRes,
  StylePickFilesRes,
  StyleProfile,
  StyleSelfCheckReq,
  StyleSelfCheckRes,
} from '@novel-forge/shared';
import type { AppDatabase } from '../db/index.js';
import { StylesRepository } from '../db/repositories/styles.js';
import type { SidecarClient } from '../sidecar/client.js';

export interface StyleIpcDeps {
  db: AppDatabase;
  sidecar?: SidecarClient;
  emit: (event: StreamEvent) => void;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 风格相似度自测阈值（SPEC §15「风格相似度 > 阈值（按 N 分档）」口径：
 *  N=1 单本 0.55；2≤N≤4 少量 0.65；N≥5 充分 0.75。score >= threshold 即达标。 */
const SELF_CHECK_THRESHOLDS = { one: 0.55, few: 0.65, many: 0.75 } as const;

/** N 分档（N = style_books 作品条目数，契约冻结口径） */
type SelfCheckBand = keyof typeof SELF_CHECK_THRESHOLDS;

function selfCheckBand(n: number): SelfCheckBand {
  if (n <= 1) return 'one';
  if (n <= 4) return 'few';
  return 'many';
}

/** 单次自测参与打分的风格库语料上限（rag_chunks 段数可达成千上万，
 *  逐条全量打分会拖慢 IPC；取前若干段均分作为自测口径） */
const SELF_CHECK_MAX_SAMPLES = 50;

export function registerStyleIpc(deps: StyleIpcDeps): void {
  const styles = new StylesRepository(deps.db);

  ipcMain.handle('style:import', async (_event, req: StyleImportReq): Promise<StyleImportRes> => {
    try {
      if (!deps.sidecar) return { ok: false, error: 'sidecar 未配置，风格分析不可用' };
      if (typeof req.authorName !== 'string' || req.authorName.trim() === '') {
        return { ok: false, error: '作者名不能为空' };
      }
      if (!Array.isArray(req.bookPaths) || req.bookPaths.length === 0) {
        return { ok: false, error: 'bookPaths 不能为空' };
      }
      const missing = req.bookPaths.filter((p) => !fs.existsSync(p));
      if (missing.length > 0) {
        return { ok: false, error: `文件不存在：${missing.join('、')}` };
      }

      // 进度事件的 jobId：预生成（Done 帧的 styleId 才是档案 id）
      const jobId = randomUUID();
      const books = req.bookPaths.map((p) => ({ title: path.basename(p), path: p }));

      let styleId: string | undefined;
      let profile: StyleProfile | undefined;
      for await (const ev of deps.sidecar.styleAnalyze({
        authorName: req.authorName,
        genre: req.genre,
        books,
      })) {
        if (ev.type === 'progress') {
          deps.emit({ type: 'style:import-progress', jobId, stage: ev.stage, progress: ev.progress });
        } else if (ev.type === 'error') {
          return { ok: false, error: ev.error };
        } else {
          styleId = ev.styleId;
          profile = ev.profile ?? (await deps.sidecar.getStyle(ev.styleId));
        }
      }
      if (styleId === undefined || profile === undefined) {
        return { ok: false, error: 'sidecar 未返回分析结果' };
      }

      styles.upsertProfile(profile);
      deps.emit({ type: 'style:import-progress', jobId, stage: 'done', progress: 1, styleId });
      return { ok: true, jobId: styleId };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('style:get', async (_event, req: StyleGetReq): Promise<StyleGetRes> => {
    try {
      const profile = styles.getProfile(req.styleId);
      if (!profile) return { ok: false, error: 'style not found' };
      return { ok: true, profile };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  // Phase 5 新增频道（§4.1 未列，SPEC-CHANGELOG 登记）
  ipcMain.handle('style:list', async (): Promise<StyleListRes> => {
    try {
      return { ok: true, styles: styles.listProfiles() };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  // Phase 5 新增频道（§4.1 未列，SPEC-CHANGELOG 登记）；sidecar 侧删除失败仅 warn
  ipcMain.handle('style:delete', async (_event, req: StyleDeleteReq): Promise<StyleDeleteRes> => {
    try {
      styles.deleteProfile(req.styleId);
      if (deps.sidecar) {
        try {
          await deps.sidecar.deleteStyle(req.styleId);
        } catch (err) {
          console.warn('[novel-forge] sidecar 删除风格失败（本地已删，忽略）：', err);
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  // Phase 5 新增频道（§4.1 未列，SPEC-CHANGELOG 登记）：导入作品文件选择
  ipcMain.handle('style:pick-files', async (): Promise<StylePickFilesRes> => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '作品文件', extensions: ['txt', 'epub'] }],
      });
      return { ok: true, paths: result.filePaths, ...(result.canceled ? { canceled: true } : {}) };
    } catch (err) {
      return { ok: false, paths: [], error: errMsg(err) };
    }
  });

  // 收尾批次 4 新增（SPEC §15「风格相似度 > 阈值（按 N 分档）」+ §12.4 面板自测区）：
  // N = style_books 条目数（契约口径）；样本语料取 rag_chunks.text（style_books 无文本列，
  // 风格库正文语料在 rag_chunks，PENDING-batch4 登记）；逐条 /discriminator/score 取均分。
  ipcMain.handle('style:self-check', async (_event, req: StyleSelfCheckReq): Promise<StyleSelfCheckRes> => {
    try {
      if (!deps.sidecar) return { ok: false, error: 'sidecar 未配置，风格自测不可用' };
      const sidecar = deps.sidecar;
      const { n } = deps.db
        .prepare('SELECT COUNT(*) AS n FROM style_books WHERE style_id = ?')
        .get(req.styleId) as { n: number };
      if (n === 0) {
        return { ok: true, skipped: true, reason: '风格库无样本', n: 0 };
      }
      const texts = (
        deps.db
          .prepare('SELECT text FROM rag_chunks WHERE style_id = ? ORDER BY rowid ASC LIMIT ?')
          .all(req.styleId, SELF_CHECK_MAX_SAMPLES) as { text: string }[]
      ).map((r) => r.text);
      if (texts.length === 0) {
        // 有作品条目但语料未入库（导入中断等）：同样按无样本跳过
        return { ok: true, skipped: true, reason: '风格库无样本', n };
      }

      let sum = 0;
      try {
        for (const text of texts) {
          const res = await sidecar.discriminatorScore({ styleId: req.styleId, text });
          sum += res.score;
        }
      } catch {
        // 判别器未训练（sidecar 400）或调用失败：无分可判定
        return { ok: true, skipped: true, reason: '判别器未训练或不可用', n };
      }

      const band = selfCheckBand(n);
      return {
        ok: true,
        score: sum / texts.length,
        n,
        band,
        threshold: SELF_CHECK_THRESHOLDS[band],
      };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });
}
