const path = require("path");
const fs = require("fs");
const http = require("http");
const os = require("os");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");
const multer = require("multer");

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-production";

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

const dataDir = path.join(__dirname, "data");
const persistentUploadDir = path.join(dataDir, "uploads");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(persistentUploadDir, { recursive: true });

// A feltöltött fájlok a builden kívüli, tartós data mappában élnek.
// Így egy új build kibontásakor elég a teljes data mappát átmásolni az új buildbe.
function copyMissingFilesRecursive(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyMissingFilesRecursive(source, target);
    } else if (!fs.existsSync(target)) {
      fs.copyFileSync(source, target);
    }
  }
}

// v5-ig a build public/uploads mappájába kerülhettek feltöltések.
// Első induláskor ezeket is átmentjük a tartós helyre, hogy ne vesszenek el.
copyMissingFilesRecursive(path.join(__dirname, "public", "uploads"), persistentUploadDir);

const db = new Database(path.join(dataDir, "cardgame.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS decks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deck_cards (
  deck_id INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity >= 0 AND quantity <= 99),
  PRIMARY KEY(deck_id, card_id),
  FOREIGN KEY(deck_id) REFERENCES decks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deck_special_cards (
  deck_id INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity >= 0 AND quantity <= 99),
  PRIMARY KEY(deck_id, card_id),
  FOREIGN KEY(deck_id) REFERENCES decks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  rarity TEXT NOT NULL,
  icon TEXT NOT NULL,
  type_id TEXT,
  class_name TEXT NOT NULL DEFAULT 'rarity-common',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY,
  active_deck_id INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(active_deck_id) REFERENCES decks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY,
  bio TEXT NOT NULL DEFAULT '',
  avatar_path TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS profile_likes (
  liker_id INTEGER NOT NULL,
  liked_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(liker_id, liked_id),
  FOREIGN KEY(liker_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(liked_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK(liker_id <> liked_id)
);

CREATE INDEX IF NOT EXISTS idx_profile_likes_liked ON profile_likes(liked_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_created_at ON chat_messages(created_at);

CREATE TABLE IF NOT EXISTS news_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author_id INTEGER NOT NULL,
  author_username TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(author_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);

CREATE TABLE IF NOT EXISTS match_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_a TEXT NOT NULL,
  player_b TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS presence_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  online_count INTEGER NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS game_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_presence_log_time ON presence_log(recorded_at);
`);

// Migráció: a korábbi adatbázisokhoz hozzáadjuk a meccsszámlálót, a profilokat, az admin jelzőt és a chat kiegészítő mezőit.
try { db.exec(`ALTER TABLE users ADD COLUMN matches_played INTEGER NOT NULL DEFAULT 0`); } catch (err) {
  if (!String(err.message).includes('duplicate column name')) throw err;
}
try { db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`); } catch (err) {
  if (!String(err.message).includes('duplicate column name')) throw err;
}
try { db.exec(`ALTER TABLE chat_messages ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`); } catch (err) {
  if (!String(err.message).includes('duplicate column name')) throw err;
}
try { db.exec(`ALTER TABLE cards ADD COLUMN image_path TEXT`); } catch (err) {
  if (!String(err.message).includes('duplicate column name')) throw err;
}
try { db.exec(`ALTER TABLE cards ADD COLUMN fields_json TEXT NOT NULL DEFAULT '{}'`); } catch (err) {
  if (!String(err.message).includes('duplicate column name')) throw err;
}
try { db.exec(`ALTER TABLE cards ADD COLUMN type_id TEXT`); } catch (err) {
  if (!String(err.message).includes('duplicate column name')) throw err;
}
try { db.exec(`ALTER TABLE profiles ADD COLUMN avatar_version TEXT`); } catch (err) {
  if (!String(err.message).includes('duplicate column name')) throw err;
}
db.exec(`
  INSERT OR IGNORE INTO profiles(user_id, bio, avatar_path)
  SELECT id, '', NULL FROM users;
`);
db.prepare(`INSERT OR IGNORE INTO game_settings(key, value) VALUES (?, ?)`).run("menu_music", "");
db.prepare(`INSERT OR IGNORE INTO game_settings(key, value) VALUES (?, ?)`).run("card_schema", JSON.stringify({ fields: [], types: [] }));
db.prepare(`INSERT OR IGNORE INTO game_settings(key, value) VALUES (?, ?)`).run("deck_rules", JSON.stringify({ minSize: 0, maxSize: 60, maxCopies: 99, requiredTypes: [] }));

// Ide írd be azoknak a felhasználóneveknek a listáját (kisbetű-érzéketlen),
// akik a Developer Center-t (hírek írása stb.) elérhetik.
const ADMIN_USERNAMES = ["Fochmarsall"];
if (ADMIN_USERNAMES.length) {
  db.prepare(`UPDATE users SET is_admin = 0 WHERE is_admin = 1`).run();
  const markAdmin = db.prepare(`UPDATE users SET is_admin = 1 WHERE lower(username) = lower(?)`);
  for (const name of ADMIN_USERNAMES) markAdmin.run(name);
}

// Nincsenek beépített/sablon kártyák. A korábbi verziók által létrehozott sablonokat
// egyszer eltávolítjuk; a játékos/developer által létrehozott kártyákat érintetlenül hagyjuk.
db.prepare(`DELETE FROM cards WHERE created_by IS NULL`).run();
db.prepare(`DELETE FROM deck_cards WHERE card_id NOT IN (SELECT id FROM cards)`).run();

function loadCardsFromDb() {
  return db.prepare(`
    SELECT id, name, type, type_id AS typeId, rarity, icon, image_path AS imagePath,
           fields_json AS fieldsJson, class_name AS className, created_by AS createdBy, created_at AS createdAt
    FROM cards ORDER BY id ASC
  `).all().map(card => ({
    ...card,
    fields: (() => { try { return JSON.parse(card.fieldsJson || '{}'); } catch { return {}; } })(),
    imageUrl: card.imagePath ? `/${card.imagePath.replaceAll('\\', '/')}?v=${encodeURIComponent(card.createdAt)}` : null
  }));
}

let CARDS = loadCardsFromDb();
let cardById = new Map(CARDS.map(c => [c.id, c]));

function refreshCardsCache() {
  CARDS = loadCardsFromDb();
  cardById = new Map(CARDS.map(c => [c.id, c]));
}

const RARITY_THEMES = {
  "Közönséges": "rarity-common",
  "Ritka": "rarity-rare",
  "Epic": "rarity-epic",
  "Legendás": "rarity-legendary"
};

app.use(express.json({ limit: "20kb" }));
app.use(cookieParser());
// /uploads/* közvetlenül a tartós data/uploads mappából szolgálódik ki.
app.use("/uploads", express.static(persistentUploadDir, { fallthrough: true }));
app.use(express.static(path.join(__dirname, "public")));

function makeToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function getUserFromRequest(req) {
  const token = req.cookies?.cardgame_token;
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "Nincs bejelentkezve." });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const row = db.prepare(`SELECT is_admin FROM users WHERE id = ?`).get(req.user.id);
  if (!row || !row.is_admin) return res.status(403).json({ error: "Ehhez fejlesztői jogosultság szükséges." });
  next();
}

