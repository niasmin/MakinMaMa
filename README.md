# มากิน มาม่า (MAKIN MAMA)

ระบบจัดการร้านมาม่าต้มเอง — ไฟล์ HTML เดี่ยว ไม่ต้องติดตั้ง เปิดในเบราว์เซอร์ได้เลย

| ไฟล์ | หน้าที่ |
|---|---|
| `index.html` | ระบบหลังบ้าน: แดชบอร์ด รายงาน สต๊อก การเงิน สูตร/ต้นทุนเมนู CRM พนักงาน |
| `pos-frontend.html` | POS หน้าร้าน (ซิงก์ออเดอร์/สต๊อกผ่าน Firebase) |
| `stock-system.html` | ระบบสต๊อกเดี่ยว: เรียลไทม์ + งวดต้น-ปลาย คำนวณต้นทุนจริง |
| `makin-mama-pos.html` | POS/หลังบ้านแบบเดี่ยวรุ่นก่อนหน้า |

## Firebase
เปิด Anonymous sign-in แล้วตั้ง Rules: `{"rules":{".read":"auth != null",".write":"auth != null"}}`
ใส่ config (apiKey, databaseURL, projectId) ในหน้าตั้งค่าของแต่ละแอป — ไม่ต้อง commit ค่าเหล่านี้ลง repo
