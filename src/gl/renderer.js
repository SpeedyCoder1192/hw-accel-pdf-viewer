// WebGL2 compositor.
//
// Everything the user sees is a textured quad drawn by the GPU: page shadows are
// an analytic SDF in the fragment shader, page bodies are cached tile textures,
// and dark mode is a colour transform on the way out. Panning and zooming never
// touch a pixel on the CPU -- they only change the uniforms feeding these quads,
// which is why the camera stays smooth while rasterization is still catching up.

const VERT = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;   // x, y, w, h in device pixels
uniform vec4 uUV;     // u0, v0, u1, v1
uniform vec2 uRes;    // canvas size in device pixels
out vec2 vUV;
out vec2 vPx;
void main() {
  vec2 p = uRect.xy + aPos * uRect.zw;
  vPx = p;
  vUV = mix(uUV.xy, uUV.zw, aPos);
  vec2 clip = (p / uRes) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
in vec2 vPx;
uniform sampler2D uTex;
uniform int uMode;      // 0 = texture, 1 = solid, 2 = drop shadow
uniform vec4 uColor;
uniform vec4 uBox;      // shadow caster rect, device pixels
uniform float uBlur;
uniform float uInvert;  // 0..1 dark-mode blend
uniform float uAlpha;
out vec4 frag;

// Signed distance to an axis-aligned box centred on the origin.
float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

void main() {
  if (uMode == 1) {
    frag = vec4(uColor.rgb, uColor.a * uAlpha);
    return;
  }
  if (uMode == 2) {
    vec2 halfSize = uBox.zw * 0.5;
    float d = sdBox(vPx - (uBox.xy + halfSize), halfSize);
    float a = 1.0 - smoothstep(-uBlur * 0.25, uBlur, d);
    frag = vec4(uColor.rgb, uColor.a * a * a * uAlpha);
    return;
  }
  vec4 t = texture(uTex, vUV);
  // Matches pdf.js's "invert(93%) hue-rotate(180deg)": inverting alone turns
  // coloured artwork into its ugly complement, the hue rotation puts it back.
  vec3 inv = mix(t.rgb, vec3(1.0) - t.rgb, 0.93);
  float luma = dot(inv, vec3(0.299, 0.587, 0.114));
  vec3 dark = vec3(2.0 * luma) - inv;
  frag = vec4(mix(t.rgb, dark, uInvert), t.a * uAlpha);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

export const UV_FULL = [0, 0, 1, 1];

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');

    this.canvas = canvas;
    this.gl = gl;
    this.width = 0;
    this.height = 0;
    this.invert = 0;
    this.contextLost = false;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`);
    }
    this.prog = prog;
    this.u = {};
    const names = ['uRect', 'uUV', 'uRes', 'uTex', 'uMode', 'uColor', 'uBox', 'uBlur', 'uInvert', 'uAlpha'];
    for (const name of names) this.u[name] = gl.getUniformLocation(prog, name);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.vao = vao;

    gl.useProgram(prog);
    gl.uniform1i(this.u.uTex, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this.aniso = aniso
      ? { ext: aniso, max: Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) }
      : null;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.adapter = String(
      (dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER)
    );

    this.drawCalls = 0;
    this.onContextLost = null;
    this._lost = (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.onContextLost?.();
    };
    canvas.addEventListener('webglcontextlost', this._lost);
  }

  resize(cssWidth, cssHeight, dpr) {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (w === this.width && h === this.height) return false;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.gl.viewport(0, 0, w, h);
    return true;
  }

  /** Upload an ImageBitmap and return a mipmapped, clamped texture. */
  createTexture(bitmap) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    // Mipmaps are what make zooming *out* past a tile's native scale look right;
    // without them minification aliases into shimmering garbage.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.aniso) {
      gl.texParameterf(gl.TEXTURE_2D, this.aniso.ext.TEXTURE_MAX_ANISOTROPY_EXT, this.aniso.max);
    }
    return tex;
  }

  deleteTexture(tex) {
    this.gl.deleteTexture(tex);
  }

  beginFrame(bg) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.useProgram(this.prog);
    gl.uniform2f(this.u.uRes, this.width, this.height);
    gl.uniform1f(this.u.uInvert, this.invert);
    gl.uniform1f(this.u.uAlpha, 1);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawCalls = 0;
  }

  _draw() {
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
    this.drawCalls++;
  }

  drawRect(x, y, w, h, color, alpha = 1) {
    const gl = this.gl;
    gl.uniform1i(this.u.uMode, 1);
    gl.uniform4f(this.u.uRect, x, y, w, h);
    gl.uniform4f(this.u.uColor, color[0], color[1], color[2], color[3] === undefined ? 1 : color[3]);
    gl.uniform1f(this.u.uAlpha, alpha);
    this._draw();
  }

  drawShadow(x, y, w, h, blur, color) {
    const gl = this.gl;
    gl.uniform1i(this.u.uMode, 2);
    gl.uniform4f(this.u.uRect, x - blur, y - blur, w + blur * 2, h + blur * 2);
    gl.uniform4f(this.u.uBox, x, y, w, h);
    gl.uniform1f(this.u.uBlur, blur);
    gl.uniform4f(this.u.uColor, color[0], color[1], color[2], color[3] === undefined ? 1 : color[3]);
    gl.uniform1f(this.u.uAlpha, 1);
    this._draw();
  }

  drawTexture(tex, x, y, w, h, uv = UV_FULL, alpha = 1) {
    const gl = this.gl;
    gl.uniform1i(this.u.uMode, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform4f(this.u.uRect, x, y, w, h);
    gl.uniform4f(this.u.uUV, uv[0], uv[1], uv[2], uv[3]);
    gl.uniform1f(this.u.uAlpha, alpha);
    this._draw();
  }

  destroy() {
    this.canvas.removeEventListener('webglcontextlost', this._lost);
    const gl = this.gl;
    gl.deleteProgram(this.prog);
    gl.deleteVertexArray(this.vao);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
