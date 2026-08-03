/** Table des biomes : sélection par climat et paramètres de décoration. */

import { B } from './blocks';

export const enum Biome {
  DeepOcean = 0,
  Ocean = 1,
  Beach = 2,
  Plains = 3,
  SunflowerPlains = 4,
  Forest = 5,
  BirchForest = 6,
  Taiga = 7,
  SnowyTaiga = 8,
  SnowyPlains = 9,
  Desert = 10,
  Savanna = 11,
  Jungle = 12,
  Swamp = 13,
  StonyPeaks = 14,
  Badlands = 15,
  Meadow = 16,
  Count = 17,
}

export type TreeKind = 'none' | 'oak' | 'big_oak' | 'birch' | 'spruce' | 'tall_spruce' | 'jungle' | 'acacia' | 'swamp_oak' | 'cactus';

export interface BiomeDef {
  id: Biome;
  name: string;
  surface: number;
  subsurface: number;
  underwater: number;
  /** Épaisseur de la couche de surface. */
  depth: number;
  /** Densité d'arbres par colonne (probabilité). */
  treeDensity: number;
  tree: TreeKind;
  secondaryTree?: TreeKind;
  secondaryChance?: number;
  grassDensity: number;
  flowerDensity: number;
  /** Neige posée en surface au-dessus de ce seuil d'altitude (Infinity = jamais). */
  snowLine: number;
  grassTint: number;
  foliageTint: number;
  waterTint: number;
  /** Teinte du brouillard atmosphérique. */
  fogTint: number;
  /** Multiplicateur de densité de brume. */
  fogDensity: number;
  temperature: number;
}

const D: Omit<BiomeDef, 'id' | 'name'> = {
  surface: B.grass,
  subsurface: B.dirt,
  underwater: B.gravel,
  depth: 4,
  treeDensity: 0,
  tree: 'none',
  grassDensity: 0,
  flowerDensity: 0,
  snowLine: Infinity,
  grassTint: 0x51803c,
  foliageTint: 0x528e2e,
  waterTint: 0x3f76e4,
  fogTint: 0xc0d8ff,
  fogDensity: 1,
  temperature: 0.6,
};

function def(id: Biome, name: string, o: Partial<BiomeDef>): BiomeDef {
  return { ...D, id, name, ...o };
}

