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
const betRedBtn = document.getElementById('betRed');
const betBlackBtn = document.getElementById('betBlack');
const clearBetBtn = document.getElementById('clearBet');
const colorBetsContainer = document.getElementById('colorBets');

function updateColorButtonsVisibility() {
  if (!colorBetsContainer) return;
  colorBetsContainer.style.display = isDealer ? 'none' : 'flex';
}
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

// Audio & tick detection for wheel 'clicks'
let audioCtx = null; // initialized on first user interaction
let lastTickIndex = null; // last slice index that produced a tick
let lastAngular = null; // last normalized angle at arrow
let lastFrameTime = null;

function ensureAudioCtx() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) {
    audioCtx = null;
  }
}

function playTick(speed) {
  // Roulette-like: light but deep thock + click
  ensureAudioCtx();
  if (!audioCtx) return;
  const ac = audioCtx;
  const now = ac.currentTime;
  const sp = Math.max(0, Math.min(1, speed || 0));

  // master mixer (keep volume safe)
  const master = ac.createGain();
  master.gain.value = 0.95;
  master.connect(ac.destination);

  // LIGHT CLICK (short bright transient) - boosted for immediate, sharp click
  try {
    const clickDur = 0.008; // 8ms (sharper)
    const buf = ac.createBuffer(1, Math.max(1, Math.floor(ac.sampleRate * clickDur)), ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 0.8);
      if (i < Math.max(1, Math.floor(data.length * 0.18))) data[i] *= 2.8; // emphasize the attack portion
    }

    const src = ac.createBufferSource();
    src.buffer = buf;

    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3000 + sp * 1600; // brighter center to bite
    bp.Q.value = 4 + sp * 3;

    const g = ac.createGain();
    const peak = 0.09 + sp * 0.06; // stronger click peak
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(peak, now + 0.0008); // near-instant peak
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);

    src.connect(bp);
    bp.connect(g);
    g.connect(master);

    src.start(now);
    src.stop(now + clickDur + 0.006);

    // Add a short HF oscillator transient for extra 'bite' without being piercing
    try {
      const osc = ac.createOscillator();
      const og = ac.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 5200 + sp * 2400; // 5200..7600Hz
      og.gain.setValueAtTime(0.0001, now);
      og.gain.linearRampToValueAtTime(peak * 0.28, now + 0.0007);
      og.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
      osc.connect(og);
      og.connect(master);
      osc.start(now);
      osc.stop(now + 0.035);
    } catch (e) {
      // ignore osc errors
    }
  } catch (e) {
    // ignore
  }

  // DEEP THOCK (low-frequency body) - reduced and slightly delayed so it doesn't mask the click
  try {
    const thFreq = 85 + sp * 40; // 85..125 Hz (slightly higher so it's less boomy)
    const th = ac.createOscillator();
    th.type = 'sine';
    th.frequency.value = thFreq;
    const tg = ac.createGain();
    // start very low then peak a bit later so click is clearly audible
    tg.gain.setValueAtTime(0.0001, now);
    const thPeak = 0.012 + sp * 0.02; // a bit gentler overall
    tg.gain.linearRampToValueAtTime(thPeak * 0.35, now + 0.03); // very small early level
    tg.gain.linearRampToValueAtTime(thPeak, now + 0.07); // reach peak after click
    tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);
    // gentle lowpass to keep warmth but avoid masking mids
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;

    th.connect(tg);
    tg.connect(lp);
    lp.connect(master);

    th.start(now);
    th.stop(now + 0.26);
  } catch (e) {
    // ignore
  }

  // SMALL METALLIC ECHO (tiny) to add realism but kept low and slightly earlier
  try {
    const echoDelay = 0.010 + sp * 0.01; // 10..20ms
    const delayNode = ac.createDelay(0.05);
    delayNode.delayTime.value = echoDelay;
    const echoGain = ac.createGain();
    echoGain.gain.value = 0.016 + sp * 0.02; // slightly lower than before

    // use a highband filtered noise for the echo
    const echoDur = 0.018;
    const eb = ac.createBuffer(1, Math.max(1, Math.floor(ac.sampleRate * echoDur)), ac.sampleRate);
    const ed = eb.getChannelData(0);
    for (let i = 0; i < ed.length; i++) ed[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ed.length, 2);
    const eSrc = ac.createBufferSource();
    eSrc.buffer = eb;
    const eBp = ac.createBiquadFilter();
    eBp.type = 'bandpass';
    eBp.frequency.value = 2800 + sp * 1800;
    eBp.Q.value = 3;

    eSrc.connect(eBp);
    eBp.connect(echoGain);
    echoGain.connect(delayNode);
    delayNode.connect(master);

    eSrc.start(now);
    eSrc.stop(now + echoDur);
  } catch (e) {
    // ignore
  }
}

