import { describe, it, expect } from 'vitest'
import { gateBashCommand, gateBashMessage, checkCommandOrder, type BashGateContext } from './bashGate'
import { getProfile, NODE_GATE_PROFILE } from '../../shared/projectProfiles'

function makeCtx(overrides: Partial<BashGateContext> = {}): BashGateContext {
  return {
    isProjectCreation: true,
    createdFiles: new Set<string>(),
    ranNpmInstall: false,
    ranServe: false,
    ...overrides
  }
}

describe('gateBashCommand - 交互式命令分类（interactive）', () => {
  it('vue create 归为 interactive', () => {
    const v = gateBashCommand('vue create my-app', makeCtx())
    expect(v?.kind).toBe('interactive')
    expect(v?.message).toContain('PTY')
  })

  it('npx create-react-app 归为 interactive', () => {
    const v = gateBashCommand('npx create-react-app app', makeCtx())
    expect(v?.kind).toBe('interactive')
  })

  it('npm create vue@ 归为 interactive（无 -y）', () => {
    const v = gateBashCommand('npm create vue@latest', makeCtx())
    expect(v?.kind).toBe('interactive')
  })

  it('npm init -y 在项目创建场景被拦截（空壳 package.json 禁令），非创建场景放行', () => {
    // 项目创建：npm init -y 生成无 dependencies 的空壳 → deny，强制 write_file 写完整清单
    const denied = gateBashCommand('npm init -y', makeCtx())
    expect(denied?.kind).toBe('deny')
    expect(denied?.message).toContain('npm init')
    expect(denied?.message).toContain('write_file')
    // 非项目创建（用户在既有仓库操作）：不拦
    expect(gateBashCommand('npm init -y', makeCtx({ isProjectCreation: false }))).toBeNull()
    // npm init <pkg> 脚手架形态仍归 interactive（不被禁令误伤）
    expect(gateBashCommand('npm init vue@latest', makeCtx())?.kind).toBe('interactive')
  })

  it('yarn create vite 归为 interactive', () => {
    const v = gateBashCommand('yarn create vite app', makeCtx())
    expect(v?.kind).toBe('interactive')
  })

  it('django-admin startproject 归为 interactive', () => {
    const v = gateBashCommand('django-admin startproject mysite', makeCtx())
    expect(v?.kind).toBe('interactive')
  })

  it('apt install 无 -y 归为 interactive', () => {
    const v = gateBashCommand('apt install nginx', makeCtx())
    expect(v?.kind).toBe('interactive')
    expect(v?.message).toContain('-y')
  })

  it('apt install -y 放行', () => {
    expect(gateBashCommand('apt install -y nginx', makeCtx())).toBeNull()
  })

  it('git commit 无 -m 归为 interactive', () => {
    const v = gateBashCommand('git commit', makeCtx())
    expect(v?.kind).toBe('interactive')
    expect(v?.message).toContain('-m')
  })

  it('git commit -m 放行', () => {
    expect(gateBashCommand('git commit -m "fix"', makeCtx())).toBeNull()
  })
})

