/* ───────────────────────────────────────────────────────────────────────────
   admin.js — Admin panel logic
   ─────────────────────────────────────────────────────────────────────────── */

// ── State ─────────────────────────────────────────────────────────────────────

let allMessages = [];
let allQuestions = [];
let editingQuestionId = null;
let pendingConfirm = null;

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
    setupTabs();
    setupQuestionForm();
    setupConfirmDialog();
    await loadMessages();
    await loadQuestions();
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
        });
    });
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

// ── Confirm Dialog ─────────────────────────────────────────────────────────────

function setupConfirmDialog() {
    document.getElementById('confirm-yes').addEventListener('click', () => {
        if (pendingConfirm) pendingConfirm(true);
        pendingConfirm = null;
        document.getElementById('confirm-overlay').classList.add('hidden');
    });
    document.getElementById('confirm-no').addEventListener('click', () => {
        if (pendingConfirm) pendingConfirm(false);
        pendingConfirm = null;
        document.getElementById('confirm-overlay').classList.add('hidden');
    });
}

function confirm(msg) {
    return new Promise(resolve => {
        document.getElementById('confirm-msg').textContent = msg;
        document.getElementById('confirm-overlay').classList.remove('hidden');
        pendingConfirm = resolve;
    });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString();
}

function getFillColor(pct) {
    if (pct < 0.5) return '#22c55e';
    if (pct < 0.75) return '#f97316';
    return '#ef4444';
}

// ── Messages ───────────────────────────────────────────────────────────────────

async function loadMessages() {
    const tbody = document.getElementById('messages-tbody');
    tbody.innerHTML = '<tr><td colspan="6" class="loading">Loading...</td></tr>';

    try {
        const res = await fetch('/api/admin/messages');
        if (res.status === 403) {
            toast('Access denied — please navigate through the maze first', 'error');
            return;
        }
        allMessages = await res.json();
        renderMessages(allMessages);
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6" class="loading">Failed to load messages</td></tr>';
    }
}

function renderMessages(messages) {
    const tbody = document.getElementById('messages-tbody');
    document.getElementById('msg-count').textContent = `${messages.length} messages`;

    if (messages.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="loading">No messages</td></tr>';
        return;
    }

    tbody.innerHTML = messages.map((m, i) => `
        <tr data-id="${m._id}">
            <td style="color:var(--text-dim);font-size:12px">${i + 1}</td>
            <td class="msg-text">${escapeHtml(m.text)}</td>
            <td style="color:var(--text-dim)">${m.fontSize}px</td>
            <td><span class="color-swatch" style="background:${m.color}" title="${m.color}"></span></td>
            <td class="time-cell">${formatTime(m.timestamp)}</td>
            <td>
                <button class="btn-icon" onclick="deleteMessage('${m._id}')" title="Delete">🗑️</button>
            </td>
        </tr>
    `).join('');
}

async function deleteMessage(id) {
    const ok = await confirm('Delete this message permanently from the canvas?');
    if (!ok) return;

    try {
        const res = await fetch(`/api/admin/messages/${id}`, { method: 'DELETE' });
        if (res.ok) {
            toast('Message deleted', 'success');
            allMessages = allMessages.filter(m => m._id !== id);
            renderMessages(allMessages);
        } else {
            toast('Failed to delete', 'error');
        }
    } catch (e) {
        toast('Network error', 'error');
    }
}

// Search
document.getElementById('msg-search').addEventListener('input', function () {
    const q = this.value.toLowerCase();
    const filtered = allMessages.filter(m => m.text.toLowerCase().includes(q));
    renderMessages(filtered);
});

// ── Questions ──────────────────────────────────────────────────────────────────

async function loadQuestions() {
    const list = document.getElementById('questions-list');
    list.innerHTML = '<div class="loading">Loading questions...</div>';

    try {
        const res = await fetch('/api/admin/questions');
        if (res.status === 403) return;
        allQuestions = await res.json();
        renderQuestions(allQuestions);
    } catch (e) {
        list.innerHTML = '<div class="loading">Failed to load questions</div>';
    }
}