// Small number-select sound (pleasant bell + subtle click)
function playSelectSound(intensity = 0.6) {
  ensureAudioCtx();
  if (!audioCtx) return;
  const ac = audioCtx;
  const now = ac.currentTime;
  const it = Math.max(0, Math.min(1, intensity || 0.6));

  // Bell body (two detuned sines) for a musical selection tone
  try {
    const o1 = ac.createOscillator();
    const o2 = ac.createOscillator();
    const g = ac.createGain();
    const bp = ac.createBiquadFilter();

    o1.type = 'sine';
    o2.type = 'sine';
    const baseFreq = 720 + it * 260; // ~720..980Hz
    o1.frequency.value = baseFreq;
    o2.frequency.value = baseFreq * 1.498; // just under a fifth for pleasantness
    o2.detune.value = (Math.random() * 6 - 3);

    // gentle bandpass to keep the bell focused
    bp.type = 'bandpass';
    bp.frequency.value = 900 + it * 600;
    bp.Q.value = 1.6;

    const peak = 0.04 * it + 0.02;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(peak, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);

    o1.connect(g);
    o2.connect(g);
    g.connect(bp);
    bp.connect(ac.destination);

    o1.start(now);
    o2.start(now);
    o1.stop(now + 0.18);
    o2.stop(now + 0.18);
  } catch (e) {
    // ignore
  }

  // Short click layer to emphasize selection (very short noise)
  try {
    const dur = 0.012;
    const buf = ac.createBuffer(1, Math.max(1, Math.floor(ac.sampleRate * dur)), ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 1.2);

    const src = ac.createBufferSource();
    src.buffer = buf;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200 + it * 1000;
    const g2 = ac.createGain();
    const pk2 = 0.02 * it + 0.006;
    g2.gain.setValueAtTime(0.0001, now);
    g2.gain.linearRampToValueAtTime(pk2, now + 0.002);
    g2.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);

    src.connect(hp);
    hp.connect(g2);
    g2.connect(ac.destination);

    src.start(now);
    src.stop(now + dur + 0.005);
  } catch (e) {
    // ignore
  }
}

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

    // reset tick tracking for this animation
    lastTickIndex = null;
    lastAngular = null;
    lastFrameTime = null;

    function frame(now) {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / duration);
      const eased = easeOut(t);

      startAngle = start + delta * eased;

      // Tick detection: compute which slice is at the arrow (top: -PI/2)
      const normalizedAtArrow = normalizeAngle(startAngle + Math.PI / 2);
      const idx = Math.floor(normalizedAtArrow / arc);

      // Estimate speed (higher speed => louder/faster tick)
      let speed = 0;
      if (lastFrameTime !== null && lastAngular !== null) {
        let angDelta = normalizedAtArrow - lastAngular;
        // wrap into -PI..PI for smallest diff
        if (angDelta > Math.PI) angDelta -= Math.PI * 2;
        if (angDelta < -Math.PI) angDelta += Math.PI * 2;
        const dt = Math.max(1, now - lastFrameTime); // ms
        const angularVel = Math.abs(angDelta) / dt; // rad per ms
        // Convert to 'ticks' scale and clamp
        speed = Math.min(4, (angularVel * 1000) / (arc * 6));
      }

      // Only play tick when slice index changes (a stud or divider passes the arrow)
      if (idx !== lastTickIndex) {
        playTick(speed);
        lastTickIndex = idx;
      }

      lastAngular = normalizedAtArrow;
      lastFrameTime = now;

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

          // ticks during settle too
          const normalized2 = normalizeAngle(startAngle + Math.PI / 2);
          const idx2 = Math.floor(normalized2 / arc);
          let speed2 = 0;
          if (lastAngular !== null) {
            let angDelta2 = normalized2 - lastAngular;
            if (angDelta2 > Math.PI) angDelta2 -= Math.PI * 2;
            if (angDelta2 < -Math.PI) angDelta2 += Math.PI * 2;
            const dt2 = Math.max(1, now2 - (lastFrameTime || now2));
            const angularVel2 = Math.abs(angDelta2) / dt2;
            speed2 = Math.min(4, (angularVel2 * 1000) / (arc * 6));
          }
          if (idx2 !== lastTickIndex) {
            playTick(speed2);
            lastTickIndex = idx2;
          }
          lastAngular = normalized2;
          lastFrameTime = now2;

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
  // Play a small selection sound so the chosen number is audible
  try {
    ensureAudioCtx();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    playSelectSound(0.7);
  } catch (e) {
    // ignore
  }
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
  // Ensure audio can start (resume on user gesture if needed)
  ensureAudioCtx();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();

  // mark animating locally as a fallback in case server doesn't respond
  isAnimating = true;
  socket.emit("spin", [Math.random()]);
  // fallback to clear animating after animation+buffer to avoid stuck state
  setTimeout(() => { isAnimating = false; updateSpinButton(); }, 5000);
}

