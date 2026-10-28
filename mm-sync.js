// มากิน มาม่า — ชั้นซิงก์ข้อมูลกับ Supabase (ใช้ร่วมกันทั้ง index.html / pos-frontend.html / stock-system.html)
// ต้องโหลด supabase-js (UMD) ก่อนไฟล์นี้ ข้อมูลอยู่ในตาราง public.mm_records (ดู supabase/migrations)
// ทุกอุปกรณ์ล็อกอินแบบ Anonymous แล้ว "เข้าร่วมร้าน" ด้วยรหัสร้านครั้งเดียว — session เก็บใน localStorage ของโดเมนนี้
(function(){
  const DEFAULT_CFG = {
    url: 'https://qrxfmymmsjsyzhvuudtj.supabase.co',
    key: 'sb_publishable_2r38ph8nVKDipJLgkwp-AA_QgTP66Go',
  };
  const CFG_KEY = 'mm_supabaseConfig';

  let client = null, channel = null, handlers = [];
  const pending = {}; // จำนวนการเขียนที่ยังค้างต่อเอกสาร — ระหว่างนั้นไม่รับค่าสะท้อนกลับมาทับค่าในเครื่อง

  function loadConfig(){
    try{ const r = localStorage.getItem(CFG_KEY); if(r) return JSON.parse(r); }catch(e){}
    return {...DEFAULT_CFG};
  }
  function getClient(){
    if(!client){
      if(!window.supabase) throw new Error('โหลดไลบรารี Supabase ไม่สำเร็จ (ตรวจสอบอินเทอร์เน็ต)');
      const cfg = loadConfig();
      client = window.supabase.createClient(cfg.url, cfg.key);
    }
    return client;
  }
  const docKey = (coll, id) => coll + '/' + id;
  function fail(error){ if(error) throw new Error(error.message || String(error)); }

  // ตรวจว่าอุปกรณ์นี้เข้าร่วมร้านแล้วหรือยัง ถ้าส่ง code มาจะล็อกอิน+เข้าร่วมให้
  // ไม่ส่ง code และยังไม่เคยล็อกอิน = ไม่สร้างผู้ใช้ใหม่ (ใช้ตอนเปิดหน้าเว็บ)
  // คืนค่า {member:true} หรือ {member:false} (ต้องใส่รหัสร้าน)
  async function connect(code){
    const sb = getClient();
    const { data: { session } } = await sb.auth.getSession();
    if(!session){
      if(!code) return { member: false };
      const { error } = await sb.auth.signInAnonymously();
      if(error) throw new Error('ล็อกอิน Supabase ไม่สำเร็จ: ' + error.message + ' (ตรวจสอบว่าเปิด Anonymous sign-in แล้ว)');
    }
    let { data: member, error } = await sb.rpc('mm_is_member');
    fail(error);
    if(!member && code){
      ({ data: member, error } = await sb.rpc('mm_join', { p_code: code }));
      fail(error);
      if(!member) throw new Error('รหัสร้านไม่ถูกต้อง');
    }
    return { member: !!member };
  }

  async function list(coll){
    const { data, error } = await getClient().from('mm_records').select('id,data,version').eq('coll', coll);
    fail(error);
    return data;
  }
  async function get(coll, id){
    const { data, error } = await getClient().from('mm_records').select('id,data,version').eq('coll', coll).eq('id', id).maybeSingle();
    fail(error);
    return data;
  }
  async function track(coll, id, fn){
    const k = docKey(coll, id);
    pending[k] = (pending[k] || 0) + 1;
    try{ return await fn(); }
    finally{ pending[k]--; }
  }
  function put(coll, id, data){
    return track(coll, id, async ()=>{
      const { error } = await getClient().from('mm_records').upsert({ coll, id, data: data === undefined ? null : data });
      fail(error);
    });
  }
  // อัปโหลดหลายเอกสารพร้อมกัน (ใช้ตอนส่งข้อมูลในเครื่องขึ้นไปตั้งต้น) docs = [{id, data}]
  async function putMany(coll, docs){
    for(let i = 0; i < docs.length; i += 500){
      const { error } = await getClient().from('mm_records').upsert(docs.slice(i, i + 500).map(d=>({ coll, id: d.id, data: d.data })));
      fail(error);
    }
  }
  function remove(coll, id){
    return track(coll, id, async ()=>{
      const { error } = await getClient().from('mm_records').delete().eq('coll', coll).eq('id', id);
      fail(error);
    });
  }
  // อ่าน-แก้-เขียนแบบกันชนกัน (แทน transaction ของ Firebase): fn(ค่าปัจจุบัน) คืนค่าใหม่ หรือ undefined เพื่อยกเลิก
  // คืนค่าใหม่ที่บันทึกสำเร็จ หรือ undefined ถ้ายกเลิก/ไม่มีเอกสาร
  function mutate(coll, id, fn){
    return track(coll, id, async ()=>{
      const sb = getClient();
      for(let attempt = 0; attempt < 8; attempt++){
        const cur = await get(coll, id);
        if(!cur || cur.data === null) return undefined;
        const next = fn(cur.data);
        if(next === undefined) return undefined;
        const { data, error } = await sb.from('mm_records').update({ data: next })
          .eq('coll', coll).eq('id', id).eq('version', cur.version).select('id');
        fail(error);
        if(data && data.length) return next;
      }
      throw new Error('มีอุปกรณ์อื่นแก้ข้อมูลนี้พร้อมกัน กรุณาลองใหม่');
    });
  }

  // handler({type:'upsert'|'delete', coll, id, data})
  function subscribe(handler){
    handlers.push(handler);
    if(channel) return;
    const sb = getClient();
    channel = sb.channel('mm_records')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mm_records' }, async payload=>{
        const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
        if(!row || !row.coll) return;
        if(pending[docKey(row.coll, row.id)] > 0) return;
        let evt;
        if(payload.eventType === 'DELETE') evt = { type: 'delete', coll: row.coll, id: row.id };
        else {
          let data = row.data;
          // ข้อมูลก้อนใหญ่เกินขนาดข้อความ realtime จะไม่ถูกส่งมา — ดึงจากฐานข้อมูลแทน
          if(data === undefined){ try{ const r = await get(row.coll, row.id); data = r ? r.data : null; }catch(e){ console.error(e); return; } }
          evt = { type: 'upsert', coll: row.coll, id: row.id, data };
        }
        handlers.forEach(h=>{ try{ h(evt); }catch(e){ console.error(e); } });
      })
      .subscribe((status, err)=>{
        if(status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.error('Supabase realtime', status, err);
      });
  }
  // หยุดซิงก์และออกจากระบบ — อุปกรณ์นี้ต้องใส่รหัสร้านใหม่ถ้าจะเชื่อมต่ออีก (มีผลกับทุกแอปในโดเมนเดียวกัน)
  async function disconnect(){
    handlers = [];
    if(channel){ try{ await client.removeChannel(channel); }catch(e){} channel = null; }
    if(client){ try{ await client.auth.signOut(); }catch(e){} }
  }
  async function setCode(code){
    const { error } = await getClient().rpc('mm_set_code', { p_code: code });
    fail(error);
  }

  window.MMSync = { connect, list, get, put, putMany, remove, mutate, subscribe, disconnect, setCode };
})();
