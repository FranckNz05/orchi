/**
 * Globe a points, en canvas 2D pur.
 *
 * Aucune dependance : une bibliotheque 3D pour un decor couterait plusieurs
 * centaines de kilo-octets sur la premiere page, exactement la ou la vitesse de
 * chargement compte le plus. Tout ce qui suit tient en une projection
 * orthographique de quelques lignes.
 *
 * PARTI PRIS GEOGRAPHIQUE — seule l'Afrique est dessinee comme une terre. Le
 * reste de la sphere est une trame de points reguliere, sans continent. Ce
 * n'est pas une approximation paresseuse mais un choix : dessiner de memoire
 * des cotes que je ne peux pas verifier produirait une carte fausse, et une
 * carte fausse sur un produit pan-africain se remarque. La trame dit « le
 * monde », le trace dit « l'Afrique », et rien n'est affirme a tort.
 *
 * Quatre garde-fous, parce qu'une animation de fond ne doit jamais degrader
 * l'usage :
 *   - `prefers-reduced-motion` : rendu statique, une seule image ;
 *   - onglet masque : l'animation est suspendue ;
 *   - ecran etroit : moins de points, pas d'arcs, pas d'etoiles ;
 *   - la geometrie des terres est calculee UNE fois, pas a chaque image.
 */
