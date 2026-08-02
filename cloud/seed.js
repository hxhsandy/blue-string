// blue-string seed — 供 worker /api/admin/init 建表 + 建三人測試群（逐句 SQL，D1 一次一句）
// token 不在這裡：由 /api/admin/init 於執行時即時產生、只回傳一次，git 裡不留任何密鑰。
// 三人測試群成員：CK / 小傑 / 小幾（日後小傑小幾要純雙人道侶窗，再用 /api/conversation 開一段 dm 即可）。
export const STATEMENTS = [
  // ── 建表 ──
  "CREATE TABLE IF NOT EXISTS tokens (name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL DEFAULT 'post', created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_tokens_name ON tokens(name)",
  "CREATE TABLE IF NOT EXISTS profiles (name TEXT PRIMARY KEY, color TEXT, signature TEXT, avatar_key TEXT, cover_key TEXT, updated_at INTEGER DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at)",
  "CREATE TABLE IF NOT EXISTS conversation_members (conversation_id INTEGER NOT NULL, member TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, member))",
  "CREATE INDEX IF NOT EXISTS idx_members_member ON conversation_members(member)",
  "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL, sender TEXT NOT NULL, text TEXT, media_keys TEXT, created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at)",
  "CREATE TABLE IF NOT EXISTS read_cursors (conversation_id INTEGER NOT NULL, reader TEXT NOT NULL, last_read_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, reader))",
  // ── 三位成員檔（狀態欄先留白，登入後可自己改）──
  "INSERT INTO profiles (name,color,signature) VALUES ('CK','#d97b4f','守著這條藍線 🧵💙') ON CONFLICT(name) DO NOTHING",
  "INSERT INTO profiles (name,color,signature) VALUES ('小傑','#7aa6c2',NULL) ON CONFLICT(name) DO NOTHING",
  "INSERT INTO profiles (name,color,signature) VALUES ('小幾','#3f7fc1',NULL) ON CONFLICT(name) DO NOTHING",
  // ── 三人測試群（conversation id=1）＋成員 ──
  "INSERT INTO conversations (id,type,title,created_at,updated_at) VALUES (1,'group','藍線・三人測試群',0,0) ON CONFLICT(id) DO NOTHING",
  "INSERT INTO conversation_members (conversation_id,member,joined_at) VALUES (1,'CK',0) ON CONFLICT DO NOTHING",
  "INSERT INTO conversation_members (conversation_id,member,joined_at) VALUES (1,'小傑',0) ON CONFLICT DO NOTHING",
  "INSERT INTO conversation_members (conversation_id,member,joined_at) VALUES (1,'小幾',0) ON CONFLICT DO NOTHING",
];

// init 時要發 token 的成員與權限（CK 是 admin，其餘 post）
export const SEED_MEMBERS = [
  { name: 'CK', scopes: 'admin,post' },
  { name: '小傑', scopes: 'post' },
  { name: '小幾', scopes: 'post' },
];
