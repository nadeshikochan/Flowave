(function (root) {
  root.FlowaveSearchInput = {
    inheritAttrs: false,
    props: { modelValue: { type: String, default: "" }, resetRevision: { type: Number, default: 0 } },
    emits: ["commit", "activity"],
    data() { return { draft: this.modelValue, composing: false, commitTimer: null }; },
    watch: {
      resetRevision() { this.reset(); },
      modelValue(value) {
        if (value === this.draft) return;
        clearTimeout(this.commitTimer);
        this.commitTimer = null;
        this.draft = value;
      },
    },
    beforeUnmount() { clearTimeout(this.commitTimer); },
    methods: {
      reset() {
        clearTimeout(this.commitTimer);
        this.commitTimer = null;
        this.composing = false;
        this.draft = this.modelValue;
      },
      focus() { this.$refs.input?.focus(); },
      input(event) {
        this.draft = event.target.value;
        this.$emit("activity", this.composing || event.isComposing === true);
        clearTimeout(this.commitTimer);
        if (this.composing || event.isComposing) return;
        this.commitTimer = setTimeout(() => {
          this.commitTimer = null;
          this.$emit("commit", this.draft);
        }, 120);
      },
      compositionStart() {
        this.composing = true;
        clearTimeout(this.commitTimer);
        this.$emit("activity", true);
      },
      compositionEnd(event) { this.composing = false; this.input(event); },
    },
    template: `<input ref="input" v-bind="$attrs" :value="draft" @input="input" @compositionstart="compositionStart" @compositionend="compositionEnd">`,
  };
})(window);
