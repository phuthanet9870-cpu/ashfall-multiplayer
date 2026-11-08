เซิร์ฟเวอร์ Ashfall Online Multiplayer V2 — Cloudflare Workers / Durable Objects
- โปรเจกต์ GitHub phuthanet9870-cpu/ashfall-multiplayer
- root: package.json, wrangler.jsonc, src/index.js, src/service.js, src/skills.js
- deploy command: npx wrangler deploy
- ไม่มี migrations เพิ่ม เพราะใช้ Durable Object class AshfallRoom เดิม และ DO SQLite namespace เดิม
- Deploy README ดูในไฟล์ README_ONLINE_V2_TH.txt ของ ZIP เกม
- ตรวจ health: https://ashfall-multiplayer.phuthanet9870.workers.dev/health
- สิ่งที่ยังไม่พร้อมแข่งขันจริง: server authoritative loot/economy game inventory, player account ownership, anti-cheat, multi-instance matchmaker.
