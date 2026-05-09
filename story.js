let storyBgActiveLayer = 'A';
let storyScrollRaf = null;
let storyListenersController = null;
let storyStageState = { photoIndex: -2, chapterTitle: '' };
let storyBackdropPhotoIndex = -2;
let currentStoryNodes = [];
let storyDetailOrder = -1;
let storyDetailEditing = false;
const STORY_EDITS_KEY = 'storyFilmEdits';
const STORY_SCENE_ROOT = '故事胶片';
const STORY_IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|svg)$/i;
const STORY_VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogg)$/i;
let storyEdits = {};
const storyScenePhotosCache = new Map();

const storyLoopState = {
    baseStart: 0,
    segmentWidth: 0,
    leftBoundary: 0,
    rightBoundary: 0,
    total: 0,
    activeOrder: 0,
    rebasing: false
};

function loadStoryEdits() {
    try {
        const saved = localStorage.getItem(STORY_EDITS_KEY);
        storyEdits = saved ? JSON.parse(saved) : {};
    } catch (e) {
        storyEdits = {};
    }
}

function saveStoryEdits() {
    localStorage.setItem(STORY_EDITS_KEY, JSON.stringify(storyEdits));
}

function getStoryNodeEditKey(node) {
    const photoList = Array.isArray(window.photos) ? window.photos : [];
    if (typeof node.photoIndex === 'number' && node.photoIndex >= 0 && photoList[node.photoIndex]?.name) {
        return `photo:${photoList[node.photoIndex].name}`;
    }
    return 'photo:now';
}

function encodeStoryPath(path) {
    if (typeof window.encodeGitHubPath === 'function') return window.encodeGitHubPath(path);
    return path.split('/').map(seg => encodeURIComponent(seg)).join('/');
}

function sanitizeStorySceneSegment(text) {
    return String(text || '')
        .trim()
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^\.+/, '')
        .replace(/\.$/, '')
        .slice(0, 32);
}

function getStorySceneFolder(order) {
    const node = currentStoryNodes[order];
    if (!node) return `${STORY_SCENE_ROOT}/第00幕-未命名`;
    const photoList = Array.isArray(window.photos) ? window.photos : [];
    const photo = node.photoIndex >= 0 ? photoList[node.photoIndex] : null;
    const stablePart = photo?.name
        ? sanitizeStorySceneSegment(photo.name.split('/').pop().replace(/^\d+_/, '').replace(/\.[^/.]+$/, ''))
        : sanitizeStorySceneSegment((node.title || '').replace(/^第\d+幕\s*·?\s*/, ''));
    const titlePart = stablePart || '未命名';
    const orderPart = `第${String(order + 1).padStart(2, '0')}幕`;
    return `${STORY_SCENE_ROOT}/${orderPart}-${titlePart}`;
}

