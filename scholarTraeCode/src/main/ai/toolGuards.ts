// 工具执行守卫：禁止文件/命令拦截 + 同命令防抖
// 独立文件，避免在大函数里插入时贴错位置。

/** 禁止的文件名模式：测试性/示例文件不应出现在正式项目中 */
const FORBIDDEN_FILE_RE =
  /(^|\/)(example|test|temp|tmp|demo|sample)\.(txt|md|json|js|ts)$/i

/** 禁止的命令模式：直接装包/初始化/全局安装都应通过 package.json 声明依赖 */
const FORBIDDEN_CMD_RE =
  /\bnpm\s+(install|i)\s+[@a-z][a-z0-9-]*@[\d.]+|\bnpm\s+(init|create)\b|\bnpm\s+(install|i)\s+-g\b/i

/** 同命令防抖窗口与阈值 */
const CMD_THROTTLE_WINDOW_MS = 60_000
const CMD_THROTTLE_THRESHOLD = 2

/**
 * 检查写入文件是否命中禁止模式。
 * @returns 拦截文案；放行返回 null
 */
export function checkForbiddenFile(name: string, path: string): string | null {
  if (name !== 'write' && name !== 'write_file') return null
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  if (FORBIDDEN_FILE_RE.test(normalized)) {
    return `错误：【禁止文件拦截】${path} 属于测试性/示例文件，禁止写入。Vue/Node 项目只允许创建标准结构文件。`
  }
  return null
}

/**
 * 检查命令是否命中禁止模式。
 * @returns 拦截文案；放行返回 null
 */
export function checkForbiddenCommand(cmd: string): string | null {
  if (!cmd) return null
  if (FORBIDDEN_CMD_RE.test(cmd)) {
    return `错误：【禁止命令拦截】${cmd} 属于禁止命令（直接装包/初始化/全局安装）。必须通过 write_file 写 package.json 声明依赖，禁止用 npm init/create。`
  }
  return null
}

/**
 * 同命令防抖：60 秒内同命令执行 ≥2 次（含本次）即拦截。
 * 副作用：放行时自动将本次调用时间戳记入 history。
 * @returns 拦截文案；放行返回 null
 */
export function checkCommandThrottle(
  cmd: string,
  history: Map<string, number[]>
): string | null {
  if (!cmd) return null
  const now = Date.now()
  const recent = (history.get(cmd) ?? []).filter((t) => now - t < CMD_THROTTLE_WINDOW_MS)
  if (recent.length >= CMD_THROTTLE_THRESHOLD) {
    return `错误：【防抖拦截】${cmd} 在 60 秒内已执行 ${recent.length} 次且均秒退，判定为死循环。请先用 read_file / list_directory 定位问题，禁止重复执行该命令。`
  }
  recent.push(now)
  history.set(cmd, recent)
  return null
}
