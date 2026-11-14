// Navigation metadata only: no model, playback, persistence or task work on import.
(function(root){'use strict';
const categories=[
  {
    "id": "sound",
    "title": "播放与声音",
    "hint": "音效 · 淡化 · 耳机保护",
    "pages": [
      "general"
    ],
    "icon": "M4 9h4l5-4v14l-5-4H4ZM17 8q4 4 0 8M19 5q7 7 0 14"
  },
  {
    "id": "library",
    "title": "音乐库与在线",
    "hint": "音乐目录 · 音源 · 下载",
    "pages": [
      "library-settings",
      "source",
      "downloads"
    ],
    "icon": "M3 7V5h6l2 2h10v12H3ZM8 12h8"
  },
  {
    "id": "recommend",
    "title": "歌曲推荐",
    "hint": "准备与索引 · 接歌规则",
    "pages": [
      "advanced",
      "recommendation"
    ],
    "icon": "M4 7h3q4 0 5 5t5 5h3m-4-4 4 4-4 4M4 17h3q2 0 3-3m4-4q1-3 3-3h3m-4-4 4 4-4 4"
  },
  {
    "id": "lyrics",
    "title": "歌词",
    "hint": "软件内显示 · 桌面歌词",
    "pages": [
      "lyric",
      "desktop-lyric"
    ],
    "icon": "M4 4h16v12H4ZM8 20h8m-4-4v4M8 8h8m-8 4h5"
  },
  {
    "id": "appearance",
    "title": "外观",
    "hint": "主题 · 启动背景",
    "pages": [
      "theme"
    ],
    "icon": "M4 4h16v12H4ZM8 20h8m-4-4v4M8 8h8m-8 4h5"
  },
  {
    "id": "keys",
    "title": "快捷键",
    "hint": "播放控制 · 全局热键",
    "pages": [
      "shortcuts"
    ],
    "icon": "M3 6h18v12H3ZM6 10h1m3 0h1m3 0h1m3 0h1M7 14h10"
  },
  {
    "id": "extensions",
    "title": "插件与模型",
    "hint": "安装 · 启用 · 移除",
    "pages": [
      "features"
    ],
    "icon": "M4 4h6v6H4Zm10 0h6v6h-6ZM4 14h6v6H4Zm10 0h6v6h-6Z"
  },
  {
    "id": "maintenance",
    "title": "数据与帮助",
    "hint": "工作区 · 存储 · 诊断",
    "pages": [
      "storage",
      "logs",
      "manual"
    ],
    "icon": "m14 5 5 5M4 20l4-1L20 7l-3-3L5 16ZM4 20h4"
  }
];
const titles={"features":"插件与模型", "storage":"工作区与存储","general": "播放与声音", "recommendation": "接歌规则", "theme": "软件外观", "lyric": "软件内歌词", "desktop-lyric": "桌面歌词", "library-settings": "本地音乐", "source": "在线音源与音质", "downloads": "下载与入库", "shortcuts": "快捷键", "advanced": "准备与索引", "logs": "诊断日志", "manual": "帮助与恢复", "history": "听歌记录", "song-info": "歌曲资料与歌词补全", "folders": "文件夹", "insights": "曲库概览"};
const items=[
  {id:'setting-release-info',anchor:'setting-release-info',page:'manual',title:'软件版本与构建号',path:'数据与帮助 / 帮助与恢复',keywords:'关于 版本号 构建 发布 安装包'},
  {id:'setting-recovery',anchor:'setting-recovery',page:'manual',title:'备份与数据恢复',path:'数据与帮助 / 帮助与恢复',keywords:'记录丢失 损坏 恢复 备份 重装 升级'},
  {id:'setting-diagnostic-export',anchor:'setting-diagnostic-export',page:'logs',title:'导出诊断信息',path:'数据与帮助 / 诊断日志',keywords:'报错 故障 反馈 导出日志 脱敏'},
  {id:'page-storage',anchor:'',page:'storage',title:'工作区与存储',path:'数据与帮助 / 工作区与存储',keywords:'数据目录 数据位置 文件夹 备份 迁移 保留 清理 工作区 新建 打开 切换 仓库'},
  {id:'setting-storage-locations',anchor:'setting-storage-locations',page:'storage',title:'数据与存储位置',path:'数据与帮助 / 工作区与存储',keywords:'模型 索引 缓存 听歌记录 分轨 保存在哪里 打开目录'},
  {id:'setting-recommendation-setup',anchor:'setting-recommendation-setup',page:'advanced',title:'开启歌曲推荐',path:'歌曲推荐 / 准备与索引',keywords:'启用推荐 安装推荐 模型下载 更新推荐索引 没有推荐 如何推荐'},
  {id:'setting-bluetooth-protection',anchor:'setting-bluetooth-protection',page:'general',title:'蓝牙耳机保护',path:'播放与声音',keywords:'摘下 暂停 断连 戴回 自动恢复 防外放 输出'},
  {id:"page-features",anchor:"",page:"features",title:"插件与模型",path:"插件与模型",keywords:"功能选装 组件 安装 下载 模型 插件 模块 启用 停用 关闭 推荐 分析 演奏 记录 轻量"},
  {id:"setting-lyric-background",anchor:"setting-lyric-background",page:"lyric",title:"背景与配色",path:"歌词 / 软件内歌词",keywords:"封面 背景颜色 流光"},
  {id:'setting-theme-startup-background',anchor:'setting-theme-startup-background',page:'theme',title:'启动背景图片',path:'外观 / 软件外观',keywords:'启动画面 开屏 图片 壁纸 自定义 恢复默认'},
  {
    "id": "setting-library-settings-17de1ed2d9",
    "anchor": "setting-library-settings-17de1ed2d9",
    "page": "library-settings",
    "title": "音乐文件夹",
    "path": "音乐库与在线 / 本地音乐",
    "keywords": "找不到歌曲 刷新音乐库 添加音乐"
  },
  {
    "id": "setting-library-settings-audiodirectorydraft",
    "anchor": "setting-library-settings-audiodirectorydraft",
    "page": "library-settings",
    "title": "音乐文件夹列表",
    "path": "音乐库与在线 / 本地音乐 / 音乐文件夹",
    "keywords": "音乐目录 添加音乐 文件夹位置 路径 多个文件夹 添加文件夹 移除文件夹"
  },
  {
    "id": "setting-general-98454ca754",
    "anchor": "setting-general-98454ca754",
    "page": "general",
    "title": "交叉淡化",
    "path": "播放与声音",
    "keywords": ""
  },
  {
    "id": "setting-general-audioeffects-seconds",
    "anchor": "setting-general-audioeffects-seconds",
    "page": "general",
    "title": "重叠时长",
    "path": "播放与声音 / 交叉淡化",
    "keywords": ""
  },
  {
    "id": "setting-general-d2440fa637",
    "anchor": "setting-general-d2440fa637",
    "page": "general",
    "title": "均衡器",
    "path": "播放与声音",
    "keywords": "低音 高音 人声 音效"
  },
  {
    "id": "setting-general-fa64d60993",
    "anchor": "setting-general-fa64d60993",
    "page": "general",
    "title": "蓝牙耳机校准",
    "path": "播放与声音",
    "keywords": "耳机延迟 蓝牙延迟 校准 同步"
  },
  {
    "id": "setting-general-bca467da0d",
    "anchor": "setting-general-bca467da0d",
    "page": "general",
    "title": "演奏入口",
    "path": "播放与声音",
    "keywords": " 演奏"
  },
  {
    "id": "setting-song-info-22b15a534b",
    "anchor": "setting-song-info-22b15a534b",
    "page": "song-info",
    "title": "补充内容",
    "path": "曲库工具 / 歌曲资料与歌词补全",
    "keywords": ""
  },
  {
    "id": "setting-song-info-songinfobatchsettings-scope",
    "anchor": "setting-song-info-songinfobatchsettings-scope",
    "page": "song-info",
    "title": "范围",
    "path": "曲库工具 / 歌曲资料与歌词补全 / 补充内容",
    "keywords": ""
  },
  {
    "id": "setting-song-info-c7127bb6ee",
    "anchor": "setting-song-info-c7127bb6ee",
    "page": "song-info",
    "title": "匹配选项",
    "path": "曲库工具 / 歌曲资料与歌词补全",
    "keywords": " 匹配"
  },
  {
    "id": "setting-song-info-songinfobatchsettings-autothreshold",
    "anchor": "setting-song-info-songinfobatchsettings-autothreshold",
    "page": "song-info",
    "title": "自动匹配",
    "path": "曲库工具 / 歌曲资料与歌词补全 / 匹配",
    "keywords": ""
  },
  {
    "id": "setting-song-info-songinfobatchsettings-manualthreshold",
    "anchor": "setting-song-info-songinfobatchsettings-manualthreshold",
    "page": "song-info",
    "title": "人工确认",
    "path": "曲库工具 / 歌曲资料与歌词补全 / 匹配",
    "keywords": ""
  },
  {
    "id": "setting-song-info-songinfobatchsettings-concurrency",
    "anchor": "setting-song-info-songinfobatchsettings-concurrency",
    "page": "song-info",
    "title": "并行查找",
    "path": "曲库工具 / 歌曲资料与歌词补全 / 匹配",
    "keywords": ""
  },
  {
    "id": "setting-song-info-315d810f5e",
    "anchor": "setting-song-info-315d810f5e",
    "page": "song-info",
    "title": "歌词选项",
    "path": "曲库工具 / 歌曲资料与歌词补全",
    "keywords": " 歌词"
  },
  {
    "id": "setting-song-info-songinfobatchsettings-lyricsavetarget",
    "anchor": "setting-song-info-songinfobatchsettings-lyricsavetarget",
    "page": "song-info",
    "title": "保存位置",
    "path": "曲库工具 / 歌曲资料与歌词补全 / 歌词",
    "keywords": ""
  },
  {
    "id": "setting-song-info-songinfobatchsettings-lyricformat",
    "anchor": "setting-song-info-songinfobatchsettings-lyricformat",
    "page": "song-info",
    "title": "歌词格式",
    "path": "曲库工具 / 歌曲资料与歌词补全 / 歌词",
    "keywords": ""
  },
  {
    "id": "setting-song-info-songinfobatchsettings-skipexistinglyrics",
    "anchor": "setting-song-info-songinfobatchsettings-skipexistinglyrics",
    "page": "song-info",
    "title": "跳过已有歌词",
    "path": "曲库工具 / 歌曲资料与歌词补全 / 歌词",
    "keywords": ""
  },
  {
    "id": "setting-song-info-4d69dbdf62",
    "anchor": "setting-song-info-4d69dbdf62",
    "page": "song-info",
    "title": "原文",
    "path": "曲库工具 / 歌曲资料与歌词补全 / 歌词",
    "keywords": ""
  },
  {
    "id": "setting-song-info-lyricsaveincludetranslation",
    "anchor": "setting-song-info-lyricsaveincludetranslation",
    "page": "song-info",
    "title": "翻译",
    "path": "曲库工具 / 歌曲资料与歌词补全 / 歌词",
    "keywords": ""
  },
  {
    "id": "setting-song-info-lyricsaveincluderomanization",
    "anchor": "setting-song-info-lyricsaveincluderomanization",
    "page": "song-info",
    "title": "罗马音",
    "path": "曲库工具 / 歌曲资料与歌词补全 / 歌词",
    "keywords": ""
  },
  {
    "id": "setting-song-info-f9e4f28179",
    "anchor": "setting-song-info-f9e4f28179",
    "page": "song-info",
    "title": "查找歌曲信息",
    "path": "曲库工具 / 歌曲资料与歌词补全",
    "keywords": " 开始查找"
  },
  {
    "id": "setting-song-info-abc5c37d80",
    "anchor": "setting-song-info-abc5c37d80",
    "page": "song-info",
    "title": "最近任务",
    "path": "曲库工具 / 歌曲资料与歌词补全",
    "keywords": ""
  },
  {
    "id": "setting-song-info-c6386d7265",
    "anchor": "setting-song-info-c6386d7265",
    "page": "song-info",
    "title": "查找缓存",
    "path": "曲库工具 / 歌曲资料与歌词补全",
    "keywords": ""
  },
  {
    "id": "setting-advanced-405be21f38",
    "anchor": "setting-advanced-405be21f38",
    "page": "advanced",
    "title": "模型与自定义位置",
    "path": "歌曲推荐 / 准备与索引",
    "keywords": "安装组件 下载模型"
  },
  {
    "id": "setting-advanced-params-model-local-dir",
    "anchor": "setting-advanced-params-model-local-dir",
    "page": "advanced",
    "title": "模型目录",
    "path": "歌曲推荐 / 准备与索引 / 推荐模型",
    "keywords": ""
  },
  {
    "id": "setting-advanced-params-model-source",
    "anchor": "setting-advanced-params-model-source",
    "page": "advanced",
    "title": "模型来源",
    "path": "歌曲推荐 / 准备与索引",
    "keywords": ""
  },
  {
    "id": "setting-downloads-c60e1b1007",
    "anchor": "setting-downloads-c60e1b1007",
    "page": "downloads",
    "title": "在线歌曲",
    "path": "音乐库与在线 / 下载与入库",
    "keywords": ""
  },
  {
    "id": "setting-downloads-params-download-dir",
    "anchor": "setting-downloads-params-download-dir",
    "page": "downloads",
    "title": "下载目录",
    "path": "音乐库与在线 / 下载与入库 / 在线歌曲",
    "keywords": "下载到哪里 保存位置"
  },
  {
    "id": "setting-downloads-params-online-auto-index-enabled",
    "anchor": "setting-downloads-params-online-auto-index-enabled",
    "page": "downloads",
    "title": "自动加入推荐索引",
    "path": "音乐库与在线 / 下载与入库 / 在线歌曲",
    "keywords": ""
  },
  {
    "id": "setting-downloads-params-online-auto-index-after-seconds",
    "anchor": "setting-downloads-params-online-auto-index-after-seconds",
    "page": "downloads",
    "title": "播放时长",
    "path": "音乐库与在线 / 下载与入库 / 在线歌曲",
    "keywords": ""
  },
  {
    "id": "setting-downloads-currenttrackexcluded",
    "anchor": "setting-downloads-currenttrackexcluded",
    "page": "downloads",
    "title": "排除当前在线歌曲",
    "path": "音乐库与在线 / 下载与入库 / 在线歌曲",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-8c707b6c21",
    "anchor": "setting-recommendation-8c707b6c21",
    "page": "recommendation",
    "title": "连续推荐",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-recommendfullmode",
    "anchor": "setting-recommendation-recommendfullmode",
    "page": "recommendation",
    "title": "包含已入库的在线歌曲",
    "path": "歌曲推荐 / 接歌规则 / 连续推荐",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-recommendation-recent-exclusion",
    "anchor": "setting-recommendation-params-recommendation-recent-exclusion",
    "page": "recommendation",
    "title": "避免立即重播最近几首",
    "path": "歌曲推荐 / 接歌规则 / 连续推荐",
    "keywords": " 始终不重复最近几首"
  },
  {
    "id": "setting-recommendation-params-recommendation-allow-older-repeats",
    "anchor": "setting-recommendation-params-recommendation-allow-older-repeats",
    "page": "recommendation",
    "title": "允许偶尔重听合适的歌曲",
    "path": "歌曲推荐 / 接歌规则 / 连续推荐",
    "keywords": " 同感觉候选不足时重听较早歌曲"
  },
  {
    "id": "setting-recommendation-236a36b269",
    "anchor": "setting-recommendation-236a36b269",
    "page": "recommendation",
    "title": "高级推荐参数",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-history-no-repeat-within",
    "anchor": "setting-recommendation-params-history-no-repeat-within",
    "page": "recommendation",
    "title": "防止连续重复",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-recommendation-semantic-floor",
    "anchor": "setting-recommendation-params-recommendation-semantic-floor",
    "page": "recommendation",
    "title": "整体听感优先下限",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": "整体听感关联下限"
  },
    {
      "id": "setting-recommendation-adjacent-mert-floor",
      "anchor": "setting-recommendation-adjacent-mert-floor",
      "page": "recommendation",
      "title": "自然续播相邻 MERT 起始下限",
      "path": "歌曲推荐 / 接歌规则",
      "keywords": "相邻 硬约束 相似度 MERT 自然续播相邻 MERT 下限"
    },
  {
    "id": "setting-recommendation-params-recommendation-context-floor",
    "anchor": "setting-recommendation-params-recommendation-context-floor",
    "page": "recommendation",
    "title": "本段感觉优先下限",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-recommendation-candidate-limit",
    "anchor": "setting-recommendation-params-recommendation-candidate-limit",
    "page": "recommendation",
    "title": "候选数量上限",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-similarity-like-min",
    "anchor": "setting-recommendation-params-similarity-like-min",
    "page": "recommendation",
    "title": "单模型／组合关联下限",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-dislike-min-sim",
    "anchor": "setting-recommendation-params-dislike-min-sim",
    "page": "recommendation",
    "title": "单模型换感觉下限",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-dislike-max-sim",
    "anchor": "setting-recommendation-params-dislike-max-sim",
    "page": "recommendation",
    "title": "单模型换感觉上限",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-790000a827",
    "anchor": "setting-recommendation-790000a827",
    "page": "recommendation",
    "title": "换歌推荐纠偏",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-dislike-correction-enabled",
    "anchor": "setting-recommendation-params-dislike-correction-enabled",
    "page": "recommendation",
    "title": "启用纠偏",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-dislike-correction-auto-rebuild-recommend-rate",
    "anchor": "setting-recommendation-params-dislike-correction-auto-rebuild-recommend-rate",
    "page": "recommendation",
    "title": "自动重建推荐率",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-dislike-correction-enable-recommend-rate-fix",
    "anchor": "setting-recommendation-params-dislike-correction-enable-recommend-rate-fix",
    "page": "recommendation",
    "title": "启用修正",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-dislike-correction-rec-strength",
    "anchor": "setting-recommendation-params-dislike-correction-rec-strength",
    "page": "recommendation",
    "title": "强度",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-dislike-correction-rec-fix-min",
    "anchor": "setting-recommendation-params-dislike-correction-rec-fix-min",
    "page": "recommendation",
    "title": "最小修正",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-dislike-correction-rec-fix-max",
    "anchor": "setting-recommendation-params-dislike-correction-rec-fix-max",
    "page": "recommendation",
    "title": "最大修正",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-dislike-correction-enable-skip-rate-fix",
    "anchor": "setting-recommendation-params-dislike-correction-enable-skip-rate-fix",
    "page": "recommendation",
    "title": "启用修正",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-dislike-correction-skip-strength",
    "anchor": "setting-recommendation-params-dislike-correction-skip-strength",
    "page": "recommendation",
    "title": "强度",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-dislike-correction-skip-fix-min",
    "anchor": "setting-recommendation-params-dislike-correction-skip-fix-min",
    "page": "recommendation",
    "title": "最小修正",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-dislike-correction-skip-fix-max",
    "anchor": "setting-recommendation-params-dislike-correction-skip-fix-max",
    "page": "recommendation",
    "title": "最大修正",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-dislike-correction-skip-smooth-k",
    "anchor": "setting-recommendation-params-dislike-correction-skip-smooth-k",
    "page": "recommendation",
    "title": "平滑",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-dislike-correction-daily-decay",
    "anchor": "setting-recommendation-params-dislike-correction-daily-decay",
    "page": "recommendation",
    "title": "每日衰减",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-dislike-correction-consecutive-dislike-threshold",
    "anchor": "setting-recommendation-params-dislike-correction-consecutive-dislike-threshold",
    "page": "recommendation",
    "title": "记录前忽略",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-recommendation-params-dislike-correction-long-pause-reset-minutes",
    "anchor": "setting-recommendation-params-dislike-correction-long-pause-reset-minutes",
    "page": "recommendation",
    "title": "暂停后重置",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "setting-advanced-72ce9b8c3f",
    "anchor": "setting-advanced-72ce9b8c3f",
    "page": "advanced",
    "title": "更新推荐索引",
    "path": "歌曲推荐 / 准备与索引",
    "keywords": "更新索引 重建索引"
  },
  {
    "id": "setting-source-d76af2ccdf",
    "anchor": "setting-source-d76af2ccdf",
    "page": "source",
    "title": "播放音质",
    "path": "音乐库与在线 / 在线音源与音质",
    "keywords": " 在线音乐"
  },
  {
    "id": "setting-source-params-online-default-quality",
    "anchor": "setting-source-params-online-default-quality",
    "page": "source",
    "title": "默认音质",
    "path": "音乐库与在线 / 在线音源与音质 / 在线音乐",
    "keywords": ""
  },
  {
    "id": "setting-source-8149b7c3f4",
    "anchor": "setting-source-8149b7c3f4",
    "page": "source",
    "title": "音源脚本",
    "path": "音乐库与在线 / 在线音源与音质",
    "keywords": " 用户脚本"
  },
  {
    "id": "setting-source-704cc67428",
    "anchor": "setting-source-704cc67428",
    "page": "source",
    "title": "脚本文件",
    "path": "音乐库与在线 / 在线音源与音质 / 用户脚本",
    "keywords": ""
  },
  {
    "id": "setting-source-d2790c92be",
    "anchor": "setting-source-d2790c92be",
    "page": "source",
    "title": "已加载来源",
    "path": "音乐库与在线 / 在线音源与音质 / 用户脚本",
    "keywords": ""
  },
  {
    "id": "setting-source-onlinefilesource",
    "anchor": "setting-source-onlinefilesource",
    "page": "source",
    "title": "默认播放来源",
    "path": "音乐库与在线 / 在线音源与音质 / 用户脚本",
    "keywords": ""
  },
  {
    "id": "setting-theme-31472ea4de",
    "anchor": "setting-theme-31472ea4de",
    "page": "theme",
    "title": "界面主题",
    "path": "外观 / 软件外观",
    "keywords": "深色 浅色 深蓝 皮肤"
  },
  {
    "id": "setting-theme-customcolor",
    "anchor": "setting-theme-customcolor",
    "page": "theme",
    "title": "强调色",
    "path": "外观 / 软件外观 / 界面主题",
    "keywords": ""
  },
  {
    "id": "setting-lyric-14844bd3b8",
    "anchor": "setting-lyric-14844bd3b8",
    "page": "lyric",
    "title": "歌词来源",
    "path": "歌词 / 软件内歌词",
    "keywords": "找不到歌词 获取歌词"
  },
  {
    "id": "setting-lyric-externallyricdir",
    "anchor": "setting-lyric-externallyricdir",
    "page": "lyric",
    "title": "KTV 歌词目录",
    "path": "歌词 / 软件内歌词 / 歌词来源",
    "keywords": ""
  },
  {
    "id": "setting-lyric-6630c004ce",
    "anchor": "setting-lyric-6630c004ce",
    "page": "lyric",
    "title": "歌词保存",
    "path": "歌词 / 软件内歌词",
    "keywords": "导出 翻译 罗马音"
  },
  {
    "id": "setting-lyric-88c34452cc",
    "anchor": "setting-lyric-88c34452cc",
    "page": "lyric",
    "title": "位置",
    "path": "歌词 / 软件内歌词 / 歌词保存",
    "keywords": ""
  },
  {
    "id": "setting-lyric-lyricsaveincludetranslation",
    "anchor": "setting-lyric-lyricsaveincludetranslation",
    "page": "lyric",
    "title": "包含翻译",
    "path": "歌词 / 软件内歌词 / 歌词保存",
    "keywords": ""
  },
  {
    "id": "setting-lyric-lyricsaveincluderomanization",
    "anchor": "setting-lyric-lyricsaveincluderomanization",
    "page": "lyric",
    "title": "包含罗马音",
    "path": "歌词 / 软件内歌词 / 歌词保存",
    "keywords": ""
  },
  {
    "id": "setting-lyric-ddff81bbc8",
    "anchor": "setting-lyric-ddff81bbc8",
    "page": "lyric",
    "title": "字体与显示",
    "path": "歌词 / 软件内歌词",
    "keywords": " 软件内歌词"
  },
  {
    "id": "setting-lyric-lyricfontfamily",
    "anchor": "setting-lyric-lyricfontfamily",
    "page": "lyric",
    "title": "歌词字体",
    "path": "歌词 / 软件内歌词",
    "keywords": ""
  },
  {
    "id": "setting-lyric-lyricmainfontsize",
    "anchor": "setting-lyric-lyricmainfontsize",
    "page": "lyric",
    "title": "原文字号",
    "path": "歌词 / 软件内歌词",
    "keywords": "歌词太小 字体大小 放大"
  },
  {
    "id": "setting-lyric-lyricsubfontsize",
    "anchor": "setting-lyric-lyricsubfontsize",
    "page": "lyric",
    "title": "译文字号",
    "path": "歌词 / 软件内歌词",
    "keywords": "翻译太小 字体大小"
  },
  {
    "id": "setting-lyric-lyricactivecolor",
    "anchor": "setting-lyric-lyricactivecolor",
    "page": "lyric",
    "title": "高亮颜色",
    "path": "歌词 / 软件内歌词",
    "keywords": " 高亮颜色自定义颜色在关闭封面沉浸配色后生效。"
  },
  {
    "id": "setting-lyric-lyricinactivecolor",
    "anchor": "setting-lyric-lyricinactivecolor",
    "page": "lyric",
    "title": "普通颜色",
    "path": "歌词 / 软件内歌词",
    "keywords": ""
  },
  {
    "id": "setting-lyric-lyricmetacolor",
    "anchor": "setting-lyric-lyricmetacolor",
    "page": "lyric",
    "title": "歌曲信息颜色",
    "path": "歌词 / 软件内歌词",
    "keywords": ""
  },
  {
    "id": "setting-lyric-lyricbgcolor",
    "anchor": "setting-lyric-lyricbgcolor",
    "page": "lyric",
    "title": "背景颜色",
    "path": "歌词 / 软件内歌词",
    "keywords": ""
  },
  {
    "id": "setting-lyric-lyricactivescale",
    "anchor": "setting-lyric-lyricactivescale",
    "page": "lyric",
    "title": "自定义高亮放大",
    "path": "歌词 / 软件内歌词",
    "keywords": ""
  },
  {
    "id": "setting-lyric-lyricdisplaymode",
    "anchor": "setting-lyric-lyricdisplaymode",
    "page": "lyric",
    "title": "多语言显示",
    "path": "歌词 / 软件内歌词",
    "keywords": ""
  },
  {
    "id": "setting-lyric-lyrickaraoke",
    "anchor": "setting-lyric-lyrickaraoke",
    "page": "lyric",
    "title": "逐字高亮",
    "path": "歌词 / 软件内歌词",
    "keywords": ""
  },
  {
    "id": "setting-lyric-lyricstageautocolor",
    "anchor": "setting-lyric-lyricstageautocolor",
    "page": "lyric",
    "title": "封面沉浸配色",
    "path": "歌词 / 软件内歌词",
    "keywords": ""
  },
  {
    "id": "setting-lyric-lyricstagescale",
    "anchor": "setting-lyric-lyricstagescale",
    "page": "lyric",
    "title": "沉浸界面文字比例",
    "path": "歌词 / 软件内歌词",
    "keywords": ""
  },
  {
    "id": "setting-lyric-lyricglowenabled",
    "anchor": "setting-lyric-lyricglowenabled",
    "page": "lyric",
    "title": "动态流光背景",
    "path": "歌词 / 软件内歌词",
    "keywords": ""
  },
  {
    "id": "setting-lyric-lyricglowspeed",
    "anchor": "setting-lyric-lyricglowspeed",
    "page": "lyric",
    "title": "流光速度",
    "path": "歌词 / 软件内歌词",
    "keywords": "背景动画 快慢"
  },
  {
    "id": "setting-lyric-4319e8cb25",
    "anchor": "setting-lyric-4319e8cb25",
    "page": "lyric",
    "title": "歌词同步",
    "path": "歌词 / 软件内歌词",
    "keywords": "歌词偏移 歌词提前 歌词落后"
  },
  {
    "id": "setting-lyric-lyricrenderdelayms",
    "anchor": "setting-lyric-lyricrenderdelayms",
    "page": "lyric",
    "title": "时间偏移",
    "path": "歌词 / 软件内歌词 / 歌词同步",
    "keywords": ""
  },
  {
    "id": "setting-lyric-lyricfocusleadms",
    "anchor": "setting-lyric-lyricfocusleadms",
    "page": "lyric",
    "title": "换句提前量",
    "path": "歌词 / 软件内歌词 / 歌词同步",
    "keywords": ""
  },
  {
    "id": "setting-lyric-lyricswitchscrollms",
    "anchor": "setting-lyric-lyricswitchscrollms",
    "page": "lyric",
    "title": "滚动时长",
    "path": "歌词 / 软件内歌词 / 歌词同步",
    "keywords": ""
  },
  {
    "id": "setting-desktop-lyric-5095667048",
    "anchor": "setting-desktop-lyric-5095667048",
    "page": "desktop-lyric",
    "title": "桌面歌词",
    "path": "歌词 / 桌面歌词",
    "keywords": ""
  },
  {
    "id": "setting-desktop-lyric-desktoplyricenabled",
    "anchor": "setting-desktop-lyric-desktoplyricenabled",
    "page": "desktop-lyric",
    "title": "启用桌面歌词",
    "path": "歌词 / 桌面歌词",
    "keywords": ""
  },
  {
    "id": "setting-desktop-lyric-desktoplyriclocked",
    "anchor": "setting-desktop-lyric-desktoplyriclocked",
    "page": "desktop-lyric",
    "title": "锁定并点击穿透",
    "path": "歌词 / 桌面歌词",
    "keywords": ""
  },
  {
    "id": "setting-desktop-lyric-desktoplyriccovercolor",
    "anchor": "setting-desktop-lyric-desktoplyriccovercolor",
    "page": "desktop-lyric",
    "title": "颜色跟随封面",
    "path": "歌词 / 桌面歌词",
    "keywords": ""
  },
  {
    "id": "setting-desktop-lyric-desktoplyricmainfontsize",
    "anchor": "setting-desktop-lyric-desktoplyricmainfontsize",
    "page": "desktop-lyric",
    "title": "原文字号",
    "path": "歌词 / 桌面歌词",
    "keywords": "歌词太小 字体大小 放大"
  },
  {
    "id": "setting-desktop-lyric-desktoplyricsubfontsize",
    "anchor": "setting-desktop-lyric-desktoplyricsubfontsize",
    "page": "desktop-lyric",
    "title": "译文字号",
    "path": "歌词 / 桌面歌词",
    "keywords": "翻译太小 字体大小"
  },
  {
    "id": "setting-desktop-lyric-desktoplyricstroke",
    "anchor": "setting-desktop-lyric-desktoplyricstroke",
    "page": "desktop-lyric",
    "title": "描边强度",
    "path": "歌词 / 桌面歌词",
    "keywords": ""
  },
  {
    "id": "setting-desktop-lyric-desktoplyriclinemode",
    "anchor": "setting-desktop-lyric-desktoplyriclinemode",
    "page": "desktop-lyric",
    "title": "显示模式",
    "path": "歌词 / 桌面歌词",
    "keywords": ""
  },
  {
    "id": "setting-shortcuts-314c9abdb6",
    "anchor": "setting-shortcuts-314c9abdb6",
    "page": "shortcuts",
    "title": "播放控制",
    "path": "快捷键",
    "keywords": ""
  },
  {
    "id": "setting-history-d97701c357",
    "anchor": "setting-history-d97701c357",
    "page": "history",
    "title": "数据管理",
    "path": "曲库工具 / 听歌记录",
    "keywords": "清空统计 重置推荐学习"
  },
  {
    "id": "tool-folders",
    "anchor": "",
    "page": "folders",
    "title": "文件夹",
    "path": "曲库工具",
    "keywords": "目录 浏览 本地歌曲"
  },
  {
    "id": "tool-insights",
    "anchor": "",
    "page": "insights",
    "title": "曲库概览",
    "path": "曲库工具",
    "keywords": "标签 分析 乐器 风格 氛围"
  },
  {
    "id": "tool-history",
    "anchor": "",
    "page": "history",
    "title": "听歌记录",
    "path": "曲库工具",
    "keywords": "听了多久 历史 时长 播放次数"
  },
  {
    "id": "tool-song-info",
    "anchor": "",
    "page": "song-info",
    "title": "歌曲资料与歌词补全",
    "path": "曲库工具",
    "keywords": "查找歌词 补封面 歌名 歌手 批量补全"
  },
  {
    "id": "page-general",
    "anchor": "",
    "page": "general",
    "title": "播放与声音",
    "path": "播放与声音",
    "keywords": ""
  },
  {
    "id": "page-recommendation",
    "anchor": "",
    "page": "recommendation",
    "title": "推荐",
    "path": "歌曲推荐 / 接歌规则",
    "keywords": ""
  },
  {
    "id": "page-theme",
    "anchor": "",
    "page": "theme",
    "title": "软件外观",
    "path": "外观",
    "keywords": ""
  },
  {
    "id": "page-lyric",
    "anchor": "",
    "page": "lyric",
    "title": "软件内歌词",
    "path": "歌词",
    "keywords": ""
  },
  {
    "id": "page-desktop-lyric",
    "anchor": "",
    "page": "desktop-lyric",
    "title": "桌面歌词",
    "path": "歌词",
    "keywords": ""
  },
  {
    "id": "page-library-settings",
    "anchor": "",
    "page": "library-settings",
    "title": "本地音乐",
    "path": "音乐库与在线",
    "keywords": ""
  },
  {
    "id": "page-source",
    "anchor": "",
    "page": "source",
    "title": "在线音源与音质",
    "path": "音乐库与在线",
    "keywords": ""
  },
  {
    "id": "page-downloads",
    "anchor": "",
    "page": "downloads",
    "title": "下载与入库",
    "path": "音乐库与在线",
    "keywords": ""
  },
  {
    "id": "page-shortcuts",
    "anchor": "",
    "page": "shortcuts",
    "title": "快捷键",
    "path": "快捷键",
    "keywords": "快捷键 键盘 热键"
  },
  {
    "id": "page-advanced",
    "anchor": "",
    "page": "advanced",
    "title": "准备与索引",
    "path": "歌曲推荐",
    "keywords": ""
  },
  {
    "id": "page-logs",
    "anchor": "",
    "page": "logs",
    "title": "诊断日志",
    "path": "数据与帮助",
    "keywords": ""
  },
  {
    "id": "page-manual",
    "anchor": "",
    "page": "manual",
    "title": "帮助与恢复",
    "path": "数据与帮助",
    "keywords": ""
  }
];
const categoryFor=page=>categories.find(c=>c.pages.includes(page))||null;
const normalize=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g,' ').trim();
const search=query=>{const terms=normalize(query).split(/[\s，,、]+/u).filter(Boolean);if(!terms.length)return [];return items.filter(i=>terms.every(t=>normalize(i.title+' '+i.path+' '+i.keywords).includes(t))).sort((a,b)=>Number(normalize(b.title)===normalize(query))-Number(normalize(a.title)===normalize(query)));};
root.FlowaveSettings=Object.freeze({categories:categories.map(c=>Object.freeze({...c,pages:Object.freeze(c.pages)})),titles:Object.freeze(titles),items:items.map(Object.freeze),categoryFor,search});
})(window);