function getStorySceneUploadHint(order) {
    return `上传路径：${getStorySceneFolder(order)}`;
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

function parseTags(raw) {
    return String(raw || '')
        .split(/[，,]/)
        .map(t => t.trim())
        .filter(Boolean)
        .slice(0, 6);
}

function deriveStoryLocation(photo) {
    if (!photo || !photo.name) return '我们的日常宇宙';
    const folder = photo.name.includes('/') ? photo.name.split('/')[0] : '';
    return folder ? `${folder} · 我们的足迹` : '我们的日常宇宙';
}

function escapeStoryHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildDefaultMoments(node) {
    const title = node.title || '这一幕';
    return [
        `在「${title.replace(/^第\d+幕\s*·\s*/, '')}」里认真相爱`,
        '把平凡一天过成值得收藏的片段',
        '约定把下一次心动继续写进故事'
    ];
}

function getStoryNodeViewModel(node) {
    const edit = storyEdits[getStoryNodeEditKey(node)] || {};
    const photoList = Array.isArray(window.photos) ? window.photos : [];
    const photo = (node.photoIndex >= 0 && photoList[node.photoIndex]) ? photoList[node.photoIndex] : null;
    return {
        dateLabel: edit.dateLabel || node.dateLabel || '',
        title: edit.title || node.title || '我们的故事',
        text: edit.text || node.text || '',
        location: edit.location || deriveStoryLocation(photo),
        tags: Array.isArray(edit.tags) && edit.tags.length ? edit.tags : ['心动', '陪伴', '日常'],
        moments: Array.isArray(edit.moments) && edit.moments.length ? edit.moments : buildDefaultMoments(node),
        board: edit.board || '如果这一幕是一张慢慢显影的照片，我想在背面写下：谢谢你，把普通日子变成了值得反复看的电影。',
        noteMe: edit.noteMe || '今天也很喜欢你。',
        noteTa: edit.noteTa || '我们会一直一起走下去。',
        imageUrl: photo && typeof window.getImageUrl === 'function' ? window.getImageUrl(photo.name) : ''
    };
}

function getStoryTitle(order) {
    const titles = ['心动开场', '日常发光', '双向奔赴', '城市漫游', '未来序章', '星光尾注'];
    return titles[(order - 1) % titles.length];
}

function getStoryText(photo) {
    if (!photo || !photo.name) return '故事还在继续，下一幕由今天的我们书写。';
    const shortName = photo.name.split('/').pop().replace(/^\d+_/, '').replace(/\.[^/.]+$/, '');
    return `我们把「${shortName || '这一刻'}」收藏进回忆里，平凡日子也因此有了闪光。`;
}

function updateStoryStageByIndex(photoIndex, chapterTitle = '') {
    const imgEl = document.getElementById('storyStageImg');
    const titleEl = document.getElementById('storyStageTitle');
    const textEl = document.getElementById('storyStageText');
    if (!imgEl || !titleEl || !textEl) return;

    // 滚动中频繁触发时，避免同一幕重复刷新造成闪动
    if (storyStageState.photoIndex === photoIndex && storyStageState.chapterTitle === chapterTitle) {
        return;
    }
    storyStageState = { photoIndex, chapterTitle };

    const photoList = Array.isArray(window.photos) ? window.photos : [];
    const photo = photoList[photoIndex];
    if (!photo) {
        imgEl.classList.remove('active');
        imgEl.removeAttribute('src');
        titleEl.textContent = '我们的现在';
        textEl.textContent = '横向滑动胶片，故事镜头会在这里同步切换。';
        return;
    }

    imgEl.classList.remove('active');
    imgEl.src = window.getImageUrl(photo.name);
    imgEl.onload = () => imgEl.classList.add('active');
    titleEl.textContent = chapterTitle || '故事章节';
    textEl.textContent = getStoryText(photo);
}

function syncStoryBackdrop(photoIndex) {
    const layerA = document.getElementById('storyBgLayerA');
    const layerB = document.getElementById('storyBgLayerB');
    if (!layerA || !layerB) return;

    // 防止同一张背景图被重复切层引发闪烁
    if (storyBackdropPhotoIndex === photoIndex) return;
    storyBackdropPhotoIndex = photoIndex;

    const photoList = Array.isArray(window.photos) ? window.photos : [];
    const photo = photoList[photoIndex];
    if (!photo) {
        layerA.classList.remove('active');
        layerB.classList.remove('active');
        return;
    }

    const nextLayer = storyBgActiveLayer === 'A' ? layerB : layerA;
    const prevLayer = storyBgActiveLayer === 'A' ? layerA : layerB;
    nextLayer.style.backgroundImage = `url('${window.getImageUrl(photo.name)}')`;
    prevLayer.classList.remove('active');
    nextLayer.classList.add('active');
    storyBgActiveLayer = storyBgActiveLayer === 'A' ? 'B' : 'A';
}

function getStoryTrack() {
    return document.getElementById('storyFilmTrack');
}

function getStoryViewport() {
    return document.getElementById('storyFilmViewport');
}

function getMiddleStoryItem(order) {
    return document.querySelector(`.timeline-item[data-segment="real"][data-order="${order}"]`);
}

function getCenteredStoryScroll(item, viewport) {
    return item.offsetLeft + item.offsetWidth / 2 - viewport.clientWidth / 2;
}

function updateStoryFilmStatus(order, total) {
    const text = document.getElementById('storyProgressText');
    if (!text) return;

    const safeTotal = Math.max(total, 1);
    text.textContent = `第 ${order + 1} 幕 / 共 ${safeTotal} 幕`;
}

function activateStoryOrder(order) {
    if (storyLoopState.total <= 0) return;
    const safeOrder = ((order % storyLoopState.total) + storyLoopState.total) % storyLoopState.total;
    const hasActive = !!document.querySelector('.timeline-item.active');
    if (hasActive && safeOrder === storyLoopState.activeOrder) {
        return;
    }

    document.querySelectorAll('.timeline-item').forEach(el => {
        const isActive = parseInt(el.dataset.order, 10) === safeOrder;
        el.classList.toggle('active', isActive);
    });

    storyLoopState.activeOrder = safeOrder;
    updateStoryFilmStatus(safeOrder, storyLoopState.total);

    const card = getMiddleStoryItem(safeOrder)?.querySelector('.timeline-card[data-photo-index]');
    if (!card) {
        updateStoryStageByIndex(-1);
        syncStoryBackdrop(-1);
        return;
    }

    const index = parseInt(card.dataset.photoIndex, 10);
    const title = card.querySelector('h4')?.textContent || '';
    if (!isNaN(index)) {
        updateStoryStageByIndex(index, title);
        syncStoryBackdrop(index);
    }
}

function keepStoryInLoopRange() {
    const viewport = getStoryViewport();
    if (!viewport || storyLoopState.segmentWidth <= 0 || storyLoopState.rebasing) return;

    let delta = 0;
    if (viewport.scrollLeft < storyLoopState.leftBoundary) {
        delta = storyLoopState.segmentWidth;
    } else if (viewport.scrollLeft > storyLoopState.rightBoundary) {
        delta = -storyLoopState.segmentWidth;
    }
    if (!delta) return;

    storyLoopState.rebasing = true;
    const prevSnapType = viewport.style.scrollSnapType;
    const prevBehavior = viewport.style.scrollBehavior;
    viewport.style.scrollSnapType = 'none';
    viewport.style.scrollBehavior = 'auto';
    viewport.scrollLeft += delta;

    requestAnimationFrame(() => {
        viewport.style.scrollSnapType = prevSnapType;
        viewport.style.scrollBehavior = prevBehavior;
        storyLoopState.rebasing = false;
    });
}

function detectActiveStoryByCenter() {
    const viewport = getStoryViewport();
    if (!viewport) return;

    const viewportRect = viewport.getBoundingClientRect();
    const center = viewportRect.left + viewportRect.width / 2;

    const candidates = Array.from(document.querySelectorAll('.timeline-item'));
    if (!candidates.length) return;

    let closestOrder = parseInt(candidates[0].dataset.order, 10) || 0;
    let minDistance = Infinity;

    candidates.forEach(item => {
        const rect = item.getBoundingClientRect();
        const itemCenter = rect.left + rect.width / 2;
        const distance = Math.abs(itemCenter - center);
        if (distance < minDistance) {
            minDistance = distance;
            closestOrder = parseInt(item.dataset.order, 10) || 0;
        }
    });

    activateStoryOrder(closestOrder);
}

function syncStoryByScroll() {
    storyScrollRaf = null;
    keepStoryInLoopRange();
    detectActiveStoryByCenter();
}

function onStoryScroll() {
    if (storyScrollRaf) return;
    storyScrollRaf = requestAnimationFrame(syncStoryByScroll);
}

function scrollToStoryOrder(order, behavior = 'smooth') {
    const viewport = getStoryViewport();
    const target = getMiddleStoryItem(order);
    if (!viewport || !target) return;

    viewport.scrollTo({
        left: getCenteredStoryScroll(target, viewport),
        behavior
    });
    activateStoryOrder(order);
}

function stepStory(delta) {
    if (storyLoopState.total <= 0) return;
    const nextOrder = (storyLoopState.activeOrder + delta + storyLoopState.total) % storyLoopState.total;
    scrollToStoryOrder(nextOrder);
}

function storyPrev() {
    stepStory(-1);
}

function storyNext() {
    stepStory(1);
}

function bindStoryInteractions() {
    const viewport = getStoryViewport();
    if (!viewport) return;

    if (storyListenersController) {
        storyListenersController.abort();
    }
    storyListenersController = new AbortController();
    const signal = storyListenersController.signal;

    viewport.addEventListener('scroll', onStoryScroll, { passive: true, signal });

    viewport.addEventListener('wheel', (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            viewport.scrollLeft += e.deltaY;
            e.preventDefault();
        }
    }, { passive: false, signal });

    document.addEventListener('keydown', (e) => {
        const editableTarget = e.target?.closest?.('input, textarea, select, [contenteditable="true"]');
        if (editableTarget) return;
        if (isStoryDetailOpen()) {
            if (e.key === 'Escape') closeStoryDetail();
            if (e.key === 'ArrowLeft') storyDetailPrev();
            if (e.key === 'ArrowRight') storyDetailNext();
            return;
        }
        if (typeof window.currentMainChannel !== 'undefined' && window.currentMainChannel !== 'story') {
            return;
        }
        if (e.key === 'ArrowLeft') storyPrev();
        if (e.key === 'ArrowRight') storyNext();
    }, { signal });
}

