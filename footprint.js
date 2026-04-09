// ========== 地图足迹功能 ==========

const HARDCODED_AMAP_KEY = 'WXpaa1l6WmtaamN6WWpKa01qazRZbVZtTlRBME9UazVZakE1TURjME5EST0=';

function decodeEmbeddedKey(encoded) {
    try {
        return atob(atob(encoded));
    } catch (e) {
        return '';
    }
}

let footprints = [];
let editingFootprintId = null;
let selectedFootprintId = null;
let amapKey = localStorage.getItem('amapStaticKey') || decodeEmbeddedKey(HARDCODED_AMAP_KEY);

function syncFootprintsGlobal() {
    window.footprints = footprints;
    if (typeof window.updateHomeOverview === 'function') {
        window.updateHomeOverview();
    }
}

async function geocodeAddressByAmap(address) {
    if (!amapKey || !address) return null;
    try {
        const res = await fetch(`https://restapi.amap.com/v3/geocode/geo?key=${encodeURIComponent(amapKey)}&address=${encodeURIComponent(address)}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.status !== '1' || !Array.isArray(data.geocodes) || data.geocodes.length === 0) return null;
        const location = data.geocodes[0].location || '';
        const [lng, lat] = location.split(',').map(v => parseFloat(v));
        if (!isFinite(lng) || !isFinite(lat)) return null;
        return { lng, lat };
    } catch (e) {
        console.error('高德地理编码失败:', e);
        return null;
    }
}

async function loadFootprints() {
    try {
        const headers = { 'Accept': 'application/vnd.github.v3+json' };
        if (githubToken) headers['Authorization'] = `token ${githubToken}`;

        const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/footprints.json?ref=${CONFIG.branch}`, {
            headers
        });

        if (res.ok) {
            const data = await res.json();
            const content = decodeGitHubContent(data.content);
            const parsed = JSON.parse(content);
            footprints = Array.isArray(parsed) ? parsed : [];
        } else if (res.status === 404) {
            footprints = [];
        }
        syncFootprintsGlobal();
    } catch (e) {
        console.error('加载足迹失败:', e);
        footprints = [];
        syncFootprintsGlobal();
    }
}

