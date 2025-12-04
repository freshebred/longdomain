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

// State
let scale = 1;
let panX = 0;
let panY = 0;
let isDragging = false;
let startX, startY;
let lastPanX, lastPanY;
let canvasItems = [];
let jokeLines = [];
let targetItem = null; // The item to point to with the yellow line
let ws = null;
let isConnected = false;
let otherUsers = new Map(); // id -> {x, y, w, h, scale, el}
let myId = null;

// Constants
const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
const COLORS = ['#ff0000', '#008000', '#0000ff', '#800080', '#008080', '#000000', '#ff4500', '#8b4513'];

// Initialization
async function init() {
    await fetchData();
    setupWebSocket();
    setupEventListeners();
    renderItems();
    startStupidLoop();
    requestAnimationFrame(gameLoop);
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
            }
        } catch (e) {
            console.error('WS Error', e);
        }
    };
}

function sendViewportUpdate() {
    if (!isConnected) return;

    // Calculate visible area in world coordinates
    // World Origin (0,0) is at Screen Center + (panX, panY)
    // We want the World Coordinate of the Screen Center.
    // ScreenCenter = WorldOrigin + WorldOffset * scale
    // ScreenCenter is visually at (ScreenW/2, ScreenH/2)
    // But WorldOrigin is visually at (ScreenW/2 + panX, ScreenH/2 + panY)
    // So: ScreenCenter = WorldOrigin - (panX, panY)
    // WorldOffset = -panX / scale

    const w = window.innerWidth / scale;
    const h = window.innerHeight / scale;
    const x = -panX / scale; // Center X
    const y = -panY / scale; // Center Y

    ws.send(JSON.stringify({
        type: 'viewport',
        viewport: { x, y, w, h, scale }
    }));
}

function updateOtherUsers(viewports) {
    // Mark all as not updated
    const updatedIds = new Set();

    viewports.forEach(vp => {
        if (vp.id === myId) return; // Don't show self

        updatedIds.add(vp.id);

        let user = otherUsers.get(vp.id);
        if (!user) {
            // Create new element
            const el = document.createElement('div');
            el.className = 'user-viewport';
            usersContainer.appendChild(el);
            user = { el };
            otherUsers.set(vp.id, user);
        }

        // Update properties
        user.x = vp.x;
        user.y = vp.y;
        user.w = vp.w;
        user.h = vp.h;

        // Update element style
        // vp.x, vp.y are the center of the viewport in world space
        // CSS left/top should be the top-left corner

        user.el.style.width = `${vp.w}px`;
        user.el.style.height = `${vp.h}px`;
        user.el.style.left = `${vp.x - vp.w / 2}px`;
        user.el.style.top = `${vp.y - vp.h / 2}px`;
    });

    // Remove stale users
    for (const [id, user] of otherUsers) {
        if (!updatedIds.has(id)) {
            user.el.remove();
            otherUsers.delete(id);
        }
    }
}

function setupEventListeners() {
    // Panning
    viewport.addEventListener('mousedown', e => {
        if (!isConnected) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        lastPanX = panX;
        lastPanY = panY;
        viewport.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', e => {
        if (isDragging) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            panX = lastPanX + dx;
            panY = lastPanY + dy;
            updateTransform();
        }
    });

    window.addEventListener('mouseup', () => {
        isDragging = false;
        viewport.style.cursor = 'grab';
        if (isConnected) sendViewportUpdate();
    });

    // Zooming
    viewport.addEventListener('wheel', e => {
        if (!isConnected) return;
        e.preventDefault();
        const zoomIntensity = 0.1;
        const delta = -Math.sign(e.deltaY);
        const newScale = scale + (delta * zoomIntensity * scale);

        if (newScale >= MIN_SCALE && newScale <= MAX_SCALE) {
            scale = newScale;
            updateTransform();
            sendViewportUpdate();
        }
    }, { passive: false });

    // Submission
    submitBtn.addEventListener('click', submitText);
    userInput.addEventListener('keypress', e => {
        if (e.key === 'Enter') submitText();
    });

    // Mobile Touch
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
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            panX = lastPanX + dx;
            panY = lastPanY + dy;
            updateTransform();
        }
    });

    viewport.addEventListener('touchend', () => {
        isDragging = false;
        if (isConnected) sendViewportUpdate();
    });
}

function updateTransform() {
    world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    updateOverlay();
}

function renderItems() {
    if (!itemsContainer) return;
    itemsContainer.innerHTML = ''; // Clear and rebuild

    canvasItems.forEach(item => {
        renderNewItem(item);
    });
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

    // Use stored color, or deterministic hash for old items
    const colorIndex = Math.abs(hashCode(item.text + (item.timestamp || ''))) % COLORS.length;
    el.style.color = item.color || COLORS[colorIndex];

    itemsContainer.appendChild(el);
}

function submitText() {
    if (!isConnected) {
        statusMsg.textContent = 'NOT CONNECTED';
        return;
    }

    const text = userInput.value.trim();
    if (!text) return;

    statusMsg.textContent = 'SENDING...';

    ws.send(JSON.stringify({
        type: 'submit',
        text: text
    }));
}

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

function startStupidLoop() {
    setInterval(() => {
        if (Math.random() > 0.7) spawnPopup();
    }, 10000);

    setInterval(() => {
        if (Math.random() > 0.5) spawnGroundShape();
    }, 5000);
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
            <span class="popup-close" onclick="this.parentElement.parentElement.remove()">X</span>
        </div>
        <div class="popup-content">
            ${text}
        </div>
    `;

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

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return hash;
}

init();
