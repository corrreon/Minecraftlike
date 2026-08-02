/**
 * Carte d'ombre directionnelle du soleil.
 *
 * Une caméra orthographique suit le joueur et rend la profondeur de la scène
 * depuis le soleil. Le centre est **aligné sur la grille de texels** de la
 * carte : sans cela, le moindre déplacement du joueur ferait grouiller les
 * bords d'ombre.
 */

import {
  DepthFormat,
  DepthTexture,
  Matrix4,
  NearestFilter,
  OrthographicCamera,
  UnsignedIntType,
  Vector3,
  WebGLRenderTarget,
} from 'three';

/** Passe de l'espace projectif [-1,1] aux coordonnées de texture [0,1]. */
const BIAS = new Matrix4().set(
  0.5, 0, 0, 0.5,
  0, 0.5, 0, 0.5,
  0, 0, 0.5, 0.5,
  0, 0, 0, 1,
);

const UP = new Vector3(0, 1, 0);
const UP_ALT = new Vector3(0, 0, 1);

export class ShadowMap {
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 1, 400);
  readonly matrix = new Matrix4();
  target: WebGLRenderTarget;
  size: number;
  radius: number;

  private center = new Vector3();
  private right = new Vector3();
  private up = new Vector3();

  constructor(size = 2048, radius = 80) {
    this.size = size;
    this.radius = radius;
    this.target = this.makeTarget(size);
    this.configure(radius);
  }

  private makeTarget(size: number): WebGLRenderTarget {
    // On n'a besoin que de la profondeur : le tampon couleur n'est jamais lu.
    const depth = new DepthTexture(size, size, UnsignedIntType);
    depth.format = DepthFormat;
    depth.minFilter = NearestFilter;
    depth.magFilter = NearestFilter;
    const rt = new WebGLRenderTarget(size, size, {
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: depth,
    });
    rt.texture.name = 'shadowColor';
    return rt;
  }

  get depthTexture(): DepthTexture {
    return this.target.depthTexture as DepthTexture;
  }

  private configure(radius: number): void {
    this.radius = radius;
    const c = this.camera;
    c.left = -radius;
    c.right = radius;
    c.top = radius;
    c.bottom = -radius;
    c.near = 1;
    c.far = radius * 4 + 80;
    c.updateProjectionMatrix();
  }

  /** Change la résolution (réglage de qualité). */
  setSize(size: number): void {
    if (size === this.size) return;
    this.target.dispose();
    this.size = size;
    this.target = this.makeTarget(size);
  }

  setRadius(radius: number): void {
    if (Math.abs(radius - this.radius) < 0.5) return;
    this.configure(radius);
  }

  /** Taille d'un texel de la carte en unités monde. */
  get texelWorldSize(): number {
    return (this.radius * 2) / this.size;
  }

  /**
   * Recentre la caméra d'ombre sur le joueur, en direction du soleil.
   * @param sunDir direction *vers* le soleil, normalisée
   */
  update(sunDir: Vector3, target: Vector3, forward: Vector3): void {
    // On décale le centre devant le joueur : la carte sert surtout à ce qu'il
    // regarde, pas à ce qu'il a dans le dos.
    this.center.copy(target).addScaledVector(forward, this.radius * 0.35);
    this.center.y = target.y;

    const dist = this.radius * 2 + 40;
    const c = this.camera;
    c.position.copy(this.center).addScaledVector(sunDir, dist);
    // Soleil au zénith : l'axe « haut » par défaut devient dégénéré.
    c.up.copy(Math.abs(sunDir.y) > 0.985 ? UP_ALT : UP);
    c.lookAt(this.center);
    c.updateMatrixWorld(true);

    // Alignement sur la grille de texels, dans l'espace de la lumière.
    const texel = this.texelWorldSize;
    const p = this.center.clone().applyMatrix4(c.matrixWorldInverse);
    const dx = p.x - Math.round(p.x / texel) * texel;
    const dy = p.y - Math.round(p.y / texel) * texel;
    this.right.setFromMatrixColumn(c.matrixWorld, 0);
    this.up.setFromMatrixColumn(c.matrixWorld, 1);
    c.position.addScaledVector(this.right, dx).addScaledVector(this.up, dy);
    c.updateMatrixWorld(true);

    this.matrix.multiplyMatrices(BIAS, c.projectionMatrix).multiply(c.matrixWorldInverse);
  }

  dispose(): void {
    this.target.dispose();
  }
}
