/* ───────────────────────────────────────────────────────────────────────────
   maze.js — Chaos navigation for /youdontknowthispage
   ─────────────────────────────────────────────────────────────────────────── */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const SCRAMBLE_INTERVAL = 15000; // 15 seconds

const TROLL_MSGS = [
    'ALMOST THERE... just kidding.',
    'why are you still doing this',
    'lol',
    'wrong.',
    'you\'re getting warmer... not really',
    'ERROR: BRAIN NOT FOUND',
    'bro.',
    'stop.',
    'this is genuinely sad',
    'have you tried turning yourself off',
    'the answer is not what you think',
    'maybe try google',
    'okay fine, the answer is Z. (it\'s not)',
    'i\'m rooting for you! (i\'m not)',
    '',
    '',
    '',
];

const FOOTER_TAUNTS = [
    'you\'ll never find it',
    'give up',
    'keep clicking lol',
    'skill issue',
    'the answer is love (unhelpful)',
    'not this one',
    'are you sure?',
];

const NEON_COLORS = [
    '#39ff14', '#ff00cc', '#00ffff', '#ff003c',
    '#ffff00', '#ff6600', '#aa00ff', '#00ff88'
];

const BORDER_RADII = ['4px', '50%', '12px', '40% 60% 60% 40% / 60% 40% 60% 40%', '0px', '20px 4px'];

let depth = 0;
let currentPath = [];
let scrambleTimer = null;
let countdownTimer = null;
let shakePest = null;
let buttons = [];
let countdownProgress = 1; // 1 = full bar
let isNavigating = false;

const grid = document.getElementById('buttons-grid');
const depthEl = document.getElementById('depth-num');
const trollEl = document.getElementById('troll-msg');
const countdownFill = document.getElementById('countdown-fill');
const fakeCursor = document.getElementById('fake-cursor');
const footerTaunt = document.getElementById('footer-taunt');

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
    // Fetch current session state
    try {
        const res = await fetch('/api/maze/state');
        const state = await res.json();
        depth = state.depth;
        currentPath = state.path;
    } catch (e) {
        depth = 0;
        currentPath = [];
    }

    depthEl.textContent = depth;
    updateFooter();
    renderButtons();
    startScrambleTimer();
    startShakePest();
    startFakeCursor();
    showTrollMsg();
}

// ── Button Rendering ─────────────────────────────────────────────────────────

function getGridPositions() {
    const cols = 7;
    const cellW = Math.min(80, (grid.offsetWidth) / cols);
    const cellH = 72;
    const positions = [];
    for (let i = 0; i < 26; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        positions.push({
            x: col * cellW + (cellW - 62) / 2,
            y: row * cellH + 4
        });
    }
    return positions;
}

function shuffledLetters() {
    const arr = [...LETTERS];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function renderButtons() {
    grid.innerHTML = '';
    buttons = [];
    const letters = shuffledLetters();
    const positions = getGridPositions();
    const shuffledPositions = [...positions].sort(() => Math.random() - 0.5);

    letters.forEach((letter, i) => {
        const btn = document.createElement('button');
        btn.className = 'maze-btn';
        btn.textContent = letter;
        btn.dataset.letter = letter;
        btn.setAttribute('aria-label', `Choose letter ${letter}`);

        // Random color tint
        const color = NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)];
        btn.style.color = color;
        btn.style.borderColor = color;
        btn.style.boxShadow = `0 0 10px ${color}40, inset 0 0 10px ${color}10`;

        const pos = shuffledPositions[i];
        btn.style.left = `${pos.x}px`;
        btn.style.top = `${pos.y}px`;

        btn.addEventListener('click', () => onLetterClick(letter));
        grid.appendChild(btn);
        buttons.push({ btn, letter });
    });
}

// ── Scramble ─────────────────────────────────────────────────────────────────

function scrambleButtons() {
    const positions = getGridPositions();
    const shuffledPositions = [...positions].sort(() => Math.random() - 0.5);

    buttons.forEach(({ btn }, i) => {
        const pos = shuffledPositions[i];
        btn.style.left = `${pos.x}px`;
        btn.style.top = `${pos.y}px`;

        // Random color reassignment
        const color = NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)];
        btn.style.color = color;
        btn.style.borderColor = color;
        btn.style.boxShadow = `0 0 10px ${color}40, inset 0 0 10px ${color}10`;

        // Random border radius morph
        const radius = BORDER_RADII[Math.floor(Math.random() * BORDER_RADII.length)];
        btn.style.borderRadius = radius;

        // Brief morph class
        btn.classList.add('morphing');
        setTimeout(() => btn.classList.remove('morphing'), 700);
    });

    // Flash background
    document.body.style.backgroundColor = '#0d0010';
    setTimeout(() => { document.body.style.backgroundColor = ''; }, 200);

    showTrollMsg();
    updateFooter();
}

