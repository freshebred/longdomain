/* ───────────────────────────────────────────────────────────────────────────
   script.js — Infinite Canvas 2000s main client
   ─────────────────────────────────────────────────────────────────────────── */

const viewport = document.getElementById('viewport');
const world = document.getElementById('world');
const itemsContainer = document.getElementById('items-container');
const usersContainer = document.getElementById('users-container');
const overlayLines = document.getElementById('overlay-lines');
const userInput = document.getElementById('user-input');
const submitBtn = document.getElementById('submit-btn');
const statusMsg = document.getElementById('status-msg');
const popupsLayer = document.getElementById('popups-layer');
const onlineCountEl = document.getElementById('online-count');
const answerQBtn = document.getElementById('answer-q-btn');

// State
let scale = 1;
let panX = 0;
let panY = 0;
let isDragging = false;
let startX, startY;
let lastPanX, lastPanY;
let canvasItems = [];
let jokeLines = [];
let questions = [];
let targetItem = null;
let ws = null;
let isConnected = false;
let otherUsers = new Map();
let myId = null;
let isAdmin = false;

// Admin drag state
let draggingQuestion = null; // { id, startWorldX, startWorldY, el }
let dragOffsetX = 0;
let dragOffsetY = 0;

// Constants
const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
const COLORS = ['#ff0000', '#008000', '#0000ff', '#800080', '#008080', '#000000', '#ff4500', '#8b4513'];

// ── Initialization ─────────────────────────────────────────────────────────

async function init() {
    await fetchData();
    await fetchQuestions();
    await fetchAdminStatus();
    setupWebSocket();
    setupEventListeners();
    setupAnswerModal();
    renderItems();
    renderAllQuestions();
    startStupidLoop();
    requestAnimationFrame(gameLoop);
}

async function fetchAdminStatus() {
    try {
        const res = await fetch('/api/admin/check');
        const data = await res.json();
        isAdmin = !!data.isAdmin;
        if (isAdmin) showAdminBadge();
    } catch (e) {
        isAdmin = false;
    }
}

function showAdminBadge() {
    const badge = document.createElement('div');
    badge.id = 'admin-mode-badge';
    badge.innerHTML = `
        <div class="admin-badge-text">⚡ ADMIN MODE — drag circles to reposition</div>
        <div class="admin-logout-btn" title="Logout from Admin Mode">LOGOUT</div>
    `;
    document.body.appendChild(badge);

    badge.querySelector('.admin-logout-btn').addEventListener('click', async () => {
        try {
            await fetch('/api/admin/logout', { method: 'POST' });
            window.location.reload();
        } catch (e) {
            console.error('Logout failed', e);
        }
    });
}

async function fetchData() {
    try {
        const res = await fetch('/api/data');
        const data = await res.json();
        canvasItems = data.canvas;
        jokeLines = data.jokes;
        renderItems();
    } catch (err) {
        console.error('Failed to fetch data', err);
    }
}

async function fetchQuestions() {
    try {
        const res = await fetch('/api/questions/all');
        questions = await res.json();
    } catch (err) {
        console.error('Failed to fetch questions', err);
    }
}

// ── WebSocket ───────────────────────────────────────────────────────────────

function setupWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        isConnected = true;
        statusMsg.textContent = 'CONNECTED';
        setTimeout(() => { statusMsg.textContent = ''; }, 2000);
        sendViewportUpdate();
    };

    ws.onclose = () => {
        isConnected = false;
        statusMsg.textContent = 'DISCONNECTED - RECONNECTING...';
        onlineCountEl.textContent = 'Online: 0';
        setTimeout(setupWebSocket, 3000);
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            switch (data.type) {
                case 'init':
                    myId = data.id;
                    break;
                case 'online_count':
                    onlineCountEl.textContent = `Online: ${data.count}`;
                    break;
                case 'viewports':
                    updateOtherUsers(data.viewports);
                    break;
                case 'new_item':
                    canvasItems.push(data.item);
                    renderNewItem(data.item);
                    break;
                case 'submit_success':
                    statusMsg.textContent = 'SENT!';
                    userInput.value = '';
                    canvasItems.push(data.item);
                    renderNewItem(data.item);
                    targetItem = data.item;
                    setTimeout(() => { statusMsg.textContent = ''; }, 3000);
                    break;
                case 'submit_error':
                    statusMsg.textContent = data.error || 'ERROR';
                    setTimeout(() => { statusMsg.textContent = ''; }, 3000);
                    break;
                case 'delete_item':
                    handleDeleteItem(data.id);
                    break;
                case 'new_question':
                    handleNewQuestion(data.question);
                    break;
                case 'update_question':
                    handleUpdateQuestion(data.question);
                    break;
                case 'delete_question':
                    handleDeleteQuestion(data.id);
                    break;
                case 'new_response':
                    handleNewResponse(data.questionId, data.response);
                    break;
                case 'delete_response':
                    handleDeleteResponse(data.questionId, data.responseId);
                    break;
                case 'move_question':
                    handleMoveQuestion(data.id, data.x, data.y);
                    break;
            }
        } catch (e) {
            console.error('WS Error', e);
        }
    };
}

