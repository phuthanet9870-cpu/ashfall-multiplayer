Cloudflare Worker สำหรับ Ashfall Online Multiplayer + shared GM bosses

Deploy: เชื่อม GitHub กับ Worker เดิม แล้วใช้ npx wrangler deploy
ต้องเพิ่ม Worker Secret ใน Dashboard ชื่อ GM_SPAWN_KEY (อย่างน้อย 16 ตัวอักษร)
อย่าใส่รหัส Secret จริงใน ZIP, ไฟล์ wrangler.jsonc หรือ GitHub

เทสต์: https://ashfall-multiplayer.phuthanet9870.workers.dev/health
ถ้าสำเร็จต้องเห็น ok:true; ผลเล่นออนไลน์จริงต้องทดสอบจากผู้เล่นสองอุปกรณ์
ระบบ GM เสกบอสแชร์เฉพาะเซิร์ฟเวอร์และแมพเดียวกัน
บอสที่ GM เสกไว้มีอายุสูงสุด 1 ชั่วโมง (รีเซ็ตได้ด้วย GM)
เนื่องจากแยกจากระบบเศรษฐกิจ จะไม่ดรอปไอเทมเมื่อฆ่าบอส GM
