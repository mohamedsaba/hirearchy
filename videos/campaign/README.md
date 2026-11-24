# Hirearchy Launch Campaign Studio

Remotion 4 studio producing the complete **Hirearchy / Hirearchy Software** launch campaign:

## Master Deliverables (`../../launch-renders/campaign/`)
- `01_Hirearchy_Launch_Master_16x9.mp4` — 84s flagship launch film (`1920×1080`, `60 fps`, H.264 BT.709, `-14.0 LUFS` AAC-LC 320 kbps)
- `02_Hirearchy_Social_Reel_9x16.mp4` — 34s purpose-built vertical social reel (`1080×1920`, `60 fps`)
- `03_Hirearchy_Thesis_Teaser_16x9.mp4` — 24s Day-1 pre-launch manifesto teaser (`1920×1080`, `60 fps`)
- `stills/` — 5 high-resolution editorial campaign stills (`2400×1350` 16:9 & `1600×2000` 4:5)
- `CAMPAIGN_PLAYBOOK.md` — 5-day launch sequence & ready-to-publish copy

## Commands
- Preview interactively in Remotion Studio: `npm run studio`
- Typecheck: `npm run typecheck`
- Regenerate all 3 mastered audio stems (`-14.0 LUFS`): `python3 audio/compose_campaign_audio.py`
- Export all stills & films: `node render.mjs all` (or `stills`, `teaser`, `reel`, `master`)