function cleanUsername(username) {
  return String(username || "").trim();
}

function cleanMessage(message) {
  return String(message || "").trim().replace(/\s+/g, " ");
}

const DEFAULT_AVATAR_URL = "/assets/default-avatar.svg";

function getProfileTitle(matchesPlayed = 0, likesReceived = 0) {
  const matches = Number(matchesPlayed) || 0;
  const likes = Number(likesReceived) || 0;
  if (matches >= 10) return "Harcedzett";
  if (likes >= 2) return "Közkedvelt";
  return "Újonc";
}

function serializeChatMessage(row) {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    message: row.message,
    isAdmin: Boolean(row.is_admin),
    avatarUrl: row.avatar_path ? `/${row.avatar_path.replaceAll('\\\\', '/')}?v=${encodeURIComponent(row.avatar_version || Date.now())}` : DEFAULT_AVATAR_URL,
    createdAt: row.created_at
  };
}

function getChatMessageById(id) {
  const row = db.prepare(`
    SELECT c.id, c.user_id, c.username, c.message, c.is_admin, c.created_at,
           p.avatar_path, p.avatar_version
    FROM chat_messages c
    LEFT JOIN profiles p ON p.user_id = c.user_id
    WHERE c.id = ?
  `).get(id);
  return row ? serializeChatMessage(row) : null;
}

// Egyszerű, memóriában tárolt spam-védelem a chathez.
const chatRate = new Map();

function checkChatRate(userId, content) {
  const now = Date.now();
  const windowMs = 10000;
  const maxInWindow = 6;
  const minGapMs = 500;

  let entry = chatRate.get(userId);
  if (!entry) {
    entry = { timestamps: [], lastMessage: "", repeatCount: 0 };
    chatRate.set(userId, entry);
  }

  entry.timestamps = entry.timestamps.filter(t => now - t < windowMs);

  const last = entry.timestamps[entry.timestamps.length - 1];
  if (last && now - last < minGapMs) {
    return { ok: false, error: "Túl gyorsan küldesz üzenetet, lassíts egy kicsit." };
  }

  if (entry.timestamps.length >= maxInWindow) {
    return { ok: false, error: "Túl sok üzenet rövid idő alatt. Várj néhány másodpercet." };
  }

  if (content && content === entry.lastMessage) {
    entry.repeatCount += 1;
  } else {
    entry.repeatCount = 0;
    entry.lastMessage = content;
  }

  if (entry.repeatCount >= 3) {
    return { ok: false, error: "Ne ismételgesd ugyanazt az üzenetet." };
  }

  entry.timestamps.push(now);
  return { ok: true };
}

function getDeckRules() {
  const row = db.prepare(`SELECT value FROM game_settings WHERE key = ?`).get("deck_rules");
  try { return normalizeDeckRules(JSON.parse(row?.value || "{}")); }
  catch { return normalizeDeckRules({}); }
}

function normalizeDeckRules(rules) {
  const minRaw = Number(rules?.minSize);
  const maxRaw = Number(rules?.maxSize);
  const copyRaw = Number(rules?.maxCopies);
  const minSize = Number.isFinite(minRaw) ? Math.max(0, Math.floor(minRaw)) : 0;
  const maxSize = Number.isFinite(maxRaw) ? Math.max(minSize, Math.floor(maxRaw)) : Math.max(minSize, 60);
  const maxCopies = Number.isFinite(copyRaw) ? Math.min(99, Math.max(1, Math.floor(copyRaw))) : 99;
  const schema = getCardSchema();
  const validTypes = new Set((schema.types || []).map(t => t.id));
  const seen = new Set();
  const requiredTypes = (Array.isArray(rules?.requiredTypes) ? rules.requiredTypes : [])
    .map(rule => ({ typeId: String(rule?.typeId || ""), quantity: Math.max(1, Math.min(99, Math.floor(Number(rule?.quantity) || 1))) }))
    .filter(rule => rule.typeId && validTypes.has(rule.typeId) && !seen.has(rule.typeId) && (seen.add(rule.typeId), true));
  return { minSize, maxSize, maxCopies, requiredTypes };
}

function getDeckCardsMap(deckId, tableName) {
  const rows = db.prepare(`SELECT card_id, quantity FROM ${tableName} WHERE deck_id = ?`).all(deckId);
  return Object.fromEntries(rows.map(row => [String(row.card_id), Number(row.quantity)]));
}

function getCardTypeId(card, schema = getCardSchema()) {
  if (card?.typeId && schema.types.some(type => type.id === card.typeId)) return card.typeId;
  return (schema.types || []).find(type => type.name === card?.type)?.id || null;
}