function sendViewportUpdate() {
    if (!isConnected) return;
    const w = window.innerWidth / scale;
    const h = window.innerHeight / scale;
    const x = -panX / scale;
    const y = -panY / scale;
    ws.send(JSON.stringify({ type: 'viewport', viewport: { x, y, w, h, scale } }));
}

// ── Delete item handler ───────────────────────────────────────────────────

function handleDeleteItem(id) {
    canvasItems = canvasItems.filter(i => (i._id || i.id) !== id);
    const el = document.querySelector(`[data-item-id="${id}"]`);
    if (el) el.remove();
}

// ── Question handlers ─────────────────────────────────────────────────────

function handleNewQuestion(q) {
    questions.push(q);
    renderQuestionCircle(q);
}

function handleUpdateQuestion(updatedQ) {
    const idx = questions.findIndex(q => q._id === updatedQ._id);
    if (idx >= 0) questions[idx] = updatedQ;
    const el = document.getElementById(`qcircle-${updatedQ._id}`);
    if (el) el.remove();
    renderQuestionCircle(updatedQ);
}

function handleDeleteQuestion(id) {
    questions = questions.filter(q => q._id !== id);
    const el = document.getElementById(`qcircle-${id}`);
    if (el) el.remove();
}

function handleNewResponse(questionId, response) {
    const q = questions.find(q => q._id === questionId);
    if (!q) return;
    q.responses = q.responses || [];
    q.responses.push(response);
    // Add response to existing circle DOM
    const inner = document.querySelector(`#qcircle-${questionId} .question-circle-inner`);
    if (inner) appendResponseEl(inner, response, q.size);
    updateCircleHeat(q);
}
function handleMoveQuestion(id, x, y) {
    const q = questions.find(q => q._id === id);
    if (q) { q.x = x; q.y = y; }
    const el = document.getElementById(`qcircle-${id}`);
    if (el) {
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
    }
}

function handleDeleteResponse(questionId, responseId) {
    const q = questions.find(q => q._id === questionId);
    if (!q) return;
    q.responses = (q.responses || []).filter(r => r._id !== responseId);
    const el = document.getElementById(`qresp-${responseId}`);
    if (el) el.remove();
    updateCircleHeat(q);
}

// ── Rendering ─────────────────────────────────────────────────────────────

function renderItems() {
    if (!itemsContainer) return;
    itemsContainer.innerHTML = '';
    canvasItems.forEach(item => renderNewItem(item));
}

function renderNewItem(item) {
    const el = document.createElement('div');
    el.className = 'canvas-item';
    el.textContent = item.text;
    el.style.left = `${item.x}px`;
    el.style.top = `${item.y}px`;
    el.style.transform = `translate(-50%, -50%) rotate(${item.rotation}deg)`;
    el.style.fontSize = `${item.fontSize}px`;
    const fontIndex = Math.abs(hashCode(item.text)) % 12;
    el.classList.add(`font-${fontIndex}`);
    const colorIndex = Math.abs(hashCode(item.text + (item.timestamp || ''))) % COLORS.length;
    el.style.color = item.color || COLORS[colorIndex];
    const itemId = item._id || item.id;
    if (itemId) el.dataset.itemId = itemId;
    itemsContainer.appendChild(el);
}

// ── Question Circles ──────────────────────────────────────────────────────

function renderAllQuestions() {
    questions.forEach(q => renderQuestionCircle(q));
}

/**
 * Returns a heat-based border color for the circle.
 * Blue (cool) → orange → red (full)
 */
