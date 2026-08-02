/**
 * Entrées unifiées : clavier/souris avec verrouillage du pointeur, molette,
 * et couche tactile (joystick virtuel + zone de visée) pour les mobiles.
 */

export interface InputState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sneak: boolean;
  sprint: boolean;
  attack: boolean;
  use: boolean;
  /** Déplacement de la visée accumulé depuis la dernière lecture. */
  lookX: number;
  lookY: number;
  /** Axes analogiques du joystick tactile, dans [-1, 1]. */
  moveX: number;
  moveY: number;
}

export type Binding = keyof Omit<InputState, 'lookX' | 'lookY' | 'moveX' | 'moveY'>;

export const DEFAULT_BINDINGS: Record<string, Binding> = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  ArrowUp: 'forward',
  ArrowDown: 'back',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'sneak',
  ShiftRight: 'sneak',
  ControlLeft: 'sprint',
};

type Listener = (e: KeyboardEvent) => void;

export class Input {
  readonly state: InputState = {
    forward: false, back: false, left: false, right: false,
    jump: false, sneak: false, sprint: false, attack: false, use: false,
    lookX: 0, lookY: 0, moveX: 0, moveY: 0,
  };

  bindings: Record<string, Binding> = { ...DEFAULT_BINDINGS };
  sensitivity = 1;
  invertY = false;
  locked = false;
  touchEnabled = false;

  /** Touches pressées cette image (pour les actions ponctuelles). */
  private pressed = new Set<string>();
  private justPressed = new Set<string>();
  private wheelDelta = 0;
  private keyListeners = new Map<string, Listener[]>();
  private anyKeyListeners: Listener[] = [];
  private onLockChange?: (locked: boolean) => void;

  private touchLook = -1;
  private touchMove = -1;
  private touchOrigin = { x: 0, y: 0 };
  private touchLast = { x: 0, y: 0 };

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.releaseAll);
    canvas.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mouseup', this.handleMouseUp);
    window.addEventListener('mousemove', this.handleMouseMove);
    canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', this.handleLockChange);

    canvas.addEventListener('touchstart', this.handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', this.handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', this.handleTouchEnd);
    canvas.addEventListener('touchcancel', this.handleTouchEnd);
  }

  // --- Clavier ------------------------------------------------------------

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) {
      this.dispatch(e);
      return;
    }
    this.pressed.add(e.code);
    this.justPressed.add(e.code);
    const b = this.bindings[e.code];
    if (b) {
      this.state[b] = true;
      if (this.locked) e.preventDefault();
    }
    this.dispatch(e);
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    this.pressed.delete(e.code);
    const b = this.bindings[e.code];
    if (b) this.state[b] = false;
  };

  private dispatch(e: KeyboardEvent): void {
    for (const l of this.keyListeners.get(e.code) ?? []) l(e);
    for (const l of this.anyKeyListeners) l(e);
  }

  private releaseAll = (): void => {
    this.pressed.clear();
    for (const k of Object.keys(this.state) as (keyof InputState)[]) {
      if (typeof this.state[k] === 'boolean') (this.state[k] as boolean) = false;
    }
    this.state.moveX = 0;
    this.state.moveY = 0;
  };

  onKey(code: string, fn: Listener): void {
    const list = this.keyListeners.get(code) ?? [];
    list.push(fn);
    this.keyListeners.set(code, list);
  }

  onAnyKey(fn: Listener): void {
    this.anyKeyListeners.push(fn);
  }

  isDown(code: string): boolean {
    return this.pressed.has(code);
  }

  consumePressed(code: string): boolean {
    if (!this.justPressed.has(code)) return false;
    this.justPressed.delete(code);
    return true;
  }

  endFrame(): void {
    this.justPressed.clear();
    this.state.lookX = 0;
    this.state.lookY = 0;
    this.wheelDelta = 0;
  }

  // --- Souris -------------------------------------------------------------

  /** Clic milieu : demande de « prendre le bloc visé », consommée une fois. */
  private pickPending = false;

  private handleMouseDown = (e: MouseEvent): void => {
    if (!this.locked) return;
    if (e.button === 0) this.state.attack = true;
    if (e.button === 2) this.state.use = true;
    if (e.button === 1) {
      e.preventDefault();
      this.pickPending = true;
    }
  };

  takePick(): boolean {
    const p = this.pickPending;
    this.pickPending = false;
    return p;
  }

  private handleMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.state.attack = false;
    if (e.button === 2) this.state.use = false;
  };

  private handleMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    this.state.lookX += e.movementX * 0.0022 * this.sensitivity;
    this.state.lookY += e.movementY * 0.0022 * this.sensitivity * (this.invertY ? -1 : 1);
  };

  private handleWheel = (e: WheelEvent): void => {
    if (!this.locked) return;
    e.preventDefault();
    this.wheelDelta += Math.sign(e.deltaY);
  };

  takeWheel(): number {
    const d = this.wheelDelta;
    this.wheelDelta = 0;
    return d;
  }

  // --- Verrouillage du pointeur ------------------------------------------

  requestLock(): void {
    if (this.touchEnabled) return;
    void this.canvas.requestPointerLock();
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  setLockHandler(fn: (locked: boolean) => void): void {
    this.onLockChange = fn;
  }

  private handleLockChange = (): void => {
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) {
      this.state.attack = false;
      this.state.use = false;
      this.releaseAll();
    }
    this.onLockChange?.(this.locked);
  };

  // --- Tactile ------------------------------------------------------------

  private handleTouchStart = (e: TouchEvent): void => {
    this.touchEnabled = true;
    for (const t of Array.from(e.changedTouches)) {
      const leftHalf = t.clientX < window.innerWidth * 0.4;
      if (leftHalf && this.touchMove < 0) {
        this.touchMove = t.identifier;
        this.touchOrigin = { x: t.clientX, y: t.clientY };
      } else if (!leftHalf && this.touchLook < 0) {
        this.touchLook = t.identifier;
        this.touchLast = { x: t.clientX, y: t.clientY };
      }
    }
    e.preventDefault();
  };

  private handleTouchMove = (e: TouchEvent): void => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.touchMove) {
        const dx = (t.clientX - this.touchOrigin.x) / 60;
        const dy = (t.clientY - this.touchOrigin.y) / 60;
        this.state.moveX = Math.max(-1, Math.min(1, dx));
        this.state.moveY = Math.max(-1, Math.min(1, dy));
      } else if (t.identifier === this.touchLook) {
        this.state.lookX += (t.clientX - this.touchLast.x) * 0.005 * this.sensitivity;
        this.state.lookY += (t.clientY - this.touchLast.y) * 0.005 * this.sensitivity * (this.invertY ? -1 : 1);
        this.touchLast = { x: t.clientX, y: t.clientY };
      }
    }
    e.preventDefault();
  };

  private handleTouchEnd = (e: TouchEvent): void => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.touchMove) {
        this.touchMove = -1;
        this.state.moveX = 0;
        this.state.moveY = 0;
      }
      if (t.identifier === this.touchLook) this.touchLook = -1;
    }
  };

  /** Boutons tactiles exposés par l'interface (casser, poser, sauter…). */
  setVirtual(button: 'attack' | 'use' | 'jump' | 'sneak', value: boolean): void {
    this.state[button] = value;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.releaseAll);
    window.removeEventListener('mouseup', this.handleMouseUp);
    window.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('pointerlockchange', this.handleLockChange);
  }
}
