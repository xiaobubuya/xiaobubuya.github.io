// 账号配置
const ACCOUNTS = { 'yuge': '20250918', 'meimei': '20250918' };

// GitHub 配置
const CONFIG = {
    owner: 'xiaobubuya',
    repo: 'xiaobubuya.github.io',
    branch: 'main',
    imageRepo: 'image',
    cdnBase: 'https://cdn.jsdelivr.net/gh/xiaobubuya/image@main',
    rawBase: 'https://raw.githubusercontent.com/xiaobubuya/image@main'
};

// GitHub Token
const HARDCODED_TOKEN = 'WjJod1gzQnNWa3RrZURJM1pHb3dXa3BvWWxNNFZIUjVSM2t5U0dOalpWVmlSREZMZWt0bmJnPT0=';
const decodedToken = base64Decode(base64Decode(HARDCODED_TOKEN));

let currentUser = null;
let githubToken = decodedToken;
let photos = [];
let filteredPhotos = [];
let displayedPhotos = [];
let currentPage = 0;
const PHOTOS_PER_PAGE = 20;
let currentLightboxIndex = 0;
let folders = [];
let currentFilter = {
    folder: '',
    time: 'all',
    search: '',
    tag: 'all'
};
let currentMainChannel = localStorage.getItem('mainChannel') || 'home';

window.CONFIG = CONFIG;
window.githubToken = githubToken;
window.photos = photos;
window.folders = folders;
window.currentMainChannel = currentMainChannel;

const DEFAULT_MUSIC_ID = '17888105448';
const PREVIOUS_DEFAULT_MUSIC_ID = '2124135604';
const NETEASE_PRESET_SONGS = [
    { id: '17888105448', name: '我们的专属歌单' },
    { id: '120001', name: '网易云热歌榜' },
    { id: '3778678', name: '云音乐新歌榜' },
    { id: '2884035', name: '云音乐飙升榜' }
];
let musicSettings = {
    songId: DEFAULT_MUSIC_ID
};
let statusTimer = null;


// 背景设置
let bgSettings = {
    mode: 'default', // default, photo, gradient
    blur: 8,
    darkness: 30,
    photoIndex: 0,
    customPhoto: ''
};

// IndexedDB 配置
const DB_NAME = 'GalleryDB';
const DB_VERSION = 5;
let db = null;

// 纪念日
let anniversaryDate = '2025-09-18';

function syncSharedState() {
    window.githubToken = githubToken;
    window.photos = photos;
    window.folders = folders;
}

// 初始化
init();

async function init() {
    try {
        await initDB();
    } catch (e) {
        console.warn('IndexedDB 初始化失败，将跳过本地缓存', e);
        db = null;
    }
    loadSettings();
    loadMusicSettings();
    loadAnniversary();
    await loadCountdownEvents();  // 加载倒计时数据
    await loadFootprints();  // 加载地图足迹

    // 本地测试自动加载照片，不需要登录
    const savedUser = localStorage.getItem('galleryUser');
    if (savedUser) {
        currentUser = savedUser;
        showMainPage();
    } else {
        // 本地测试模式：直接加载照片
        console.log('本地测试模式：直接加载照片');
        loadPhotos();
    }

    // 初始化标签点击事件
    document.querySelectorAll('.tag-item').forEach(tag => {
        tag.addEventListener('click', function() {
            document.querySelectorAll('.tag-item').forEach(t => t.classList.remove('active'));
            this.classList.add('active');
            currentFilter.tag = this.dataset.tag;
            filterPhotos();
        });
    });

    // 文件输入监听
    document.getElementById('fileInput').addEventListener('change', e => handleFiles(e.target.files, getSelectedUploadFolder()));

    // 键盘导航
    document.addEventListener('keydown', e => {
        if (document.getElementById('lightbox').classList.contains('active')) {
            if (e.key === 'Escape') closeLightbox();
            if (e.key === 'ArrowLeft') prevPhoto();
            if (e.key === 'ArrowRight') nextPhoto();
        }
    });

    // 拖拽上传
    setupDragDrop();

    // 创建漂浮爱心
    createFloatingHearts();
    initRomanticCursorEffect();
    runHeroTypewriter();
    initSoftInteractionEnhancers();
    initMusicPlayer();
    initMainChannels();
    updateWelcomeMessage();


    // 渲染倒计时卡片
    renderCountdownCards();
    renderFootprints();

    renderStoryTimeline();
    updateHomeOverview();
}

function setMainChannel(channel, persist = true) {
    currentMainChannel = channel;
    window.currentMainChannel = currentMainChannel;
    document.querySelectorAll('.channel-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.channelTab === channel);
    });
    document.querySelectorAll('.channel-section').forEach(section => {
        section.classList.toggle('active', section.dataset.channel === channel);
    });
    if (persist) localStorage.setItem('mainChannel', channel);
}

function initMainChannels() {
    const exists = document.querySelector(`.channel-tab[data-channel-tab="${currentMainChannel}"]`);
    setMainChannel(exists ? currentMainChannel : 'home', false);
}

function switchChannel(channel) {
    setMainChannel(channel, true);
    if (channel === 'gallery') {
        requestAnimationFrame(() => {
            const gallerySection = document.querySelector('.gallery-section');
            if (gallerySection) gallerySection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }
}

function updateHomeOverview() {
    const storyCountEl = document.getElementById('homeStoryCount');
    const photoCountEl = document.getElementById('homePhotoCount');
    const albumCountEl = document.getElementById('homeAlbumCount');
    const footprintCountEl = document.getElementById('homeFootprintCount');
    const countdownCountEl = document.getElementById('homeCountdownCount');
    if (storyCountEl) {
        storyCountEl.textContent = document.querySelectorAll('.timeline-item[data-segment="real"]').length || 0;
    }
    if (photoCountEl) photoCountEl.textContent = photos.length;
    if (albumCountEl) albumCountEl.textContent = folders.length > 0 ? Math.max(0, folders.length - 1) : 0;
    if (footprintCountEl && Array.isArray(window.footprints)) footprintCountEl.textContent = window.footprints.length;
    if (countdownCountEl) countdownCountEl.textContent = countdownEvents.length;
}

// 初始化 IndexedDB
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => { db = request.result; resolve(); };
        request.onupgradeneeded = (e) => {
            const db = e.target.result;

            if (!db.objectStoreNames.contains('photos')) {
                db.createObjectStore('photos', { keyPath: 'name' });
            }

            if (!db.objectStoreNames.contains('metadata')) {
                db.createObjectStore('metadata', { keyPath: 'key' });
            }

            if (!db.objectStoreNames.contains('folders')) {
                db.createObjectStore('folders', { keyPath: 'id' });
            }
        };
    });
}

// ========== 设置功能 ==========

function loadSettings() {
    const saved = localStorage.getItem('coupleSettings');
    if (saved) {
        bgSettings = { ...bgSettings, ...JSON.parse(saved) };
    }
    applyBackgroundSettings();
    syncSettingsControls();
}

function saveSettings() {
    localStorage.setItem('coupleSettings', JSON.stringify(bgSettings));
}

