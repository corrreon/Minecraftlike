/**
 * Uniformes d'ambiance partagés par tous les matériaux (terrain, ciel, nuages,
 * entités, post-traitement). Le même objet `IUniform` est référencé partout :
 * une seule écriture met tout le rendu à jour.
 */

import { Color, Matrix4, Vector3, type IUniform } from 'three';
import type { Texture } from 'three';

export interface EnvUniforms {
  uTime: IUniform<number>;
  uSunDir: IUniform<Vector3>;
  uMoonDir: IUniform<Vector3>;
  uSunColor: IUniform<Color>;
  uSkyLight: IUniform<Color>;
  uBlockLight: IUniform<Color>;
  uAmbient: IUniform<Color>;
  uFogColor: IUniform<Color>;
  uFogSky: IUniform<Color>;
  uFogDensity: IUniform<number>;
  uDayFactor: IUniform<number>;
  uUnderwater: IUniform<number>;
  uCameraPos: IUniform<Vector3>;
  uZenith: IUniform<Color>;
  uHorizon: IUniform<Color>;
  uNight: IUniform<Color>;
  uStarStrength: IUniform<number>;
  uCloudCover: IUniform<number>;
  uRain: IUniform<number>;
  uRenderDistance: IUniform<number>;
  /** Carte de profondeur vue du soleil, ou null si les ombres sont coupées. */
  uShadowMap: IUniform<Texture | null>;
  uShadowMatrix: IUniform<Matrix4>;
  /** 0 = pas d'ombres ; sinon intensité de l'assombrissement. */
  uShadowStrength: IUniform<number>;
  /** Taille d'un texel de la carte, en unités monde (pour le décalage de biais). */
  uShadowTexel: IUniform<number>;
  /** Rayon couvert par la carte : au-delà, les ombres s'estompent. */
  uShadowRadius: IUniform<number>;
}

export function createEnvUniforms(): EnvUniforms {
  return {
    uTime: { value: 0 },
    uSunDir: { value: new Vector3(0.4, 0.8, 0.3).normalize() },
    uMoonDir: { value: new Vector3(-0.4, -0.8, -0.3).normalize() },
    uSunColor: { value: new Color(1, 0.97, 0.9) },
    uSkyLight: { value: new Color(1, 1, 1) },
    uBlockLight: { value: new Color(1.0, 0.72, 0.42) },
    uAmbient: { value: new Color(0.07, 0.08, 0.11) },
    uFogColor: { value: new Color(0.72, 0.82, 0.95) },
    uFogSky: { value: new Color(0.6, 0.75, 0.95) },
    uFogDensity: { value: 0.012 },
    uDayFactor: { value: 1 },
    uUnderwater: { value: 0 },
    uCameraPos: { value: new Vector3() },
    uZenith: { value: new Color(0.15, 0.34, 0.75) },
    uHorizon: { value: new Color(0.65, 0.79, 0.95) },
    uNight: { value: new Color(0.02, 0.03, 0.07) },
    uStarStrength: { value: 0 },
    uCloudCover: { value: 0.45 },
    uRain: { value: 0 },
    uRenderDistance: { value: 128 },
    uShadowMap: { value: null },
    uShadowMatrix: { value: new Matrix4() },
    uShadowStrength: { value: 0 },
    uShadowTexel: { value: 1 / 2048 },
    uShadowRadius: { value: 80 },
  };
}
