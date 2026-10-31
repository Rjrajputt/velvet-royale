const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'velvet-royale.db'));
db.pragma('journal_mode = WAL');

const activeRounds = new Map();

const suits = ['♠', '♥', '♦', '♣'];
const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function buildDeck() {
  const deck = [];
  for (const suit of suits) {
    for (const value of values) {
      deck.push({
        suit,
        value,
        label: `${value}${suit}`,
        weight: values.indexOf(value) + 2,
      });
    }
  }

  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function getHandCategory(cards) {
  const valuesInOrder = [...cards].map((card) => card.weight).sort((a, b) => a - b);
  const uniqueValues = [...new Set(valuesInOrder)];
  const counts = valuesInOrder.reduce((acc, value) => {
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});

  const sameSuit = cards.every((card) => card.suit === cards[0].suit);
  const isSequence = uniqueValues.length === 3 && valuesInOrder[2] - valuesInOrder[0] === 2 && valuesInOrder[1] - valuesInOrder[0] === 1;
  const hasPair = Object.values(counts).includes(2);
  const isTrail = uniqueValues.length === 1;
  const isPureSequence = sameSuit && isSequence;

  if (isTrail) {
    return { category: 6, label: 'Trail', high: Math.max(...valuesInOrder) };
  }

  if (isPureSequence) {
    return { category: 5, label: 'Pure Sequence', high: Math.max(...valuesInOrder) };
  }

  if (isSequence) {
    return { category: 4, label: 'Sequence', high: Math.max(...valuesInOrder) };
  }

  if (sameSuit) {
    return { category: 3, label: 'Colour', high: Math.max(...valuesInOrder) };
  }

  if (hasPair) {
    const pairValue = Number(Object.entries(counts).find(([, count]) => count === 2)[0]);
    return { category: 2, label: 'Pair', high: pairValue };
  }

  return { category: 1, label: 'High Card', high: Math.max(...valuesInOrder) };
}

function compareHands(playerCards, dealerCards) {
  const player = getHandCategory(playerCards);
  const dealer = getHandCategory(dealerCards);

  if (player.category !== dealer.category) {
    return player.category > dealer.category ? 'player' : 'dealer';
  }

  if (player.high !== dealer.high) {
    return player.high > dealer.high ? 'player' : 'dealer';
  }

  const playerTotal = playerCards.reduce((sum, card) => sum + card.weight, 0);
  const dealerTotal = dealerCards.reduce((sum, card) => sum + card.weight, 0);

  return playerTotal >= dealerTotal ? 'player' : 'dealer';
}

function ensureWalletForUser(userId) {
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
  if (!wallet) {
    db.prepare('INSERT INTO wallets (user_id, vc_balance) VALUES (?, 0)').run(userId);
  }
}

function getUserFromSession(req) {
  const token = req.cookies?.session;
  if (!token) {
    return null;
  }

  const row = db
    .prepare(
      `SELECT u.id, u.username, u.last_bonus_at, w.vc_balance
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(token, new Date().toISOString());

  return row || null;
}

function requireAuth(req, res, next) {
  const user = getUserFromSession(req);
  if (!user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  req.user = user;
  next();
}

function createSessionCookie(res, token) {
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function createGuestSession(res) {
  const username = `Guest_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const passwordHash = sha256(`${username}:${Date.now()}`);

  const insertUser = db.prepare(
    'INSERT INTO users (username, password_hash, last_bonus_at) VALUES (?, ?, NULL)'
  );
  const userId = insertUser.run(username, passwordHash).lastInsertRowid;

  ensureWalletForUser(Number(userId));

  const token = randomId('sess');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);

  createSessionCookie(res, token);

  return db
    .prepare(
      `SELECT u.id, u.username, u.last_bonus_at, w.vc_balance
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.id = ?`
    )
    .get(userId);
}

function getUserBalance(userId) {
  const row = db.prepare('SELECT vc_balance FROM wallets WHERE user_id = ?').get(userId);
  return row ? row.vc_balance : 0;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    last_bonus_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    vc_balance INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS game_rounds (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    game_name TEXT NOT NULL,
    details TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/boot', (req, res) => {
  const user = getUserFromSession(req);
  if (user) {
    return res.json({ ok: true, user });
  }

  const guest = createGuestSession(res);
  return res.json({ ok: true, user: guest, guestMode: true });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies?.session;
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = getUserFromSession(req);
  res.json({ ok: true, user });
});

app.post('/api/claim-daily-bonus', requireAuth, (req, res) => {
  const user = req.user;
  const now = new Date();
  const lastBonus = user.last_bonus_at ? new Date(user.last_bonus_at) : null;
  const eligible = !lastBonus || now.getTime() - lastBonus.getTime() >= 24 * 60 * 60 * 1000;

  if (!eligible) {
    const remainingMs = 24 * 60 * 60 * 1000 - (now.getTime() - lastBonus.getTime());
    const remainingHours = Math.max(0, Math.ceil(remainingMs / (60 * 60 * 1000)));
    return res.status(400).json({ ok: false, message: `Daily bonus available in ${remainingHours}h.` });
  }

  const bonus = 250;
  db.prepare('UPDATE wallets SET vc_balance = vc_balance + ? WHERE user_id = ?').run(bonus, user.id);
  db.prepare('UPDATE users SET last_bonus_at = ? WHERE id = ?').run(now.toISOString(), user.id);

  const updatedUser = db
    .prepare(
      `SELECT u.id, u.username, u.last_bonus_at, w.vc_balance
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.id = ?`
    )
    .get(user.id);

  res.json({ ok: true, amount: bonus, user: updatedUser });
});

app.post('/api/mock-buy-vc', requireAuth, (req, res) => {
  const pack = String(req.body?.pack || 'starter');
  const packMap = {
    starter: 250,
    royal: 1200,
    vip: 5000,
  };

  const amount = packMap[pack] ?? packMap.starter;
  if (!amount) {
    return res.status(400).json({ ok: false, message: 'Unknown VC bundle.' });
  }

  db.prepare('UPDATE wallets SET vc_balance = vc_balance + ? WHERE user_id = ?').run(amount, req.user.id);

  const updatedUser = db
    .prepare(
      `SELECT u.id, u.username, u.last_bonus_at, w.vc_balance
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.id = ?`
    )
    .get(req.user.id);

  res.json({ ok: true, amount, user: updatedUser, demoOnly: true, message: 'Demo purchase only — no actual money moved.' });
});

app.get('/api/leaderboard', (req, res) => {
  const rows = db.prepare(`
    SELECT u.username, w.vc_balance
    FROM wallets w
    JOIN users u ON u.id = w.user_id
    ORDER BY w.vc_balance DESC
    LIMIT 10
  `).all();

  res.json({ ok: true, leaderboard: rows });
});

app.post('/api/game/teen-patti/start', requireAuth, (req, res) => {
  const bet = Math.max(5, Number(req.body?.bet || 25));
  const deck = buildDeck();
  const playerCards = deck.slice(0, 3);
  const dealerCards = deck.slice(3, 6);
  const result = compareHands(playerCards, dealerCards);
  const roundId = randomId('teenpatti');

  activeRounds.set(roundId, {
    userId: req.user.id,
    bet,
    playerCards,
    dealerCards,
    result,
    createdAt: new Date().toISOString(),
  });

  db.prepare('INSERT INTO game_rounds (id, user_id, game_name, details) VALUES (?, ?, ?, ?)').run(
    roundId,
    req.user.id,
    'teen-patti',
    JSON.stringify({ bet, playerCards, dealerCards, result })
  );

  const playerSummary = getHandCategory(playerCards);
  const dealerSummary = getHandCategory(dealerCards);

  res.json({
    ok: true,
    roundId,
    bet,
    userBalance: getUserBalance(req.user.id),
    playerCards,
    dealerCards,
    playerHand: playerSummary,
    dealerHand: dealerSummary,
    status: 'pending',
    outcome: result,
    note: 'Server-authoritative showdown ready for resolution.',
  });
});

app.post('/api/game/teen-patti/resolve', requireAuth, (req, res) => {
  const roundId = String(req.body?.roundId || '');
  const round = activeRounds.get(roundId);

  if (!round || Number(round.userId) !== Number(req.user.id)) {
    return res.status(404).json({ ok: false, message: 'Round not found.' });
  }

  const playerWon = round.result === 'player';
  const payout = playerWon ? round.bet * 2 : 0;
  const walletChange = playerWon ? payout : -round.bet;

  db.prepare('UPDATE wallets SET vc_balance = vc_balance + ? WHERE user_id = ?').run(walletChange, req.user.id);
  activeRounds.delete(roundId);

  const user = db
    .prepare(
      `SELECT u.id, u.username, u.last_bonus_at, w.vc_balance
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.id = ?`
    )
    .get(req.user.id);

  res.json({
    ok: true,
    outcome: playerWon ? 'win' : 'loss',
    won: playerWon,
    payout,
    bet: round.bet,
    playerCards: round.playerCards,
    dealerCards: round.dealerCards,
    playerHand: getHandCategory(round.playerCards),
    dealerHand: getHandCategory(round.dealerCards),
    user,
    demoOnly: true,
  });
});

app.post('/api/game/raffle/draw', requireAuth, (req, res) => {
  const ticketCount = Math.max(1, Number(req.body?.ticketCount || 1));
  const playersTicket = Array.from({ length: ticketCount }, () => Math.floor(Math.random() * 10));
  const winningNumbers = Array.from({ length: 3 }, () => Math.floor(Math.random() * 10));
  const matches = playersTicket.filter((value, index) => value === winningNumbers[index % winningNumbers.length]).length;

  let winAmount = 0;
  if (matches >= 3) winAmount = 500;
  else if (matches === 2) winAmount = 120;
  else if (matches === 1) winAmount = 20;

  db.prepare('UPDATE wallets SET vc_balance = vc_balance + ? WHERE user_id = ?').run(winAmount, req.user.id);

  const user = db
    .prepare(
      `SELECT u.id, u.username, u.last_bonus_at, w.vc_balance
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.id = ?`
    )
    .get(req.user.id);

  res.json({
    ok: true,
    ticket: playersTicket,
    winningNumbers,
    matches,
    winAmount,
    user,
    demoOnly: true,
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'Velvet Royale', mode: 'virtual-currency prototype' });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Velvet Royale running on http://localhost:${PORT}`);
});