function toggleBackgroundSettings() {
    const panel = document.getElementById('bgSettingsPanel');
    if (!panel) return;
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function toggleSettings() {
    const panel = document.getElementById('settingsPanel');
    if (!panel) return;
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
}

function setBackground(mode) {
    bgSettings.mode = mode;
    saveSettings();
    applyBackgroundSettings();

    // 更新按钮状态
    document.querySelectorAll('.bg-option').forEach(btn => {
        btn.classList.remove('active');
    });
    const activeBtn = document.querySelector(`.bg-option[onclick="setBackground('${mode}')"]`);
    if (activeBtn) activeBtn.classList.add('active');
}

function updateBlur(value) {
    bgSettings.blur = parseInt(value);
    saveSettings();
    applyBackgroundSettings();
    const blurValue = document.getElementById('blurValue');
    if (blurValue) blurValue.textContent = `${bgSettings.blur}px`;
}

function updateDarkness(value) {
    bgSettings.darkness = parseInt(value);
    saveSettings();
    applyBackgroundSettings();
    const darknessValue = document.getElementById('darknessValue');
    if (darknessValue) darknessValue.textContent = `${bgSettings.darkness}%`;
}

function clearBackgroundSlideshowTimer() {
    if (window.backgroundSlideshowTimer) {
        clearInterval(window.backgroundSlideshowTimer);
        window.backgroundSlideshowTimer = null;
    }
}

function applyBackgroundSettings() {
    const bgSlideshow = document.getElementById('bgSlideshow');
    const overlay = document.querySelector('.bg-overlay');
    if (!bgSlideshow || !overlay) return;

    // 应用模糊和暗度
    bgSlideshow.style.filter = `blur(${bgSettings.blur}px)`;
    overlay.style.background = `rgba(255, 240, 245, ${bgSettings.darkness / 100})`;

    // 根据模式设置背景
    if (bgSettings.mode === 'default') {
        clearBackgroundSlideshowTimer();
        bgSlideshow.style.background = 'linear-gradient(135deg, #fff0f5 0%, #ffe4ec 50%, #ffd6e0 100%)';
        bgSlideshow.innerHTML = '';
    } else if (bgSettings.mode === 'gradient') {
        clearBackgroundSlideshowTimer();
        bgSlideshow.style.background = 'linear-gradient(135deg, #ff6b9d 0%, #ffc2d1 50%, #ffd6e0 100%)';
        bgSlideshow.innerHTML = '';
    } else if (bgSettings.mode === 'custom' && bgSettings.customPhoto) {
        clearBackgroundSlideshowTimer();
        bgSlideshow.style.background = '';
        bgSlideshow.innerHTML = `<div class="bg-slide active" style="background-image: url('${bgSettings.customPhoto}')"></div>`;
    } else if (bgSettings.mode === 'photo' && photos.length > 0) {
        startBackgroundSlideshow();
    }
}

function startBackgroundSlideshow() {
    const bgSlideshow = document.getElementById('bgSlideshow');
    if (!bgSlideshow || photos.length === 0) return;

    clearBackgroundSlideshowTimer();

    bgSlideshow.innerHTML = photos.map((p, i) => `
        <div class="bg-slide ${i === 0 ? 'active' : ''}" style="background-image: url('${getImageUrl(p.name)}')"></div>
    `).join('');

    let currentBg = 0;
    window.backgroundSlideshowTimer = setInterval(() => {
        const slides = bgSlideshow.querySelectorAll('.bg-slide');
        if (!slides.length) return;
        slides[currentBg].classList.remove('active');
        currentBg = (currentBg + 1) % slides.length;
        slides[currentBg].classList.add('active');
    }, 10000);
}

function syncSettingsControls() {
    const anniversaryInput = document.getElementById('anniversaryDateInput');
    const blurSlider = document.getElementById('blurSlider');
    const blurValue = document.getElementById('blurValue');
    const darknessSlider = document.getElementById('darknessSlider');
    const darknessValue = document.getElementById('darknessValue');

    if (anniversaryInput) anniversaryInput.value = anniversaryDate;
    if (blurSlider) blurSlider.value = bgSettings.blur;
    if (blurValue) blurValue.textContent = `${bgSettings.blur}px`;
    if (darknessSlider) darknessSlider.value = bgSettings.darkness;
    if (darknessValue) darknessValue.textContent = `${bgSettings.darkness}%`;

    document.querySelectorAll('.bg-option').forEach(btn => {
        const targetMode = bgSettings.mode === 'custom' ? 'photo' : bgSettings.mode;
        const isActive = btn.getAttribute('onclick') === `setBackground('${targetMode}')`;
        btn.classList.toggle('active', isActive);
    });
}

// ========== 纪念日功能 ==========

function loadAnniversary() {
    const saved = localStorage.getItem('anniversaryDate');
    if (saved) {
        anniversaryDate = saved;
    }
    updateAnniversaryDisplay();
    syncSettingsControls();
}

function updateAnniversaryDisplay() {
    const start = new Date(anniversaryDate);
    const now = new Date();
    const diff = Math.floor((now - start) / (1000 * 60 * 60 * 24));

    const daysTogether = document.getElementById('daysTogether');
    const daysTogether2 = document.getElementById('daysTogether2');
    const anniversaryDateEl = document.getElementById('anniversaryDate');
    if (daysTogether) daysTogether.textContent = diff;
    if (daysTogether2) daysTogether2.textContent = diff;
    if (anniversaryDateEl) anniversaryDateEl.textContent = formatDate(start);
}

function updateAnniversary() {
    const input = document.getElementById('anniversaryDateInput');
    if (!input || !input.value) return;
    anniversaryDate = input.value;
    localStorage.setItem('anniversaryDate', anniversaryDate);
    updateAnniversaryDisplay();
    showStatus('纪念日已更新', 'success');
}

function formatDate(date) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

// ========== 重要日期倒计时功能 ==========

let countdownEvents = [];
let editingCountdownIndex = null;

// 图标映射
const typeIcons = {
    birthday: '🎂',
    anniversary: '💕',
    travel: '✈️',
    event: '📅',
    custom: '⭐'
};

// 从 GitHub 加载倒计时数据
async function loadCountdownEvents() {
    try {
        const headers = { 'Accept': 'application/vnd.github.v3+json' };
        if (githubToken) headers['Authorization'] = `token ${githubToken}`;

        const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/events.json?ref=${CONFIG.branch}`, {
            headers: headers
        });

        if (res.ok) {
            const data = await res.json();
            const content = decodeGitHubContent(data.content);
            countdownEvents = JSON.parse(content);
            console.log(`加载倒计时事件：${countdownEvents.length}个`);
        } else if (res.status === 404) {
            // 文件不存在，创建空数组
            countdownEvents = [];
            console.log('倒计时文件不存在，将创建新文件');
        }
    } catch (e) {
        console.error('加载倒计时失败:', e);
        countdownEvents = [];
    }
}

// 保存倒计时数据到 GitHub
async function saveCountdownEvents() {
    try {
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        };
        if (githubToken) headers['Authorization'] = `token ${githubToken}`;

        // 先获取文件的 SHA
        let sha = null;
        const getRes = await fetch(`https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/events.json?ref=${CONFIG.branch}`, {
            headers: headers
        });

        if (getRes.ok) {
            const getData = await getRes.json();
            sha = getData.sha;
        }

        // 保存文件
        const content = btoa(unescape(encodeURIComponent(JSON.stringify(countdownEvents, null, 2))));
        const body = {
            message: '更新倒计时事件',
            content: content,
            branch: CONFIG.branch
        };
        if (sha) body.sha = sha;

        const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/events.json`, {
            method: 'PUT',
            headers: headers,
            body: JSON.stringify(body)
        });

        if (res.ok) {
            console.log('倒计时事件已保存');
            return true;
        } else {
            console.error('保存失败:', await res.text());
            return false;
        }
    } catch (e) {
        console.error('保存倒计时失败:', e);
        return false;
    }
}

