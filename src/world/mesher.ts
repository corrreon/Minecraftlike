/**
 * Mailleur de chunk : « greedy meshing » avec occlusion ambiante par sommet
 * et éclairage lissé.
 *
 * Entrée : volume de blocs et volume de lumière, tous deux étendus d'un voxel
 * de marge sur X et Z (18 × 128 × 18) afin de connaître les voisins sans
 * dialoguer avec le thread principal.
 *
 * Sortie : trois jeux d'attributs (opaque, alpha-test, translucide) prêts à
 * être transférés vers le thread principal en zéro-copie.
 */

import { CHUNK_X, CHUNK_Z, WORLD_HEIGHT } from '../core/constants';
import { IS_OPAQUE, IS_PARTIAL, MAX_Y, MIN_Y, RENDER_KIND, RENDER_LAYER, TEX_LAYERS, TINTS, RenderKind, RenderLayer } from './blocks';

export const PAD = 1;
export const PX = CHUNK_X + 2 * PAD;
export const PZ = CHUNK_Z + 2 * PAD;
export const PADDED_VOLUME = PX * PZ * WORLD_HEIGHT;

/** Index dans le volume étendu, coordonnées locales pouvant valoir -1 ou 16. */
export function paddedIndex(x: number, y: number, z: number): number {
  return x + PAD + PX * (z + PAD + PZ * y);
}

export interface LayerBuffers {
  position: Float32Array;
  normal: Int8Array;
  uv: Float32Array;
  color: Uint8Array;
  data: Float32Array;
  index: Uint32Array;
}

export interface MeshResult {
  opaque: LayerBuffers | null;
  cutout: LayerBuffers | null;
  translucent: LayerBuffers | null;
}

/**
 * Drapeaux d'animation encodés dans l'attribut `vdata` (bits 19-20), plus le
 * bit 21 qui marque les sommets appartenant à la surface d'un fluide.
 */
const WAVE_NONE = 0;
const WAVE_FOLIAGE = 1;
const WAVE_LIQUID = 2;
const WAVE_CROSS = 3;
const BIT_FLUID_TOP = 1 << 21;

/**
 * Bits 9-10, 22 et 23 sont réinterprétés selon la nature de la face.
 *
 * - fluide  : bits 9-10 et 22 = profondeur de la colonne d'eau (0-7), bit 23 =
 *   contact avec la terre ferme. L'occlusion ambiante n'a aucun sens sur de
 *   l'eau, ses deux bits sont donc recyclés.
 * - solide  : bit 22 = la face donne sur de l'eau, pour y projeter des
 *   caustiques.
 */
const BIT_SHORE = 1 << 23;
const BIT_SUBMERGED = 1 << 22;
const MAX_WATER_DEPTH = 7;

class LayerBuilder {
  pos: Float32Array;
  nrm: Int8Array;
  uv: Float32Array;
  col: Uint8Array;
  dat: Float32Array;
  idx: Uint32Array;
  vc = 0;
  ic = 0;

  constructor(cap = 2048) {
    this.pos = new Float32Array(cap * 3);
    this.nrm = new Int8Array(cap * 3);
    this.uv = new Float32Array(cap * 2);
    this.col = new Uint8Array(cap * 3);
    this.dat = new Float32Array(cap);
    this.idx = new Uint32Array(cap * 2);
  }

  private growVerts(need: number): void {
    let cap = this.dat.length;
    if (this.vc + need <= cap) return;
    while (cap < this.vc + need) cap *= 2;
    const pos = new Float32Array(cap * 3); pos.set(this.pos); this.pos = pos;
    const nrm = new Int8Array(cap * 3); nrm.set(this.nrm); this.nrm = nrm;
    const uv = new Float32Array(cap * 2); uv.set(this.uv); this.uv = uv;
    const col = new Uint8Array(cap * 3); col.set(this.col); this.col = col;
    const dat = new Float32Array(cap); dat.set(this.dat); this.dat = dat;
  }