export const BIOMES: BiomeDef[] = [];
BIOMES[Biome.DeepOcean] = def(Biome.DeepOcean, 'Océan profond', {
  surface: B.gravel, subsurface: B.gravel, underwater: B.gravel, waterTint: 0x2b5ec0, fogTint: 0x9fb7d8,
});
BIOMES[Biome.Ocean] = def(Biome.Ocean, 'Océan', {
  surface: B.sand, subsurface: B.sand, underwater: B.sand, waterTint: 0x3f76e4, fogTint: 0xa8c2e8,
});
BIOMES[Biome.Beach] = def(Biome.Beach, 'Plage', {
  surface: B.sand, subsurface: B.sand, underwater: B.sand, depth: 5, temperature: 0.8, fogTint: 0xd6e4ff,
});
BIOMES[Biome.Plains] = def(Biome.Plains, 'Plaines', {
  treeDensity: 0.004, tree: 'oak', grassDensity: 0.16, flowerDensity: 0.02,
});
BIOMES[Biome.SunflowerPlains] = def(Biome.SunflowerPlains, 'Prairie fleurie', {
  treeDensity: 0.003, tree: 'oak', grassDensity: 0.22, flowerDensity: 0.14, grassTint: 0x5c873f,
});
BIOMES[Biome.Forest] = def(Biome.Forest, 'Forêt', {
  treeDensity: 0.036, tree: 'oak', secondaryTree: 'big_oak', secondaryChance: 0.12,
  grassDensity: 0.18, flowerDensity: 0.03, grassTint: 0x467f31, foliageTint: 0x488e24,
});
BIOMES[Biome.BirchForest] = def(Biome.BirchForest, 'Forêt de bouleaux', {
  treeDensity: 0.032, tree: 'birch', grassDensity: 0.16, flowerDensity: 0.03,
  grassTint: 0x5b7d45, foliageTint: 0x709756,
});
BIOMES[Biome.Taiga] = def(Biome.Taiga, 'Taïga', {
  treeDensity: 0.03, tree: 'spruce', secondaryTree: 'tall_spruce', secondaryChance: 0.25,
  grassDensity: 0.1, temperature: 0.25, grassTint: 0x476c3a, foliageTint: 0x3b5d38, fogTint: 0xb6c7d8,
});
BIOMES[Biome.SnowyTaiga] = def(Biome.SnowyTaiga, 'Taïga enneigée', {
  treeDensity: 0.022, tree: 'spruce', grassDensity: 0.04, snowLine: 0, temperature: -0.2,
  grassTint: 0x426c47, foliageTint: 0x38543e, waterTint: 0x3a5fb0, fogTint: 0xd8e6f2,
});
BIOMES[Biome.SnowyPlains] = def(Biome.SnowyPlains, 'Plaines enneigées', {
  grassDensity: 0.02, snowLine: 0, temperature: -0.4,
  grassTint: 0x557965, foliageTint: 0x497a5d, waterTint: 0x3d57d6, fogTint: 0xe2eef8, fogDensity: 1.25,
});
BIOMES[Biome.Desert] = def(Biome.Desert, 'Désert', {
  surface: B.sand, subsurface: B.sandstone, underwater: B.sand, depth: 6,
  treeDensity: 0.006, tree: 'cactus', grassDensity: 0.01, temperature: 1.4,
  grassTint: 0x807a39, foliageTint: 0x847d20, fogTint: 0xf2e2b8, fogDensity: 0.7,
});
BIOMES[Biome.Savanna] = def(Biome.Savanna, 'Savane', {
  treeDensity: 0.012, tree: 'acacia', grassDensity: 0.2, flowerDensity: 0.01, temperature: 1.1,
  grassTint: 0x807a39, foliageTint: 0x847d20, fogTint: 0xecdfae, fogDensity: 0.8,
});
BIOMES[Biome.Jungle] = def(Biome.Jungle, 'Jungle', {
  treeDensity: 0.05, tree: 'jungle', grassDensity: 0.28, flowerDensity: 0.06, temperature: 1.2,
  grassTint: 0x3c8728, foliageTint: 0x409720, fogTint: 0xa9d8a1, fogDensity: 1.5,
});
BIOMES[Biome.Swamp] = def(Biome.Swamp, 'Marais', {
  treeDensity: 0.018, tree: 'swamp_oak', grassDensity: 0.18, flowerDensity: 0.02,
  underwater: B.clay, grassTint: 0x474b26, foliageTint: 0x51552b, waterTint: 0x4b6d3a,
  fogTint: 0x8f9f78, fogDensity: 2.1, temperature: 0.8,
});
BIOMES[Biome.StonyPeaks] = def(Biome.StonyPeaks, 'Sommets rocheux', {
  surface: B.stone, subsurface: B.stone, underwater: B.gravel, depth: 2, snowLine: 96,
  temperature: 0.1, fogTint: 0xd0dced, grassTint: 0x557155, foliageTint: 0x547754,
});
BIOMES[Biome.Badlands] = def(Biome.Badlands, 'Mesa', {
  surface: B.red_sand, subsurface: B.red_sand, underwater: B.red_sand, depth: 5,
  temperature: 1.5, grassTint: 0x605634, foliageTint: 0x78623b, fogTint: 0xe0a06a, fogDensity: 0.9,
  grassDensity: 0.01,
});
BIOMES[Biome.Meadow] = def(Biome.Meadow, 'Alpage', {
  treeDensity: 0.006, tree: 'oak', grassDensity: 0.24, flowerDensity: 0.08,
  grassTint: 0x587d49, foliageTint: 0x4b8037, temperature: 0.35, fogTint: 0xcfe0f5,
});

/**
 * Sélection du biome à partir du climat.
 * @param cont continentalité, -1 = large océan, +1 = intérieur des terres
 * @param temp température   [-1, 1]
 * @param hum  humidité      [-1, 1]
 * @param ero  érosion (relief plat vs accidenté) [-1, 1]
 * @param height altitude du terrain en blocs
 */
export function pickBiome(cont: number, temp: number, hum: number, ero: number, height: number, seaLevel: number): Biome {
  if (height < seaLevel - 12) return Biome.DeepOcean;
  if (height < seaLevel - 1) return Biome.Ocean;
  if (height <= seaLevel + 2 && cont < 0.25) return Biome.Beach;

  if (height > seaLevel + 46) return Biome.StonyPeaks;

  if (temp < -0.35) return hum > 0 ? Biome.SnowyTaiga : Biome.SnowyPlains;
  if (temp < 0.05) return hum > -0.1 ? Biome.Taiga : Biome.Meadow;

  if (temp > 0.75) {
    if (hum < -0.4) return ero > 0.35 ? Biome.Badlands : Biome.Desert;
    if (hum < 0.15) return Biome.Savanna;
    return Biome.Jungle;
  }

  if (hum > 0.45 && height < seaLevel + 6) return Biome.Swamp;
  if (hum > 0.2) return temp > 0.45 ? Biome.Forest : Biome.BirchForest;
  if (hum > -0.25) return ero > 0.2 ? Biome.Forest : Biome.Plains;
  return temp > 0.5 ? Biome.SunflowerPlains : Biome.Plains;
}

export function biomeDef(b: Biome): BiomeDef {
  return BIOMES[b] ?? BIOMES[Biome.Plains];
}
