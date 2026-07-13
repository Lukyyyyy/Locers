# Locers

Locers 是一款面向 macOS 的本地开发服务管理工具，用于集中查看和控制由 Homebrew 管理的服务。通过一个桌面应用，即可掌握服务状态、资源占用、监听端口、运行日志和操作历史。

> Locers 目前仍处于早期开发阶段，适合本地开发和个人使用，暂未配置正式发布所需的代码签名与公证。

## 功能特性

- 自动发现由 `brew services` 管理的服务
- 浏览、搜索并安装 Homebrew 官方目录中所有可用的后台服务 Formula
- 启动、停止、重启和移除本地服务
- 查看 CPU、内存、运行时长、进程和监听端口信息
- 读取服务日志，但不将日志内容复制到应用数据库
- 查看服务操作历史与命令输出
- 监控系统资源变化趋势
- 支持简体中文和英文界面
- 使用 SQLite 保存本地元数据及监控采样，并执行有界的数据保留策略

## 环境要求

- macOS
- [Homebrew](https://brew.sh/)
- Node.js 18 或更高版本
- [pnpm](https://pnpm.io/) 9 或更高版本
- 稳定版 Rust 工具链
- Tauri 2 在 macOS 上所需的系统依赖（Xcode Command Line Tools）

## 快速开始

克隆仓库并安装前端依赖：

```bash
git clone <repository-url>
cd Locers
pnpm install
```

以开发模式启动桌面应用：

```bash
pnpm tauri dev
```

如果只需启动浏览器演示界面：

```bash
pnpm dev
```

浏览器演示界面使用示例数据。Homebrew 服务发现及服务控制功能仅在 Tauri 桌面运行环境中可用。

## 构建应用

构建 macOS 应用：

```bash
pnpm tauri build
```

构建产物位于 `src-tauri/target/release/bundle/` 目录。

## 质量检查

提交修改前，建议运行以下检查：

```bash
pnpm test
pnpm lint
pnpm format
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
```

## 项目结构

```text
.
├── src/                 React 与 TypeScript 前端
│   ├── api/             Tauri 命令客户端和数据类型
│   ├── state/           界面状态管理
│   ├── test/            前端测试配置
│   └── ui/              应用页面和界面组件
├── src-tauri/           Rust 与 Tauri 桌面后端
│   └── src/             命令、存储、Homebrew 集成和系统探测
├── docs/                设计及运行规范文档
└── package.json         前端脚本与依赖配置
```

## 数据与隐私

Locers 将 SQLite 数据库以 `locers.sqlite3` 为文件名，保存在 Tauri 应用数据目录中。服务日志仍保留在原始文件内，不会被复制到应用数据库。监控数据和操作记录均采用有界的数据保留策略。

完整的数据存储及清理规则请参阅 [docs/storage-policy.md](docs/storage-policy.md)。

## 当前限制

- 目前仅支持 macOS 和由 Homebrew 管理的服务。
- 应用尚未进行代码签名和公证。
- 尚未配置发行镜像和自动更新功能。
- 部分进程和端口信息依赖 `lsof`、`launchctl` 等 macOS 命令行工具。

## 参与贡献

请尽量让每次修改保持聚焦，并为行为变更补充测试。提交 Pull Request 前，请运行[质量检查](#质量检查)中列出的全部命令。

## 开源许可

本项目基于 [MIT License](LICENSE) 开源。