describe('gateBashCommand - 系统级破坏命令（deny）', () => {
  it('sudo 被永久拒绝', () => {
    const v = gateBashCommand('sudo rm -rf /tmp/x', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('禁止执行 sudo')
  })

  it('rm -rf / 被拒绝', () => {
    const v = gateBashCommand('rm -rf /', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('禁止')
  })

  it('rm -rf ~ 被拒绝', () => {
    const v = gateBashCommand('rm -rf ~', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('禁止')
  })

  it('rm -rf ./node_modules 放行（非系统路径）', () => {
    expect(gateBashCommand('rm -rf ./node_modules', makeCtx())).toBeNull()
  })

  it('mkfs 被拒绝', () => {
    const v = gateBashCommand('mkfs.ext4 /dev/sda1', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('禁止')
  })

  it('dd if= 被拒绝', () => {
    const v = gateBashCommand('dd if=/dev/zero of=/dev/sda', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('禁止')
  })

  it('systemctl disable 被拒绝', () => {
    const v = gateBashCommand('systemctl disable sshd', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('禁止')
  })

  it('iptables 被拒绝', () => {
    const v = gateBashCommand('iptables -A INPUT -p tcp --dport 80 -j ACCEPT', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('禁止')
  })

  it('shutdown 被拒绝', () => {
    const v = gateBashCommand('shutdown -h now', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('禁止')
  })

  it('reg delete HKLM 被拒绝', () => {
    const v = gateBashCommand('reg delete HKLM\\SOFTWARE\\foo', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('禁止')
  })

  it('chmod -R 777 /etc 被拒绝', () => {
    const v = gateBashCommand('chmod -R 777 /etc', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('禁止')
  })

  it('chmod 755 ./file 放行', () => {
    expect(gateBashCommand('chmod 755 ./deploy.sh', makeCtx())).toBeNull()
  })
})

describe('gateBashCommand - 多生态依赖图谱（deny）', () => {
  it('go build 无 go.mod 被拒绝', () => {
    const v = gateBashCommand('go build ./...', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('go.mod')
  })

  it('go build 有 go.mod 放行', () => {
    const ctx = makeCtx({ createdFiles: new Set(['/p/go.mod']) })
    expect(gateBashCommand('go build ./...', ctx)).toBeNull()
  })

  it('cargo build 无 Cargo.toml 被拒绝', () => {
    const v = gateBashCommand('cargo build', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('Cargo.toml')
  })

  it('cargo build 有 Cargo.toml 放行', () => {
    const ctx = makeCtx({ createdFiles: new Set(['/p/Cargo.toml']) })
    expect(gateBashCommand('cargo build', ctx)).toBeNull()
  })

  it('docker compose up 无 docker-compose.yml 被拒绝', () => {
    const v = gateBashCommand('docker compose up -d', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('docker-compose.yml')
  })

  it('docker compose up 有 docker-compose.yml 放行', () => {
    const ctx = makeCtx({ createdFiles: new Set(['/p/docker-compose.yml']) })
    expect(gateBashCommand('docker compose up -d', ctx)).toBeNull()
  })

  it('pip install -r 无 requirements.txt 被拒绝', () => {
    const v = gateBashCommand('pip install -r requirements.txt', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('requirements.txt')
  })

  it('mvn compile 无 pom.xml 被拒绝', () => {
    const v = gateBashCommand('mvn compile', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('pom.xml')
  })

  it('gradle build 无 build.gradle 被拒绝', () => {
    const v = gateBashCommand('gradle build', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('build.gradle')
  })
})

describe('gateBashCommand - npm 顺序锁（deny）', () => {
  it('npm install 无 package.json 被拒绝', () => {
    const v = gateBashCommand('npm install', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('当前目录缺少 package.json')
    expect(v?.message).toContain('请先使用 write_file 创建 package.json')
  })

  it('npm install 带包名（npm install vue@2.7.16）无 package.json 同样被拒绝', () => {
    const v = gateBashCommand('npm install vue@2.7.16', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('当前目录缺少 package.json')
    expect(v?.message).toContain('npm install <包名>')
  })

  it('npm install 有 package.json 放行', () => {
    const ctx = makeCtx({ createdFiles: new Set(['/p/package.json']) })
    expect(gateBashCommand('npm install', ctx)).toBeNull()
  })

  it('npm install -g 全局安装被画像禁令硬拦（任何场景生效）', () => {
    const v = gateBashCommand('npm install -g typescript', makeCtx())
    expect(v?.kind).toBe('deny')
    expect(v && v.kind === 'deny' ? v.message : '').toContain('禁止全局安装')
  })

  it('npm run serve 未 install 被拒绝', () => {
    const ctx = makeCtx({ createdFiles: new Set(['/p/package.json']), ranNpmInstall: false })
    const v = gateBashCommand('npm run serve', ctx)
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('依赖尚未安装')
  })

  it('npm run serve 已 install 放行', () => {
    const ctx = makeCtx({ createdFiles: new Set(['/p/package.json']), ranNpmInstall: true })
    expect(gateBashCommand('npm run serve', ctx)).toBeNull()
  })

  it('npm run build 未 install（旧口径 undefined）不拦——仅 serve/dev/start 在回退口径内', () => {
    const ctx = makeCtx({ createdFiles: new Set(['/p/package.json']), ranNpmInstall: false })
    expect(gateBashCommand('npm run build', ctx)).toBeNull()
  })
})

describe('gateBashCommand - NPM 硬锁（显式磁盘探测，任何场景生效）', () => {
  it('packageJsonExists:false：非项目创建场景 npm install 仍被拒绝', () => {
    const ctx = makeCtx({ isProjectCreation: false, packageJsonExists: false })
    const v = gateBashCommand('npm install', ctx)
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('当前目录缺少 package.json')
    expect(v?.message).toContain('请先使用 write_file 创建 package.json')
  })

  it('packageJsonExists:false：npm i 简写同样被拒；npm init -y 豁免', () => {
    const ctx = makeCtx({ isProjectCreation: false, packageJsonExists: false })
    expect(gateBashCommand('npm i', ctx)?.kind).toBe('deny')
    expect(gateBashCommand('npm init -y', ctx)).toBeNull()
  })

  it('packageJsonExists:true：createdFiles 为空也放行 npm install', () => {
    const ctx = makeCtx({ isProjectCreation: false, packageJsonExists: true })
    expect(gateBashCommand('npm install', ctx)).toBeNull()
  })

  it('packageJsonExists:false 不影响 npm install -g 全局安装（但画像禁令本身硬拦）', () => {
    const ctx = makeCtx({ isProjectCreation: false, packageJsonExists: false })
    const v = gateBashCommand('npm install -g typescript', ctx)
    expect(v?.kind).toBe('deny')
    expect(v && v.kind === 'deny' ? v.message : '').toContain('禁止全局安装')
  })

  it('nodeModulesExists:false：非项目创建场景 npm run build 被拒绝（任意 script 全覆盖）', () => {
    const ctx = makeCtx({
      isProjectCreation: false,
      packageJsonExists: true,
      nodeModulesExists: false
    })
    const v = gateBashCommand('npm run build', ctx)
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('依赖尚未安装')
    expect(v?.message).toContain('node_modules')
  })

  it('nodeModulesExists:false：npm run dev 被拒绝，消息点名命令', () => {
    const ctx = makeCtx({ isProjectCreation: true, packageJsonExists: true, nodeModulesExists: false })
    const v = gateBashCommand('npm run dev', ctx)
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('npm run dev')
  })

  it('nodeModulesExists:true：未执行 install 也允许 npm run serve（已有依赖目录）', () => {
    const ctx = makeCtx({
      createdFiles: new Set(['/p/package.json']),
      ranNpmInstall: false,
      nodeModulesExists: true
    })
    expect(gateBashCommand('npm run serve', ctx)).toBeNull()
  })

  it('ranNpmInstall:true：即使 nodeModulesExists:false 也放行（安装成功标记优先）', () => {
    const ctx = makeCtx({
      packageJsonExists: true,
      nodeModulesExists: false,
      ranNpmInstall: true
    })
    expect(gateBashCommand('npm run build', ctx)).toBeNull()
  })
})

describe('gateBashCommand - 场景与边界', () => {
  it('非项目创建场景：普通 npm install 放行（不做依赖检查）', () => {
    const ctx = makeCtx({ isProjectCreation: false })
    expect(gateBashCommand('npm install', ctx)).toBeNull()
  })

  it('非项目创建场景：交互式命令仍归为 interactive', () => {
    const ctx = makeCtx({ isProjectCreation: false })
    expect(gateBashCommand('vue create app', ctx)?.kind).toBe('interactive')
  })

  it('非项目创建场景：破坏命令仍被拒绝', () => {
    const ctx = makeCtx({ isProjectCreation: false })
    expect(gateBashCommand('sudo apt update', ctx)?.kind).toBe('deny')
  })

  it('空命令放行', () => {
    expect(gateBashCommand('', makeCtx())).toBeNull()
  })

  it('普通命令放行', () => {
    expect(gateBashCommand('ls -la', makeCtx())).toBeNull()
    expect(gateBashCommand('git status', makeCtx())).toBeNull()
    expect(gateBashCommand('node -v', makeCtx())).toBeNull()
  })

  it('Windows 路径分隔符的 createdFiles 也能匹配', () => {
    const ctx = makeCtx({ createdFiles: new Set(['C:\\p\\go.mod']) })
    expect(gateBashCommand('go build', ctx)).toBeNull()
  })
})

describe('gateBashMessage - 兼容薄壳', () => {
  it('deny/interactive 折叠为消息文本', () => {
    expect(gateBashMessage('sudo x', makeCtx())).toContain('禁止')
    expect(gateBashMessage('vue create x', makeCtx())).toContain('PTY')
  })

  it('放行返回 null', () => {
    expect(gateBashMessage('ls', makeCtx())).toBeNull()
  })
})

describe('checkCommandOrder - 通用顺序锁（项目画像驱动）', () => {
  it('python 画像：pip install -r 缺 requirements.txt 被拦（前置校验失败文案）', () => {
    const msg = checkCommandOrder('pip install -r requirements.txt', getProfile('python'), new Set(), {
      ranInit: false,
      isProjectCreation: true
    })
    expect(msg).toContain('【前置校验失败】')
    expect(msg).toContain('当前目录缺少 Python 依赖声明文件 requirements.txt')
    expect(msg).toContain('请先使用 write_file 创建该文件')
  })

  it('python 画像：requirements.txt 已创建则放行安装', () => {
    const msg = checkCommandOrder(
      'pip install -r requirements.txt',
      getProfile('python'),
      new Set(['/p/requirements.txt']),
      { ranInit: false, isProjectCreation: true }
    )
    expect(msg).toBeNull()
  })

  it('go 画像：go build 缺 go.mod 被拦；磁盘探测 manifestOnDisk:false 任何场景硬拦', () => {
    const go = getProfile('go')
    const miss = checkCommandOrder('go build', go, new Set(), { ranInit: false, isProjectCreation: true })
    expect(miss).toContain('go.mod')
    // init 命令硬拦：manifestOnDisk 显式 false 时即使非项目创建也拦
    const hard = checkCommandOrder('go mod tidy', go, new Set(), {
      manifestOnDisk: false,
      ranInit: false,
      isProjectCreation: false
    })
    expect(hard).toContain('go.mod')
  })

  it('node 画像：npm install 任意形态在无 package.json 时拦截（含带包名形态）', () => {
    const msg = checkCommandOrder('npm install vue@2.7.16', NODE_GATE_PROFILE, new Set(), {
      manifestOnDisk: false,
      ranInit: false,
      isProjectCreation: false
    })
    expect(msg).toContain('当前目录缺少 package.json')
    expect(msg).toContain('npm install <包名>')
  })

  it('node 画像：npm install -g 全局安装不受 manifest 限制（initPattern 自带排除）', () => {
    const msg = checkCommandOrder('npm install -g typescript', NODE_GATE_PROFILE, new Set(), {
      manifestOnDisk: false,
      ranInit: false,
      isProjectCreation: false
    })
    expect(msg).toBeNull()
  })

  it('run 命令硬拦与软拦：depsOnDisk:false 拦全部 run；undefined 仅拦主运行命令', () => {
    // 硬拦：任意 npm run
    const hard = checkCommandOrder('npm run build', NODE_GATE_PROFILE, new Set(), {
      manifestOnDisk: true,
      depsOnDisk: false,
      ranInit: false,
      isProjectCreation: false
    })
    expect(hard).toContain('依赖尚未安装')
    // 软拦：未探测时 npm run build 不拦（仅 serve/dev/start）
    const soft = checkCommandOrder('npm run build', NODE_GATE_PROFILE, new Set(['/p/package.json']), {
      ranInit: false,
      isProjectCreation: true
    })
    expect(soft).toBeNull()
    const softServe = checkCommandOrder('npm run serve', NODE_GATE_PROFILE, new Set(['/p/package.json']), {
      ranInit: false,
      isProjectCreation: true
    })
    expect(softServe).toContain('依赖尚未安装')
  })

  it('gateBashCommand 集成：pip/go/cargo 命令缺 manifest 时被拦且点名对应文件', () => {
    expect(gateBashCommand('pip install -r requirements.txt', makeCtx())?.message).toContain('requirements.txt')
    expect(gateBashCommand('go build', makeCtx())?.message).toContain('go.mod')
    expect(gateBashCommand('cargo build', makeCtx())?.message).toContain('Cargo.toml')
    expect(gateBashCommand('docker compose up', makeCtx())?.message).toContain('docker-compose.yml')
  })
})

describe('checkCommandOrder - 内容级空壳校验（manifestHasContent）', () => {
  it('manifestOnDisk:true 但 manifestHasContent:false → 空壳硬拦，点名 npm init -y 与 dependencies', () => {
    const msg = checkCommandOrder('npm install', NODE_GATE_PROFILE, new Set(['/p/package.json']), {
      manifestOnDisk: true,
      manifestHasContent: false,
      ranInit: false,
      isProjectCreation: true
    })
    expect(msg).toContain('缺少 dependencies')
    expect(msg).toContain('npm init -y')
    expect(msg).toContain('write_file')
  })

  it('manifestHasContent:true → 内容级放行（不触发空壳文案）', () => {
    const msg = checkCommandOrder('npm install', NODE_GATE_PROFILE, new Set(['/p/package.json']), {
      manifestOnDisk: true,
      manifestHasContent: true,
      ranInit: false,
      isProjectCreation: true
    })
    expect(msg).toBeNull()
  })

  it('画像无 manifestEmptyHint 时回退 manifestHint（非 node 生态通用兜底）', () => {
    const pyProfile = { ...getProfile('python'), manifestEmptyHint: undefined }
    const msg = checkCommandOrder('pip install -r requirements.txt', pyProfile, new Set(), {
      manifestOnDisk: true,
      manifestHasContent: false,
      ranInit: false,
      isProjectCreation: true
    })
    expect(msg).toBe(pyProfile.manifestHint)
  })
})

describe('gateBashCommand - 磁盘内容探测接线（packageJsonHasContent）', () => {
  it('packageJsonExists:true + packageJsonHasContent:false → npm install 被拒（空壳不放行）', () => {
    const v = gateBashCommand('npm install', makeCtx({
      packageJsonExists: true,
      packageJsonHasContent: false
    }))
    expect(v?.kind).toBe('deny')
    expect(v?.message).toContain('缺少 dependencies')
  })

  it('packageJsonHasContent:true → npm install 放行', () => {
    expect(gateBashCommand('npm install', makeCtx({
      packageJsonExists: true,
      packageJsonHasContent: true
    }))).toBeNull()
  })

  it('packageJsonHasContent:undefined（未做内容探测）→ 回退存在性口径放行', () => {
    expect(gateBashCommand('npm install', makeCtx({
      packageJsonExists: true
    }))).toBeNull()
  })

  it('空壳 package.json 不豁免 npm run serve 的顺序锁（deps 未装仍拦）', () => {
    const v = gateBashCommand('npm run serve', makeCtx({
      packageJsonExists: true,
      packageJsonHasContent: false,
      ranNpmInstall: false
    }))
    expect(v?.kind).toBe('deny')
  })
})
