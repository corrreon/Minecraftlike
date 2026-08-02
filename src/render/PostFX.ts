/**
 * Chaîne de post-traitement maison (aucune dépendance aux addons Three).
 *
 * scène HDR → extraction des hautes lumières → flou séparable multi-échelle
 * → composition (bloom, rayons crépusculaires, sous-marin, vignette, tonemap)
 * → anticrénelage FXAA → écran.
 */

import {
  Camera,
  ClampToEdgeWrapping,
  GLSL3,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NoToneMapping,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import type { EnvUniforms } from './env';

const QUAD_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const BRIGHT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform float uThreshold;
uniform float uSoft;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
void main() {
  vec3 c = texture(tSrc, vUv).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float knee = max(uSoft, 1e-4);
  float soft = clamp((lum - uThreshold + knee) / (2.0 * knee), 0.0, 1.0);
  float w = max(soft * soft * knee, max(lum - uThreshold, 0.0)) / max(lum, 1e-4);
  fragColor = vec4(c * w, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uDirection;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
void main() {
  // Noyau gaussien 9 taps exploitant le filtrage linéaire (5 échantillons).
  vec2 off1 = uDirection * 1.3846153846;
  vec2 off2 = uDirection * 3.2307692308;
  vec3 c = texture(tSrc, vUv).rgb * 0.2270270270;
  c += texture(tSrc, vUv + off1).rgb * 0.3162162162;
  c += texture(tSrc, vUv - off1).rgb * 0.3162162162;
  c += texture(tSrc, vUv + off2).rgb * 0.0702702703;
  c += texture(tSrc, vUv - off2).rgb * 0.0702702703;
  fragColor = vec4(c, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tBloom0;
uniform sampler2D tBloom1;
uniform sampler2D tBloom2;
uniform float uBloomStrength;
uniform vec2 uSunScreen;
uniform float uSunVisible;
uniform float uGodRays;
uniform vec3 uSunColor;
uniform float uUnderwater;
uniform float uTime;
uniform float uExposure;
uniform float uVignette;
uniform float uSaturation;
uniform float uDamage;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// La chaîne travaille en linéaire ; l'écriture finale doit être encodée sRGB.
vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0031308)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

void main() {
  vec2 uv = vUv;

  // Ondulation plein écran sous l'eau.
  if (uUnderwater > 0.5) {
    uv += vec2(sin(uv.y * 26.0 + uTime * 1.7), cos(uv.x * 22.0 + uTime * 1.3)) * 0.0022;
  }

  vec3 color = texture(tScene, uv).rgb;

  vec3 bloom = texture(tBloom0, uv).rgb * 0.5
             + texture(tBloom1, uv).rgb * 0.32
             + texture(tBloom2, uv).rgb * 0.18;
  color += bloom * uBloomStrength;

  // Rayons crépusculaires : accumulation radiale depuis le soleil projeté.
  if (uSunVisible > 0.001 && uGodRays > 0.001) {
    vec2 delta = (uv - uSunScreen) * (1.0 / 24.0) * 0.85;
    vec2 sampPos = uv;
    float decay = 1.0;
    vec3 rays = vec3(0.0);
    for (int i = 0; i < 24; i++) {
      sampPos -= delta;
      rays += texture(tBloom0, sampPos).rgb * decay;
      decay *= 0.94;
    }
    rays /= 24.0;
    color += rays * uSunColor * uGodRays * uSunVisible * 1.9;
  }

  color *= uExposure;
  color = aces(color);

  // Étalonnage : saturation puis léger contraste en S.
  float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(lum), color, uSaturation);
  color = color * color * (3.0 - 2.0 * color) * 0.28 + color * 0.72;

  if (uUnderwater > 0.5) color = mix(color, color * vec3(0.42, 0.82, 1.0), 0.65);

  // Vignette.
  vec2 v = (vUv - 0.5) * 2.0;
  float vig = 1.0 - dot(v, v) * uVignette * 0.34;
  color *= clamp(vig, 0.0, 1.0);

  // Rougeoiement de dégâts.
  if (uDamage > 0.001) {
    float edge = smoothstep(0.25, 1.25, length(v));
    color = mix(color, vec3(0.55, 0.02, 0.02), edge * uDamage * 0.85);
  }

  fragColor = vec4(linearToSrgb(color), 1.0);
}
`;

const FXAA_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec3 rgbNW = texture(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 rgbNE = texture(tSrc, vUv + vec2( 1.0, -1.0) * uTexel).rgb;
  vec3 rgbSW = texture(tSrc, vUv + vec2(-1.0,  1.0) * uTexel).rgb;
  vec3 rgbSE = texture(tSrc, vUv + vec2( 1.0,  1.0) * uTexel).rgb;
  vec3 rgbM  = texture(tSrc, vUv).rgb;

  float lNW = lum(rgbNW), lNE = lum(rgbNE), lSW = lum(rgbSW), lSE = lum(rgbSE), lM = lum(rgbM);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcpDir = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpDir, -8.0, 8.0) * uTexel;

  vec3 rgbA = 0.5 * (texture(tSrc, vUv + dir * (1.0 / 3.0 - 0.5)).rgb
                   + texture(tSrc, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture(tSrc, vUv - dir * 0.5).rgb
                                 + texture(tSrc, vUv + dir * 0.5).rgb);

  float lB = lum(rgbB);
  fragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}
`;

interface Pass {
  material: ShaderMaterial;
}

function makePass(fragment: string, uniforms: Record<string, { value: unknown }>): Pass {
  return {
    material: new ShaderMaterial({
      glslVersion: GLSL3,
      uniforms: uniforms as never,
      vertexShader: QUAD_VERT,
      fragmentShader: fragment,
      depthTest: false,
      depthWrite: false,
    }),
  };
}

export interface PostQuality {
  bloom: boolean;
  godRays: boolean;
  fxaa: boolean;
  bloomStrength: number;
  exposure: number;
  saturation: number;
  vignette: number;
}

export class PostFX {
  private renderer: WebGLRenderer;
  private quadScene = new Scene();
  private quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: Mesh;

  scene!: WebGLRenderTarget;
  private bright!: WebGLRenderTarget;
  private blurA: WebGLRenderTarget[] = [];
  private blurB: WebGLRenderTarget[] = [];
  private ldr!: WebGLRenderTarget;

  private brightPass: Pass;
  private blurPass: Pass;
  private compositePass: Pass;
  private fxaaPass: Pass;

  private size = new Vector2(1, 1);
  private pixelRatio = 1;

  quality: PostQuality = {
    bloom: true,
    godRays: true,
    fxaa: true,
    bloomStrength: 0.55,
    exposure: 1.05,
    saturation: 1.08,
    vignette: 1,
  };

  /** Intensité du flash rouge de dégâts, décrémentée par le jeu. */
  damage = 0;

  constructor(renderer: WebGLRenderer, private env: EnvUniforms) {
    this.renderer = renderer;
    this.quad = new Mesh(new PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.brightPass = makePass(BRIGHT_FRAG, {
      tSrc: { value: null },
      uThreshold: { value: 1.05 },
      uSoft: { value: 0.45 },
    });
    this.blurPass = makePass(BLUR_FRAG, {
      tSrc: { value: null },
      uDirection: { value: new Vector2() },
    });
    this.compositePass = makePass(COMPOSITE_FRAG, {
      tScene: { value: null },
      tBloom0: { value: null },
      tBloom1: { value: null },
      tBloom2: { value: null },
      uBloomStrength: { value: 0.55 },
      uSunScreen: { value: new Vector2(0.5, 0.5) },
      uSunVisible: { value: 0 },
      uGodRays: { value: 0.5 },
      uSunColor: { value: env.uSunColor.value },
      uUnderwater: { value: 0 },
      uTime: { value: 0 },
      uExposure: { value: 1.05 },
      uVignette: { value: 1 },
      uSaturation: { value: 1.08 },
      uDamage: { value: 0 },
    });
    this.fxaaPass = makePass(FXAA_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new Vector2() },
    });

    this.allocate(1, 1, 1);
  }

  private makeTarget(w: number, h: number, float: boolean, depth = false): WebGLRenderTarget {
    return new WebGLRenderTarget(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)), {
      format: RGBAFormat,
      type: float ? HalfFloatType : UnsignedByteType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: depth,
      stencilBuffer: false,
    });
  }

  private allocate(width: number, height: number, pixelRatio: number): void {
    this.dispose();
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));
    this.scene = this.makeTarget(w, h, true, true);
    this.scene.texture.name = 'sceneHDR';
    this.ldr = this.makeTarget(w, h, false);
    this.bright = this.makeTarget(w >> 1, h >> 1, true);
    this.blurA = [];
    this.blurB = [];
    for (let i = 0; i < 3; i++) {
      const s = 1 << (i + 1);
      this.blurA.push(this.makeTarget(w / s, h / s, true));
      this.blurB.push(this.makeTarget(w / s, h / s, true));
    }
    this.size.set(w, h);
    this.pixelRatio = pixelRatio;
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));
    if (w === this.size.x && h === this.size.y && pixelRatio === this.pixelRatio) return;
    this.allocate(width, height, pixelRatio);
  }

  /** Cible dans laquelle la scène doit être rendue. */
  get renderTarget(): WebGLRenderTarget {
    return this.scene;
  }

  private blit(pass: Pass, target: WebGLRenderTarget | null): void {
    this.quad.material = pass.material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  /**
   * Exécute la chaîne complète. `sunScreen` est la position projetée du soleil
   * en coordonnées écran normalisées, `sunVisible` son facteur de visibilité.
   */
  render(sunScreen: Vector2, sunVisible: number): void {
    const q = this.quality;
    const prevTone = this.renderer.toneMapping;
    this.renderer.toneMapping = NoToneMapping;

    const cu = this.compositePass.material.uniforms;
    const bu = this.brightPass.material.uniforms;
    const blu = this.blurPass.material.uniforms;

    if (q.bloom || q.godRays) {
      bu.tSrc.value = this.scene.texture;
      this.blit(this.brightPass, this.bright);

      let src = this.bright;
      for (let i = 0; i < 3; i++) {
        const a = this.blurA[i];
        const b = this.blurB[i];
        blu.tSrc.value = src.texture;
        (blu.uDirection.value as Vector2).set(1 / a.width, 0);
        this.blit(this.blurPass, a);
        blu.tSrc.value = a.texture;
        (blu.uDirection.value as Vector2).set(0, 1 / a.height);
        this.blit(this.blurPass, b);
        src = b;
      }
    }

    cu.tScene.value = this.scene.texture;
    cu.tBloom0.value = this.blurB[0].texture;
    cu.tBloom1.value = this.blurB[1].texture;
    cu.tBloom2.value = this.blurB[2].texture;
    cu.uBloomStrength.value = q.bloom ? q.bloomStrength : 0;
    (cu.uSunScreen.value as Vector2).copy(sunScreen);
    cu.uSunVisible.value = q.godRays ? sunVisible : 0;
    cu.uGodRays.value = q.godRays ? 0.6 : 0;
    cu.uSunColor.value = this.env.uSunColor.value;
    cu.uUnderwater.value = this.env.uUnderwater.value;
    cu.uTime.value = this.env.uTime.value;
    cu.uExposure.value = q.exposure;
    cu.uVignette.value = q.vignette;
    cu.uSaturation.value = q.saturation;
    cu.uDamage.value = this.damage;

    if (q.fxaa) {
      this.blit(this.compositePass, this.ldr);
      const fu = this.fxaaPass.material.uniforms;
      fu.tSrc.value = this.ldr.texture;
      (fu.uTexel.value as Vector2).set(1 / this.size.x, 1 / this.size.y);
      this.blit(this.fxaaPass, null);
    } else {
      this.blit(this.compositePass, null);
    }

    this.renderer.setRenderTarget(null);
    this.renderer.toneMapping = prevTone;
  }

  dispose(): void {
    for (const t of [this.scene, this.bright, this.ldr, ...this.blurA, ...this.blurB]) t?.dispose();
    this.blurA = [];
    this.blurB = [];
  }
}

/** Projette la direction du soleil en coordonnées écran [0,1]. */
const tmpVec = new Vector3();
export function projectSun(sunDir: Vector3, camera: Camera, out: Vector2): number {
  tmpVec.copy(sunDir).multiplyScalar(900).add(camera.position);
  tmpVec.project(camera);
  out.set(tmpVec.x * 0.5 + 0.5, tmpVec.y * 0.5 + 0.5);
  if (tmpVec.z > 1) return 0;
  const dx = Math.max(0, Math.abs(out.x - 0.5) - 0.5);
  const dy = Math.max(0, Math.abs(out.y - 0.5) - 0.5);
  const off = Math.hypot(dx, dy);
  return Math.max(0, 1 - off * 3.5);
}
