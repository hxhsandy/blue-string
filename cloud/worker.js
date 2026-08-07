// worker.js — blue-string（傳音石）雲端 API（Cloudflare Workers + D1 + KV[圖片,免綁卡]）
// LINE 式私訊：對話清單 / 某對話訊息(增量) / 送訊息 / 已讀 / 開對話 / 輕量指紋輪詢 / 個人頁
// 認證：每個請求帶 Authorization: Bearer <token>；比對 D1 tokens 表的 sha256(不存明文)。
// 私訊隔離：所有讀寫訊息前都驗「我是這段對話的成員」，非成員一律擋 → 別的 AI 翻不到別人的私聊。
// 前端(public/)由 [assets] 服務；/api/* 才進這裡。
import { STATEMENTS, SEED_MEMBERS } from './seed.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // 分流：非 /api/* → 靜態前端
    if (!pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('no assets', { status: 500 });
    }
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    // bootstrap：空庫才跑，建表+建三人測試群+即時產 token 回傳一次（免 token；D1 console 吃不下多句 SQL 的替代路）
    if (pathname === '/api/admin/init') { try { return await adminInit(env); } catch (e) { return json({ error: errmsg(e) }, 500); } }
    // 圖片公開（<img> 帶不了 token；圖非機密，訊息文字/清單仍要 token）
    if (pathname === '/api/media' && request.method === 'GET') { try { return await getMedia(url, env); } catch (e) { return json({ error: errmsg(e) }, 500); } }

    try {
      const me = await authenticate(request, env);      // {name, scopes} 或 null
      if (!me) return json({ error: '未授權：請帶有效 token' }, 401);

      const P = pathname, M = request.method;
      if (P === '/api/me'            && M === 'GET')  return json({ name: me.name, scopes: me.scopes });
      if (P === '/api/rev'           && M === 'GET')  return getRev(env, me);
      if (P === '/api/conversations' && M === 'GET')  return getConversations(env, me);
      if (P === '/api/messages'      && M === 'GET')  return getMessages(url, env, me);
      if (P === '/api/profile'       && M === 'GET')  return getProfile(url, env);

      // 寫入類要 'post' 權限（訪客 scope=read 只能看）
      if (M === 'POST' && !P.startsWith('/api/admin/') && !hasScope(me, 'post'))
        return json({ error: '此帳號唯讀，無法發訊息' }, 403);
      if (P === '/api/message'        && M === 'POST') return sendMessage(request, env, me);
      if (P === '/api/message/delete' && M === 'POST') return deleteMessage(request, env, me);
      if (P === '/api/read'           && M === 'POST') return markRead(request, env, me);
      if (P === '/api/conversation' && M === 'POST') return createConversation(request, env, me);
      if (P === '/api/profile'      && M === 'POST') return updateProfile(request, env, me);
      if (P === '/api/admin/member' && M === 'POST') return adminMember(request, env, me);
      if (P === '/api/admin/conversation-add' && M === 'POST') return adminConvAdd(request, env, me);
      if (P === '/api/admin/migrate' && M === 'POST') return adminMigrate(env, me);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: errmsg(e) }, 500);
    }
  }
};

// ── 認證 ──
async function authenticate(request, env) {
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  if (!token) return null;
  const hash = await sha256hex(token);
  const row = await env.DB.prepare('SELECT name, scopes FROM tokens WHERE token_hash = ?').bind(hash).first();
  return row || null;
}
function hasScope(me, s) { return String(me.scopes || '').split(',').map(x => x.trim()).includes(s); }

// ── 私訊隔離：我是不是這段對話的成員 ──
async function isMember(env, convId, name) {
  const r = await env.DB.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND member = ?').bind(convId, name).first();
  return !!r;
}
async function myConvIds(env, name) {
  const rows = (await env.DB.prepare('SELECT conversation_id FROM conversation_members WHERE member = ?').bind(name).all()).results;
  return rows.map(r => r.conversation_id);
}