function validateDeckData(cards, specialCards, rules = getDeckRules()) {
  const schema = getCardSchema();
  const requiredByType = new Map((rules.requiredTypes || []).map(rule => [rule.typeId, Number(rule.quantity)]));
  const errors = [];
  const specialByType = new Map();
  let mainCount = 0;
  let specialCount = 0;

  for (const [id, rawQty] of Object.entries(cards || {})) {
    const qty = Number(rawQty);
    if (!qty) continue;
    const card = cardById.get(Number(id));
    if (!card || !Number.isInteger(qty) || qty < 1) { errors.push({ code: "invalid-card", message: "A pakli ismeretlen vagy érvénytelen kártyát tartalmaz." }); continue; }
    const typeId = getCardTypeId(card, schema);
    if (requiredByType.has(typeId)) errors.push({ code: "reserved-type-in-main", message: `A(z) „${card.type}” típusú kártyák külön kötelező kártyák, nem kerülhetnek a normál pakliba.` });
    if (qty > rules.maxCopies) errors.push({ code: "max-copies", message: `„${card.name}” legfeljebb ${rules.maxCopies} példányban szerepelhet.` });
    mainCount += qty;
  }

  for (const [id, rawQty] of Object.entries(specialCards || {})) {
    const qty = Number(rawQty);
    if (!qty) continue;
    const card = cardById.get(Number(id));
    if (!card || !Number.isInteger(qty) || qty < 1) { errors.push({ code: "invalid-special-card", message: "A külön kártyák között ismeretlen vagy érvénytelen kártya szerepel." }); continue; }
    const typeId = getCardTypeId(card, schema);
    if (!requiredByType.has(typeId)) errors.push({ code: "invalid-special-type", message: `A(z) „${card.name}” kártya típusa nincs kötelező külön kártyaként konfigurálva.` });
    else specialByType.set(typeId, (specialByType.get(typeId) || 0) + qty);
    if (qty > rules.maxCopies) errors.push({ code: "max-copies", message: `„${card.name}” legfeljebb ${rules.maxCopies} példányban szerepelhet.` });
    if (cards && Number(cards[id] || 0) > 0) errors.push({ code: "duplicate-card-role", message: `„${card.name}” nem szerepelhet egyszerre normál és külön kártyaként.` });
    specialCount += qty;
  }

  if (mainCount > rules.maxSize) errors.push({ code: "max-size", message: `A normál pakli legfeljebb ${rules.maxSize} kártyás lehet.` });
  if (mainCount < rules.minSize) errors.push({ code: "min-size", message: `A normál paklinak legalább ${rules.minSize} kártyát kell tartalmaznia.` });

  for (const rule of rules.requiredTypes || []) {
    const actual = specialByType.get(rule.typeId) || 0;
    const typeDef = schema.types.find(type => type.id === rule.typeId);
    if (actual > rule.quantity) errors.push({ code: "special-too-many", message: `A(z) „${typeDef?.name || rule.typeId}” külön kártyából legfeljebb ${rule.quantity} darab lehet.` });
    else if (actual < rule.quantity) errors.push({ code: "special-missing", message: `Hiányzik ${rule.quantity - actual} db „${typeDef?.name || rule.typeId}” külön kártya.` });
  }

  const unique = [];
  const seen = new Set();
  for (const error of errors) if (!seen.has(error.message)) { seen.add(error.message); unique.push(error); }
  return { valid: unique.length === 0, errors: unique, mainCount, specialCount };
}

function getDeckValidation(deckId) {
  return validateDeckData(getDeckCardsMap(deckId, "deck_cards"), getDeckCardsMap(deckId, "deck_special_cards"), getDeckRules());
}

function getDecks(userId) {
  const decks = db.prepare(`
    SELECT d.id, d.name, d.created_at, d.updated_at,
           COALESCE((SELECT SUM(quantity) FROM deck_cards WHERE deck_id = d.id), 0) AS card_count,
           COALESCE((SELECT SUM(quantity) FROM deck_special_cards WHERE deck_id = d.id), 0) AS special_count
    FROM decks d
    WHERE d.user_id = ?
    ORDER BY d.updated_at DESC, d.id DESC
  `).all(userId);

  const cardRows = db.prepare(`SELECT card_id, quantity FROM deck_cards WHERE deck_id = ?`);
  const specialRows = db.prepare(`SELECT card_id, quantity FROM deck_special_cards WHERE deck_id = ?`);

  return decks.map(deck => {
    const cards = Object.fromEntries(cardRows.all(deck.id).map(r => [String(r.card_id), r.quantity]));
    const specialCards = Object.fromEntries(specialRows.all(deck.id).map(r => [String(r.card_id), r.quantity]));
    return { ...deck, cards, specialCards, validation: validateDeckData(cards, specialCards, getDeckRules()) };
  });
}

function getActiveDeckId(userId) {
  const row = db.prepare(`SELECT active_deck_id FROM user_settings WHERE user_id = ?`).get(userId);
  return row?.active_deck_id ?? null;
}

function setActiveDeck(userId, deckId) {
  const exists = db.prepare(`SELECT id FROM decks WHERE id = ? AND user_id = ?`).get(deckId, userId);
  if (!exists) throw new Error("A pakli nem létezik.");

  db.prepare(`
    INSERT INTO user_settings(user_id, active_deck_id)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET active_deck_id = excluded.active_deck_id
  `).run(userId, deckId);
}

function serializeMatch(match) {
  return {
    id: match.id,
    status: match.status,
    players: match.players.map(p => {
      const profile = publicProfileById(p.userId, p.userId);
      return {
        userId: p.userId,
        username: p.username,
        deckName: p.deckName,
        deckId: p.deckId,
        avatarUrl: profile?.avatarUrl || DEFAULT_AVATAR_URL,
        title: profile?.title || "Újonc"
      };
    })
  };
}

const cardImageDir = path.join(persistentUploadDir, "cards");
fs.mkdirSync(cardImageDir, { recursive: true });
const cardImageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, cardImageDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".png";
      cb(null, `card-${Date.now()}-${Math.random().toString(36).slice(2, 9)}${ext}`);
    }
  }),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === "image/png")
});

function getCardSchema() {
  const row = db.prepare(`SELECT value FROM game_settings WHERE key = ?`).get("card_schema");
  try { return JSON.parse(row?.value || '{"fields":[],"types":[]}'); } catch { return { fields: [], types: [] }; }
}

function normalizeCardSchema(schema) {
  const fields = Array.isArray(schema?.fields) ? schema.fields : [];
  const types = Array.isArray(schema?.types) ? schema.types : [];
  const seen = new Set();
  const safeFields = fields.map((f, i) => ({
    id: String(f.id || `field-${i + 1}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50),
    label: String(f.label || '').trim().slice(0, 60),
    inputType: ["text", "number", "textarea"].includes(f.inputType) ? f.inputType : "text",
    required: Boolean(f.required)
  })).filter(f => f.id && f.label && !seen.has(f.id) && (seen.add(f.id), true));
  const validIds = new Set(safeFields.map(f => f.id));
  const safeTypes = types.map((t, i) => ({
    id: String(t.id || `type-${i + 1}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50),
    name: String(t.name || '').trim().slice(0, 60),
    fieldIds: Array.isArray(t.fieldIds) ? [...new Set(t.fieldIds.map(String).filter(id => validIds.has(id)))] : []
  })).filter(t => t.id && t.name);
  return { fields: safeFields, types: safeTypes };
}

app.get("/api/card-schema", auth, (req, res) => {
  res.json({ schema: getCardSchema() });
});