function buildFilmItem(node, order, segment) {
    const cardClass = `timeline-card ${node.isNow ? 'now-card' : ''}`;
    const dataAttr = typeof node.photoIndex === 'number' && node.photoIndex >= 0
        ? `data-photo-index="${node.photoIndex}"`
        : '';

    return `
        <article class="timeline-item" data-order="${order}" data-segment="${segment}">
            <span class="timeline-date">${escapeStoryHtml(node.dateLabel)}</span>
            <div class="${cardClass}" ${dataAttr} onclick="openStoryDetail(${order})">
                <h4>${escapeStoryHtml(node.title)}</h4>
                <p>${escapeStoryHtml(node.text)}</p>
                <span class="story-card-cta">点击展开详情</span>
            </div>
        </article>
    `;
}

function buildStoryFilmNodes(force = false) {
    const photoList = Array.isArray(window.photos) ? window.photos : [];
    const timelinePhotos = [...photoList]
        .filter(p => typeof p.timestamp === 'number' && !isNaN(p.timestamp))
        .sort((a, b) => a.timestamp - b.timestamp);

    if (!timelinePhotos.length) return [];

    const maxNodes = 8;
    const total = timelinePhotos.length;
    const nodeCount = Math.min(maxNodes, total);
    const sampled = [];

    for (let i = 0; i < nodeCount; i++) {
        let index;
        if (force && total > 3) {
            index = Math.floor(Math.random() * total);
        } else {
            index = total === 1 ? 0 : Math.round((i * (total - 1)) / (nodeCount - 1 || 1));
        }
        sampled.push(timelinePhotos[index]);
    }

    const uniqueNodes = sampled.filter((item, idx, arr) => arr.findIndex(t => t.name === item.name) === idx);
    const filmNodes = uniqueNodes.map((photo, idx) => ({
        order: idx,
        photoIndex: photoList.findIndex(p => p.name === photo.name),
        dateLabel: new Date(photo.timestamp).toLocaleDateString('zh-CN'),
        title: `第${idx + 1}幕 · ${getStoryTitle(idx + 1)}`,
        text: getStoryText(photo),
        isNow: idx === uniqueNodes.length - 1
    }));

    filmNodes.push({
        order: filmNodes.length,
        photoIndex: -1,
        dateLabel: 'NOW',
        title: '正在上映 · 我们的现在',
        text: '故事仍在更新，下一张照片会成为新的片段。',
        isNow: true
    });

    filmNodes.forEach(node => {
        const edit = storyEdits[getStoryNodeEditKey(node)];
        if (!edit) return;
        if (typeof edit.dateLabel === 'string' && edit.dateLabel.trim()) node.dateLabel = edit.dateLabel.trim();
        if (typeof edit.title === 'string' && edit.title.trim()) node.title = edit.title.trim();
        if (typeof edit.text === 'string' && edit.text.trim()) node.text = edit.text.trim();
    });

    return filmNodes;
}

