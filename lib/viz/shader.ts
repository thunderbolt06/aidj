import type { VizFrame } from "@/lib/viz/types";

/**
 * Minimal WebGL fragment-shader runner , the "shader-art" path.
 *
 * A shader template (built-in OR user/AI authored) only needs to define
 *   void mainImage(out vec4 fragColor, in vec2 fragCoord)
 * Shadertoy-style. We prepend a prelude exposing the audio as uniforms and a
 * spectrum texture, append a main() wrapper, and run it over a full-screen
 * triangle. This is the "add your own framework" contract: paste a body, get a
 * real-time, audio-reactive music video.
 */

const VERT = `
attribute vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
`;

/** Documented uniform contract , keep in sync with the AI route's prompt. */
export const SHADER_PRELUDE = `
precision highp float;
uniform vec2  iResolution;   // pixels
uniform float iTime;         // seconds (already scaled by speed)
uniform float iLevel;        // 0..1 overall loudness
uniform float iLow;          // 0..1 bass energy
uniform float iMid;          // 0..1 mid energy
uniform float iHigh;         // 0..1 treble energy
uniform float iBeat;         // 0..1 phase within the current beat
uniform float iBeatPulse;    // 0..1, snaps to 1 on each beat then eases down
uniform float iBar;          // 0..1 phase within the 4-beat bar
uniform float iOnset;        // 0..1 transient / kick detector
uniform float iHue;          // 0..1 base hue (from the song key)
uniform float iIntensity;    // reactivity multiplier (~0..2)
uniform float iSpeed;        // motion multiplier (~0..2)
uniform vec3  iKeyColor;     // rgb anchor color from the song key
uniform float iChroma[12];   // 12 pitch-class energies , the live chord
uniform sampler2D iSpectrum; // row .25 = FFT, row .75 = waveform; x in 0..1

vec3 hsv2rgb(vec3 c){
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
float fft(float x){ return texture2D(iSpectrum, vec2(clamp(x,0.0,1.0), 0.25)).x; }
float wave(float x){ return texture2D(iSpectrum, vec2(clamp(x,0.0,1.0), 0.75)).x; }
`;

const MAIN_WRAP = `
void main(){
  vec4 c = vec4(0.0);
  mainImage(c, gl_FragCoord.xy);
  gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0), 1.0);
}
`;

const TEX_W = 256;

export class ShaderRenderer {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram | null = null;
  private locs: Record<string, WebGLUniformLocation | null> = {};
  private tex: WebGLTexture;
  private texData = new Uint8Array(TEX_W * 2);
  private buf: WebGLBuffer;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
    if (!gl) throw new Error("WebGL not available");
    this.gl = gl;

    this.buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, TEX_W, 2, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, this.texData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || "shader compile error";
      gl.deleteShader(sh);
      throw new Error(log);
    }
    return sh;
  }

  /** Compile a new fragment body. Returns an error string, or null on success. */
  setFragment(body: string): string | null {
    const gl = this.gl;
    const full = `${SHADER_PRELUDE}\n${body}\n${MAIN_WRAP}`;
    try {
      const vs = this.compile(gl.VERTEX_SHADER, VERT);
      const fs = this.compile(gl.FRAGMENT_SHADER, full);
      const prog = gl.createProgram()!;
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog) || "link error";
        gl.deleteProgram(prog);
        return log;
      }
      if (this.program) gl.deleteProgram(this.program);
      this.program = prog;
      this.locs = {};
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  private loc(name: string): WebGLUniformLocation | null {
    if (!(name in this.locs)) this.locs[name] = this.gl.getUniformLocation(this.program!, name);
    return this.locs[name];
  }

  /** Hex color → normalized rgb for iKeyColor; default from hue if absent. */
  private keyColor(f: VizFrame): [number, number, number] {
    const pal = f.params.palette;
    if (pal && pal[0]) {
      const m = /^#?([0-9a-f]{6})$/i.exec(pal[0]);
      if (m) {
        const n = parseInt(m[1], 16);
        return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
      }
    }
    // HSV(keyHue, 0.7, 1) → rgb
    const h = f.key.hue / 360;
    const r = Math.abs(((h * 6 + 0) % 6) - 3) - 1;
    const g = Math.abs(((h * 6 + 4) % 6) - 3) - 1;
    const b = Math.abs(((h * 6 + 2) % 6) - 3) - 1;
    const clamp = (x: number) => Math.min(1, Math.max(0, x));
    const s = 0.7;
    return [clamp(r) * s + (1 - s), clamp(g) * s + (1 - s), clamp(b) * s + (1 - s)];
  }

  render(f: VizFrame) {
    const gl = this.gl;
    if (!this.program) return;
    const cw = Math.floor(f.w * f.dpr);
    const ch = Math.floor(f.h * f.dpr);
    if (gl.canvas.width !== cw || gl.canvas.height !== ch) {
      gl.canvas.width = cw;
      gl.canvas.height = ch;
    }
    gl.viewport(0, 0, cw, ch);
    gl.useProgram(this.program);

    // update spectrum/waveform texture (downsampled to TEX_W)
    const spec = f.spectrum;
    const wave = f.waveform;
    const usable = Math.min(spec.length, 720); // ~0..15kHz
    for (let x = 0; x < TEX_W; x++) {
      this.texData[x] = spec[Math.min(spec.length - 1, Math.floor((x / TEX_W) * usable))];
      this.texData[TEX_W + x] = wave[Math.min(wave.length - 1, Math.floor((x / TEX_W) * wave.length))];
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_W, 2, gl.LUMINANCE, gl.UNSIGNED_BYTE, this.texData);
    gl.uniform1i(this.loc("iSpectrum"), 0);

    const p = f.params;
    gl.uniform2f(this.loc("iResolution"), cw, ch);
    gl.uniform1f(this.loc("iTime"), f.clock * p.speed);
    gl.uniform1f(this.loc("iLevel"), f.level);
    gl.uniform1f(this.loc("iLow"), f.low);
    gl.uniform1f(this.loc("iMid"), f.mid);
    gl.uniform1f(this.loc("iHigh"), f.high);
    gl.uniform1f(this.loc("iBeat"), f.beat.beatPhase);
    gl.uniform1f(this.loc("iBeatPulse"), f.beat.hit);
    gl.uniform1f(this.loc("iBar"), f.beat.barPhase);
    gl.uniform1f(this.loc("iOnset"), f.onset);
    gl.uniform1f(this.loc("iHue"), f.key.hue / 360);
    gl.uniform1f(this.loc("iIntensity"), p.intensity);
    gl.uniform1f(this.loc("iSpeed"), p.speed);
    gl.uniform3fv(this.loc("iKeyColor"), this.keyColor(f));
    gl.uniform1fv(this.loc("iChroma[0]"), f.chroma);

    const aPos = gl.getAttribLocation(this.program, "aPos");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    const gl = this.gl;
    if (this.program) gl.deleteProgram(this.program);
    gl.deleteBuffer(this.buf);
    gl.deleteTexture(this.tex);
  }
}
