(function(root){
  'use strict';
  const intents={continue:'自然续播',recover:'找回感觉',change:'换个感觉'};
  const finite=v=>typeof v==='number'&&Number.isFinite(v);
  const number=v=>finite(v)?v.toFixed(4):'未记录';
  const fallbacks={quality_balanced:'正常质量池',strict:'严格池',continuity_reserve:'应急池',context_preserving_replay:'保留感觉重听',same_direction_expansion:'同方向扩展',older_repeat:'较早重听',expanded_older_repeat:'扩展后重听'};
  function inspect(row,lookup){
    if(!row?.decision)return null;
    const d=row.decision,p=d.policyDetails||{},s=d.selectedScores||{},e=d.evidence;
    const stored=new Map([d.from,d.target,...(d.contextReferences||[]),...(d.recent||[])].filter(Boolean).map(r=>[r.resourceId,r]));
    const name=k=>{
      const info=lookup?.(k),r=stored.get(k);
      return info?.title&&info.title!=='未索引歌曲'?info.title:r?.title||r?.songKey||r?.path?.split(/[\\/]/).pop()||String(k||'未知歌曲');
    };
    const effective=root.FlowaveSoundMapModel.effectiveIntent(row),requested=d.intent||({like_button:'recover',dislike_button:'change',natural:'continue'}[d.trigger]);
    const refs=new Map(),comparisons=new Map((e?.reference_comparisons||[]).map(r=>[r.key,r]));
    const add=(k,role)=>{if(!k)return;const item=refs.get(k)||{key:k,name:name(k),roles:[]};if(!item.roles.includes(role))item.roles.push(role);refs.set(k,item);};
    add(d.from?.resourceId,effective==='recover'?'失配当前曲 · 不作正参考':effective==='change'?'实际离开曲':'实际相邻依据');
    for(const k of p.context_keys||d.contextReferences?.map(r=>r.resourceId)||[])add(k,effective==='change'?'离开方向约束':'正向参考');
    for(const k of p.direction_keys||[])add(k,k===p.origin_key?'根参考 · 弱奖励':'慢参考 · 弱奖励');
    for(const k of p.recent_keys||d.recent?.map(r=>r.resourceId)||[])add(k,'近期有效听曲');
    for(const k of p.route_keys||[])if(!refs.has(k))add(k,'经过路线 · 未入本次正参考');
    const referenceRows=[...refs.values()].map(r=>({...r,roles:r.roles.join(' / '),...comparisons.get(r.key),weight:e?.audio_rule==='bridge'?undefined:(e?.audio_reference_weights||p.audio_reference_weights)?.[r.key]}));
    const negatives=Array.isArray(p.negative_contexts)?p.negative_contexts.map(n=>{
      const effect=e?.negatives?.find(v=>v.key===n.key);
      return {key:n.key,name:name(n.key),positive:(n.positive||[]).map(name).join('、'),...effect};
    }):null;
    const memories=Array.isArray(p.direction_memories)?p.direction_memories.map((m,i)=>({index:i,names:(m.keys||[]).map(name).join('、'),strength:m.strength,...e?.memories?.find(v=>v.index===i)})):null;
    const scoreRows=[[finite(s.audio_primary)?'audio_primary':'audio_score','音频基础分',1],['mert_adjustment','MERT辅助',1],['bridge_penalty','桥接扣分',-1],['tag_adjustment','独立标签',1],['direction_adjustment','弱核心奖励',1],['recent_reward','近期连续奖励',1],['negative_penalty','纠偏负例',-1],['old_direction_penalty','旧方向避返',-1],['repeat_penalty','近期重听',-1]].map(([key,label,sign])=>({key,label,value:finite(s[key])?s[key]*sign:null}));
    return {d,p,s,e,effective,requested,name,refs:referenceRows,negatives,memories,scoreRows,
      operation:intents[effective]||'其他来源',requestedLabel:intents[requested]||d.trigger||d.source||'未记录',
      rootName:Object.hasOwn(p,'origin_key')?(p.origin_key?name(p.origin_key):'无根参考'):'旧记录未单独保存',
      model:({'muq+mert':'MuQ + MERT',mert_only:'MERT',muq_continuity_reserve:'MuQ应急',mert_continuity_reserve:'MERT应急',context_replay:'完整耗尽后重听'})[p.model]||p.model||'未记录',fallback:fallbacks[p.reason]||fallbacks[p.fallback]||p.fallback||d.fallback||'未记录',
      candidateSample:(d.candidateSample||[]).map(v=>({...v,name:name(v.track?.resourceId),scores:v.scores||{}})),
      raw:JSON.stringify(d,null,2)};
  }
  root.FlowaveRecommendationEvidence={inspect,number};
  root.FlowaveRecommendationInspector={
    props:{row:Object,lookup:Function},computed:{audit(){return inspect(this.row,this.lookup);}},
    methods:{n:number,signed(v){return finite(v)?(v>0?'+':'')+v.toFixed(4):'未记录';},pct(v){return finite(v)?(v*100).toFixed(1)+'%':'未记录';},
      audioWeight(r){
        if(this.audit.e?.ranking_applied===false)return '不适用';
        if(this.audit.e?.audio_rule==='bridge')return '桥接分';
        if(finite(r.weight))return this.pct(r.weight);
        if(this.audit.p.audio_reference_rule==='maximum_departure')return '上限约束';
        return this.audit.e?.audio_reference_weights||this.audit.p.audio_reference_rule==='weighted_semantic'?'不计入':'未记录';
      },
      tags(values){return (values||[]).map(t=>t.label+' '+t.score.toFixed(2)).join('、');},
      kind(v){return {instrument:'乐器',genre:'风格',mood:'氛围',theme:'主题'}[v]||v;},
      stage(v){return {strict:'严格',same_direction_expansion:'同方向扩展',connected_neighbourhood:'两跳关联'}[v]||v;}},
    template:`<section class="recommendation-inspector" aria-label="推荐诊断">
      <p v-if="!row">选择下方歌曲步骤查看推荐依据。</p>
      <p v-else-if="!audit">这一步没有保存推荐决策。</p>
      <template v-else>
        <div class="recommendation-audit-heading"><strong>第 {{row.ordinal}} 步 · {{audit.operation}}</strong><span>{{audit.p.policy_build || audit.d.policy || '旧记录'}}</span></div>
        <p v-if="audit.requested!==audit.effective && audit.effective" class="recommendation-audit-warning">请求{{audit.requestedLabel}} → 实际{{audit.operation}}<span v-if="audit.p.recovery_reference_missing"> · 正向参考已空</span></p>
        <p v-if="audit.d.diagnosticTruncated" class="recommendation-audit-warning">这条记录超出保存上限，部分诊断未保存。</p>
        <p v-if="audit.p.semantic_conflicts?.length" class="recommendation-audit-warning">检测到MuQ表示冲突，本次评分暂不采用冲突向量。</p>
        <p v-if="audit.e?.ranking_applied===false" class="recommendation-audit-note">完整计算后没有可靠其他歌曲，本步直接重听，未进行候选排序加减。</p>
        <p v-if="audit.d.policy==='manual-or-list'" class="recommendation-audit-note">手动或列表选歌，此步未经过推荐评分。</p>
        <dl class="recommendation-audit-facts">
          <div><dt>主音频 / 选歌层</dt><dd>{{audit.model}} · {{audit.fallback}}</dd></div>
          <div><dt>有效 / 本次可用 MuQ</dt><dd>{{audit.p.semantic_available ?? '未记录'}} / {{audit.p.scoring_semantic_available ?? '未记录'}}</dd></div>
          <div><dt>{{audit.effective==='change'?'离开方向根歌曲':'本次弱根歌曲'}}</dt><dd>{{audit.rootName}}</dd></div>
          <div v-if="audit.effective==='change'"><dt>播放成功后的新根</dt><dd>{{row.title || audit.name(audit.d.target?.resourceId)}}</dd></div>
          <div><dt>输入听曲 / 冻结</dt><dd>{{audit.p.qualified_listens ?? '未记录'}} / {{audit.p.repair_active===true?'恢复参考冻结':audit.p.repair_active===false?'无冻结':'未记录'}}</dd></div>
          <div><dt>候选 / 被选排名</dt><dd>{{audit.d.candidateCount ?? '未记录'}} / {{audit.d.selectedRank ?? '未记录'}}</dd></div>
          <div><dt>抽中概率 / 重听</dt><dd>{{pct(audit.d.probability)}} / {{audit.d.repeatedRecommendation===true?'是':audit.d.repeatedRecommendation===false?'否':'未记录'}}</dd></div>
          <div><dt>实际相邻 MERT</dt><dd>{{n(audit.s.sim ?? audit.d.similarity)}}</dd></div>
          <div><dt>实际相邻 MuQ</dt><dd>{{n(audit.s.local_semantic_similarity)}}</dd></div>
          <div v-if="audit.p.natural_semantic_floor!=null"><dt>应急自然 MuQ 下限</dt><dd>{{n(audit.p.natural_semantic_floor)}}</dd></div>
          <div v-for="(gate,key) in audit.p.semantic_neighbourhood || {}" :key="key"><dt>{{audit.name(key)}} · 稀疏近邻</dt><dd><template v-if="gate.role==='soft_context'">保留软参考</template><template v-else>{{n(gate.base_floor)}} → {{n(gate.effective_floor)}}</template> · 最近其他录音 {{n(gate.nearest_other)}}</dd></div>
          <div><dt>相邻 MERT 门</dt><dd>{{n(audit.p.adjacent_mert_base_floor)}} → {{n(audit.p.adjacent_mert_floor)}}<span v-if="audit.effective!=='continue'"> · 主动操作例外</span></dd></div>
          <div v-if="audit.effective==='change'"><dt>换向 MERT 上限</dt><dd>{{n(audit.p.change_mert_ceiling)}}</dd></div>
          <div><dt>同录音文件</dt><dd>{{audit.s.recording_group_size ?? '旧记录未保存'}}<span v-if="audit.p.recording_duplicate_files!=null"> · 全库折叠 {{audit.p.recording_duplicate_files}} 份副本</span></dd></div>
        </dl>
        <h3>参考歌曲与作用</h3><p v-if="!audit.e" class="recommendation-audit-note">旧记录未保存逐项相似度，以下仅列当时记录的角色。</p>
        <table class="recommendation-audit-table"><thead><tr><th>歌曲 / 角色</th><th>MERT</th><th>MuQ</th><th>音频权重</th></tr></thead><tbody><tr v-for="r in audit.refs" :key="r.key"><td><b>{{r.name}}</b><small>{{r.roles}}</small></td><td>{{n(r.mert)}}</td><td>{{n(r.muq)}}</td><td>{{audioWeight(r)}}</td></tr></tbody></table>
        <p v-if="audit.e && audit.e.reference_count>audit.e.reference_comparisons.length" class="recommendation-audit-note">共 {{audit.e.reference_count}} 首对照，保存了 {{audit.e.reference_comparisons.length}} 首逐项值；换向优先保存最相近项。</p>
        <p v-if="audit.p.audio_reference_rule==='maximum_departure'" class="recommendation-audit-note">离开参考取最大相似度作约束；音频权重不适用。</p>
        <p v-if="audit.e?.audio_rule==='bridge'" class="recommendation-audit-note">此项通过两跳关联：正参考关联占65%，桥接关联占35%，另有桥接扣分。</p>
        <p v-if="audit.effective!=='change' && audit.p.direction_keys?.length && audit.p.direction_strength!=null" class="recommendation-audit-note">弱核心强度 {{n(audit.p.direction_strength)}}，仅作有界奖励。</p>
        <p v-if="audit.effective==='change'" class="recommendation-audit-note">旧方向和标签用于避让，本步不使用弱核心正向奖励。</p>
        <h3>排序分的加减</h3><div class="recommendation-audit-scores"><div v-for="s in audit.scoreRows" :key="s.key"><span>{{s.label}}</span><b :class="{negative:s.value<0,positive:s.value>0}">{{signed(s.value)}}</b></div><div class="total"><span>最终排序分</span><b>{{n(audit.s.suitability)}}</b></div></div>
        <p class="recommendation-audit-note">排序分和模型相似度均不代表准确率。换向概率另含分组平衡与历史纠偏。</p>
        <details><summary>标签对照</summary><p v-if="!audit.e?.tag_comparisons">此记录未保存当时使用的标签。</p><p v-else-if="!audit.e.tag_comparisons.length">没有可比较的有效标签。</p>
          <div v-for="t in audit.e?.tag_comparisons || []" :key="t.kind" class="recommendation-audit-tag"><b>{{kind(t.kind)}} · {{n(t.similarity)}} · {{t.used?'参与':'未加票'}}</b><p>候选：{{tags(t.target)}}</p><p>{{audit.name(t.reference)}}：{{tags(t.reference_tags)}}</p><small v-if="t.kind==='mood'&&!t.used&&audit.e.mood_vote_excluded">MuQ已参与主音频评分，同源氛围不重复加票。</small><small v-if="t.target_count>4||t.reference_count>4">展示各方最强四项，计算使用完整有效标签。</small></div>
        </details>
        <h3>纠偏负例 <span>取最大惩罚，不逐项累加</span></h3>
        <p v-if="audit.negatives===null">旧记录未保存负例明细。</p><p v-else-if="!audit.negatives.length">本次没有使用情境负例。</p>
        <table v-else class="recommendation-audit-table"><thead><tr><th>否定歌曲 / 对应正参考</th><th>像负例</th><th>像正参考</th><th>惩罚</th></tr></thead><tbody><tr v-for="(r,i) in audit.negatives" :key="i"><td><b>{{r.name}}</b><small>{{r.positive || '无正参考，无法作相对惩罚'}}<span v-if="r.model"> · {{r.model}}</span></small></td><td>{{n(r.similarity)}}</td><td>{{n(r.positive_similarity)}}</td><td>{{n(r.penalty)}}</td></tr></tbody></table>
        <h3>旧方向记忆 <span>取最大避返惩罚</span></h3>
        <p v-if="audit.memories===null">旧记录未保存记忆明细。</p><p v-else-if="!audit.memories.length">没有旧方向记忆。</p>
        <table v-else class="recommendation-audit-table"><thead><tr><th>旧方向参考</th><th>剩余强度</th><th>相似度</th><th>惩罚</th></tr></thead><tbody><tr v-for="r in audit.memories" :key="r.index"><td>{{r.names}}</td><td>{{n(r.strength)}}</td><td>{{n(r.similarity)}}</td><td>{{n(r.penalty)}}</td></tr></tbody></table>
        <details><summary>硬约束与已排除歌曲</summary><h4>本方向明确拒绝</h4><p>{{audit.p.blocked_keys?.map(audit.name).join('、') || (audit.p.blocked_keys?'无':'旧记录未保存完整清单')}}</p><h4>旧方向短期硬边界</h4><p>{{audit.p.excluded_keys?.map(audit.name).join('、') || (audit.p.excluded_keys?'无':'未记录')}}</p><p class="recommendation-audit-note">有可比MuQ时上限 {{n(audit.p.old_direction_muq_ceiling)}}，缺MuQ参考用MERT上限 {{n(audit.p.old_direction_mert_ceiling)}}。与长期衰减记忆分开。</p></details>
        <details><summary>筛选、降档与重听控制</summary><dl class="recommendation-audit-facts"><div><dt>降档路径</dt><dd>{{audit.p.adjacent_mert_evaluated_floors?.join(' → ') || '未记录 / 不适用'}}</dd></div><div><dt>短期重听概率</dt><dd>{{pct(audit.p.repeat_mass)}}</dd></div><div><dt>近20次重听</dt><dd>{{audit.p.recent_repeat_count ?? '未记录'}} / {{audit.p.repeat_limit ?? '未记录'}}</dd></div><div><dt>预算放宽</dt><dd>{{audit.p.repeat_budget_relaxed===true?'是，仅余合格旧歌':audit.p.repeat_budget_relaxed===false?'否':'未记录'}}</dd></div><div><dt>退化原因</dt><dd>{{audit.p.degradation?.join(' / ') || '无记录'}}</dd></div><div><dt>换向出口估计</dt><dd>{{audit.s.next_available ?? '未记录 / 不适用'}}</dd></div></dl>
        <table v-if="audit.p.stage_counts?.length" class="recommendation-audit-table"><thead><tr><th>层</th><th>准入</th><th>质量合格</th><th>新歌</th></tr></thead><tbody><tr v-for="(r,i) in audit.p.stage_counts" :key="i"><td>{{stage(r.stage)}} {{r.expansion || ''}}</td><td>{{r.eligible}}</td><td>{{r.qualified}}</td><td>{{r.fresh}}</td></tr></tbody></table>
        <div v-for="r in audit.p.gate_counts || []" :key="r.gate" class="recommendation-audit-gate"><span>{{r.gate}}</span><b>{{r.count}}</b></div></details>
        <details><summary>候选样本 · {{audit.candidateSample.length}} / {{audit.d.candidateCount ?? '?'}}</summary><p class="recommendation-audit-note">只保存前五项，未列出的候选不能据此判断不存在。</p><table class="recommendation-audit-table"><thead><tr><th>歌曲</th><th>MERT</th><th>排序分</th><th>概率</th></tr></thead><tbody><tr v-for="(r,i) in audit.candidateSample" :key="i"><td>{{r.rank}} · {{r.name}}</td><td>{{n(r.scores.sim)}}</td><td>{{n(r.scores.suitability)}}</td><td>{{pct(r.scores.probability)}}</td></tr></tbody></table></details>
        <details><summary>原始决策</summary><pre>{{audit.raw}}</pre></details>
      </template></section>`
  };
})(typeof window==='object'?window:globalThis);
