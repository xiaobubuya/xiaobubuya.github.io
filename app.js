
// Base64 瑙ｇ爜涓?UTF-8 瀛楃涓?
function base64ToUtf8(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
}

// UTF-8 瀛楃涓茶浆 Base64
function utf8ToBase64(str) {
    const bytes = new TextEncoder('utf-8').encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// 鍏ㄥ眬鍙橀噺锛堝繀椤诲湪鍑芥暟涔嬪墠澹版槑锛?
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

// GitHub 閰嶇疆
const CONFIG = {
    owner: 'xiaobubuya',
    repo: 'xiaobubuya.github.io',
    branch: 'main',
    imageRepo: 'image',
    cdnBase: 'https://cdn.jsdelivr.net/gh/xiaobubuya/image@main',
    rawBase: 'https://raw.githubusercontent.com/xiaobubuya/image@main',
    slideshowFolder: 'slideshow'  // 骞荤伅鐗囦笓鐢ㄧ洰褰?
};

// GitHub Token
const HARDCODED_TOKEN = 'WjJod1gzQnNWa3RrZURJM1pHb3dXa3BvWWxNNFZIUjVSM2t5U0dOalpWVmlSREZMZWt0bmJnPT0=';
githubToken = base64Decode(base64Decode(HARDCODED_TOKEN));

// 鍒濆鍖?
init();

async function init() {
    await initDB();
    loadSettings();
    loadAnniversary();
    loadSlideshowSettings();
    loadAchievements();
    await loadCountdownEvents();
    await loadWishes();

    // 鍔犺浇鐓х墖
    await loadPhotos();

    // 鍒濆鍖栨爣绛剧偣鍑讳簨浠?
    document.querySelectorAll('.tag-item').forEach(tag => {
        tag.addEventListener('click', function() {
            document.querySelectorAll('.tag-item').forEach(t => t.classList.remove('active'));
            this.classList.add('active');
            currentFilter.tag = this.dataset.tag;
            filterPhotos();
        });
    });

    // 鏂囦欢杈撳叆鐩戝惉
    document.getElementById('fileInput').addEventListener('change', e => handleFiles(e.target.files));

    // 閿洏瀵艰埅
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

    // 鎷栨嫿涓婁紶
    setupDragDrop();

    // 鍒涘缓婕傛诞鐖卞績
    createFloatingHearts();

    // 鍒濆鍖栧够鐏墖瑙︽懜婊戝姩
    initSlideshowTouch();

    // 娓叉煋鍊掕鏃跺崱鐗?
    renderCountdownCards();
    
    // 娓叉煋鎴愬氨鍗＄墖
    renderAchievements();
    
    // 娓叉煋鎰挎湜鍗＄墖
    renderWishes();
    
    // 妫€鏌ユ垚灏?
    setTimeout(() => {
        checkAchievements(getAchievementData());
    }, 1000);
}

// 鍒濆鍖?IndexedDB
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

// ========== 璁剧疆鍔熻兘 ==========

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

    // 鏇存柊鎸夐挳鐘舵€?
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

    // 搴旂敤妯＄硦鍜屾殫搴?
    bgSlideshow.style.filter = `blur(${bgSettings.blur}px)`;
    overlay.style.background = `rgba(255, 240, 245, ${bgSettings.darkness / 100})`;

    // 鏍规嵁妯″紡璁剧疆鑳屾櫙
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

// ========== 绾康鏃ュ姛鑳?==========

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
    return `${date.getFullYear()}骞?{date.getMonth() + 1}鏈?{date.getDate()}鏃;
}

// ========== 骞荤伅鐗囧姛鑳斤紙浠庣嫭绔?slideshow/ 鐩綍鍔犺浇锛?==========

let slideshowPhotos = [];  // 骞荤伅鐗囦笓鐢ㄧ収鐗囧垪琛?

// 浠?slideshow/ 鐩綍鍔犺浇骞荤伅鐗囩収鐗?
async function loadSlideshowPhotos() {
    try {
        // 纭繚浣跨敤鏈€鏂扮殑閰嶇疆
        CONFIG.slideshowFolder = slideshowSettings.folder;
        
        const headers = { 'Accept': 'application/vnd.github.v3+json' };
        if (githubToken) headers['Authorization'] = `token ${githubToken}`;

        console.log(`鍔犺浇骞荤伅鐗囩洰褰曪細${CONFIG.slideshowFolder}`);

        // 鑾峰彇 slideshow 鐩綍
        const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/image/contents/${CONFIG.slideshowFolder}?ref=main`, {
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
                console.log(`骞荤伅鐗囧姞杞芥垚鍔燂細${slideshowPhotos.length}寮燻);
            }
        } else {
            console.log(`骞荤伅鐗囩洰褰曚笉瀛樺湪鎴栨棤鏉冮檺锛?{CONFIG.slideshowFolder}`);
        }
    } catch (e) {
        console.error('鍔犺浇骞荤伅鐗囩洰褰曞け璐?', e);
    }
}

function initSlideshow() {
    // 浼樺厛浣跨敤 slideshow/ 鐩綍鐨勭収鐗囷紝濡傛灉娌℃湁鍒欎娇鐢ㄥ叏閮ㄧ収鐗?
    const sourcePhotos = slideshowPhotos.length > 0 ? slideshowPhotos : photos;
    
    if (sourcePhotos.length === 0) {
        // 鏄剧ず绌虹姸鎬?
        const container = document.getElementById('slideshowContainer');
        container.innerHTML = `
            <div class="slideshow-empty">
                <div class="slideshow-empty-icon">馃摲</div>
                <p>骞荤伅鐗囩洰褰曟殏鏃犵収鐗?/p>
                <p style="font-size: 0.9rem; margin-top: 10px; opacity: 0.7;">璇峰皢鐓х墖涓婁紶鍒?${CONFIG.slideshowFolder}/ 鐩綍</p>
            </div>
        `;
        console.log('骞荤伅鐗囧垵濮嬪寲锛氭棤鐓х墖');
        return;
    }

    const slideshowImg = document.getElementById('slideshowImg');
    const slideshowDate = document.getElementById('slideshowDate');
    const slideshowText = document.getElementById('slideshowText');
    const slideshowDots = document.getElementById('slideshowDots');

    // 浣跨敤璁剧疆涓殑鏈€澶ф暟閲?
    const displayCount = Math.min(sourcePhotos.length, slideshowSettings.maxCount);
    
    console.log(`骞荤伅鐗囧垵濮嬪寲锛?{sourcePhotos.length}寮犵収鐗囷紝鏄剧ず${displayCount}寮狅紝鑷姩鎾斁=${slideshowSettings.autoPlay}`);
    
    // 鍒涘缓瀵艰埅鐐?
    slideshowDots.innerHTML = Array.from({ length: displayCount }, (_, i) => `
        <div class="slideshow-dot ${i === 0 ? 'active' : ''}" onclick="goToSlide(${i})"></div>
    `).join('');

    // 鏄剧ず绗竴寮?
    updateSlideshowSlide(0, sourcePhotos);

    // 鑷姩鎾斁锛堝欢杩熶竴鐐瑰惎鍔紝纭繚璁剧疆宸插姞杞斤級
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

    // 寮哄埗閲嶇粯锛岀‘淇濈Щ鍔ㄧ绔嬪嵆鍝嶅簲
    container.style.display = 'none';
    container.offsetHeight; // 瑙﹀彂閲嶇粯
    container.style.display = '';

    // 绔嬪嵆鏇存柊鍥剧墖
    if (photo && photo.name) {
        slideshowImg.src = getImageUrl(photo.name);
    slideshowDate.textContent = photo.timestamp ?
        new Date(photo.timestamp).toLocaleDateString('zh-CN') : '';
    slideshowText.textContent = photo.name.split('/').pop().replace(/^\d+_/, '').replace(/\.[^/.]+$/, '');

    // 鏇存柊瀵艰埅鐐?
    document.querySelectorAll('.slideshow-dot').forEach((dot, i) => {
        dot.classList.toggle('active', i === index);
    });

    console.log(`鍒囨崲鍒扮 ${index + 1} 寮狅細${photo.name}`);
}

function startSlideshow(sourcePhotos = null) {
    // 娓呴櫎涔嬪墠鐨勫畾鏃跺櫒
    if (slideshowInterval) {
        clearInterval(slideshowInterval);
        slideshowInterval = null;
    }
    
    // 妫€鏌ユ槸鍚﹀惎鐢ㄨ嚜鍔ㄦ挱鏀?
    if (!slideshowSettings.autoPlay) {
        isSlideshowPlaying = false;
        return;
    }
    
    isSlideshowPlaying = true;

    const photosToUse = sourcePhotos || (slideshowPhotos.length > 0 ? slideshowPhotos : photos);
    if (photosToUse.length === 0) return;

    // 浣跨敤璁剧疆涓殑闂撮殧鏃堕棿锛堣浆鎹负姣锛?
    const intervalMs = slideshowSettings.interval * 1000;
    
    // 绔嬪嵆鍒囨崲鍒颁笅涓€寮狅紝鐒跺悗寮€濮嬪畾鏃?
    setTimeout(() => {
        if (!slideshowSettings.autoPlay) return;
        const next = (currentSlideIndex + 1) % photosToUse.length;
        updateSlideshowSlide(next, photosToUse);
        
        // 鍚姩瀹氭椂鍣?
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
    
    // 濡傛灉鍚敤浜嗚嚜鍔ㄦ挱鏀撅紝閲嶆柊鍚姩
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
    
    // 濡傛灉鍚敤浜嗚嚜鍔ㄦ挱鏀撅紝閲嶆柊鍚姩
    if (slideshowSettings.autoPlay) {
        startSlideshow(photosToUse);
    }
}

function goToSlide(index) {
    const photosToUse = slideshowPhotos.length > 0 ? slideshowPhotos : photos;
    if (photosToUse.length === 0) return;
    
    stopSlideshow();
    updateSlideshowSlide(index, photosToUse);
    
    // 濡傛灉鍚敤浜嗚嚜鍔ㄦ挱鏀撅紝閲嶆柊鍚姩
    if (slideshowSettings.autoPlay) {
        startSlideshow(photosToUse);
    }
}

// ========== 骞荤伅鐗囪Е鎽告粦鍔ㄦ敮鎸?==========

let touchStartX = 0;
let touchEndX = 0;

function initSlideshowTouch() {
    const container = document.getElementById('slideshowContainer');
    if (!container) return;

    // 瑙︽懜寮€濮?
    container.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    // 瑙︽懜缁撴潫
    container.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        handleSwipe();
    }, { passive: true });

    // 闃绘榛樿婊氬姩琛屼负
    container.addEventListener('touchmove', (e) => {
        e.preventDefault();
    }, { passive: false });
}

function handleSwipe() {
    const threshold = 50; // 鏈€灏忔粦鍔ㄨ窛绂?
    const diff = touchStartX - touchEndX;

    if (Math.abs(diff) < threshold) {
        return; // 婊戝姩璺濈澶煭锛屽拷鐣?
    }

    if (diff > 0) {
        // 鍚戝乏婊戝姩锛屼笅涓€寮?
        nextSlide();
    } else {
        // 鍚戝彸婊戝姩锛屼笂涓€寮?
        prevSlide();
    }
}

// ========== 閲嶈鏃ユ湡鍊掕鏃跺姛鑳?==========

let countdownEvents = [];

// ========== 鎴愬氨绯荤粺 ==========

// 鎴愬氨鍒楄〃瀹氫箟
const achievementDefinitions = [
    { id: 'first_photo', name: '绗竴寮犵収鐗?, desc: '涓婁紶绗竴寮犵収鐗?, icon: '馃摳', check: (data) => data.photoCount >= 1 },
    { id: 'ten_photos', name: '鍗佸叏鍗佺編', desc: '涓婁紶 10 寮犵収鐗?, icon: '馃挴', check: (data) => data.photoCount >= 10 },
    { id: 'hundred_photos', name: '鐧惧紶鐓х墖', desc: '涓婁紶 100 寮犵収鐗?, icon: '馃柤锔?, check: (data) => data.photoCount >= 100 },
    { id: 'first_wish', name: '蹇冩€€鎲ф啲', desc: '娣诲姞绗竴涓効鏈?, icon: '馃専', check: (data) => data.wishCount >= 1 },
    { id: 'five_wishes', name: '浜旂涓撮棬', desc: '娣诲姞 5 涓効鏈?, icon: '馃帇', check: (data) => data.wishCount >= 5 },
    { id: 'first_complete', name: '姊︽兂鎴愮湡', desc: '瀹屾垚绗竴涓効鏈?, icon: '鉁?, check: (data) => data.completedWishes >= 1 },
    { id: 'ten_complete', name: '鍗佸叏鍗佺編', desc: '瀹屾垚 10 涓効鏈?, icon: '馃弳', check: (data) => data.completedWishes >= 10 },
    { id: 'first_event', name: '閲嶈鏃跺埢', desc: '娣诲姞绗竴涓噸瑕佹棩鏈?, icon: '馃搮', check: (data) => data.eventCount >= 1 },
    { id: 'five_events', name: '浜斿懆骞寸邯蹇?, desc: '娣诲姞 5 涓噸瑕佹棩鏈?, icon: '馃帄', check: (data) => data.eventCount >= 5 },
    { id: '100_days', name: '鐧炬棩鎯呬荆', desc: '鍦ㄤ竴璧?100 澶?, icon: '馃挄', check: (data) => data.daysTogether >= 100 },
    { id: '365_days', name: '鍛ㄥ勾蹇箰', desc: '鍦ㄤ竴璧?365 澶?, icon: '馃帀', check: (data) => data.daysTogether >= 365 },
    { id: 'slideshow', name: '绮惧僵鐬棿', desc: '璁剧疆骞荤伅鐗囪儗鏅?, icon: '馃幀', check: (data) => data.hasSlideshowBg },
];

let unlockedAchievements = [];

// 鍔犺浇鎴愬氨鏁版嵁
function loadAchievements() {
    const saved = localStorage.getItem('achievements');
    if (saved) {
        unlockedAchievements = JSON.parse(saved);
    }
}

// 淇濆瓨鎴愬氨鏁版嵁
function saveAchievements() {
    localStorage.setItem('achievements', JSON.stringify(unlockedAchievements));
}

// 妫€鏌ュ苟瑙ｉ攣鎴愬氨
function checkAchievements(data) {
    let newUnlock = false;
    
    achievementDefinitions.forEach(achievement => {
        if (!unlockedAchievements.includes(achievement.id)) {
            if (achievement.check(data)) {
                unlockedAchievements.push(achievement.id);
                newUnlock = true;
                console.log(`馃帀 瑙ｉ攣鎴愬氨锛?{achievement.name}`);
            }
        }
    });
    
    if (newUnlock) {
        saveAchievements();
        renderAchievements();
    }
}

// 娓叉煋鎴愬氨鍗＄墖
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
                <div class="achievement-progress">${isUnlocked ? '鉁?宸茶В閿? : '馃敀 鏈В閿?}</div>
            </div>
        `;
    }).join('');
}

