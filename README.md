# VoxelCraft

Un bac à sable voxel façon Minecraft, entièrement jouable dans le navigateur.
Monde infini généré procéduralement, survie, artisanat, créatures, cycle
jour/nuit, météo et rendu avancé — le tout sans aucun asset externe : textures,
icônes et sons sont **synthétisés au démarrage**.

Pile technique : **TypeScript + Vite + Three.js (WebGL 2 / GLSL ES 3.0)**,
avec un pool de **Web Workers** pour la génération de terrain et le maillage.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # bundle de production dans dist/
npm run preview  # sert le bundle construit
```

WebGL 2 est requis (tableau de textures, shaders GLSL 3).

---

## Ce que le jeu contient

### Monde

- **Terrain infini** en colonnes de 16 × 128 × 16, streamé autour du joueur.
- Génération pilotée par un **climat à cinq bruits** (continentalité, érosion,
  relief, température, humidité) combinés par courbes splines : océans, plages,
  plaines, forêts, taïgas, jungles, marais, savanes, déserts, mesas, alpages et
  sommets rocheux — **17 biomes** aux teintes, brumes et végétations propres.
- **Grottes** creusées par intersection de bruits *ridged* (tunnels) et de
  poches volumineuses en profondeur, échantillonnées sur grille grossière puis
  interpolées ; lacs de lave au fond.
- **Filons de minerai** par marche aléatoire (charbon, fer, or, redstone,
  lapis, diamant, émeraude) avec plages d'altitude distinctes.
- **Végétation** : 8 formes d'arbres (chêne, grand chêne, bouleau, sapin,
  grand sapin, acajou, acacia, chêne de marais), cactus, cannes à sucre,
  fleurs, fougères, champignons, citrouilles. Les structures qui débordent d'un
  chunk sont reportées sur les chunks voisins.
- **~95 blocs** : roches et variantes, minerais, quatre essences de bois,
  verre, glace, 15 couleurs de laine, blocs décoratifs, établi, four, coffre,
  TNT, sources de lumière…

### Rendu

- **Greedy meshing** dans des workers, avec **occlusion ambiante par sommet** et
  **éclairage lissé** ; les attributs sont compactés dans un seul flottant
  (index de texture, AO, lumière du ciel, lumière de bloc, mode d'animation,
  profondeur d'eau).
- **Ombres portées du soleil** : carte d'ombre orthographique suivant le joueur,
  centre aligné sur la grille de texels, PCF 3×3, biais dépendant de
  l'inclinaison, feuillages alpha-testés dans la passe de profondeur, intensité
  fondue au crépuscule.
- **Propagation de lumière** incrémentale, budgétée par image : lumière du ciel
  en colonne puis diffusion, lumière de bloc (torches, lave, pierre lumineuse),
  avec algorithmes d'ajout **et** de retrait corrects lorsqu'on casse ou pose.
- **Atlas procédural** : chaque tuile 32×32 est peinte au démarrage dans un
  `DataArrayTexture` (fissures en marche aléatoire, motifs cellulaires, briques,
  cernes et nœuds du bois, strates, trame tissée, silhouettes de plantes), ce
  qui supprime tout saignement d'atlas et donne des mipmaps propres.
- **Relief par pixel** : chaque peintre produit un champ de hauteur d'où l'on
  dérive une carte de normales tangentes, plus une rugosité par matériau. Le
  repère tangent est reconstruit depuis les dérivées d'écran, et un spéculaire
  solaire distingue les métaux et la glace de la laine et de la terre.
- **Ciel volumétrique** : dégradé atmosphérique, halo de diffusion solaire,
  disque solaire, lune avec phase, champ d'étoiles scintillantes et couche
  nuageuse projetée en perspective à altitude constante.
- **Post-traitement maison** (sans addons Three) : extraction des hautes
  lumières, flou gaussien séparable sur trois échelles, **bloom**, **rayons
  crépusculaires** échantillonnés radialement, effet **sous-marin** (ondulation
  et teinte), vignette, étalonnage, tonemap **ACES** et **FXAA**.
- **Eau** : surface abaissée et animée, normales ondulées, scintillement à deux
  lobes, Fresnel, transparence triée. La **profondeur de la colonne d'eau est
  calculée par le mailleur**, ce qui donne l'absorption (turquoise sur les
  hauts-fonds, bleu profond au large) sans passe de profondeur supplémentaire,
  ainsi que l'**écume** sur les rives et les **caustiques** animées projetées
  sur les fonds immergés.
- Feuillages et herbes qui **ondulent au vent** (amplifié par la pluie),
  brouillard atmosphérique teinté par le biome, particules de blocs cassés,
  gerbes d'eau, étincelles d'explosion, pluie et neige.

### Jeu

- **Trois modes** : survie, créatif (vol par double appui sur Espace),
  spectateur.
- **Minage** dépendant du bloc et de l'outil : durée, niveau requis, butin
  conditionnel, usure des outils, particules et sons par matériau.
- **Inventaire complet** : 36 emplacements + barre rapide, 4 emplacements
  d'armure, glisser-déposer (clic gauche/droit, `Maj`+clic pour le transfert
  rapide), infobulles détaillées, sélecteur d'objets filtrable en créatif.
- **Artisanat** : grille 2×2 dans l'inventaire, 3×3 sur un établi, plus de
  **90 recettes** (outils et armures des 5 matériaux, blocs compacts, teinture
  de la laine, TNT, papier, livres…), avec ingrédients alternatifs.
- **Four** fonctionnel : combustion, progression de cuisson, table de fusion
  (minerais, verre, briques, cuisson des viandes) ; **coffres** de 27 cases.
- **Créatures** : cochon, vache, mouton, poule, zombie, squelette, creeper,
  araignée — modèles articulés animés, IA d'errance et de poursuite, apparition
  selon la lumière et l'heure, butins, expérience. Les creepers **explosent** et
  creusent le terrain.
- **Survie** : vie, faim et saturation, souffle sous l'eau, dégâts de chute, de
  lave, de cactus et de famine, régénération, armure et réduction de dégâts,
  écran de mort et réapparition.
- **Physique** : collisions AABB par axe avec résolution dichotomique, nage,
  vol, accroupissement (qui empêche de tomber d'un rebord), saut automatique
  optionnel, sable et gravier qui tombent.
- **Sauvegarde IndexedDB** : plusieurs mondes, seuls les blocs modifiés sont
  stockés (le terrain est reproductible depuis la graine), position, inventaire,
  armure, heure et temps de jeu ; sauvegarde automatique.
- **Console de commandes** : `/gamemode`, `/tp`, `/time`, `/give`, `/meteo`,
  `/seed`, `/tuer`, `/aide`.
- **Audio 100 % procédural** (Web Audio) : impacts filtrés par matériau, pas,
  cris de créatures, explosions, nappe d'ambiance jour/nuit.
- **Options** : distance de rendu, FOV, échelle de résolution et d'interface,
  bloom, rayons crépusculaires, FXAA, nuages, météo, particules, oscillation de
  caméra, sensibilité, volumes, nombre de créatures.
- **Contrôles tactiles** détectés automatiquement (joystick virtuel, zone de
  visée, boutons d'action).

---

## Contrôles

| Touche | Action |
| --- | --- |
| `Z Q S D` / `W A S D` | Se déplacer |
| `Espace` | Sauter — double appui : voler (créatif) |
| `Maj` | S'accroupir / descendre en vol |
| `Ctrl` | Courir |
| Clic gauche | Casser un bloc / attaquer |
| Clic droit | Poser un bloc / utiliser / ouvrir un conteneur |
| Molette, `1`-`9` | Changer d'objet |
| `E` | Inventaire |
| `Q` | Jeter l'objet tenu |
| `F` / `F5` | Vue à la troisième personne |
| `F3` | Informations de débogage |
| `T` ou `/` | Console de commandes |
| `Échap` | Pause |

---

## Architecture

```
src/
  core/        constantes, entrées (clavier/souris/tactile), réglages, boucle de jeu
  world/       registre des blocs, bruits, biomes, générateur, mailleur, monde, pool de workers
  workers/     worker polyvalent (génération + maillage)
  render/      atlas procédural, matériaux GLSL 3, ciel, post-traitement, particules, streaming
  player/      physique AABB, lancer de rayon DDA, état et vitalité du joueur
  items/       registre d'objets, recettes, inventaire et conteneurs
  entities/    créatures (modèles, IA) et objets au sol
  ui/          HUD, écrans, icônes générées, feuille de style
  audio/       synthèse sonore Web Audio
  save/        persistance IndexedDB
