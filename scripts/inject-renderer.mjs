/**
 * 渲染层补丁注入与校验（幂等、多块）。
 *
 * 渲染层 Vue 源码已不可恢复（没有 sourcemap），dist/renderer/*.js 属于
 * 冻结产物。可维护的部分放在 src/renderer/patches/，由本脚本注入到 index.html：
 *   - drag-sort.js    → <body> 尾部，自选股拖拽排序
 *   - transparent.css → <head> 末尾，极简纯透明样式
 *   - transparent.js  → <body> 尾部，透明开关（跟随 backAlpha）
 *   - trade.js        → <body> 尾部，「更多」弹窗的买入/卖出录入（仅 #/cost）
 * 另有若干压缩产物的文案/样式替换规则（见下方 textPatches）。
 * doctor.*.js 的备份 UI 是压缩过的 Vue render function，只能冻结保留。
 *
 *   node scripts/inject-renderer.mjs            # 应用补丁
 *   node scripts/inject-renderer.mjs --check    # 只校验，不修改
 *
 * --check 会逐块比对「注入内容」与「补丁源文件」是否一致，防止手改 index.html
 * 造成源码与产物漂移。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const checkOnly = process.argv.includes('--check')
const rendererDir = path.join(root, 'dist/renderer')
const patchDir = path.join(root, 'src/renderer/patches')
const htmlPath = path.join(rendererDir, 'index.html')

let failed = 0
function report(name, state, detail = '') {
  console.log(`${state ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!state) failed++
}

let html = fs.readFileSync(htmlPath, 'utf8')

/**
 * 通用幂等注入：每块用 <!-- sm:<name>:start/end --> 包裹。
 * tag = style 时进 </head> 前，tag = script 时进 </body> 前。
 */
function injectBlock({ name, tag, sourceFile, label }) {
  const START = `<!-- sm:${name}:start -->`
  const END = `<!-- sm:${name}:end -->`
  const source = fs.readFileSync(path.join(patchDir, sourceFile), 'utf8').trim()
  const expected = `${START}\n<${tag}>\n${source}\n</${tag}>\n${END}`
  const marked = html.includes(START) && html.includes(END)
  const anchor = tag === 'style' ? '</head>' : '</body>'

  if (checkOnly) {
    const anchored = tag === 'style'
      ? html.indexOf(START) < html.indexOf('</head>')
      : html.indexOf(START) > html.indexOf('<body>')
    report(label, marked && html.includes(source) && anchored,
      marked ? (html.includes(source) ? '内容与源文件一致' : '内容与源文件不一致') : '缺少注入标记块')
    return
  }

  // 先清旧块（含内容），再清历史遗留的无标记裸脚本，最后按锚点插入
  html = html.replace(new RegExp(`${START}[\\s\\S]*?${END}\\s*`, 'g'), '')
  if (tag === 'script' && name === 'drag-sort') {
    html = html.replace(/<script>\s*\/\* 自选股拖拽排序[\s\S]*?<\/script>\s*/g, '')
  }
  if (!html.includes(anchor)) throw new Error(`index.html 中找不到 ${anchor}`)
  html = html.replace(anchor, expected + '\n' + anchor)
  report(label, true, `已由 ${sourceFile} 注入`)
}

const blocks = [
  { name: 'transparent-css', tag: 'style', sourceFile: 'transparent.css', label: 'index.html 极简纯透明样式' },
  { name: 'drag-sort', tag: 'script', sourceFile: 'drag-sort.js', label: 'index.html 拖拽排序脚本' },
  { name: 'transparent-js', tag: 'script', sourceFile: 'transparent.js', label: 'index.html 透明开关脚本' },
  { name: 'trade', tag: 'script', sourceFile: 'trade.js', label: 'index.html 更多弹窗买入/卖出输入' },
]
for (const block of blocks) injectBlock(block)

if (!checkOnly) fs.writeFileSync(htmlPath, html, 'utf8')

// 压缩产物里的文案替换规则（字符串是 JS 源码中的 \uXXXX 字面量）
const textPatches = [
  {
    file: 'index.237cad89.js',
    from: '\\u6545\\u969C\\u8BCA\\u65AD',
    to: '\\u5907\\u4EFD\\u914D\\u7F6E',
    label: '设置菜单文案 → 备份配置',
  },
  {
    file: 'index.e4b3f4eb.js',
    from: 'name:"\\u7F51\\u7EDC\\u8BCA\\u65AD"',
    to: 'name:"\\u5907\\u4EFD\\u914D\\u7F6E"',
    label: 'doctor 路由名称 → 备份配置',
  },
  // 设置页原文案把「置顶」误写成「置页」，压缩产物里是 \uXXXX 字面量，只能字符串替换
  {
    file: 'general.2002cfc8.js',
    from: '\\u7A97\\u53E3\\u7F6E\\u9875',
    to: '\\u7A97\\u53E3\\u7F6E\\u9876',
    label: '设置项文案 → 窗口置顶',
  },
  // classic 主题下总盈亏/当日盈亏/合计金额写死纯色，不跟随「文字透明度」滑条；
  // 涨跌幅列原本就用 p(color, textAlpha)，这里把同类逻辑补齐。
  {
    file: 'index.8cbe8649.js',
    from: 'e.color="#f56c6c"',
    to: 'e.color=p("#f56c6c",i.textAlpha)',
    label: '盈亏红色跟随文字透明度',
  },
  {
    file: 'index.8cbe8649.js',
    from: 'e.color="#67c23a"',
    to: 'e.color=p("#67c23a",i.textAlpha)',
    label: '盈亏绿色跟随文字透明度',
  },
  // 合计行是表格外的独立 div，容器样式没有 background，永远透出桌面；
  // 用 CSS 变量接收 transparent.js 从 #table 同步来的背景色，跟随「背景透明度」。
  {
    file: 'index.8cbe8649.js',
    from: 'qe={key:4,style:{"font-size":"10px",padding:"2px","text-align":"right","margin-right":"5px"}}',
    to: 'qe={key:4,style:{"font-size":"10px",padding:"2px","text-align":"right","margin-right":"5px",backgroundColor:"var(--sm-sum-bg, rgba(0,0,0,0))"}}',
    label: '合计行背景跟随背景透明度',
  },
]

