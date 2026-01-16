const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.use(express.json());

// Load users from users.txt (format: CODE,Name per line)
const fs = require('fs');
const path = require('path');
const usersFile = path.join(__dirname, 'users.txt');
let usersByCode = {};
let DEALER_CODE = null;
let usersOrder = []; // preserve order from users.txt
let connectedSockets = {}; // socketId -> { name, code }
let usersStatus = {}; // code -> { connected: bool, socketId: string | null }
try {
  const lines = fs.readFileSync(usersFile, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const ln of lines) {
    const parts = ln.split(',');
    if (parts.length >= 2) {
      const code = parts[0].trim();
      const name = parts.slice(1).join(',').trim();
      if (/^\d{6}$/.test(code) && name) {
        usersByCode[code] = name;
        // preserve ordering
        usersOrder.push(code);
        usersStatus[code] = { connected: false, socketId: null };
      }
    }
  }
  console.log('Loaded users:', Object.keys(usersByCode).length);

  // Derive dealer code from users.txt (match name "Dealer", case-insensitive)
  for (const [code, name] of Object.entries(usersByCode)) {
    if (String(name).toLowerCase() === 'dealer') { DEALER_CODE = code; break; }
  }
  if (DEALER_CODE) console.log('Dealer code set to', DEALER_CODE);
} catch (err) {
  console.warn('Could not read users.txt:', err.message);
} 

// Verify code endpoint
app.post('/verify-code', (req, res) => {
  const { code } = req.body || {};
  if (!code || typeof code !== 'string') return res.status(400).json({ ok: false });
  const c = code.trim();
  if (!/^\d{6}$/.test(c)) return res.status(400).json({ ok: false });
  const name = usersByCode[c];
  if (!name) return res.status(401).json({ ok: false });
  // Return the authenticated name (client will set cookie)
  return res.json({ ok: true, name });
});

let dealerSocket = null;
let betsOpen = false;
let selections = {}; // socketId -> { name, bet }
let weightBySocket = {}; // socketId -> numeric weight
let lastSpinResult = null; // { winningNumber, results } of the last spin, sent to newly connected clients
const SPIN_ANIMATION_MS = 4200; // server-side guard window for consecutive spins
let spinning = false; // prevents overlapping spins from dealer