// ── profiles（個人頁：頭像/封面/狀態欄）──
async function profilesFor(env, names) {
  if (!names.length) return {};
  const uniq = [...new Set(names)];
  const out = {};
  const CH = 90;
  for (let i = 0; i < uniq.length; i += CH) {
    const batch = uniq.slice(i, i + CH);
    const ph = batch.map(() => '?').join(',');
    const rows = (await env.DB.prepare(`SELECT name,color,signature,avatar_key,cover_key FROM profiles WHERE name IN (${ph})`).bind(...batch).all()).results;
    for (const p of rows) out[p.name] = {
      name: p.name, color: p.color || '#8a8a8a', signature: p.signature || '',
      avatar: p.avatar_key ? '/api/media?key=' + encodeURIComponent(p.avatar_key) : '',
      cover:  p.cover_key  ? '/api/media?key=' + encodeURIComponent(p.cover_key)  : '',
    };
  }
  // 沒建 profile 的成員也給個預設，前端不會缺名
  for (const n of uniq) if (!out[n]) out[n] = { name: n, color: '#8a8a8a', signature: '', avatar: '', cover: '' };
  return out;
}
function mediaUrls(csv) {
  return (csv ? csv.split(',').filter(Boolean) : []).map(k => '/api/media?key=' + encodeURIComponent(k));
}

// ── GET /api/conversations：對話清單（對方/群名、最後一則、未讀數）──
// 一般成員：只看自己有份的。admin(擁有者 CK)：看得到全部——為安全監督(4.6+ 模型 bug 可能亂輸出/刪檔，
// 出事在看不到的地方會來不及救)。她不在的對話標 observing=true(只讀不發言)。此監督是公開的、非偷窺。
async function getConversations(env, me) {
  const admin = hasScope(me, 'admin');
  const ids = admin
    ? (await env.DB.prepare('SELECT id FROM conversations ORDER BY updated_at DESC').all()).results.map(r => r.id)
    : await myConvIds(env, me.name);
  if (!ids.length) return json({ me: me.name, admin, conversations: [], profiles: {} });
  const convs = [];
  const memberNames = [me.name];
  for (const cid of ids) {
    const c = await env.DB.prepare('SELECT id,type,title,created_at,updated_at FROM conversations WHERE id = ?').bind(cid).first();
    if (!c) continue;
    const members = (await env.DB.prepare('SELECT member FROM conversation_members WHERE conversation_id = ?').bind(cid).all()).results.map(r => r.member);
    members.forEach(m => memberNames.push(m));
    const observing = !members.includes(me.name);
    const last = await env.DB.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1').bind(cid).first();
    const cur = await env.DB.prepare('SELECT last_read_at FROM read_cursors WHERE conversation_id = ? AND reader = ?').bind(cid, me.name).first();
    const lastRead = cur ? cur.last_read_at : 0;
    const un = await env.DB.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND created_at > ? AND sender != ?').bind(cid, lastRead, me.name).first();
    const peer = c.type === 'dm' ? (members.find(m => m !== me.name) || '') : '';
    const title = c.type === 'group' ? (c.title || '群組') : (observing ? members.join(' ↔ ') : peer);
    convs.push({
      id: c.id, type: c.type, title, peer, members, observing,
      updated_at: c.updated_at,
      last: last ? { sender: last.sender, text: last.deleted ? '' : (last.text || ''), has_media: !last.deleted && !!last.media_keys, at: last.created_at, recalled: !!last.deleted } : null,
      unread: (un && un.n) || 0,
    });
  }
  convs.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return json({ me: me.name, admin, conversations: convs, profiles: await profilesFor(env, memberNames) });
}

