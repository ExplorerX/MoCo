# Learning Morse Code

[![CI](https://github.com/ExplorerX/MoCo/actions/workflows/ci.yml/badge.svg)](https://github.com/ExplorerX/MoCo/actions/workflows/ci.yml)

一个声音优先、离线优先的 Morse Code 学习与练习应用。项目目标是在 Web/PWA、Android、iOS 和桌面端复用同一套领域核心。

当前为 V2 Foundation 0.4.3：导航和页面已重构为“基础、听抄、发报、工具”四个功能域，统一训练路由、V2 本地数据、自由拍发、Morse 双向转换、字符速查、进度与设置均已接通。本轮完成移动端文字与布局稳定化，覆盖极窄屏、主流手机和横屏：长中文标签、按键名与 Morse 字符串可在框内安全换行，训练顶栏、参数行、PWA 状态、卡片按钮及按压时长组件不再挤出容器。V2 不读取旧会话、结果、课程进度或设置，旧 URL 不提供重定向。进入 Capacitor/Tauri 封装前仍需完成跨浏览器与真机矩阵。

## 环境要求

- Node.js `>=22.13.0`
- npm（随 Node.js 安装）

## 本地运行

首次拉取项目后执行：

```bash
npm install
npm run dev
```

开发服务器会打印实际访问地址，通常为 <http://localhost:3000>。如果端口已被占用，Vite 会自动选择 3001 等其他端口，请以终端输出为准。

停止本地服务时，在运行服务的终端按 `Ctrl+C`。

## 质量检查

```bash
npm run lint
npm run typecheck
npm test
```

`npm test` 会执行生产构建、32 项领域/存储/V2 路由/PWA/移动布局测试和服务端直达渲染检查。

GitHub Actions 会在提交到 `main`、发往 `main` 的 Pull Request 和手动触发时执行同一套质量门禁：锁定依赖安装、类型检查、Lint、生产构建和自动化测试。工作流只读取仓库内容，不持有部署或写入权限。

## 工作区结构

```text
app/                         Vinext/React Web/PWA 页面壳与稳定路由
packages/morse-core/         字符表、编解码、输入判定和时间轴
packages/shared-types/       练习、会话与作答数据协议
packages/training-engine/    固定 seed 出题、会话状态机和评分
packages/audio-engine/       Web Audio 调度、实时音调和生命周期
packages/input-engine/       统一按键信号和点划判定
packages/storage/            IndexedDB/Dexie schema、事务和恢复仓储
public/                      PWA Manifest、Service Worker 与应用图标
tests/                       领域核心、存储、路由、PWA 与渲染测试
FeatureList.md               统一功能范围
ProductSpec.md               产品行为规格
InformationArchitecture.md  页面与导航信息架构
Architecture.md              技术架构与实施阶段
ValidationReport.md          自动验证与真机测试状态
```

## Git 工作流

远程仓库为 `origin`，默认分支为 `main`，也是唯一长期分支。功能开发使用短生命周期分支：

```bash
git switch -c feature/training-engine
git add <changed-files>
git commit -m "Implement training session state machine"
git push -u origin feature/training-engine
```

- `main` 只接收通过构建、类型、静态检查和相关测试的提交。
- 功能分支建议使用 `feature/`、修复使用 `fix/`、文档使用 `docs/` 前缀。
- 分支保持短生命周期；Pull Request 合并并确认 `main` 正常后，删除对应本地和远程分支。
- 不为 Stage 长期保留分支；阶段里程碑使用版本标签或 GitHub Release 表达。
- 提交保持单一目的，不将无关格式化或临时产物混入功能提交。
- 合并前通过 Pull Request 检查功能范围、测试结果和文档同步情况。

建议在 GitHub 的 `main` 分支保护中要求 `Validate web and domain packages` 通过后才能合并。当前线上版本继续由 Sites 托管流程发布；本项目不是纯静态站点，暂不使用 GitHub Pages，也不把部署密钥放进 CI。

## 项目文档

- [功能清单](./FeatureList.md)
- [产品规格](./ProductSpec.md)
- [信息架构](./InformationArchitecture.md)
- [技术架构](./Architecture.md)
- [验证报告](./ValidationReport.md)