io.on("connection", socket => {
  socket.on("join", identifier => {
    // Identifier is expected to be a 6-digit code (mandatory login). If it's a valid code
    // we look up the user's name. Otherwise, accept it as a display name (fallback).
    let assignedName = identifier;
    if (typeof identifier === 'string' && /^\d{6}$/.test(identifier)) {
      const code = identifier;
      const name = usersByCode[code];
      if (name) {
        socket.data.name = name;
        socket.data.code = code;
        assignedName = name;
        // Auto-grant dealer for the Dealer account from users.txt (if no dealer exists)
        if (DEALER_CODE && code === DEALER_CODE && !dealerSocket) {
          dealerSocket = socket.id;
          io.emit('dealerState', true);
          io.to(socket.id).emit('dealerGranted');
          // ensure new dealer immediately sees bets state and last result
          io.to(socket.id).emit('betsState', betsOpen);
          if (lastSpinResult) io.to(socket.id).emit('spinResult', lastSpinResult);
        }
      } else {
        // invalid code: assign a temporary guest-like name but client should not allow this path
        socket.data.name = 'Unknown';
      }
    } else {
      socket.data.name = identifier;
    }

    // track connected sockets for ordered leaderboard
    connectedSockets[socket.id] = { name: socket.data.name, code: socket.data.code || null };
    // if this connection used a known code, mark that user as connected
    if (socket.data.code) {
      usersStatus[socket.data.code] = usersStatus[socket.data.code] || {};
      usersStatus[socket.data.code].connected = true;
      usersStatus[socket.data.code].socketId = socket.id;
    }

    // Let the client know whether a dealer is connected
    socket.emit("dealerState", dealerSocket !== null);
    // Inform the joining client of the current bets state
    socket.emit("betsState", betsOpen);
    // Send the last spin result so new clients immediately see the last outcome
    if (lastSpinResult) socket.emit("spinResult", lastSpinResult);
    emitLeaderboard();
  });

  // Dealer may set per-player weight to bias spins
  socket.on('setWeight', ({ target, weight }) => {
    if (socket.id !== dealerSocket) return; // only dealer
    const w = Number(weight);
    if (Number.isNaN(w)) return;
    // only accept weights >= 0 and reasonably bounded
    const val = Math.max(0, Math.min(10, w));
    // target should be a socket id (connected player)
    if (typeof target === 'string' && connectedSockets[target]) {
      weightBySocket[target] = val;
      emitLeaderboard();
    }
  });

  socket.on("dealerLogin", code => {
    if (DEALER_CODE && code === DEALER_CODE && !dealerSocket) {
      dealerSocket = socket.id;
      io.emit("dealerState", true);
      io.to(socket.id).emit("dealerGranted");
      // Ensure the newly-granted dealer sees current bets state and last result
      io.to(socket.id).emit("betsState", betsOpen);
      if (lastSpinResult) io.to(socket.id).emit("spinResult", lastSpinResult);
    }
  });

  socket.on("disconnect", () => {
    if (socket.id === dealerSocket) {
      dealerSocket = null;
      betsOpen = false;
      io.emit("dealerState", false);
    }
    // clear selection for this socket
    delete selections[socket.id];
    // if this socket belonged to a known user code, mark that code as disconnected but keep in usersStatus
    if (socket.data && socket.data.code) {
      const code = socket.data.code;
      if (usersStatus[code]) {
        usersStatus[code].connected = false;
        usersStatus[code].socketId = null;
      }
    }
    // remove socket from active map (guests will no longer appear)
    delete connectedSockets[socket.id];
    emitLeaderboard();
  });

  socket.on("select", bet => {
    // Prevent betting when bets are closed or if the dealer attempts to bet
    if (!betsOpen) return;
    if (socket.id === dealerSocket) return;
    selections[socket.id] = { name: socket.data.name, bet };
    emitLeaderboard();
  });

  function emitLeaderboard() {
    // Build ordered leaderboard: users present in users.txt order first (persistent rows),
    // then any currently connected guests.
    const ordered = {};

    for (const code of usersOrder) {
      const status = usersStatus[code] || { connected: false, socketId: null };
      if (status.connected && status.socketId && connectedSockets[status.socketId]) {
        const sid = status.socketId;
        ordered[sid] = { name: usersByCode[code], bet: (selections[sid] && selections[sid].bet !== undefined) ? selections[sid].bet : null, connected: true, weight: (weightBySocket[sid] !== undefined ? weightBySocket[sid] : 1) };
      } else {
        // user known but currently disconnected
        // use pseudo-key for stability: prefix with 'u:' + code so client can still render
        const key = 'u:' + code;
        ordered[key] = { name: usersByCode[code], bet: null, connected: false, weight: null };
      }
    }

    // Append any remaining connected sockets (guests or unknown codes) sorted by name
    const remaining = Object.entries(connectedSockets).filter(([sid, info]) => {
      // skip if this socket belonged to a users.txt code already included above
      return !(info.code && usersStatus[info.code]);
    });
    remaining.sort((a, b) => {
      const an = (a[1].name || '').toLowerCase();
      const bn = (b[1].name || '').toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    for (const [sid, info] of remaining) {
      ordered[sid] = { name: info.name, bet: (selections[sid] && selections[sid].bet !== undefined) ? selections[sid].bet : null, connected: true, weight: (weightBySocket[sid] !== undefined ? weightBySocket[sid] : 1) };
    }

    io.emit('leaderboard', ordered);
  }

  socket.on("openBets", () => {
    // Only the currently authenticated dealer can open bets
    if (socket.id !== dealerSocket) return;
    betsOpen = true;
    io.emit("betsState", true);
  });

  socket.on("closeBets", () => {
    // Only the currently authenticated dealer can close bets
    if (socket.id !== dealerSocket) return;
    betsOpen = false;
    io.emit("betsState", false);
  });

  socket.on("spin", clientRandoms => {
    // Only dealer may spin and prevent overlapping spins
    if (socket.id !== dealerSocket) return;
    if (spinning) return;
    spinning = true;

    // If there are numeric bets, bias the outcome using weights; otherwise fall back
    // to the original clientRandoms-based selection.
    const avg =
      clientRandoms.reduce((a, b) => a + b, 0) / clientRandoms.length;

    // Build per-number bettors list and per-color bettors
    const bettorsByNumber = Array.from({ length: 37 }, () => []);
    const bettorsByColor = { red: [], black: [] };
    let anyNumeric = false;
    let anyColor = false;
    for (const sid in selections) {
      let bet = selections[sid].bet;
      if (typeof bet === 'string') {
        const num = Number(bet);
        if (!Number.isNaN(num)) bet = num;
        else bet = bet.trim().toLowerCase();
      }
      if (typeof bet === 'number' && bet >= 0 && bet <= 36) {
        anyNumeric = true;
        bettorsByNumber[bet].push(sid);
      } else if (bet === 'red' || bet === 'black') {
        anyColor = true;
        bettorsByColor[bet].push(sid);
      }
    }
    // Compute per-color bettor counts and positive-weight sums (consider numeric and color bettors)
    const colorInfo = { red: { count: 0, sumPos: 0 }, black: { count: 0, sumPos: 0 } };
    for (let n = 0; n <= 36; n++) {
      const sids = bettorsByNumber[n];
      if (!sids || sids.length === 0) continue;
      const color = isRed(n) ? 'red' : (isBlack(n) ? 'black' : null);
      if (!color) continue;
      for (const sid of sids) {
        colorInfo[color].count += 1;
        const w = weightBySocket[sid] !== undefined ? Number(weightBySocket[sid]) : 1;
        if (w > 0) colorInfo[color].sumPos += w;
      }
    }
    // include explicit color bettors
    for (const sid of bettorsByColor.red) {
      colorInfo.red.count += 1;
      const w = weightBySocket[sid] !== undefined ? Number(weightBySocket[sid]) : 1;
      if (w > 0) colorInfo.red.sumPos += w;
    }
    for (const sid of bettorsByColor.black) {
      colorInfo.black.count += 1;
      const w = weightBySocket[sid] !== undefined ? Number(weightBySocket[sid]) : 1;
      if (w > 0) colorInfo.black.sumPos += w;
    }

    let winningNumber;
    if (anyNumeric || anyColor) {
      // Priority rule: if any bettor has weight >= 2, pick among numbers bet by those high-weight bettors only
      const highWeightNumbers = {};
      // numeric high-weight bettors
      for (let n = 0; n <= 36; n++) {
        let count = 0;
        for (const sid of bettorsByNumber[n]) {
          const w = weightBySocket[sid] !== undefined ? Number(weightBySocket[sid]) : 1;
          if (w >= 2) count += 1;
        }
        if (count > 0) highWeightNumbers[n] = (highWeightNumbers[n] || 0) + count;
      }
      // color high-weight bettors: add their counts to each number of that color
      const highRed = bettorsByColor.red.reduce((s, sid) => s + ((weightBySocket[sid] !== undefined ? Number(weightBySocket[sid]) : 1) >= 2 ? 1 : 0), 0);
      const highBlack = bettorsByColor.black.reduce((s, sid) => s + ((weightBySocket[sid] !== undefined ? Number(weightBySocket[sid]) : 1) >= 2 ? 1 : 0), 0);
      if (highRed > 0) {
        for (let n = 0; n <= 36; n++) if (isRed(n)) highWeightNumbers[n] = (highWeightNumbers[n] || 0) + highRed;
      }
      if (highBlack > 0) {
        for (let n = 0; n <= 36; n++) if (isBlack(n)) highWeightNumbers[n] = (highWeightNumbers[n] || 0) + highBlack;
      }

      if (Object.keys(highWeightNumbers).length > 0) {
        // choose among highWeightNumbers proportionally to count
        const totalHigh = Object.values(highWeightNumbers).reduce((s, x) => s + x, 0);
        const r = Math.random();
        let acc = 0;
        for (const [nStr, cnt] of Object.entries(highWeightNumbers)) {
          acc += cnt / totalHigh;
          if (r <= acc) { winningNumber = Number(nStr); break; }
        }
        if (winningNumber === undefined) winningNumber = Number(Object.keys(highWeightNumbers)[0]);
      } else {
        // Normal weighted selection:
        // For each number, compute sum of positive weights from numeric bettors and color bettors (ignore weight 0 bettors);
        // if a number has only zero-weight bettors, treat that number as ineligible. Unbet numbers get a base weight of 1.
        const baseUnbet = 1;
        const weights = new Array(37).fill(0);
        let total = 0;
        for (let n = 0; n <= 36; n++) {
          // collect bettors affecting this number: numeric bettors on this number + bettors who bet the number's color
          const numericSids = bettorsByNumber[n] || [];
          const color = isRed(n) ? 'red' : (isBlack(n) ? 'black' : null);
          const colorSids = color === 'red' ? bettorsByColor.red : (color === 'black' ? bettorsByColor.black : []);

          // Determine if there are any bettors at all for this number (numeric or color)
          const hasAnyBettor = (numericSids.length > 0) || (colorSids && colorSids.length > 0);

          // Sum only positive weights from these bettors
          let sumPos = 0;
          for (const sid of numericSids) {
            const w = weightBySocket[sid] !== undefined ? Number(weightBySocket[sid]) : 1;
            if (w > 0) sumPos += w;
          }
          if (colorSids && colorSids.length > 0) {
            for (const sid of colorSids) {
              const w = weightBySocket[sid] !== undefined ? Number(weightBySocket[sid]) : 1;
              if (w > 0) sumPos += w;
            }
          }

          if (!hasAnyBettor) {
            // No bettors affecting this number -> base unbet weight
            weights[n] = baseUnbet;
          } else {
            // There are bettors. If none of them have positive weight, exclude this number entirely (weight 0).
            if (sumPos <= 0) {
              weights[n] = 0;
            } else {
              weights[n] = baseUnbet + sumPos;
            }
          }

          total += weights[n];
        }

        if (total <= 0) {
          // fallback to avg method
          winningNumber = Math.floor(avg * 37);
        } else {
          const r = Math.random();
          let acc = 0;
          for (let i = 0; i < weights.length; i++) {
            acc += weights[i] / total;
            if (r <= acc) { winningNumber = i; break; }
          }
          if (winningNumber === undefined) winningNumber = Math.floor(r * 37);
        }
      }
    } else {
      winningNumber = Math.floor(avg * 37);
    }

    const results = {};
    for (const id in selections) {
      // Normalize bets: numeric strings -> numbers, color names -> lowercased trimmed strings
      let bet = selections[id].bet;
      if (typeof bet === "string") {
        const num = Number(bet);
        if (!Number.isNaN(num)) bet = num;
        else bet = bet.trim().toLowerCase();
      }

      if (bet === winningNumber) {
        results[id] = "WIN";
      } else if (bet === "red" || bet === "black") {
        // Player bet a color directly: if it matches, mark as COLOR_ONLY
        if ((bet === "red" && isRed(winningNumber)) || (bet === "black" && isBlack(winningNumber))) {
          results[id] = "COLOR_ONLY";
        } else {
          results[id] = "LOSE";
        }
      } else if (typeof bet === 'number') {
        // If the bet was a number (player bet a number), give a partial COLOR if colors match
        if ((isRed(bet) && isRed(winningNumber)) || (isBlack(bet) && isBlack(winningNumber))) {
          results[id] = "COLOR";
        } else {
          results[id] = "LOSE";
        }
      } else {
        results[id] = "LOSE";
      }
    }

    // Close bets on server and store last result so new joiners see it
    betsOpen = false;
    lastSpinResult = { winningNumber, results };

    // Emit live spin with an "animate" flag so clients animate the wheel
    io.emit("spinResult", Object.assign({}, lastSpinResult, { animate: true }));
    io.emit("betsState", false);

    // Prevent the dealer from triggering another spin for the animation duration
    setTimeout(() => {
      spinning = false;
    }, SPIN_ANIMATION_MS);
  });
});

function isRed(n) {
  return [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36].includes(n);
}
function isBlack(n) {
  return n !== 0 && !isRed(n);
}

server.listen(3000, () =>
  console.log("Roulette running on http://localhost:3000")
);