// ========== 鎰挎湜娓呭崟鍔熻兘 ==========

let wishes = [];
let currentWishFilter = 'all';

// 浠?GitHub 鍔犺浇鎰挎湜鏁版嵁
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
            console.log(`鍔犺浇鎰挎湜锛?{wishes.length}涓猔);
        } else if (res.status === 404) {
            wishes = [];
        }
    } catch (e) {
        console.error('鍔犺浇鎰挎湜澶辫触:', e);
        wishes = [];
    }
}

// 淇濆瓨鎰挎湜鏁版嵁鍒?GitHub
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
            message: '鏇存柊鎰挎湜娓呭崟',
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
        console.error('淇濆瓨鎰挎湜澶辫触:', e);
        return false;
    }
}

// 鍥炬爣鏄犲皠
const wishIcons = {
    travel: '鉁堬笍',
    food: '馃嵆',
    gift: '馃巵',
    experience: '馃幁',
    skill: '馃摎',
    other: '猸?
};

const categoryNames = {
    travel: '鏃呰',
    food: '缇庨',
    gift: '绀肩墿',
    experience: '浣撻獙',
    skill: '鎶€鑳?,
    other: '鍏朵粬'
};

// 娓叉煋鎰挎湜鍗＄墖
function renderWishes() {
    const grid = document.getElementById('wishlistGrid');
    const empty = document.getElementById('emptyWishlist');
    const totalEl = document.getElementById('totalWishes');
    const completedEl = document.getElementById('completedWishes');
    const pendingEl = document.getElementById('pendingWishes');
    
    if (!grid || !empty) return;
    
    // 绛涢€?
    let filteredWishes = wishes;
    if (currentWishFilter === 'pending') {
        filteredWishes = wishes.filter(w => !w.completed);
    } else if (currentWishFilter === 'completed') {
        filteredWishes = wishes.filter(w => w.completed);
    }
    
    // 缁熻
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
                    <span class="wish-priority ${wish.priority}">${wish.priority === 'normal' ? '鏅€? : wish.priority === 'important' ? '閲嶈' : '绱ф€?}</span>
                </div>
                <div class="wish-content">${wish.completed ? '<s>' : ''}${wish.content}${wish.completed ? '</s>' : ''}</div>
                ${wish.deadline ? `<div class="wish-meta"><span class="wish-deadline">馃搮 ${wish.deadline} ${daysLeft !== null && daysLeft >= 0 ? '(杩樺墿' + daysLeft + '澶?' : ''}</span></div>` : ''}
                <div class="wish-actions">
                    <button class="wish-action-btn complete ${wish.completed ? 'completed' : ''}" onclick="toggleWishComplete(${actualIndex})" ${wish.completed ? 'disabled' : ''}>
                        ${wish.completed ? '鉁?宸插畬鎴? : '鈼?瀹屾垚'}
                    </button>
                    <button class="wish-action-btn edit" onclick="editWish(${actualIndex})">缂栬緫</button>
                    <button class="wish-action-btn delete" onclick="deleteWish(${actualIndex})">鍒犻櫎</button>
                </div>
            </div>
        `;
    }).join('');
}