async function saveFootprints() {
    try {
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        };
        if (githubToken) headers['Authorization'] = `token ${githubToken}`;

        let sha = null;
        const getRes = await fetch(`https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/footprints.json?ref=${CONFIG.branch}`, {
            headers
        });
        if (getRes.ok) {
            const getData = await getRes.json();
            sha = getData.sha;
        }

        const content = btoa(unescape(encodeURIComponent(JSON.stringify(footprints, null, 2))));
        const body = {
            message: '更新地图足迹',
            content,
            branch: CONFIG.branch
        };
        if (sha) body.sha = sha;

        const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/footprints.json`, {
            method: 'PUT',
            headers,
            body: JSON.stringify(body)
        });
        return res.ok;
    } catch (e) {
        console.error('保存足迹失败:', e);
        return false;
    }
}

function toggleAddFootprintPanel() {
    const panel = document.getElementById('addFootprintPanel');
    const overlay = document.getElementById('modalOverlay');
    if (!panel) return;

    if (panel.style.display === 'none' || !panel.style.display) {
        if (!overlay) {
            const newOverlay = document.createElement('div');
            newOverlay.id = 'modalOverlay';
            newOverlay.className = 'modal-overlay';
            newOverlay.onclick = toggleAddFootprintPanel;
            document.body.appendChild(newOverlay);
        }
        panel.style.display = 'block';
        if (!editingFootprintId) {
            document.getElementById('footprintPanelTitle').textContent = '添加地图足迹';
            document.getElementById('footprintCity').value = '';
            document.getElementById('footprintSpot').value = '';
            document.getElementById('footprintDate').value = '';
            document.getElementById('footprintLng').value = '';
            document.getElementById('footprintLat').value = '';
            document.getElementById('footprintNote').value = '';
        }
    } else {
        panel.style.display = 'none';
        editingFootprintId = null;
        document.getElementById('footprintPanelTitle').textContent = '添加地图足迹';
        if (overlay) overlay.remove();
    }
}

async function saveFootprint() {
    const city = document.getElementById('footprintCity')?.value.trim();
    const spot = document.getElementById('footprintSpot')?.value.trim();
    const date = document.getElementById('footprintDate')?.value;
    const note = document.getElementById('footprintNote')?.value.trim();
    const lngInput = parseFloat(document.getElementById('footprintLng')?.value);
    const latInput = parseFloat(document.getElementById('footprintLat')?.value);

    if (!city || !spot) {
        alert('请至少填写城市和景点');
        return;
    }

    let lng = isFinite(lngInput) ? lngInput : null;
    let lat = isFinite(latInput) ? latInput : null;

    if ((lng === null || lat === null) && amapKey) {
        const geocoded = await geocodeAddressByAmap(`${city}${spot}`);
        if (geocoded) {
            lng = geocoded.lng;
            lat = geocoded.lat;
        }
    }

    const resolvedId = editingFootprintId || Date.now().toString();
    const existingIndex = footprints.findIndex(item => item.id === resolvedId);
    const gender = existingIndex >= 0
        ? (footprints[existingIndex].gender || (existingIndex % 2 === 0 ? 'male' : 'female'))
        : (footprints.length % 2 === 0 ? 'male' : 'female');

    const payload = {
        id: resolvedId,
        city,
        spot,
        date: date || new Date().toISOString().slice(0, 10),
        note: note || '',
        lng,
        lat,
        gender,
        updatedAt: new Date().toISOString()
    };
    
    const targetIndex = footprints.findIndex(item => item.id === payload.id);
    if (targetIndex >= 0) {
        footprints[targetIndex] = { ...footprints[targetIndex], ...payload };
    } else {
        footprints.push({ ...payload, createdAt: new Date().toISOString() });
    }

    const saved = await saveFootprints();
    if (!saved) {
        showStatus('保存足迹失败，请检查网络', 'error');
        return;
    }

    renderFootprints();
    toggleAddFootprintPanel();
    showStatus('足迹已保存', 'success');
}

function editFootprint(id) {
    const target = footprints.find(item => item.id === id);
    if (!target) return;

    editingFootprintId = id;
    document.getElementById('footprintPanelTitle').textContent = '编辑地图足迹';
    document.getElementById('footprintCity').value = target.city || '';
    document.getElementById('footprintSpot').value = target.spot || '';
    document.getElementById('footprintDate').value = target.date || '';
    document.getElementById('footprintLng').value = isFinite(target.lng) ? target.lng : '';
    document.getElementById('footprintLat').value = isFinite(target.lat) ? target.lat : '';
    document.getElementById('footprintNote').value = target.note || '';

    const panel = document.getElementById('addFootprintPanel');
    if (!panel || panel.style.display === 'none' || !panel.style.display) {
        toggleAddFootprintPanel();
    }
}

async function deleteFootprint(id) {
    if (!confirm('确定删除这个足迹吗？')) return;
    footprints = footprints.filter(item => item.id !== id);
    if (selectedFootprintId === id) selectedFootprintId = null;

    const saved = await saveFootprints();
    if (!saved) {
        showStatus('删除失败，请检查网络', 'error');
        return;
    }
    renderFootprints();
    showStatus('足迹已删除', 'success');
}

function focusFootprint(id) {
    selectedFootprintId = id;
    renderFootprints();
}

function renderFootprintMap() {
    const mapImg = document.getElementById('footprintMapImg');
    const empty = document.getElementById('footprintMapEmpty');
    if (!mapImg || !empty) return;

    if (!amapKey) {
        mapImg.classList.remove('active');
        mapImg.removeAttribute('src');
        empty.textContent = '地图 Key 未配置，暂时无法渲染足迹地图';
        empty.style.display = 'grid';
        return;
    }

    const points = footprints
        .filter(item => isFinite(item.lng) && isFinite(item.lat))
        .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));

    if (!points.length) {
        mapImg.classList.remove('active');
        mapImg.removeAttribute('src');
        empty.textContent = '当前足迹暂无可定位坐标，请补充经纬度或确保 Key 可地理编码';
        empty.style.display = 'grid';
        return;
    }

    const selectedPoint = points.find(item => item.id === selectedFootprintId) || null;
    const shownPoints = points.slice(0, 16);
    if (selectedPoint && !shownPoints.some(item => item.id === selectedPoint.id)) {
        shownPoints[shownPoints.length - 1] = selectedPoint;
    }
    const markers = shownPoints.map((item) => {
        const isSelected = selectedPoint && item.id === selectedPoint.id;
        const markerStyle = isSelected ? 'large,0xFF4D6D' : 'mid,0xE07D88';
        const label = item.gender === 'male' ? '男' : '女';
        return `${markerStyle},${label}:${item.lng},${item.lat}`;
    }).join('|');
    const center = selectedPoint || points[points.length - 1];

    const params = new URLSearchParams({
        key: amapKey,
        location: `${center.lng},${center.lat}`,
        zoom: points.length > 5 ? '4' : '5',
        size: '1024*520',
        scale: '2',
        markers
    });

    const mapUrl = `https://restapi.amap.com/v3/staticmap?${params.toString()}`;
    mapImg.onload = () => {
        mapImg.classList.add('active');
        empty.style.display = 'none';
    };
    mapImg.onerror = () => {
        mapImg.classList.remove('active');
        empty.textContent = '地图加载失败，请检查高德 Key 是否有效';
        empty.style.display = 'grid';
    };
    mapImg.src = mapUrl;
}

