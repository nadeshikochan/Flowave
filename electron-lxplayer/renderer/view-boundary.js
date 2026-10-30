(function (root) {
  // 保留已访问页面的 DOM/滚动位置；隐藏后不再执行其模板与列表方法。
  root.FlowaveViewBoundary = {
    inheritAttrs: false,
    props: { active: { type: Boolean, default: false } },
    render() {
      if (this.active || !this._retainedNodes) this._retainedNodes = this.$slots.default?.() || [];
      return root.Vue.h("div", {
        ...this.$attrs,
        style: [this.$attrs.style, { display: this.active ? undefined : "none" }],
      }, this._retainedNodes);
    },
  };
})(window);