// 鏄剧ず/闅愯棌鎰挎湜闈㈡澘
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
        // 娓呯┖琛ㄥ崟
        document.getElementById('wishContent').value = '';
        document.getElementById('wishCategory').value = 'travel';
        document.getElementById('wishPriority').value = 'normal';
        document.getElementById('wishDeadline').value = '';
        document.getElementById('wishPanelTitle').textContent = '鉃?娣诲姞鎰挎湜';
    } else {
        panel.style.display = 'none';
        if (overlay) overlay.remove();
    }
}

// 淇濆瓨鎰挎湜锛堟坊鍔犳垨缂栬緫锛?
async function saveWish() {
    const content = document.getElementById('wishContent').value.trim();
    const category = document.getElementById('wishCategory').value;
    const priority = document.getElementById('wishPriority').value;
    const deadline = document.getElementById('wishDeadline').value;
    
    if (!content) {
        alert('璇峰～鍐欐効鏈涘唴瀹?);
        return;
    }
    
    // 妫€鏌ユ槸鍚︽槸缂栬緫妯″紡锛堥€氳繃闈㈡澘鏍囬鍒ゆ柇锛?
    const isEdit = document.getElementById('wishPanelTitle').textContent.includes('缂栬緫');
    
    if (isEdit) {
        // 缂栬緫妯″紡锛氭洿鏂板綋鍓嶇紪杈戠殑鎰挎湜
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
                showStatus('鏇存柊鎴愬姛锛?, 'success');
            } else {
                alert('淇濆瓨澶辫触锛岃妫€鏌ョ綉缁?);
            }
        }
    } else {
        // 娣诲姞妯″紡
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
            showStatus('娣诲姞鎴愬姛锛?, 'success');
        } else {
            alert('淇濆瓨澶辫触锛岃妫€鏌ョ綉缁?);
        }
    }
}

// 缂栬緫鎰挎湜
let editingWishIndex = null;

function editWish(index) {
    const wish = wishes[index];
    editingWishIndex = index;
    
    document.getElementById('wishContent').value = wish.content;
    document.getElementById('wishCategory').value = wish.category;
    document.getElementById('wishPriority').value = wish.priority;
    document.getElementById('wishDeadline').value = wish.deadline || '';
    document.getElementById('wishPanelTitle').textContent = '鉁忥笍 缂栬緫鎰挎湜';
    
    toggleWishPanel();
}

// 鍒囨崲瀹屾垚鐘舵€?
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
        showStatus(wishes[index].completed ? '鎭枩瀹屾垚鎰挎湜锛侌煄? : '宸插彇娑堝畬鎴?, 'success');
    }
}