```

Quelques points de conception :

- **Rien n'est calculé deux fois entre les threads.** Le registre de blocs est
  importé aussi bien par le thread principal que par les workers ; les index de
  textures découlent de l'ordre d'enregistrement, ce qui garantit des valeurs
  identiques des deux côtés sans échange de message.
- **Le maillage reçoit un volume étendu** de 18 × 128 × 18 (le chunk plus une
  marge d'un voxel copiée depuis les huit voisins), transféré en zéro-copie et
  recyclé dans un pool de tampons.
- **La lumière n'est amorcée que là où elle peut changer** : au-dessus de la
  crête locale, la lumière du ciel vaut 15 partout et la diffusion latérale
  serait inutile. Cette borne fait passer la file d'attente de ~10⁶ à ~10⁴
  opérations sur une distance de rendu de 8 chunks.
- **Le rendu est linéaire de bout en bout** : les textures sRGB sont converties
  par le GPU, les teintes de sommets sont linéarisées dans le shader, et
  l'encodage sRGB n'a lieu qu'à la toute dernière passe.

## Limites connues

- Les contenus de fours et de coffres vivent en mémoire pour la session : ils
  ne sont pas encore écrits dans IndexedDB (les blocs, eux, le sont).
- Les fluides ne s'écoulent pas ; l'eau et la lave sont statiques.
- Une seule cascade d'ombre : au-delà du rayon couvert (48 à 110 blocs selon la
  distance de rendu), les ombres s'estompent au lieu de se prolonger.
- La lumière de bloc est monochrome : une torche et une lanterne aquatique
  éclairent de la même teinte.