// ── GET /api/messages?conversation=X&since=<ms>：某對話訊息（增量）。非成員擋。 ──
async function getMessages(url, env, me) {
  const cid = Number(url.searchParams.get('conversation'));
  if (!cid) return json({ error: '缺 conversation' }, 400);
  const member = await isMember(env, cid, me.name);
  if (!member && !hasScope(me, 'admin')) return json({ error: '你不在這段對話裡' }, 403);   // admin 可監督讀取
  const since = Number(url.searchParams.get('since') || 0);
  // SELECT * → 就算 deleted/client_msg_id 欄位還沒 migrate 也不會壞（欄位不存在時 r.deleted 為 undefined）
  const rows = (await env.DB.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT 300'
  ).bind(cid, since).all()).results;
  const c = await env.DB.prepare('SELECT id,type,title FROM conversations WHERE id = ?').bind(cid).first();
  const members = (await env.DB.prepare('SELECT member FROM conversation_members WHERE conversation_id = ?').bind(cid).all()).results.map(r => r.member);
  const msgs = rows.map(r => ({
    id: r.id, sender: r.sender,
    text: r.deleted ? '' : (r.text || ''),
    images: r.deleted ? [] : mediaUrls(r.media_keys),
    at: r.created_at, mine: r.sender === me.name,
    recalled: !!r.deleted,
  }));
  return json({
    conversation: { id: cid, type: c ? c.type : 'group', title: c ? c.title : '', members, member, observing: !member },
    messages: msgs, now: Date.now(),
    profiles: await profilesFor(env, members),
  });
}

// ── POST /api/message {conversation, text, images?, client_msg_id?}：送訊息（成員才行）──
// 冪等：客戶端可帶 client_msg_id(自生唯一碼)；重送同一碼只會回同一筆、不新增（防「500 但其實寫進去了→retry→雙胞胎」）。
// 且訊息一旦寫入成功，後續維護步驟(戳 updated_at/推游標)一律盡力而為，絕不因它們失敗而回 500 誤導客戶端重送。
async function sendMessage(request, env, me) {
  const b = await request.json().catch(() => ({}));
  const cid = Number(b.conversation);
  if (!cid) return json({ error: '缺 conversation' }, 400);
  if (!(await isMember(env, cid, me.name))) return json({ error: '你不在這段對話裡' }, 403);
  const text = String(b.text || '').trim();
  const images = Array.isArray(b.images) ? b.images.slice(0, 9) : [];
  if (!text && !images.length) return json({ error: '空訊息' }, 400);
  const cmid = String(b.client_msg_id || '').trim() || null;

  // 冪等前置檢查：這個 client_msg_id 已經寫過就直接回同一筆（避免重送、也避免重傳圖）
  if (cmid) {
    try {
      const ex = await env.DB.prepare('SELECT id,created_at FROM messages WHERE conversation_id=? AND sender=? AND client_msg_id=?').bind(cid, me.name, cmid).first();
      if (ex) return json({ ok: true, id: ex.id, at: ex.created_at, dedup: true });
    } catch (e) { /* 舊 schema 尚無此欄位 → 略過去重 */ }
  }

  const ts = Date.now();
  const keys = [];
  for (let i = 0; i < images.length; i++) {
    const k = await putImage(env, `msg/${cid}/${ts}_${i}`, images[i]);
    if (k) keys.push(k);
  }

  // 寫入（帶 cmid；ON CONFLICT 擋並發同碼重送。舊 schema 無此欄位/索引 → 退回不帶 cmid 的寫法）
  let id;
  try {
    const ins = await env.DB.prepare('INSERT INTO messages (conversation_id,sender,text,media_keys,created_at,client_msg_id) VALUES (?,?,?,?,?,?) ON CONFLICT(conversation_id,sender,client_msg_id) DO NOTHING')
      .bind(cid, me.name, text, keys.join(','), ts, cmid).run();
    if (ins.meta.changes === 0 && cmid) {
      const ex = await env.DB.prepare('SELECT id,created_at FROM messages WHERE conversation_id=? AND sender=? AND client_msg_id=?').bind(cid, me.name, cmid).first();
      if (ex) return json({ ok: true, id: ex.id, at: ex.created_at, dedup: true });
    }
    id = ins.meta.last_row_id;
  } catch (e) {
    if (/client_msg_id|no such column|no such index|ON CONFLICT/i.test(String((e && e.message) || e))) {
      const ins = await env.DB.prepare('INSERT INTO messages (conversation_id,sender,text,media_keys,created_at) VALUES (?,?,?,?,?)').bind(cid, me.name, text, keys.join(','), ts).run();
      id = ins.meta.last_row_id;
    } else throw e;
  }

  // 訊息已寫入 → 以下維護步驟盡力而為，出錯也不回 500（否則客戶端會以為失敗而重送成雙胞胎）
  try {
    await env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(ts, cid).run();
    await env.DB.prepare('INSERT INTO read_cursors (conversation_id,reader,last_read_at) VALUES (?,?,?) ON CONFLICT(conversation_id,reader) DO UPDATE SET last_read_at = excluded.last_read_at').bind(cid, me.name, ts).run();
  } catch (e) { /* 已寫入成功，維護步驟失敗不影響回應 */ }
  return json({ ok: true, id, at: ts });
}

