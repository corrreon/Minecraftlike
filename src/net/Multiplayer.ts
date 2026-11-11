/**
 * Connexion à une partie multijoueur (serveur Cloudflare, voir `server/`).
 *
 * Le jeu reste maître de son monde : cette classe ne fait que transporter des
 * messages — positions, blocs modifiés, arrivées et départs — et regrouper
 * les blocs en lots pour ne pas envoyer un message par clic.
 */

/** Adresse du serveur, fixée à la construction du site (voir le déploiement). */
export const MULTI_URL: string = (import.meta.env.VITE_MP_URL as string | undefined) ?? '';

export const PROTOCOL = 1;

export type Edit = [number, number, number, number];

export interface RemotePlayerInfo {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
}

export interface Welcome {
  you: number;
  owner: boolean;
  created: boolean;
  seed: number;
  type: 'normal' | 'flat' | 'oneblock';
  mode: number;
  host: string;
  players: RemotePlayerInfo[];
  edits: number;
}

export interface NetHandlers {
  onWelcome(w: Welcome): void;
  onOwnerToken(token: string): void;
  onBlocks(edits: Edit[]): void;
  onReady(): void;
  onJoin(id: number, name: string): void;
  onLeave(id: number): void;
  onPos(id: number, x: number, y: number, z: number, yaw: number, pitch: number, dimension: string): void;
  onChat(name: string, text: string): void;
  onError(message: string, fatal: boolean): void;
  onClose(): void;
}

export interface HelloOptions {
  name: string;
  pass: string;
  /** Création ou reprise d'une partie par l'hôte. */
  host?: { seed: number; type: string; mode: number; owner?: string };
}

/** Code de partie : 22 caractères aléatoires, soit 132 bits — impossible à deviner. */
export function newRoomCode(): string {
  const b = new Uint8Array(17);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
}

/** Extrait le code d'un lien d'invitation, ou accepte le code seul. */
export function parseRoomCode(text: string): string | null {
  const t = text.trim();
  const m = /[?&]partie=([A-Za-z0-9_-]{16,64})/.exec(t);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{16,64}$/.test(t) ? t : null;
}

/** Lien à partager : la page du jeu, avec le code de la partie. */
export function inviteLink(room: string): string {
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('partie', room);
  return u.toString();
}

export class NetSession {
  readonly room: string;
  private ws: WebSocket | null = null;
  private pendingEdits: Edit[] = [];
  private closedByUs = false;
  connected = false;

  constructor(room: string, private handlers: NetHandlers) {
    this.room = room;
  }

  connect(hello: HelloOptions): void {
    const base = MULTI_URL.replace(/^http/, 'ws').replace(/\/$/, '');
    const ws = new WebSocket(`${base}/partie/${this.room}`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      ws.send(JSON.stringify({
        t: 'hello', v: PROTOCOL, name: hello.name, pass: hello.pass,
        ...(hello.host ? { host: true, seed: hello.host.seed, type: hello.host.type, mode: hello.host.mode, owner: hello.host.owner ?? '' } : {}),
      }));
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => { /* suivi d'un close */ };
    ws.onclose = () => {
      this.connected = false;
      if (!this.closedByUs) this.handlers.onClose();
    };
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let m: Record<string, unknown>;
    try { m = JSON.parse(raw); } catch { return; }
    const h = this.handlers;
    switch (m.t) {
      case 'welcome': h.onWelcome(m as unknown as Welcome); break;
      case 'owner': h.onOwnerToken(String(m.token)); break;
      case 'blocks': if (Array.isArray(m.e)) h.onBlocks(m.e as Edit[]); break;
      case 'ready': h.onReady(); break;
      case 'join': h.onJoin(Number(m.id), String(m.name)); break;
      case 'leave': h.onLeave(Number(m.id)); break;
      case 'pos':
        h.onPos(Number(m.id), Number(m.x), Number(m.y), Number(m.z), Number(m.yaw), Number(m.pitch), String(m.d ?? 'overworld'));
        break;
      case 'chat': h.onChat(String(m.name), String(m.text)); break;
      case 'error': h.onError(String(m.msg), m.fatal === true); break;
    }
  }

  private send(data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
  }

  sendPos(x: number, y: number, z: number, yaw: number, pitch: number, dimension: string): void {
    this.send({ t: 'pos', x: round2(x), y: round2(y), z: round2(z), yaw: round2(yaw), pitch: round2(pitch), d: dimension });
  }

  queueEdit(x: number, y: number, z: number, id: number): void {
    this.pendingEdits.push([x, y, z, id]);
  }

  /** Envoie les blocs modifiés depuis le dernier appel, en un seul message. */
  flush(): void {
    while (this.pendingEdits.length > 0) {
      this.send({ t: 'blocks', e: this.pendingEdits.splice(0, 200) });
    }
  }

  /** Téléverse le monde de l'hôte, par lots, à la création de la partie. */
  upload(edits: Edit[]): void {
    for (let i = 0; i < edits.length; i += 4000) this.send({ t: 'upload', e: edits.slice(i, i + 4000) });
  }

  chat(text: string): void {
    this.send({ t: 'chat', text });
  }

  close(): void {
    this.closedByUs = true;
    this.connected = false;
    this.ws?.close(1000, 'Départ');
    this.ws = null;
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
