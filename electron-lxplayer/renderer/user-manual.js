(function (root) {
  'use strict';
  const chapters = new Map();
  let catalogue;
  const tourSteps = [
    {title: '从一首喜欢的歌开始', topic: 'start', image: 'library.png',
      text: '从一首喜欢的歌开始听，点开封面看歌词。选装歌曲推荐后，可以沿当前氛围连续听，遇到不合适的一首时接回此前的感觉，也可以主动换个方向。',
      points: ['左侧切换歌曲和歌单，中间查找音乐。', '双击歌曲播放，底部控制暂停、切歌和音量。', '点击底部封面，进入沉浸歌词。']},
    {title: '添加音乐，就可以听了', topic: 'add-music', image: 'library-settings.png',
      text: '先让 Flowave 找到你的音乐。推荐和分析可以之后再准备。',
      points: ['点击下方按钮，添加音乐文件夹。', '核对目录后点击“应用更改”，等待歌曲载入。', '回到歌曲页，双击一首播放。手册可随时重新打开。'],
      action: {label: '添加音乐文件夹', page: 'library-settings'}},
    {title: '选择你想用的功能', topic: 'packages', image: 'packages.png',
      text: '基础播放器可直接听歌。其他功能按用途选装，安装页会说明资源和硬件要求。',
      features: true, action: {label: '查看插件与模型', page: 'features'}},
    {title: '需要时，手册就在左下角', topic: 'find-settings', image: 'library.png',
      text: '打开“使用手册”，搜索你要做的事。每篇都有操作入口，复杂功能还可以继续阅读原理。',
      points: ['按 F1 打开当前页面的帮助。', '“前往设置”直接定位相关功能，按步骤继续。', '重新查看入门引导、备份和版本信息，都能从帮助入口找到。']},
  ];
  async function readJson(file, signal) {
    const response = await fetch('help/' + file + '.json', {signal});
    if (!response.ok) throw Error('离线手册文件读取失败，请重试。');
    return response.json();
  }
  root.FlowaveUserManual = {
    props: {topic: {type: String, default: 'start'}, active: Boolean, tour: Boolean, saveBusy: Boolean, saveError: String,
      musicCount: Number, features: Object},
    emits: ['topic', 'navigate', 'back', 'tour', 'finish'],
    data: () => ({catalogue: catalogue || null, article: null, query: '', loading: true, failure: '',
      tourIndex: 0, menuOpen: false, imageFailed: false, enlarged: null, history: [], position: -1, loadGeneration: 0}),
    computed: {
      currentStep() { return tourSteps[this.tourIndex]; },
      currentChapter() { return this.catalogue?.chapters.find(chapter => chapter.articles.some(article => article.id === this.topic)); },
      neighbors() {
        const articles = this.catalogue?.chapters.flatMap(chapter => chapter.articles) || [];
        const index = articles.findIndex(article => article.id === this.topic);
        return index < 0 ? {} : {previous: articles[index - 1], next: articles[index + 1]};
      },
      results() {
        const q = this.query.normalize('NFKC').toLowerCase().trim();
        if (!q || !this.catalogue) return [];
        const terms = q.split(/\s+/u);
        // Exact Chinese terms remain discoverable regardless of fuzzy tokenisation.
        const items = this.catalogue.chapters.flatMap(chapter => chapter.articles.map(article => ({...article, chapter: chapter.title})));
        const exact = items.filter(item => terms.every(term => [item.title, item.summary, item.search].join(' ').normalize('NFKC').toLowerCase().includes(term)));
        if (exact.length || !root.Fuse) return exact;
        return new root.Fuse(items, {keys: [{name: 'title', weight: 3}, 'summary', 'search'], threshold: .25, ignoreLocation: true})
          .search(q).slice(0, 12).map(result => result.item);
      },
      featureRows() {
        return [
          {id: 'recommendation', topic:'prepare-recommendation', name: '歌曲推荐', text: '沿当前氛围接歌，随时找回或换个感觉。'},
          {id: 'analysis', topic:'analysis', name: '歌曲分析', text: '看乐器、风格和段落，组合标签找歌。'},
          {id: 'practice', topic:'practice', name: '演奏练习', text: '准备分轨，调伴奏并循环练习。'},
          {id: 'history', topic:'history', name: '听歌记录', text: '查看听歌时长、次数和排行。'},
        ].map(item => ({...item, state: root.FlowaveFeatureModules?.failures?.[item.id] ? '载入失败，前往功能页检查'
          : this.features?.active?.enabled?.[item.id] === true
          ? '当前已启用' : this.features?.packages?.[item.id]?.installed ? '已安装，核对启用状态' : '可按需安装'}));
      },
    },
    watch: {
      active(value) { if (value) this.$nextTick(() => this.$refs.heading?.focus({preventScroll: true})); else this.$refs.imageDialog?.close(); },
      menuOpen(value) { if (value) this.$nextTick(() => this.$refs.contents?.querySelector('[aria-current="page"]')?.scrollIntoView({block:'nearest'})); },
      topic() { this.loadArticle(); },
      tour() { this.tourIndex = 0; this.query = ''; this.focusTitle(); },
    },
    mounted() { this.controller = new AbortController(); this.loadArticle(); },
    beforeUnmount() { this.loadGeneration++; this.controller?.abort(); this.$refs.imageDialog?.close(); },
    methods: {
      async loadArticle() {
        const generation = ++this.loadGeneration;
        this.loading = true;
        this.failure = '';
        this.imageFailed = false;
        try {
          const index = catalogue || await readJson('catalog', this.controller?.signal);
          if (generation !== this.loadGeneration) return;
          catalogue = index;
          this.catalogue = Vue.markRaw(index);
          const chapter = index.chapters.find(chapter => chapter.articles.some(article => article.id === this.topic));
          if (!chapter) throw Error('这个章节未包含在当前版本中，请从目录重新选择。');
          let data = chapters.get(chapter.id);
          if (!data) { data = await readJson(chapter.id, this.controller?.signal); chapters.set(chapter.id, data); }
          if (generation !== this.loadGeneration) return;
          this.article = Vue.markRaw(data.articles.find(article => article.id === this.topic));
          if (this.history[this.position] !== this.topic) {
            this.history = this.history.slice(0, this.position + 1).concat(this.topic);
            this.position++;
          }
          this.focusTitle();
        } catch (error) { if (generation === this.loadGeneration && error.name !== 'AbortError') this.failure = error.message; }
        finally { if (generation === this.loadGeneration) this.loading = false; }
      },
      focusTitle() {
        this.$nextTick(() => {
          if (this.$refs.body) this.$refs.body.scrollTop = 0;
          if (this.active) this.$refs.heading?.focus({preventScroll: true});
          if (this.active) this.$refs.contents?.querySelector('[aria-current="page"]')?.scrollIntoView({block:'nearest'});
        });
      },
      choose(id) {
        this.query = ''; this.menuOpen = false;
        if (id === this.topic) this.focusTitle();
        else this.$emit('topic', id);
      },
      closeContents(event) {
        if (!this.menuOpen) return;
        event.preventDefault(); event.stopPropagation();
        this.menuOpen = false;
        this.$nextTick(() => this.$refs.menuToggle?.focus());
      },
      goBack() { if (this.position > 0) { this.position--; this.choose(this.history[this.position]); } },
      goToSection(index) {
        const section = this.$refs.body?.querySelector('#help-section-' + index);
        section?.scrollIntoView({block: 'start'});
        section?.focus({preventScroll: true});
      },
      actionLabel(action) {
        const setting = root.FlowaveSettings?.items.find(item => item.anchor === action.anchor && item.page === action.page);
        return setting?.path || root.FlowaveSettings?.titles[action.page] || '';
      },
      articleTitle(id) { return this.catalogue?.chapters.flatMap(chapter => chapter.articles).find(article => article.id === id)?.title || id; },
      advance(delta) { this.tourIndex += delta; this.imageFailed = false; this.focusTitle(); },
      showImage(src, caption) {
        this.enlarged = {src, caption};
        this.$nextTick(() => this.$refs.imageDialog?.showModal());
      },
      imagePath(name) { return 'help/images/' + name; },
      openTourArticle() { this.$emit('topic', this.currentStep.topic); this.$emit('tour', false); },
    },
    template: `
      <section class="user-help" aria-label="使用手册">
        <header class="help-toolbar">
          <button v-if="!tour" class="mini ghost" @click="$emit('back')">‹ 返回软件</button>
          <span class="help-brand">{{tour ? '欢迎使用 Flowave' : '使用手册'}}</span>
          <label v-if="!tour" class="help-search"><input type="search" aria-label="搜索手册" v-model="query" placeholder="搜索功能、操作或问题" @keydown.esc.stop="query=''" /></label>
          <button v-if="!tour" class="mini ghost" @click="$emit('tour',true)">入门引导</button>
          <button v-else class="mini ghost help-skip" :disabled="saveBusy" @click="$emit('finish','skipped')">跳过引导</button>
        </header>
        <div v-if="tour" class="help-tour">
          <nav class="help-tour-steps" aria-label="入门步骤">
            <button v-for="(name,index) in ['认识软件','添加音乐','按需选装','随时查阅']" :key="name"
              :class="{active:tourIndex===index}" :aria-current="tourIndex===index?'step':null"
              @click="tourIndex=index;imageFailed=false;focusTitle()">
              <span>{{index+1}}</span>{{name}}
            </button>
          </nav>
          <div ref="body" class="help-tour-body">
            <div class="help-tour-copy">
              <p class="help-eyebrow">开始使用 · {{tourIndex+1}} / 4</p>
              <h1 ref="heading" tabindex="-1">{{currentStep.title}}</h1>
              <p class="help-lead">{{currentStep.text}}</p>
              <ul v-if="currentStep.points" class="help-tour-points">
                <li v-for="point in currentStep.points" :key="point">{{point}}</li>
              </ul>
              <dl v-if="currentStep.features" class="help-feature-list">
                <div v-for="item in featureRows" :key="item.id">
                  <dt>{{item.name}}<small>{{item.state}}</small></dt>
                  <dd>{{item.text}}</dd>
                  <button class="help-feature-link" @click="choose(item.topic);$emit('tour',false)">了解{{item.name}} →</button>
                </div>
              </dl>
              <p v-if="tourIndex===1" class="help-status">{{musicCount>0 ? '当前曲库已载入 '+musicCount+' 首歌曲，可以开始播放。' : '当前曲库还没有歌曲。前往设置添加音乐，之后可从左下角手册继续查看。'}}</p>
              <p v-if="tourIndex===2" class="help-status">推荐准备顺序<br />安装资源 → 重启启用 → 添加音乐 → 更新索引 → 开启连续推荐</p>
              <div class="help-actions">
                <button class="mini ghost" @click="openTourArticle">阅读详细操作 ↗</button>
              </div>
            </div>
            <figure class="help-tour-picture">
              <button class="help-image-button" :disabled="imageFailed" @click="showImage(imagePath(currentStep.image),'当前界面示例')">
                <img v-if="!imageFailed" :src="imagePath(currentStep.image)" alt="当前软件界面示例，可点击放大" @error="imageFailed=true" />
                <span v-else>图片暂不可用，可继续阅读文字说明。</span>
              </button>
              <figcaption>当前界面示例 · 点击图片放大</figcaption>
              <ol v-if="catalogue?.figures?.[currentStep.image]" class="help-figure-key" aria-label="图中标注">
                <li v-for="(point,i) in catalogue.figures[currentStep.image].points" :key="point.label"><b>{{i+1}}</b>{{point.label}}</li>
              </ol>
            </figure>
          </div>
          <footer class="help-tour-footer">
            <span>稍后可从左下角“使用手册”重新打开。</span>
            <div>
              <button v-if="tourIndex>0" class="mini ghost" @click="advance(-1)">上一步</button>
              <button v-if="currentStep.action" class="mini" @click="$emit('navigate',currentStep.action)">{{currentStep.action.label}}</button>
              <button v-if="tourIndex<3" class="primary" @click="advance(1)">下一步</button>
              <button v-else class="primary" :disabled="saveBusy" @click="$emit('finish','completed')">{{saveBusy?'正在保存…':'开始使用'}}</button>
            </div>
          </footer>
          <p v-if="saveError" class="help-error" role="alert">{{saveError}}</p>
        </div>
        <template v-else>
          <button ref="menuToggle" class="help-menu-toggle mini ghost" :aria-expanded="menuOpen" @click="menuOpen=!menuOpen">章节目录 {{menuOpen?'⌃':'⌄'}}</button>
          <div class="help-reader">
            <aside ref="contents" class="help-contents" :class="{'is-open':menuOpen}" aria-label="手册章节" @keydown.esc="closeContents">
              <nav v-if="catalogue">
                <section v-for="chapter in catalogue.chapters" :key="chapter.id">
                  <h2>{{chapter.title}}</h2>
                  <button v-for="item in chapter.articles" :key="item.id" :class="{active:!query && topic===item.id}"
                    :aria-current="!query && topic===item.id?'page':null" @click="choose(item.id)">{{item.title}}</button>
                </section>
              </nav>
              <button class="help-retry mini" v-if="failure" @click="loadArticle">重新载入</button>
            </aside>
            <main ref="body" class="help-body">
              <div v-if="query.trim()" class="help-article help-results">
                <p class="help-eyebrow">手册搜索</p>
                <h1>“{{query}}”</h1>
                <p class="help-lead">{{results.length}} 篇相关说明</p>
                <button v-for="item in results" :key="item.id" @click="choose(item.id)">
                  <small>{{item.chapter}}</small><strong>{{item.title}}</strong><span>{{item.summary}}</span>
                </button>
                <p v-if="!results.length">尝试功能名称或较短的词，例如“索引”“歌词”“工作区”。</p>
              </div>
              <div v-else-if="failure" class="help-article" role="alert">
                <h1>手册暂时无法读取</h1><p>{{failure}}</p>
                <button class="mini" @click="loadArticle">重试</button>
              </div>
              <p v-else-if="loading" class="help-article" role="status">正在载入章节…</p>
              <article v-else-if="article" class="help-article">
                <div class="help-breadcrumb"><button v-if="position>0" class="mini ghost" @click="goBack">‹ 返回上次阅读</button><span>{{currentChapter?.title}}</span></div>
                <h1 ref="heading" tabindex="-1">{{article.title}}</h1>
                <p class="help-lead">{{article.summary}}</p>
                <p v-if="article.entry" class="help-entry"><strong>入口</strong>{{article.entry}}</p>
                <details v-if="article.sections.length > 1" :key="article.id" class="help-outline">
                  <summary>本页目录</summary>
                  <nav aria-label="本页目录">
                    <button v-for="(section,index) in article.sections" :key="index" class="help-text-link" @click="goToSection(index)">{{section.title}}</button>
                  </nav>
                </details>
                <template v-for="(section,index) in article.sections" :key="index">
                <section class="help-section" :id="'help-section-'+index" tabindex="-1">
                  <h2>{{section.title}}</h2>
                  <p v-for="(paragraph,i) in section.paragraphs" :key="'p'+i">{{paragraph}}</p>
                  <ol v-if="section.steps" class="help-steps">
                    <li v-for="(step,i) in section.steps" :key="i">{{step}}</li>
                  </ol>
                  <div v-if="section.table" class="help-table-wrap">
                    <table>
                      <thead><tr><th v-for="(cell,i) in section.table.head" :key="i" scope="col">{{cell}}</th></tr></thead>
                      <tbody><tr v-for="(row,i) in section.table.rows" :key="i"><td v-for="(cell,j) in row" :key="j">{{cell}}</td></tr></tbody>
                    </table>
                  </div>
                  <div v-if="section.actions" class="help-actions">
                    <button v-for="(action,i) in section.actions" :key="i" class="mini" :title="actionLabel(action)" @click="$emit('navigate',action)">{{action.label}} ↗</button>
                  </div>
                  <nav v-if="section.links" class="help-links" aria-label="进一步阅读">
                    <button v-for="link in section.links" :key="link.id" @click="choose(link.id)">{{link.label}} →</button>
                  </nav>
                </section>
                <figure v-if="index===0 && article.image" class="help-figure">
                  <button class="help-image-button" :disabled="imageFailed" @click="showImage(imagePath(article.image),article.caption)">
                    <img v-if="!imageFailed" :src="imagePath(article.image)" :alt="article.caption" loading="lazy" decoding="async" @error="imageFailed=true" />
                    <span v-else>图片暂不可用，可继续阅读以下操作。</span>
                  </button>
                  <figcaption>{{article.caption}} <span v-if="!imageFailed">点击放大</span></figcaption>
                  <ol v-if="catalogue.figures?.[article.image]?.points?.length" class="help-figure-key" aria-label="图中标注">
                    <li v-for="(point,i) in catalogue.figures[article.image].points" :key="point.label"><b>{{i+1}}</b>{{point.label}}</li>
                  </ol>
                </figure>
                </template>
                <footer v-if="article.related?.length" class="help-related">
                  <h2>相关操作</h2>
                  <button v-for="id in article.related" :key="id" @click="choose(id)">{{articleTitle(id)}} →</button>
                </footer>
                <nav class="help-pagination" aria-label="相邻文章">
                  <button v-if="neighbors.previous" class="help-text-link" @click="choose(neighbors.previous.id)"><small>上一篇</small>{{neighbors.previous.title}}</button>
                  <button v-if="neighbors.next" class="help-text-link" @click="choose(neighbors.next.id)"><small>下一篇</small>{{neighbors.next.title}}</button>
                </nav>
              </article>
            </main>
          </div>
        </template>
        <dialog ref="imageDialog" class="help-image-dialog" @close="enlarged=null" @keydown.esc.stop @click.self="$refs.imageDialog.close()">
          <template v-if="enlarged">
            <header><p>{{enlarged.caption}}</p><button class="mini" autofocus @click="$refs.imageDialog.close()">关闭图片</button></header>
            <img :src="enlarged.src" :alt="enlarged.caption" />
          </template>
        </dialog>
      </section>`,
  };
})(window);
