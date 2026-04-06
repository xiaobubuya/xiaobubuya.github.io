
// Base64 解码为 UTF-8 字符串
function base64ToUtf8(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
}

// UTF-8 字符串转 Base64
function utf8ToBase64(str) {
    const bytes = new TextEncoder('utf-8').encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// 全局变量（必须在函数之前声明）
let githubToken = null;
let photos = [];
let filteredPhotos = [];
let displayedPhotos = [];
let currentPage = 0;
const PHOTOS_PER_PAGE = 20;
let currentLightboxIndex = 0;
let folders = [];
let currentFilter = {
    folder: 'all',
    time: 'all',
    search: '',
    tag: 'all'
};
let slideshowInterval = null;
let isSlideshowPlaying = false;
let currentSlideIndex = 0;
let bgSettings = {
    mode: 'default',
    blur: 8,
    darkness: 30,
    photoIndex: 0
};
const DB_NAME = 'GalleryDB';
const DB_VERSION = 5;
let db = null;
let anniversaryDate = '2025-09-18';
let slideshowSettings = {
    interval: 5,
    transition: 'fade',
    folder: 'slideshow',
    maxCount: 10,
    autoPlay: true
};
let countdownEvents = [];
let wishes = [];
let currentWishFilter = 'all';
let map = null;
let locationMarkers = [];
let locations = [];
let lastLocationsHash = '';

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
githubToken = base64Decode(base64Decode(HARDCODED_TOKEN));

// 初始化
init();

async function init() {
    await initDB();
    loadSettings();
    loadAnniversary();
    loadSlideshowSettings();
    loadAchievements();
    await loadCountdownEvents();
    await loadWishes();

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
    document.getElementById('fileInput').addEventListener('change', e => handleFiles(e.target.files));

    // 键盘导航
    document.addEventListener('keydown', e => {
        if (document.getElementById('lightbox').classList.contains('active')) {
            if (e.key === 'Escape') closeLightbox();
            if (e.key === 'ArrowLeft') prevPhoto();
            if (e.key === 'ArrowRight') nextPhoto();
        }
        const fullscreenEl = document.getElementById('fullscreenSlideshow');
        if (fullscreenEl && fullscreenEl.style.display === 'flex') {
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

    // 初始化幻灯片触摸滑动
    initSlideshowTouch();

    // 渲染倒计时卡片
    renderCountdownCards();
    
    // 渲染成就卡片
    renderAchievements();
    
    // 渲染愿望卡片
    renderWishes();
    
    // 检查成就
    setTimeout(() => {
        checkAchievements(getAchievementData());
    }, 1000);
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
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function setBackground(mode) {
    bgSettings.mode = mode;
    saveSettings();
    applyBackgroundSettings();

    // 更新按钮状态
    document.querySelectorAll('.bg-option').forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');
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
    if (photos.length === 0) return;

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

    document.getElementById('daysTogether').textContent = diff;
    document.getElementById('daysTogether2').textContent = diff;
    document.getElementById('anniversaryDate').textContent = formatDate(start);
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
        const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/image/contents/${CONFIG.slideshowFolder}?ref=master`, {
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

    if (!slideshowImg || !container) return;

    // 强制重绘，确保移动端立即响应
    container.style.display = 'none';
    container.offsetHeight; // 触发重绘
    container.style.display = '';

    // 立即更新图片
    if (photo && photo.name) {
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

// ========== 成就系统 ==========

// 成就列表定义
const achievementDefinitions = [
    { id: 'first_photo', name: '第一张照片', desc: '上传第一张照片', icon: '📸', check: (data) => data.photoCount >= 1 },
    { id: 'ten_photos', name: '十全十美', desc: '上传 10 张照片', icon: '💯', check: (data) => data.photoCount >= 10 },
    { id: 'hundred_photos', name: '百张照片', desc: '上传 100 张照片', icon: '🖼️', check: (data) => data.photoCount >= 100 },
    { id: 'first_wish', name: '心怀憧憬', desc: '添加第一个愿望', icon: '🌟', check: (data) => data.wishCount >= 1 },
    { id: 'five_wishes', name: '五福临门', desc: '添加 5 个愿望', icon: '🎋', check: (data) => data.wishCount >= 5 },
    { id: 'first_complete', name: '梦想成真', desc: '完成第一个愿望', icon: '✨', check: (data) => data.completedWishes >= 1 },
    { id: 'ten_complete', name: '十全十美', desc: '完成 10 个愿望', icon: '🏆', check: (data) => data.completedWishes >= 10 },
    { id: 'first_event', name: '重要时刻', desc: '添加第一个重要日期', icon: '📅', check: (data) => data.eventCount >= 1 },
    { id: 'five_events', name: '五周年纪念', desc: '添加 5 个重要日期', icon: '🎊', check: (data) => data.eventCount >= 5 },
    { id: '100_days', name: '百日情侣', desc: '在一起 100 天', icon: '💕', check: (data) => data.daysTogether >= 100 },
    { id: '365_days', name: '周年快乐', desc: '在一起 365 天', icon: '🎉', check: (data) => data.daysTogether >= 365 },
    { id: 'slideshow', name: '精彩瞬间', desc: '设置幻灯片背景', icon: '🎬', check: (data) => data.hasSlideshowBg },
];

let unlockedAchievements = [];

// 加载成就数据
function loadAchievements() {
    const saved = localStorage.getItem('achievements');
    if (saved) {
        unlockedAchievements = JSON.parse(saved);
    }
}

// 保存成就数据
function saveAchievements() {
    localStorage.setItem('achievements', JSON.stringify(unlockedAchievements));
}

// 检查并解锁成就
function checkAchievements(data) {
    let newUnlock = false;
    
    achievementDefinitions.forEach(achievement => {
        if (!unlockedAchievements.includes(achievement.id)) {
            if (achievement.check(data)) {
                unlockedAchievements.push(achievement.id);
                newUnlock = true;
                console.log(`🎉 解锁成就：${achievement.name}`);
            }
        }
    });
    
    if (newUnlock) {
        saveAchievements();
        renderAchievements();
    }
}

// 渲染成就卡片
function renderAchievements() {
    const grid = document.getElementById('achievementsGrid');
    const unlockedCount = document.getElementById('unlockedCount');
    const progress = document.getElementById('achievementProgress');
    
    if (!grid) return;
    
    const total = achievementDefinitions.length;
    const unlocked = unlockedAchievements.length;
    
    if (unlockedCount) unlockedCount.textContent = unlocked;
    if (progress) progress.textContent = Math.round((unlocked / total) * 100) + '%';
    
    grid.innerHTML = achievementDefinitions.map(achievement => {
        const isUnlocked = unlockedAchievements.includes(achievement.id);
        return `
            <div class="achievement-card ${isUnlocked ? 'unlocked' : 'locked'}">
                <div class="achievement-icon">${achievement.icon}</div>
                <div class="achievement-name">${achievement.name}</div>
                <div class="achievement-desc">${achievement.desc}</div>
                <div class="achievement-progress">${isUnlocked ? '✅ 已解锁' : '🔒 未解锁'}</div>
            </div>
        `;
    }).join('');
}

// ========== 愿望清单功能 ==========

let wishes = [];
let currentWishFilter = 'all';

// 从 GitHub 加载愿望数据
async function loadWishes() {
    try {
        const headers = { 'Accept': 'application/vnd.github.v3+json' };
        if (githubToken) headers['Authorization'] = `token ${githubToken}`;

        const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/wishes.json?ref=${CONFIG.branch}`, {
            headers: headers
        });

        if (res.ok) {
            const data = await res.json();
            const content = base64ToUtf8(data.content);
            wishes = JSON.parse(content);
            console.log(`加载愿望：${wishes.length}个`);
        } else if (res.status === 404) {
            wishes = [];
        }
    } catch (e) {
        console.error('加载愿望失败:', e);
        wishes = [];
    }
}

// 保存愿望数据到 GitHub
async function saveWishes() {
    try {
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        };
        if (githubToken) headers['Authorization'] = `token ${githubToken}`;

        let sha = null;
        const getRes = await fetch(`https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/wishes.json?ref=${CONFIG.branch}`, {
            headers: headers
        });

        if (getRes.ok) {
            const getData = await getRes.json();
            sha = getData.sha;
        }

        const content = utf8ToBase64(JSON.stringify(wishes, null, 2));
        const body = {
            message: '更新愿望清单',
            content: content,
            branch: CONFIG.branch
        };
        if (sha) body.sha = sha;

        const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/wishes.json`, {
            method: 'PUT',
            headers: headers,
            body: JSON.stringify(body)
        });

        return res.ok;
    } catch (e) {
        console.error('保存愿望失败:', e);
        return false;
    }
}

// 图标映射
const wishIcons = {
    travel: '✈️',
    food: '🍳',
    gift: '🎁',
    experience: '🎭',
    skill: '📚',
    other: '⭐'
};

const categoryNames = {
    travel: '旅行',
    food: '美食',
    gift: '礼物',
    experience: '体验',
    skill: '技能',
    other: '其他'
};

// 渲染愿望卡片
function renderWishes() {
    const grid = document.getElementById('wishlistGrid');
    const empty = document.getElementById('emptyWishlist');
    const totalEl = document.getElementById('totalWishes');
    const completedEl = document.getElementById('completedWishes');
    const pendingEl = document.getElementById('pendingWishes');
    
    if (!grid || !empty) return;
    
    // 筛选
    let filteredWishes = wishes;
    if (currentWishFilter === 'pending') {
        filteredWishes = wishes.filter(w => !w.completed);
    } else if (currentWishFilter === 'completed') {
        filteredWishes = wishes.filter(w => w.completed);
    }
    
    // 统计
    const total = wishes.length;
    const completed = wishes.filter(w => w.completed).length;
    const pending = total - completed;
    
    if (totalEl) totalEl.textContent = total;
    if (completedEl) completedEl.textContent = completed;
    if (pendingEl) pendingEl.textContent = pending;
    
    if (total === 0) {
        grid.style.display = 'none';
        empty.style.display = 'block';
        return;
    }
    
    grid.style.display = 'grid';
    empty.style.display = 'none';
    
    const now = new Date();
    
    grid.innerHTML = filteredWishes.map((wish, index) => {
        const actualIndex = wishes.findIndex(w => w.id === wish.id);
        const isUrgent = wish.deadline && !wish.completed && new Date(wish.deadline) < new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const daysLeft = wish.deadline ? Math.ceil((new Date(wish.deadline) - now) / (1000 * 60 * 60 * 24)) : null;
        
        return `
            <div class="wish-card ${wish.completed ? 'completed' : ''} ${isUrgent ? 'urgent' : ''}">
                <div class="wish-header">
                    <span class="wish-category">${wishIcons[wish.category]} ${categoryNames[wish.category]}</span>
                    <span class="wish-priority ${wish.priority}">${wish.priority === 'normal' ? '普通' : wish.priority === 'important' ? '重要' : '紧急'}</span>
                </div>
                <div class="wish-content">${wish.completed ? '<s>' : ''}${wish.content}${wish.completed ? '</s>' : ''}</div>
                ${wish.deadline ? `<div class="wish-meta"><span class="wish-deadline">📅 ${wish.deadline} ${daysLeft !== null && daysLeft >= 0 ? '(还剩' + daysLeft + '天)' : ''}</span></div>` : ''}
                <div class="wish-actions">
                    <button class="wish-action-btn complete ${wish.completed ? 'completed' : ''}" onclick="toggleWishComplete(${actualIndex})" ${wish.completed ? 'disabled' : ''}>
                        ${wish.completed ? '✓ 已完成' : '○ 完成'}
                    </button>
                    <button class="wish-action-btn edit" onclick="editWish(${actualIndex})">编辑</button>
                    <button class="wish-action-btn delete" onclick="deleteWish(${actualIndex})">删除</button>
                </div>
            </div>
        `;
    }).join('');
}

// 显示/隐藏愿望面板
function toggleWishPanel() {
    const panel = document.getElementById('wishPanel');
    const overlay = document.getElementById('modalOverlay');
    
    if (panel.style.display === 'none' || !panel.style.display) {
        if (!overlay) {
            const newOverlay = document.createElement('div');
            newOverlay.id = 'modalOverlay';
            newOverlay.className = 'modal-overlay';
            newOverlay.onclick = toggleWishPanel;
            document.body.appendChild(newOverlay);
        }
        panel.style.display = 'block';
        // 清空表单
        document.getElementById('wishContent').value = '';
        document.getElementById('wishCategory').value = 'travel';
        document.getElementById('wishPriority').value = 'normal';
        document.getElementById('wishDeadline').value = '';
        document.getElementById('wishPanelTitle').textContent = '➕ 添加愿望';
    } else {
        panel.style.display = 'none';
        if (overlay) overlay.remove();
    }
}

// 保存愿望（添加或编辑）
async function saveWish() {
    const content = document.getElementById('wishContent').value.trim();
    const category = document.getElementById('wishCategory').value;
    const priority = document.getElementById('wishPriority').value;
    const deadline = document.getElementById('wishDeadline').value;
    
    if (!content) {
        alert('请填写愿望内容');
        return;
    }
    
    // 检查是否是编辑模式（通过面板标题判断）
    const isEdit = document.getElementById('wishPanelTitle').textContent.includes('编辑');
    
    if (isEdit) {
        // 编辑模式：更新当前编辑的愿望
        editingWishIndex = parseInt(editingWishIndex);
        if (!isNaN(editingWishIndex) && wishes[editingWishIndex]) {
            wishes[editingWishIndex].content = content;
            wishes[editingWishIndex].category = category;
            wishes[editingWishIndex].priority = priority;
            wishes[editingWishIndex].deadline = deadline;
            
            const success = await saveWishes();
            if (success) {
                renderWishes();
                toggleWishPanel();
                checkAchievements(getAchievementData());
                showStatus('更新成功！', 'success');
            } else {
                alert('保存失败，请检查网络');
            }
        }
    } else {
        // 添加模式
        const newWish = {
            id: Date.now(),
            content: content,
            category: category,
            priority: priority,
            deadline: deadline,
            completed: false,
            createdAt: new Date().toISOString()
        };
        
        wishes.push(newWish);
        
        const success = await saveWishes();
        if (success) {
            renderWishes();
            toggleWishPanel();
            checkAchievements(getAchievementData());
            showStatus('添加成功！', 'success');
        } else {
            alert('保存失败，请检查网络');
        }
    }
}

// 编辑愿望
let editingWishIndex = null;

function editWish(index) {
    const wish = wishes[index];
    editingWishIndex = index;
    
    document.getElementById('wishContent').value = wish.content;
    document.getElementById('wishCategory').value = wish.category;
    document.getElementById('wishPriority').value = wish.priority;
    document.getElementById('wishDeadline').value = wish.deadline || '';
    document.getElementById('wishPanelTitle').textContent = '✏️ 编辑愿望';
    
    toggleWishPanel();
}

// 切换完成状态
async function toggleWishComplete(index) {
    wishes[index].completed = !wishes[index].completed;
    if (wishes[index].completed) {
        wishes[index].completedAt = new Date().toISOString();
    } else {
        delete wishes[index].completedAt;
    }
    
    const success = await saveWishes();
    if (success) {
        renderWishes();
        checkAchievements(getAchievementData());
        showStatus(wishes[index].completed ? '恭喜完成愿望！🎉' : '已取消完成', 'success');
    }
}

// 删除愿望
async function deleteWish(index) {
    if (!confirm('确定删除这个愿望吗？')) return;
    
    wishes.splice(index, 1);
    
    const success = await saveWishes();
    if (success) {
        renderWishes();
        checkAchievements(getAchievementData());
        showStatus('删除成功', 'success');
    }
}

// 筛选愿望
function filterWishes(filter) {
    currentWishFilter = filter;
    
    // 更新按钮状态
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent === (filter === 'all' ? '全部' : filter === 'pending' ? '进行中' : '已完成'));
    });
    
    renderWishes();
}

// 获取成就检查数据
function getAchievementData() {
    const start = new Date(anniversaryDate);
    const now = new Date();
    const daysTogether = Math.floor((now - start) / (1000 * 60 * 60 * 24));
    
    return {
        photoCount: photos.length,
        wishCount: wishes.length,
        completedWishes: wishes.filter(w => w.completed).length,
        eventCount: countdownEvents.length,
        daysTogether: daysTogether,
        hasSlideshowBg: bgSettings.mode === 'photo' || bgSettings.mode === 'custom'
    };
}

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
            const content = base64ToUtf8(data.content);
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
        const content = utf8ToBase64(JSON.stringify(countdownEvents, null, 2));
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
        return;
    }

    grid.style.display = 'grid';
    empty.style.display = 'none';

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    grid.innerHTML = countdownEvents.map((event, index) => {
        const eventDate = new Date(event.date);
        eventDate.setHours(0, 0, 0, 0);

        let daysDiff = Math.ceil((eventDate - now) / (1000 * 60 * 60 * 24));

        // 如果是重复事件且已过期，计算明年的日期
        let isUrgent = false;
        if (daysDiff < 0 && event.repeat) {
            const nextYear = now.getFullYear() + 1;
            const nextDate = new Date(nextYear, eventDate.getMonth(), eventDate.getDate());
            daysDiff = Math.ceil((nextDate - now) / (1000 * 60 * 60 * 24));
        }

        isUrgent = daysDiff <= 7 && daysDiff >= 0;

        const daysText = daysDiff < 0 ? '已过' : `还剩 ${daysDiff} 天`;
        const label = daysDiff === 0 ? '🎉 就是今天！' : (daysDiff < 0 ? '已经过去' : '天');

        return `
            <div class="countdown-card ${isUrgent ? 'urgent' : ''}">
                <div class="countdown-icon">${typeIcons[event.type] || '⭐'}</div>
                <div class="countdown-name">${event.name}</div>
                <div class="countdown-days">${daysDiff < 0 ? Math.abs(daysDiff) : daysDiff}</div>
                <div class="countdown-label">${label}</div>
                <div class="countdown-date">${event.date}</div>
                <div class="countdown-actions">
                    <button class="countdown-action-btn edit" onclick="editCountdown(${index})">编辑</button>
                    <button class="countdown-action-btn delete" onclick="deleteCountdown(${index})">删除</button>
                </div>
            </div>
        `;
    }).join('');
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
    document.getElementById('countdownName').value = event.name;
    document.getElementById('countdownDate').value = event.date;
    document.getElementById('countdownType').value = event.type;
    document.getElementById('countdownRepeat').checked = event.repeat;

    // 删除旧的，保存时添加新的
    countdownEvents.splice(index, 1);

    toggleAddCountdownPanel();
    document.querySelector('.add-countdown-panel .panel-header h3').textContent = '✏️ 编辑重要日期';

    // 修改保存按钮行为
    const submitBtn = document.querySelector('.submit-btn');
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
    const photo = photos[fullscreenIndex];
    document.getElementById('fsImg').src = getImageUrl(photo.name);
    document.getElementById('fsCaption').textContent =
        `${photo.name.split('/').pop().replace(/^\d+_/, '')} · ${new Date(photo.timestamp).toLocaleDateString('zh-CN')}`;

    // 进度条
    const progress = ((fullscreenIndex + 1) / photos.length) * 100;
    document.getElementById('fsProgress').style.width = progress + '%';
}

// ========== 其他功能 ==========

function createFloatingHearts() {
    const container = document.getElementById('floatingHearts');

    setInterval(() => {
        const heart = document.createElement('div');
        heart.className = 'heart';
        heart.textContent = ['💕', '💖', '💗', '💓', '💝'][Math.floor(Math.random() * 5)];
        heart.style.left = Math.random() * 100 + '%';
        heart.style.animationDuration = (Math.random() * 3 + 4) + 's';
        heart.style.opacity = Math.random() * 0.5 + 0.3;
        container.appendChild(heart);

        setTimeout(() => heart.remove(), 7000);
    }, 2000);
}

function randomPhoto() {
    if (photos.length === 0) return;
    const random = Math.floor(Math.random() * photos.length);
    openLightbox(random);
}

function scrollToUpload() {
    document.getElementById('uploadSection').scrollIntoView({ behavior: 'smooth' });
}

// ========== 原有功能 ==========

function setupDragDrop() {
    const dropZone = document.getElementById('dropZone');
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(e => {
        dropZone.addEventListener(e, ev => { ev.preventDefault(); ev.stopPropagation(); }, false);
    });
    ['dragenter', 'dragover'].forEach(e => {
        dropZone.addEventListener(e, () => dropZone.classList.add('dragover'), false);
    });
    ['dragleave', 'drop'].forEach(e => {
        dropZone.addEventListener(e, () => dropZone.classList.remove('dragover'), false);
    });
    dropZone.addEventListener('drop', e => handleFiles(e.dataTransfer.files), false);
}

function showStatus(msg, type) {
    const s = document.getElementById('status');
    s.textContent = msg;
    s.className = 'status ' + type;
    if (type !== 'loading') setTimeout(() => s.className = 'status', 3000);
}

function updateProgress(current, total, filename) {
    const c = document.getElementById('progressContainer');
    const f = document.getElementById('progressFill');
    const t = document.getElementById('progressText');
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
            branch: 'master'
        })
    });

    if (!res.ok) throw new Error('Upload failed');
}

function getImageUrl(filename) {
    // 使用 jsDelivr CDN 加速图片加载
    // jsDelivr 是免费的全球 CDN，基于 GitHub 仓库
    return `https://cdn.jsdelivr.net/gh/xiaobubuya/image@master/${filename}`;
}

async function fetchFromServer() {
    const headers = { 'Accept': 'application/vnd.github.v3+json' };
    if (githubToken) headers['Authorization'] = `token ${githubToken}`;

    // 获取根目录
    const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/image/contents/?ref=master`, {
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
            const folderRes = await fetch(folder.url, {
                headers: { 'Accept': 'application/vnd.github.v3+json' }
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
        updateStats();
        filterPhotos();
        initSlideshow();
    } else {
        gallery.innerHTML = '<div class="skeleton" style="height:200px"></div>'.repeat(6);
    }

    try {
        const res = await fetchFromServer();

        if (!res.ok) {
            if (res.status === 404) {
                photos = [];
                gallery.innerHTML = '';
                empty.classList.add('active');
                document.getElementById('loadMore').style.display = 'none';
                updateStats();
                initSlideshow();
                return;
            }
            throw new Error(`HTTP ${res.status}`);
        }

        const files = await res.json();
        const { photos: newPhotos } = await parseFilesAndFolders(files);

        const hasChanged = JSON.stringify(newPhotos) !== JSON.stringify(photos);

        if (hasChanged || photos.length === 0) {
            photos = newPhotos;
            await cachePhotos(photos);
            updateStats();
            filterPhotos();
            initSlideshow();
            showStatus(`已加载 ${photos.length} 张照片`, 'success');
            // 检查照片相关成就
            checkAchievements(getAchievementData());
        }

    } catch (e) {
        console.error('Load error:', e);
        if (!cached || cached.length === 0) {
            showStatus('加载失败，请检查网络', 'error');
        }
    }
}

function updateStats() {
    document.getElementById('photoCount').textContent = photos.length;
    document.getElementById('folderCount').textContent = folders.length > 0 ? folders.length - 1 : 0;
    document.getElementById('storageUsed').textContent = calculateStorageUsage(photos);

    // 更新文件夹筛选器
    const folderFilter = document.getElementById('folderFilter');
    const currentValue = folderFilter.value;
    folderFilter.innerHTML = folders.map(f =>
        `<option value="${f.id}" ${f.id === currentValue ? 'selected' : ''}>${f.name} (${f.count})</option>`
    ).join('');
}

function calculateStorageUsage(photos) {
    const totalBytes = photos.reduce((sum, photo) => sum + photo.size, 0);
    const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);
    return `${totalMB} MB`;
}

function filterPhotos() {
    currentFilter.folder = document.getElementById('folderFilter').value;
    currentFilter.time = document.getElementById('timeFilter').value;
    currentFilter.search = document.getElementById('searchInput').value.toLowerCase();

    filteredPhotos = photos.filter(photo => {
        // 文件夹筛选
        if (currentFilter.folder !== 'all' && photo.folder !== currentFilter.folder) {
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

function renderPhotos(append = false) {
    const gallery = document.getElementById('gallery');
    const empty = document.getElementById('emptyState');
    const loadMore = document.getElementById('loadMore');

    const photosToRender = filteredPhotos.length > 0 ? filteredPhotos : photos;

    if (!photosToRender.length) {
        empty.classList.add('active');
        loadMore.style.display = 'none';
        if (!append) gallery.innerHTML = '';
        return;
    }

    empty.classList.remove('active');

    const start = append ? displayedPhotos.length : 0;
    const end = Math.min(start + PHOTOS_PER_PAGE, photosToRender.length);
    const pagePhotos = photosToRender.slice(start, end);

    if (!append) {
        gallery.innerHTML = '';
        displayedPhotos = [];
    }

    displayedPhotos = displayedPhotos.concat(pagePhotos);

    pagePhotos.forEach((p, idx) => {
        const actualIndex = photos.findIndex(photo => photo.name === p.name);
        const name = p.name.split('/').pop().replace(/^\d+_/, '');
        const date = p.timestamp ? new Date(p.timestamp).toLocaleString('zh-CN') : '-';
        const size = (p.size / 1024).toFixed(1) + ' KB';

        const card = document.createElement('div');
        card.className = 'photo-card';
        card.style.animationDelay = `${idx * 0.05}s`;
        card.innerHTML = `
            <div class="photo-wrapper">
                <img data-src="${getImageUrl(p.name)}" alt="${name}" loading="lazy">
                <div class="photo-overlay" onclick="event.stopPropagation()">
                    <div class="photo-actions">
                        <button class="photo-action-btn" onclick="openLightbox(${actualIndex})" title="查看">👁</button>
                        <button class="photo-action-btn" onclick="setPhotoAsBackground(${actualIndex})" title="设为背景">🖼️</button>
                        <button class="photo-action-btn delete" onclick="deletePhoto('${p.name}', '${p.sha}')" title="删除">🗑</button>
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
        gallery.appendChild(card);

        const img = card.querySelector('img');
        if ('IntersectionObserver' in window) {
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const img = entry.target;
                        img.src = img.dataset.src;
                        img.onload = () => img.classList.add('loaded');
                        observer.unobserve(img);
                    }
                });
            }, { rootMargin: '50px' });
            observer.observe(img);
        } else {
            img.src = img.dataset.src;
            img.onload = () => img.classList.add('loaded');
        }
    });

    if (end < photosToRender.length) {
        loadMore.style.display = 'block';
    } else {
        loadMore.style.display = 'none';
    }
}

function setPhotoAsBackground(index) {
    const photo = photos[index];
    bgSettings.mode = 'custom';
    bgSettings.customPhoto = getImageUrl(photo.name);
    saveSettings();

    const bgSlideshow = document.getElementById('bgSlideshow');
    bgSlideshow.innerHTML = `<div class="bg-slide active" style="background-image: url('${bgSettings.customPhoto}')"></div>`;

    showStatus('已设为背景图片', 'success');
}

function loadMorePhotos() {
    renderPhotos(true);
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
                branch: 'master'
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

}
