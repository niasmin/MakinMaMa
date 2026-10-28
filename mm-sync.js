// มากิน มาม่า — ชั้นซิงก์ข้อมูลกับ Supabase (ใช้ร่วมกันทั้ง index.html / pos-frontend.html / stock-system.html)
// ต้องโหลด supabase-js (UMD) ก่อนไฟล์นี้ ข้อมูลอยู่ในตาราง public.mm_records (ดู supabase/migrations)
//
// หลักการ: ข้อมูลในเครื่อง (localStorage) เป็นหลักเสมอ แล้วค่อยซิงก์ขึ้น/ลง
// - ข้อมูลแบบรายการ (array ของ object ที่มี id) เก็บแยกทีละรายการ อุปกรณ์ต่างกันเพิ่ม/แก้คนละรายการได้โดยไม่ทับกัน
// - เก็บ "ภาพล่าสุดที่ซิงก์แล้ว" (hash ต่อรายการ) ไว้ในเครื่อง จึงรู้ว่าอะไรแก้ตอนออฟไลน์/ส่งไม่สำเร็จ แล้วส่งให้ภายหลัง
// - ฟิลด์ตัวเลขที่กำหนดเป็น delta (เช่น qty ของสต๊อก) ส่งเป็นส่วนต่าง เซิร์ฟเวอร์บวกเพิ่มให้ ตัดสต๊อกพร้อมกันหลายเครื่องก็ไม่หาย
// - ทุกอุปกรณ์ล็อกอินแบบ Anonymous แล้วเข้าร่วมร้านด้วยรหัสร้านครั้งเดียว (session ใช้ร่วมกันทุกหน้าในโดเมนเดียวกัน)
(function(){
  const DEFAULT_CFG = {
    url: 'https://qrxfmymmsjsyzhvuudtj.supabase.co',
    key: 'sb_publishable_2r38ph8nVKDipJLgkwp-AA_QgTP66Go',
  };
  const RETRY_MS = [3000, 10000, 30000, 60000];
  const POLL_MS = 60000; // ดึงการเปลี่ยนแปลงซ้ำเป็นระยะ กันกรณี realtime พลาด

  let client = null;
  function getClient(){
    if(!client){
      if(!window.supabase) throw new Error('โหลดไลบรารี Supabase ไม่สำเร็จ (ตรวจสอบอินเทอร์เน็ต)');
      let cfg = DEFAULT_CFG;
      try{ const r = localStorage.getItem('mm_supabaseConfig'); if(r) cfg = JSON.parse(r); }catch(e){}
      client = window.supabase.createClient(cfg.url, cfg.key);
    }
    return client;
  }
  function fail(error){ if(error) throw new Error(error.message || String(error)); }
  function lsGet(k, d){ try{ const r = localStorage.getItem(k); return r === null ? d : JSON.parse(r); }catch(e){ return d; } }
  function lsSet(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){ console.error('localStorage', k, e); } }
  function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }

  // JSON ที่เรียงคีย์ (jsonb บนเซิร์ฟเวอร์สลับลำดับคีย์ได้) + FNV-1a เพื่อเทียบว่ารายการเปลี่ยนหรือไม่
  function stable(v){
    if(Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if(v && typeof v === 'object') return '{' + Object.keys(v).filter(k=>v[k] !== undefined).sort().map(k=>JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    return v === undefined ? 'null' : JSON.stringify(v);
  }
  function hash(v){
    const s = stable(v); let h = 0x811c9dc5;
    for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36) + s.length.toString(36);
  }
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const backoff = n => RETRY_MS[Math.min(n, RETRY_MS.length - 1)];

  // ---------- auth ----------
  // ตรวจว่าเบราว์เซอร์นี้เข้าร่วมร้านแล้วหรือยัง ถ้าส่ง code มาจะล็อกอิน+เข้าร่วมให้
  // ไม่ส่ง code และยังไม่เคยล็อกอิน = ไม่สร้างผู้ใช้ใหม่ คืนค่า {member:boolean}
  async function connect(code){
    const sb = getClient();
    const { data: { session } } = await sb.auth.getSession();
    if(!session){
      if(!code) return { member: false };
      const { error } = await sb.auth.signInAnonymously();
      if(error) throw new Error('ล็อกอิน Supabase ไม่สำเร็จ: ' + error.message);
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
  async function setCode(code){
    const { error } = await getClient().rpc('mm_set_code', { p_code: code });
    fail(error);
  }

  // ---------- realtime (ช่องเดียวต่อหน้า แจกจ่ายให้ทุก store ตาม coll) ----------
  let channel = null, channelOk = false, channelEver = false, channelTimer = null;
  const stores = new Set();
  function onChange(payload){
    const del = payload.eventType === 'DELETE';
    const row = del ? payload.old : payload.new;
    if(!row || !row.coll) return;
    stores.forEach(s=>s._remote(row.coll, row.id, del ? null : row, del));
  }
  function ensureChannel(){
    if(channel) return;
    const sb = getClient();
    const c = channel = sb.channel('mm_records_' + rid())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mm_records' }, onChange)
      .subscribe(status=>{
        if(c !== channel) return;
        const ok = status === 'SUBSCRIBED';
        // กลับมาเชื่อมต่อได้หลังหลุด — ดึงของที่พลาดไประหว่างนั้น
        if(ok && !channelOk && channelEver) stores.forEach(s=>s._resync());
        if(ok) channelEver = true;
        channelOk = ok;
        stores.forEach(s=>s._emitStatus());
        clearTimeout(channelTimer);
        if(!ok){
          // ยังต่อไม่ได้ภายใน 30 วิ สร้างช่องใหม่
          channelTimer = setTimeout(()=>{
            if(channelOk || c !== channel) return;
            channel = null; sb.removeChannel(c).catch(()=>{});
            if(stores.size) ensureChannel();
          }, 30000);
        }
      });
  }
  function dropChannel(){
    if(!channel) return;
    clearTimeout(channelTimer);
    const c = channel; channel = null; channelOk = false;
    getClient().removeChannel(c).catch(()=>{});
  }

  // ---------- store ----------
  // createStore({
  //   name: 'bo',                      ชื่อแอป ใช้แยก "ภาพล่าสุดที่ซิงก์" ของแต่ละหน้า
  //   keys: { orders:{list:true, coll:'orders', delta:['qty'], sort:(a,b)=>..}, settings:{} }   ไม่ระบุ list = เอกสารเดี่ยว
  //   get(key), set(key, value)        อ่าน/เขียน state ของแอป (set ต้องบันทึก localStorage ของแอปด้วย)
  //   onData(keys)                     เรียกเมื่อข้อมูลในเครื่องถูกเปลี่ยนจากการซิงก์
  //   onStatus({state, pending, error}) state: 'off' | 'connecting' | 'online' | 'offline'
  // })
  function createStore(opts){
    const keys = Object.keys(opts.keys);
    const kc = k => opts.keys[k].coll || (opts.keys[k].list ? k : 'doc');
    const snapKey = k => 'mm_snap_' + opts.name + '_' + k;
    const offKey = 'mm_sync_off_' + opts.name;
    let phase = 'off', error = '', pending = 0, active = false;
    let flushing = null, again = false, retryN = 0, retryTimer = null, saveTimer = null, pollTimer = null, lastPull = null;
    const snaps = {};
    keys.forEach(k=>{ snaps[k] = lsGet(snapKey(k), null); });
    const saveSnap = k => lsSet(snapKey(k), snaps[k]);

    function status(){
      let state = phase;
      if(active) state = phase === 'offline' || !channelOk ? 'offline' : 'online';
      return { state, pending, error };
    }
    function emitStatus(){ if(opts.onStatus) opts.onStatus(status()); }
    const deltaOf = k => opts.keys[k].delta || [];
    const baseOf = (k, d) => { const b = {}; deltaOf(k).forEach(f=>{ if(d && typeof d[f] === 'number') b[f] = d[f]; }); return b; };
    // ภาพที่ซิงก์แล้วต่อรายการ: [hash, ค่าฐานของฟิลด์ delta, version บนเซิร์ฟเวอร์]
    const entry = (k, d, v) => [hash(d), baseOf(k, d), v == null ? -1 : v];
    const verOf = e => (e && e[2] != null ? e[2] : -1);
    // ระหว่างส่งข้อมูลของคีย์ใด จะพักข้อมูลขาเข้าของคีย์นั้นไว้ก่อน (ไม่งั้นค่าที่ตัวเองเพิ่งส่งสะท้อนกลับมาจะถูกนับซ้ำ)
    const inflight = new Set(), queued = {};
    const clone = v => JSON.parse(JSON.stringify(v));
    function getList(k){
      const v = opts.get(k);
      const arr = Array.isArray(v) ? v : [];
      arr.forEach(el=>{ if(el && typeof el === 'object' && !el.id) el.id = rid(); });
      return arr;
    }
    function setList(k, arr){
      const sort = opts.keys[k].sort;
      opts.set(k, sort ? arr.slice().sort(sort) : arr);
    }
    function rebase(k, local, server, base){
      // ฟิลด์ delta = ค่าเซิร์ฟเวอร์ + ส่วนต่างในเครื่องที่ยังไม่ได้ส่ง (local − base) ฟิลด์อื่นใช้ของในเครื่อง
      const m = { ...local };
      deltaOf(k).forEach(f=>{
        if(typeof local[f] === 'number' && typeof server[f] === 'number' && typeof base[f] === 'number') m[f] = server[f] + (local[f] - base[f]);
      });
      return m;
    }

    // รับค่าจากเซิร์ฟเวอร์ 1 รายการ คืน true ถ้าข้อมูลในเครื่องเปลี่ยน
    function applyRemote(k, id, data, deleted, version){
      if(inflight.has(k)){ (queued[k] = queued[k] || []).push([id, data, deleted, version]); return false; }
      if(!opts.keys[k].list){
        if(deleted || data === null || data === undefined) return false;
        const local = opts.get(k), snap = snaps[k];
        if(version != null && version <= verOf(snap)) return false; // เก่ากว่าที่มีแล้ว
        const dirty = local !== undefined && hash(local) !== snap[0];
        snaps[k] = entry(k, data, version); saveSnap(k);
        if(dirty || hash(local) === snaps[k][0]) return false; // แก้ในเครื่องค้างอยู่ — ของในเครื่องชนะ (จะถูกส่งขึ้นไป)
        opts.set(k, data); return true;
      }
      const arr = getList(k).slice(), snap = snaps[k];
      const i = arr.findIndex(x=>x.id === id);
      const el = i >= 0 ? arr[i] : null, s = snap[id];
      const dirty = el && (!s || hash(el) !== s[0]);
      if(deleted){
        if(!s && !el) return false;
        delete snap[id]; saveSnap(k);
        if(!el || dirty) return false; // แก้ในเครื่องค้างอยู่ — เก็บไว้ (จะถูกส่งกลับขึ้นไป)
        arr.splice(i, 1); setList(k, arr); return true;
      }
      if(!el && s) return false; // ลบในเครื่องแล้ว รอส่งคำสั่งลบ
      if(s && version != null && version <= verOf(s)) return false; // เก่ากว่าที่มีแล้ว (รวมถึงค่าที่ตัวเองเพิ่งส่ง)
      snap[id] = entry(k, data, version); saveSnap(k);
      if(!el){ arr.push(data); setList(k, arr); return true; }
      if(!dirty){
        if(hash(el) === snap[id][0]) return false;
        arr[i] = data; setList(k, arr); return true;
      }
      if(!s || !deltaOf(k).length) return false;
      const m = rebase(k, el, data, s[1]);
      if(hash(m) === hash(el)) return false;
      arr[i] = m; setList(k, arr); return true;
    }

    function drain(k){
      const q = queued[k]; delete queued[k];
      let touched = false;
      (q || []).forEach(a=>{ if(applyRemote(k, a[0], a[1], a[2], a[3])) touched = true; });
      return touched;
    }

    // ดึงข้อมูลจากเซิร์ฟเวอร์ (full = ทั้งหมด ใช้ตอนเชื่อมต่อ/กลับมาออนไลน์ ไม่งั้นเฉพาะที่เปลี่ยนตั้งแต่ครั้งก่อน)
    async function pull(full){
      const sb = getClient();
      const changed = [];
      const startedAt = new Date(Date.now() - 5000).toISOString();
      for(const k of keys){
        const cfg = opts.keys[k], coll = kc(k);
        let q = sb.from('mm_records').select('id,data,version').eq('coll', coll);
        if(!cfg.list) q = q.eq('id', k);
        if(!full && lastPull) q = q.gte('updated_at', lastPull);
        const { data: rows, error: err } = await q.order('created_at').limit(100000);
        fail(err);
        let touched = false;
        if(snaps[k] === null){
          // เชื่อมต่อครั้งแรกบนเบราว์เซอร์นี้: ถ้าบนเซิร์ฟเวอร์มีข้อมูลแล้วใช้ของเซิร์ฟเวอร์ ถ้ายังว่างส่งของในเครื่องขึ้นไปตั้งต้น
          if(!cfg.list){
            if(rows.length && rows[0].data !== null){ snaps[k] = entry(k, rows[0].data, rows[0].version); opts.set(k, rows[0].data); touched = true; }
            else snaps[k] = ['', {}];
          } else {
            snaps[k] = {};
            if(rows.length){
              rows.forEach(r=>{ snaps[k][r.id] = entry(k, r.data, r.version); });
              setList(k, rows.map(r=>r.data)); touched = true;
            }
          }
          saveSnap(k);
        } else {
          rows.forEach(r=>{ if(applyRemote(k, r.id, r.data, false, r.version)) touched = true; });
          if(full && cfg.list && !inflight.has(k)){
            // รายการที่เคยซิงก์แล้วแต่ไม่อยู่บนเซิร์ฟเวอร์แล้ว = ถูกลบจากอุปกรณ์อื่น
            const ids = new Set(rows.map(r=>r.id));
            Object.keys(snaps[k]).forEach(id=>{ if(!ids.has(id) && applyRemote(k, id, null, true)) touched = true; });
          }
        }
        if(touched) changed.push(k);
      }
      lastPull = startedAt;
      if(changed.length && opts.onData) opts.onData(changed);
    }

    // ส่งของที่แก้ในเครื่องแต่ยังไม่ได้ซิงก์ขึ้นไป
    async function flushOnce(){
      const sb = getClient();
      for(const k of keys){
        const cfg = opts.keys[k], coll = kc(k);
        if(snaps[k] === null) continue;
        if(!cfg.list){
          const local = opts.get(k);
          if(local === undefined || hash(local) === snaps[k][0]) continue;
          const sentDoc = clone(local);
          inflight.add(k);
          let rows;
          try{
            const res = await sb.rpc('mm_push', { p_coll: coll, p_rows: [{ id: k, data: sentDoc }], p_deletes: [] });
            fail(res.error); rows = res.data;
          }finally{ inflight.delete(k); }
          const r0 = rows && rows[0];
          snaps[k] = r0 ? entry(k, r0.data, r0.version) : entry(k, sentDoc);
          saveSnap(k);
          if(drain(k) && opts.onData) opts.onData([k]);
          continue;
        }
        const snap = snaps[k], arr = getList(k);
        const ids = new Set(arr.map(x=>x.id));
        const ups = [], sent = {};
        arr.forEach(el=>{
          const h = hash(el), s = snap[el.id];
          if(s && s[0] === h) return;
          const row = { id: el.id, data: el };
          if(s && deltaOf(k).length){
            const delta = {};
            deltaOf(k).forEach(f=>{ if(typeof el[f] === 'number' && typeof s[1][f] === 'number') delta[f] = el[f] - s[1][f]; });
            if(Object.keys(delta).length) row.delta = delta;
          }
          row.data = clone(el);
          ups.push(row); sent[el.id] = { h, data: row.data };
        });
        const dels = Object.keys(snap).filter(id=>!ids.has(id));
        if(!ups.length && !dels.length) continue;
        for(let i = 0; i === 0 || i < ups.length; i += 200){
          inflight.add(k);
          let rows;
          try{
            const res = await sb.rpc('mm_push', { p_coll: coll, p_rows: ups.slice(i, i + 200), p_deletes: i === 0 ? dels : [] });
            fail(res.error); rows = res.data;
          }finally{ inflight.delete(k); }
          if(i === 0) dels.forEach(id=>{ delete snap[id]; });
          // ใช้ค่าที่เซิร์ฟเวอร์คำนวณ (ฟิลด์ delta รวมของอุปกรณ์อื่นแล้ว)
          const cur = getList(k).slice(); let replaced = false;
          (rows || []).forEach(r=>{
            snap[r.id] = entry(k, r.data, r.version);
            const j = cur.findIndex(x=>x.id === r.id);
            if(j < 0) return;
            const sentEl = sent[r.id];
            if(sentEl && hash(cur[j]) === sentEl.h){
              if(hash(r.data) !== sentEl.h){ cur[j] = r.data; replaced = true; }
            } else if(sentEl){
              // ถูกแก้เพิ่มระหว่างส่ง: เก็บส่วนที่แก้เพิ่มไว้บนค่าใหม่จากเซิร์ฟเวอร์
              const m = rebase(k, cur[j], r.data, baseOf(k, sentEl.data));
              if(hash(m) !== hash(cur[j])){ cur[j] = m; replaced = true; }
            }
          });
          saveSnap(k);
          if(replaced) setList(k, cur);
          if((drain(k) || replaced) && opts.onData) opts.onData([k]);
        }
      }
    }
    function countPending(){
      let n = 0;
      keys.forEach(k=>{
        if(snaps[k] === null) return;
        if(!opts.keys[k].list){ const v = opts.get(k); if(v !== undefined && hash(v) !== snaps[k][0]) n++; return; }
        const snap = snaps[k], ids = new Set();
        getList(k).forEach(el=>{ ids.add(el.id); const s = snap[el.id]; if(!s || s[0] !== hash(el)) n++; });
        Object.keys(snap).forEach(id=>{ if(!ids.has(id)) n++; });
      });
      return n;
    }
    function flush(){
      if(!active) return Promise.resolve();
      if(flushing){ again = true; return flushing; }
      clearTimeout(retryTimer);
      flushing = (async ()=>{
        try{
          do{ again = false; await flushOnce(); } while(again && active);
          retryN = 0;
          if(phase === 'offline'){ phase = 'online'; error = ''; }
        }catch(e){
          console.error('MMSync flush', e);
          keys.forEach(k=>{ if(queued[k] && drain(k) && opts.onData) opts.onData([k]); });
          phase = 'offline'; error = e.message;
          if(active) retryTimer = setTimeout(flush, backoff(retryN++));
        }finally{
          flushing = null;
          pending = countPending();
          emitStatus();
        }
      })();
      return flushing;
    }
    async function resync(){
      if(!active) return;
      try{ await pull(true); phase = 'online'; error = ''; }
      catch(e){ console.error('MMSync pull', e); phase = 'offline'; error = e.message; }
      emitStatus();
      return flush();
    }
    async function poll(){
      if(!active) return;
      try{ await pull(false); }catch(e){ phase = 'offline'; error = e.message; emitStatus(); }
      flush();
    }
    const onOnline = () => resync();
    const onVisible = () => { if(document.visibilityState === 'visible') resync(); };

    const store = {
      get status(){ return status(); },
      // เริ่มซิงก์ ไม่ส่ง code = เชื่อมต่อเฉพาะถ้าเบราว์เซอร์นี้เคยเข้าร่วมร้านแล้วและไม่ได้กดยกเลิกไว้ คืน true ถ้าเริ่มได้
      async start(code){
        if(active) return true;
        clearTimeout(retryTimer);
        if(!code && lsGet(offKey, false)) return false;
        phase = 'connecting'; error = ''; emitStatus();
        try{
          const { member } = await connect(code);
          if(!member){ phase = 'off'; emitStatus(); return false; }
        }catch(e){
          phase = 'off'; error = e.message; emitStatus();
          // ตอนเปิดหน้าเน็ตอาจยังไม่มา ลองใหม่ภายหลัง (ถ้าใส่รหัสเองให้ผู้ใช้กดใหม่)
          if(!code) retryTimer = setTimeout(()=>store.start(), backoff(retryN++));
          if(code) throw e;
          return false;
        }
        lsDel(offKey);
        active = true; phase = 'online'; retryN = 0;
        stores.add(store); ensureChannel();
        window.addEventListener('online', onOnline);
        document.addEventListener('visibilitychange', onVisible);
        pollTimer = setInterval(poll, POLL_MS);
        await resync();
        return true;
      },
      // หยุดซิงก์ในหน้านี้ (ไม่ออกจากระบบ — ข้อมูลที่แก้ระหว่างนี้จะถูกส่งขึ้นเมื่อเชื่อมต่อใหม่)
      stop(){
        active = false; phase = 'off'; error = '';
        lsSet(offKey, true);
        clearTimeout(retryTimer); clearTimeout(saveTimer); clearInterval(pollTimer);
        window.removeEventListener('online', onOnline);
        document.removeEventListener('visibilitychange', onVisible);
        stores.delete(store); if(!stores.size) dropChannel();
        emitStatus();
      },
      // เรียกหลังแอปบันทึกข้อมูลในเครื่อง — หน่วงเล็กน้อยเพื่อรวมหลายการแก้เป็นการส่งครั้งเดียว
      save(){
        if(!active) return;
        pending = countPending(); emitStatus();
        clearTimeout(saveTimer); saveTimer = setTimeout(flush, 300);
      },
      flush,
      // ลืม "ภาพล่าสุดที่ซิงก์" ของหน้านี้ ใช้หลังล้างข้อมูลในเครื่อง (ไม่งั้นการเชื่อมต่อครั้งถัดไปจะลบข้อมูลบนเซิร์ฟเวอร์ตาม)
      // ครั้งถัดไปที่เชื่อมต่อจะดึงข้อมูลจากเซิร์ฟเวอร์มาใช้
      forget(){
        if(active) throw new Error('หยุดซิงก์ก่อน');
        keys.forEach(k=>{ snaps[k] = null; lsDel(snapKey(k)); });
      },
      // รายการนี้มีการแก้ในเครื่องที่ยังไม่ได้ส่งหรือไม่
      isDirty(k, id){
        const snap = snaps[k]; if(!snap) return true;
        const el = getList(k).find(x=>x.id === id), s = snap[id];
        return !el || !s || s[0] !== hash(el);
      },
      // อ่าน-แก้-เขียนรายการเดียวบนเซิร์ฟเวอร์แบบกันชนกัน (ใช้ตอนออนไลน์เท่านั้น)
      // fn(ค่าบนเซิร์ฟเวอร์) คืนค่าใหม่ หรือ undefined เพื่อยกเลิก — คืนค่าที่บันทึกแล้ว หรือ undefined
      async mutate(k, id, fn){
        const sb = getClient(), coll = kc(k);
        for(let attempt = 0; attempt < 8; attempt++){
          const { data: cur, error: e1 } = await sb.from('mm_records').select('data,version').eq('coll', coll).eq('id', id).maybeSingle();
          fail(e1);
          if(!cur || cur.data === null) return undefined;
          const next = fn(cur.data);
          if(next === undefined) return undefined;
          const { data, error: e2 } = await sb.from('mm_records').update({ data: next }).eq('coll', coll).eq('id', id).eq('version', cur.version).select('id');
          fail(e2);
          if(data && data.length){
            const arr = getList(k).slice(), i = arr.findIndex(x=>x.id === id);
            if(i >= 0) arr[i] = next; else arr.push(next);
            if(snaps[k]){ snaps[k][id] = entry(k, next, cur.version + 1); saveSnap(k); }
            setList(k, arr);
            return next;
          }
        }
        throw new Error('มีอุปกรณ์อื่นแก้ข้อมูลนี้พร้อมกัน กรุณาลองใหม่');
      },
      _remote(coll, id, row, deleted){
        if(!active) return;
        // ข้อมูลก้อนใหญ่เกินขนาดข้อความ realtime จะไม่ถูกส่งมา — ดึงจากฐานข้อมูลแทน
        if(!deleted && row && row.data === undefined){ if(keys.some(k=>kc(k) === coll)) poll(); return; }
        const changed = [];
        keys.forEach(k=>{
          if(kc(k) !== coll || snaps[k] === null) return;
          if(!opts.keys[k].list && id !== k) return;
          if(applyRemote(k, id, row ? row.data : null, deleted, row ? row.version : null)) changed.push(k);
        });
        if(changed.length){ pending = countPending(); if(opts.onData) opts.onData(changed); }
      },
      _resync: resync,
      _emitStatus: emitStatus,
    };
    return store;
  }

  window.MMSync = { connect, setCode, createStore };
})();