app.put("/api/card-schema", auth, requireAdmin, (req, res) => {
  const previous = getCardSchema();
  const schema = normalizeCardSchema(req.body?.schema || {});
  db.prepare(`INSERT INTO game_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run("card_schema", JSON.stringify(schema));
  for (const nextType of schema.types) {
    const oldType = previous.types.find(type => type.id === nextType.id);
    if (oldType && oldType.name !== nextType.name) {
      db.prepare(`UPDATE cards SET type = ?, type_id = ? WHERE type_id = ? OR (type_id IS NULL AND type = ?)`).run(nextType.name, nextType.id, nextType.id, oldType.name);
    }
  }
  refreshCardsCache();
  const rules = getDeckRules();
  db.prepare(`INSERT INTO game_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run("deck_rules", JSON.stringify(normalizeDeckRules(rules)));
  res.json({ schema });
});

app.get("/api/deck-rules", auth, (req, res) => {
  res.json({ rules: getDeckRules() });
});

app.put("/api/deck-rules", auth, requireAdmin, (req, res) => {
  const rules = normalizeDeckRules(req.body?.rules || {});
  db.prepare(`INSERT INTO game_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run("deck_rules", JSON.stringify(rules));
  res.json({ rules });
});

app.get("/api/cards", (req, res) => {
  res.json({ cards: CARDS });
});

app.post("/api/cards", auth, requireAdmin, (req, res) => {
  const schema = getCardSchema();
  if (!schema.types.length) return res.status(400).json({ error: "Előbb hozz létre legalább egy saját kártyatípust a Kártyarendszer beállításában." });
  const typeId = String(req.body.typeId || "");
  const typeDef = schema.types.find(t => t.id === typeId);
  if (!typeDef) return res.status(400).json({ error: "Érvénytelen kártyatípus." });
  const values = req.body.fields && typeof req.body.fields === "object" ? req.body.fields : {};
  const savedFields = {};
  for (const field of schema.fields) {
    if (!typeDef.fieldIds.includes(field.id)) continue;
    const value = values[field.id] == null ? "" : String(values[field.id]).trim();
    if (field.required && !value) return res.status(400).json({ error: `A(z) ${field.label} mező kötelező.` });
    if (field.inputType === "number" && value !== "" && Number.isNaN(Number(value))) {
      return res.status(400).json({ error: `A(z) ${field.label} mező csak szám lehet.` });
    }
    savedFields[field.id] = value;
  }
  const nameField = schema.fields.find(f => /^(kártya\s*)?név$/i.test(f.label));
  const name = nameField ? String(savedFields[nameField.id] || "Névtelen kártya").slice(0, 80) : `${typeDef.name} #${Date.now()}`;
  const rarityField = schema.fields.find(f => /ritkaság/i.test(f.label));
  const rarity = rarityField ? String(savedFields[rarityField.id] || "").slice(0, 30) : "";
  const className = RARITY_THEMES[rarity] || "rarity-common";
  const imagePath = String(req.body.imagePath || "").trim() || null;
  if (!imagePath) return res.status(400).json({ error: "A teljes kártyakép (PNG) feltöltése kötelező." });
  const result = db.prepare(`
    INSERT INTO cards(name, type, type_id, rarity, icon, image_path, fields_json, class_name, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, typeDef.name, typeDef.id, rarity, "", imagePath, JSON.stringify(savedFields), className, req.user.username);
  refreshCardsCache();
  const card = cardById.get(Number(result.lastInsertRowid));
  io.emit("card:new", card);
  res.json({ card });
});

app.post("/api/cards/image", auth, requireAdmin, (req, res) => {
  cardImageUpload.single("image")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "A PNG legfeljebb 12 MB lehet." : "Csak PNG kép tölthető fel." });
    if (!req.file) return res.status(400).json({ error: "Nem választottál PNG képet." });
    res.json({ imagePath: `uploads/cards/${req.file.filename}` });
  });
});

app.put("/api/cards/:id", auth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM cards WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: "A kártya nem található." });

  const schema = getCardSchema();
  const typeId = String(req.body.typeId || "");
  const typeDef = schema.types.find(t => t.id === typeId);
  if (!typeDef) return res.status(400).json({ error: "Érvénytelen kártyatípus." });
  const values = req.body.fields && typeof req.body.fields === "object" ? req.body.fields : {};
  const savedFields = {};
  for (const field of schema.fields) {
    if (!typeDef.fieldIds.includes(field.id)) continue;
    const value = values[field.id] == null ? "" : String(values[field.id]).trim();
    if (field.required && !value) return res.status(400).json({ error: `A(z) ${field.label} mező kötelező.` });
    if (field.inputType === "number" && value !== "" && Number.isNaN(Number(value))) return res.status(400).json({ error: `A(z) ${field.label} mező csak szám lehet.` });
    savedFields[field.id] = value;
  }
  const nameField = schema.fields.find(f => /^(kártya\s*)?név$/i.test(f.label));
  const name = nameField ? String(savedFields[nameField.id] || "Névtelen kártya").slice(0, 80) : `${typeDef.name} #${id}`;
  const rarityField = schema.fields.find(f => /ritkaság/i.test(f.label));
  const rarity = rarityField ? String(savedFields[rarityField.id] || "").slice(0, 30) : "";
  const className = RARITY_THEMES[rarity] || "rarity-common";
  const imagePath = String(req.body.imagePath || existing.image_path || "").trim() || null;

  db.prepare(`UPDATE cards SET name = ?, type = ?, type_id = ?, rarity = ?, image_path = ?, fields_json = ?, class_name = ? WHERE id = ?`)
    .run(name, typeDef.name, rarity, imagePath, JSON.stringify(savedFields), className, id);

  if (req.body.imagePath && existing.image_path && existing.image_path !== imagePath && existing.image_path.startsWith("uploads/cards/")) {
    try { fs.unlinkSync(path.join(dataDir, existing.image_path)); } catch {}
  }
  refreshCardsCache();
  const card = cardById.get(id);
  io.emit("card:updated", card);
  res.json({ card });
});

app.delete("/api/cards/:id", auth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);

  const usedInDecks = db.prepare(`
    SELECT (SELECT COUNT(*) FROM deck_cards WHERE card_id = ?) + (SELECT COUNT(*) FROM deck_special_cards WHERE card_id = ?) AS c
  `).get(id, id).c;
  if (usedInDecks > 0) {
    return res.status(400).json({ error: "Ez a kártya már szerepel valakinek a paklijában, ezért nem törölhető." });
  }

  const result = db.prepare(`DELETE FROM cards WHERE id = ?`).run(id);
  if (!result.changes) return res.status(404).json({ error: "A kártya nem található." });

  refreshCardsCache();
  io.emit("card:deleted", { id });
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.json({ user: null });

  const dbUser = db.prepare(`SELECT id, username, created_at, matches_played, is_admin FROM users WHERE id = ?`).get(user.id);
  if (!dbUser) return res.json({ user: null });

  const profile = publicProfileById(user.id, user.id) || { username: dbUser.username, bio: '', avatarUrl: DEFAULT_AVATAR_URL, likesReceived: 0, matchesPlayed: dbUser.matches_played, title: getProfileTitle(dbUser.matches_played, 0) };
  res.json({
    user: dbUser,
    isAdmin: Boolean(dbUser.is_admin),
    profile,
    activeDeckId: getActiveDeckId(user.id)
  });
});

app.post("/api/register", (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || "");

  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({
      error: "A felhasználónév 3-20 karakteres lehet, csak betű, szám és _ használható."
    });
  }

  if (password.length < 6 || password.length > 100) {
    return res.status(400).json({ error: "A jelszó 6-100 karakter hosszú legyen." });
  }

  try {
    const hash = bcrypt.hashSync(password, 12);
    const result = db.prepare(`
      INSERT INTO users(username, password_hash) VALUES (?, ?)
    `).run(username, hash);

    const user = { id: Number(result.lastInsertRowid), username };
    db.prepare(`INSERT OR IGNORE INTO profiles(user_id) VALUES (?)`).run(user.id);
    const token = makeToken(user);

    res.cookie("cardgame_token", token, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    res.json({ user });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "Ez a felhasználónév már foglalt." });
    }
    console.error(err);
    res.status(500).json({ error: "Sikertelen regisztráció." });
  }
});