  private growIdx(need: number): void {
    let cap = this.idx.length;
    if (this.ic + need <= cap) return;
    while (cap < this.ic + need) cap *= 2;
    const idx = new Uint32Array(cap); idx.set(this.idx); this.idx = idx;
  }

  /** Ajoute un quad (4 sommets + 6 indices). `flip` inverse la diagonale pour l'AO. */
  quad(
    px: Float32Array, // 12 valeurs : 4 positions xyz
    nx: number, ny: number, nz: number,
    uvs: Float32Array, // 8 valeurs
    r: number, g: number, b: number,
    d0: number, d1: number, d2: number, d3: number,
    reverse: boolean,
    flip: boolean,
  ): void {
    this.growVerts(4);
    this.growIdx(6);
    const v = this.vc;
    for (let i = 0; i < 4; i++) {
      this.pos[(v + i) * 3 + 0] = px[i * 3 + 0];
      this.pos[(v + i) * 3 + 1] = px[i * 3 + 1];
      this.pos[(v + i) * 3 + 2] = px[i * 3 + 2];
      this.nrm[(v + i) * 3 + 0] = nx;
      this.nrm[(v + i) * 3 + 1] = ny;
      this.nrm[(v + i) * 3 + 2] = nz;
      this.uv[(v + i) * 2 + 0] = uvs[i * 2 + 0];
      this.uv[(v + i) * 2 + 1] = uvs[i * 2 + 1];
      this.col[(v + i) * 3 + 0] = r;
      this.col[(v + i) * 3 + 1] = g;
      this.col[(v + i) * 3 + 2] = b;
    }
    this.dat[v + 0] = d0;
    this.dat[v + 1] = d1;
    this.dat[v + 2] = d2;
    this.dat[v + 3] = d3;

    const I = this.idx;
    let i = this.ic;
    if (!reverse) {
      if (flip) { I[i++] = v + 1; I[i++] = v + 2; I[i++] = v + 3; I[i++] = v + 1; I[i++] = v + 3; I[i++] = v + 0; }
      else { I[i++] = v + 0; I[i++] = v + 1; I[i++] = v + 2; I[i++] = v + 0; I[i++] = v + 2; I[i++] = v + 3; }
    } else {
      if (flip) { I[i++] = v + 3; I[i++] = v + 2; I[i++] = v + 1; I[i++] = v + 0; I[i++] = v + 3; I[i++] = v + 1; }
      else { I[i++] = v + 3; I[i++] = v + 2; I[i++] = v + 0; I[i++] = v + 2; I[i++] = v + 1; I[i++] = v + 0; }
    }
    this.ic = i;
    this.vc = v + 4;
  }

  finish(): LayerBuffers | null {
    if (this.ic === 0) return null;
    return {
      position: this.pos.slice(0, this.vc * 3),
      normal: this.nrm.slice(0, this.vc * 3),
      uv: this.uv.slice(0, this.vc * 2),
      color: this.col.slice(0, this.vc * 3),
      data: this.dat.slice(0, this.vc),
      index: this.idx.slice(0, this.ic),
    };
  }
}

// Tampons de travail partagés (le worker traite un chunk à la fois).
const DIMS = [CHUNK_X, WORLD_HEIGHT, CHUNK_Z];
const MASK_SIZE = WORLD_HEIGHT * Math.max(CHUNK_X, CHUNK_Z);
const maskTex = [new Int32Array(MASK_SIZE), new Int32Array(MASK_SIZE)];
const maskTint = [new Int32Array(MASK_SIZE), new Int32Array(MASK_SIZE)];
const maskAO = [new Int32Array(MASK_SIZE), new Int32Array(MASK_SIZE)];
const maskSky = [new Int32Array(MASK_SIZE), new Int32Array(MASK_SIZE)];
const maskBlk = [new Int32Array(MASK_SIZE), new Int32Array(MASK_SIZE)];
const maskShape = [new Int32Array(MASK_SIZE), new Int32Array(MASK_SIZE)];
const maskLayer = [new Int32Array(MASK_SIZE), new Int32Array(MASK_SIZE)];
const maskWave = [new Int32Array(MASK_SIZE), new Int32Array(MASK_SIZE)];
const maskExtra = [new Int32Array(MASK_SIZE), new Int32Array(MASK_SIZE)];

