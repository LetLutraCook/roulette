const socket = io();

// Login flow: check cookie `roulette_user` and auto-login; otherwise prompt for 6-digit code
function getCookie(name) {
  const v = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
  return v ? decodeURIComponent(v.pop()) : null;
}

async function verifyCode(code) {
  try {
    const r = await fetch('/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.name;
  } catch (e) {
    return null;
  }
}

async function doLogin() {
  // Must have a 6-digit code; no guest option
  let code = getCookie('roulette_user');
  if (code) {
    // verify stored code and then join using code
    const verifiedName = await verifyCode(code);
    if (verifiedName) {
      socket.emit('join', code); // send code so server can map name and auto-dealer if applicable
      return;
    }
    // invalid stored cookie - drop it
    document.cookie = 'roulette_user=; max-age=0; path=/';
  }

  // Prompt until valid code entered
  while (true) {
    const codeInput = prompt('Enter your 6-digit code to log in (required)');
    if (!codeInput) { alert('Code is required'); continue; }
    const trimmed = String(codeInput).trim();
    if (!/^\d{6}$/.test(trimmed)) { alert('Code must be 6 digits'); continue; }
    const verifiedName = await verifyCode(trimmed);
    if (!verifiedName) { alert('Invalid code'); continue; }

    // Persist code in cookie for future auto-login (1 year)
    document.cookie = 'roulette_user=' + encodeURIComponent(trimmed) + '; max-age=' + (60*60*24*365) + '; path=/';
    socket.emit('join', trimmed);
    return;
  }
}

const table = document.getElementById("table");
const playersDiv = document.getElementById("players");
const lastResultDiv = document.getElementById("lastResult");
const dealerLogin = document.getElementById("dealerLogin");
const dealerWrapper = document.getElementById("dealerWrapper");
const spinBtn = document.getElementById("spinBtn");
const openBtn = document.getElementById("openBtn");
const closeBtn = document.getElementById("closeBtn");
const betStatus = document.getElementById("betStatus");
const betBoard = document.getElementById("betBoard");
const betBoardParent = betBoard ? betBoard.parentNode : null;
const betBoardNext = betBoard ? betBoard.nextSibling : null;

let isAnimating = false; // tracks wheel animation in progress

let isDealer = false;
let betsOpen = false;
let dealerCollapsed = false;
let players = {};
let myBet = null;

const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

/* -------- ROULETTE WHEEL (canvas) -------- */
const options = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
let startAngle = 0;
const arc = Math.PI / (options.length / 2);
let resize = 1;
let ctx = null;
let canvas = document.getElementById("canvas");

function getColor(n) {
  if (n === 0) return "#008b0f"; // green
  return RED.has(n) ? "#FF0000" : "#000000"; // use RED set so wheel matches table colors
}

function drawRouletteWheel() {
  if (!canvas) return;
  if (!ctx) ctx = canvas.getContext("2d");

  const size = canvas.width;
  const offsetX = size / 2;
  const offsetY = size / 2;
  const outsideRadius = (size * 0.8) / 2;
  const textRadius = (size * 0.64) / 2;
  const insideRadius = (size * 0.5) / 2;

  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = "black";
  ctx.lineWidth = 2;
  ctx.font = 'normal ' + Math.round(0.032 * size) + 'px Helvetica, Arial';

  // subtle shadow for depth
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = Math.round(0.02 * size);

  for (let i = 0; i < options.length; i++) {
    const angle = startAngle + i * arc;
    const val = options[i];
    ctx.fillStyle = getColor(val);

    ctx.beginPath();
    ctx.arc(offsetX, offsetY, outsideRadius, angle, angle + arc, false);
    ctx.arc(offsetX, offsetY, insideRadius, angle + arc, angle, true);
    ctx.stroke();
    ctx.fill();

    // thin separators between slices for realism
    ctx.beginPath();
    const sepX1 = offsetX + Math.cos(angle) * insideRadius;
    const sepY1 = offsetY + Math.sin(angle) * insideRadius;
    const sepX2 = offsetX + Math.cos(angle) * outsideRadius;
    const sepY2 = offsetY + Math.sin(angle) * outsideRadius;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.moveTo(sepX1, sepY1);
    ctx.lineTo(sepX2, sepY2);
    ctx.stroke();

    ctx.save();
    ctx.fillStyle = "white";
    ctx.translate(offsetX + Math.cos(angle + arc / 2) * textRadius,
                  offsetY + Math.sin(angle + arc / 2) * textRadius);
    ctx.rotate(angle + arc / 2 + Math.PI / 2);
    const text = String(val);
    ctx.fillText(text, -ctx.measureText(text).width / 2, 0);
    ctx.restore();
  }

  ctx.restore();

  // Draw an outer metallic rim and little studs to give it a realistic look
  const rimOuter = outsideRadius + Math.round(0.04 * size);
  const rimInner = outsideRadius - Math.round(0.035 * size);
  const rimGrad = ctx.createRadialGradient(offsetX, offsetY, rimInner, offsetX, offsetY, rimOuter);
  rimGrad.addColorStop(0, '#b7b7b7');
  rimGrad.addColorStop(0.6, '#777');
  rimGrad.addColorStop(1, '#333');
  ctx.beginPath();
  ctx.fillStyle = rimGrad;
  ctx.arc(offsetX, offsetY, rimOuter, 0, Math.PI * 2);
  ctx.arc(offsetX, offsetY, rimInner, 0, Math.PI * 2, true);
  ctx.fill();

  // studs (small dots) around the rim
  const studs = 36;
  for (let s = 0; s < studs; s++) {
    const a = startAngle + (s / studs) * Math.PI * 2;
    const sx = offsetX + Math.cos(a) * ((rimInner + rimOuter) / 2);
    const sy = offsetY + Math.sin(a) * ((rimInner + rimOuter) / 2);
    ctx.beginPath();
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.arc(sx, sy, Math.max(1, Math.round(0.006 * size)), 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw subtle center rim with gradient for more 'aero' look
  const grad = ctx.createRadialGradient(offsetX, offsetY, insideRadius * 0.1, offsetX, offsetY, insideRadius * 0.5);
  grad.addColorStop(0, '#666');
  grad.addColorStop(1, '#111');
  ctx.beginPath();
  ctx.fillStyle = grad;
  ctx.arc(offsetX, offsetY, insideRadius * 0.45, 0, Math.PI * 2);
  ctx.fill();

  // Add a small glossy highlight
  ctx.beginPath();
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.ellipse(offsetX + insideRadius * 0.18, offsetY - insideRadius * 0.18, insideRadius * 0.28, insideRadius * 0.14, Math.PI / 6, 0, Math.PI * 2);
  ctx.fill();

  // Arrow
  ctx.fillStyle = "#ccc";
  ctx.beginPath();
  ctx.moveTo(offsetX - 0.008 * size, offsetY - (outsideRadius + 0.02 * size));
  ctx.lineTo(offsetX + 0.008 * size, offsetY - (outsideRadius + 0.02 * size));
  ctx.lineTo(offsetX + 0.008 * size, offsetY - (outsideRadius - 0.02 * size));
  ctx.lineTo(offsetX + 0.02 * size, offsetY - (outsideRadius - 0.02 * size));
  ctx.lineTo(offsetX + 0 * size, offsetY - (outsideRadius - 0.052 * size));
  ctx.lineTo(offsetX - 0.02 * size, offsetY - (outsideRadius - 0.02 * size));
  ctx.lineTo(offsetX - 0.008 * size, offsetY - (outsideRadius - 0.02 * size));
  ctx.lineTo(offsetX - 0.008 * size, offsetY - (outsideRadius + 0.02 * size));
  ctx.fill();
}

function easeOut(t) {
  // t between 0..1
  const ts = t * t;
  const tc = ts * t;
  return (tc + -3 * ts + 3 * t);
}

function normalizeAngle(a) {
  const twoPi = Math.PI * 2;
  a = a % twoPi;
  if (a < 0) a += twoPi;
  return a;
}

function animateToNumber(targetNumber, duration = 3800) {
  // New behavior: rotate to slightly past the target (overshoot by 0.25 slice),
  // then smoothly snap back to the exact target number. This gives a crisp
  // authoritative feel without multi-phase wobble.
  return new Promise(resolve => {
    const index = options.indexOf(targetNumber);
    if (index === -1) {
      resolve();
      return;
    }

    const targetAngle = -Math.PI / 2 - (index * arc) - (arc / 2);
    const rotations = 3 + Math.floor(Math.random() * 3); // 3..5

    const start = startAngle;
    const normalizedStart = normalizeAngle(start);
    const normalizedTarget = normalizeAngle(targetAngle);
    let deltaToTarget = (normalizedTarget - normalizedStart);
    if (deltaToTarget < 0) deltaToTarget += Math.PI * 2;

    // Final base angle: start + full rotations + delta to align with target on same revolution
    const baseFinal = start + rotations * 2 * Math.PI + deltaToTarget;

    // Overshoot forward by quarter slot
    const overshoot = arc * 0.25;
    const finalOvershoot = baseFinal + overshoot;

    const delta = finalOvershoot - start;
    const startTime = performance.now();

    function frame(now) {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / duration);
      const eased = easeOut(t);

      startAngle = start + delta * eased;
      drawRouletteWheel();

      if (t < 1) requestAnimationFrame(frame);
      else {
        // short smooth snap-back to the base final angle (same revolution)
        const settleDuration = 260;
        const settleStart = performance.now();
        const settleFrom = startAngle;
        const settleTo = baseFinal; // same revolution without normalization

        function settle(now2) {
          const se = Math.min(1, (now2 - settleStart) / settleDuration);
          const eased2 = easeOut(se);
          startAngle = settleFrom + (settleTo - settleFrom) * eased2;
          drawRouletteWheel();
          if (se < 1) requestAnimationFrame(settle);
          else {
            startAngle = settleTo;
            drawRouletteWheel();
            showResultOnWheel(targetNumber);
            resolve();
          }
        }

        requestAnimationFrame(settle);
      }
    }

    requestAnimationFrame(frame);
  });
}

function showResultOnWheel(number) {
  if (!ctx || !canvas) return;
  const size = canvas.width;
  ctx.save();
  ctx.font = 'bold ' + Math.round(0.08 * size) + 'px Helvetica, Arial';
  const text = String(number);
  const radius = Math.round(0.065 * size);
  // circle background with subtle shadow and border
  ctx.beginPath();
  ctx.fillStyle = getColor(number);
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = Math.round(0.02 * size);
  ctx.arc(size / 2, size / 2, radius, 0, Math.PI * 2);
  ctx.fill();
  // white border ring
  ctx.lineWidth = Math.max(2, Math.round(0.008 * size));
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.stroke();
  ctx.closePath();
  // white number
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'white';
  ctx.fillText(text, (size / 2) - ctx.measureText(text).width / 2, (size / 2) + Math.round(0.03 * size));
  ctx.restore();
}

// Resize/calc initial draw
function resizeCanvas() {
  if (!canvas) canvas = document.getElementById("canvas");
  if (!canvas) return;
  const w = window, d = document, e = d.documentElement, g = d.getElementsByTagName('body')[0];
  const x = w.innerWidth || e.clientWidth || g.clientWidth;
  const y = w.innerHeight || e.clientHeight || g.clientHeight;
  const size = Math.min(x * 0.9, 500, y * 0.45);
  canvas.width = size;
  canvas.height = size;
  drawRouletteWheel();
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

/* -------- BUILD TABLE -------- */
for (let i = 0; i <= 36; i++) {
  const cell = document.createElement("div");
  cell.className = "cell " + (i === 0 ? "green" : RED.has(i) ? "red" : "black");
  cell.setAttribute('data-number', String(i));

  const num = document.createElement('div');
  num.className = 'number';
  num.textContent = i;
  cell.appendChild(num);

  const count = document.createElement('div');
  count.className = 'chipCount';
  count.textContent = '';
  count.style.display = 'none';
  count.setAttribute('data-number', String(i));
  cell.appendChild(count);

  cell.onclick = () => {
    // Dealers cannot place bets; also respect betsOpen state
    if (!betsOpen || isDealer) return;
    myBet = i;
    document.querySelectorAll(".cell").forEach(c => c.classList.remove("selected"));
    cell.classList.add("selected");
    socket.emit("select", i);
  };

  table.appendChild(cell);
}

// Show live counts of bets per number and tooltips with bettor names
function updateTableBets() {
  // Clear counts
  document.querySelectorAll('.chipCount').forEach(c => { c.textContent = ''; c.style.display = 'none'; c.title = ''; });

  // Aggregate by bet value
  const aggregates = {};
  Object.values(players).forEach(p => {
    const bet = p.bet;
    if (bet === undefined || bet === null) return;
    const key = String(bet);
    if (!aggregates[key]) aggregates[key] = [];
    aggregates[key].push(p.name);
  });

  for (const key in aggregates) {
    const el = document.querySelector('.chipCount[data-number="' + key + '"]');
    if (!el) continue;
    const names = aggregates[key];
    el.textContent = String(names.length);
    el.title = names.join(', ');
    el.style.display = '';
  }
}

/* -------- DEALER FUNCTIONS -------- */
function login() {
  socket.emit("dealerLogin", document.getElementById("code").value);
}

function openBets() {
  if (!isDealer) return; // Prevent non-dealers from triggering dealer actions
  socket.emit("openBets");
}

function closeBets() {
  if (!isDealer) return;
  socket.emit("closeBets");
}

function spin() {
  if (!isDealer || isAnimating) return;
  // mark animating locally as a fallback in case server doesn't respond
  isAnimating = true;
  socket.emit("spin", [Math.random()]);
  // fallback to clear animating after animation+buffer to avoid stuck state
  setTimeout(() => { isAnimating = false; updateSpinButton(); }, 5000);
}

function toggleDealer() {
  dealerCollapsed = !dealerCollapsed;
  dealerWrapper.classList.toggle("collapsed", dealerCollapsed);
  document.getElementById("dealerTab").textContent = dealerCollapsed ? "◀" : "▶";
}

/* -------- SOCKET EVENTS -------- */
socket.on("dealerGranted", () => {
  isDealer = true;
  // show the inline controls (non-floating)
  dealerWrapper.style.display = "flex";
  // Hide the betting grid table for dealer but keep the Table Status visible
  const tableEl = document.getElementById("table");
  if (tableEl) tableEl.style.display = "none";
  if (betBoard) betBoard.style.display = "block";
  // Ensure dealer sees proper button state immediately
  if (openBtn) openBtn.disabled = betsOpen;
  if (closeBtn) closeBtn.disabled = !betsOpen;
  updateSpinButton();
});

socket.on("dealerState", active => {
  // Hide login when a dealer already exists; show only when none
  dealerLogin.style.display = active ? "none" : "block";

  // Ensure dealer controls are visible only for the actual dealer
  const tableEl = document.getElementById("table");
  if (!active) {
    isDealer = false;
    dealerWrapper.style.display = "none";
    // Restore the betting grid and Table Status
    if (tableEl) tableEl.style.display = "grid";
    if (betBoard) betBoard.style.display = "block";
  } else {
    dealerWrapper.style.display = isDealer ? "flex" : "none";
    // If this client is the dealer, hide betting grid but keep Table Status visible
    if (isDealer) {
      if (tableEl) tableEl.style.display = "none";
      if (betBoard) betBoard.style.display = "block";
    } else {
      // Non-dealers see both
      if (tableEl) tableEl.style.display = "grid";
      if (betBoard) betBoard.style.display = "block";
    }
  }
});

socket.on("betsState", open => {
  betsOpen = open;
  betStatus.textContent = open ? "BETS OPEN" : "BETS CLOSED";
  betStatus.className = open ? "open" : "closed";
  table.classList.toggle("disabled", !open);
  if (!open) {
    myBet = null;
    document.querySelectorAll(".cell").forEach(c => c.classList.remove("selected"));
  }

  // Update dealer controls so they reflect the current bets state on login
  if (isDealer) {
    if (openBtn) openBtn.disabled = open;
    if (closeBtn) closeBtn.disabled = !open;
    updateSpinButton();
  } else {
    // Defensive: if controls are visible to non-dealers, ensure they're disabled/greyed
    if (openBtn) openBtn.disabled = true;
    if (closeBtn) closeBtn.disabled = true;
    if (spinBtn) spinBtn.disabled = true;
  }
});

socket.on("leaderboard", data => {
  players = data;
  renderBoard();
  updateSpinButton();
  // Update cell badges showing who bet where
  updateTableBets();
});

socket.on("spinResult", res => {
  // If this is a historic result (sent on join), don't animate — just show it
  if (!res.animate) {
    const n = res.winningNumber;
    const color = n === 0 ? "GREEN" : RED.has(n) ? "RED" : "BLACK";
    lastResultDiv.textContent = `Last Result: ${n} (${color})`;
    // Draw winner on wheel for history
    showResultOnWheel(n);

    // Apply player results mapping if present
    if (res.results) {
      Object.keys(players).forEach(id => {
        players[id].result = res.results[id] || null;
      });
      renderBoard();
    }
    return;
  }

  // Live spin — animate wheel to the winning number, then apply results
  const n = res.winningNumber;

  // Disable UI interactions during animation
  table.classList.add("disabled");
  isAnimating = true;
  if (isDealer) {
    if (openBtn) openBtn.disabled = true;
    if (closeBtn) closeBtn.disabled = true;
    if (spinBtn) spinBtn.disabled = true;
  }

  animateToNumber(n, 4200).then(() => {
    const color = n === 0 ? "GREEN" : RED.has(n) ? "RED" : "BLACK";
    lastResultDiv.textContent = `Last Result: ${n} (${color})`;

    // Apply results provided by server (WIN/COLOR/LOSE)
    if (res.results) {
      Object.keys(players).forEach(id => {
        players[id].result = res.results[id] || null;
      });
      renderBoard();
    }

    // reset local bet
    myBet = null;
    document.querySelectorAll(".cell").forEach(c => c.classList.remove("selected"));

    // Bets are closed after spin — server will emit betsState=false, but enforce UI here too
    betsOpen = false;
    betStatus.textContent = "BETS CLOSED";
    betStatus.className = "closed";

    // Keep dealer controls in proper state
    if (isDealer) updateSpinButton();
    isAnimating = false;
  });
});

/* -------- UI RENDERING -------- */
function renderBoard() {
  playersDiv.innerHTML = "";

  Object.values(players).forEach(p => {
    const row = document.createElement("div");
    row.className = "playerRow";

    const left = document.createElement("div");
    left.textContent = p.name;

    const right = document.createElement("div");

    const bet = document.createElement("span");
    bet.className = "betValue";
    bet.textContent = p.bet ?? "—";
    right.appendChild(bet);

    if (p.result) {
      const badge = document.createElement("span");
      if (p.result === "WIN") badge.className = "badge win";
      else if (p.result === "COLOR") badge.className = "badge partial-win";
      else badge.className = "badge lose";

      badge.textContent = p.result === "COLOR" ? "WIN (Color)" : p.result;
      right.appendChild(badge);
    }

    row.append(left, right);
    playersDiv.appendChild(row);
  });
}

function updateSpinButton() {
  if (!isDealer) return;
  const ready = Object.values(players).every(p => p.bet !== undefined);
  spinBtn.disabled = isAnimating || !ready;
  // Keep the Open/Close buttons in sync with the server bets state
  if (openBtn) openBtn.disabled = betsOpen || isAnimating;
  if (closeBtn) closeBtn.disabled = !betsOpen || isAnimating;
}

// Start login after socket event handlers are registered
doLogin();