function getHeatColor(fillPct) {
    if (fillPct < 0.5) {
        // blue → orange
        const t = fillPct / 0.5;
        const r = Math.round(30 + t * (249 - 30));
        const g = Math.round(144 + t * (115 - 144));
        const b = Math.round(255 + t * (22 - 255));
        return `rgb(${r},${g},${b})`;
    } else {
        // orange → red
        const t = (fillPct - 0.5) / 0.5;
        const r = Math.round(249 + t * (239 - 249));
        const g = Math.round(115 + t * (68 - 115));
        const b = Math.round(22 + t * (68 - 22));
        return `rgb(${r},${g},${b})`;
    }
}

function estimateFillPct(q) {
    const responseCount = (q.responses || []).length;
    const maxArea = Math.PI * Math.pow(q.size / 2, 2);
    const avgResponseArea = 25 * 9.6 * 22.4;
    const estimatedMax = Math.max(1, Math.floor(maxArea / avgResponseArea));
    return Math.min(1, responseCount / estimatedMax);
}

function updateCircleHeat(q) {
    const circle = document.querySelector(`#qcircle-${q._id} .question-circle`);
    if (!circle) return;
    const fillPct = estimateFillPct(q);
    circle.style.borderColor = getHeatColor(fillPct);
}

function renderQuestionCircle(q) {
    const wrapper = document.createElement('div');
    wrapper.className = 'question-circle-wrapper' + (isAdmin ? ' admin-draggable' : '');
    wrapper.id = `qcircle-${q._id}`;
    wrapper.dataset.qid = q._id;
    wrapper.style.left = `${q.x}px`;
    wrapper.style.top = `${q.y}px`;

    const fillPct = estimateFillPct(q);
    const heatColor = getHeatColor(fillPct);
    const bgAlpha = q.status === 'open' ? '0.12' : '0.07';

    wrapper.innerHTML = `
        <div class="question-circle" style="
            width:${q.size}px;
            height:${q.size}px;
            border: 4px solid ${heatColor};
            background: rgba(180,220,255,${bgAlpha});
        ">
            <div class="question-circle-inner">
                <div class="question-text-label">${escapeHtml(q.question)}</div>
                <span class="question-status-badge q-status-${q.status}">${q.status}</span>
            </div>
        </div>
        ${isAdmin ? `<div class="admin-drag-handle" title="Drag to reposition">&#9654; MOVE</div>` : ''}
    `;

    const inner = wrapper.querySelector('.question-circle-inner');
    (q.responses || []).forEach(r => appendResponseEl(inner, r, q.size));

    itemsContainer.appendChild(wrapper);
}

function appendResponseEl(inner, response, size) {
    const el = document.createElement('div');
    el.className = 'question-response';
    el.id = `qresp-${response._id}`;
    el.textContent = response.text;

    // Derive font, color, rotation deterministically from response _id
    // so it's consistent across all clients and page reloads
    const seed1 = Math.abs(hashCode(response._id || response.text));
    const seed2 = Math.abs(hashCode((response._id || '') + (response.timestamp || '')));
    const seed3 = Math.abs(hashCode((response.text || '') + (response._id || '')));

    el.classList.add(`font-${seed1 % 12}`);
    el.style.color = COLORS[seed2 % COLORS.length];

    if (response.fontSize) {
        el.style.fontSize = `${response.fontSize}px`;
    }

    // ±15° rotation — tight enough to stay readable inside the circle
    const rotation = (seed3 % 31) - 15;
    el.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;

    const radius = size / 2;
    el.style.left = `${radius + response.x}px`;
    el.style.top = `${radius + response.y}px`;

    inner.appendChild(el);
}


// ── Answer Question Modal ─────────────────────────────────────────────────

let selectedQuestion = null;

function setupAnswerModal() {
    answerQBtn.addEventListener('click', openAnswerModal);
    document.getElementById('aq-close-btn').addEventListener('click', closeAnswerModal);
    document.getElementById('aq-back-btn').addEventListener('click', showQuestionList);
    document.getElementById('aq-submit-btn').addEventListener('click', submitAnswer);
    document.getElementById('aq-answer-input').addEventListener('input', onAnswerInput);
    document.getElementById('aq-modal').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeAnswerModal();
    });
}

async function openAnswerModal() {
    document.getElementById('aq-modal').classList.remove('aq-hidden');
    showQuestionList();
}

function closeAnswerModal() {
    document.getElementById('aq-modal').classList.add('aq-hidden');
    selectedQuestion = null;
    document.getElementById('aq-answer-input').value = '';
}

async function showQuestionList() {
    document.getElementById('aq-step-choose').classList.remove('aq-hidden');
    document.getElementById('aq-step-answer').classList.add('aq-hidden');
    selectedQuestion = null;

    const listEl = document.getElementById('aq-q-list');
    listEl.innerHTML = '<div class="aq-empty">Loading...</div>';

    try {
        const res = await fetch('/api/questions');
        const openQs = await res.json();

        if (openQs.length === 0) {
            listEl.innerHTML = '<div class="aq-empty">No open questions right now. Check back later!</div>';
            return;
        }

        listEl.innerHTML = openQs.map(q => `
            <div class="aq-question-item" onclick="selectQuestion('${q._id}')">
                <span class="aq-q-text">${escapeHtml(q.question)}</span>
                <div class="aq-q-meta">
                    <span class="aq-q-size">⌀ ${q.size}px circle</span>
                </div>
                <button class="aq-goto-link" onclick="event.stopPropagation(); panToQuestion('${q._id}')">→ Show on canvas</button>
            </div>
        `).join('');
    } catch (e) {
        listEl.innerHTML = '<div class="aq-empty">Failed to load questions</div>';
    }
}

function panToQuestion(qId) {
    const q = questions.find(q => q._id === qId);
    if (!q) return;
    panX = -q.x * scale;
    panY = -q.y * scale;
    updateTransform();
    sendViewportUpdate();
    closeAnswerModal();
}

async function selectQuestion(qId) {
    const res = await fetch(`/api/questions/${qId}/capacity`);
    const cap = await res.json();
    const q = questions.find(q => q._id === qId);

    selectedQuestion = q || { _id: qId };

    document.getElementById('aq-selected-q').textContent = q ? `"${q.question}"` : 'Selected question';
    document.getElementById('aq-step-choose').classList.add('aq-hidden');
    document.getElementById('aq-step-answer').classList.remove('aq-hidden');
    document.getElementById('aq-answer-input').value = '';
    document.getElementById('aq-char-count').textContent = '0 / 25';
    document.getElementById('aq-too-long').classList.add('aq-hidden');
    document.getElementById('aq-cooldown-msg').textContent = '';
    document.getElementById('aq-submit-btn').disabled = !cap.canFit;

    if (!cap.canFit) {
        document.getElementById('aq-too-long').classList.remove('aq-hidden');
        document.getElementById('aq-too-long').textContent = 'This circle is full! No more responses fit.';
    }

    document.getElementById('aq-answer-input').focus();
}

function onAnswerInput() {
    const val = document.getElementById('aq-answer-input').value;
    const len = val.length;
    document.getElementById('aq-char-count').textContent = `${len} / 25`;

    const tooLong = len > 25;
    document.getElementById('aq-too-long').classList.toggle('aq-hidden', !tooLong);
    if (tooLong) document.getElementById('aq-too-long').textContent = 'Response too long for this circle!';
    document.getElementById('aq-submit-btn').disabled = tooLong || len === 0;
}

async function submitAnswer() {
    if (!selectedQuestion) return;
    const text = document.getElementById('aq-answer-input').value.trim();
    if (!text || text.length > 25) return;

    const submitBtn = document.getElementById('aq-submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'SENDING...';

    try {
        const res = await fetch(`/api/questions/${selectedQuestion._id}/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        const data = await res.json();

        if (res.ok) {
            document.getElementById('aq-answer-input').value = '';
            document.getElementById('aq-char-count').textContent = '0 / 25';
            closeAnswerModal();
            // Pan to the question circle to show the response
            panToQuestion(selectedQuestion._id);
        } else {
            document.getElementById('aq-cooldown-msg').textContent = data.error || 'Failed to submit';
            submitBtn.disabled = false;
        }
    } catch (e) {
        document.getElementById('aq-cooldown-msg').textContent = 'Network error';
        submitBtn.disabled = false;
    }

    submitBtn.textContent = 'SEND IT';
}

