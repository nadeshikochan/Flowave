# 构建脚本

| 命令 | 用途 |
| --- | --- |
| [build-installer.ps1](build-installer.ps1) | 构建 Windows 安装包 |
| [build-portable.ps1](build-portable.ps1) | 构建 ZIP 便携版 |
| [build-official-modules.cjs](build-official-modules.cjs) | 生成官方插件包 |
| [build-user-help.cjs](build-user-help.cjs) | 更新软件内手册的检索目录 |
| [build-web-manual.cjs](build-web-manual.cjs) | 从同一份正文生成静态网页版 |

环境要求、运行方式及输出位置见[源码运行与构建](../docs/源码运行与构建.md)。

手册正文在 `electron-lxplayer/renderer/help/`。编辑后先运行 `node scripts/build-user-help.cjs` 更新搜索目录，再运行 `node scripts/build-web-manual.cjs`。网页版输出到 `build/web-manual/`。