const quadPos = new Float32Array(12);
const quadUv = new Float32Array(8);

export function meshChunk(blocks: Uint8Array, light: Uint8Array): MeshResult {
  const builders = [new LayerBuilder(4096), new LayerBuilder(1024), new LayerBuilder(512)];

  const getBlock = (x: number, y: number, z: number): number => {
    if (y < 0) return 6; // bedrock virtuel : évite une face inutile sous le monde
    if (y >= WORLD_HEIGHT) return 0;
    return blocks[x + PAD + PX * (z + PAD + PZ * y)];
  };
  const getLight = (x: number, y: number, z: number): number => {
    if (y < 0) return 0;
    if (y >= WORLD_HEIGHT) return 0xf0;
    return light[x + PAD + PX * (z + PAD + PZ * y)];
  };
  const opaqueAt = (x: number, y: number, z: number): number => IS_OPAQUE[getBlock(x, y, z)];

  /** Le bloc `n` masque-t-il la face du bloc `s` ? */
  const occludes = (n: number, s: number): boolean => {
    if (IS_OPAQUE[n]) return true;
    if (n === s) return RENDER_KIND[n] === RenderKind.Cube || RENDER_KIND[n] === RenderKind.Liquid;
    // Un fluide ne dessine pas sa face contre un autre fluide.
    if (RENDER_KIND[n] === RenderKind.Liquid && RENDER_KIND[s] === RenderKind.Liquid) return true;
    return false;
  };

  const renderableFace = (b: number): boolean => {
    if (IS_PARTIAL[b]) return false; // dalles : géométrie émise à part
    const k = RENDER_KIND[b];
    return k === RenderKind.Cube || k === RenderKind.Liquid;
  };

  const p = [0, 0, 0];
  const q = [0, 0, 0];
  const uAxis = [0, 0, 0];
  const vAxis = [0, 0, 0];

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const du = DIMS[u];
    const dv = DIMS[v];
    q[0] = q[1] = q[2] = 0;
    q[d] = 1;
    uAxis[0] = uAxis[1] = uAxis[2] = 0;
    uAxis[u] = 1;
    vAxis[0] = vAxis[1] = vAxis[2] = 0;
    vAxis[v] = 1;

    for (let s = -1; s < DIMS[d]; s++) {
      // --- Construction des deux masques (faces +d et -d) -------------------
      for (let side = 0; side < 2; side++) maskTex[side].fill(-1, 0, du * dv);

      for (let j = 0; j < dv; j++) {
        for (let i = 0; i < du; i++) {
          p[d] = s;
          p[u] = i;
          p[v] = j;
          const ax = p[0], ay = p[1], az = p[2];
          const bx = ax + q[0], by = ay + q[1], bz = az + q[2];
          const a = getBlock(ax, ay, az);
          const b = getBlock(bx, by, bz);
          const m = i + j * du;

          // Face du bloc « a » orientée vers +d.
          if (s >= 0 && renderableFace(a) && !occludes(b, a)) {
            fillMask(0, m, a, ax, ay, az, +1);
          }
          // Face du bloc « b » orientée vers -d.
          if (s + 1 < DIMS[d] && renderableFace(b) && !occludes(a, b)) {
            fillMask(1, m, b, bx, by, bz, -1);
          }
        }
      }

      // --- Fusion gloutonne et émission ------------------------------------
      for (let side = 0; side < 2; side++) {
        const mt = maskTex[side];
        for (let j = 0; j < dv; j++) {
          for (let i = 0; i < du; ) {
            const m = i + j * du;
            if (mt[m] < 0) { i++; continue; }
            // Largeur.
            let w = 1;
            while (i + w < du && sameMask(side, m, m + w)) w++;
            // Hauteur.
            let h = 1;
            outer: while (j + h < dv) {
              for (let k = 0; k < w; k++) {
                if (!sameMask(side, m, m + k + h * du)) break outer;
              }
              h++;
            }
            emit(side, m, s, i, j, w, h);
            for (let hh = 0; hh < h; hh++) for (let ww = 0; ww < w; ww++) mt[m + ww + hh * du] = -1;
            i += w;
          }
        }
      }
    }

    // ---- Fonctions locales (capturent d/u/v) -------------------------------

    function fillMask(side: number, m: number, blockId: number, x: number, y: number, z: number, dir: number): void {
      const kind = RENDER_KIND[blockId];
      const face = d === 1 ? (dir > 0 ? 0 : 1) : 2; // 0=top, 1=bottom, 2=side
      maskTex[side][m] = TEX_LAYERS[blockId * 3 + face];
      maskTint[side][m] = TINTS[blockId] || 0xffffff;
      maskLayer[side][m] = RENDER_LAYER[blockId];

      const isLiquid = kind === RenderKind.Liquid;
      let shape = 0;
      if (isLiquid && getBlock(x, y + 1, z) !== blockId) shape = 1; // surface d'un fluide
      maskShape[side][m] = shape;

      // Informations de fluide, résolues ici une bonne fois : la profondeur
      // sous la face et le contact avec la rive.
      let extra = 0;
      if (isLiquid) {
        let depth = 0;
        while (depth < MAX_WATER_DEPTH && getBlock(x, y - depth - 1, z) === blockId) depth++;
        extra |= (depth & 3) << 9;
        extra |= ((depth >> 2) & 1) << 22;
        for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nb = getBlock(x + ox, y, z + oz);
          if (nb !== 0 && nb !== blockId && RENDER_KIND[nb] !== RenderKind.Liquid) {
            extra |= BIT_SHORE;
            break;
          }
        }
      }
      maskExtra[side][m] = extra;
      // Seuls les feuillages (repérés par leur teinte) ondulent ; le verre non.
      maskWave[side][m] = isLiquid
        ? WAVE_LIQUID
        : RENDER_LAYER[blockId] === RenderLayer.Cutout && TINTS[blockId] !== 0
          ? WAVE_FOLIAGE
          : WAVE_NONE;

      // Voxel voisin par lequel arrive la lumière.
      const nx = x + q[0] * dir, ny = y + q[1] * dir, nz = z + q[2] * dir;
      if (!isLiquid && RENDER_KIND[getBlock(nx, ny, nz)] === RenderKind.Liquid) {
        maskExtra[side][m] |= BIT_SUBMERGED;
      }
      let ao = 0, sky = 0, blk = 0;
      for (let c = 0; c < 4; c++) {
        // Coins dans l'ordre (-u,-v), (+u,-v), (+u,+v), (-u,+v).
        const cu = c === 1 || c === 2 ? 1 : -1;
        const cv = c === 2 || c === 3 ? 1 : -1;
        const s1x = nx + uAxis[0] * cu, s1y = ny + uAxis[1] * cu, s1z = nz + uAxis[2] * cu;
        const s2x = nx + vAxis[0] * cv, s2y = ny + vAxis[1] * cv, s2z = nz + vAxis[2] * cv;
        const cxx = s1x + vAxis[0] * cv, cyy = s1y + vAxis[1] * cv, czz = s1z + vAxis[2] * cv;
        const o1 = opaqueAt(s1x, s1y, s1z);
        const o2 = opaqueAt(s2x, s2y, s2z);
        const oc = opaqueAt(cxx, cyy, czz);
        const aoVal = o1 && o2 ? 0 : 3 - (o1 + o2 + oc);

        // Éclairage lissé : moyenne des cellules non opaques du voisinage.
        let sSum = 0, bSum = 0, count = 0;
        const acc = (X: number, Y: number, Z: number) => {
          if (opaqueAt(X, Y, Z)) return;
          const l = getLight(X, Y, Z);
          sSum += l >> 4;
          bSum += l & 15;
          count++;
        };
        acc(nx, ny, nz);
        acc(s1x, s1y, s1z);
        acc(s2x, s2y, s2z);
        if (!(o1 && o2)) acc(cxx, cyy, czz);
        const skyV = count ? Math.round(sSum / count) : 0;
        const blkV = count ? Math.round(bSum / count) : 0;

        ao |= aoVal << (c * 2);
        sky |= skyV << (c * 4);
        blk |= blkV << (c * 4);
      }
      maskAO[side][m] = ao;
      maskSky[side][m] = sky;
      maskBlk[side][m] = blk;
    }

    function sameMask(side: number, a: number, b: number): boolean {
      return (
        maskTex[side][b] === maskTex[side][a] &&
        maskTint[side][b] === maskTint[side][a] &&
        maskAO[side][b] === maskAO[side][a] &&
        maskSky[side][b] === maskSky[side][a] &&
        maskBlk[side][b] === maskBlk[side][a] &&
        maskShape[side][b] === maskShape[side][a] &&
        maskLayer[side][b] === maskLayer[side][a] &&
        maskWave[side][b] === maskWave[side][a] &&
        maskExtra[side][b] === maskExtra[side][a]
      );
    }

    function emit(side: number, m: number, sSlice: number, i: number, j: number, w: number, h: number): void {
      const dir = side === 0 ? 1 : -1;
      const base = [0, 0, 0];
      base[d] = sSlice + 1;
      base[u] = i;
      base[v] = j;

      // Abaissement de la surface des fluides.
      const drop = maskShape[side][m] === 1 ? 0.11 : 0;
      const yTopIdx = 1;

      const P = quadPos;
      let loweredMask = 0;
      for (let c = 0; c < 4; c++) {
        const cu = c === 1 || c === 2 ? w : 0;
        const cv = c === 2 || c === 3 ? h : 0;
        for (let k = 0; k < 3; k++) P[c * 3 + k] = base[k] + uAxis[k] * cu + vAxis[k] * cv;
        if (drop > 0) {
          // Face supérieure : on abaisse tout ; faces latérales : uniquement le bord haut.
          if (d === yTopIdx && side === 0) { P[c * 3 + 1] -= drop; loweredMask |= 1 << c; }
          else if (d !== yTopIdx && P[c * 3 + 1] > base[1] + 0.5) { P[c * 3 + 1] -= drop; loweredMask |= 1 << c; }
        }
      }

      const U = quadUv;
      U[0] = 0; U[1] = 0;
      U[2] = w; U[3] = 0;
      U[4] = w; U[5] = h;
      U[6] = 0; U[7] = h;

      const tint = maskTint[side][m];
      const r = (tint >> 16) & 255, g = (tint >> 8) & 255, bl = tint & 255;
      const tex = maskTex[side][m];
      const ao = maskAO[side][m];
      const sky = maskSky[side][m];
      const blk = maskBlk[side][m];
      const wave = maskWave[side][m];

      const extra = maskExtra[side][m];
      const isLiquid = wave === WAVE_LIQUID;
      const packed = (c: number) =>
        tex |
        // Sur un fluide, les bits d'occlusion portent la profondeur.
        (isLiquid ? extra & (3 << 9) : ((ao >> (c * 2)) & 3) << 9) |
        (((sky >> (c * 4)) & 15) << 11) |
        (((blk >> (c * 4)) & 15) << 15) |
        (wave << 19) |
        (loweredMask & (1 << c) ? BIT_FLUID_TOP : 0) |
        (extra & (BIT_SUBMERGED | BIT_SHORE));

      const a0 = (ao >> 0) & 3, a1 = (ao >> 2) & 3, a2 = (ao >> 4) & 3, a3 = (ao >> 6) & 3;
      const flip = a0 + a2 > a1 + a3;

      const nrm = [0, 0, 0];
      nrm[d] = dir;
      builders[maskLayer[side][m]].quad(
        P,
        nrm[0] * 127, nrm[1] * 127, nrm[2] * 127,
        U,
        r, g, bl,
        packed(0), packed(1), packed(2), packed(3),
        side === 1,
        flip,
      );
    }
  }

  // --- Blocs « croix » (végétation, torches) --------------------------------
  emitCrosses(blocks, light, builders[RenderLayer.Cutout]);
  // --- Blocs partiels (dalles) ---------------------------------------------
  emitPartials(blocks, light, builders);

  return {
    opaque: builders[RenderLayer.Opaque].finish(),
    cutout: builders[RenderLayer.Cutout].finish(),
    translucent: builders[RenderLayer.Translucent].finish(),
  };
}

