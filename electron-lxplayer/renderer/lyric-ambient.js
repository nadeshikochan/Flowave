// Independent ambient renderer. It never reads audio or changes playback state.
(function (root) {
  "use strict";
  const vertex = `attribute vec2 p;varying vec2 uv;void main(){uv=p*.5+.5;gl_Position=vec4(p,0.,1.);}`;
  const fragment = `precision mediump float;
    varying vec2 uv;uniform sampler2D oldCover;uniform sampler2D cover;
    uniform float time;uniform float blend;
    vec3 field(sampler2D tex,vec2 q){
      vec2 p1=.5+.46*vec2(sin(time*.86),cos(time*.63));
      vec2 p2=.5+.46*vec2(cos(time*.71+2.),sin(time*.81+1.));
      vec2 p3=.5+.46*vec2(sin(time*.67+4.),cos(time*.91+2.));
      vec2 p4=.5+.46*vec2(cos(time*.93+1.),sin(time*.57+4.));
      vec4 w=exp(-7.*vec4(dot(q-p1,q-p1),dot(q-p2,q-p2),dot(q-p3,q-p3),dot(q-p4,q-p4)));
      vec3 colors=texture2D(tex,vec2(.18,.24)).rgb*w.x+texture2D(tex,vec2(.8,.3)).rgb*w.y
        +texture2D(tex,vec2(.4,.82)).rgb*w.z+texture2D(tex,vec2(.82,.8)).rgb*w.w;
      colors/=max(.001,w.x+w.y+w.z+w.w);
      vec2 drift=vec2(sin(time*.72+q.y*4.),cos(time*.63+q.x*4.))*.26;
      vec3 detail=texture2D(tex,clamp(q*.7+.15+drift,0.,1.)).rgb;
      return mix(colors,detail,.2)*(.90+.14*sin(time*.95+q.x*3.4+q.y*2.6));
    }
    void main(){vec3 c=mix(field(oldCover,uv),field(cover,uv),blend);
      c=pow(max(c,vec3(.001)),vec3(.88));
      float lum=dot(c,vec3(.2126,.7152,.0722));
      c=mix(vec3(lum),c,1.18);
      c*=.68; c=mix(c,vec3(.035,.025,.085),.12);
      gl_FragColor=vec4(c,1.);}`;

  class LyricAmbient {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.state = { visible: false, playing: false, enabled: true, speed: 1 };
      this.generation = 0; this.phase = 0; this.motionPhase = 0; this.frames = 0; this.lastFrame = 0;
      this.pendingImage = null; this.source = ""; this.destroyed = false; this.failed = false;
      this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
      this.onVisibility = () => this.sync();
      this.onResize = () => { this.resize(); this.draw(); };
      this.onLost = event => { event.preventDefault(); this.fail(); };
      document.addEventListener("visibilitychange", this.onVisibility);
      this.reduced.addEventListener("change", this.onVisibility);
      window.addEventListener("resize", this.onResize);
      canvas.addEventListener("webglcontextlost", this.onLost);
      try {
        const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, powerPreference: "low-power" });
        if (!gl) throw new Error("unavailable");
        this.gl = gl;
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        const renderer = this.renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "";
        if (!options.allowSoftware && /swiftshader|llvmpipe|software|basic render/i.test(renderer)) throw new Error("software renderer");
        this.shaders = [];
        const compile = (type, code) => {
          const shader = gl.createShader(type); gl.shaderSource(shader, code); gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); throw new Error("shader"); }
          this.shaders.push(shader); return shader;
        };
        const vs = compile(gl.VERTEX_SHADER, vertex), fs = compile(gl.FRAGMENT_SHADER, fragment);
        const program = this.program = gl.createProgram();
        gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
        gl.deleteShader(vs); gl.deleteShader(fs); this.shaders=[];
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("program");
        gl.useProgram(program);
        this.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
        const position = gl.getAttribLocation(program, "p"); gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
        this.uniforms = Object.fromEntries(["oldCover","cover","time","blend"].map(key => [key, gl.getUniformLocation(program,key)]));
        this.textures = [this.texture(), this.texture()]; this.ready = false;
        this.resize();
      } catch (_) { this.fail(); }
    }
    texture() {
      const gl = this.gl, tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([35,32,60,255]));
      return tex;
    }
    resize() {
      const r = this.canvas.getBoundingClientRect();
      const scale = Math.min(1, 768 / Math.max(1,r.width,r.height));
      this.canvas.width = Math.max(1,Math.round(r.width*scale));
      this.canvas.height = Math.max(1,Math.round(r.height*scale));
      this.gl?.viewport(0,0,this.canvas.width,this.canvas.height);
    }
    update(state) {
      if (this.destroyed) return;
      Object.assign(this.state,state);
      if (this.state.visible && typeof state.source === "string" && state.source !== this.source) this.load(state.source);
      this.sync();
    }
    load(source) {
      this.source = source; const generation = ++this.generation;
      if (this.pendingImage) { this.pendingImage.onload = this.pendingImage.onerror = null; this.pendingImage.src = ""; }
      this.pendingImage = null;
      if (!source || this.failed) { this.canvas.dataset.ready = "false"; this.ready = false; return; }
      const img = this.pendingImage = new Image(); img.crossOrigin = "anonymous";
      img.onload = () => {
        if (this.destroyed || generation !== this.generation) return;
        this.pendingImage = null;
        try {
          // Smooth on a tiny surface once per cover, never blur a full-size image each frame.
          const tiny = document.createElement("canvas"); tiny.width = tiny.height = 24;
          tiny.getContext("2d").drawImage(img,0,0,24,24);
          const smooth = document.createElement("canvas"); smooth.width = smooth.height = 256;
          const ctx = smooth.getContext("2d"); ctx.filter = "blur(18px)";
          ctx.drawImage(tiny,-32,-32,320,320);
          // Check taint before touching GL; a failed remote cover retains the CSS fallback.
          ctx.getImageData(0,0,1,1);
          const gl = this.gl;
          [this.textures[0],this.textures[1]] = [this.textures[1],this.textures[0]];
          gl.bindTexture(gl.TEXTURE_2D,this.textures[1]);
          gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,smooth);
          this.transitionAt = this.phase; this.transition = this.ready;
          if (!this.ready) {
            gl.bindTexture(gl.TEXTURE_2D,this.textures[0]);
            gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,smooth);
          }
          this.ready = true; this.canvas.dataset.ready = "true"; this.draw(); this.sync();
        } catch (_) { this.ready = false; this.canvas.dataset.ready = "false"; this.sync(); }
      };
      img.onerror = () => { if(generation === this.generation) { this.pendingImage=null; this.ready=false; this.canvas.dataset.ready="false"; this.sync(); } };
      img.src = source;
    }
    running() { return !this.destroyed && !this.failed && this.ready && this.state.visible && !document.hidden && this.state.playing && this.state.enabled && !this.reduced.matches; }
    sync() {
      cancelAnimationFrame(this.raf); this.raf = 0; this.lastFrame = 0;
      if (!this.running()) { if(this.transition) this.transition=false; if(this.state.visible&&!document.hidden)this.draw(); return; }
      const tick = now => {
        this.raf = 0; if(!this.running()) return;
        if(!this.lastFrame) this.lastFrame=now;
        const elapsed = now-this.lastFrame;
        if(elapsed >= 1000/30) {
          const dt=Math.min(elapsed,100)/1000;
          this.phase += dt; this.motionPhase += dt*Math.max(.4,Math.min(2.4,Number(this.state.speed)||1));
          this.lastFrame=now; this.draw();
        }
        this.raf=requestAnimationFrame(tick);
      };
      this.raf=requestAnimationFrame(tick);
    }
    draw() {
      if(!this.ready || this.failed || this.destroyed) return;
      const gl=this.gl; gl.useProgram(this.program);
      this.textures.forEach((tex,i)=>{gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,tex);});
      gl.uniform1i(this.uniforms.oldCover,0); gl.uniform1i(this.uniforms.cover,1);
      gl.uniform1f(this.uniforms.time,this.motionPhase);
      const blend=this.transition?Math.min(1,(this.phase-this.transitionAt)/1.2):1;
      gl.uniform1f(this.uniforms.blend,blend); if(blend>=1)this.transition=false;
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4); this.frames++;
    }
    fail() { this.failed=true; this.ready=false; this.canvas.dataset.ready="false"; cancelAnimationFrame(this.raf); this.raf=0; this.release(); }
    release() {
      const gl=this.gl; if(!gl)return;
      (this.shaders||[]).forEach(shader=>gl.deleteShader(shader)); this.shaders=[];
      (this.textures||[]).forEach(tex=>gl.deleteTexture(tex)); this.textures=[];
      if(this.buffer)gl.deleteBuffer(this.buffer); if(this.program)gl.deleteProgram(this.program);
      this.buffer=null;this.program=null;
    }
    destroy() {
      this.destroyed=true; ++this.generation; cancelAnimationFrame(this.raf); this.raf=0;
      if(this.pendingImage){this.pendingImage.onload=this.pendingImage.onerror=null;this.pendingImage.src="";this.pendingImage=null;}
      document.removeEventListener("visibilitychange",this.onVisibility);
      this.reduced.removeEventListener("change",this.onVisibility);
      window.removeEventListener("resize",this.onResize);
      this.canvas.removeEventListener("webglcontextlost",this.onLost); this.release();
    }
  }
  root.LyricAmbient = LyricAmbient;
})(window);
