/** export 域 IPC（SPEC §14 任务 6.6）：export:manuscript 导出成稿（txt/md/docx/epub） */

import { ipcMain } from 'electron';
import type { ExportManuscriptReq, ExportManuscriptRes } from '@novel-forge/shared';
import type { AppDatabase } from '../db/index.js';
import { defaultExportsDir, exportManuscript } from '../services/export-manuscript.js';

export interface ExportIpcDeps {
  db: AppDatabase;
  /** 测试注入用；缺省 = db 文件旁 exports/ */
  exportsDir?: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerExportIpc(deps: ExportIpcDeps): void {
  ipcMain.handle('export:manuscript', async (_event, req: ExportManuscriptReq): Promise<ExportManuscriptRes> => {
    try {
      const result = exportManuscript(
        deps.db,
        req.projectId,
        req.format,
        deps.exportsDir ?? defaultExportsDir(deps.db),
      );
      return { ok: true, path: result.path };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });
}