function setupStoryLoopMetrics() {
    const viewport = getStoryViewport();
    const firstPrev = document.querySelector('.timeline-item[data-segment="prev"][data-order="0"]');
    const lastPrev = document.querySelector(`.timeline-item[data-segment="prev"][data-order="${storyLoopState.total - 1}"]`);
    const firstReal = document.querySelector('.timeline-item[data-segment="real"][data-order="0"]');
    const lastReal = document.querySelector(`.timeline-item[data-segment="real"][data-order="${storyLoopState.total - 1}"]`);
    const firstNext = document.querySelector('.timeline-item[data-segment="next"][data-order="0"]');

    if (!viewport || !firstPrev || !lastPrev || !firstReal || !lastReal || !firstNext) return;

    const firstPrevScroll = getCenteredStoryScroll(firstPrev, viewport);
    const lastPrevScroll = getCenteredStoryScroll(lastPrev, viewport);
    const firstRealScroll = getCenteredStoryScroll(firstReal, viewport);
    const lastRealScroll = getCenteredStoryScroll(lastReal, viewport);
    const firstNextScroll = getCenteredStoryScroll(firstNext, viewport);

    storyLoopState.baseStart = firstRealScroll;
    storyLoopState.segmentWidth = firstNextScroll - firstRealScroll;
    storyLoopState.leftBoundary = (lastPrevScroll + firstRealScroll) / 2;
    storyLoopState.rightBoundary = (lastRealScroll + firstNextScroll) / 2;

    viewport.scrollLeft = storyLoopState.baseStart;
}

