import { Game } from './core/Game';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const loadingBar = document.getElementById('loading-bar') as HTMLElement;
const loadingText = document.getElementById('loading-text') as HTMLElement;
const loading = document.getElementById('loading') as HTMLElement;

function fail(message: string): void {
  loadingText.textContent = message;
  loadingText.style.color = '#e0503f';
  loadingBar.style.background = '#e0503f';
}

async function start(): Promise<void> {
  // WebGL2 est requis : l'atlas utilise un tableau de textures et les shaders
  // sont écrits en GLSL ES 3.0.
  // Sonde sur un canevas jetable : le canevas de rendu doit garder ses propres
  // attributs de contexte, fixés par Three.
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) {
    fail('WebGL 2 est indisponible sur cet appareil ou ce navigateur.');
    return;
  }

  const game = new Game(canvas);
  // Poignée de débogage : utile en console navigateur et pour les tests.
  (window as unknown as { voxelcraft: Game }).voxelcraft = game;
  try {
    await game.boot((p, label) => {
      loadingBar.style.width = `${Math.round(p * 100)}%`;
      loadingText.textContent = label;
    });
    loading.classList.add('done');
  } catch (err) {
    console.error(err);
    fail(`Erreur au démarrage : ${(err as Error).message}`);
  }
}

void start();