// 渲染倒计时卡片
function renderCountdownCards() {
    const grid = document.getElementById('countdownGrid');
    const empty = document.getElementById('emptyCountdown');

    if (!grid || !empty) return;

    if (countdownEvents.length === 0) {
        grid.style.display = 'none';
        empty.style.display = 'block';
        renderNextCountdownCard(null);
        updateHomeOverview();
        return;
    }

    grid.style.display = 'grid';
    empty.style.display = 'none';

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const enriched = countdownEvents.map((event, index) => {
        const rawDate = new Date(event.date);
        rawDate.setHours(0, 0, 0, 0);

        let targetDate = new Date(rawDate);
        let daysDiff = Math.ceil((targetDate - now) / (1000 * 60 * 60 * 24));

        if (daysDiff < 0 && event.repeat) {
            targetDate = new Date(now.getFullYear(), rawDate.getMonth(), rawDate.getDate());
            if (targetDate < now) {
                targetDate = new Date(now.getFullYear() + 1, rawDate.getMonth(), rawDate.getDate());
            }
            daysDiff = Math.ceil((targetDate - now) / (1000 * 60 * 60 * 24));
        }

        const isToday = daysDiff === 0;
        const isPast = daysDiff < 0;
        const isUrgent = daysDiff >= 0 && daysDiff <= 7;
        const sortWeight = isPast ? 99999 + Math.abs(daysDiff) : daysDiff;
        const progress = isPast ? 100 : Math.max(0, Math.min(100, ((30 - daysDiff) / 30) * 100));
        const badgeText = isToday ? '今天' : (isPast ? '已过期' : (isUrgent ? '即将到来' : '未来计划'));
        const displayDate = targetDate.toLocaleDateString('zh-CN');
        const dayLabel = isToday ? '就是今天' : (isPast ? `已过 ${Math.abs(daysDiff)} 天` : `还剩 ${daysDiff} 天`);

        return {
            event,
            index,
            daysDiff,
            isToday,
            isPast,
            isUrgent,
            sortWeight,
            progress,
            badgeText,
            displayDate,
            dayLabel
        };
    }).sort((a, b) => a.sortWeight - b.sortWeight);

    const nearestUpcoming = enriched.find(item => !item.isPast) || null;
    renderNextCountdownCard(nearestUpcoming);

    grid.innerHTML = enriched.map((item) => `
        <div class="countdown-card ${item.isUrgent ? 'urgent' : ''} ${item.isToday ? 'today' : ''} ${item.isPast ? 'past' : ''}">
            <div class="countdown-head">
                <span class="countdown-icon">${typeIcons[item.event.type] || '⭐'}</span>
                <span class="countdown-badge">${item.badgeText}</span>
            </div>
            <div class="countdown-name">${escapeHtml(item.event.name)}</div>
            <div class="countdown-days-row">
                <span class="countdown-days-num">${item.isPast ? Math.abs(item.daysDiff) : item.daysDiff}</span>
                <span class="countdown-days-unit">天</span>
            </div>
            <div class="countdown-label">${item.dayLabel}</div>
            <div class="countdown-meta-row">
                <span>${escapeHtml(item.displayDate)}</span>
                <span>${item.event.repeat ? '每年重复' : '单次事件'}</span>
            </div>
            <div class="countdown-progress"><span style="width:${item.progress}%"></span></div>
            <div class="countdown-actions">
                <button class="countdown-action-btn edit" onclick="editCountdown(${item.index})">编辑</button>
                <button class="countdown-action-btn delete" onclick="deleteCountdown(${item.index})">删除</button>
            </div>
        </div>
    `).join('');
    updateHomeOverview();
}

function renderNextCountdownCard(nextItem) {
    const nameEl = document.getElementById('nextCountdownName');
    const metaEl = document.getElementById('nextCountdownMeta');
    if (!nameEl || !metaEl) return;

    if (!nextItem) {
        nameEl.textContent = '暂无安排';
        metaEl.textContent = '去「纪念日」频道添加一个重要日期吧';
        return;
    }

    const icon = typeIcons[nextItem.event.type] || '⭐';
    const repeatText = nextItem.event.repeat ? '每年重复' : '单次事件';
    const dateText = nextItem.displayDate || nextItem.event.date || '-';
    const dayText = nextItem.isToday ? '就是今天' : `还有 ${nextItem.daysDiff} 天`;
    nameEl.textContent = `${icon} ${nextItem.event.name}`;
    metaEl.textContent = `${dateText} · ${dayText} · ${repeatText}`;
}

// 显示/隐藏添加面板
function resetCountdownForm() {
    const nameEl = document.getElementById('countdownName');
    const dateEl = document.getElementById('countdownDate');
    const typeEl = document.getElementById('countdownType');
    const repeatEl = document.getElementById('countdownRepeat');
    const titleEl = document.querySelector('.add-countdown-panel .panel-header h3');
    const submitBtn = document.querySelector('#addCountdownPanel .submit-btn');

    if (nameEl) nameEl.value = '';
    if (dateEl) dateEl.value = '';
    if (typeEl) typeEl.value = 'birthday';
    if (repeatEl) repeatEl.checked = true;
    if (titleEl) titleEl.textContent = '添加重要日期';
    if (submitBtn) submitBtn.textContent = '添加日期';
}

function setCountdownPanelMode(mode) {
    const titleEl = document.querySelector('.add-countdown-panel .panel-header h3');
    const submitBtn = document.querySelector('#addCountdownPanel .submit-btn');
    const isEditing = mode === 'edit';

    if (titleEl) titleEl.textContent = isEditing ? '编辑重要日期' : '添加重要日期';
    if (submitBtn) submitBtn.textContent = isEditing ? '保存修改' : '添加日期';
}

function openCountdownPanel() {
    const panel = document.getElementById('addCountdownPanel');
    let overlay = document.getElementById('modalOverlay');
    if (!panel) return;

    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'modalOverlay';
        overlay.className = 'modal-overlay';
        overlay.onclick = toggleAddCountdownPanel;
        document.body.appendChild(overlay);
    }
    panel.style.display = 'block';
}