function renderFootprints() {
    const list = document.getElementById('footprintList');
    const empty = document.getElementById('emptyFootprint');
    if (!list || !empty) return;

    const ordered = [...footprints].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    if (ordered.length === 0) {
        selectedFootprintId = null;
        list.innerHTML = '';
        empty.style.display = 'block';
        renderFootprintMap();
        syncFootprintsGlobal();
        return;
    }

    if (!selectedFootprintId) {
        const firstWithCoord = ordered.find(item => isFinite(item.lng) && isFinite(item.lat));
        selectedFootprintId = firstWithCoord ? firstWithCoord.id : ordered[0].id;
    }
    if (!ordered.some(item => item.id === selectedFootprintId)) {
        selectedFootprintId = ordered[0].id;
    }

    empty.style.display = 'none';
    list.innerHTML = ordered.map(item => `
        <article class="footprint-item ${item.id === selectedFootprintId ? 'active' : ''}" onclick="focusFootprint('${item.id}')">
            <div class="footprint-title">
                ${getFootprintAvatarSvg(item.gender)}
                <span>${escapeHtml(item.city || '')} · ${escapeHtml(item.spot || '')}</span>
            </div>
            <div class="footprint-meta">
                <span>${escapeHtml(item.date || '-')}</span>
                <span>${(isFinite(item.lng) && isFinite(item.lat)) ? '已定位' : '未定位'}</span>
            </div>
            ${item.note ? `<p class="footprint-note">${escapeHtml(item.note)}</p>` : ''}
            <div class="footprint-actions">
                <button class="footprint-action-btn edit" onclick="event.stopPropagation();editFootprint('${item.id}')">编辑</button>
                <button class="footprint-action-btn delete" onclick="event.stopPropagation();deleteFootprint('${item.id}')">删除</button>
            </div>
        </article>
    `).join('');

    renderFootprintMap();
    syncFootprintsGlobal();
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getFootprintAvatarSvg(gender) {
    if (gender === 'male') {
        return `
            <svg class="footprint-avatar male" viewBox="0 0 48 48" aria-hidden="true">
                <circle cx="24" cy="16" r="9" fill="#8EC9FF"/>
                <path d="M10 43c0-8 6-14 14-14s14 6 14 14" fill="#4D8BFF"/>
                <circle cx="20.5" cy="16.5" r="1.2" fill="#1F3557"/>
                <circle cx="27.5" cy="16.5" r="1.2" fill="#1F3557"/>
                <path d="M20 20.5c1.2 1 2.6 1.5 4 1.5s2.8-.5 4-1.5" stroke="#1F3557" stroke-width="1.6" fill="none" stroke-linecap="round"/>
            </svg>
        `;
    }
    return `
        <svg class="footprint-avatar female" viewBox="0 0 48 48" aria-hidden="true">
            <circle cx="24" cy="16" r="9" fill="#FFC0D6"/>
            <path d="M10 43c0-8 6-14 14-14s14 6 14 14" fill="#FF6FA6"/>
            <circle cx="20.5" cy="16.5" r="1.2" fill="#5A1F3B"/>
            <circle cx="27.5" cy="16.5" r="1.2" fill="#5A1F3B"/>
            <path d="M20 20.5c1.2 1 2.6 1.5 4 1.5s2.8-.5 4-1.5" stroke="#5A1F3B" stroke-width="1.6" fill="none" stroke-linecap="round"/>
        </svg>
    `;
}

(function() {
    window.toggleAddFootprintPanel = toggleAddFootprintPanel;
    window.saveFootprint = saveFootprint;
    window.editFootprint = editFootprint;
    window.deleteFootprint = deleteFootprint;
    window.focusFootprint = focusFootprint;
})();