// ── POST /api/message/delete {id}：收回/刪除一則訊息（LINE 式）──
// admin(擁有者)可收回任何人的；非 admin 只能刪自己的、且要是該對話成員。軟刪(留 row 標 deleted)＋清 KV 媒體＋戳對話→對方即時同步收回。
async function deleteMessage(request, env, me) {
  const b = await request.json().catch(() => ({}));
  const id = Number(b.id);
  if (!id) return json({ error: '缺 id' }, 400);
  const row = await env.DB.prepare('SELECT id,conversation_id,sender,media_keys FROM messages WHERE id = ?').bind(id).first();
  if (!row) return json({ error: '訊息不存在' }, 404);
  const admin = hasScope(me, 'admin');
  if (!admin) {
    if (row.sender !== me.name) return json({ error: '只能收回自己的訊息' }, 403);
    if (!(await isMember(env, row.conversation_id, me.name))) return json({ error: '你不在這段對話裡' }, 403);
  }
  const ts = Date.now();
  try {
    await env.DB.prepare('UPDATE messages SET deleted = 1, text = NULL, media_keys = NULL WHERE id = ?').bind(id).run();
  } catch (e) {
    if (/deleted|no such column/i.test(String((e && e.message) || e))) {
      await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(id).run();   // 舊 schema 無 deleted → 退回硬刪
    } else throw e;
  }
  if (row.media_keys) for (const k of row.media_keys.split(',').filter(Boolean)) { try { await env.MEDIA.delete(k); } catch (e) {} }
  try { await env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(ts, row.conversation_id).run(); } catch (e) {}
  return json({ ok: true, id, recalled: true });
}

// ── POST /api/read {conversation, at?}：標某對話已讀（推進游標；預設到現在）──
async function markRead(request, env, me) {
  const b = await request.json().catch(() => ({}));
  const cid = Number(b.conversation);
  if (!cid) return json({ error: '缺 conversation' }, 400);
  if (!(await isMember(env, cid, me.name)) && !hasScope(me, 'admin')) return json({ error: '你不在這段對話裡' }, 403);   // admin 監督時也能標已讀(未讀徽章用)
  const at = Number(b.at) || Date.now();
  await env.DB.prepare('INSERT INTO read_cursors (conversation_id,reader,last_read_at) VALUES (?,?,?) ON CONFLICT(conversation_id,reader) DO UPDATE SET last_read_at = excluded.last_read_at').bind(cid, me.name, at).run();
  return json({ ok: true, at });
}

// ── POST /api/conversation {type, members[], title?}：開一段 dm/group（自己自動加入）──
async function createConversation(request, env, me) {
  const b = await request.json().catch(() => ({}));
  const type = b.type === 'dm' ? 'dm' : 'group';
  let members = Array.isArray(b.members) ? b.members.map(x => String(x).trim()).filter(Boolean) : [];
  members.push(me.name);
  members = [...new Set(members)];
  if (type === 'dm' && members.length !== 2) return json({ error: 'dm 必須剛好兩人（你＋對方）' }, 400);
  if (members.length < 2) return json({ error: '至少要兩人' }, 400);
  const title = type === 'group' ? String(b.title || '').trim().slice(0, 40) || '群組' : null;
  const ts = Date.now();
  const r = await env.DB.prepare('INSERT INTO conversations (type,title,created_at,updated_at) VALUES (?,?,?,?)').bind(type, title, ts, ts).run();
  const cid = r.meta.last_row_id;
  for (const m of members) await env.DB.prepare('INSERT INTO conversation_members (conversation_id,member,joined_at) VALUES (?,?,?) ON CONFLICT DO NOTHING').bind(cid, m, ts).run();
  return json({ ok: true, id: cid, type, members, title });
}

