<p align="center"><img width="96" src="electron-lxplayer/renderer/assets/app-icon.png" alt="Flowave"></p>

# Flowave

Flowave 是一款 Windows 本地音乐播放器。支持曲库和歌单、逐字歌词、桌面歌词、均衡器和交叉淡化。安装歌曲推荐后，可以顺着当前风格听下去，也可以用「找回感觉」调整方向，或用「换个感觉」切到另一组歌曲。

## 下载

支持 Windows 10 和 Windows 11（x64）。

| 版本 | 使用方法 |
| --- | --- |
| [Windows 安装版](https://github.com/nadeshikochan/Flowave/releases/tag/v0.2.3) | 运行 Setup.exe，分别选择程序目录和数据目录。 |
| [ZIP 便携版](https://github.com/nadeshikochan/Flowave/releases/tag/v0.2.3) | 完整解压后运行 Flowave.exe。工作区默认在程序旁的 `data` 目录。 |

首次打开后，在「设置 → 音乐库与在线 → 本地音乐」添加文件夹。左下角「使用手册」提供图文步骤，按 F1 可以查看当前页面的帮助。

## 插件

在「设置 → 插件与模型」选择需要的功能。安装时会一并准备所需的模型和运行环境，安装完成后重启软件。[插件包下载](https://github.com/nadeshikochan/Flowave/releases/tag/plugins-v1.2.0)

| 插件 | 功能 |
| --- | --- |
| 歌曲推荐 | 连续推荐、复合种子、声音地图和听歌轨迹 |
| 歌曲分析 | 查看歌曲标签和段落，按多个标签筛选曲库 |
| 演奏练习 | 分轨、循环练习、变速和谱面辅助 |
| 听歌记录 | 查看播放次数、收听时长和歌曲排行 |

安装歌曲推荐后，在「设置 → 歌曲推荐 → 准备与索引」更新全库索引。基础播放无需安装插件，涉及模型的功能需要兼容的 NVIDIA 显卡及驱动。

## 界面

### 曲库

<p><img width="100%" src="docs/images/library.png" alt="Flowave 曲库与播放栏"></p>

### 歌词

<p><img width="100%" src="docs/images/lyrics.png" alt="Flowave 歌词页"></p>

### 声音地图

<p><img width="100%" src="docs/images/map.png" alt="Flowave 声音地图"></p>

[播放演示](docs/images/playback.mp4) · [复合种子](docs/images/seeds.png) · [设置](docs/images/sound.png)

## 文档与反馈

- [在线使用手册](https://flowave-manual.kumiko233.chatgpt.site) · [使用指南](docs/使用指南.md) · [隐私与数据](docs/隐私与数据.md) · [从源码运行](docs/源码运行与构建.md)
- [提交问题](https://github.com/nadeshikochan/Flowave/issues/new)时请附上软件版本和复现步骤。诊断导出位于「设置 → 数据与帮助 → 诊断日志」。
- 安全问题请通过[安全政策](SECURITY.md)中的方式报告。

Flowave 无需账户，曲库和播放记录保存在本机。在线播放需自行导入可信音源脚本。

## 许可

Flowave 允许个人非商业使用。源码供查阅，修改或再分发须取得授权。第三方组件及模型遵循各自的许可。[主程序许可](LICENSE) · [第三方许可](release-template/THIRD_PARTY_NOTICES.txt)