const CROSS_POS = new Float32Array(12);
const CROSS_UV = new Float32Array(8);

function emitCrosses(blocks: Uint8Array, light: Uint8Array, out: LayerBuilder): void {
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let z = 0; z < CHUNK_Z; z++) {
      for (let x = 0; x < CHUNK_X; x++) {
        const idx = paddedIndex(x, y, z);
        const id = blocks[idx];
        if (id === 0 || RENDER_KIND[id] !== RenderKind.Cross) continue;

        const l = light[idx];
        const sky = l >> 4;
        const blk = Math.max(l & 15, 0);
        const tint = TINTS[id] || 0xffffff;
        const r = (tint >> 16) & 255, g = (tint >> 8) & 255, b = tint & 255;
        const tex = TEX_LAYERS[id * 3 + 2];
        const wave = TINTS[id] !== 0 ? WAVE_CROSS : WAVE_NONE;

        // Décalage déterministe : la végétation n'est pas parfaitement alignée.
        const hx = (((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0) / 4294967296;
        const hz = (((x * 19349663) ^ (y * 83492791) ^ (z * 73856093)) >>> 0) / 4294967296;
        const ox = (hx - 0.5) * 0.3;
        const oz = (hz - 0.5) * 0.3;
        const half = 0.45;
        const packed = tex | (3 << 9) | (sky << 11) | (blk << 15) | (wave << 19);

        for (let plane = 0; plane < 2; plane++) {
          const sx = plane === 0 ? half : -half;
          const x0 = x + 0.5 + ox - sx, z0 = z + 0.5 + oz - half;
          const x1 = x + 0.5 + ox + sx, z1 = z + 0.5 + oz + half;
          const P = CROSS_POS;
          P[0] = x0; P[1] = y; P[2] = z0;
          P[3] = x1; P[4] = y; P[5] = z1;
          P[6] = x1; P[7] = y + 1; P[8] = z1;
          P[9] = x0; P[10] = y + 1; P[11] = z0;
          const U = CROSS_UV;
          U[0] = 0; U[1] = 0; U[2] = 1; U[3] = 0; U[4] = 1; U[5] = 1; U[6] = 0; U[7] = 1;
          out.quad(P, 0, 127, 0, U, r, g, b, packed, packed, packed, packed, false, false);
        }
      }
    }
  }
}

