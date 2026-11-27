'use client';

import { useEffect, useRef } from 'react';

const GRID_SPACING = 36;
const INFLUENCE_RADIUS = 210;
const LERP_POSITION = 0.11;
const LERP_STRENGTH = 0.08;

/**
 * Interactive "Architectural Drafting & Common Thread Field" canvas backdrop
 * for sign-in and candidate onboarding pages. Renders a crisp DPR-scaled
 * precision dot grid that subtly responds to pointer movement with magnetic
 * micro-displacement, miniature crosshairs, and delicate hairline connections.
 */
export function AuthCanvasBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let rafId = 0;
    let isDisposed = false;

    const pointer = {
      targetX: -9999,
      targetY: -9999,
      curX: -9999,
      curY: -9999,
      targetStrength: 0,
      curStrength: 0,
      initialized: false,
    };

    const reducedMotionQuery = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    );
    let prefersReducedMotion = reducedMotionQuery.matches;
    let isDarkTheme = document.documentElement.dataset.theme === 'dark';

    const drawFrame = () => {
      if (width <= 0 || height <= 0) return;

      ctx.clearRect(0, 0, width, height);

      const strength = prefersReducedMotion ? 0 : pointer.curStrength;
      const cx = pointer.curX;
      const cy = pointer.curY;

      // Ambient radial wash under pointer
      if (strength > 0.01 && cx > -1000 && cy > -1000) {
        const grad = ctx.createRadialGradient(
          cx,
          cy,
          0,
          cx,
          cy,
          INFLUENCE_RADIUS * 1.15,
        );
        if (isDarkTheme) {
          grad.addColorStop(0, `rgba(142, 227, 184, ${0.11 * strength})`);
          grad.addColorStop(0.55, `rgba(182, 137, 255, ${0.05 * strength})`);
          grad.addColorStop(1, 'rgba(20, 15, 26, 0)');
        } else {
          grad.addColorStop(0, `rgba(142, 227, 184, ${0.16 * strength})`);
          grad.addColorStop(0.55, `rgba(124, 92, 165, ${0.04 * strength})`);
          grad.addColorStop(1, 'rgba(246, 243, 238, 0)');
        }
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);
      }

      const startX = (width % GRID_SPACING) / 2 || GRID_SPACING / 2;
      const startY = (height % GRID_SPACING) / 2 || GRID_SPACING / 2;
      const cols = Math.ceil((width - startX) / GRID_SPACING) + 1;
      const rows = Math.ceil((height - startY) / GRID_SPACING) + 1;

      interface ActiveNode {
        x: number;
        y: number;
        energy: number;
        col: number;
        row: number;
      }

      const activeGrid = new Map<string, ActiveNode>();

      // Base precision dot matrix + micro-displacement & crosshairs near pointer
      const baseDotColor = isDarkTheme
        ? 'rgba(244, 239, 232, 0.07)'
        : 'rgba(33, 20, 38, 0.08)';
      ctx.fillStyle = baseDotColor;

      for (let r = 0; r < rows; r++) {
        const gy = startY + r * GRID_SPACING;
        for (let c = 0; c < cols; c++) {
          const gx = startX + c * GRID_SPACING;

          let drawX = gx;
          let drawY = gy;
          let energy = 0;

          if (strength > 0.01) {
            const dx = cx - gx;
            const dy = cy - gy;
            const distSq = dx * dx + dy * dy;
            const maxSq = INFLUENCE_RADIUS * INFLUENCE_RADIUS;

            if (distSq < maxSq) {
              const dist = Math.sqrt(distSq);
              const t = 1 - dist / INFLUENCE_RADIUS;
              // Smooth cubic falloff
              const falloff = t * t * (3 - 2 * t);
              energy = falloff * strength;

              if (dist > 0.5) {
                const pull = Math.min(4, falloff * 4.2 * strength);
                drawX = gx + (dx / dist) * pull;
                drawY = gy + (dy / dist) * pull;
              }
            }
          }

          if (energy > 0.14) {
            activeGrid.set(`${c}:${r}`, {
              x: drawX,
              y: drawY,
              energy,
              col: c,
              row: r,
            });
          }

          if (energy > 0.32) {
            // Transform closest nodes into crisp drafting crosshairs (+)
            const arm = 2.4 + energy * 1.6;
            const alpha = Math.min(0.62, 0.14 + energy * 0.48);
            ctx.strokeStyle = isDarkTheme
              ? `rgba(142, 227, 184, ${alpha})`
              : `rgba(20, 83, 45, ${alpha * 0.9})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(drawX - arm, drawY);
            ctx.lineTo(drawX + arm, drawY);
            ctx.moveTo(drawX, drawY - arm);
            ctx.lineTo(drawX, drawY + arm);
            ctx.stroke();
          } else if (energy > 0.04) {
            const dotAlpha = isDarkTheme
              ? 0.07 + energy * 0.28
              : 0.08 + energy * 0.24;
            ctx.fillStyle = isDarkTheme
              ? `rgba(244, 239, 232, ${dotAlpha})`
              : `rgba(75, 40, 104, ${dotAlpha})`;
            ctx.beginPath();
            ctx.arc(drawX, drawY, 1 + energy * 0.55, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = baseDotColor;
          } else {
            ctx.fillRect(drawX - 0.65, drawY - 0.65, 1.3, 1.3);
          }
        }
      }

      // Connect adjacent activated nodes with whisper-quiet Common Thread hairlines
      if (activeGrid.size > 1) {
        ctx.lineWidth = 0.75;
        const neighbors: ReadonlyArray<readonly [number, number]> = [
          [1, 0],
          [0, 1],
          [1, 1],
          [1, -1],
        ];
        for (const node of activeGrid.values()) {
          if (node.energy < 0.24) continue;
          for (const [dc, dr] of neighbors) {
            const peer = activeGrid.get(`${node.col + dc}:${node.row + dr}`);
            if (!peer || peer.energy < 0.24) continue;
            const pairEnergy = Math.min(node.energy, peer.energy);
            const lineAlpha = Math.min(0.24, pairEnergy * 0.26);
            ctx.strokeStyle = isDarkTheme
              ? `rgba(142, 227, 184, ${lineAlpha})`
              : `rgba(75, 40, 104, ${lineAlpha * 0.85})`;
            ctx.beginPath();
            ctx.moveTo(node.x, node.y);
            ctx.lineTo(peer.x, peer.y);
            ctx.stroke();
          }
        }
      }
    };

    const tick = () => {
      rafId = 0;
      if (isDisposed) return;

      if (!prefersReducedMotion && pointer.initialized) {
        pointer.curX += (pointer.targetX - pointer.curX) * LERP_POSITION;
        pointer.curY += (pointer.targetY - pointer.curY) * LERP_POSITION;
        pointer.curStrength +=
          (pointer.targetStrength - pointer.curStrength) * LERP_STRENGTH;
      }

      drawFrame();

      const dx = Math.abs(pointer.targetX - pointer.curX);
      const dy = Math.abs(pointer.targetY - pointer.curY);
      const ds = Math.abs(pointer.targetStrength - pointer.curStrength);
      const needsMore =
        !prefersReducedMotion &&
        pointer.initialized &&
        (dx >= 0.15 || dy >= 0.15 || ds >= 0.005);

      if (needsMore) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    const scheduleRender = () => {
      if (isDisposed || rafId !== 0) return;
      rafId = window.requestAnimationFrame(tick);
    };

    const handleResize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawFrame();
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (prefersReducedMotion) return;
      if (event.pointerType === 'touch') return;

      pointer.targetX = event.clientX;
      pointer.targetY = event.clientY;
      if (!pointer.initialized) {
        pointer.curX = event.clientX;
        pointer.curY = event.clientY;
        pointer.initialized = true;
      }

      const targetEl = event.target as HTMLElement | null;
      const overCard = Boolean(targetEl?.closest?.('.software-document-panel'));
      pointer.targetStrength = overCard ? 0.35 : 1;
      scheduleRender();
    };

    const handlePointerLeave = () => {
      pointer.targetStrength = 0;
      if (!prefersReducedMotion && pointer.initialized) {
        scheduleRender();
      }
    };

    const handleMotionChange = (event: MediaQueryListEvent) => {
      prefersReducedMotion = event.matches;
      if (prefersReducedMotion && rafId !== 0) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      drawFrame();
    };

    const themeObserver = new MutationObserver(() => {
      isDarkTheme = document.documentElement.dataset.theme === 'dark';
      drawFrame();
    });

    handleResize();

    window.addEventListener('resize', handleResize, { passive: true });
    window.addEventListener('pointermove', handlePointerMove, {
      passive: true,
    });
    document.addEventListener('pointerleave', handlePointerLeave, {
      passive: true,
    });
    reducedMotionQuery.addEventListener('change', handleMotionChange);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      isDisposed = true;
      if (rafId !== 0) {
        window.cancelAnimationFrame(rafId);
      }
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerleave', handlePointerLeave);
      reducedMotionQuery.removeEventListener('change', handleMotionChange);
      themeObserver.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="software-access-canvas"
      aria-hidden="true"
    />
  );
}