(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;

  /**
   * Contour de l'Afrique continentale, en [longitude, latitude], sens horaire
   * depuis Tanger. Une soixantaine de points : assez pour que la silhouette
   * soit reconnaissable au premier coup d'oeil, pas assez pour pretendre a
   * l'exactitude cartographique. C'est un decor, pas un atlas.
   */
  const AFRICA = [
    [-5.9, 35.8], [-2.2, 35.1], [0.2, 36.0], [3.1, 36.8], [5.8, 36.9], [8.6, 37.1],
    [10.3, 36.9], [11.1, 35.5], [10.6, 34.3], [11.0, 33.5], [11.5, 33.2], [15.2, 32.4],
    [20.0, 32.2], [23.1, 32.2], [25.0, 31.5], [27.2, 31.2], [29.9, 31.2], [32.3, 31.1],
    [34.2, 31.3], [34.3, 29.5], [33.0, 28.0], [34.0, 27.5], [34.5, 24.0], [35.6, 22.0],
    [37.2, 18.7], [38.6, 17.9], [39.1, 15.6], [40.0, 14.5], [41.8, 13.5], [43.1, 12.7],
    [44.0, 11.6], [45.0, 11.0], [47.0, 11.0], [49.0, 11.3], [51.3, 11.8], [51.0, 10.4],
    [49.5, 8.0], [48.0, 5.5], [46.0, 3.0], [44.0, 1.8], [42.5, -0.4], [39.7, -4.0],
    [39.3, -6.8], [40.2, -10.3], [40.5, -12.9], [39.9, -16.2], [34.9, -19.8],
    [35.4, -23.9], [32.6, -25.9], [31.0, -29.9], [27.9, -33.0], [25.6, -34.0],
    [20.0, -34.8], [18.4, -34.0], [15.2, -26.6], [14.5, -22.9], [11.8, -17.2],
    [12.2, -15.2], [13.2, -8.8], [12.3, -6.0], [9.4, 0.4], [9.7, 4.0], [8.3, 4.6],
    [6.0, 4.3], [3.4, 6.4], [1.2, 6.1], [-0.2, 5.5], [-4.0, 5.3], [-7.7, 4.4],
    [-10.8, 6.3], [-13.2, 8.5], [-13.7, 9.5], [-15.6, 11.9], [-17.5, 14.7],
    [-16.0, 18.1], [-17.0, 21.0], [-15.9, 23.7], [-13.2, 27.1], [-9.6, 30.4],
    [-7.6, 33.6], [-6.8, 34.0],
  ];

  /** Madagascar, meme convention. */
  const MADAGASCAR = [
    [43.2, -25.6], [45.2, -25.5], [47.1, -25.2], [48.5, -23.5], [49.5, -21.5],
    [50.0, -19.0], [49.9, -16.5], [50.5, -15.4], [50.2, -14.0], [49.3, -12.1],
    [48.0, -13.5], [46.3, -15.7], [44.5, -16.2], [44.0, -18.0], [43.5, -20.5],
    [43.3, -23.0],
  ];

  /**
   * Centroides approximatifs des 54 pays. Approximatifs et assumes : il s'agit
   * de placer un point lumineux, pas de tracer une frontiere.
   */
  const PLACES = [
    ['DZ', 28.0, 1.7], ['AO', -11.2, 17.9], ['BJ', 9.3, 2.3], ['BW', -22.3, 24.7],
    ['BF', 12.2, -1.6], ['BI', -3.4, 29.9], ['CV', 16.0, -24.0], ['CM', 7.4, 12.3],
    ['CF', 6.6, 20.9], ['TD', 15.5, 18.7], ['KM', -11.9, 43.9], ['CG', -0.2, 15.8],
    ['CD', -4.0, 21.8], ['DJ', 11.8, 42.6], ['EG', 26.8, 30.8], ['GQ', 1.7, 10.3],
    ['ER', 15.2, 39.8], ['SZ', -26.5, 31.5], ['ET', 9.1, 40.5], ['GA', -0.8, 11.6],
    ['GM', 13.4, -15.3], ['GH', 7.9, -1.0], ['GN', 9.9, -9.7], ['GW', 11.8, -15.2],
    ['CI', 7.5, -5.5], ['KE', -0.02, 37.9], ['LS', -29.6, 28.2], ['LR', 6.4, -9.4],
    ['LY', 26.3, 17.2], ['MG', -18.8, 46.9], ['MW', -13.3, 34.3], ['ML', 17.6, -4.0],
    ['MR', 21.0, -10.9], ['MU', -20.3, 57.6], ['MA', 31.8, -7.1], ['MZ', -18.7, 35.5],
    ['NA', -22.9, 18.5], ['NE', 17.6, 8.1], ['NG', 9.1, 8.7], ['RW', -1.9, 29.9],
    ['ST', 0.2, 6.6], ['SN', 14.5, -14.5], ['SC', -4.7, 55.5], ['SL', 8.5, -11.8],
    ['SO', 5.2, 46.2], ['ZA', -30.6, 22.9], ['SS', 7.9, 30.0], ['SD', 12.9, 30.2],
    ['TZ', -6.4, 34.9], ['TG', 8.6, 0.8], ['TN', 33.9, 9.5], ['UG', 1.4, 32.3],
    ['ZM', -13.1, 27.8], ['ZW', -19.0, 29.2],
  ];

  /** Corridors mis en avant : ce sont les zones de la phase 1. */
  const FLOWS = [
    ['SN', 'CI'], ['CI', 'BJ'], ['BJ', 'CM'], ['CM', 'CD'],
    ['NG', 'GH'], ['KE', 'TZ'], ['ZA', 'MZ'], ['MA', 'SN'], ['EG', 'KE'],
  ];

  /* ------------------------------------------------------------------------ */
  /* Geometrie                                                                */
  /* ------------------------------------------------------------------------ */

  /** Lancer de rayon horizontal. Le polygone est ferme implicitement. */
  function inside(lon, lat, poly) {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        hit = !hit;
      }
    }
    return hit;
  }

  /**
   * Points de terre, echantillonnes sur une grille en latitude/longitude.
   *
   * Le pas en longitude est divise par le cosinus de la latitude : sans cette
   * correction, les points se resserreraient vers les poles et l'Afrique
   * paraitrait plus dense au Caire qu'au Cap. Calcule une seule fois — la
   * rotation ne change que la projection, jamais la geographie.
   */
  function landPoints(step) {
    const pts = [];
    for (let lat = -36; lat <= 38; lat += step) {
      const span = step / Math.max(0.25, Math.cos(lat * DEG));
      for (let lon = -19; lon <= 53; lon += span) {
        if (inside(lon, lat, AFRICA) || inside(lon, lat, MADAGASCAR)) pts.push([lat, lon]);
      }
    }
    return pts;
  }

  /**
   * Trame de la sphere : distribution de Fibonacci.
   *
   * Une double boucle lat/lon donnerait des points agglutines aux poles et un
   * moirage visible. La spirale dorree repartit les points a peu pres
   * uniformement sur la sphere, ce qui est exactement ce qu'on veut d'une
   * trame de fond.
   */
  function spherePoints(count) {
    const pts = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i += 1) {
      const y = 1 - (i / (count - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      pts.push([Math.cos(theta) * r, y, Math.sin(theta) * r]);
    }
    return pts;
  }

  function project(latDeg, lonDeg, rot, tilt) {
    const lat = latDeg * DEG;
    const lon = lonDeg * DEG + rot;
    const x = Math.cos(lat) * Math.sin(lon);
    const y = Math.sin(lat);
    const z = Math.cos(lat) * Math.cos(lon);
    // Basculement autour de l'axe horizontal : donne au globe une inclinaison
    // et permet au regard de suivre legerement la souris.
    const c = Math.cos(tilt);
    const s = Math.sin(tilt);
    return { x, y: y * c - z * s, z: y * s + z * c };
  }

  function rotatePoint(p, rot, tilt) {
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    const x = p[0] * cr + p[2] * sr;
    const z = -p[0] * sr + p[2] * cr;
    const c = Math.cos(tilt);
    const s = Math.sin(tilt);
    return { x, y: p[1] * c - z * s, z: p[1] * s + z * c };
  }

  /* ------------------------------------------------------------------------ */

  function start(canvas) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = motion.matches;

    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue('--accent').trim() || '#35d6a4';
    const accent2 = style.getPropertyValue('--accent-2').trim() || '#4aa8ff';

    // Direction de la lumiere, en coordonnees ecran. Les points de terre qui
    // lui font face sont plus clairs : c'est ce degrade, et non la taille des
    // points, qui donne le volume.
    const LIGHT = (() => {
      const v = [-0.42, 0.40, 0.82];
      const n = Math.hypot(v[0], v[1], v[2]);
      return [v[0] / n, v[1] / n, v[2] / n];
    })();

    let width = 0, height = 0, radius = 0, cx = 0, cy = 0, small = false;
    let land = [];
    let mesh = [];
    let stars = [];

    // Cible et valeur courante de l'inclinaison : l'ecart entre les deux est
    // resorbe progressivement a chaque image, ce qui evite que le globe ne
    // sursaute a chaque mouvement de souris.
    let tiltTarget = -0.30;
    let tilt = -0.30;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      if (width < 2 || height < 2) return;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      radius = Math.min(width, height * 1.35) * 0.295;
      cx = width / 2;
      cy = height * 0.47;

      small = width < 620;
      // Sur petit ecran, moins de points : la surface a peindre chute autant
      // que la puissance disponible.
      land = landPoints(small ? 1.9 : 1.05);
      mesh = spherePoints(small ? 500 : 1500);
      stars = small ? [] : Array.from({ length: 90 }, (_, i) => ({
        x: (Math.sin(i * 12.9898) * 43758.5453) % 1,
        y: (Math.sin(i * 78.233) * 12345.6789) % 1,
        p: (i % 17) / 17,
      }));
    }

    const byCode = new Map(PLACES.map((p) => [p[0], p]));
    const flows = FLOWS.map(([a, b], i) => ({
      a: byCode.get(a),
      b: byCode.get(b),
      // Decalage initial pour que les impulsions ne partent pas ensemble.
      phase: i / FLOWS.length,
    })).filter((f) => f.a && f.b);

    function draw(time) {
      if (width < 2) return;
      // Une rotation complete en trois minutes : perceptible sans distraire.
      const rot = reduced ? 0.15 : (time / 180000) * TAU + 0.15;
      tilt += (tiltTarget - tilt) * 0.05;

      ctx.clearRect(0, 0, width, height);

      /* --- etoiles ------------------------------------------------------- */
      for (let i = 0; i < stars.length; i += 1) {
        const s = stars[i];
        const sx = Math.abs(s.x) * width;
        const sy = Math.abs(s.y) * height;
        // Ne pas semer d'etoiles sur le globe lui-meme.
        if (Math.hypot(sx - cx, sy - cy) < radius * 1.12) continue;
        const tw = reduced ? 0.5 : 0.35 + 0.35 * Math.sin(time / 1400 + s.p * TAU);
        ctx.globalAlpha = tw * 0.5;
        ctx.fillStyle = '#cfe3f5';
        ctx.fillRect(sx, sy, 1.4, 1.4);
      }
      ctx.globalAlpha = 1;

      /* --- atmosphere ---------------------------------------------------- */
      const halo = ctx.createRadialGradient(cx, cy, radius * 0.72, cx, cy, radius * 1.55);
      halo.addColorStop(0, 'rgba(53,214,164,.16)');
      halo.addColorStop(0.45, 'rgba(74,168,255,.07)');
      halo.addColorStop(1, 'transparent');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.55, 0, TAU);
      ctx.fill();

      // Corps de la sphere : un fond tres sombre, sans quoi les etoiles
      // situees derriere transparaitraient a travers la trame.
      const body = ctx.createRadialGradient(
        cx - radius * 0.35, cy - radius * 0.35, radius * 0.1, cx, cy, radius,
      );
      body.addColorStop(0, 'rgba(18,28,38,.92)');
      body.addColorStop(1, 'rgba(6,9,13,.96)');
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TAU);
      ctx.fill();

      /* --- trame de la sphere -------------------------------------------- */
      ctx.fillStyle = 'rgba(150,195,225,.85)';
      for (let i = 0; i < mesh.length; i += 1) {
        const p = rotatePoint(mesh[i], rot, tilt);
        if (p.z < 0.02) continue;
        ctx.globalAlpha = Math.min(1, p.z * 1.9) * 0.34;
        ctx.fillRect(cx + p.x * radius - 0.65, cy - p.y * radius - 0.65, 1.3, 1.3);
      }
      ctx.globalAlpha = 1;

      /* --- terres -------------------------------------------------------- */
      for (let i = 0; i < land.length; i += 1) {
        const [lat, lon] = land[i];
        const p = project(lat, lon, rot, tilt);
        if (p.z < 0.02) continue;
        // Eclairement : produit scalaire avec la direction de la lumiere,
        // ramene dans [0,1] puis adouci pour ne pas noircir le terminateur.
        const lit = Math.max(0, p.x * LIGHT[0] + p.y * LIGHT[1] + p.z * LIGHT[2]);
        const shade = 0.55 + 0.45 * lit;
        // Les points proches du limbe s'estompent : sans cela ils apparaissent
        // d'un coup au bord du disque, et le bord se met a scintiller.
        const edge = Math.min(1, p.z * 3.2);
        ctx.globalAlpha = shade * edge;
        ctx.fillStyle = accent;
        const s = 2.1 + shade * 1.1;
        ctx.fillRect(cx + p.x * radius - s / 2, cy - p.y * radius - s / 2, s, s);
      }
      ctx.globalAlpha = 1;

      /* --- limbe --------------------------------------------------------- */
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TAU);
      ctx.strokeStyle = 'rgba(53,214,164,.34)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.015, 0, TAU);
      ctx.strokeStyle = 'rgba(74,168,255,.13)';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      /* --- flux ---------------------------------------------------------- */
      if (!reduced && !small) {
        for (let i = 0; i < flows.length; i += 1) {
          const flow = flows[i];
          const a = project(flow.a[1], flow.a[2], rot, tilt);
          const b = project(flow.b[1], flow.b[2], rot, tilt);
          if (a.z < 0.08 || b.z < 0.08) continue;

          const ax = cx + a.x * radius, ay = cy - a.y * radius;
          const bx = cx + b.x * radius, by = cy - b.y * radius;
          // Point de controle pousse vers l'exterieur : l'arc semble survoler
          // la sphere plutot que la traverser.
          const mx = (ax + bx) / 2, my = (ay + by) / 2;
          const nx = mx - cx, ny = my - cy;
          const len = Math.hypot(nx, ny) || 1;
          const qx = mx + (nx / len) * radius * 0.28;
          const qy = my + (ny / len) * radius * 0.28;

          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.quadraticCurveTo(qx, qy, bx, by);
          ctx.strokeStyle = 'rgba(53,214,164,.22)';
          ctx.lineWidth = 1;
          ctx.stroke();

          // Impulsion et sa traine : cinq echantillons regulierement espaces
          // en arriere du front, de plus en plus petits et transparents.
          const t = ((time / 5200) + flow.phase) % 1;
          for (let k = 0; k < 5; k += 1) {
            const tk = t - k * 0.028;
            if (tk < 0) continue;
            const it = 1 - tk;
            const px = it * it * ax + 2 * it * tk * qx + tk * tk * bx;
            const py = it * it * ay + 2 * it * tk * qy + tk * tk * by;
            ctx.globalAlpha = (1 - k / 5) * 0.95;
            ctx.beginPath();
            ctx.arc(px, py, 2.7 - k * 0.42, 0, TAU);
            ctx.fillStyle = k === 0 ? '#ffffff' : accent;
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
      }

      /* --- pays ---------------------------------------------------------- */
      for (let i = 0; i < PLACES.length; i += 1) {
        const [, lat, lon] = PLACES[i];
        const p = project(lat, lon, rot, tilt);
        if (p.z < 0.02) continue;

        const edge = Math.min(1, p.z * 2.6);
        const sx = cx + p.x * radius;
        const sy = cy - p.y * radius;

        // Onde qui s'echappe du point, decalee pays par pays pour qu'elles ne
        // battent pas toutes ensemble.
        if (!reduced && !small) {
          const w = ((time / 3000) + i * 0.11) % 1;
          if (w < 0.55) {
            ctx.globalAlpha = (1 - w / 0.55) * 0.32 * edge;
            ctx.beginPath();
            ctx.arc(sx, sy, 2 + w * 13, 0, TAU);
            ctx.strokeStyle = accent2;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }

        ctx.globalAlpha = edge;
        ctx.beginPath();
        ctx.arc(sx, sy, 2.1, 0, TAU);
        ctx.fillStyle = '#eafff7';
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    let frame = null;
    function loop(time) {
      draw(time);
      frame = requestAnimationFrame(loop);
    }
    function play() { if (frame === null && !reduced) frame = requestAnimationFrame(loop); }
    function pause() { if (frame !== null) { cancelAnimationFrame(frame); frame = null; } }

    resize();
    if (reduced) draw(0); else play();

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      // Le recalcul des terres n'est pas gratuit : on attend la fin du
      // redimensionnement plutot que de le refaire a chaque pixel.
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { resize(); if (reduced) draw(0); }, 140);
    });

    // Le globe s'incline legerement vers le pointeur. Amplitude volontairement
    // faible : c'est un signe de vie, pas un jouet.
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      window.addEventListener('pointermove', (e) => {
        tiltTarget = -0.30 + (e.clientY / window.innerHeight - 0.5) * 0.34;
      }, { passive: true });
    }

    // Un onglet en arriere-plan ne doit pas consommer de CPU.
    document.addEventListener('visibilitychange', () => (document.hidden ? pause() : play()));

    // Le reglage systeme peut changer pendant la visite.
    motion.addEventListener('change', (e) => {
      reduced = e.matches;
      if (reduced) { pause(); draw(0); } else play();
    });
  }

  const canvas = document.getElementById('globe');
  if (canvas) start(canvas);
})();
