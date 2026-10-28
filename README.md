# มากิน มาม่า (MAKIN MAMA)

ระบบจัดการร้านมาม่าต้มเอง — ไฟล์ HTML เดี่ยว ไม่ต้องติดตั้ง เปิดในเบราว์เซอร์ได้เลย

| ไฟล์ | URL บน Cloudflare Pages | หน้าที่ |
|---|---|---|
| `index.html` | `/` | ระบบหลังบ้าน: แดชบอร์ด รายงาน สต๊อก การเงิน สูตร/ต้นทุนเมนู CRM พนักงาน |
| `pos-frontend.html` | `/pos` | POS หน้าร้าน (ซิงก์ออเดอร์/สต๊อกผ่าน Firebase) |
| `stock-system.html` | `/stock` | ระบบสต๊อกเดี่ยว: เรียลไทม์ + งวดต้น-ปลาย คำนวณต้นทุนจริง |
| `makin-mama-pos.html` | `/legacy` | POS/หลังบ้านแบบเดี่ยวรุ่นก่อนหน้า |

## Deploy บน Cloudflare Pages
เว็บนี้เป็นไฟล์ static ล้วน ไม่มีขั้นตอน build

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. เลือก repo `niasmin/makinmama` และ production branch `main`
3. Build settings:
   - Framework preset: **None**
   - Build command: *(เว้นว่าง)*
   - Build output directory: `/`
4. กด **Save and Deploy** — ได้ URL `https://<project>.pages.dev` และทุกครั้งที่ push เข้า `main` จะ deploy ใหม่อัตโนมัติ (branch อื่นได้ preview URL)

หรือ deploy จากเครื่องด้วย CLI: `npx wrangler pages deploy . --project-name makin-mama`

ไฟล์ `_redirects` กำหนด URL สั้น (`/pos`, `/stock`, `/legacy`) และ `_headers` ใส่ security headers พื้นฐาน

## Firebase
เปิด Anonymous sign-in แล้วตั้ง Rules: `{"rules":{".read":"auth != null",".write":"auth != null"}}`
ใส่ config (apiKey, databaseURL, projectId) ในหน้าตั้งค่าของแต่ละแอป — ไม่ต้อง commit ค่าเหล่านี้ลง repo

หลัง deploy แล้ว ให้เพิ่มโดเมน `<project>.pages.dev` (และโดเมนจริงถ้ามี) ใน Firebase Console → Authentication → Settings → **Authorized domains**
และถ้าจำกัด API key ด้วย HTTP referrer ใน Google Cloud Console ให้เพิ่มโดเมนนี้ด้วย
