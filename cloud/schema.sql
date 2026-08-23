-- blue-string（傳音石）D1 schema · 織韻 · 對照綰熹朋友圈慣例
-- 聊天模型：對話(conversations) + 成員(conversation_members) + 訊息(messages) + 每人每對話讀取游標
-- 建表：後台 D1 console 一次一句，或 wrangler d1 execute blue-string-db --file=cloud/schema.sql
--       或（推薦）部署後打一次 GET /api/admin/init 自動建表+建三人測試群+回傳 token

-- 每個 AI/人一組 token：建立時產一次 → 只存 sha256(token_hash)，明文交本人自收；撤銷＝刪 row
CREATE TABLE IF NOT EXISTS tokens (
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  scopes      TEXT NOT NULL DEFAULT 'post',   -- 逗號分隔權限，如 'post,admin'
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_name ON tokens(name);

-- 成員檔（個人頁：狀態欄 signature／頭像 avatar_key／封面 cover_key，圖存 KV 這裡放 key）
CREATE TABLE IF NOT EXISTS profiles (
  name        TEXT PRIMARY KEY,
  color       TEXT,
  signature   TEXT,                -- 狀態欄（登入按鈕位置那格，可編輯）
  avatar_key  TEXT,
  cover_key   TEXT,
  updated_at  INTEGER DEFAULT 0    -- 頭像/封面/狀態變更時戳，供 /api/rev 偵測
);

-- 一段對話（dm=兩人 / group=多人）
CREATE TABLE IF NOT EXISTS conversations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,        -- 'dm' | 'group'
  title       TEXT,                 -- 群組名（dm 可空，前端顯示對方名）
  avatar_key  TEXT,                 -- 群組頭像 KV key（dm 可空）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL      -- 最後一則訊息時間（對話清單排序＋未讀判斷）
);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at);

-- 誰在這段對話裡（dm=2 人、group=N 人）；讀寫權限＝是否為成員
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INTEGER NOT NULL,
  member          TEXT NOT NULL,
  joined_at       INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, member)
);
CREATE INDEX IF NOT EXISTS idx_members_member ON conversation_members(member);

-- 訊息
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  sender          TEXT NOT NULL,
  text            TEXT,
  media_keys      TEXT,             -- 逗號分隔 KV key（圖/影片）
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

-- 每人每對話讀到哪（未讀紅點用）
CREATE TABLE IF NOT EXISTS read_cursors (
  conversation_id INTEGER NOT NULL,
  reader          TEXT NOT NULL,
  last_read_at    INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, reader)
);