app.post("/api/login", (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || "");

  const user = db.prepare(`
    SELECT id, username, password_hash, created_at
    FROM users WHERE username = ? COLLATE NOCASE
  `).get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Hibás felhasználónév vagy jelszó." });
  }

  const safeUser = { id: user.id, username: user.username };
  db.prepare(`INSERT OR IGNORE INTO profiles(user_id) VALUES (?)`).run(user.id);
  res.cookie("cardgame_token", makeToken(safeUser), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000
  });

  res.json({ user: safeUser });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("cardgame_token");
  res.json({ ok: true });
});

const musicDir = path.join(persistentUploadDir, "music");
fs.mkdirSync(musicDir, { recursive: true });

const musicUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, musicDir),
    filename: (_req, file, cb) => cb(null, `menu-${Date.now()}.mp3`)
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === "audio/mpeg" || file.originalname.toLowerCase().endsWith(".mp3"))
});

const avatarDir = path.join(persistentUploadDir, "avatars");
fs.mkdirSync(avatarDir, { recursive: true });

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, avatarDir),
    filename: (req, file, cb) => {
      const ext = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" }[file.mimetype];
      cb(null, `${req.user.id}-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(null, ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype));
  }
});

function publicProfileById(viewerId, targetId) {
  const row = db.prepare(`
    SELECT u.id, u.username, u.created_at, u.matches_played,
           p.bio, p.avatar_path, p.avatar_version,
           (SELECT COUNT(*) FROM profile_likes WHERE liked_id = u.id) AS likes_received,
           EXISTS(SELECT 1 FROM profile_likes WHERE liker_id = ? AND liked_id = u.id) AS liked_by_me
    FROM users u
    LEFT JOIN profiles p ON p.user_id = u.id
    WHERE u.id = ?
  `).get(viewerId, targetId);
  if (!row) return null;
  const matchesPlayed = Number(row.matches_played) || 0;
  const likesReceived = Number(row.likes_received) || 0;
  return {
    id: row.id,
    username: row.username,
    createdAt: row.created_at,
    matchesPlayed,
    bio: row.bio || "",
    avatarUrl: row.avatar_path ? `/${row.avatar_path.replaceAll('\\', '/')}?v=${encodeURIComponent(row.avatar_version || Date.now())}` : DEFAULT_AVATAR_URL,
    likesReceived,
    likedByMe: Boolean(row.liked_by_me),
    title: getProfileTitle(matchesPlayed, likesReceived),
    isSelf: viewerId === row.id,
    online: onlineSockets.has(row.id)
  };
}

app.get("/api/players/online", auth, (req, res) => {
  const ids = [...onlineSockets.keys()];
  if (!ids.length) return res.json({ players: [] });
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id FROM users WHERE id IN (${placeholders}) ORDER BY username COLLATE NOCASE`).all(...ids);
  res.json({ players: rows.map(r => publicProfileById(req.user.id, r.id)).filter(Boolean) });
});

app.get("/api/profiles/:username", auth, (req, res) => {
  const target = db.prepare(`SELECT id FROM users WHERE username = ? COLLATE NOCASE`).get(cleanUsername(req.params.username));
  if (!target) return res.status(404).json({ error: "A játékos nem található." });
  const profile = publicProfileById(req.user.id, target.id);
  res.json({ profile });
});

app.put("/api/profile", auth, (req, res) => {
  const bio = String(req.body.bio || "").trim();
  if (bio.length > 100) return res.status(400).json({ error: "A bemutatkozás legfeljebb 100 karakter lehet." });
  db.prepare(`INSERT INTO profiles(user_id, bio) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET bio = excluded.bio`).run(req.user.id, bio);
  res.json({ profile: publicProfileById(req.user.id, req.user.id) });
});

app.post("/api/profile/avatar", auth, (req, res) => {
  avatarUpload.single("avatar")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "A kép legfeljebb 1 MB lehet." : "Csak JPG, PNG, WEBP vagy GIF kép tölthető fel." });
    if (!req.file) return res.status(400).json({ error: "Nem választottál képet." });
    const old = db.prepare(`SELECT avatar_path FROM profiles WHERE user_id = ?`).get(req.user.id);
    if (old?.avatar_path && old.avatar_path !== `uploads/avatars/${req.file.filename}`) {
      try { fs.unlinkSync(path.join(dataDir, old.avatar_path)); } catch {}
    }
    const avatarPath = `uploads/avatars/${req.file.filename}`;
    const avatarVersion = String(Date.now());
    db.prepare(`INSERT INTO profiles(user_id, avatar_path, avatar_version) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET avatar_path = excluded.avatar_path, avatar_version = excluded.avatar_version`).run(req.user.id, avatarPath, avatarVersion);
    const profile = publicProfileById(req.user.id, req.user.id);
    io.emit("profile:avatar-updated", { userId: req.user.id, avatarUrl: profile.avatarUrl });
    res.json({ profile });
  });
});

app.post("/api/profiles/:username/like", auth, (req, res) => {
  const target = db.prepare(`SELECT id FROM users WHERE username = ? COLLATE NOCASE`).get(cleanUsername(req.params.username));
  if (!target) return res.status(404).json({ error: "A játékos nem található." });
  if (target.id === req.user.id) return res.status(400).json({ error: "A saját profilodat nem lehet lájkolni." });

  const alreadyLiked = db.prepare(`SELECT 1 FROM profile_likes WHERE liker_id = ? AND liked_id = ?`).get(req.user.id, target.id);
  db.prepare(`INSERT OR IGNORE INTO profile_likes(liker_id, liked_id) VALUES (?, ?)`).run(req.user.id, target.id);

  if (!alreadyLiked) {
    notifyUser(target.id, {
      type: "like",
      title: "Új lájk",
      body: `${req.user.username} lájkolta a profilodat.`,
      link: "players"
    });
  }

  res.json({ profile: publicProfileById(req.user.id, target.id) });
});