function closeCountdownPanel() {
    const panel = document.getElementById('addCountdownPanel');
    const overlay = document.getElementById('modalOverlay');
    if (panel) panel.style.display = 'none';
    if (overlay) overlay.remove();
    editingCountdownIndex = null;
    resetCountdownForm();
}

function toggleAddCountdownPanel() {
    const panel = document.getElementById('addCountdownPanel');
    if (!panel) return;

    if (panel.style.display === 'none' || !panel.style.display) {
        editingCountdownIndex = null;
        resetCountdownForm();
        setCountdownPanelMode('add');
        openCountdownPanel();
    } else {
        closeCountdownPanel();
    }
}

// 添加倒计时
async function addCountdown() {
    const name = document.getElementById('countdownName').value.trim();
    const date = document.getElementById('countdownDate').value;
    const type = document.getElementById('countdownType').value;
    const repeat = document.getElementById('countdownRepeat').checked;

    if (!name || !date) {
        alert('请填写完整信息');
        return;
    }

    const nowIso = new Date().toISOString();
    const isEditing = editingCountdownIndex !== null;
    const originalEvent = isEditing ? countdownEvents[editingCountdownIndex] : null;

    if (isEditing && !originalEvent) {
        alert('要编辑的日期不存在，请刷新后重试');
        closeCountdownPanel();
        return;
    }

    const eventPayload = {
        id: originalEvent?.id || Date.now(),
        name: name,
        date: date,
        type: type,
        repeat: repeat,
        createdAt: originalEvent?.createdAt || nowIso,
        updatedAt: nowIso
    };

    const previousEvents = [...countdownEvents];
    if (isEditing) {
        countdownEvents = countdownEvents.map((item, idx) => (
            idx === editingCountdownIndex ? { ...item, ...eventPayload } : item
        ));
    } else {
        countdownEvents = [...countdownEvents, eventPayload];
    }
    const savedEditingIndex = editingCountdownIndex;

    const success = await saveCountdownEvents();
    if (success) {
        renderCountdownCards();
        closeCountdownPanel();
        showStatus(isEditing ? '更新成功！' : '添加成功！', 'success');
    } else {
        countdownEvents = previousEvents;
        editingCountdownIndex = savedEditingIndex;
        alert('保存失败，请检查网络');
    }
}

// 编辑倒计时
function editCountdown(index) {
    const event = countdownEvents[index];
    if (!event) return;

    editingCountdownIndex = index;
    openCountdownPanel();
    setCountdownPanelMode('edit');
    document.getElementById('countdownName').value = event.name || '';
    document.getElementById('countdownDate').value = event.date || '';
    document.getElementById('countdownType').value = event.type || 'birthday';
    document.getElementById('countdownRepeat').checked = !!event.repeat;
}

// 删除倒计时
async function deleteCountdown(index) {
    if (!confirm('确定删除这个倒计时吗？')) return;

    const previousEvents = [...countdownEvents];
    countdownEvents.splice(index, 1);

    const success = await saveCountdownEvents();
    if (success) {
        renderCountdownCards();
        showStatus('删除成功', 'success');
    } else {
        countdownEvents = previousEvents;
        renderCountdownCards();
        alert('删除失败，请检查网络');
    }
}

// ========== 其他功能 ==========

function createFloatingHearts() {
    const container = document.getElementById('floatingHearts');
    if (!container) return;

    setInterval(() => {
        const heart = document.createElement('div');
        heart.className = 'heart';
        heart.textContent = ['💕', '💖', '💗', '💓', '💝'][Math.floor(Math.random() * 5)];
        heart.style.left = Math.random() * 100 + '%';
        heart.style.setProperty('--drift', `${Math.round((Math.random() - 0.5) * 60)}px`);
        heart.style.animationDuration = (Math.random() * 3 + 4) + 's';
        heart.style.opacity = Math.random() * 0.5 + 0.3;
        container.appendChild(heart);

        setTimeout(() => heart.remove(), 7000);
    }, 2000);
}

function initRomanticCursorEffect() {
    const container = document.getElementById('floatingHearts');
    if (!container || window.matchMedia('(pointer: coarse)').matches) return;

    let lastTime = 0;
    document.addEventListener('mousemove', (e) => {
        const now = performance.now();
        if (now - lastTime < 55) return;
        lastTime = now;

        const particle = document.createElement('span');
        particle.className = 'cursor-heart';
        particle.textContent = ['❤', '✦', '❥'][Math.floor(Math.random() * 3)];
        particle.style.left = `${e.clientX}px`;
        particle.style.top = `${e.clientY}px`;
        particle.style.setProperty('--mx', `${Math.round((Math.random() - 0.5) * 26)}px`);
        container.appendChild(particle);

        setTimeout(() => particle.remove(), 950);
    }, { passive: true });
}

async function typeText(el, text, speed = 74) {
    if (!el) return;
    el.classList.add('typed-caret');
    el.textContent = '';
    for (let i = 0; i < text.length; i++) {
        el.textContent += text[i];
        await new Promise(resolve => setTimeout(resolve, speed));
    }
    setTimeout(() => el.classList.remove('typed-caret'), 280);
}

async function runHeroTypewriter() {
    if (sessionStorage.getItem('heroTypewriterDone') === '1') return;
    const titleEl = document.getElementById('heroMainTitle');
    const quoteEl = document.getElementById('heroQuote');
    if (!titleEl || !quoteEl) return;
    const title = titleEl.dataset.typedText || titleEl.textContent || '';
    const quote = quoteEl.dataset.typedText || quoteEl.textContent || '';
    await typeText(titleEl, title, 68);
    await typeText(quoteEl, quote, 40);
    sessionStorage.setItem('heroTypewriterDone', '1');
}

function initSoftInteractionEnhancers() {
    initButtonRippleEffect();
    initClickLoveBurst();
}

function initButtonRippleEffect() {
    document.addEventListener('click', (e) => {
        const button = e.target.closest('.control-btn, .add-btn, .submit-btn, .browse-btn, .load-more-btn');
        if (!button) return;
        const rect = button.getBoundingClientRect();
        const ripple = document.createElement('span');
        ripple.className = 'btn-ripple';
        const size = Math.max(rect.width, rect.height) * 1.35;
        ripple.style.width = `${size}px`;
        ripple.style.height = `${size}px`;
        ripple.style.left = `${e.clientX - rect.left}px`;
        ripple.style.top = `${e.clientY - rect.top}px`;
        button.appendChild(ripple);
        setTimeout(() => ripple.remove(), 640);
    }, { passive: true });
}

function initClickLoveBurst() {
    const container = document.getElementById('floatingHearts');
    if (!container || window.matchMedia('(pointer: coarse)').matches) return;
    document.addEventListener('click', (e) => {
        for (let i = 0; i < 3; i++) {
            const particle = document.createElement('span');
            particle.className = 'cursor-heart burst';
            particle.textContent = ['❤', '❣', '✦'][Math.floor(Math.random() * 3)];
            particle.style.left = `${e.clientX + (Math.random() - 0.5) * 22}px`;
            particle.style.top = `${e.clientY + (Math.random() - 0.5) * 22}px`;
            particle.style.setProperty('--mx', `${Math.round((Math.random() - 0.5) * 36)}px`);
            container.appendChild(particle);
            setTimeout(() => particle.remove(), 760);
        }
    }, { passive: true });
}