// 鍒犻櫎鎰挎湜
async function deleteWish(index) {
    if (!confirm('纭畾鍒犻櫎杩欎釜鎰挎湜鍚楋紵')) return;
    
    wishes.splice(index, 1);
    
    const success = await saveWishes();
    if (success) {
        renderWishes();
        checkAchievements(getAchievementData());
        showStatus('鍒犻櫎鎴愬姛', 'success');
    }
}

// 绛涢€夋効鏈?
function filterWishes(filter) {
    currentWishFilter = filter;
    
    // 鏇存柊鎸夐挳鐘舵€?
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent === (filter === 'all' ? '鍏ㄩ儴' : filter === 'pending' ? '杩涜涓? : '宸插畬鎴?));
    });
    
    renderWishes();
}

// 鑾峰彇鎴愬氨妫€鏌ユ暟鎹?
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

// 鍥炬爣鏄犲皠
const typeIcons = {
    birthday: '馃巶',
    anniversary: '馃挄',
    travel: '鉁堬笍',
    event: '馃搮',
    custom: '猸?
};

// 浠?GitHub 鍔犺浇鍊掕鏃舵暟鎹?
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
            console.log(`鍔犺浇鍊掕鏃朵簨浠讹細${countdownEvents.length}涓猔);
        } else if (res.status === 404) {
            // 鏂囦欢涓嶅瓨鍦紝鍒涘缓绌烘暟缁?
            countdownEvents = [];
            console.log('鍊掕鏃舵枃浠朵笉瀛樺湪锛屽皢鍒涘缓鏂版枃浠?);
        }
    } catch (e) {
        console.error('鍔犺浇鍊掕鏃跺け璐?', e);
        countdownEvents = [];
    }
}

// 淇濆瓨鍊掕鏃舵暟鎹埌 GitHub
async function saveCountdownEvents() {
    try {
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        };
        if (githubToken) headers['Authorization'] = `token ${githubToken}`;

        // 鍏堣幏鍙栨枃浠剁殑 SHA
        let sha = null;
        const getRes = await fetch(`https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/events.json?ref=${CONFIG.branch}`, {
            headers: headers
        });

        if (getRes.ok) {
            const getData = await getRes.json();
            sha = getData.sha;
        }

        // 淇濆瓨鏂囦欢
        const content = utf8ToBase64(JSON.stringify(countdownEvents, null, 2));
        const body = {
            message: '鏇存柊鍊掕鏃朵簨浠?,
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
            console.log('鍊掕鏃朵簨浠跺凡淇濆瓨');
            return true;
        } else {
            console.error('淇濆瓨澶辫触:', await res.text());
            return false;
        }
    } catch (e) {
        console.error('淇濆瓨鍊掕鏃跺け璐?', e);
        return false;
    }
}

// 娓叉煋鍊掕鏃跺崱鐗?
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

        // 濡傛灉鏄噸澶嶄簨浠朵笖宸茶繃鏈燂紝璁＄畻鏄庡勾鐨勬棩鏈?
        let isUrgent = false;
        if (daysDiff < 0 && event.repeat) {
            const nextYear = now.getFullYear() + 1;
            const nextDate = new Date(nextYear, eventDate.getMonth(), eventDate.getDate());
            daysDiff = Math.ceil((nextDate - now) / (1000 * 60 * 60 * 24));
        }

        isUrgent = daysDiff <= 7 && daysDiff >= 0;

        const daysText = daysDiff < 0 ? '宸茶繃' : `杩樺墿 ${daysDiff} 澶ー;
        const label = daysDiff === 0 ? '馃帀 灏辨槸浠婂ぉ锛? : (daysDiff < 0 ? '宸茬粡杩囧幓' : '澶?);

        return `
            <div class="countdown-card ${isUrgent ? 'urgent' : ''}">
                <div class="countdown-icon">${typeIcons[event.type] || '猸?}</div>
                <div class="countdown-name">${event.name}</div>
                <div class="countdown-days">${daysDiff < 0 ? Math.abs(daysDiff) : daysDiff}</div>
                <div class="countdown-label">${label}</div>
                <div class="countdown-date">${event.date}</div>
                <div class="countdown-actions">
                    <button class="countdown-action-btn edit" onclick="editCountdown(${index})">缂栬緫</button>
                    <button class="countdown-action-btn delete" onclick="deleteCountdown(${index})">鍒犻櫎</button>
                </div>
            </div>
        `;
    }).join('');
}

