/** Dimensions du monde et constantes partagées entre le thread principal et les workers. */

export const CHUNK_X = 16;
export const CHUNK_Z = 16;
export const WORLD_HEIGHT = 128;
export const SEA_LEVEL = 62;

/** Nombre de voxels dans une colonne de chunk. */
export const CHUNK_VOLUME = CHUNK_X * CHUNK_Z * WORLD_HEIGHT;

/** Index linéaire d'un voxel local. x,z dans [0,16[, y dans [0,128[. */
export function voxelIndex(x: number, y: number, z: number): number {
  return x + CHUNK_X * (z + CHUNK_Z * y);
}

/** Taille d'une couche horizontale (utile pour parcourir une colonne). */
export const LAYER = CHUNK_X * CHUNK_Z;

/** Clé de chunk compacte et stable, utilisable comme clé de Map. */
export function chunkKey(cx: number, cz: number): string {
  return cx + ',' + cz;
}

export function parseChunkKey(key: string): [number, number] {
  const i = key.indexOf(',');
  return [Number(key.slice(0, i)), Number(key.slice(i + 1))];
}

/** Divisions entières « vers moins l'infini », indispensables pour les coordonnées négatives. */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

export function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** Vitesse d'écoulement du temps : un cycle jour/nuit complet en secondes. */
export const DAY_LENGTH_SECONDS = 900;

/** Ticks logiques par seconde (physique des entités, faim, croissance…). */
export const TICK_RATE = 20;
export const TICK_DT = 1 / TICK_RATE;

export const GRAVITY = 28;
export const TERMINAL_VELOCITY = 60;

export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE = 1.62;
export const PLAYER_CROUCH_HEIGHT = 1.5;
export const PLAYER_CROUCH_EYE = 1.32;

export const REACH_SURVIVAL = 4.5;
export const REACH_CREATIVE = 6.0;
