                <div class="achievement-progress">${isUnlocked ? '✅ 已解锁' : '🔒 未解锁'}</div>
            </div>
        `;
    }).join('');
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

function toggleSettings() {
    const panel = document.getElementById('settingsPanel');
    if (panel.style.display === 'none' || !panel.style.display) {
        panel.style.display = 'flex';
        document.getElementById('anniversaryDateInput').value = CONFIG.anniversaryDate;
        document.getElementById('blurSlider').value = bgSettings.blur;
        document.getElementById('blurValue').textContent = bgSettings.blur + 'px';
        document.getElementById('darknessSlider').value = bgSettings.darkness;
        document.getElementById('darknessValue').textContent = bgSettings.darkness + '%';
    } else {
        panel.style.display = 'none';
    }
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
    document.getElementById('blurValue').textContent = value + 'px';
    saveSettings();
    applyBackgroundSettings();
}

function updateDarkness(value) {
    bgSettings.darkness = parseInt(value);
    document.getElementById('darknessValue').textContent = value + '%';
    saveSettings();
    applyBackgroundSettings();
}

function applyBackgroundSettings() {
    const bg = document.body;
    const overlay = document.createElement('div');
    overlay.className = 'bg-overlay';
    
    // 移除旧的覆盖层
    const oldOverlay = document.querySelector('.bg-overlay');
    if (oldOverlay) oldOverlay.remove();
    
    // 应用背景
    if (bgSettings.mode === 'default') {
        bg.style.background = 'linear-gradient(135deg, #fff0f5 0%, #ffe4ec 50%, #ffd6e0 100%)';
    } else if (bgSettings.mode === 'gradient') {
        bg.style.background = 'linear-gradient(135deg, #ff6b9d 0%, #ffc2d1 50%, #ffd6e0 100%)';
    } else if (bgSettings.mode === 'photo' && bgSettings.customPhoto) {
        bg.style.background = `url(${bgSettings.customPhoto}) center/cover fixed`;
    }
    
    // 添加覆盖层
    bg.appendChild(overlay);
    overlay.style.background = `rgba(255, 240, 245, ${bgSettings.darkness / 100})`;
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.zIndex = '-1';
    
    // 应用模糊
    bg.style.filter = `blur(${bgSettings.blur}px)`;
}

// ========== 音乐播放器 ==========
function toggleMusicPlayer() {
    const frame = document.getElementById('musicFrame');
    const icon = document.querySelector('.music-icon');
    if (frame.style.display === 'none') {
        frame.style.display = 'block';
        icon.textContent = '🔇';
    } else {
        frame.style.display = 'none';
        icon.textContent = '🎵';
    }
}

// ========== 漂浮爱心 ==========
function createFloatingHearts() {
    const container = document.getElementById('floatingHearts');
    const hearts = ['💕', '💘', '💝', '💖', '💗', '💓', '💞', '💯', '❤️'];
    
    setInterval(() => {
        const heart = document.createElement('div');
        heart.className = 'heart';
        heart.textContent = hearts[Math.floor(Math.random() * hearts.length)];
        heart.style.left = Math.random() * 100 + '%';
        heart.style.animationDuration = (Math.random() * 3 + 4) + 's';
        heart.style.opacity = Math.random() * 0.5 + 0.3;
        container.appendChild(heart);
        setTimeout(() => heart.remove(), 7000);
    }, 2000);
}

// ========== 进度条 ==========
function updateProgress(current, total, filename) {
    const container = document.getElementById('progressContainer');
    const fill = document.getElementById('progressFill');
    const text = document.getElementById('progressText');
    const pct = total > 0 ? (current / total) * 100 : 0;
    
    container.classList.add('active');
    fill.style.width = pct + '%';
    text.textContent = filename ? `上传中 ${filename} (${current}/${total})` : '';
    
    if (pct >= 100) {
        setTimeout(() => container.classList.remove('active'), 1000);
    }
}

// ========== 状态提示 ==========
function showStatus(msg, type = 'success') {
    const status = document.createElement('div');
    status.className = `status ${type}`;
    status.textContent = msg;
    status.style.animation = 'slideIn 0.3s ease';
    
    document.body.appendChild(status);
    
    setTimeout(() => {
        status.style.opacity = '0';
        status.style.transform = 'translateY(-20px)';
        setTimeout(() => status.remove(), 300);
    }, 3000);
}

// ========== 工具函数 ==========
function calculateStorageUsage(photos) {
    const totalBytes = photos.reduce((sum, photo) => sum + photo.size, 0);
    const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);
    return `${totalMB} MB`;
}

function updateStats() {
    document.getElementById('photoCount').textContent = photos.length;
    document.getElementById('folderCount').textContent = folders.length > 0 ? folders.length - 1 : 0;
    document.getElementById('storageUsed').textContent = calculateStorageUsage(photos);
}