function getWelcomePrefixByHour(date = new Date()) {
    const hour = date.getHours();
    if (hour < 6) return '夜深了';
    if (hour < 11) return '早安';
    if (hour < 14) return '中午好';
    if (hour < 18) return '下午好';
    return '晚上好';
}

function updateWelcomeMessage() {
    const welcomeUser = document.getElementById('welcomeUser');
    if (!welcomeUser) return;
    const prefix = getWelcomePrefixByHour();
    welcomeUser.textContent = currentUser ? `${prefix}，${currentUser}` : `${prefix}，宝贝`;
}

function randomPhoto() {
    const source = displayedPhotos.length ? displayedPhotos : [];
    if (!source.length) {
        showStatus(currentFilter.folder ? '当前相册暂无照片' : '请先选择一个相册', 'error');
        return;
    }
    const random = Math.floor(Math.random() * source.length);
    openLightboxByName(source[random].name);
}

function scrollToUpload() {
    if (typeof switchChannel === 'function') {
        switchChannel('gallery');
    }
    const uploadSection = document.getElementById('uploadSection');
    if (uploadSection) {
        uploadSection.scrollIntoView({ behavior: 'smooth' });
    }
}

// ========== 原有功能 ==========

function toggleMusicPlayer() {
    const player = document.getElementById('musicPlayer');
    const frame = document.getElementById('musicFrame');
    if (!frame) return;
    const isActive = frame.classList.toggle('active');
    if (player) {
        player.classList.toggle('playing', isActive);
        player.classList.toggle('expanded', isActive);
    }
}

function getNeteasePlayerUrl(songId) {
    return `https://music.163.com/outchain/player?type=0&id=${encodeURIComponent(songId)}&auto=0&height=430`;
}

function loadMusicSettings() {
    const saved = localStorage.getItem('musicSettings');
    if (!saved) return;
    try {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed.songId === 'string' && /^\d+$/.test(parsed.songId)) {
            musicSettings.songId = parsed.songId === PREVIOUS_DEFAULT_MUSIC_ID
                ? DEFAULT_MUSIC_ID
                : parsed.songId;
        }
    } catch (e) {
        console.warn('musicSettings 解析失败，使用默认值');
    }
}

function saveMusicSettings() {
    localStorage.setItem('musicSettings', JSON.stringify(musicSettings));
}

function buildMusicPresetOptions() {
    const options = [...NETEASE_PRESET_SONGS];
    if (!options.some(item => item.id === musicSettings.songId)) {
        options.unshift({ id: musicSettings.songId, name: `当前自定义歌单 (${musicSettings.songId})` });
    }
    return options;
}

function applyMusicSong(songId) {
    if (!/^\d+$/.test(songId)) {
        showStatus('歌单无效，请重新选择', 'error');
        return;
    }
    musicSettings.songId = songId;
    saveMusicSettings();

    const frame = document.getElementById('musicFrame');
    if (frame) {
        frame.src = getNeteasePlayerUrl(songId);
    }

    const presetSelect = document.getElementById('musicPresetSelect');
    if (presetSelect) {
        const options = buildMusicPresetOptions();
        presetSelect.innerHTML = options.map(item =>
            `<option value="${item.id}">${item.name}</option>`
        ).join('');
        presetSelect.value = songId;
    }

    const currentOption = buildMusicPresetOptions().find(item => item.id === songId);
    showStatus(`已切换到「${currentOption?.name || '网易云歌单'}」`, 'success');
}

function changeMusicPreset(songId) {
    if (!songId) return;
    applyMusicSong(songId);
}

function initMusicPlayer() {
    const frame = document.getElementById('musicFrame');
    const presetSelect = document.getElementById('musicPresetSelect');
    if (!frame || !presetSelect) return;

    frame.src = getNeteasePlayerUrl(musicSettings.songId);
    const options = buildMusicPresetOptions();
    presetSelect.innerHTML = options.map(item =>
        `<option value="${item.id}">${item.name}</option>`
    ).join('');
    presetSelect.value = musicSettings.songId;
}

function login() {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();
    const errorDiv = document.getElementById('loginError');

    if (!username || !password) {
        errorDiv.textContent = '请输入用户名和密码';
        errorDiv.style.display = 'block';
        return;
    }

    if (ACCOUNTS[username] === password) {
        currentUser = username;
        localStorage.setItem('galleryUser', username);
        showMainPage();
    } else {
        errorDiv.textContent = '用户名或密码错误';
        errorDiv.style.display = 'block';
    }
}

async function showMainPage() {
    const loginPage = document.getElementById('loginPage');
    const mainPage = document.getElementById('mainPage');
    const welcomeUser = document.getElementById('welcomeUser');
    if (loginPage) loginPage.style.display = 'none';
    if (mainPage) mainPage.classList.add('active');
    if (welcomeUser) updateWelcomeMessage();
    await loadPhotos();
}

function logout() {
    localStorage.removeItem('galleryUser');
    location.reload();
}

function setupDragDrop() {
    const dropZone = document.getElementById('dropZone');
    if (!dropZone) return;
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(e => {
        dropZone.addEventListener(e, ev => { ev.preventDefault(); ev.stopPropagation(); }, false);
    });
    ['dragenter', 'dragover'].forEach(e => {
        dropZone.addEventListener(e, () => dropZone.classList.add('dragover'), false);
    });
    ['dragleave', 'drop'].forEach(e => {
        dropZone.addEventListener(e, () => dropZone.classList.remove('dragover'), false);
    });
    dropZone.addEventListener('drop', e => handleFiles(e.dataTransfer.files, getSelectedUploadFolder()), false);
}

function getSelectedUploadFolder() {
    const customInput = document.getElementById('uploadFolderCustom');
    const selectedInput = document.getElementById('uploadFolderSelect');

    const custom = sanitizeFolderName(customInput?.value || '');
    if (custom) {
        return custom;
    }

    if (selectedInput?.value) {
        return selectedInput.value;
    }

    return '99-临时';
}

function syncUploadFolderOptions() {
    const uploadFolderSelect = document.getElementById('uploadFolderSelect');
    if (!uploadFolderSelect) return;

    const current = uploadFolderSelect.value || '99-临时';
    const existing = new Set(['99-临时']);
    folders.forEach(f => {
        if (f.id && f.id !== 'all' && f.id !== '故事胶片') existing.add(f.id);
    });

    const options = Array.from(existing);
    uploadFolderSelect.innerHTML = options
        .sort((a, b) => a.localeCompare(b, 'zh-CN'))
        .map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
        .join('');

    uploadFolderSelect.value = options.includes(current) ? current : '99-临时';
}