function renderQuestions(questions) {
    const list = document.getElementById('questions-list');

    if (questions.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🔵</div>
                No questions yet. Create one above!
            </div>`;
        return;
    }

    list.innerHTML = questions.map(q => {
        const responseCount = q.responses ? q.responses.length : 0;
        const maxArea = Math.PI * Math.pow(q.size / 2, 2);
        const avgResponseArea = 25 * 9.6 * 22.4; // ~25chars * charW * lineH
        const estimatedMax = Math.max(1, Math.floor(maxArea / avgResponseArea));
        const fillPct = Math.min(1, responseCount / estimatedMax);
        const fillColor = getFillColor(fillPct);
        const expiryStr = q.expiresAt ? `<span class="meta-pill" style="background:rgba(234,179,8,0.1);color:#eab308;border:1px solid rgba(234,179,8,0.3)">Expires: ${new Date(q.expiresAt).toLocaleDateString()}</span>` : '';

        return `
        <div class="question-card" id="qcard-${q._id}">
            <div class="qcard-header">
                <div class="qcard-info">
                    <div class="qcard-question">${escapeHtml(q.question)}</div>
                    <div class="qcard-meta">
                        <span class="meta-pill ${q.status === 'open' ? 'pill-open' : 'pill-closed'}">${q.status.toUpperCase()}</span>
                        <span class="meta-pill pill-size">⌀ ${q.size}px</span>
                        <span class="meta-pill pill-responses">${responseCount} response${responseCount !== 1 ? 's' : ''}</span>
                        <span class="meta-pill" style="background:${fillColor}22;color:${fillColor};border:1px solid ${fillColor}44">
                            Fill: ${Math.round(fillPct * 100)}%
                        </span>
                        ${expiryStr}
                    </div>
                </div>
                <div class="qcard-actions">
                    <button class="btn-icon edit" onclick="editQuestion('${q._id}')" title="Edit">✏️</button>
                    <button class="btn-icon" onclick="toggleQuestionStatus('${q._id}', '${q.status}')" title="Toggle status">
                        ${q.status === 'open' ? '🔒' : '🔓'}
                    </button>
                    <button class="btn-icon" onclick="deleteQuestion('${q._id}')" title="Delete question">🗑️</button>
                </div>
            </div>
            <div class="qcard-responses">
                ${renderResponseRows(q)}
            </div>
        </div>`;
    }).join('');
}

function renderResponseRows(q) {
    if (!q.responses || q.responses.length === 0) {
        return '<div class="no-responses">No responses yet</div>';
    }
    return q.responses.map(r => `
        <div class="response-row" id="resp-${r._id}">
            <span class="response-text">${escapeHtml(r.text)}</span>
            <span class="response-time">${formatTime(r.timestamp)}</span>
            <button class="btn-icon" onclick="deleteResponse('${q._id}', '${r._id}')" title="Delete response">✕</button>
        </div>
    `).join('');
}

// ── Question Form ─────────────────────────────────────────────────────────────

function setupQuestionForm() {
    document.getElementById('new-q-btn').addEventListener('click', () => {
        editingQuestionId = null;
        document.getElementById('q-form-title').textContent = 'Create Question';
        document.getElementById('q-submit-btn').textContent = 'Create';
        document.getElementById('q-text').value = '';
        document.getElementById('q-size').value = 500;
        document.getElementById('size-display').textContent = '500';
        document.getElementById('q-expires').value = '';
        setStatusToggle('open');
        updateSizePreview(500);
        document.getElementById('q-form-panel').classList.remove('hidden');
        document.getElementById('q-text').focus();
    });

    document.getElementById('q-cancel-btn').addEventListener('click', () => {
        document.getElementById('q-form-panel').classList.add('hidden');
        editingQuestionId = null;
    });

    document.getElementById('q-size').addEventListener('input', function () {
        document.getElementById('size-display').textContent = this.value;
        updateSizePreview(parseInt(this.value));
    });

    document.getElementById('status-toggle').addEventListener('click', function () {
        const current = this.dataset.status;
        setStatusToggle(current === 'open' ? 'closed' : 'open');
    });

    document.getElementById('q-submit-btn').addEventListener('click', submitQuestion);
}

function setStatusToggle(status) {
    const btn = document.getElementById('status-toggle');
    btn.dataset.status = status;
    btn.textContent = status.toUpperCase();
    btn.className = `status-btn ${status}`;
}

function updateSizePreview(sz) {
    const preview = document.getElementById('size-preview-circle');
    const displaySize = Math.min(sz, 72); // cap at 72px for display
    preview.style.width = `${displaySize}px`;
    preview.style.height = `${displaySize}px`;
}

async function submitQuestion() {
    const text = document.getElementById('q-text').value.trim();
    const size = parseInt(document.getElementById('q-size').value);
    const status = document.getElementById('status-toggle').dataset.status;
    const expiresAt = document.getElementById('q-expires').value || null;

    if (!text) {
        toast('Question text is required', 'error');
        return;
    }

    const body = { question: text, size, status, expiresAt };
    const btn = document.getElementById('q-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
        let res;
        if (editingQuestionId) {
            res = await fetch(`/api/admin/questions/${editingQuestionId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        } else {
            res = await fetch('/api/admin/questions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        }

        if (res.ok) {
            toast(editingQuestionId ? 'Question updated!' : 'Question created!', 'success');
            document.getElementById('q-form-panel').classList.add('hidden');
            editingQuestionId = null;
            await loadQuestions();
        } else {
            const err = await res.json();
            toast(err.error || 'Failed', 'error');
        }
    } catch (e) {
        toast('Network error', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = editingQuestionId ? 'Update' : 'Create';
    }
}

function editQuestion(id) {
    const q = allQuestions.find(q => q._id === id);
    if (!q) return;
    editingQuestionId = id;
    document.getElementById('q-form-title').textContent = 'Edit Question';
    document.getElementById('q-submit-btn').textContent = 'Update';
    document.getElementById('q-text').value = q.question;
    document.getElementById('q-size').value = q.size;
    document.getElementById('size-display').textContent = q.size;
    document.getElementById('q-expires').value = q.expiresAt ? new Date(q.expiresAt).toISOString().slice(0,16) : '';
    setStatusToggle(q.status);
    updateSizePreview(q.size);
    document.getElementById('q-form-panel').classList.remove('hidden');
    document.getElementById('q-text').focus();
    document.getElementById('q-form-panel').scrollIntoView({ behavior: 'smooth' });
}

async function toggleQuestionStatus(id, currentStatus) {
    const newStatus = currentStatus === 'open' ? 'closed' : 'open';
    try {
        const res = await fetch(`/api/admin/questions/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
        });
        if (res.ok) {
            toast(`Question ${newStatus}`, 'success');
            await loadQuestions();
        }
    } catch (e) {
        toast('Network error', 'error');
    }
}

async function deleteQuestion(id) {
    const ok = await confirm('Delete this question and ALL its responses?');
    if (!ok) return;
    try {
        const res = await fetch(`/api/admin/questions/${id}`, { method: 'DELETE' });
        if (res.ok) {
            toast('Question deleted', 'success');
            await loadQuestions();
        }
    } catch (e) {
        toast('Network error', 'error');
    }
}

async function deleteResponse(qid, rid) {
    const ok = await confirm('Delete this response?');
    if (!ok) return;
    try {
        const res = await fetch(`/api/admin/questions/${qid}/responses/${rid}`, { method: 'DELETE' });
        if (res.ok) {
            toast('Response deleted', 'success');
            await loadQuestions();
        }
    } catch (e) {
        toast('Network error', 'error');
    }
}

// ── Utils ──────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init();