// Color bet buttons
if (betRedBtn) betRedBtn.onclick = () => {
  if (!betsOpen || isDealer) return;
  myBet = 'red';
  document.querySelectorAll(".cell").forEach(c => c.classList.remove("selected"));
  socket.emit('select', 'red');
};
if (betBlackBtn) betBlackBtn.onclick = () => {
  if (!betsOpen || isDealer) return;
  myBet = 'black';
  document.querySelectorAll(".cell").forEach(c => c.classList.remove("selected"));
  socket.emit('select', 'black');
};
if (clearBetBtn) clearBetBtn.onclick = () => {
  if (isDealer) return;
  myBet = null;
  document.querySelectorAll(".cell").forEach(c => c.classList.remove("selected"));
  // remove selection on server by sending null
  socket.emit('select', null);
};

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
  updateColorButtonsVisibility();
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
    updateColorButtonsVisibility();
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
  // color bet buttons should be disabled when bets are closed
  if (betRedBtn) betRedBtn.disabled = !open || isDealer;
  if (betBlackBtn) betBlackBtn.disabled = !open || isDealer;
  if (clearBetBtn) clearBetBtn.disabled = !open || isDealer; // disable clear when bets closed too
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

  // preserve server-sent order by iterating entries
  Object.entries(players).forEach(([key, p]) => {
    const row = document.createElement("div");
    row.className = "playerRow";

    const leftWrap = document.createElement('div');
    leftWrap.className = 'playerLeft';

    // If this client is the dealer and the player is connected, show slider to left
    if (isDealer && p.connected === true && key && !String(key).startsWith('u:')) {
      // don't show a slider for the Dealer row
      if ((p.name || '').toLowerCase() !== 'dealer') {
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = 0;
        slider.max = 2;
        slider.step = 0.5;
        slider.value = p.weight !== undefined ? String(p.weight) : '1';
        slider.className = 'playerSlider';
        slider.title = 'Bias weight for this player';
        slider.oninput = (e) => {
          const v = Number(e.target.value);
          socket.emit('setWeight', { target: key, weight: v });
        };
        leftWrap.appendChild(slider);
      }
    }

    const left = document.createElement("div");
    left.className = 'playerName';
    left.textContent = p.name;
    if (p.connected === false) left.classList.add('disconnected');
    leftWrap.appendChild(left);

    const right = document.createElement("div");

    // Hide 'No bet' or any bet label for the Dealer row
    if ((p.name || '').toLowerCase() !== 'dealer') {
      const bet = document.createElement("span");
        bet.className = "betValue";
        let displayBet = "No bet";
        if (p.bet !== undefined && p.bet !== null) {
          if (typeof p.bet === 'string') {
            if (p.bet.toLowerCase() === 'red') displayBet = 'Red';
            else if (p.bet.toLowerCase() === 'black') displayBet = 'Black';
            else displayBet = String(p.bet);
          } else {
            displayBet = String(p.bet);
          }
        }
        bet.textContent = displayBet;
      right.appendChild(bet);
    }

    if (p.result) {
      const badge = document.createElement("span");
      if (p.result === "WIN") badge.className = "badge win";
      else if (p.result === "COLOR") badge.className = "badge partial-win";
      else if (p.result === "COLOR_ONLY") badge.className = "badge color-only";
      else badge.className = "badge lose";

      badge.textContent = (p.result === "COLOR" || p.result === "COLOR_ONLY") ? "WIN (Color)" : p.result;
      right.appendChild(badge);
    }

    row.append(leftWrap, right);
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

// One-time gesture to ensure audio can play in browsers that require user interaction
document.addEventListener('click', () => {
  ensureAudioCtx();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}, { once: true });

// Start login after socket event handlers are registered
doLogin();