app.delete("/api/profiles/:username/like", auth, (req, res) => {
  const target = db.prepare(`SELECT id FROM users WHERE username = ? COLLATE NOCASE`).get(cleanUsername(req.params.username));
  if (!target) return res.status(404).json({ error: "A játékos nem található." });
  db.prepare(`DELETE FROM profile_likes WHERE liker_id = ? AND liked_id = ?`).run(req.user.id, target.id);
  res.json({ profile: publicProfileById(req.user.id, target.id) });
});

app.get("/api/profile/likes", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.matches_played, p.bio, p.avatar_path, p.avatar_version
    FROM profile_likes l
    JOIN users u ON u.id = l.liker_id
    LEFT JOIN profiles p ON p.user_id = u.id
    WHERE l.liked_id = ?
    ORDER BY l.created_at DESC
  `).all(req.user.id);
  res.json({ likers: rows.map(r => ({
    id: r.id, username: r.username, matchesPlayed: r.matches_played, bio: r.bio || "",
    avatarUrl: r.avatar_path ? `/${r.avatar_path.replaceAll('\\', '/')}?v=${encodeURIComponent(r.avatar_version || Date.now())}` : DEFAULT_AVATAR_URL,
    online: onlineSockets.has(r.id)
  })) });
});

app.get("/api/decks", auth, (req, res) => {
  res.json({ decks: getDecks(req.user.id), activeDeckId: getActiveDeckId(req.user.id), deckRules: getDeckRules() });
});

app.post("/api/decks", auth, (req, res) => {
  const name = String(req.body.name || "").trim();

  if (name.length < 1 || name.length > 40) {
    return res.status(400).json({ error: "A pakli neve 1-40 karakter legyen." });
  }

  const result = db.prepare(`
    INSERT INTO decks(user_id, name) VALUES (?, ?)
  `).run(req.user.id, name);

  const deckId = Number(result.lastInsertRowid);
  res.json({ deck: getDecks(req.user.id).find(d => d.id === deckId) });
});

app.put("/api/decks/:id", auth, (req, res) => {
  const deckId = Number(req.params.id);
  const name = String(req.body.name || "").trim();

  if (!Number.isInteger(deckId) || name.length < 1 || name.length > 40) {
    return res.status(400).json({ error: "Érvénytelen adatok." });
  }

  const result = db.prepare(`
    UPDATE decks
    SET name = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(name, deckId, req.user.id);

  if (!result.changes) return res.status(404).json({ error: "Pakli nem található." });
  res.json({ ok: true });
});

app.delete("/api/decks/:id", auth, (req, res) => {
  const deckId = Number(req.params.id);
  const active = getActiveDeckId(req.user.id);

  if (active === deckId) {
    db.prepare(`
      INSERT INTO user_settings(user_id, active_deck_id)
      VALUES (?, NULL)
      ON CONFLICT(user_id) DO UPDATE SET active_deck_id = NULL
    `).run(req.user.id);
  }

  const result = db.prepare(`
    DELETE FROM decks WHERE id = ? AND user_id = ?
  `).run(deckId, req.user.id);

  if (!result.changes) return res.status(404).json({ error: "Pakli nem található." });
  res.json({ ok: true });
});

app.put("/api/decks/:id/cards", auth, (req, res) => {
  const deckId = Number(req.params.id);
  const cards = req.body.cards;
  const specialCards = req.body.specialCards || {};
  const deck = db.prepare(`SELECT id FROM decks WHERE id = ? AND user_id = ?`).get(deckId, req.user.id);
  if (!deck || !cards || typeof cards !== "object" || Array.isArray(cards) || typeof specialCards !== "object" || Array.isArray(specialCards)) return res.status(400).json({ error: "Érvénytelen pakli." });

  const normalEntries = Object.entries(cards);
  const specialEntries = Object.entries(specialCards);
  if (normalEntries.some(([id, qty]) => !cardById.has(Number(id)) || !Number.isInteger(qty) || qty < 0 || qty > 99)) return res.status(400).json({ error: "Érvénytelen kártyamennyiség." });
  if (specialEntries.some(([id, qty]) => !cardById.has(Number(id)) || !Number.isInteger(qty) || qty < 0 || qty > 99)) return res.status(400).json({ error: "Érvénytelen külön kártyamennyiség." });

  const validation = validateDeckData(cards, specialCards, getDeckRules());
  const hardCodes = new Set(["invalid-card", "invalid-special-card", "invalid-special-type", "reserved-type-in-main", "duplicate-card-role", "max-copies", "max-size", "special-too-many"]);
  const hardErrors = validation.errors.filter(error => hardCodes.has(error.code));
  if (hardErrors.length) return res.status(400).json({ error: hardErrors.map(e => e.message).join(" "), validation });

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM deck_cards WHERE deck_id = ?`).run(deckId);
    db.prepare(`DELETE FROM deck_special_cards WHERE deck_id = ?`).run(deckId);
    const insertNormal = db.prepare(`INSERT INTO deck_cards(deck_id, card_id, quantity) VALUES (?, ?, ?)`);
    const insertSpecial = db.prepare(`INSERT INTO deck_special_cards(deck_id, card_id, quantity) VALUES (?, ?, ?)`);
    for (const [id, qty] of normalEntries) if (qty > 0) insertNormal.run(deckId, Number(id), qty);
    for (const [id, qty] of specialEntries) if (qty > 0) insertSpecial.run(deckId, Number(id), qty);
    db.prepare(`UPDATE decks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(deckId);
  });
  tx();
  res.json({ ok: true, decks: getDecks(req.user.id), deckRules: getDeckRules() });
});

