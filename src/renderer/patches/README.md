# 渲染层补丁

## 为什么这里是「补丁」而不是源码

`dist/renderer/*.js` 是原项目用 Vite 打包后的 Vue 3 压缩产物，**没有 sourcemap**，
`.vue` 单文件组件已无法还原。因此渲染层按「冻结产物 + 外挂补丁」维护：

- 冻结产物：`dist/renderer/` 下所有 `*.js`、`*.css`、图片，`index.html` 的骨架。
- 可维护源码：本目录下的 `drag-sort.js`、`transparent.css`、`transparent.js`，以及 `scripts/inject-renderer.mjs` 里的文案替换规则。
- 由脚本保证幂等：重复运行不会产生重复内容，`--check` 会逐块比对注入内容与源文件是否一致，防止手改 `index.html` 造成漂移。

## 补丁清单

| # | 目标 | 内容 | 来源 |
|---|---|---|---|
| 1 | `dist/renderer/index.html` | 自选股首列拖拽排序脚本（IPC `api/sortKeys`） | `drag-sort.js` |
| 2 | `dist/renderer/index.237cad89.js` | 设置侧栏菜单「故障诊断」→「备份配置」 | 注入脚本替换规则 |
| 3 | `dist/renderer/index.e4b3f4eb.js` | `/setting/doctor` 路由名「网络诊断」→「备份配置」 | 注入脚本替换规则 |
| 4 | `dist/renderer/doctor.63ab51ad.js` | 备份/恢复配置 UI（压缩后的 Vue render function） | **冻结产物**，无法源码化，仅校验 |
| 5 | `dist/main/index.cjs` | `sortKeys` / `backupConfig` / `restoreConfig` | 已回归 `src/main/`，由 `build:main` 生成 |
| 6 | 主进程启动流程 | 跳过登录窗、从 `userData` 重建配置、默认自选股、强制 `profiteTotal`、显示后立即刷新行情 | `src/main/index.ts` + `local_store.ts` |
| 7 | 托盘图标 | `build/icons/24x24.png` → `logo.png`，`new Tray` 加 try/catch | `src/main/index.ts` |
| 8 | 设备 ID | `machineIdSync` 读注册表失败时降级为随机 UUID | `src/main/storage/local_store.ts` |
| 9 | 启动容错 | `safeInit()` 包裹全部非关键初始化，保证主窗口一定创建 | `src/main/index.ts` |
| 10 | 页面加载 | 无 Vite dev server 时回退到 `dist/renderer/index.html` | `src/extensions/electron_extensions.ts` |
| 11 | 极简纯透明样式 | 面板 / 表格行 / 表头 / 悬停 / 分组栏背景 → `transparent`，不动文字颜色 | `transparent.css` |
| 12 | 透明开关 | `backAlpha <= 10` 时给 `<html>` 加 `sm-transparent` 类，滑条拉回即移除 | `transparent.js` |
| 13 | `dist/renderer/general.2002cfc8.js` | 设置项错别字「窗口置页」→「窗口置顶」 | 注入脚本替换规则 |
| 14 | 主进程窗口置顶 | 按 `alwaysOnTop` 配置创建窗口，设置页切换时 `setAlwaysOnTop` 即时生效 | `IndexWindow.ts` + `local_store.ts` |
| 15 | `dist/renderer/index.8cbe8649.js` | classic 主题下盈亏红/绿写死纯色 → `p(color, textAlpha)`，文字透明度可调 | 注入脚本替换规则 |
| 16 | `dist/renderer/index.8cbe8649.js` | 合计行容器补 `backgroundColor: var(--sm-sum-bg)`，跟随背景透明度 | 注入脚本替换规则 + `transparent.js` 同步变量 |

补丁 2/3/4 对应的主进程实现在 `src/main/index.ts`，补丁 1 的服务端实现在
`src/main/service/index.ts` 的 `sortKeys()`。

补丁 6–10 是**启动流程补丁**：首次离线化时它们只存在于压缩产物里、没有
sourcemap 记录，导致只还原源码就重建会退回「在线版启动流程」——表现为
进程活着但看不到主界面。`check:patches` 对每一项都有防回退校验。

## 常用命令

```bash
npm run build:renderer   # 重新注入补丁（幂等）
npm run check:patches    # 校验全部补丁是否齐全
npm run build:main       # 从 src/ 重建主进程与 preload 产物
```

## 修改建议

- 改拖拽行为：编辑 `drag-sort.js` → 运行 `npm run build:renderer`。
- 改纯透明效果：编辑 `transparent.css`（样式）或 `transparent.js`（触发阈值 `THRESHOLD`）→ `npm run build:renderer`。两条规则都挂在 `html.sm-transparent` 下，默认 `backAlpha=255` 时完全不生效，界面 100% 保持原样。
- 改设置页文案：在 `scripts/inject-renderer.mjs` 的 `textPatches` 里加规则，字符串要用压缩产物里的 `\uXXXX` 字面量（如「窗口置顶」= `\u7A97\u53E3\u7F6E\u9876`），改完跑 `npm run build:renderer`。
- 改窗口置顶行为：只改 `src/main/pages/IndexWindow.ts`，然后 `npm run build:main`；`check:patches` 有三条防回退校验（默认字段 / 即时应用 / 不写死 true）。
- 改盈亏文字颜色：压缩产物里 classic 主题写死 `e.color="#f56c6c"/"#67c23a"`，替换规则改成 `p(color, i.textAlpha)` 才跟随滑条；涨跌幅列原本就是后者，别改回去。
- 合计行背景：它是表格外的独立 div，本身没有背景；`transparent.js` 把 `#table` 当前背景同步到 `--sm-sum-bg`（在去重之前，保证只改颜色也更新），容器样式引用该变量。
- 新增渲染层功能：优先写成注入脚本（DOM 层）或新增独立窗口（主进程侧），
  不要直接手写压缩后的 Vue render function。
- 若将来拿到原始 `.vue` 源码，应引入 Vite 重新构建整个 `dist/renderer/`，
  并把这里的补丁规则迁移回组件源码后删除。
