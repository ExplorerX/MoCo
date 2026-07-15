# Learning Morse Code

一个声音优先、离线优先的 Morse Code 学习与练习应用。项目目标是在 Web/PWA、Android、iOS 和桌面端复用同一套领域核心。

当前完成到架构阶段 B：Morse 领域核心、TrainingEngine、AudioEngine、InputEngine、IndexedDB/Dexie 仓储和会话恢复均已建立。下一阶段将进入正式 Web/PWA 页面与离线能力开发。

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
npx tsc --noEmit
npm test
```

`npm test` 会执行生产构建、Morse 核心固定样本测试和服务端首屏渲染检查。

## 工作区结构

```text
app/                         当前 Vinext/React 交互原型
packages/morse-core/         字符表、编解码、输入判定和时间轴
packages/shared-types/       练习、会话与作答数据协议
packages/training-engine/    固定 seed 出题、会话状态机和评分
packages/audio-engine/       Web Audio 调度、实时音调和生命周期
packages/input-engine/       统一按键信号和点划判定
packages/storage/            IndexedDB/Dexie schema、事务和恢复仓储
tests/                       领域核心与渲染测试
FeatureList.md               统一功能范围
ProductSpec.md               产品行为规格
InformationArchitecture.md  页面与导航信息架构
Architecture.md              技术架构与实施阶段
ValidationReport.md          自动验证与真机测试状态
```

## Git 工作流

远程仓库为 `origin`，默认分支为 `main`。功能开发使用短生命周期分支：

```bash
git switch -c feature/training-engine
git add <changed-files>
git commit -m "Implement training session state machine"
git push -u origin feature/training-engine
```

- `main` 只接收通过构建、类型、静态检查和相关测试的提交。
- 功能分支建议使用 `feature/`、修复使用 `fix/`、文档使用 `docs/` 前缀。
- 提交保持单一目的，不将无关格式化或临时产物混入功能提交。
- 合并前通过 Pull Request 检查功能范围、测试结果和文档同步情况。

## 项目文档

- [功能清单](./FeatureList.md)
- [产品规格](./ProductSpec.md)
- [信息架构](./InformationArchitecture.md)
- [技术架构](./Architecture.md)
- [验证报告](./ValidationReport.md)