// ── GET /api/profile?name=X：看某人的個人頁 ──
async function getProfile(url, env) {
  const name = String(url.searchParams.get('name') || '').trim();
  if (!name) return json({ error: '缺 name' }, 400);
  const p = (await profilesFor(env, [name]))[name];
  return json({ profile: p });
}

// ── POST /api/profile {signature?, avatar?, cover?}：改自己的個人頁 ──
async function updateProfile(request, env, me) {
  const b = await request.json().catch(() => ({}));
  // 確保有自己的 profile 列
  await env.DB.prepare('INSERT INTO profiles (name) VALUES (?) ON CONFLICT(name) DO NOTHING').bind(me.name).run();
  const sets = [], vals = [];
  if ('signature' in b) { sets.push('signature = ?'); vals.push(String(b.signature || '').trim().replace(/\n/g, ' ') || null); }
  if (b.avatar) { const k = await putImage(env, `avatars/${me.name}_${Date.now()}`, b.avatar); if (k) { sets.push('avatar_key = ?'); vals.push(k); } }
  if (b.cover)  { const k = await putImage(env, `covers/${me.name}_${Date.now()}`, b.cover);  if (k) { sets.push('cover_key = ?');  vals.push(k); } }
  if (!sets.length) return json({ error: '沒有要更新的內容' }, 400);
  sets.push('updated_at = ?'); vals.push(Date.now());
  vals.push(me.name);
  await env.DB.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE name = ?`).bind(...vals).run();
  return json({ ok: true });
}

// ── GET /api/rev：輕量指紋。一般成員＝per-user(只反映我有份的對話，不洩漏別人在密聊的時間訊號)；
//    admin(擁有者)＝全域(能即時監督所有對話，含私聊，用於抓 bug)。 ──
async function getRev(env, me) {
  if (hasScope(me, 'admin')) {
    let mu = 0, mc = 0, pf = 0;
    try { const a = await env.DB.prepare('SELECT MAX(updated_at) m FROM conversations').first(); mu = (a && a.m) || 0; } catch (e) {}
    try { const b = await env.DB.prepare('SELECT COUNT(*) n FROM messages').first(); mc = (b && b.n) || 0; } catch (e) {}
    try { const p = await env.DB.prepare('SELECT MAX(updated_at) u FROM profiles').first(); pf = (p && p.u) || 0; } catch (e) {}
    return json({ rev: mu + '-' + mc + '-' + pf, admin: true });
  }
  const ids = await myConvIds(env, me.name);
  if (!ids.length) return json({ rev: '0-0-0' });
  let maxUpd = 0, msgCount = 0;
  const CH = 90;
  for (let i = 0; i < ids.length; i += CH) {
    const batch = ids.slice(i, i + CH);
    const ph = batch.map(() => '?').join(',');
    const a = await env.DB.prepare(`SELECT MAX(updated_at) m FROM conversations WHERE id IN (${ph})`).bind(...batch).first();
    if (a && a.m > maxUpd) maxUpd = a.m;
    const b = await env.DB.prepare(`SELECT COUNT(*) n FROM messages WHERE conversation_id IN (${ph})`).bind(...batch).first();
    msgCount += (b && b.n) || 0;
  }
  // 加入我自己 profile 的 updated_at → 頭像/封面/狀態改了前端也會偵測到
  let pf = 0;
  try { const p = await env.DB.prepare('SELECT updated_at u FROM profiles WHERE name = ?').bind(me.name).first(); pf = (p && p.u) || 0; } catch (e) {}
  return json({ rev: maxUpd + '-' + msgCount + '-' + pf, conversations: ids.length });
}

// ── GET /api/media（從 KV 取圖）──
async function getMedia(url, env) {
  const key = url.searchParams.get('key');
  if (!key) return json({ error: '缺 key' }, 400);
  const { value, metadata } = await env.MEDIA.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!value) return json({ error: 'not found' }, 404);
  const h = new Headers();
  h.set('Content-Type', (metadata && metadata.ct) || 'application/octet-stream');
  h.set('Cache-Control', 'public, max-age=31536000, immutable');
  h.set('Access-Control-Allow-Origin', '*');
  return new Response(value, { headers: h });
}

// ── POST /api/admin/member：管理員發 token（建 profile + 產一組新 token，明文只回一次）──
async function adminMember(request, env, me) {
  if (!hasScope(me, 'admin')) return json({ error: '需要 admin 權限' }, 403);
  const b = await request.json().catch(() => ({}));
  const name = String(b.name || '').trim();
  if (!name) return json({ error: '缺 name' }, 400);
  const scopes = String(b.scopes || 'post').trim();
  const color = b.color ? String(b.color) : '#8a8a8a';
  await env.DB.prepare('INSERT INTO profiles (name,color) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET color = COALESCE(profiles.color, excluded.color)').bind(name, color).run();
  const token = 'bs_' + randomHex(32);
  await env.DB.prepare('INSERT INTO tokens (name,token_hash,scopes,created_at) VALUES (?,?,?,?)').bind(name, await sha256hex(token), scopes, Date.now()).run();
  return json({ ok: true, name, scopes, token, note: '這串 token 只顯示這一次，交給該 AI/人收好；撤銷＝刪 tokens 表該列' });
}

// ── POST /api/admin/conversation-add {conversation, members[]}：把人加進既有對話（admin）──
async function adminConvAdd(request, env, me) {
  if (!hasScope(me, 'admin')) return json({ error: '需要 admin 權限' }, 403);
  const b = await request.json().catch(() => ({}));
  const cid = Number(b.conversation);
  const members = Array.isArray(b.members) ? b.members.map(x => String(x).trim()).filter(Boolean) : [];
  if (!cid) return json({ error: '缺 conversation' }, 400);
  if (!members.length) return json({ error: '缺 members' }, 400);
  const c = await env.DB.prepare('SELECT id,type FROM conversations WHERE id = ?').bind(cid).first();
  if (!c) return json({ error: '對話不存在' }, 404);
  const ts = Date.now();
  for (const m of members) {
    await env.DB.prepare('INSERT INTO conversation_members (conversation_id,member,joined_at) VALUES (?,?,?) ON CONFLICT DO NOTHING').bind(cid, m, ts).run();
    await env.DB.prepare('INSERT INTO profiles (name) VALUES (?) ON CONFLICT(name) DO NOTHING').bind(m).run();
  }
  await env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(ts, cid).run();
  const all = (await env.DB.prepare('SELECT member FROM conversation_members WHERE conversation_id = ?').bind(cid).all()).results.map(r => r.member);
  return json({ ok: true, conversation: cid, members: all });
}

// ── POST /api/admin/migrate：加 messages.client_msg_id 欄位＋唯一索引（訊息冪等去重用）。idempotent。──
async function adminMigrate(env, me) {
  if (!hasScope(me, 'admin')) return json({ error: '需要 admin 權限' }, 403);
  const done = [];
  try { await env.DB.prepare('ALTER TABLE messages ADD COLUMN client_msg_id TEXT').run(); done.push('messages.client_msg_id 已新增'); }
  catch (e) { done.push('messages.client_msg_id 已存在(略過)'); }
  // 平凡唯一索引即可：SQLite 的唯一索引把多個 NULL 視為互異 → 沒帶 cmid 的訊息不受限，帶了 cmid 的才去重
  try { await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_cmid ON messages(conversation_id, sender, client_msg_id)').run(); done.push('idx_msg_cmid 就緒'); }
  catch (e) { done.push('idx_msg_cmid 失敗:' + String((e && e.message) || e)); }
  try { await env.DB.prepare('ALTER TABLE messages ADD COLUMN deleted INTEGER DEFAULT 0').run(); done.push('messages.deleted 已新增'); }
  catch (e) { done.push('messages.deleted 已存在(略過)'); }
  return json({ ok: true, done });
}

// ── bootstrap 初始化：空庫才跑，建表+三人測試群+即時產 token 回傳一次 ──
async function adminInit(env) {
  const t = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tokens'").first();
  if (t) {
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM tokens').first();
    if (c && c.n > 0) return json({ ok: false, error: '資料庫已初始化，拒絕重跑（要重來請先清 tokens 表）' }, 409);
  }
  let ran = 0;
  for (const s of STATEMENTS) { await env.DB.prepare(s).run(); ran++; }
  // 即時產每位成員的 token（明文只回這一次；git 裡不留密鑰）
  const tokens = {};
  const now = Date.now();
  for (const m of SEED_MEMBERS) {
    const token = 'bs_' + randomHex(32);
    await env.DB.prepare('INSERT INTO tokens (name,token_hash,scopes,created_at) VALUES (?,?,?,?)').bind(m.name, await sha256hex(token), m.scopes, now).run();
    tokens[m.name] = token;
  }
  return json({ ok: true, ran, tokens, note: '⚠️ 這些 token 只顯示這一次！CK 收好自己的(admin)，把小傑/小幾的分別交給他們。撤銷/重發＝用 /api/admin/member。' });
}

// ── helpers ──
const MEDIA_MAX = 8 * 1024 * 1024;   // 單檔上限 8MB
async function putImage(env, base, input) {
  // 接受：{name,data}／{url}／純字串(data:URL、裸 base64、或 http(s) 圖片/影片網址)
  // ★ 網址版：AI 只給網址，後端自己抓存 → 不用編 base64、不燒 token
  let srcUrl = '';
  if (input && typeof input === 'object' && input.url) srcUrl = String(input.url);
  else if (typeof input === 'string' && /^https?:\/\//i.test(input)) srcUrl = input;
  if (srcUrl) {
    let resp;
    try { resp = await fetch(srcUrl, { headers: { 'User-Agent': 'BlueString/1.0', 'Accept': 'image/*,video/*' } }); }
    catch (e) { return null; }
    if (!resp.ok) return null;
    const ct2 = (resp.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^(image|video)\//.test(ct2)) return null;
    const buf = await resp.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > MEDIA_MAX) return null;
    const ext2 = (ct2.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const key2 = `${base}.${ext2}`;
    await env.MEDIA.put(key2, buf, { metadata: { ct: ct2 } });
    return key2;
  }
  let raw = typeof input === 'string' ? input : (input && input.data) || '';
  let ext = 'png', ct = 'image/png';
  const nm = (input && input.name) || '';
  if (raw.startsWith('data:')) {
    const m = raw.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) { ct = m[1]; raw = m[2]; ext = (ct.split('/')[1] || 'png').replace('jpeg', 'jpg'); }
  } else if (nm.includes('.')) {
    const e = nm.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm'].includes(e)) { ext = e === 'jpeg' ? 'jpg' : e; ct = (['mp4', 'webm'].includes(e) ? 'video/' : 'image/') + (e === 'jpg' ? 'jpeg' : e); }
  }
  if (!raw) return null;
  const bytes = b64ToBytes(raw);
  if (bytes.length > MEDIA_MAX) return null;
  const key = `${base}.${ext}`;
  await env.MEDIA.put(key, bytes.buffer, { metadata: { ct } });
  return key;
}
function cors(resp) {
  resp.headers.set('Access-Control-Allow-Origin', '*');
  resp.headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  resp.headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  return resp;
}
function json(obj, status = 200) {
  return cors(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
}
function errmsg(e) { return String((e && e.message) || e); }
async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(n) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}
function b64ToBytes(b64) {
  const s = atob(b64); const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}