function showStatus(msg, type) {
    const s = document.getElementById('status');
    if (!s) return;
    if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
    }
    s.textContent = msg;
    s.className = 'status ' + type;
    if (type !== 'loading') {
        statusTimer = setTimeout(() => {
            s.className = 'status';
            statusTimer = null;
        }, 3000);
    }
}

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function updateProgress(current, total, filename) {
    const c = document.getElementById('progressContainer');
    const f = document.getElementById('progressFill');
    const t = document.getElementById('progressText');
    if (!c || !f || !t) return;
    const pct = total > 0 ? (current / total) * 100 : 0;
    c.classList.add('active');
    f.style.width = pct + '%';
    t.textContent = filename ? `上传中 ${filename} (${current}/${total})` : '';
    if (pct >= 100) setTimeout(() => c.classList.remove('active'), 1000);
}

async function handleFiles(fileList, folder = '99-临时') {
    const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
    if (!files.length) return;

    let success = 0;
    for (let i = 0; i < files.length; i++) {
        updateProgress(i + 1, files.length, files[i].name);
        try {
            await uploadFile(files[i], folder);
            success++;
        } catch (e) { console.error(e); }
    }
    updateProgress(files.length, files.length);
    showStatus(success > 0 ? `成功上传 ${success} 张照片` : '上传失败', success > 0 ? 'success' : 'error');
    if (success) {
        await clearCache();
        setTimeout(() => refreshPhotos(), 2000);
    }
    document.getElementById('fileInput').value = '';
}

async function uploadFile(file, folder = '未分类') {
    const safeFolder = sanitizeFolderName(folder) || '未分类';
    const safeName = sanitizeUploadFileName(file.name);
    const filename = `${safeFolder}/${Date.now()}_${safeName}`;
    const base64 = await new Promise(r => {
        const reader = new FileReader();
        reader.onload = e => r(e.target.result.split(',')[1]);
        reader.readAsDataURL(file);
    });

    const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/image/contents/${encodeGitHubPath(filename)}`, {
        method: 'PUT',
        headers: {
            'Authorization': `token ${githubToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify({
            message: `Upload ${file.name}`,
            content: base64,
            branch: CONFIG.branch
        })
    });

    if (!res.ok) throw new Error('Upload failed');
}

function getImageUrl(filename) {
    // 使用统一分支和 URL 编码，避免 main/master 不一致或中文路径问题
    const encodedPath = encodeURI(filename).replace(/%2F/g, '/');
    return `${CONFIG.cdnBase}/${encodedPath}`;
}