function renderStoryTimeline(force = false) {
    const container = document.getElementById('storyTimeline');
    if (!container) return;

    const filmNodes = buildStoryFilmNodes(force);
    currentStoryNodes = filmNodes.map((node, index) => ({ ...node, order: index }));
    storyLoopState.total = filmNodes.length;
    storyLoopState.activeOrder = -1;
    storyStageState = { photoIndex: -2, chapterTitle: '' };
    storyBackdropPhotoIndex = -2;

    if (!filmNodes.length) {
        container.innerHTML = `
            <div class="story-film-shell empty">
                <div class="story-empty">上传几张照片后，这里会自动生成横向胶片叙事。</div>
            </div>
        `;
        updateStoryStageByIndex(-1);
        syncStoryBackdrop(-1);
        return;
    }

    const cardsHtml = [
        ...currentStoryNodes.map((node, idx) => buildFilmItem(node, idx, 'prev')),
        ...currentStoryNodes.map((node, idx) => buildFilmItem(node, idx, 'real')),
        ...currentStoryNodes.map((node, idx) => buildFilmItem(node, idx, 'next'))
    ].join('');

    container.innerHTML = `
        <div class="story-film-shell">
            <div id="storyFilmViewport" class="story-film-viewport">
                <div id="storyFilmTrack" class="story-film-track">${cardsHtml}</div>
            </div>
        </div>
        <div class="film-footer">
            <div class="film-meta" aria-live="polite">
                <span id="storyProgressText">第 1 幕 / 共 ${filmNodes.length} 幕</span>
                <span>手动滑动浏览</span>
            </div>
        </div>
    `;

    setupStoryLoopMetrics();
    bindStoryInteractions();
    activateStoryOrder(0);
    if (typeof window.updateHomeOverview === 'function') {
        window.updateHomeOverview();
    }
}

function isStoryDetailOpen() {
    const panel = document.getElementById('storyDetailPanel');
    return !!panel && panel.style.display === 'block';
}

function setStoryDetailMode(editing) {
    storyDetailEditing = editing;
    const panel = document.getElementById('storyDetailPanel');
    if (!panel) return;
    panel.classList.toggle('editing', editing);
}