app.post("/api/decks/:id/activate", auth, (req, res) => {
  const deckId = Number(req.params.id);
  try {
    setActiveDeck(req.user.id, deckId);
    res.json({ ok: true, activeDeckId: deckId });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get("/api/chat", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.user_id, c.username, c.message, c.is_admin, c.created_at,
           p.avatar_path, p.avatar_version
    FROM chat_messages c
    LEFT JOIN profiles p ON p.user_id = c.user_id
    ORDER BY c.id DESC LIMIT 100
  `).all().reverse();

  res.json({ messages: rows.map(serializeChatMessage) });
});

app.post("/api/chat", auth, (req, res) => {
  const message = cleanMessage(req.body.message);

  if (!message) return res.status(400).json({ error: "Üres üzenet." });
  if (message.length > 500) return res.status(400).json({ error: "Az üzenet túl hosszú." });

  const rate = checkChatRate(req.user.id, message);
  if (!rate.ok) return res.status(429).json({ error: rate.error });

  const senderIsAdmin = db.prepare(`SELECT is_admin FROM users WHERE id = ?`).get(req.user.id)?.is_admin ? 1 : 0;

  const result = db.prepare(`
    INSERT INTO chat_messages(user_id, username, message, is_admin)
    VALUES (?, ?, ?, ?)
  `).run(req.user.id, req.user.username, message, senderIsAdmin);

  const saved = getChatMessageById(result.lastInsertRowid);
  io.emit("chat:new", saved);
  res.json(saved);
});

// ---- News System ----

app.get("/api/news", auth, (req, res) => {
  const posts = db.prepare(`
    SELECT id, title, body, author_username, created_at
    FROM news_posts ORDER BY id DESC LIMIT 50
  `).all();
  res.json({ posts });
});

app.post("/api/news", auth, requireAdmin, (req, res) => {
  const title = String(req.body.title || "").trim();
  const body = String(req.body.body || "").trim();

  if (title.length < 1 || title.length > 120) {
    return res.status(400).json({ error: "A cím 1-120 karakter legyen." });
  }
  if (body.length < 1 || body.length > 4000) {
    return res.status(400).json({ error: "A szöveg 1-4000 karakter legyen." });
  }

  const result = db.prepare(`
    INSERT INTO news_posts(title, body, author_id, author_username) VALUES (?, ?, ?, ?)
  `).run(title, body, req.user.id, req.user.username);

  const post = db.prepare(`
    SELECT id, title, body, author_username, created_at FROM news_posts WHERE id = ?
  `).get(result.lastInsertRowid);

  io.emit("news:new", post);

  const userIds = db.prepare(`SELECT id FROM users`).all().map(r => r.id);
  for (const uid of userIds) {
    notifyUser(uid, {
      type: "news",
      title: `Új hír: ${title}`,
      body: body.length > 140 ? `${body.slice(0, 140)}…` : body,
      link: "news"
    });
  }

  res.json({ post });
});

app.delete("/api/news/:id", auth, requireAdmin, (req, res) => {
  const result = db.prepare(`DELETE FROM news_posts WHERE id = ?`).run(Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: "A hír nem található." });
  io.emit("news:deleted", { id: Number(req.params.id) });
  res.json({ ok: true });
});

// ---- Notification System ----

app.get("/api/notifications", auth, (req, res) => {
  const notifications = db.prepare(`
    SELECT id, type, title, body, link, read, created_at
    FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50
  `).all(req.user.id);

  const unreadCount = db.prepare(`
    SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0
  `).get(req.user.id).c;

  res.json({ notifications, unreadCount });
});

app.post("/api/notifications/:id/read", auth, (req, res) => {
  db.prepare(`
    UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?
  `).run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

app.post("/api/notifications/read-all", auth, (req, res) => {
  db.prepare(`UPDATE notifications SET read = 1 WHERE user_id = ?`).run(req.user.id);
  res.json({ ok: true });
});

// ---- Játékbeállítások / menüzene ----
app.get("/api/settings/public", auth, (req, res) => {
  const row = db.prepare(`SELECT value FROM game_settings WHERE key = ?`).get("menu_music");
  res.json({ menuMusic: row?.value ? `/${row.value}` : "" });
});

app.post("/api/admin/music", auth, requireAdmin, (req, res) => {
  musicUpload.single("music")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Az MP3 legfeljebb 20 MB lehet." : "Csak MP3 fájl tölthető fel." });
    if (!req.file) return res.status(400).json({ error: "Nem választottál MP3 fájlt." });

    const old = db.prepare(`SELECT value FROM game_settings WHERE key = ?`).get("menu_music")?.value;
    const musicPath = `uploads/music/${req.file.filename}`;
    db.prepare(`INSERT INTO game_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run("menu_music", musicPath);
    if (old && old !== musicPath && old.startsWith("uploads/music/")) {
      try { fs.unlinkSync(path.join(dataDir, old)); } catch {}
    }
    res.json({ menuMusic: `/${musicPath}` });
  });
});

// ---- Developer Center statisztikák ----

function recordPresenceSnapshot() {
  db.prepare(`INSERT INTO presence_log(online_count) VALUES (?)`).run(onlineSockets.size);
}

app.get("/api/admin/stats", auth, requireAdmin, (req, res) => {
  const totalUsers = db.prepare(`SELECT COUNT(*) c FROM users`).get().c;
  const totalMatches = db.prepare(`SELECT COUNT(*) c FROM match_log`).get().c;
  const matches24h = db.prepare(`SELECT COUNT(*) c FROM match_log WHERE created_at >= datetime('now', '-1 day')`).get().c;
  const totalDecks = db.prepare(`SELECT COUNT(*) c FROM decks`).get().c;
  const totalChatMessages = db.prepare(`SELECT COUNT(*) c FROM chat_messages`).get().c;
  const totalNewsPosts = db.prepare(`SELECT COUNT(*) c FROM news_posts`).get().c;
  const totalLikes = db.prepare(`SELECT COUNT(*) c FROM profile_likes`).get().c;
  const newUsers7d = db.prepare(`SELECT COUNT(*) c FROM users WHERE created_at >= datetime('now', '-7 days')`).get().c;

  const rankedPlayers = db.prepare(`
    SELECT u.id, u.username, COUNT(l.liker_id) AS likes, u.matches_played,
           COALESCE((SELECT COUNT(*) FROM decks d WHERE d.user_id = u.id), 0) AS decks
    FROM users u
    LEFT JOIN profile_likes l ON l.liked_id = u.id
    GROUP BY u.id
    ORDER BY likes DESC, u.username COLLATE NOCASE ASC
  `).all();

  const rankedCards = db.prepare(`
    SELECT c.id, c.name, c.type, c.rarity, COALESCE(SUM(dc.quantity), 0) AS total
    FROM cards c
    LEFT JOIN deck_cards dc ON dc.card_id = c.id
    GROUP BY c.id
    ORDER BY total DESC, c.name COLLATE NOCASE ASC
  `).all();

  const matchDetails = db.prepare(`
    SELECT id, player_a, player_b, created_at
    FROM match_log ORDER BY datetime(created_at) DESC LIMIT 200
  `).all();

  const likeDetails = db.prepare(`
    SELECT l.rowid AS id, liker.username AS liker_username,
           liked.username AS liked_username, l.created_at
    FROM profile_likes l
    JOIN users liker ON liker.id = l.liker_id
    JOIN users liked ON liked.id = l.liked_id
    ORDER BY datetime(l.created_at) DESC LIMIT 200
  `).all();

  const chatLeaderboard = db.prepare(`
    SELECT username, COUNT(*) AS messages
    FROM chat_messages GROUP BY user_id
    ORDER BY messages DESC, username COLLATE NOCASE ASC
  `).all();

  const deckLeaderboard = db.prepare(`
    SELECT u.username, COUNT(d.id) AS decks
    FROM users u LEFT JOIN decks d ON d.user_id = u.id
    GROUP BY u.id
    ORDER BY decks DESC, username COLLATE NOCASE ASC
  `).all();

  const recentUsers = db.prepare(`
    SELECT username, created_at FROM users
    ORDER BY datetime(created_at) DESC LIMIT 50
  `).all();

  const hourlyOnline = db.prepare(`
    SELECT strftime('%Y-%m-%d %H:00', recorded_at) AS hour, MAX(online_count) AS peak
    FROM presence_log
    WHERE recorded_at >= datetime('now', '-24 hours')
    GROUP BY hour ORDER BY hour ASC
  `).all();

  const music = db.prepare(`SELECT value FROM game_settings WHERE key = ?`).get("menu_music")?.value || "";

  res.json({
    totalUsers, onlineNow: onlineSockets.size, totalMatches, matches24h, totalDecks,
    totalChatMessages, totalNewsPosts, totalLikes, newUsers7d,
    rankedPlayers, rankedCards, matchDetails, likeDetails, chatLeaderboard,
    deckLeaderboard, recentUsers, hourlyOnline,
    deckRules: getDeckRules(),
    menuMusic: music ? `/${music}` : ""
  });
});