async function fetchFromServer() {
    const headers = { 'Accept': 'application/vnd.github.v3+json' };
    if (githubToken) headers['Authorization'] = `token ${githubToken}`;

    // 获取根目录
    const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/image/contents/?ref=${CONFIG.branch}`, {
        headers: headers
    });

    return res;
}

async function parseFilesAndFolders(files) {
    const photoList = [];
    const folderList = [];

    if (!Array.isArray(files)) return { photos: photoList, folders: folderList };

    // 识别文件夹
    const folderItems = files.filter(f => f.type === 'dir' && f.name !== '故事胶片');
    folderList.push({ id: 'all', name: '所有相册', count: 0 });

    // 处理每个文件夹
    for (const folder of folderItems) {
        try {
            const folderHeaders = { 'Accept': 'application/vnd.github.v3+json' };
            if (githubToken) folderHeaders['Authorization'] = `token ${githubToken}`;

            const folderRes = await fetch(folder.url, {
                headers: folderHeaders
            });

            if (folderRes.ok) {
                const folderFiles = await folderRes.json();
                const folderPhotos = folderFiles
                    .filter(f => f.type === 'file' && /\.(jpg|jpeg|png|gif|webp)$/i.test(f.name))
                    .map(f => ({
                        name: `${folder.name}/${f.name}`,
                        sha: f.sha,
                        size: f.size,
                        timestamp: parseInt(f.name.split('_')[0]) || Date.now(),
                        folder: folder.name
                    }));

                photoList.push(...folderPhotos);
                folderList.push({
                    id: folder.name,
                    name: folder.name,
                    count: folderPhotos.length
                });
            }
        } catch (e) {
            console.error(`加载文件夹 ${folder.name} 失败:`, e);
        }
    }

    photoList.sort((a, b) => b.timestamp - a.timestamp);

    // 更新总数
    const allFolder = folderList.find(f => f.id === 'all');
    if (allFolder) allFolder.count = photoList.length;

    return { photos: photoList, folders: folderList };
}

async function loadPhotos() {
    const gallery = document.getElementById('gallery');
    const empty = document.getElementById('emptyState');

    const cached = await getCachedPhotos();

    if (cached && cached.length > 0) {
        photos = normalizeGalleryPhotos(cached);
        folders = rebuildFoldersFromPhotos(photos);
        syncSharedState();
        updateStats();
        filterPhotos();
        renderStoryTimeline();
    } else {
        gallery.innerHTML = '<div class="skeleton" style="height:200px"></div>'.repeat(6);
    }

    try {
        const res = await fetchFromServer();

        if (!res.ok) {
            if (res.status === 404) {
                photos = [];
                folders = [{ id: 'all', name: '所有相册', count: 0 }];
                syncSharedState();
                gallery.innerHTML = '';
                empty.classList.add('active');
                document.getElementById('loadMore').style.display = 'none';
                updateStats();
                renderStoryTimeline();
                return;
            }
            throw new Error(`HTTP ${res.status}`);
        }

        const files = await res.json();
        const { photos: newPhotos, folders: newFolders } = await parseFilesAndFolders(files);

        const hasChanged = JSON.stringify(newPhotos) !== JSON.stringify(photos);

        if (hasChanged || photos.length === 0) {
            photos = newPhotos;
            folders = newFolders;
            syncSharedState();
            await cachePhotos(photos);
            updateStats();
            filterPhotos();
            renderStoryTimeline();
            showStatus(`已加载 ${photos.length} 张照片`, 'success');
        }

    } catch (e) {
        console.error('Load error:', e);
        if (!cached || cached.length === 0) {
            showStatus('加载失败，请检查网络', 'error');
        }
    }
}

function updateStats() {
    const photoCount = document.getElementById('photoCount');
    const folderCount = document.getElementById('folderCount');
    const storageUsed = document.getElementById('storageUsed');
    if (photoCount) photoCount.textContent = photos.length;
    if (folderCount) folderCount.textContent = folders.length > 0 ? folders.length - 1 : 0;
    if (storageUsed) storageUsed.textContent = calculateStorageUsage(photos);

    // 更新文件夹筛选器
    const folderFilter = document.getElementById('folderFilter');
    if (!folderFilter) return;
    const currentValue = folderFilter.value;
    const albumOptions = folders.filter(f => f.id !== 'all' && f.id !== '故事胶片');
    const hasCurrent = albumOptions.some(f => f.id === currentValue);
    const selectedValue = hasCurrent ? currentValue : '';
    currentFilter.folder = selectedValue;
    folderFilter.innerHTML = [
        `<option value="" ${selectedValue === '' ? 'selected' : ''}>请选择相册</option>`,
        ...albumOptions.map(f => `<option value="${escapeHtml(f.id)}" ${f.id === selectedValue ? 'selected' : ''}>${escapeHtml(f.name)} (${f.count})</option>`)
    ].join('');

    syncUploadFolderOptions();
    updateHomeOverview();
}

function calculateStorageUsage(photos) {
    const totalBytes = photos.reduce((sum, photo) => sum + photo.size, 0);
    const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);
    return `${totalMB} MB`;
}

function rebuildFoldersFromPhotos(photosList) {
    const folderMap = new Map();
    photosList.forEach(photo => {
        const folderName = photo.folder || '未分类';
        if (folderName === '故事胶片') return;
        folderMap.set(folderName, (folderMap.get(folderName) || 0) + 1);
    });

    const result = [{ id: 'all', name: '所有相册', count: photosList.length }];
    Array.from(folderMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))
        .forEach(([name, count]) => result.push({ id: name, name, count }));
    return result;
}

function normalizeGalleryPhotos(photosList) {
    return (Array.isArray(photosList) ? photosList : []).filter(photo => {
        const folderName = photo?.folder || (photo?.name?.split('/')?.[0] || '');
        return folderName !== '故事胶片';
    });
}

function filterPhotos() {
    currentFilter.folder = document.getElementById('folderFilter')?.value || '';
    currentFilter.time = document.getElementById('timeFilter')?.value || 'all';
    currentFilter.search = document.getElementById('searchInput')?.value?.toLowerCase() || '';

    if (!currentFilter.folder) {
        filteredPhotos = [];
        currentPage = 0;
        displayedPhotos = [];
        renderPhotos();
        return;
    }

    filteredPhotos = photos.filter(photo => {
        // 文件夹筛选
        if (photo.folder !== currentFilter.folder) {
            return false;
        }

        // 搜索筛选
        if (currentFilter.search && !photo.name.toLowerCase().includes(currentFilter.search)) {
            return false;
        }

        // 时间筛选
        const photoDate = new Date(photo.timestamp);
        const now = new Date();

        switch (currentFilter.time) {
            case 'today':
                const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                if (photoDate < today) return false;
                break;
            case 'week':
                const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                if (photoDate < weekAgo) return false;
                break;
            case 'month':
                const monthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
                if (photoDate < monthAgo) return false;
                break;
            case 'year':
                const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
                if (photoDate < yearAgo) return false;
                break;
        }

        return true;
    });

    currentPage = 0;
    displayedPhotos = [];
    renderPhotos();
}

function createPhotoCard(photo, idx = 0) {
    const actualIndex = photos.findIndex(p => p.name === photo.name);
    const name = photo.name.split('/').pop().replace(/^\d+_/, '');
    const safeName = escapeHtml(name);
    const date = photo.timestamp ? new Date(photo.timestamp).toLocaleString('zh-CN') : '-';
    const size = (photo.size / 1024).toFixed(1) + ' KB';

    const card = document.createElement('div');
    card.className = 'photo-card';
    card.style.animationDelay = `${idx * 0.05}s`;
    card.innerHTML = `
        <div class="photo-wrapper">
            <img data-src="${getImageUrl(photo.name)}" alt="${safeName}" loading="lazy">
            <div class="photo-overlay" onclick="event.stopPropagation()">
                <div class="photo-actions">
                    <button class="photo-action-btn" onclick="openLightboxByName('${escapeJsString(photo.name)}')" title="查看">👁</button>
                    <button class="photo-action-btn" onclick="setPhotoAsBackground(${actualIndex})" title="设为背景">🖼️</button>
                    <button class="photo-action-btn delete" onclick="deletePhoto('${escapeJsString(photo.name)}', '${photo.sha}')" title="删除">🗑</button>
                </div>
            </div>
        </div>
        <div class="photo-info">
            <div class="photo-name">${safeName}</div>
            <div class="photo-meta">
                <div>${date}</div>
                <div>${size}</div>
            </div>
        </div>
    `;
    card.onclick = () => openLightboxByName(photo.name);

    const img = card.querySelector('img');
    if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const target = entry.target;
                    target.src = target.dataset.src;
                    target.onload = () => target.classList.add('loaded');
                    observer.unobserve(target);
                }
            });
        }, { rootMargin: '50px' });
        observer.observe(img);
    } else {
        img.src = img.dataset.src;
        img.onload = () => img.classList.add('loaded');
    }

    return card;
}

function renderPhotos(append = false) {
    const gallery = document.getElementById('gallery');
    const empty = document.getElementById('emptyState');
    const loadMore = document.getElementById('loadMore');

    const photosToRender = filteredPhotos;

    if (!photosToRender.length) {
        const emptyText = empty?.querySelector('p');
        if (emptyText) {
            emptyText.textContent = currentFilter.folder ? '该相册暂无符合条件的照片' : '请先在上方选择一个相册';
        }
        if (empty) empty.classList.add('active');
        if (loadMore) loadMore.style.display = 'none';
        if (gallery) gallery.innerHTML = '';
        return;
    }

    if (empty) empty.classList.remove('active');
    if (!gallery) return;
    gallery.innerHTML = '';
    displayedPhotos = photosToRender;

    const grid = document.createElement('div');
    grid.className = 'gallery-grid';
    photosToRender.forEach((photo, idx) => {
        grid.appendChild(createPhotoCard(photo, idx));
    });
    gallery.appendChild(grid);

    if (loadMore) loadMore.style.display = 'none';
}

function setPhotoAsBackground(index) {
    const photo = photos[index];
    if (!photo) return;
    bgSettings.mode = 'custom';
    bgSettings.customPhoto = getImageUrl(photo.name);
    saveSettings();

    const bgSlideshow = document.getElementById('bgSlideshow');
    if (bgSlideshow) {
        bgSlideshow.innerHTML = `<div class="bg-slide active" style="background-image: url('${bgSettings.customPhoto}')"></div>`;
    }

    showStatus('已设为背景图片', 'success');
}

function loadMorePhotos() {
    renderPhotos(true);
}

function sanitizeFolderName(name) {
    return name
        .trim()
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/^\.+/, '')
        .replace(/\.$/, '');
}

function sanitizeUploadFileName(name) {
    return String(name || 'image.jpg')
        .trim()
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^\.+/, '')
        || 'image.jpg';
}

function escapeJsString(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function encodeGitHubPath(path) {
    return path.split('/').map(seg => encodeURIComponent(seg)).join('/');
}

async function createAlbum() {
    const input = prompt('请输入新相册名称：');
    if (!input) return;

    const folderName = sanitizeFolderName(input);
    if (!folderName) {
        alert('相册名称无效');
        return;
    }
    if (folderName === 'all' || folderName === '故事胶片') {
        alert('该名称不可用');
        return;
    }
    if (folders.some(f => f.id === folderName)) {
        alert('该相册已存在');
        return;
    }

    showStatus('创建相册中...', 'loading');
    try {
        const path = encodeGitHubPath(`${folderName}/.gitkeep`);
        const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/image/contents/${path}`, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${githubToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/vnd.github.v3+json'
            },
            body: JSON.stringify({
                message: `Create album ${folderName}`,
                content: btoa('album'),
                branch: CONFIG.branch
            })
        });
        if (!res.ok) throw new Error(await res.text());

        showStatus(`相册「${folderName}」已创建`, 'success');
        await refreshPhotos();
        const uploadFolderSelect = document.getElementById('uploadFolderSelect');
        if (uploadFolderSelect) uploadFolderSelect.value = folderName;
    } catch (e) {
        console.error(e);
        showStatus('创建相册失败', 'error');
    }
}

