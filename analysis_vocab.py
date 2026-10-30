"""Versioned, user-facing labels; independent of the research artifact."""
VERSION='flowave-analysis-1'
THEMES={'epic':'史诗感','dream':'梦幻','romantic':'浪漫','meditative':'冥想','party':'派对','adventure':'冒险感','dramatic':'戏剧感','hopeful':'希望感','inspiring':'鼓舞','soundscape':'声音景观','retro':'复古'}
INSTRUMENTS=dict(zip('accordion acousticbassguitar acousticguitar bass beat bell bongo brass cello clarinet classicalguitar computer doublebass drummachine drums electricguitar electricpiano flute guitar harmonica harp horn keyboard oboe orchestra organ pad percussion piano pipeorgan rhodes sampler saxophone strings synthesizer trombone trumpet viola violin voice'.split(),
 '手风琴 原声贝斯 原声吉他 贝斯 节拍 铃声 邦戈鼓 铜管 大提琴 单簧管 古典吉他 电子音色 低音提琴 鼓机 鼓 电吉他 电钢琴 长笛 吉他 口琴 竖琴 圆号 键盘 双簧管 管弦乐 风琴 铺底音色 打击乐 钢琴 管风琴 罗德电钢琴 采样音色 萨克斯 弦乐 合成器 长号 小号 中提琴 小提琴 人声'.split()))
GENRES=dict(zip('60s 70s 80s 90s acidjazz alternative alternativerock ambient atmospheric blues bluesrock bossanova breakbeat celtic chanson chillout choir classical classicrock club contemporary country dance darkambient darkwave deephouse disco downtempo drumnbass dub dubstep easylistening edm electronic electronica electropop ethno eurodance experimental folk funk fusion groove grunge hard hardrock hiphop house idm improvisation indie industrial instrumentalpop instrumentalrock jazz jazzfusion latin lounge medieval metal minimal newage newwave orchestral pop popfolk poprock postrock progressive psychedelic punkrock rap reggae rnb rock rocknroll singersongwriter soul soundtrack swing symphonic synthpop techno trance triphop world worldfusion'.split(),
 '六十年代 七十年代 八十年代 九十年代 酸爵士 另类 另类摇滚 氛围音乐 空间氛围 布鲁斯 布鲁斯摇滚 波萨诺瓦 碎拍 凯尔特 香颂 驰放 合唱 古典 经典摇滚 俱乐部 当代 乡村 舞曲 暗黑氛围 暗潮 深度浩室 迪斯科 慢拍 鼓打贝斯 回响 雷鬼步 轻音乐 电子舞曲 电子 电子音乐 电子流行 民族 欧陆舞曲 实验 民谣 放克 融合 律动 垃圾摇滚 硬派 硬摇滚 嘻哈 浩室 智慧舞曲 即兴 独立 工业 器乐流行 器乐摇滚 爵士 融合爵士 拉丁 沙发音乐 中世纪 金属 极简 新世纪 新浪潮 管弦乐 流行 流行民谣 流行摇滚 后摇 前卫 迷幻 朋克摇滚 说唱 雷鬼 节奏布鲁斯 摇滚 早期摇滚 创作歌手 灵魂乐 配乐 摇摆 交响 合成器流行 科技舞曲 迷幻舞曲 神游舞曲 世界音乐 世界融合'.split()))
MOODS=[('calm','舒缓',['平静舒缓、低强度的音乐。','安静放松、节奏从容的音乐。'],['Calm and relaxing music with a gentle pace.','Peaceful low-intensity music.']),
 ('energetic','强劲',['节奏强劲、充满力量的音乐。','激烈而有冲劲、能量很高的音乐。'],['Intense energetic music with a powerful driving rhythm.','High-energy vigorous music.']),
 ('bright','明亮',['明亮欢快、充满愉悦感的音乐。','阳光、轻快、积极的音乐。'],['Bright cheerful joyful music.','Upbeat sunny positive music.']),
 ('sad','忧郁',['低落忧郁、带有悲伤感的音乐。','哀伤、伤感的音乐。'],['Sad melancholic music.','Sorrowful wistful music.']),
 ('gentle','温柔',['柔和温柔、不尖锐的音乐。','轻柔细腻、温暖的音乐。'],['Soft gentle tender music.','Delicate warm mellow music.']),
 ('ethereal','空灵',['空灵飘渺、空间感明显的音乐。','轻盈梦幻、仿佛漂浮的音乐。'],['Ethereal airy spacious music.','Dreamy floating atmospheric music.']),
 ('cute','可爱',['俏皮可爱、轻巧活泼的音乐。','甜美可爱、有童趣的音乐。'],['Cute playful sweet music.','Adorable lighthearted whimsical music.']),
 ('dark','暗沉',['暗沉压抑、带有紧张感的音乐。','阴暗、沉重的音乐。'],['Dark tense brooding music.','Heavy ominous somber music.'])]

def labels(kind):
    return INSTRUMENTS if kind=='instrument' else GENRES if kind=='genre' else THEMES if kind=='theme' else {x[0]:x[1] for x in MOODS}

def top_tags(kind,values,n=3):
    # A shortlist is an explicitly relative suggestion, never a presence threshold.
    known=labels(kind)
    ordered=sorted(((key,float(value)) for key,value in values.items() if key in known),key=lambda x:-x[1])
    result=[]
    families={'guitar':'吉他','electricguitar':'吉他','acousticguitar':'吉他','classicalguitar':'吉他',
              'strings':'弦乐','violin':'弦乐','viola':'弦乐','cello':'弦乐','doublebass':'弦乐',
              'keyboard':'键盘','piano':'键盘','electricpiano':'键盘','rhodes':'键盘'}
    seen=set()
    for key,value in ordered:
        if value<=0:continue
        family=families.get(key,key) if kind=='instrument' else key
        if family in seen:continue
        seen.add(family);result.append({'id':kind+':'+key,'key':key,'label':known[key],'score':value})
        if len(result)>=n:break
    return result