function fillStoryDetailView(order) {
    const node = currentStoryNodes[order];
    if (!node) return;
    const vm = getStoryNodeViewModel(node);
    const heroImg = document.getElementById('storyDetailHeroImg');
    const dateEl = document.getElementById('storyDetailDate');
    const titleEl = document.getElementById('storyDetailTitle');
    const locationEl = document.getElementById('storyDetailLocation');
    const tagsEl = document.getElementById('storyDetailTags');
    const textEl = document.getElementById('storyDetailText');
    const momentsEl = document.getElementById('storyDetailMoments');
    const noteMeEl = document.getElementById('storyDetailNoteMe');
    const noteTaEl = document.getElementById('storyDetailNoteTa');
    const boardEl = document.getElementById('storyDetailBoard');

    if (heroImg) {
        if (vm.imageUrl) {
            heroImg.src = vm.imageUrl;
            heroImg.style.display = 'block';
        } else {
            heroImg.removeAttribute('src');
            heroImg.style.display = 'none';
        }
    }
    if (dateEl) dateEl.textContent = vm.dateLabel;
    if (titleEl) titleEl.textContent = vm.title;
    if (locationEl) locationEl.textContent = vm.location;
    if (textEl) textEl.textContent = vm.text;
    if (tagsEl) {
        tagsEl.innerHTML = vm.tags.map(tag => `<span class="story-tag">${escapeStoryHtml(tag)}</span>`).join('');
    }
    if (momentsEl) {
        momentsEl.innerHTML = vm.moments.map(item => `<li>${escapeStoryHtml(item)}</li>`).join('');
    }
    if (boardEl) boardEl.textContent = vm.board;
    if (noteMeEl) noteMeEl.textContent = `我：${vm.noteMe}`;
    if (noteTaEl) noteTaEl.textContent = `TA：${vm.noteTa}`;
    renderStoryScenePhotos(order);
}

function fillStoryEditForm(order) {
    const node = currentStoryNodes[order];
    if (!node) return;
    const vm = getStoryNodeViewModel(node);
    const orderInput = document.getElementById('storyDetailOrder');
    if (orderInput) orderInput.value = String(order);
    document.getElementById('storyEditDate').value = vm.dateLabel;
    document.getElementById('storyEditTitle').value = vm.title;
    document.getElementById('storyEditLocation').value = vm.location;
    document.getElementById('storyEditTags').value = vm.tags.join(', ');
    document.getElementById('storyEditText').value = vm.text;
    document.getElementById('storyEditBoard').value = vm.board;
    document.getElementById('storyEditMoments').value = vm.moments.join('\n');
    document.getElementById('storyEditNoteMe').value = vm.noteMe;
    document.getElementById('storyEditNoteTa').value = vm.noteTa;
    const uploadHint = document.getElementById('storySceneUploadHint');
    if (uploadHint) uploadHint.textContent = getStorySceneUploadHint(order);
}