// 鏄剧ず/闅愯棌娣诲姞闈㈡澘
function toggleAddCountdownPanel() {
    const panel = document.getElementById('addCountdownPanel');
    const overlay = document.getElementById('modalOverlay');

    if (panel.style.display === 'none' || !panel.style.display) {
        // 鍒涘缓閬僵灞?
        if (!overlay) {
            const newOverlay = document.createElement('div');
            newOverlay.id = 'modalOverlay';
            newOverlay.className = 'modal-overlay';
            newOverlay.onclick = toggleAddCountdownPanel;
            document.body.appendChild(newOverlay);
        }
        panel.style.display = 'block';
        // 娓呯┖琛ㄥ崟
        document.getElementById('countdownName').value = '';
        document.getElementById('countdownDate').value = '';
        document.getElementById('countdownType').value = 'birthday';
        document.getElementById('countdownRepeat').checked = true;
    } else {
        panel.style.display = 'none';
        if (overlay) overlay.remove();
    }
}

// 娣诲姞鍊掕鏃?
async function addCountdown() {
    const name = document.getElementById('countdownName').value.trim();
    const date = document.getElementById('countdownDate').value;
    const type = document.getElementById('countdownType').value;
    const repeat = document.getElementById('countdownRepeat').checked;

    if (!name || !date) {
        alert('璇峰～鍐欏畬鏁翠俊鎭?);
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
        showStatus('娣诲姞鎴愬姛锛?, 'success');
    } else {
        alert('淇濆瓨澶辫触锛岃妫€鏌ョ綉缁?);
    }
}

// 缂栬緫鍊掕鏃?
function editCountdown(index) {
    const event = countdownEvents[index];
    document.getElementById('countdownName').value = event.name;
    document.getElementById('countdownDate').value = event.date;
    document.getElementById('countdownType').value = event.type;
    document.getElementById('countdownRepeat').checked = event.repeat;

    // 鍒犻櫎鏃х殑锛屼繚瀛樻椂娣诲姞鏂扮殑
    countdownEvents.splice(index, 1);

    toggleAddCountdownPanel();
    document.querySelector('.add-countdown-panel .panel-header h3').textContent = '鉁忥笍 缂栬緫閲嶈鏃ユ湡';

    // 淇敼淇濆瓨鎸夐挳琛屼负
    const submitBtn = document.querySelector('.submit-btn');
    submitBtn.onclick = async () => {
        const name = document.getElementById('countdownName').value.trim();
        const date = document.getElementById('countdownDate').value;
        const type = document.getElementById('countdownType').value;
        const repeat = document.getElementById('countdownRepeat').checked;

        if (!name || !date) {
            alert('璇峰～鍐欏畬鏁翠俊鎭?);
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
            document.querySelector('.add-countdown-panel .panel-header h3').textContent = '鉃?娣诲姞閲嶈鏃ユ湡';
            submitBtn.onclick = addCountdown;
            showStatus('鏇存柊鎴愬姛锛?, 'success');
        } else {
            alert('淇濆瓨澶辫触锛岃妫€鏌ョ綉缁?);
        }
    };
}

// 鍒犻櫎鍊掕鏃?
async function deleteCountdown(index) {
    if (!confirm('纭畾鍒犻櫎杩欎釜鍊掕鏃跺悧锛?)) return;

    countdownEvents.splice(index, 1);

    const success = await saveCountdownEvents();
    if (success) {
        renderCountdownCards();
        showStatus('鍒犻櫎鎴愬姛', 'success');
    } else {
        alert('鍒犻櫎澶辫触锛岃妫€鏌ョ綉缁?);
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
        `${photo.name.split('/').pop().replace(/^\d+_/, '')} 路 ${new Date(photo.timestamp).toLocaleDateString('zh-CN')}`;

    // 杩涘害鏉?
    const progress = ((fullscreenIndex + 1) / photos.length) * 100;
    document.getElementById('fsProgress').style.width = progress + '%';
}

// ========== 鍏朵粬鍔熻兘 ==========

function createFloatingHearts() {
    const container = document.getElementById('floatingHearts');

    setInterval(() => {
        const heart = document.createElement('div');
        heart.className = 'heart';
        heart.textContent = ['馃挄', '馃挅', '馃挆', '馃挀', '馃挐'][Math.floor(Math.random() * 5)];
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

// ========== 鍘熸湁鍔熻兘 ==========

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
    t.textContent = filename ? `涓婁紶涓?${filename} (${current}/${total})` : '';
    if (pct >= 100) setTimeout(() => c.classList.remove('active'), 1000);
}

async function handleFiles(fileList, folder = '99-涓存椂') {
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
    showStatus(success > 0 ? `鎴愬姛涓婁紶 ${success} 寮犵収鐗嘸 : '涓婁紶澶辫触', success > 0 ? 'success' : 'error');
    if (success) {
        await clearCache();
        setTimeout(() => refreshPhotos(), 2000);
    }
    document.getElementById('fileInput').value = '';
}

async function uploadFile(file, folder = '鏈垎绫?) {
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
    // 浣跨敤 jsDelivr CDN 鍔犻€熷浘鐗囧姞杞?
    // jsDelivr 鏄厤璐圭殑鍏ㄧ悆 CDN锛屽熀浜?GitHub 浠撳簱
    return `https://cdn.jsdelivr.net/gh/xiaobubuya/image@main/${filename}`;
}

async function fetchFromServer() {
    const headers = { 'Accept': 'application/vnd.github.v3+json' };
    if (githubToken) headers['Authorization'] = `token ${githubToken}`;

    // 鑾峰彇鏍圭洰褰?
    const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/image/contents/?ref=main`, {
        headers: headers
    });

    return res;
}

async function parseFilesAndFolders(files) {
    const photoList = [];
    const folderList = [];

    if (!Array.isArray(files)) return { photos: photoList, folders: folderList };

    // 璇嗗埆鏂囦欢澶?
    const folderItems = files.filter(f => f.type === 'dir');
    folderList.push({ id: 'all', name: '鎵€鏈夌浉鍐?, count: 0 });

    // 澶勭悊姣忎釜鏂囦欢澶?
    for (const folder of folderItems) {
        try {
            // 浣跨敤 folder.url 骞舵坊鍔??ref=main 鍙傛暟纭繚鑾峰彇姝ｇ‘鍒嗘敮
            const folderUrl = folder.url.includes('?') ? `${folder.url}&ref=main` : `${folder.url}?ref=main`;
            const folderRes = await fetch(folderUrl, {
                headers: { 'Accept': 'application/vnd.github.v3+json' }
            });

            if (folderRes.ok) {
                const folderFiles = await folderRes.json();
                const folderPhotos = folderFiles
                    .filter(f => f.type === 'file' && /\.(jpg|jpeg|png|gif|webp)$/i.test(f.name))
                    .map(f => ({
                        name: `${folder.path}/${f.name}`,
                        sha: f.sha,
                        size: f.size,
                        timestamp: parseInt(f.name.split('_')[0]) || Date.now(),
                        folder: folder.name
                    }));

                photoList.push(...folderPhotos);
                folderList.push({
                    id: folder.name,
                    name: folder.name === '%E6%9C%AA%E5%88%86%E7%B1%BB' ? '鏈垎绫? : folder.name,
                    count: folderPhotos.length
                });
            } else {
                console.error(`鍔犺浇鏂囦欢澶?${folder.name} 澶辫触锛欻TTP ${folderRes.status}`);
            }
        } catch (e) {
            console.error(`鍔犺浇鏂囦欢澶?${folder.name} 寮傚父:`, e);
        }
    }

    photoList.sort((a, b) => b.timestamp - a.timestamp);

    // 鏇存柊鎬绘暟
    const allFolder = folderList.find(f => f.id === 'all');
    if (allFolder) allFolder.count = photoList.length;

    return { photos: photoList, folders: folderList };
}

async function loadPhotos() {
    const gallery = document.getElementById('gallery');
    const empty = document.getElementById('emptyState');

    console.log('寮€濮嬪姞杞界収鐗?..');

    // 鍚屾椂鍔犺浇骞荤伅鐗囩収鐗?
    await loadSlideshowPhotos();

    const cached = await getCachedPhotos();
    console.log('缂撳瓨鐓х墖鏁伴噺:', cached ? cached.length : 0);

    if (cached && cached.length > 0) {
        console.log('浣跨敤缂撳瓨鐓х墖');
        photos = cached;
        updateStats();
        filterPhotos();
        initSlideshow();
    } else {
        console.log('鏃犵紦瀛橈紝鏄剧ず楠ㄦ灦灞?);
        gallery.innerHTML = '<div class="skeleton" style="height:200px"></div>'.repeat(6);
    }

    try {
        console.log('璇锋眰 GitHub API...');
        const res = await fetchFromServer();
        console.log('API 鍝嶅簲鐘舵€?', res.status);

        if (!res.ok) {
            if (res.status === 404) {
                console.log('浠撳簱鎴栫洰褰曚笉瀛樺湪');
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

        console.log('瑙ｆ瀽 API 鍝嶅簲...');
        const files = await res.json();
        console.log('鏍圭洰褰曟枃浠?鏂囦欢澶规暟閲?', files.length);

        const { photos: newPhotos, folders: newFolders } = await parseFilesAndFolders(files);
        console.log('瑙ｆ瀽鍚庣収鐗囨暟閲?', newPhotos.length);
        console.log('瑙ｆ瀽鍚庢枃浠跺す鏁伴噺:', newFolders.length);
        if (newPhotos.length > 0) {
            console.log('鍓?3 寮犵収鐗?', newPhotos.slice(0, 3).map(p => p.name));
        }

        const hasChanged = JSON.stringify(newPhotos) !== JSON.stringify(photos);
        console.log('鐓х墖鏄惁鏈夊彉鍖?', hasChanged);

        if (hasChanged || photos.length === 0) {
            console.log('鏇存柊鐓х墖鍒楄〃');
            photos = newPhotos;
            folders = newFolders;
            await cachePhotos(photos);
            updateStats();
            filterPhotos();
            initSlideshow();
            showStatus(`宸插姞杞?${photos.length} 寮犵収鐗嘸, 'success');
            // 妫€鏌ョ収鐗囩浉鍏虫垚灏?
            checkAchievements(getAchievementData());
        }

    } catch (e) {
        console.error('Load error:', e);
        if (!cached || cached.length === 0) {
            showStatus('鍔犺浇澶辫触锛岃妫€鏌ョ綉缁?, 'error');
        }
    }
}

function updateStats() {
    document.getElementById('photoCount').textContent = photos.length;
    document.getElementById('folderCount').textContent = folders.length > 0 ? folders.length - 1 : 0;
    document.getElementById('storageUsed').textContent = calculateStorageUsage(photos);

    // 鏇存柊鏂囦欢澶圭瓫閫夊櫒
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
        // 鏂囦欢澶圭瓫閫?
        if (currentFilter.folder !== 'all' && photo.folder !== currentFilter.folder) {
            return false;
        }

        // 鎼滅储绛涢€?
        if (currentFilter.search && !photo.name.toLowerCase().includes(currentFilter.search)) {
            return false;
        }

        // 鏃堕棿绛涢€?
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
                        <button class="photo-action-btn" onclick="openLightbox(${actualIndex})" title="鏌ョ湅">馃憗</button>
                        <button class="photo-action-btn" onclick="setPhotoAsBackground(${actualIndex})" title="璁句负鑳屾櫙">馃柤锔?/button>
                        <button class="photo-action-btn delete" onclick="deletePhoto('${p.name}', '${p.sha}')" title="鍒犻櫎">馃棏</button>
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

    showStatus('宸茶涓鸿儗鏅浘鐗?, 'success');
}

function loadMorePhotos() {
    renderPhotos(true);
}

async function deletePhoto(filename, sha) {
    if (!confirm('纭畾鍒犻櫎杩欏紶鐓х墖鍚楋紵')) return;
    showStatus('鍒犻櫎涓?..', 'loading');
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
        showStatus('鍒犻櫎鎴愬姛', 'success');
        await clearCache();
        setTimeout(() => refreshPhotos(), 1000);
    } catch (e) {
        showStatus('鍒犻櫎澶辫触', 'error');
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

    meta.textContent = `${date} 路 ${size}`;

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

// 缂撳瓨鎿嶄綔
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
    showStatus('缂撳瓨宸叉竻绌?, 'success');
}

// ========== 骞荤伅鐗囪缃姛鑳?==========

// 骞荤伅鐗囬厤缃?
let slideshowSettings = {
    interval: 5,           // 鎾斁闂撮殧锛堢锛?
    transition: 'fade',    // 杩囨浮鏁堟灉锛歠ade, slide, zoom
    folder: 'slideshow',   // 骞荤伅鐗囩洰褰?
    maxCount: 10,          // 鏈€澶ф樉绀烘暟閲?
    autoPlay: true         // 鑷姩鎾斁
};

// 鍔犺浇骞荤伅鐗囪缃?
function loadSlideshowSettings() {
    const saved = localStorage.getItem('slideshowSettings');
    if (saved) {
        slideshowSettings = { ...slideshowSettings, ...JSON.parse(saved) };
    }
    // 鏇存柊 UI 鏄剧ず
    const intervalInput = document.getElementById('slideshowInterval');
    const intervalValue = document.getElementById('intervalValue');
    if (intervalInput) {
        intervalInput.value = slideshowSettings.interval;
        intervalValue.textContent = slideshowSettings.interval + '绉?;
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
        maxCountValue.textContent = slideshowSettings.maxCount + '寮?;
    }
    const autoPlayCheckbox = document.getElementById('slideshowAutoPlay');
    if (autoPlayCheckbox) {
        autoPlayCheckbox.checked = slideshowSettings.autoPlay;
    }
    // 鏇存柊 CONFIG
    CONFIG.slideshowFolder = slideshowSettings.folder;
}

// 淇濆瓨骞荤伅鐗囪缃?
function saveSlideshowSettings() {
    localStorage.setItem('slideshowSettings', JSON.stringify(slideshowSettings));
}

// 鏇存柊骞荤伅鐗囬棿闅?
function updateSlideshowInterval(value) {
    slideshowSettings.interval = parseInt(value);
    document.getElementById('intervalValue').textContent = value + '绉?;
    saveSlideshowSettings();
    // 閲嶆柊寮€濮嬪够鐏墖
    stopSlideshow();
    if (slideshowSettings.autoPlay) {
        startSlideshow();
    }
    showStatus(`骞荤伅鐗囬棿闅斿凡鏇存柊涓?${value}绉抈, 'success');
}

// 鏇存柊杩囨浮鏁堟灉
function updateTransitionEffect(value) {
    slideshowSettings.transition = value;
    saveSlideshowSettings();
    const container = document.getElementById('slideshowContainer');
    container.style.transition = value === 'fade' ? 'opacity 1s ease-in-out' : 
                                  value === 'slide' ? 'transform 0.8s ease-in-out, opacity 0.8s ease-in-out' :
                                  'transform 1s ease-in-out, opacity 1s ease-in-out';
    showStatus(`杩囨浮鏁堟灉宸叉洿鏂颁负 ${value === 'fade' ? '娣″叆娣″嚭' : value === 'slide' ? '婊戝姩' : '缂╂斁'}`, 'success');
}

// 鏇存柊骞荤伅鐗囩洰褰?
function updateSlideshowFolder(value) {
    slideshowSettings.folder = value.trim() || 'slideshow';
    saveSlideshowSettings();
    CONFIG.slideshowFolder = slideshowSettings.folder;
    showStatus(`骞荤伅鐗囩洰褰曞凡鏇存柊涓?${slideshowSettings.folder}`, 'success');
}

// 鏇存柊鏈€澶ф樉绀烘暟閲?
function updateSlideshowMaxCount(value) {
    slideshowSettings.maxCount = parseInt(value);
    document.getElementById('maxCountValue').textContent = value + '寮?;
    saveSlideshowSettings();
    initSlideshow();
    showStatus(`鏈€澶ф樉绀烘暟閲忓凡鏇存柊涓?${value}寮燻, 'success');
}

// 鏇存柊鑷姩鎾斁
function updateSlideshowAutoPlay(value) {
    slideshowSettings.autoPlay = value;
    saveSlideshowSettings();
    if (value) {
        startSlideshow();
    } else {
        stopSlideshow();
    }
    showStatus(`鑷姩鎾斁宸?{value ? '寮€鍚? : '鍏抽棴'}`, 'success');
}

// 閲嶆柊鍔犺浇骞荤伅鐗?
async function reloadSlideshowPhotos() {
    showStatus('姝ｅ湪閲嶆柊鍔犺浇骞荤伅鐗?..', 'loading');
    await loadSlideshowPhotos();
    initSlideshow();
    showStatus(`骞荤伅鐗囧凡鏇存柊锛屽叡 ${slideshowPhotos.length} 寮犵収鐗嘸, 'success');
}

// 宸ュ叿鍑芥暟
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