const onlineSockets = new Map();
const queue = [];
const matches = new Map();

function emitToUser(userId, event, payload) {
  const set = onlineSockets.get(userId);
  if (!set) return;
  for (const socketId of set) io.to(socketId).emit(event, payload);
}

function notifyUser(userId, { type, title, body = "", link = null }) {
  const result = db.prepare(`
    INSERT INTO notifications(user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)
  `).run(userId, type, title, body, link);

  const saved = db.prepare(`
    SELECT id, type, title, body, link, read, created_at FROM notifications WHERE id = ?
  `).get(result.lastInsertRowid);

  emitToUser(userId, "notification:new", saved);
  return saved;
}

function removeFromQueue(userId) {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].userId === userId) queue.splice(i, 1);
  }
}

function findSocketForUser(userId) {
  const set = onlineSockets.get(userId);
  if (!set || !set.size) return null;
  return [...set][0];
}

function tryMatchmaking() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();

    if (a.userId === b.userId) {
      queue.unshift(b);
      break;
    }

    const validationA = getDeckValidation(a.deckId);
    if (!validationA.valid) { emitToUser(a.userId, "queue:error", `A paklid időközben szabálytalanná vált: ${validationA.errors.map(error => error.message).join(" ")}`); queue.unshift(b); continue; }
    const validationB = getDeckValidation(b.deckId);
    if (!validationB.valid) { emitToUser(b.userId, "queue:error", `A paklid időközben szabálytalanná vált: ${validationB.errors.map(error => error.message).join(" ")}`); queue.unshift(a); continue; }

    const match = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: "playing",
      players: [a, b]
    };

    matches.set(match.id, match);

    db.prepare(`UPDATE users SET matches_played = matches_played + 1 WHERE id IN (?, ?)`).run(a.userId, b.userId);
    db.prepare(`INSERT INTO match_log(player_a, player_b) VALUES (?, ?)`).run(a.username, b.username);

    for (const player of match.players) {
      const opponent = match.players.find(p => p.userId !== player.userId);

      notifyUser(player.userId, {
        type: "match",
        title: "Meccs találat",
        body: `Ellenfél: ${opponent.username}`,
        link: "match"
      });

      const socketId = findSocketForUser(player.userId);
      if (socketId) {
        io.to(socketId).emit("match:found", serializeMatch(match));
      }
    }
  }
}

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers.cookie
      ?.split(";")
      .map(x => x.trim())
      .find(x => x.startsWith("cardgame_token="))
      ?.split("=")[1];

    if (!token) return next(new Error("Nincs bejelentkezve."));

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare(`SELECT id, username FROM users WHERE id = ?`).get(decoded.id);
    if (!user) return next(new Error("A felhasználó nem található."));

    socket.user = user;
    next();
  } catch {
    next(new Error("Érvénytelen munkamenet."));
  }
});

io.on("connection", socket => {
  const userId = socket.user.id;

  const wasOnline = onlineSockets.has(userId);
  if (!onlineSockets.has(userId)) onlineSockets.set(userId, new Set());
  onlineSockets.get(userId).add(socket.id);

  io.emit("presence:update", { username: socket.user.username, online: true, userId });
  socket.emit("presence:list", { userIds: [...onlineSockets.keys()] });
  if (!wasOnline) recordPresenceSnapshot();

  socket.on("queue:join", () => {
    removeFromQueue(userId);

    const activeDeckId = getActiveDeckId(userId);
    if (!activeDeckId) return socket.emit("queue:error", "Előbb válassz ki egy aktív paklit.");

    const deck = db.prepare(`SELECT id, name FROM decks WHERE id = ? AND user_id = ?`).get(activeDeckId, userId);
    if (!deck) return socket.emit("queue:error", "Az aktív pakli nem található.");

    const validation = getDeckValidation(deck.id);
    if (!validation.valid) return socket.emit("queue:error", `A pakli nem szabályos: ${validation.errors.map(error => error.message).join(" ")}`);

    queue.push({
      userId,
      username: socket.user.username,
      deckId: deck.id,
      deckName: deck.name
    });

    socket.emit("queue:joined", { playersWaiting: queue.length });
    io.emit("queue:count", { count: queue.length });
    tryMatchmaking();
  });

  socket.on("queue:leave", () => {
    removeFromQueue(userId);
    io.emit("queue:count", { count: queue.length });
  });

  socket.on("disconnect", () => {
    removeFromQueue(userId);

    const set = onlineSockets.get(userId);
    if (set) {
      set.delete(socket.id);
      if (!set.size) {
        onlineSockets.delete(userId);
        io.emit("presence:update", { username: socket.user.username, online: false });
        recordPresenceSnapshot();
      }
    }

    io.emit("queue:count", { count: queue.length });
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

recordPresenceSnapshot();
setInterval(recordPresenceSnapshot, 15 * 60 * 1000);

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("======================================");
  console.log(" MAXIMA szerver elindult");
  console.log(` Port: ${PORT}`);
  console.log("======================================");
  console.log(` Helyben: http://localhost:${PORT}`);

  const interfaces = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const info of addresses || []) {
      if (info.family === "IPv4" && !info.internal) {
        console.log(` MAXIMA hálózati cím (${name}): http://${info.address}:${PORT}`);
      }
    }
  }
  console.log("");
});