function startScrambleTimer() {
    if (scrambleTimer) clearInterval(scrambleTimer);
    if (countdownTimer) clearInterval(countdownTimer);

    countdownProgress = 1;
    countdownFill.style.transform = 'scaleX(1)';

    const tickInterval = 100;
    const totalTicks = SCRAMBLE_INTERVAL / tickInterval;
    let ticks = 0;

    countdownTimer = setInterval(() => {
        ticks++;
        countdownProgress = 1 - (ticks / totalTicks);
        countdownFill.style.transform = `scaleX(${Math.max(0, countdownProgress)})`;

        if (ticks >= totalTicks) {
            ticks = 0;
            countdownProgress = 1;
            scrambleButtons();
        }
    }, tickInterval);
}

// ── Shake pest: randomly shakes a button every few seconds ───────────────────

function startShakePest() {
    if (shakePest) clearInterval(shakePest);
    shakePest = setInterval(() => {
        if (buttons.length === 0) return;
        const { btn } = buttons[Math.floor(Math.random() * buttons.length)];
        btn.classList.add('shaking');
        setTimeout(() => btn.classList.remove('shaking'), 600);

        // Also randomly pulse another
        if (Math.random() > 0.5) {
            const { btn: btn2 } = buttons[Math.floor(Math.random() * buttons.length)];
            btn2.classList.add('pulsing');
            setTimeout(() => btn2.classList.remove('pulsing'), 500);
        }
    }, 2500);
}

// ── Fake cursor ───────────────────────────────────────────────────────────────

function startFakeCursor() {
    setInterval(() => {
        if (Math.random() > 0.4) {
            fakeCursor.style.left = `${Math.random() * window.innerWidth}px`;
            fakeCursor.style.top = `${Math.random() * window.innerHeight}px`;
        }
    }, 1200);
}

// ── Troll messages ────────────────────────────────────────────────────────────

function showTrollMsg() {
    trollEl.textContent = TROLL_MSGS[Math.floor(Math.random() * TROLL_MSGS.length)];
}

function updateFooter() {
    footerTaunt.textContent = FOOTER_TAUNTS[Math.floor(Math.random() * FOOTER_TAUNTS.length)];
}

// ── Letter click handler ──────────────────────────────────────────────────────

async function onLetterClick(letter) {
    if (isNavigating) return;
    isNavigating = true;

    // Visual feedback on clicked button
    const found = buttons.find(b => b.letter === letter);
    if (found) {
        found.btn.classList.add('pulsing');
        found.btn.style.transform = 'scale(0.85)';
        setTimeout(() => { found.btn.style.transform = ''; }, 300);
    }

    try {
        const res = await fetch('/api/maze/next', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ letter: letter.toLowerCase() })
        });
        const data = await res.json();

        if (data.error === 'no_session') {
            window.location.href = '/youdontknowthispage.html';
            return;
        }

        if (data.success && data.redirect) {
            // Brief flash before redirect
            depth++;
            depthEl.textContent = depth;

            if (data.redirect.includes('/i/l/o/v/e/y/o/u')) {
                // WIN!
                await playWinSequence();
            } else {
                await playTransition();
            }

            window.location.href = data.redirect;
        }
    } catch (e) {
        console.error(e);
        isNavigating = false;
    }
}

async function playTransition() {
    return new Promise(resolve => {
        document.body.style.transition = 'opacity 0.3s';
        document.body.style.opacity = '0';
        setTimeout(resolve, 300);
    });
}

async function playWinSequence() {
    return new Promise(resolve => {
        // Green flash
        document.body.style.background = '#00ff00';
        trollEl.textContent = 'YOU FOUND IT!!!';
        trollEl.style.color = '#fff';
        trollEl.style.fontSize = '30px';
        trollEl.style.animation = 'none';
        setTimeout(() => {
            document.body.style.transition = 'opacity 0.5s';
            document.body.style.opacity = '0';
            setTimeout(resolve, 500);
        }, 800);
    });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init();
