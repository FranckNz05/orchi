/**
 * Globe filaire anime, en canvas 2D pur.
 *
 * Aucune dependance : une bibliotheque 3D pour un decor couterait plusieurs
 * centaines de kilo-octets sur la premiere page, exactement la ou la vitesse de
 * chargement compte le plus.
 *
 * Le globe est CENTRE SUR L'AFRIQUE et ne tourne que lentement : c'est un
 * decor, pas une attraction. Les points sont les pays reellement au catalogue,
 * et les arcs figurent des flux entre eux.
 *
 * Trois garde-fous, parce qu'une animation de fond ne doit jamais degrader
 * l'usage :
 *   - `prefers-reduced-motion` : rendu statique, une seule image.
 *   - onglet masque : l'animation est suspendue.
 *   - ecran etroit : moins de points et pas d'arcs.
 */
(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;

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

  function project(latDeg, lonDeg, rotation) {
    const lat = latDeg * DEG;
    const lon = lonDeg * DEG + rotation;
    return {
      x: Math.cos(lat) * Math.sin(lon),
      y: Math.sin(lat),
      z: Math.cos(lat) * Math.cos(lon),
    };
  }

  function start(canvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue('--accent').trim() || '#3ec99f';
    const faint = style.getPropertyValue('--globe-line').trim() || 'rgba(255,255,255,.10)';

    let width = 0;
    let height = 0;
    let radius = 0;
    let cx = 0;
    let cy = 0;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      radius = Math.min(width, height) * 0.42;
      cx = width / 2;
      cy = height / 2;
    }

    const byCode = new Map(PLACES.map((p) => [p[0], p]));
    const flows = FLOWS.map(([a, b], i) => ({
      a: byCode.get(a),
      b: byCode.get(b),
      // Decalage initial pour que les impulsions ne partent pas ensemble.
      phase: i / FLOWS.length,
    })).filter((f) => f.a && f.b);

    function draw(time) {
      // Une rotation complete en deux minutes : perceptible sans distraire.
      const rotation = reduced ? -0.35 : (time / 120000) * TAU - 0.35;

      ctx.clearRect(0, 0, width, height);

      // Halo
      const glow = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius * 1.5);
      glow.addColorStop(0, accent + '22');
      glow.addColorStop(1, 'transparent');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);

      // Paralleles et meridiens : seule la face avant est tracee, ce qui donne
      // la profondeur sans avoir a gerer d'occultation.
      ctx.lineWidth = 1;
      ctx.strokeStyle = faint;

      for (let lat = -60; lat <= 60; lat += 30) {
        ctx.beginPath();
        let started = false;
        for (let lon = 0; lon <= 360; lon += 4) {
          const p = project(lat, lon, rotation);
          if (p.z < 0) { started = false; continue; }
          const sx = cx + p.x * radius;
          const sy = cy - p.y * radius;
          if (started) ctx.lineTo(sx, sy); else { ctx.moveTo(sx, sy); started = true; }
        }
        ctx.stroke();
      }

      for (let lon = 0; lon < 360; lon += 30) {
        ctx.beginPath();
        let started = false;
        for (let lat = -90; lat <= 90; lat += 3) {
          const p = project(lat, lon, rotation);
          if (p.z < 0) { started = false; continue; }
          const sx = cx + p.x * radius;
          const sy = cy - p.y * radius;
          if (started) ctx.lineTo(sx, sy); else { ctx.moveTo(sx, sy); started = true; }
        }
        ctx.stroke();
      }

      // Limbe
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TAU);
      ctx.strokeStyle = accent + '55';
      ctx.stroke();

      // Flux : une impulsion parcourt l'arc, et ne s'affiche que si ses deux
      // extremites sont sur la face visible.
      if (!reduced && width > 520) {
        for (const flow of flows) {
          const a = project(flow.a[1], flow.a[2], rotation);
          const b = project(flow.b[1], flow.b[2], rotation);
          if (a.z < 0.05 || b.z < 0.05) continue;

          const ax = cx + a.x * radius;
          const ay = cy - a.y * radius;
          const bx = cx + b.x * radius;
          const by = cy - b.y * radius;
          // Point de controle pousse vers l'exterieur : l'arc semble survoler
          // la sphere plutot que la traverser.
          const mx = (ax + bx) / 2;
          const my = (ay + by) / 2;
          const nx = mx - cx;
          const ny = my - cy;
          const len = Math.hypot(nx, ny) || 1;
          const qx = mx + (nx / len) * radius * 0.22;
          const qy = my + (ny / len) * radius * 0.22;

          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.quadraticCurveTo(qx, qy, bx, by);
          ctx.strokeStyle = accent + '33';
          ctx.stroke();

          const t = ((time / 4200) + flow.phase) % 1;
          const it = 1 - t;
          const px = it * it * ax + 2 * it * t * qx + t * t * bx;
          const py = it * it * ay + 2 * it * t * qy + t * t * by;
          ctx.beginPath();
          ctx.arc(px, py, 2.6, 0, TAU);
          ctx.fillStyle = accent;
          ctx.fill();
        }
      }

      // Pays
      for (let i = 0; i < PLACES.length; i += 1) {
        const [, lat, lon] = PLACES[i];
        const p = project(lat, lon, rotation);
        if (p.z < 0) continue;

        // Les points proches du limbe s'estompent : sans cela ils clignotent en
        // apparaissant d'un coup au bord du disque.
        const alpha = Math.min(1, p.z * 2.2);
        const pulse = reduced ? 1 : 0.75 + 0.25 * Math.sin(time / 900 + i);
        const sx = cx + p.x * radius;
        const sy = cy - p.y * radius;

        ctx.beginPath();
        ctx.arc(sx, sy, 1.9 * pulse, 0, TAU);
        ctx.fillStyle = accent;
        ctx.globalAlpha = alpha;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    let frame = null;
    function loop(time) {
      draw(time);
      frame = requestAnimationFrame(loop);
    }

    function play() {
      if (frame === null && !reduced) frame = requestAnimationFrame(loop);
    }
    function pause() {
      if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    }

    resize();
    if (reduced) {
      draw(0);
    } else {
      play();
    }

    window.addEventListener('resize', () => { resize(); if (reduced) draw(0); });
    // Un onglet en arriere-plan ne doit pas consommer de CPU.
    document.addEventListener('visibilitychange', () => (document.hidden ? pause() : play()));
  }

  const canvas = document.getElementById('globe');
  if (canvas) start(canvas);
})();
