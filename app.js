// 账号配置
const ACCOUNTS = { 'yuge': '20250918', 'meimei': '20250918' };

// GitHub 配置
const CONFIG = {
    owner: 'xiaobubuya',
    repo: 'xiaobubuya.github.io',
    branch: 'main',
    imageRepo: 'image',
    cdnBase: 'https://cdn.jsdelivr.net/gh/xiaobubuya/image@main',
    rawBase: 'https://raw.githubusercontent.com/xiaobubuya/image@main',
    slideshowFolder: 'slideshow'  // 幻灯片专用目录
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

// 幻灯片状态
let slideshowInterval = null;
let isSlideshowPlaying = false;
let currentSlideIndex = 0;

// 背景设置
let bgSettings = {
    mode: 'default', // default, photo, gradient
    blur: 8,
    darkness: 30,
    photoIndex: 0
};

// IndexedDB 配置
const DB_NAME = 'GalleryDB';
const DB_VERSION = 5;
let db = null;

// 纪念日
let anniversaryDate = '2025-09-18';

// 初始化
init();

async function init() {
    await initDB();
    loadSettings();
    loadMusicSettings();
    loadAnniversary();
    loadSlideshowSettings();  // 加载幻灯片设置
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
        const fullscreenSlideshow = document.getElementById('fullscreenSlideshow');
        if (fullscreenSlideshow && fullscreenSlideshow.style.display === 'flex') {
            if (e.key === 'Escape') toggleFullscreenSlideshow();
            if (e.key === 'ArrowLeft') prevSlide();
            if (e.key === 'ArrowRight') nextSlide();
            if (e.key === ' ') {
                e.preventDefault();
                toggleSlideshow();
            }
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

    // 初始化幻灯片触摸滑动
    initSlideshowTouch();

    // 渲染倒计时卡片
    renderCountdownCards();
    renderFootprints();

    renderStoryTimeline();
    updateHomeOverview();
}

function setMainChannel(channel, persist = true) {
    currentMainChannel = channel;
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
}

function updateDarkness(value) {
    bgSettings.darkness = parseInt(value);
    saveSettings();
    applyBackgroundSettings();
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
        bgSlideshow.style.background = 'linear-gradient(135deg, #fff0f5 0%, #ffe4ec 50%, #ffd6e0 100%)';
        bgSlideshow.innerHTML = '';
    } else if (bgSettings.mode === 'gradient') {
        bgSlideshow.style.background = 'linear-gradient(135deg, #ff6b9d 0%, #ffc2d1 50%, #ffd6e0 100%)';
        bgSlideshow.innerHTML = '';
    } else if (bgSettings.mode === 'photo' && photos.length > 0) {
        startBackgroundSlideshow();
    }
}

function startBackgroundSlideshow() {
    const bgSlideshow = document.getElementById('bgSlideshow');
    if (!bgSlideshow || photos.length === 0) return;

    bgSlideshow.innerHTML = photos.map((p, i) => `
        <div class="bg-slide ${i === 0 ? 'active' : ''}" style="background-image: url('${getImageUrl(p.name)}')"></div>
    `).join('');

    let currentBg = 0;
    setInterval(() => {
        const slides = bgSlideshow.querySelectorAll('.bg-slide');
        slides[currentBg].classList.remove('active');
        currentBg = (currentBg + 1) % slides.length;
        slides[currentBg].classList.add('active');
    }, 10000);
}

// ========== 纪念日功能 ==========

function loadAnniversary() {
    const saved = localStorage.getItem('anniversaryDate');
    if (saved) {
        anniversaryDate = saved;
    }
    updateAnniversaryDisplay();
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

// ========== 幻灯片功能（从独立 slideshow/ 目录加载） ==========

let slideshowPhotos = [];  // 幻灯片专用照片列表

// 从 slideshow/ 目录加载幻灯片照片
async function loadSlideshowPhotos() {
    try {
        // 确保使用最新的配置
        CONFIG.slideshowFolder = slideshowSettings.folder;
        
        const headers = { 'Accept': 'application/vnd.github.v3+json' };
        if (githubToken) headers['Authorization'] = `token ${githubToken}`;

        console.log(`加载幻灯片目录：${CONFIG.slideshowFolder}`);

        // 获取 slideshow 目录
        const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/image/contents/${CONFIG.slideshowFolder}?ref=${CONFIG.branch}`, {
            headers: headers
        });

        if (res.ok) {
            const files = await res.json();
            if (Array.isArray(files)) {
                slideshowPhotos = files
                    .filter(f => f.type === 'file' && /\.(jpg|jpeg|png|gif|webp)$/i.test(f.name))
                    .map(f => ({
                        name: `${CONFIG.slideshowFolder}/${f.name}`,
                        sha: f.sha,
                        size: f.size,
                        timestamp: parseInt(f.name.split('_')[0]) || Date.now(),
                        folder: CONFIG.slideshowFolder
                    }))
                    .sort((a, b) => b.timestamp - a.timestamp);
                console.log(`幻灯片加载成功：${slideshowPhotos.length}张`);
            }
        } else {
            console.log(`幻灯片目录不存在或无权限：${CONFIG.slideshowFolder}`);
        }
    } catch (e) {
        console.error('加载幻灯片目录失败:', e);
    }
}

function initSlideshow() {
    // 优先使用 slideshow/ 目录的照片，如果没有则使用全部照片
    const sourcePhotos = slideshowPhotos.length > 0 ? slideshowPhotos : photos;
    
    if (sourcePhotos.length === 0) {
        // 显示空状态
        const container = document.getElementById('slideshowContainer');
        container.innerHTML = `
            <div class="slideshow-empty">
                <div class="slideshow-empty-icon">📷</div>
                <p>幻灯片目录暂无照片</p>
                <p style="font-size: 0.9rem; margin-top: 10px; opacity: 0.7;">请将照片上传到 ${CONFIG.slideshowFolder}/ 目录</p>
            </div>
        `;
        console.log('幻灯片初始化：无照片');
        return;
    }

    const slideshowImg = document.getElementById('slideshowImg');
    const slideshowDate = document.getElementById('slideshowDate');
    const slideshowText = document.getElementById('slideshowText');
    const slideshowDots = document.getElementById('slideshowDots');

    // 使用设置中的最大数量
    const displayCount = Math.min(sourcePhotos.length, slideshowSettings.maxCount);
    
    console.log(`幻灯片初始化：${sourcePhotos.length}张照片，显示${displayCount}张，自动播放=${slideshowSettings.autoPlay}`);
    
    // 创建导航点
    slideshowDots.innerHTML = Array.from({ length: displayCount }, (_, i) => `
        <div class="slideshow-dot ${i === 0 ? 'active' : ''}" onclick="goToSlide(${i})"></div>
    `).join('');

    // 显示第一张
    updateSlideshowSlide(0, sourcePhotos);

    // 自动播放（延迟一点启动，确保设置已加载）
    setTimeout(() => {
        if (slideshowSettings.autoPlay) {
            startSlideshow(sourcePhotos);
        }
    }, 1000);
}

function updateSlideshowSlide(index, sourcePhotos = null) {
    const photosToUse = sourcePhotos || (slideshowPhotos.length > 0 ? slideshowPhotos : photos);
    if (photosToUse.length === 0) return;

    currentSlideIndex = index;
    const photo = photosToUse[index];
    const slideshowImg = document.getElementById('slideshowImg');
    const slideshowDate = document.getElementById('slideshowDate');
    const slideshowText = document.getElementById('slideshowText');
    const container = document.getElementById('slideshowContainer');

    // 强制重绘，确保移动端立即响应
    container.style.display = 'none';
    container.offsetHeight; // 触发重绘
    container.style.display = '';

    // 立即更新图片
    slideshowImg.src = getImageUrl(photo.name);
    slideshowDate.textContent = photo.timestamp ?
        new Date(photo.timestamp).toLocaleDateString('zh-CN') : '';
    slideshowText.textContent = photo.name.split('/').pop().replace(/^\d+_/, '').replace(/\.[^/.]+$/, '');

    // 更新导航点
    document.querySelectorAll('.slideshow-dot').forEach((dot, i) => {
        dot.classList.toggle('active', i === index);
    });

    console.log(`切换到第 ${index + 1} 张：${photo.name}`);
}

function startSlideshow(sourcePhotos = null) {
    // 清除之前的定时器
    if (slideshowInterval) {
        clearInterval(slideshowInterval);
        slideshowInterval = null;
    }
    
    // 检查是否启用自动播放
    if (!slideshowSettings.autoPlay) {
        isSlideshowPlaying = false;
        return;
    }
    
    isSlideshowPlaying = true;

    const photosToUse = sourcePhotos || (slideshowPhotos.length > 0 ? slideshowPhotos : photos);
    if (photosToUse.length === 0) return;

    // 使用设置中的间隔时间（转换为毫秒）
    const intervalMs = slideshowSettings.interval * 1000;
    
    // 立即切换到下一张，然后开始定时
    setTimeout(() => {
        if (!slideshowSettings.autoPlay) return;
        const next = (currentSlideIndex + 1) % photosToUse.length;
        updateSlideshowSlide(next, photosToUse);
        
        // 启动定时器
        slideshowInterval = setInterval(() => {
            if (!slideshowSettings.autoPlay) {
                clearInterval(slideshowInterval);
                return;
            }
            const nextIndex = (currentSlideIndex + 1) % photosToUse.length;
            updateSlideshowSlide(nextIndex, photosToUse);
        }, intervalMs);
    }, intervalMs);
}

function stopSlideshow() {
    if (slideshowInterval) {
        clearInterval(slideshowInterval);
        slideshowInterval = null;
    }
    isSlideshowPlaying = false;
}

function toggleSlideshow() {
    if (isSlideshowPlaying) {
        stopSlideshow();
    } else {
        startSlideshow();
    }
}

function prevSlide() {
    const photosToUse = slideshowPhotos.length > 0 ? slideshowPhotos : photos;
    if (photosToUse.length === 0) return;
    
    stopSlideshow();
    const prev = (currentSlideIndex - 1 + photosToUse.length) % photosToUse.length;
    updateSlideshowSlide(prev, photosToUse);
    
    // 如果启用了自动播放，重新启动
    if (slideshowSettings.autoPlay) {
        startSlideshow(photosToUse);
    }
}

function nextSlide() {
    const photosToUse = slideshowPhotos.length > 0 ? slideshowPhotos : photos;
    if (photosToUse.length === 0) return;
    
    stopSlideshow();
    const next = (currentSlideIndex + 1) % photosToUse.length;
    updateSlideshowSlide(next, photosToUse);
    
    // 如果启用了自动播放，重新启动
    if (slideshowSettings.autoPlay) {
        startSlideshow(photosToUse);
    }
}

function goToSlide(index) {
    const photosToUse = slideshowPhotos.length > 0 ? slideshowPhotos : photos;
    if (photosToUse.length === 0) return;
    
    stopSlideshow();
    updateSlideshowSlide(index, photosToUse);
    
    // 如果启用了自动播放，重新启动
    if (slideshowSettings.autoPlay) {
        startSlideshow(photosToUse);
    }
}

// ========== 幻灯片触摸滑动支持 ==========

let touchStartX = 0;
let touchEndX = 0;

function initSlideshowTouch() {
    const container = document.getElementById('slideshowContainer');
    if (!container) return;

    // 触摸开始
    container.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    // 触摸结束
    container.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        handleSwipe();
    }, { passive: true });

    // 阻止默认滚动行为
    container.addEventListener('touchmove', (e) => {
        e.preventDefault();
    }, { passive: false });
}

function handleSwipe() {
    const threshold = 50; // 最小滑动距离
    const diff = touchStartX - touchEndX;

    if (Math.abs(diff) < threshold) {
        return; // 滑动距离太短，忽略
    }

    if (diff > 0) {
        // 向左滑动，下一张
        nextSlide();
    } else {
        // 向右滑动，上一张
        prevSlide();
    }
}

// ========== 重要日期倒计时功能 ==========

let countdownEvents = [];

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
            <div class="countdown-name">${item.event.name}</div>
            <div class="countdown-days-row">
                <span class="countdown-days-num">${item.isPast ? Math.abs(item.daysDiff) : item.daysDiff}</span>
                <span class="countdown-days-unit">天</span>
            </div>
            <div class="countdown-label">${item.dayLabel}</div>
            <div class="countdown-meta-row">
                <span>${item.displayDate}</span>
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
function toggleAddCountdownPanel() {
    const panel = document.getElementById('addCountdownPanel');
    const overlay = document.getElementById('modalOverlay');

    if (panel.style.display === 'none' || !panel.style.display) {
        // 创建遮罩层
        if (!overlay) {
            const newOverlay = document.createElement('div');
            newOverlay.id = 'modalOverlay';
            newOverlay.className = 'modal-overlay';
            newOverlay.onclick = toggleAddCountdownPanel;
            document.body.appendChild(newOverlay);
        }
        panel.style.display = 'block';
        // 清空表单
        document.getElementById('countdownName').value = '';
        document.getElementById('countdownDate').value = '';
        document.getElementById('countdownType').value = 'birthday';
        document.getElementById('countdownRepeat').checked = true;
    } else {
        panel.style.display = 'none';
        if (overlay) overlay.remove();
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

    const newEvent = {
        id: Date.now(),
        name: name,
        date: date,
        type: type,
        repeat: repeat,
        createdAt: new Date().toISOString()
    };

    countdownEvents.push(newEvent);

    const success = await saveCountdownEvents();
    if (success) {
        renderCountdownCards();
        toggleAddCountdownPanel();
        showStatus('添加成功！', 'success');
    } else {
        alert('保存失败，请检查网络');
    }
}

// 编辑倒计时
function editCountdown(index) {
    const event = countdownEvents[index];
    toggleAddCountdownPanel();
    document.getElementById('countdownName').value = event.name;
    document.getElementById('countdownDate').value = event.date;
    document.getElementById('countdownType').value = event.type;
    document.getElementById('countdownRepeat').checked = !!event.repeat;

    // 删除旧的，保存时添加新的
    countdownEvents.splice(index, 1);

    document.querySelector('.add-countdown-panel .panel-header h3').textContent = '✏️ 编辑重要日期';

    // 修改保存按钮行为
    const submitBtn = document.querySelector('#addCountdownPanel .submit-btn');
    if (!submitBtn) return;
    submitBtn.onclick = async () => {
        const name = document.getElementById('countdownName').value.trim();
        const date = document.getElementById('countdownDate').value;
        const type = document.getElementById('countdownType').value;
        const repeat = document.getElementById('countdownRepeat').checked;

        if (!name || !date) {
            alert('请填写完整信息');
            return;
        }

        const updatedEvent = {
            id: Date.now(),
            name: name,
            date: date,
            type: type,
            repeat: repeat,
            createdAt: event.createdAt
        };

        countdownEvents.push(updatedEvent);

        const success = await saveCountdownEvents();
        if (success) {
            renderCountdownCards();
            toggleAddCountdownPanel();
            document.querySelector('.add-countdown-panel .panel-header h3').textContent = '➕ 添加重要日期';
            submitBtn.onclick = addCountdown;
            showStatus('更新成功！', 'success');
        } else {
            alert('保存失败，请检查网络');
        }
    };
}

// 删除倒计时
async function deleteCountdown(index) {
    if (!confirm('确定删除这个倒计时吗？')) return;

    countdownEvents.splice(index, 1);

    const success = await saveCountdownEvents();
    if (success) {
        renderCountdownCards();
        showStatus('删除成功', 'success');
    } else {
        alert('删除失败，请检查网络');
    }
}

function toggleFullscreenSlideshow() {
    const fs = document.getElementById('fullscreenSlideshow');
    if (!fs) return;
    if (fs.style.display === 'flex') {
        fs.style.display = 'none';
        stopFullscreenSlideshow();
    } else {
        fs.style.display = 'flex';
        startFullscreenSlideshow();
    }
}

let fullscreenSlideshowInterval = null;
let fullscreenIndex = 0;

function startFullscreenSlideshow() {
    if (photos.length === 0) return;

    fullscreenIndex = 0;
    updateFullscreenSlide();

    fullscreenSlideshowInterval = setInterval(() => {
        fullscreenIndex = (fullscreenIndex + 1) % photos.length;
        updateFullscreenSlide();
    }, 5000);
}

function stopFullscreenSlideshow() {
    if (fullscreenSlideshowInterval) {
        clearInterval(fullscreenSlideshowInterval);
        fullscreenSlideshowInterval = null;
    }
}

function updateFullscreenSlide() {
    if (!photos[fullscreenIndex]) return;
    const photo = photos[fullscreenIndex];
    const fsImg = document.getElementById('fsImg');
    const fsCaption = document.getElementById('fsCaption');
    const fsProgress = document.getElementById('fsProgress');
    if (!fsImg || !fsCaption || !fsProgress) return;
    fsImg.src = getImageUrl(photo.name);
    fsCaption.textContent =
        `${photo.name.split('/').pop().replace(/^\d+_/, '')} · ${new Date(photo.timestamp).toLocaleDateString('zh-CN')}`;

    // 进度条
    const progress = ((fullscreenIndex + 1) / photos.length) * 100;
    fsProgress.style.width = progress + '%';
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
    if (photos.length === 0) return;
    const random = Math.floor(Math.random() * photos.length);
    openLightbox(random);
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
        showStatus('歌单 ID 无效，请输入纯数字', 'error');
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

    showStatus(`已切换网易云歌单 ID: ${songId}`, 'success');
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

    const custom = customInput?.value?.trim();
    if (custom) {
        return custom.replace(/\//g, '-');
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
        if (f.id && f.id !== 'all') existing.add(f.id);
    });

    const options = Array.from(existing);
    uploadFolderSelect.innerHTML = options
        .sort((a, b) => a.localeCompare(b, 'zh-CN'))
        .map(name => `<option value="${name}">${name}</option>`)
        .join('');

    uploadFolderSelect.value = options.includes(current) ? current : '99-临时';
}

function showStatus(msg, type) {
    const s = document.getElementById('status');
    if (!s) return;
    s.textContent = msg;
    s.className = 'status ' + type;
    if (type !== 'loading') setTimeout(() => s.className = 'status', 3000);
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
    const filename = `${folder}/${Date.now()}_${file.name}`;
    const base64 = await new Promise(r => {
        const reader = new FileReader();
        reader.onload = e => r(e.target.result.split(',')[1]);
        reader.readAsDataURL(file);
    });

    const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/image/contents/${filename}`, {
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
    const folderItems = files.filter(f => f.type === 'dir');
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
                    name: folder.name === '%E6%9C%AA%E5%88%86%E7%B1%BB' ? '未分类' : folder.name,
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

    // 同时加载幻灯片照片
    await loadSlideshowPhotos();

    const cached = await getCachedPhotos();

    if (cached && cached.length > 0) {
        photos = cached;
        folders = rebuildFoldersFromPhotos(photos);
        updateStats();
        filterPhotos();
        initSlideshow();
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
                gallery.innerHTML = '';
                empty.classList.add('active');
                document.getElementById('loadMore').style.display = 'none';
                updateStats();
                initSlideshow();
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
            await cachePhotos(photos);
            updateStats();
            filterPhotos();
            initSlideshow();
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
    const albumOptions = folders.filter(f => f.id !== 'all');
    const hasCurrent = albumOptions.some(f => f.id === currentValue);
    const selectedValue = hasCurrent ? currentValue : '';
    currentFilter.folder = selectedValue;
    folderFilter.innerHTML = [
        `<option value="" ${selectedValue === '' ? 'selected' : ''}>请选择相册</option>`,
        ...albumOptions.map(f => `<option value="${f.id}" ${f.id === selectedValue ? 'selected' : ''}>${f.name} (${f.count})</option>`)
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
        folderMap.set(folderName, (folderMap.get(folderName) || 0) + 1);
    });

    const result = [{ id: 'all', name: '所有相册', count: photosList.length }];
    Array.from(folderMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))
        .forEach(([name, count]) => result.push({ id: name, name, count }));
    return result;
}

function filterPhotos() {
    currentFilter.folder = document.getElementById('folderFilter').value;
    currentFilter.time = document.getElementById('timeFilter').value;
    currentFilter.search = document.getElementById('searchInput').value.toLowerCase();

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
    const date = photo.timestamp ? new Date(photo.timestamp).toLocaleString('zh-CN') : '-';
    const size = (photo.size / 1024).toFixed(1) + ' KB';

    const card = document.createElement('div');
    card.className = 'photo-card';
    card.style.animationDelay = `${idx * 0.05}s`;
    card.innerHTML = `
        <div class="photo-wrapper">
            <img data-src="${getImageUrl(photo.name)}" alt="${name}" loading="lazy">
            <div class="photo-overlay" onclick="event.stopPropagation()">
                <div class="photo-actions">
                    <button class="photo-action-btn" onclick="openLightbox(${actualIndex})" title="查看">👁</button>
                    <button class="photo-action-btn" onclick="setPhotoAsBackground(${actualIndex})" title="设为背景">🖼️</button>
                    <button class="photo-action-btn delete" onclick="deletePhoto('${photo.name}', '${photo.sha}')" title="删除">🗑</button>
                </div>
            </div>
        </div>
        <div class="photo-info">
            <div class="photo-name">${name}</div>
            <div class="photo-meta">
                <div>${date}</div>
                <div>${size}</div>
            </div>
        </div>
    `;
    card.onclick = () => openLightbox(actualIndex);

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
        empty.classList.add('active');
        loadMore.style.display = 'none';
        gallery.innerHTML = '';
        return;
    }

    empty.classList.remove('active');
    gallery.innerHTML = '';
    displayedPhotos = photosToRender;

    const grid = document.createElement('div');
    grid.className = 'gallery-grid';
    photosToRender.forEach((photo, idx) => {
        grid.appendChild(createPhotoCard(photo, idx));
    });
    gallery.appendChild(grid);

    loadMore.style.display = 'none';
}

function setPhotoAsBackground(index) {
    const photo = photos[index];
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
    if (folderName === 'all') {
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
        const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/image/contents/${filename}`, {
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
    currentLightboxIndex = index;
    const photo = photos[index];
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
    currentLightboxIndex = (currentLightboxIndex - 1 + photos.length) % photos.length;
    openLightbox(currentLightboxIndex);
}

function nextPhoto() {
    currentLightboxIndex = (currentLightboxIndex + 1) % photos.length;
    openLightbox(currentLightboxIndex);
}

async function refreshPhotos() {
    await clearCache();
    currentPage = 0;
    displayedPhotos = [];
    await loadPhotos();
    initSlideshow();
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
    const tx = db.transaction('photos', 'readwrite');
    const store = tx.objectStore('photos');
    photosData.forEach(p => store.put(p));
}

async function clearCache() {
    if (!db) return;
    const tx1 = db.transaction('photos', 'readwrite');
    tx1.objectStore('photos').clear();
    const tx2 = db.transaction('folders', 'readwrite');
    tx2.objectStore('folders').clear();
    showStatus('缓存已清空', 'success');
}

// ========== 幻灯片设置功能 ==========

// 幻灯片配置
let slideshowSettings = {
    interval: 5,           // 播放间隔（秒）
    transition: 'fade',    // 过渡效果：fade, slide, zoom
    folder: 'slideshow',   // 幻灯片目录
    maxCount: 10,          // 最大显示数量
    autoPlay: true         // 自动播放
};

// 加载幻灯片设置
function loadSlideshowSettings() {
    const saved = localStorage.getItem('slideshowSettings');
    if (saved) {
        slideshowSettings = { ...slideshowSettings, ...JSON.parse(saved) };
    }
    // 更新 UI 显示
    const intervalInput = document.getElementById('slideshowInterval');
    const intervalValue = document.getElementById('intervalValue');
    if (intervalInput) {
        intervalInput.value = slideshowSettings.interval;
        intervalValue.textContent = slideshowSettings.interval + '秒';
    }
    const transitionSelect = document.getElementById('transitionEffect');
    if (transitionSelect) {
        transitionSelect.value = slideshowSettings.transition;
    }
    const folderInput = document.getElementById('slideshowFolder');
    if (folderInput) {
        folderInput.value = slideshowSettings.folder;
    }
    const maxCountInput = document.getElementById('slideshowMaxCount');
    const maxCountValue = document.getElementById('maxCountValue');
    if (maxCountInput) {
        maxCountInput.value = slideshowSettings.maxCount;
        maxCountValue.textContent = slideshowSettings.maxCount + '张';
    }
    const autoPlayCheckbox = document.getElementById('slideshowAutoPlay');
    if (autoPlayCheckbox) {
        autoPlayCheckbox.checked = slideshowSettings.autoPlay;
    }
    // 更新 CONFIG
    CONFIG.slideshowFolder = slideshowSettings.folder;
}

// 保存幻灯片设置
function saveSlideshowSettings() {
    localStorage.setItem('slideshowSettings', JSON.stringify(slideshowSettings));
}

// 更新幻灯片间隔
function updateSlideshowInterval(value) {
    slideshowSettings.interval = parseInt(value);
    document.getElementById('intervalValue').textContent = value + '秒';
    saveSlideshowSettings();
    // 重新开始幻灯片
    stopSlideshow();
    if (slideshowSettings.autoPlay) {
        startSlideshow();
    }
    showStatus(`幻灯片间隔已更新为 ${value}秒`, 'success');
}

// 更新过渡效果
function updateTransitionEffect(value) {
    slideshowSettings.transition = value;
    saveSlideshowSettings();
    const container = document.getElementById('slideshowContainer');
    container.style.transition = value === 'fade' ? 'opacity 1s ease-in-out' : 
                                  value === 'slide' ? 'transform 0.8s ease-in-out, opacity 0.8s ease-in-out' :
                                  'transform 1s ease-in-out, opacity 1s ease-in-out';
    showStatus(`过渡效果已更新为 ${value === 'fade' ? '淡入淡出' : value === 'slide' ? '滑动' : '缩放'}`, 'success');
}

// 更新幻灯片目录
function updateSlideshowFolder(value) {
    slideshowSettings.folder = value.trim() || 'slideshow';
    saveSlideshowSettings();
    CONFIG.slideshowFolder = slideshowSettings.folder;
    showStatus(`幻灯片目录已更新为 ${slideshowSettings.folder}`, 'success');
}

// 更新最大显示数量
function updateSlideshowMaxCount(value) {
    slideshowSettings.maxCount = parseInt(value);
    document.getElementById('maxCountValue').textContent = value + '张';
    saveSlideshowSettings();
    initSlideshow();
    showStatus(`最大显示数量已更新为 ${value}张`, 'success');
}

// 更新自动播放
function updateSlideshowAutoPlay(value) {
    slideshowSettings.autoPlay = value;
    saveSlideshowSettings();
    if (value) {
        startSlideshow();
    } else {
        stopSlideshow();
    }
    showStatus(`自动播放已${value ? '开启' : '关闭'}`, 'success');
}

// 重新加载幻灯片
async function reloadSlideshowPhotos() {
    showStatus('正在重新加载幻灯片...', 'loading');
    await loadSlideshowPhotos();
    initSlideshow();
    showStatus(`幻灯片已更新，共 ${slideshowPhotos.length} 张照片`, 'success');
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
    window.toggleSlideshow = toggleSlideshow;
    window.addCountdown = addCountdown;
    window.editCountdown = editCountdown;
    window.deleteCountdown = deleteCountdown;
    window.setBackground = setBackground;
    window.updateBlur = updateBlur;
    window.updateDarkness = updateDarkness;
    window.updateAnniversary = updateAnniversary;
    window.switchChannel = switchChannel;
    window.updateHomeOverview = updateHomeOverview;
    window.scrollToUpload = scrollToUpload;
    window.randomPhoto = randomPhoto;
    window.filterPhotos = filterPhotos;
    window.loadMorePhotos = loadMorePhotos;
    window.openLightbox = openLightbox;
    window.closeLightbox = closeLightbox;
    window.prevPhoto = prevPhoto;
    window.nextPhoto = nextPhoto;
    window.setPhotoAsBackground = setPhotoAsBackground;
    window.deletePhoto = deletePhoto;
    window.handleFiles = handleFiles;
    window.uploadFile = uploadFile;
    window.prevSlide = prevSlide;
    window.nextSlide = nextSlide;
    window.goToSlide = goToSlide;
    window.toggleFullscreenSlideshow = toggleFullscreenSlideshow;
    window.reloadSlideshowPhotos = reloadSlideshowPhotos;
    window.updateSlideshowInterval = updateSlideshowInterval;
    window.updateTransitionEffect = updateTransitionEffect;
    window.updateSlideshowMaxCount = updateSlideshowMaxCount;
    window.updateSlideshowAutoPlay = updateSlideshowAutoPlay;
    window.createAlbum = createAlbum;
    window.deleteCurrentAlbum = deleteCurrentAlbum;
    window.login = login;
    window.logout = logout;
})();