async function deleteCurrentAlbum() {
    const folderFilter = document.getElementById('folderFilter');
    const folderName = folderFilter?.value;

    if (!folderName) {
        alert('请先在筛选中选择要删除的相册');
        return;
    }

    if (!confirm(`确定删除相册「${folderName}」及其中所有照片吗？`)) return;

    showStatus('删除相册中...', 'loading');
    try {
        const listRes = await fetch(`https://api.github.com/repos/${CONFIG.owner}/image/contents/${encodeGitHubPath(folderName)}?ref=${CONFIG.branch}`, {
            headers: {
                'Authorization': `token ${githubToken}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        if (!listRes.ok) throw new Error(await listRes.text());

        const files = await listRes.json();
        const fileList = Array.isArray(files) ? files.filter(f => f.type === 'file') : [];

        for (const file of fileList) {
            const deleteRes = await fetch(`https://api.github.com/repos/${CONFIG.owner}/image/contents/${encodeGitHubPath(file.path)}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `token ${githubToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: `Delete ${file.path}`,
                    sha: file.sha,
                    branch: CONFIG.branch
                })
            });
            if (!deleteRes.ok) throw new Error(await deleteRes.text());
        }

        showStatus(`相册「${folderName}」已删除`, 'success');
        document.getElementById('folderFilter').value = '';
        await refreshPhotos();
        filterPhotos();
    } catch (e) {
        console.error(e);
        showStatus('删除相册失败', 'error');
    }
}

async function deletePhoto(filename, sha) {
    if (!confirm('确定删除这张照片吗？')) return;
    showStatus('删除中...', 'loading');
    try {
        const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/image/contents/${encodeGitHubPath(filename)}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `token ${githubToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: `Delete ${filename}`,
                sha: sha,
                branch: CONFIG.branch
            })
        });
        if (!res.ok) throw new Error('Delete failed');
        showStatus('删除成功', 'success');
        await clearCache();
        setTimeout(() => refreshPhotos(), 1000);
    } catch (e) {
        showStatus('删除失败', 'error');
        console.error(e);
    }
}

function openLightbox(index) {
    const photo = photos[index];
    if (!photo) return;
    currentLightboxIndex = Math.max(0, displayedPhotos.findIndex(item => item.name === photo.name));
    openLightboxPhoto(photo);
}

function openLightboxByName(photoName) {
    const photo = displayedPhotos.find(item => item.name === photoName) || photos.find(item => item.name === photoName);
    if (!photo) return;
    currentLightboxIndex = Math.max(0, displayedPhotos.findIndex(item => item.name === photo.name));
    openLightboxPhoto(photo);
}

function openLightboxPhoto(photo) {
    const lb = document.getElementById('lightbox');
    const img = document.getElementById('lightboxImg');
    const title = document.getElementById('lightboxTitle');
    const meta = document.getElementById('lightboxMeta');

    img.src = getImageUrl(photo.name);
    title.textContent = photo.name.split('/').pop().replace(/^\d+_/, '');

    const date = new Date(photo.timestamp).toLocaleString('zh-CN');
    const size = (photo.size / 1024).toFixed(1) + ' KB';

    meta.textContent = `${date} · ${size}`;

    lb.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeLightbox() {
    document.getElementById('lightbox').classList.remove('active');
    document.body.style.overflow = '';
}

function prevPhoto() {
    const source = displayedPhotos.length ? displayedPhotos : photos;
    if (!source.length) return;
    currentLightboxIndex = (currentLightboxIndex - 1 + source.length) % source.length;
    openLightboxPhoto(source[currentLightboxIndex]);
}

function nextPhoto() {
    const source = displayedPhotos.length ? displayedPhotos : photos;
    if (!source.length) return;
    currentLightboxIndex = (currentLightboxIndex + 1) % source.length;
    openLightboxPhoto(source[currentLightboxIndex]);
}

async function refreshPhotos() {
    await clearCache();
    currentPage = 0;
    displayedPhotos = [];
    await loadPhotos();
}

// 缓存操作
async function getCachedPhotos() {
    if (!db) return null;
    return new Promise((resolve) => {
        const tx = db.transaction('photos', 'readonly');
        const store = tx.objectStore('photos');
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
    });
}

async function cachePhotos(photosData) {
    if (!db) return;
    return new Promise((resolve) => {
        const tx = db.transaction('photos', 'readwrite');
        const store = tx.objectStore('photos');
        photosData.forEach(p => store.put(p));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
    });
}

async function clearCache() {
    if (!db) return;
    await Promise.all(['photos', 'folders'].map(storeName => new Promise((resolve) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
    })));
    showStatus('缓存已清空', 'success');
}

// 工具函数
function base64Decode(str) {
    try {
        return decodeURIComponent(atob(str).split('').map(c => {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
    } catch (e) {
        return str;
    }
}

function decodeGitHubContent(base64Content) {
    if (!base64Content) return '';
    try {
        return decodeURIComponent(escape(atob(base64Content)));
    } catch (e) {
        return atob(base64Content);
    }
}

// ========== 全局函数挂载 ==========
// 将所有需要通过 onclick 调用的函数挂载到 window 对象，确保全局可访问
(function() {
    window.toggleSettings = toggleSettings;
    window.toggleAddCountdownPanel = toggleAddCountdownPanel;
    window.toggleMusicPlayer = toggleMusicPlayer;
    window.changeMusicPreset = changeMusicPreset;
    window.addCountdown = addCountdown;
    window.editCountdown = editCountdown;
    window.deleteCountdown = deleteCountdown;
    window.setBackground = setBackground;
    window.updateBlur = updateBlur;
    window.updateDarkness = updateDarkness;
    window.updateAnniversary = updateAnniversary;
    window.switchChannel = switchChannel;
    window.updateHomeOverview = updateHomeOverview;
    window.showStatus = showStatus;
    window.refreshPhotos = refreshPhotos;
    window.clearCache = clearCache;
    window.getImageUrl = getImageUrl;
    window.encodeGitHubPath = encodeGitHubPath;
    window.scrollToUpload = scrollToUpload;
    window.randomPhoto = randomPhoto;
    window.filterPhotos = filterPhotos;
    window.loadMorePhotos = loadMorePhotos;
    window.openLightbox = openLightbox;
    window.openLightboxByName = openLightboxByName;
    window.closeLightbox = closeLightbox;
    window.prevPhoto = prevPhoto;
    window.nextPhoto = nextPhoto;
    window.setPhotoAsBackground = setPhotoAsBackground;
    window.deletePhoto = deletePhoto;
    window.handleFiles = handleFiles;
    window.uploadFile = uploadFile;
    window.createAlbum = createAlbum;
    window.deleteCurrentAlbum = deleteCurrentAlbum;
    window.login = login;
    window.logout = logout;
})();