for (const rule of textPatches) {
  const file = path.join(rendererDir, rule.file)
  if (!fs.existsSync(file)) {
    report(rule.label, false, '产物文件缺失: ' + rule.file)
    continue
  }
  let content = fs.readFileSync(file, 'utf8')
  const applied = content.includes(rule.to)
  const pending = content.includes(rule.from)
  if (!checkOnly && pending) {
    content = content.split(rule.from).join(rule.to)
    fs.writeFileSync(file, content, 'utf8')
  }
  const good = (!checkOnly && (applied || pending)) || (checkOnly && applied && !pending)
  report(rule.label, good, checkOnly ? (applied ? '补丁已应用' : '补丁缺失') : (pending ? '已替换' : '已是最新'))
}

// 冻结产物：doctor 组件与主进程补丁
const doctorPath = path.join(rendererDir, 'doctor.63ab51ad.js')
const doctor = fs.existsSync(doctorPath) ? fs.readFileSync(doctorPath, 'utf8') : ''
report('doctor 备份/恢复 UI（冻结产物）', doctor.includes('backupConfig') && doctor.includes('restoreConfig'), '仅校验，不重新生成')

const mainPath = path.join(root, 'dist/main/index.cjs')
const main = fs.existsSync(mainPath) ? fs.readFileSync(mainPath, 'utf8') : ''
const indexJsPath = path.join(rendererDir, 'index.8cbe8649.js')
const indexJs = fs.existsSync(indexJsPath) ? fs.readFileSync(indexJsPath, 'utf8') : ''
const mainChecks = [
  ['主进程产物包含 sortKeys', () => main.includes('sortKeys')],
  ['主进程产物包含 backupConfig', () => main.includes('backupConfig')],
  ['主进程产物包含 restoreConfig', () => main.includes('restoreConfig')],
  ['登录服务为离线 stub', () => main.includes('login-disabled')],
  ['会员校验本地恒真', () => /isVip\(\)\s*\{\s*return true/.test(main)],
  ['未回归云端 API 调用', () => !main.includes('/user/login_wechat2') && !main.includes('/statistic/logfile')],
  // 离线启动流程：这几项曾只存在于压缩产物中，漏掉会导致「运行没有主界面」
  ['离线启动：从 userData 重建配置', () => main.includes('reloadFromUserData') && main.includes('setDataPath')],
  ['离线启动：强制开启盈亏合计', () => /profiteTotal\s*=\s*true/.test(main)],
  ['离线启动：跳过登录窗直达主界面', () => main.includes('direct show indexWindow') && !main.includes('login.show(')],
  ['离线启动：显示后立即刷新行情', () => main.includes('indexWindow.didShowCallBack && indexWindow.didShowCallBack()')],
  ['设备 ID 读取容错（注册表不可用时）', () => main.includes('safeMachineId') && main.includes('randomUUID')],
  ['托盘图标使用 logo.png', () => main.includes('"logo.png"') && !main.includes('assetsPath')],
  ['启动阶段容错（任一初始化失败仍显示主窗）', () => main.includes('safeInit') && main.includes('whenReady failed')],
  // 背景透明度闸门：Electron 40 移除了 isAeroGlassEnabled，若返回 false 会把设置页
  // backAlpha 写入拦死（提示"不支持背景透明度调整"），纯透明补丁也就收不到信号。
  ['背景透明度闸门恒真（isAeroGlassEnabled）', () => /isAeroGlassEnabled"\)\s*\{\s*return true/.test(main)],
  // 窗口置顶开关：曾只写配置不应用到窗口，且创建时写死 true，关掉仍置顶
  ['窗口置顶开关有默认配置字段', () => /alwaysOnTop\s*=\s*true/.test(main)],
  ['窗口置顶开关即时应用到窗口', () => main.includes('applyAlwaysOnTop(config.alwaysOnTop') && /setAlwaysOnTop\(enabled,\s*["\x27]normal/.test(main)],
  ['窗口创建不再写死置顶', () => !/options\.alwaysOnTop\s*=\s*true\s*;/.test(main)],
  // 盈亏文字透明度 / 合计行背景
  ['盈亏文字不再写死纯色', () => !indexJs.includes('e.color="#f56c6c"') && !indexJs.includes('e.color="#67c23a"')],
  ['合计行背景跟随背景透明度', () => indexJs.includes('var(--sm-sum-bg') && html.includes('--sm-sum-bg')],
  // 买入/卖出录入后必须立即重算盈亏，否则总盈亏/当日盈亏/合计要等下一轮轮询才变
  ['成本变更立即刷新盈亏', () => /diffKeys\.indexOf\(["\x27]cost["\x27]\)\s*>=\s*0/.test(main)],
]
for (const [label, check] of mainChecks) report(label, check())

console.log(checkOnly ? '校验结束' : '补丁注入结束')
if (failed > 0) {
  console.error(`有 ${failed} 项未通过`)
  process.exitCode = 1
}