// ── Other Users ────────────────────────────────────────────────────────────

function updateOtherUsers(viewports) {
    const updatedIds = new Set();
    viewports.forEach(vp => {
        if (vp.id === myId) return;
        updatedIds.add(vp.id);
        let user = otherUsers.get(vp.id);
        if (!user) {
            const el = document.createElement('div');
            el.className = 'user-viewport';
            usersContainer.appendChild(el);
            user = { el };
            otherUsers.set(vp.id, user);
        }
        user.x = vp.x; user.y = vp.y; user.w = vp.w; user.h = vp.h;
        user.el.style.width = `${vp.w}px`;
        user.el.style.height = `${vp.h}px`;
        user.el.style.left = `${vp.x - vp.w / 2}px`;
        user.el.style.top = `${vp.y - vp.h / 2}px`;
    });
    for (const [id, user] of otherUsers) {
        if (!updatedIds.has(id)) {
            user.el.remove();
            otherUsers.delete(id);
        }
    }
}

// ── Event Listeners ────────────────────────────────────────────────────────

function setupEventListeners() {
    viewport.addEventListener('mousedown', e => {
        if (!isConnected) return;
        if (e.target.closest('#center-console') || e.target.closest('#aq-modal')) return;

        // Admin: check if clicking a draggable question circle (the handle or the circle itself)
        if (isAdmin) {
            const wrapper = e.target.closest('.admin-draggable');
            if (wrapper) {
                e.preventDefault();
                e.stopPropagation();
                const qId = wrapper.dataset.qid;
                const q = questions.find(q => q._id === qId);
                if (!q) return;
                // Compute where in world-space the mouse is
                const worldX = (e.clientX - window.innerWidth / 2 - panX) / scale;
                const worldY = (e.clientY - window.innerHeight / 2 - panY) / scale;
                dragOffsetX = worldX - q.x;
                dragOffsetY = worldY - q.y;
                draggingQuestion = { id: qId, el: wrapper };
                wrapper.style.opacity = '0.75';
                wrapper.style.zIndex = '500';
                viewport.style.cursor = 'grabbing';
                return;
            }
        }

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        lastPanX = panX;
        lastPanY = panY;
        viewport.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', e => {
        // Admin question drag takes priority
        if (draggingQuestion) {
            const worldX = (e.clientX - window.innerWidth / 2 - panX) / scale;
            const worldY = (e.clientY - window.innerHeight / 2 - panY) / scale;
            const newX = worldX - dragOffsetX;
            const newY = worldY - dragOffsetY;
            draggingQuestion.el.style.left = `${newX}px`;
            draggingQuestion.el.style.top = `${newY}px`;
            return;
        }
        if (isDragging) {
            panX = lastPanX + (e.clientX - startX);
            panY = lastPanY + (e.clientY - startY);
            updateTransform();
        }
    });

    window.addEventListener('mouseup', async () => {
        // Finish question drag: save position
        if (draggingQuestion) {
            const el = draggingQuestion.el;
            const qId = draggingQuestion.id;
            const newX = parseFloat(el.style.left);
            const newY = parseFloat(el.style.top);
            el.style.opacity = '';
            el.style.zIndex = '';
            draggingQuestion = null;
            viewport.style.cursor = 'grab';
            // Update local state
            const q = questions.find(q => q._id === qId);
            if (q) { q.x = newX; q.y = newY; }
            // Persist to server
            await saveQuestionPosition(qId, newX, newY);
            return;
        }
        isDragging = false;
        viewport.style.cursor = 'grab';
        if (isConnected) sendViewportUpdate();
    });

    viewport.addEventListener('wheel', e => {
        if (!isConnected) return;
        e.preventDefault();
        const delta = -Math.sign(e.deltaY);
        const newScale = scale + (delta * 0.1 * scale);
        if (newScale >= MIN_SCALE && newScale <= MAX_SCALE) {
            scale = newScale;
            updateTransform();
            sendViewportUpdate();
        }
    }, { passive: false });

    submitBtn.addEventListener('click', submitText);
    userInput.addEventListener('keypress', e => {
        if (e.key === 'Enter') submitText();
    });

    viewport.addEventListener('touchstart', e => {
        if (!isConnected) return;
        if (e.touches.length === 1) {
            isDragging = true;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            lastPanX = panX;
            lastPanY = panY;
        }
    });

    viewport.addEventListener('touchmove', e => {
        if (isDragging && e.touches.length === 1) {
            panX = lastPanX + (e.touches[0].clientX - startX);
            panY = lastPanY + (e.touches[0].clientY - startY);
            updateTransform();
        }
    });

    viewport.addEventListener('touchend', () => {
        isDragging = false;
        if (isConnected) sendViewportUpdate();
    });
}

