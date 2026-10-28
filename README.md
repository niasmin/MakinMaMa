# มากิน มาม่า (MAKIN MAMA)

ระบบจัดการร้านมาม่าต้มเอง — ไฟล์ HTML เดี่ยว ไม่ต้องติดตั้ง เปิดในเบราว์เซอร์ได้เลย

| ไฟล์ | URL บน Cloudflare Pages | หน้าที่ |
|---|---|---|
| `index.html` | `/` | ระบบหลังบ้าน: แดชบอร์ด รายงาน สต๊อก การเงิน สูตร/ต้นทุนเมนู CRM พนักงาน |
| `pos-frontend.html` | `/pos` | POS หน้าร้าน (ซิงก์ออเดอร์/สต๊อกกับหลังบ้านผ่าน Supabase) |
| `stock-system.html` | `/stock` | ระบบสต๊อกเดี่ยว: เรียลไทม์ + งวดต้น-ปลาย คำนวณต้นทุนจริง |
| `makin-mama-pos.html` | `/legacy` | POS/หลังบ้านแบบเดี่ยวรุ่นก่อนหน้า (ไม่ซิงก์) |
| `mm-sync.js` | — | ชั้นซิงก์ข้อมูลกับ Supabase ที่ 3 หน้าแรกใช้ร่วมกัน (ต้องอยู่โฟลเดอร์เดียวกัน) |

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

## Supabase (ที่เก็บข้อมูลกลาง)
ข้อมูลทุกหน้าเก็บในตาราง `public.mm_records` ของโปรเจกต์ Supabase `qrxfmymmsjsyzhvuudtj` (สคีมาอยู่ที่ `supabase/migrations/`)
URL และ publishable key ใส่ไว้ใน `mm-sync.js` แล้ว — key นี้เปิดเผยได้ตามปกติ ความปลอดภัยมาจาก RLS + รหัสร้าน

- ทุกอุปกรณ์ล็อกอินแบบ Anonymous แล้วต้องใส่ **รหัสร้าน** ก่อน จึงจะอ่าน/เขียนข้อมูลได้ (ผู้ใช้ของแอปอื่นในโปรเจกต์เดียวกันเข้าไม่ได้)
- **ครั้งแรกสุด** รหัสที่ใส่จะถูกตั้งเป็นรหัสร้าน (อย่างน้อย 6 ตัวอักษร) — เปลี่ยนได้ในหน้าตั้งค่าของหลังบ้าน
- ใส่รหัสครั้งเดียวต่อเบราว์เซอร์ ใช้ได้ทุกหน้าในโดเมนเดียวกัน
- ข้อมูลในเครื่องจะถูกอัปโหลดขึ้นตอนเชื่อมต่อครั้งแรก ถ้าบน Supabase ยังไม่มีข้อมูลนั้น
