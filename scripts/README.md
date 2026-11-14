# 构建与检查脚本

## 当前构建入口

| 脚本 | 用途 |
|---|---|
| [build-portable.ps1](build-portable.ps1) | 生成ZIP便携版 |
| [build-installer.ps1](build-installer.ps1) | 生成Windows安装版 |
| [build-desktop.ps1](build-desktop.ps1) | 共用的固定环境、后端与Electron打包链 |
| [build-official-modules.cjs](build-official-modules.cjs) | 生成并核对官方代码包 |
| [build-user-help.cjs](build-user-help.cjs) | 生成软件内手册检索目录 |

准备条件、输出位置和具体参数见[源码运行与构建](../docs/源码运行与构建.md)。

## 成品与数据检查

[verify-package-content.cjs](verify-package-content.cjs)核官方包内容，[check-packaged-dependencies.cjs](check-packaged-dependencies.cjs)核实际打包依赖。[verify-public-source.ps1](verify-public-source.ps1)与[verify-release-data.ps1](verify-release-data.ps1)核源码及干净数据模板边界。

[check-portable-app.cjs](check-portable-app.cjs)、[check-installer.ps1](check-installer.ps1)、[check-uninstall-options.ps1](check-uninstall-options.ps1)涉及真实程序或安装卸载。[check-model-delivery.py](check-model-delivery.py)涉及实际GPU模型。执行前按构建说明确认隔离目录、现有进程、安装登记及资源要求。

`build-windows.ps1`和独立推荐环境脚本保留早期实现，其依赖版本、输出结构及安装方式与当前统一入口有差异。日常构建使用上表入口。