async function loadStorySceneMedia(order, force = false) {
    const sceneFolder = getStorySceneFolder(order);
    if (!force && storyScenePhotosCache.has(sceneFolder)) {
        return storyScenePhotosCache.get(sceneFolder);
    }
    const headers = { 'Accept': 'application/vnd.github.v3+json' };
    if (typeof window.githubToken === 'string' && window.githubToken) {
        headers['Authorization'] = `token ${window.githubToken}`;
    }

    try {
        const res = await fetch(`https://api.github.com/repos/${window.CONFIG.owner}/image/contents/${encodeStoryPath(sceneFolder)}?ref=${window.CONFIG.branch}`, { headers });
        if (res.status === 404) {
            storyScenePhotosCache.set(sceneFolder, []);
            return [];
        }
        if (!res.ok) throw new Error(await res.text());

        const files = await res.json();
        const media = (Array.isArray(files) ? files : [])
            .filter(file => file.type === 'file' && (STORY_IMAGE_EXT_RE.test(file.name) || STORY_VIDEO_EXT_RE.test(file.name)))
            .map(file => ({
                name: file.name,
                path: file.path,
                url: window.getImageUrl(file.path),
                size: file.size || 0,
                type: STORY_VIDEO_EXT_RE.test(file.name) ? 'video' : 'image'
            }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
        storyScenePhotosCache.set(sceneFolder, media);
        return media;
    } catch (e) {
        console.error('加载故事幕媒体失败:', e);
        return [];
    }
}

async function renderStoryScenePhotos(order, force = false) {
    const photoContainer = document.getElementById('storyScenePhotos');
    const videoContainer = document.getElementById('storySceneVideos');
    const folderPathEl = document.getElementById('storySceneFolderPath');
    if (!photoContainer || !videoContainer) return;
    const sceneFolder = getStorySceneFolder(order);
    if (folderPathEl) folderPathEl.textContent = sceneFolder;
    photoContainer.innerHTML = '<div class="story-scene-empty">正在加载本幕影像...</div>';
    videoContainer.innerHTML = '';

    const mediaList = await loadStorySceneMedia(order, force);
    const photosList = mediaList.filter(item => item.type === 'image');
    const videosList = mediaList.filter(item => item.type === 'video');
    if (!photosList.length) {
        photoContainer.innerHTML = '<div class="story-scene-empty">本幕还没有图片，进入编辑态后可以上传一组照片。</div>';
    } else {
        photoContainer.innerHTML = photosList.map(photo => `
            <button class="story-scene-photo" type="button" data-url="${photo.url}" onclick="window.open(this.dataset.url, '_blank', 'noopener')">
                <img src="${photo.url}" alt="${escapeStoryHtml(photo.name)}">
                <span>${escapeStoryHtml(photo.name.replace(/^\d+_/, '').replace(/\.[^/.]+$/, ''))}</span>
            </button>
        `).join('');
    }

    videoContainer.innerHTML = videosList.length
        ? videosList.map(video => `
            <article class="story-scene-video">
                <div class="story-scene-video-frame">
                    <span class="story-scene-video-badge">VIDEO CLIP</span>
                    <video src="${video.url}" controls preload="metadata"></video>
                </div>
                <div class="story-scene-video-caption">
                    <strong>${escapeStoryHtml(video.name.replace(/^\d+_/, '').replace(/\.[^/.]+$/, ''))}</strong>
                    <small>按下播放，回到这一秒</small>
                </div>
            </article>
        `).join('')
        : '<div class="story-scene-empty">本幕还没有视频，适合放一段现场声音、路上的风景或小片段。</div>';
}

async function uploadStorySceneFile(file, order) {
    const sceneFolder = getStorySceneFolder(order);
    const filename = `${sceneFolder}/${Date.now()}_${sanitizeUploadFileName(file.name)}`;
    const contentBase64 = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(event.target.result.split(',')[1]);
        reader.readAsDataURL(file);
    });

    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
    };
    if (typeof window.githubToken === 'string' && window.githubToken) {
        headers['Authorization'] = `token ${window.githubToken}`;
    }

    const res = await fetch(`https://api.github.com/repos/${window.CONFIG.owner}/image/contents/${encodeStoryPath(filename)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
            message: `Upload story scene media ${file.name}`,
            content: contentBase64,
            branch: window.CONFIG.branch
        })
    });
    if (!res.ok) throw new Error(await res.text());
}

async function handleStorySceneFiles(fileList) {
    const order = storyDetailOrder;
    if (order < 0 || !fileList) return;
    const files = Array.from(fileList).filter(file => file.type.startsWith('image/') || file.type.startsWith('video/'));
    if (!files.length) {
        alert('请选择图片或视频文件');
        return;
    }
    if (typeof window.showStatus !== 'function') return;

    window.showStatus(`开始上传本幕影像（共 ${files.length} 个）...`, 'loading');
    let success = 0;
    for (const file of files) {
        try {
            await uploadStorySceneFile(file, order);
            success += 1;
        } catch (e) {
            console.error('上传故事幕影像失败:', e);
        }
    }

    const sceneFolder = getStorySceneFolder(order);
    storyScenePhotosCache.delete(sceneFolder);
    await renderStoryScenePhotos(order, true);
    if (typeof window.refreshPhotos === 'function' && success > 0) {
        await window.refreshPhotos();
    }
    window.showStatus(success > 0 ? `本幕影像上传成功 ${success} 个` : '本幕影像上传失败', success > 0 ? 'success' : 'error');
    const input = document.getElementById('storySceneUploadInput');
    if (input) input.value = '';
}

function openStoryDetail(order) {
    const node = currentStoryNodes[order];
    const panel = document.getElementById('storyDetailPanel');
    if (!node || !panel) return;
    storyDetailOrder = order;
    fillStoryDetailView(order);
    fillStoryEditForm(order);
    setStoryDetailMode(false);
    panel.style.display = 'block';
}

function closeStoryDetail() {
    const panel = document.getElementById('storyDetailPanel');
    if (!panel) return;
    panel.style.display = 'none';
    setStoryDetailMode(false);
    const input = document.getElementById('storySceneUploadInput');
    if (input) input.value = '';
}

function startStoryEdit() {
    if (storyDetailOrder < 0) return;
    fillStoryEditForm(storyDetailOrder);
    setStoryDetailMode(true);
}

function cancelStoryEdit() {
    if (storyDetailOrder < 0) return;
    setStoryDetailMode(false);
    fillStoryDetailView(storyDetailOrder);
}

function saveStoryEdit() {
    const order = parseInt(document.getElementById('storyDetailOrder')?.value || '-1', 10);
    const node = currentStoryNodes[order];
    if (!node) return;

    const dateLabel = document.getElementById('storyEditDate')?.value.trim() || '';
    const title = document.getElementById('storyEditTitle')?.value.trim() || '';
    const text = document.getElementById('storyEditText')?.value.trim() || '';
    const board = document.getElementById('storyEditBoard')?.value.trim() || '';
    const location = document.getElementById('storyEditLocation')?.value.trim() || '';
    const tags = parseTags(document.getElementById('storyEditTags')?.value || '');
    const moments = String(document.getElementById('storyEditMoments')?.value || '')
        .split('\n')
        .map(item => item.trim())
        .filter(Boolean)
        .slice(0, 8);
    const noteMe = document.getElementById('storyEditNoteMe')?.value.trim() || '';
    const noteTa = document.getElementById('storyEditNoteTa')?.value.trim() || '';
    if (!title || !text || !location) {
        alert('标题、地点和内容不能为空');
        return;
    }

    storyEdits[getStoryNodeEditKey(node)] = {
        dateLabel,
        title,
        text,
        board,
        location,
        tags,
        moments,
        noteMe,
        noteTa
    };
    saveStoryEdits();
    renderStoryTimeline(false);
    requestAnimationFrame(() => {
        scrollToStoryOrder(order, 'auto');
        openStoryDetail(order);
    });
}

function storyDetailPrev() {
    if (currentStoryNodes.length <= 0 || storyDetailOrder < 0) return;
    const prev = (storyDetailOrder - 1 + currentStoryNodes.length) % currentStoryNodes.length;
    scrollToStoryOrder(prev);
    openStoryDetail(prev);
}

function storyDetailNext() {
    if (currentStoryNodes.length <= 0 || storyDetailOrder < 0) return;
    const next = (storyDetailOrder + 1) % currentStoryNodes.length;
    scrollToStoryOrder(next);
    openStoryDetail(next);
}

loadStoryEdits();

window.renderStoryTimeline = renderStoryTimeline;
window.storyPrev = storyPrev;
window.storyNext = storyNext;
window.openStoryDetail = openStoryDetail;
window.closeStoryDetail = closeStoryDetail;
window.startStoryEdit = startStoryEdit;
window.cancelStoryEdit = cancelStoryEdit;
window.saveStoryEdit = saveStoryEdit;
window.storyDetailPrev = storyDetailPrev;
window.storyDetailNext = storyDetailNext;
window.handleStorySceneFiles = handleStorySceneFiles;
