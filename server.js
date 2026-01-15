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
try {
  const lines = fs.readFileSync(usersFile, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const ln of lines) {
    const parts = ln.split(',');
    if (parts.length >= 2) {
      const code = parts[0].trim();
      const name = parts.slice(1).join(',').trim();
      if (/^\d{6}$/.test(code) && name) usersByCode[code] = name;
    }
  }
  console.log('Loaded users:', Object.keys(usersByCode).length);
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
        // Auto-grant dealer for special code (if no dealer exists)
        if (code === '983452' && !dealerSocket) {
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

    // Let the client know whether a dealer is connected
    socket.emit("dealerState", dealerSocket !== null);
    // Inform the joining client of the current bets state
    socket.emit("betsState", betsOpen);
    // Send the last spin result so new clients immediately see the last outcome
    if (lastSpinResult) socket.emit("spinResult", lastSpinResult);
    io.emit("leaderboard", selections);
  });

  socket.on("dealerLogin", code => {
    if (code === "1234" && !dealerSocket) {
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
    delete selections[socket.id];
    io.emit("leaderboard", selections);
  });

  socket.on("select", bet => {
    // Prevent betting when bets are closed or if the dealer attempts to bet
    if (!betsOpen) return;
    if (socket.id === dealerSocket) return;
    selections[socket.id] = { name: socket.data.name, bet };
    io.emit("leaderboard", selections);
  });

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

    const avg =
      clientRandoms.reduce((a, b) => a + b, 0) / clientRandoms.length;

    const winningNumber = Math.floor(avg * 37);

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
      } else if (
        (bet === "red" && isRed(winningNumber)) ||
        (bet === "black" && isBlack(winningNumber))
      ) {
        results[id] = "COLOR"; // partial win for matching color
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