// ── Save question position (admin drag) ────────────────────────────────────

async function saveQuestionPosition(qId, x, y) {
    try {
        await fetch(`/api/admin/questions/${qId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ x, y })
        });
    } catch (e) {
        console.error('Failed to save question position', e);
    }
}


// ── Transform ─────────────────────────────────────────────────────────────

function updateTransform() {
    world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    updateOverlay();
}

// ── Submit ─────────────────────────────────────────────────────────────────

function submitText() {
    if (!isConnected) {
        statusMsg.textContent = 'NOT CONNECTED';
        return;
    }
    const text = userInput.value.trim();
    if (!text) return;
    statusMsg.textContent = 'SENDING...';
    ws.send(JSON.stringify({ type: 'submit', text }));
}

// ── Overlay ────────────────────────────────────────────────────────────────

function updateOverlay() {
    overlayLines.innerHTML = '';
    if (targetItem) {
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;
        const itemScreenX = centerX + panX + (targetItem.x * scale);
        const itemScreenY = centerY + panY + (targetItem.y * scale);
        if (itemScreenX < 0 || itemScreenX > window.innerWidth ||
            itemScreenY < 0 || itemScreenY > window.innerHeight) {
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', centerX);
            line.setAttribute('y1', centerY);
            line.setAttribute('x2', itemScreenX);
            line.setAttribute('y2', itemScreenY);
            line.setAttribute('stroke', 'yellow');
            line.setAttribute('stroke-width', '2');
            overlayLines.appendChild(line);
        } else {
            targetItem = null;
        }
    }
}

function gameLoop() {
    updateOverlay();
    requestAnimationFrame(gameLoop);
}

// ── Stupid Loop ────────────────────────────────────────────────────────────

function startStupidLoop() {
    setInterval(() => { if (Math.random() > 0.7) spawnPopup(); }, 10000);
    setInterval(() => { if (Math.random() > 0.5) spawnGroundShape(); }, 5000);
}

function spawnPopup() {
    if (!jokeLines.length) return;
    const text = jokeLines[Math.floor(Math.random() * jokeLines.length)];
    const popup = document.createElement('div');
    popup.className = 'stupid-popup';
    popup.style.left = `${Math.random() * (window.innerWidth - 200)}px`;
    popup.style.top = `${Math.random() * (window.innerHeight - 150)}px`;
    popup.innerHTML = `
        <div class="popup-header">
            <span>MESSAGE</span>
            <span class="popup-close">X</span>
        </div>
        <div class="popup-content">${text}</div>
    `;
    popup.querySelector('.popup-close').addEventListener('click', () => popup.remove());
    popupsLayer.appendChild(popup);
    setTimeout(() => popup.remove(), 8000);
}

function spawnGroundShape() {
    if (!itemsContainer) return;
    const shape = document.createElement('div');
    shape.className = 'stupid-shape';
    const size = Math.random() * 200 + 50;
    shape.style.width = `${size}px`;
    shape.style.height = `${size}px`;
    shape.style.border = `${Math.random() * 10 + 2}px solid ${COLORS[Math.floor(Math.random() * COLORS.length)]}`;
    shape.style.left = `${(Math.random() - 0.5) * 2000}px`;
    shape.style.top = `${(Math.random() - 0.5) * 2000}px`;
    shape.style.transform = `rotate(${Math.random() * 360}deg)`;
    const type = Math.random();
    if (type < 0.33) {
        shape.style.borderRadius = '50%';
    } else if (type < 0.66) {
        shape.style.width = '0';
        shape.style.height = '0';
        shape.style.borderLeft = `${size / 2}px solid transparent`;
        shape.style.borderRight = `${size / 2}px solid transparent`;
        shape.style.borderBottom = `${size}px solid ${COLORS[Math.floor(Math.random() * COLORS.length)]}`;
        shape.style.backgroundColor = 'transparent';
        shape.style.borderTop = 'none';
    }
    if (jokeLines.length && Math.random() > 0.5) {
        const text = document.createElement('div');
        text.textContent = jokeLines[Math.floor(Math.random() * jokeLines.length)];
        text.style.color = COLORS[Math.floor(Math.random() * COLORS.length)];
        text.style.fontSize = '12px';
        text.style.textAlign = 'center';
        text.style.width = '100%';
        text.style.position = 'absolute';
        text.style.top = '50%';
        text.style.transform = 'translateY(-50%)';
        shape.appendChild(text);
    }
    itemsContainer.insertBefore(shape, itemsContainer.firstChild);
    const shapes = document.querySelectorAll('.stupid-shape');
    if (shapes.length > 20) shapes[0].remove();
}

// ── Utilities ──────────────────────────────────────────────────────────────

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return hash;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── Boot ───────────────────────────────────────────────────────────────────

init();
