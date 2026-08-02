/**
 * Uniformes d'ambiance partagés par tous les matériaux (terrain, ciel, nuages,
 * entités, post-traitement). Le même objet `IUniform` est référencé partout :
 * une seule écriture met tout le rendu à jour.
 */

import { Color, Vector3, type IUniform } from 'three';

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
  };
}