const BOX_POS = new Float32Array(12);
const BOX_UV = new Float32Array(8);

/**
 * Émet la géométrie des blocs qui ne remplissent pas leur voxel — pour
 * l'instant les dalles, dont seule l'emprise verticale diffère.
 *
 * Ils échappent au greedy meshing : leurs faces ne s'alignent pas sur la
 * grille, et les fusionner demanderait de comparer aussi les hauteurs.
 */
function emitPartials(blocks: Uint8Array, light: Uint8Array, builders: LayerBuilder[]): void {
  const getBlock = (x: number, y: number, z: number): number => {
    if (y < 0) return 6;
    if (y >= WORLD_HEIGHT) return 0;
    return blocks[x + PAD + PX * (z + PAD + PZ * y)];
  };
  const getLight = (x: number, y: number, z: number): number => {
    if (y < 0) return 0;
    if (y >= WORLD_HEIGHT) return 0xf0;
    return light[x + PAD + PX * (z + PAD + PZ * y)];
  };

  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let z = 0; z < CHUNK_Z; z++) {
      for (let x = 0; x < CHUNK_X; x++) {
        const id = blocks[paddedIndex(x, y, z)];
        if (id === 0 || !IS_PARTIAL[id]) continue;

        const y0 = y + MIN_Y[id];
        const y1 = y + MAX_Y[id];
        const tint = TINTS[id] || 0xffffff;
        const r = (tint >> 16) & 255, g = (tint >> 8) & 255, b = tint & 255;
        const out = builders[RENDER_LAYER[id]];
        const height = MAX_Y[id] - MIN_Y[id];

        // [normale, texture, cullé si le voisin est opaque et couvre la face]
        const faces: [number, number, number, number, boolean][] = [
          [0, 1, 0, TEX_LAYERS[id * 3 + 0], MAX_Y[id] >= 1 && IS_OPAQUE[getBlock(x, y + 1, z)] === 1],
          [0, -1, 0, TEX_LAYERS[id * 3 + 1], MIN_Y[id] <= 0 && IS_OPAQUE[getBlock(x, y - 1, z)] === 1],
          [0, 0, 1, TEX_LAYERS[id * 3 + 2], IS_OPAQUE[getBlock(x, y, z + 1)] === 1 || getBlock(x, y, z + 1) === id],
          [0, 0, -1, TEX_LAYERS[id * 3 + 2], IS_OPAQUE[getBlock(x, y, z - 1)] === 1 || getBlock(x, y, z - 1) === id],
          [1, 0, 0, TEX_LAYERS[id * 3 + 2], IS_OPAQUE[getBlock(x + 1, y, z)] === 1 || getBlock(x + 1, y, z) === id],
          [-1, 0, 0, TEX_LAYERS[id * 3 + 2], IS_OPAQUE[getBlock(x - 1, y, z)] === 1 || getBlock(x - 1, y, z) === id],
        ];

        for (const [nx, ny, nz, tex, culled] of faces) {
          if (culled) continue;
          const l = getLight(x + nx, y + (ny > 0 ? 1 : ny < 0 ? -1 : 0), z + nz);
          const sky = l >> 4;
          const blk = l & 15;
          const packed = tex | (3 << 9) | (sky << 11) | (blk << 15);

          const P = BOX_POS;
          if (ny !== 0) {
            const py = ny > 0 ? y1 : y0;
            P[0] = x; P[1] = py; P[2] = z;
            P[3] = x + 1; P[4] = py; P[5] = z;
            P[6] = x + 1; P[7] = py; P[8] = z + 1;
            P[9] = x; P[10] = py; P[11] = z + 1;
          } else if (nx !== 0) {
            const px = nx > 0 ? x + 1 : x;
            P[0] = px; P[1] = y0; P[2] = z;
            P[3] = px; P[4] = y0; P[5] = z + 1;
            P[6] = px; P[7] = y1; P[8] = z + 1;
            P[9] = px; P[10] = y1; P[11] = z;
          } else {
            const pz = nz > 0 ? z + 1 : z;
            P[0] = x; P[1] = y0; P[2] = pz;
            P[3] = x + 1; P[4] = y0; P[5] = pz;
            P[6] = x + 1; P[7] = y1; P[8] = pz;
            P[9] = x; P[10] = y1; P[11] = pz;
          }

          const U = BOX_UV;
          const vh = ny !== 0 ? 1 : height;
          U[0] = 0; U[1] = 0; U[2] = 1; U[3] = 0; U[4] = 1; U[5] = vh; U[6] = 0; U[7] = vh;

          // Les quatre sommets tournent dans le sens direct vu de la normale ;
          // trois des six faces demandent l'ordre inverse.
          const reverse = ny < 0 || nx < 0 || nz < 0;
          out.quad(P, nx * 127, ny * 127, nz * 127, U, r, g, b, packed, packed, packed, packed, reverse, false);
        }
      }
    }
  }
}
