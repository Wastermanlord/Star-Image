import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { check } from '@tauri-apps/plugin-updater';


const state = {
  images: [],
  thumbCache: {},
  currentIndex: -1,
  zoom: 1,
  fitMode: true,
  mode: 'empty',
  recent: [],
  theme: localStorage.getItem('star-theme') || 'dark',
  nativeW: 0,
  nativeH: 0,
  slideshow: false,
  slideshowTimer: null,
};

let _panning = false, _panStart = {}, _panOffset = { x: 0, y: 0 };
let _thumbRendered = false;
let _currentDir = '';

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelector(sel);
const $$$ = (sel) => document.querySelectorAll(sel);

let _menuTimer = null;
function showControlsTemporarily() {
  const menu = $('imgMenu');
  if (!menu) return;
  menu.classList.remove('fade-out');
  clearTimeout(_menuTimer);
  _menuTimer = setTimeout(() => {
    if (state.mode !== 'empty' && !_panning) {
      menu.classList.add('fade-out');
    }
  }, 2200);
}

document.addEventListener('DOMContentLoaded', async () => {
  applyTheme();
  bindEvents();
  $('sidebar').classList.add('closed');
  updatePathDisplay('');
  await loadRecent();
  // Restore last folder
  const lastDir = localStorage.getItem('star-last-dir');
  if (lastDir) {
    try {
      const files = await invoke('scan_directory', { path: lastDir });
      if (files.length > 0) {
        await invoke('add_folder_scope', { path: lastDir });
        state.images = files;
        state.currentIndex = 0;
        showImage(0);
        renderThumbnails();
        if (!$('sidebar').classList.contains('closed')) toggleSidebar();
        preloadThumbnailsAsync(files);
        updatePathDisplay(lastDir);
      }
    } catch {}
  }

  // Clean stale thumbnails and check for updates
  invoke('clean_thumb_cache').catch(() => {});
  setTimeout(checkForUpdatesSilent, 2000);
});

function checkForUpdatesSilent() {
  if (typeof check !== 'function') return;
  check().then((result) => {
    if (result) {
      const status = $('updateStatus');
      if (status) status.textContent = `Actualización disponible: ${result.version}`;
    }
  }).catch(() => {});
}

function handleImageReady() {
  const mainImg = $('mainImage');
  if (mainImg.naturalWidth && mainImg.naturalHeight) {
    state.nativeW = mainImg.naturalWidth;
    state.nativeH = mainImg.naturalHeight;
    $('infoResolution').textContent = `${state.nativeW} × ${state.nativeH}`;
  }
  const img = state.images[state.currentIndex];
  if (img) updateBadge(img, { width: state.nativeW, height: state.nativeH, size: 0 });
  if (state.nativeW && state.fitMode) {
    fitToWindow();
  } else if (state.nativeW) {
    applyZoom();
  }
  $('loadingOverlay').style.display = 'none';
}

function setMode(mode) {
  state.mode = mode;
  const c = $('imageContainer');
  c.classList.toggle('is-zoomed', mode === 'zoom' || mode === 'pan');
  c.classList.toggle('is-pan', mode === 'pan');
  const img = $('mainImage');
  if (mode === 'empty') img.style.cursor = 'default';
  else if (mode === 'pan') img.style.cursor = 'grabbing';
  else if (mode === 'zoom') img.style.cursor = 'grab';
  else img.style.cursor = 'default';
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.style.display = 'none', 2000);
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  $('themeBtn').querySelector('i').className = state.theme === 'dark' ? 'ph ph-sun' : 'ph ph-moon';
}

function bindEvents() {
  $('openBtn').onclick = openImage;
  $('folderBtn').onclick = openFolder;
  $('searchBtn').onclick = toggleSearch;
  $('themeBtn').onclick = toggleTheme;
  $('toggleSidebar').onclick = toggleSidebar;
  $('toggleSidebarBtn').onclick = toggleSidebar;

  $('emptyOpenBtn').onclick = openImage;
  $('emptyFolderBtn').onclick = openFolder;

  $('prevBtn').onclick = prevImage;
  $('nextBtn').onclick = nextImage;
  $('navLeft').onclick = prevImage;
  $('navRight').onclick = nextImage;

  $('zoomInBtn').onclick = () => zoomChange(1);
  $('zoomOutBtn').onclick = () => zoomChange(-1);
  $('fitBtn').onclick = fitToWindow;
  $('fullscreenBtn').onclick = toggleFullscreen;

  $('searchInput').onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
  $('searchCloseBtn').onclick = toggleSearch;

  $('deleteBtn').onclick = deleteCurrentImage;
  $('refreshBtn').onclick = refreshDir;
  $('exifToggle').onclick = toggleExif;
  $('infoFileName').onclick = startRename;
  $('renameInput').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmRename(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
  };
  $('renameInput').onblur = confirmRename;
  $('confirmCancel').onclick = hideConfirm;
  $('confirmOk').onclick = confirmDelete;
  $('confirmModal').onclick = (e) => { if (e.target === $('confirmModal')) hideConfirm(); };

  $('galleryBtn').onclick = toggleGallery;
  $('galleryFilter').oninput = renderGallery;
  $('galleryGrid').onclick = (e) => {
    const item = e.target.closest('.gallery-item');
    if (item) { toggleGallery(); showImage(parseInt(item.dataset.index)); }
  };
  $('helpBtn').onclick = toggleShortcuts;
  $('shortcutsClose').onclick = toggleShortcuts;
  $('shortcutsModal').onclick = (e) => { if (e.target === $('shortcutsModal')) toggleShortcuts(); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('shortcutsModal').style.display !== 'none') { toggleShortcuts(); }
  });

  $('slideshowBtn').onclick = toggleSlideshow;
  $('aboutBtn').onclick = toggleAbout;
  $('aboutClose').onclick = toggleAbout;
  $('aboutModal').onclick = (e) => { if (e.target === $('aboutModal')) toggleAbout(); };
  $('aboutGitHub').onclick = (e) => { e.preventDefault(); invoke('open_folder', { path: 'https://github.com/Wastermanlord/Star-Image' }); };
  $('checkUpdateBtn').onclick = checkForUpdates;
  $('downloadUpdateBtn').onclick = downloadUpdate;
  $('installUpdateBtn').onclick = installUpdate;
  $('toggleInfoBar').onclick = toggleInfoBar;
  $('infoBtn').onclick = toggleInfoBar;
  $('infoBar').classList.add('collapsed');

  $('ctxOpen').onclick = () => { hideCtxMenu(); openImage(); };
  $('ctxFolder').onclick = () => { hideCtxMenu(); openFolder(); };
  $('ctxFullscreen').onclick = () => { hideCtxMenu(); toggleFullscreen(); };
  $('ctxCopyPath').onclick = () => { hideCtxMenu(); copyCurrentPath(); };
  $('ctxDelete').onclick = () => { hideCtxMenu(); deleteCurrentImage(); };

  document.addEventListener('keydown', onKey);
  document.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('click', hideCtxMenu);

  document.addEventListener('dragover', (e) => { e.preventDefault(); $('dropOverlay').classList.add('drag-over'); });
  document.addEventListener('dragleave', (e) => { e.preventDefault(); $('dropOverlay').classList.remove('drag-over'); });
  document.addEventListener('drop', onDrop);

  $('imageContainer').addEventListener('mousemove', () => {
    showControlsTemporarily();
  });

  window.addEventListener('resize', () => {
    if (state.fitMode) {
      fitToWindow();
    } else {
      applyZoom();
    }
  });

  $('mainImage').onload = () => {
    handleImageReady();
  };
  $('mainImage').onerror = () => {
    $('loadingOverlay').style.display = 'none';
    toast('Error al cargar la imagen');
  };

  $('mainImage').ondblclick = () => {
    if (!state.nativeW) return;
    const fitZoom = getFitZoom();
    if (state.fitMode || Math.abs(state.zoom - fitZoom) / fitZoom < 0.02) {
      state.fitMode = false;
      state.zoom = 1.0;
      _panOffset = { x: 0, y: 0 };
      applyZoom();
      setMode('zoom');
    } else {
      fitToWindow();
    }
  };

  // Timeout: if image takes > 10s, hide loading anyway
  let loadTimeout;
  $('mainImage').addEventListener('loadstart', () => {
    clearTimeout(loadTimeout);
    loadTimeout = setTimeout(() => {
      $('loadingOverlay').style.display = 'none';
    }, 10000);
  });

  $('imageContainer').onwheel = (e) => {
    e.preventDefault();
    handleWheelZoom(e);
  };

  $('mainImage').onmousedown = (e) => {
    if (state.fitMode && state.zoom <= getFitZoom()) return;
    e.preventDefault();
    _panning = true;
    setMode('pan');
    _panStart = { x: e.clientX - _panOffset.x, y: e.clientY - _panOffset.y };
  };

  let _rafPending = false;
  document.onmousemove = (e) => {
    if (!_panning) return;
    showControlsTemporarily();
    _panOffset = { x: e.clientX - _panStart.x, y: e.clientY - _panStart.y };
    if (!_rafPending) {
      _rafPending = true;
      requestAnimationFrame(() => {
        applyZoom();
        _rafPending = false;
      });
    }
  };

  document.onmouseup = () => {
    if (!_panning) return;
    _panning = false;
    setMode(state.fitMode ? 'normal' : 'zoom');
  };

  $('thumbnailList').onclick = (e) => {
    const item = e.target.closest('.thumb-item');
    if (item) showImage(parseInt(item.dataset.index));
  };
}

async function openImage() {
  const result = await open({
    multiple: false,
    filters: [{ name: 'Imágenes', extensions: ['png','jpg','jpeg','gif','bmp','webp','ico','tiff','tif','svg','avif'] }],
  });
  if (!result) return;
  await loadFromFile(result);
}

async function openFolder() {
  const result = await open({ directory: true, multiple: false });
  if (!result) return;
  await loadFromDir(result);
}

async function loadFromFile(path) {
  try {
    await invoke('add_folder_scope', { path });
    const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
    const files = await invoke('scan_directory', { path: dir });
    const idx = files.findIndex(f => f.path === path);
    if (idx >= 0) {
      state.images = files;
      state.currentIndex = idx;
      showImage(idx);
      renderThumbnails();
      preloadThumbnailsAsync(files);
      invoke('save_recent_path', { path: dir }).catch(() => {});
      updatePathDisplay(dir);
      localStorage.setItem('star-last-dir', dir);
    }
  } catch (e) { console.error(e); }
}

async function loadFromDir(dir) {
  try {
    await invoke('add_folder_scope', { path: dir });
    const files = await invoke('scan_directory', { path: dir });
    if (files.length === 0) { toast('No se encontraron imágenes'); return; }
    state.images = files;
    state.currentIndex = 0;
    showImage(0);
    renderThumbnails();
    if ($('sidebar').classList.contains('closed')) {
      toggleSidebar();
    }
    preloadThumbnailsAsync(files);
    invoke('save_recent_path', { path: dir }).catch(() => {});
    updatePathDisplay(dir);
    localStorage.setItem('star-last-dir', dir);
  } catch (e) { console.error(e); }
}

async function refreshDir() {
  if (!_currentDir) return;
  const dir = _currentDir;
  try {
    const files = await invoke('scan_directory', { path: dir });
    state.images = files;
    if (files.length === 0) {
      state.mode = 'empty';
      $('emptyState').style.display = 'flex';
      $('imageContainer').style.display = 'none';
      $('imgMenu').style.display = 'none';
      $('infoBar').style.display = 'none';
      $('exifSection').style.display = 'none';
      $('thumbnailList').innerHTML = '';
      _thumbRendered = false;
      $('sidebar').classList.add('closed');
      toast('Carpeta vacía');
      return;
    }
    state.currentIndex = Math.min(state.currentIndex, files.length - 1);
    showImage(state.currentIndex);
    renderThumbnails();
    preloadThumbnailsAsync(files);
    toast('Carpeta recargada');
  } catch (e) {
    toast('Error al recargar');
  }
}

async function preloadThumbnailsAsync(files) {
  try {
    const chunkSize = 15;
    for (let i = 0; i < files.length; i += chunkSize) {
      const chunk = files.slice(i, i + chunkSize);
      const paths = chunk.map(f => f.path);
      const thumbs = await invoke('get_thumbnails', { paths });
      chunk.forEach((f, idx) => {
        state.thumbCache[f.path] = thumbs[idx] || f.path;
      });
      if (_thumbRendered) {
        chunk.forEach(f => {
          const item = document.querySelector(`.thumb-item[data-index="${files.indexOf(f)}"] img`);
          if (item && state.thumbCache[f.path]) {
            item.src = convertFileSrc(state.thumbCache[f.path]);
          }
        });
      }
    }
  } catch {}
}

function getFitZoom() {
  if (!state.nativeW || !state.nativeH) return 1;
  const c = $('imageContainer');
  const cw = c.clientWidth || window.innerWidth;
  const ch = c.clientHeight || window.innerHeight;
  return Math.min(cw / state.nativeW, ch / state.nativeH);
}

function resetZoom() {
  state.fitMode = true;
  _panOffset = { x: 0, y: 0 };
  const fitZoom = getFitZoom();
  state.zoom = fitZoom;
  const img = $('mainImage');
  img.style.transform = 'translate3d(0px, 0px, 0px) scale(1)';
  img.style.width = '';
  img.style.height = '';
  setMode('normal');
}

function showImage(index) {
  if (index < 0 || index >= state.images.length) return;
  state.currentIndex = index;

  $('emptyState').style.display = 'none';
  $('imageContainer').style.display = 'flex';
  $('imgMenu').style.display = 'flex';
  $('infoBar').style.display = 'block';

  const imgItem = state.images[index];
  const targetSrc = convertFileSrc(imgItem.path);

  const mainImg = $('mainImage');
  if (mainImg.src !== targetSrc) {
    clearTimeout(mainImg._spinTimer);
    mainImg._spinTimer = setTimeout(() => {
      if (mainImg.src === targetSrc && !mainImg.complete) {
        $('loadingOverlay').style.display = 'flex';
      }
    }, 120);
    resetZoom();
    mainImg.src = targetSrc;
  }

  $('infoFileName').textContent = imgItem.name;
  cancelRename();
  updateCounter();
  updateThumbnailSelection();
  updateInfo(imgItem);
  loadExif(imgItem.path);
  if (typeof showControlsTemporarily === 'function') showControlsTemporarily();
}

async function updateInfo(imgItem) {
  try {
    const info = await invoke('get_image_info', { path: imgItem.path });
    if (info.width && info.height) {
      state.nativeW = info.width;
      state.nativeH = info.height;
    }
    $('infoResolution').textContent = info.width ? `${info.width} × ${info.height}` : '—';
    $('infoSize').textContent = formatSize(info.size);
    updateBadge(imgItem, info);
    if (state.fitMode && state.nativeW) fitToWindow();
  } catch {}
}

function updateBadge(imgItem, info) {
  const name = imgItem.name;
  let text = name;
  if (info && info.width && info.height) {
    text += ` · ${info.width}×${info.height}`;
  }
  if (info && info.size) {
    text += ` · ${formatSize(info.size)}`;
  }
  $('badgeInfo').textContent = text;
}

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes > 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

function updateCounter() {
  $('counterInfo').textContent = `${state.currentIndex + 1} / ${state.images.length}`;
}

function updatePathDisplay(dir) {
  _currentDir = dir || '';
  const d = _currentDir;
  const parts = d.split('/').filter(Boolean);
  const pathEl = $('pathDisplay');
  const sepEl = document.querySelector('.path-sep');
  const refreshBtn = $('refreshBtn');
  if (d) {
    pathEl.textContent = parts.length > 4 ? '.../' + parts.slice(-3).join('/') : d;
    if (sepEl) sepEl.classList.remove('hidden');
    refreshBtn.style.display = 'flex';
  } else {
    pathEl.textContent = '';
    if (sepEl) sepEl.classList.add('hidden');
    refreshBtn.style.display = 'none';
  }
}

// ─── SLIDESHOW ───────────────────────────────────────────────────────────────
function toggleSlideshow() {
  if (state.mode === 'empty' || !state.images.length) return;
  state.slideshow = !state.slideshow;
  $('slideshowBtn').classList.toggle('active', state.slideshow);
  if (state.slideshow) {
    $('slideshowBtn').querySelector('i').className = 'ph ph-stop';
    advanceSlideshow();
  } else {
    $('slideshowBtn').querySelector('i').className = 'ph ph-play';
    clearTimeout(state.slideshowTimer);
  }
}

function advanceSlideshow() {
  if (!state.slideshow) return;
  nextImage();
  state.slideshowTimer = setTimeout(advanceSlideshow, 3000);
}

// ─── ABOUT ───────────────────────────────────────────────────────────────────
function toggleAbout() {
  const m = $('aboutModal');
  m.style.display = m.style.display === 'none' ? 'flex' : 'none';
}

let _update = null;

async function checkForUpdates() {
  const status = $('updateStatus');
  const checkBtn = $('checkUpdateBtn');
  const downloadBtn = $('downloadUpdateBtn');
  const installBtn = $('installUpdateBtn');
  const progress = $('updateProgress');

  status.textContent = 'Buscando actualizaciones...';
  checkBtn.disabled = true;
  downloadBtn.style.display = 'none';
  installBtn.style.display = 'none';
  progress.style.display = 'none';

  try {
    const result = await check();
    if (!result) {
      status.textContent = 'Tienes la versión más reciente.';
      checkBtn.disabled = false;
      return;
    }
    _update = result;
    status.textContent = `Nueva versión disponible: ${result.version}`;
    downloadBtn.style.display = 'inline-flex';
    checkBtn.disabled = false;
  } catch (e) {
    status.textContent = 'Error al buscar actualizaciones.';
    checkBtn.disabled = false;
  }
}

async function downloadUpdate() {
  if (!_update) return;
  const downloadBtn = $('downloadUpdateBtn');
  const installBtn = $('installUpdateBtn');
  const status = $('updateStatus');
  const progress = $('updateProgress');
  const fill = $('updateProgressFill');
  const pct = $('updateProgressText');

  downloadBtn.style.display = 'none';
  progress.style.display = 'block';
  status.textContent = 'Descargando...';

  await _update.download((event) => {
    switch (event.event) {
      case 'progress': {
        const percent = (event.data.current / event.data.total) * 100;
        fill.style.width = percent + '%';
        pct.textContent = Math.round(percent) + '%';
        break;
      }
      case 'done':
        fill.style.width = '100%';
        pct.textContent = '100%';
        break;
    }
  });

  status.textContent = 'Actualización descargada. Se instalará al cerrar la app.';
  installBtn.style.display = 'inline-flex';
}

async function installUpdate() {
  if (!_update) return;
  await _update.install();
}

// ─── INFOBAR ─────────────────────────────────────────────────────────────────
function toggleInfoBar() {
  const bar = $('infoBar');
  const closed = bar.classList.contains('collapsed');
  bar.classList.toggle('collapsed', !closed);
  $('toggleInfoBar').querySelector('i').className = closed ? 'ph ph-caret-double-left' : 'ph ph-caret-double-right';
  $('infoBtn').classList.toggle('active', closed);
  if (closed) setTimeout(() => { if (state.nativeW && state.fitMode) fitToWindow(); }, 300);
}

// ─── GALLERY ──────────────────────────────────────────────────────────────────────
let _galleryOpen = false;

function toggleGallery() {
  if (state.mode === 'empty' || !state.images.length) return;
  _galleryOpen = !_galleryOpen;
  $('galleryView').style.display = _galleryOpen ? 'flex' : 'none';
  $('imageContainer').style.display = _galleryOpen ? 'none' : 'flex';
  $('imgMenu').style.display = _galleryOpen ? 'none' : 'flex';
  $('galleryBtn').classList.toggle('active', _galleryOpen);
  if (_galleryOpen) {
    $('searchPanel').style.display = 'none';
    renderGallery();
  }
}

function renderGallery() {
  const q = ($('galleryFilter').value || '').toLowerCase();
  const filtered = q ? state.images.filter(i => i.name.toLowerCase().includes(q)) : state.images;
  const grid = $('galleryGrid');
  if (!filtered.length) {
    grid.innerHTML = '<div class="gallery-empty">Sin resultados</div>';
    $('galleryCount').textContent = '0';
    return;
  }
  $('galleryCount').textContent = `${filtered.length} / ${state.images.length}`;
  grid.innerHTML = filtered.map((img, i) => {
    const thumbPath = state.thumbCache[img.path] || img.path;
    return `<div class="gallery-item" data-index="${state.images.indexOf(img)}">
      <img src="${convertFileSrc(thumbPath)}" loading="lazy" alt="${img.name}">
      <span class="gallery-item-name">${img.name}</span>
    </div>`;
  }).join('');
}

// ─── SHORTCUTS ─────────────────────────────────────────────────────────────────
function toggleShortcuts() {
  const modal = $('shortcutsModal');
  modal.style.display = modal.style.display === 'none' ? 'flex' : 'none';
}

// ─── EXIF ──────────────────────────────────────────────────────────────────────
async function loadExif(path) {
  const section = $('exifSection');
  try {
    const exif = await invoke('get_exif', { path });
    const hasData = exif.camera || exif.software || exif.date_time || exif.aperture || exif.shutter || exif.iso || exif.focal_length || exif.flash || exif.orientation;
    if (!hasData) {
      section.style.display = 'none';
      return;
    }
    section.style.display = 'block';
    $('exifEmpty').style.display = 'none';
    $('exifCamera').textContent = exif.camera || '—';
    $('exifSoftware').textContent = exif.software || '—';
    $('exifDate').textContent = exif.date_time || '—';
    $('exifAperture').textContent = exif.aperture || '—';
    $('exifShutter').textContent = exif.shutter || '—';
    $('exifIso').textContent = exif.iso != null ? String(exif.iso) : '—';
    $('exifFocal').textContent = exif.focal_length || '—';
    $('exifFlash').textContent = exif.flash || '—';
    $('exifOrientation').textContent = exif.orientation || '—';
    if (exif.gps_lat != null && exif.gps_lon != null) {
      $('exifGpsRow').style.display = 'flex';
      $('exifGpsLink').href = `https://www.openstreetmap.org/?mlat=${exif.gps_lat}&mlon=${exif.gps_lon}#map=15/${exif.gps_lat}/${exif.gps_lon}`;
    } else {
      $('exifGpsRow').style.display = 'none';
    }
  } catch {
    section.style.display = 'none';
  }
}

function toggleExif() {
  $('exifToggle').classList.toggle('collapsed');
}

// ─── DELETE ─────────────────────────────────────────────────────────────────────
function deleteCurrentImage() {
  if (state.mode === 'empty' || !state.images.length) return;
  const img = state.images[state.currentIndex];
  showConfirm(`¿Mover "${img.name}" a la papelera?`);
}

function showConfirm(msg) {
  $('confirmMsg').textContent = msg;
  $('confirmModal').style.display = 'flex';
}

function hideConfirm() {
  $('confirmModal').style.display = 'none';
}

async function confirmDelete() {
  hideConfirm();
  const idx = state.currentIndex;
  const img = state.images[idx];
  if (!img) return;
  try {
    await invoke('trash_file', { path: img.path });
    toast('Imagen movida a la papelera');
    state.images.splice(idx, 1);
    if (state.images.length === 0) {
      state.mode = 'empty';
      $('emptyState').style.display = 'flex';
      $('imageContainer').style.display = 'none';
      $('imgMenu').style.display = 'none';
      $('infoBar').style.display = 'none';
      $('exifSection').style.display = 'none';
      $('thumbnailList').innerHTML = '';
      _thumbRendered = false;
      $('sidebar').classList.add('closed');
    } else {
      const nextIdx = Math.min(idx, state.images.length - 1);
      showImage(nextIdx);
      renderThumbnails();
    }
  } catch (e) {
    toast('Error al eliminar: ' + e);
  }
}

// ─── RENAME ─────────────────────────────────────────────────────────────────────
let _renameOpen = false;

function startRename() {
  if (state.mode === 'empty') return;
  const span = $('infoFileName');
  const input = $('renameInput');
  const full = span.textContent;
  input.value = full;
  input.style.display = 'block';
  span.style.display = 'none';
  _renameOpen = true;
  input.focus();
  const dotIdx = full.lastIndexOf('.');
  if (dotIdx > 0) {
    input.setSelectionRange(0, dotIdx);
  } else {
    input.select();
  }
}

function confirmRename() {
  if (!_renameOpen) return;
  const span = $('infoFileName');
  const input = $('renameInput');
  let newName = input.value.trim();
  const img = state.images[state.currentIndex];
  if (!img || !newName) { cancelRename(); return; }
  const oldName = img.name;
  if (newName === oldName) { cancelRename(); return; }
  const dotIdx = oldName.lastIndexOf('.');
  const oldExt = dotIdx > 0 ? oldName.slice(dotIdx) : '';
  if (oldExt && newName.indexOf('.') === -1 && newName !== oldName) {
    newName += oldExt;
  }
  invoke('rename_file', { path: img.path, newName })
    .then((newPath) => {
      img.name = newName;
      img.path = newPath;
      span.textContent = newName;
      toast('Archivo renombrado');
      renderThumbnails();
      updateThumbnailSelection();
    })
    .catch((e) => {
      toast('Error al renombrar');
      cancelRename();
    });
  input.style.display = 'none';
  span.style.display = 'block';
  _renameOpen = false;
}

function cancelRename() {
  if (!_renameOpen) return;
  const span = $('infoFileName');
  const input = $('renameInput');
  input.style.display = 'none';
  span.style.display = 'block';
  _renameOpen = false;
}

// ─── Zoom por botones (suave con snapping) ───────────────────────────────────
function zoomChange(dir) {
  if (!state.nativeW || !state.nativeH) return;
  const fitZoom = getFitZoom();
  if (state.fitMode) {
    state.zoom = fitZoom;
    state.fitMode = false;
  }

  const factor = 1.15;
  state.zoom = dir > 0 ? state.zoom * factor : state.zoom / factor;

  const minZoom = fitZoom * 0.1;
  const maxZoom = 50;
  state.zoom = Math.max(minZoom, Math.min(maxZoom, state.zoom));

  // Snap to 1.0 (100% native)
  if (Math.abs(state.zoom - 1.0) < 0.03) state.zoom = 1.0;
  // Snap to fitZoom
  if (Math.abs(state.zoom - fitZoom) / fitZoom < 0.03) {
    state.zoom = fitZoom;
    state.fitMode = true;
    _panOffset = { x: 0, y: 0 };
  }

  applyZoom();
  setMode(state.fitMode ? 'normal' : 'zoom');
}

// ─── Zoom por rueda del ratón (focal point al cursor, sin snapping abrupto) ──
let _wheelRaf = false;
function handleWheelZoom(e) {
  if (!state.nativeW || !state.nativeH) return;

  const fitZoom = getFitZoom();
  // Si estamos en fitMode, arrancar desde el zoom actual para no hacer snap
  if (state.fitMode) {
    state.zoom = fitZoom;
    state.fitMode = false;
  }

  // Factor continuo y suave basado en el desplazamiento real
  const delta = e.deltaY !== 0 ? e.deltaY : (e.deltaX || 0);
  const factor = Math.exp(-delta * 0.0012);
  const prevZoom = state.zoom;
  const nextZoom = Math.max(fitZoom * 0.05, Math.min(50, prevZoom * factor));

  // Snap suave a fitZoom solo si estamos MUY cerca y ya nos estamos encogiendo
  if (delta > 0 && nextZoom < fitZoom * 1.04) {
    state.zoom = fitZoom;
    state.fitMode = true;
    _panOffset = { x: 0, y: 0 };
    applyZoom();
    setMode('normal');
    return;
  }

  // ── Punto focal al cursor del ratón ──
  // Traemos la posición del puntero relativa al imageContainer
  const container = $('imageContainer');
  const rect = container.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  const cx = rect.width / 2;
  const cy = rect.height / 2;

  // Ajustamos el offset de pan para que el punto bajo el cursor quede fijo
  const scaleRatio = nextZoom / prevZoom;
  _panOffset.x = mouseX - cx + ((_panOffset.x - (mouseX - cx)) * scaleRatio);
  _panOffset.y = mouseY - cy + ((_panOffset.y - (mouseY - cy)) * scaleRatio);

  state.zoom = nextZoom;

  if (!_wheelRaf) {
    _wheelRaf = true;
    requestAnimationFrame(() => {
      applyZoom();
      setMode('zoom');
      _wheelRaf = false;
    });
  }
}

function applyZoom() {
  if (!state.nativeW || !state.nativeH) return;
  const img = $('mainImage');
  const fitZoom = getFitZoom();

  const baseW = Math.round(state.nativeW * fitZoom);
  const baseH = Math.round(state.nativeH * fitZoom);

  if (img.style.width !== baseW + 'px') img.style.width = baseW + 'px';
  if (img.style.height !== baseH + 'px') img.style.height = baseH + 'px';

  const scale = state.fitMode ? 1 : (state.zoom / fitZoom);
  img.style.transform = `translate3d(${_panOffset.x}px, ${_panOffset.y}px, 0px) scale(${scale})`;
  updateZoomDisplay();
}

function fitToWindow() {
  if (!state.nativeW || !state.nativeH) return;
  state.fitMode = true;
  state.zoom = getFitZoom();
  _panOffset = { x: 0, y: 0 };
  applyZoom();
  setMode('normal');
}

function updateZoomDisplay() {
  let pct;
  if (state.fitMode) {
    pct = 'Ajustar';
  } else if (Math.abs(state.zoom - 1.0) < 0.005) {
    pct = '100%';
  } else {
    pct = Math.round(state.zoom * 100) + '%';
  }
  $('zoomLevel').textContent = pct;
}

function prevImage() {
  if (!state.images.length) return;
  const i = state.currentIndex <= 0 ? state.images.length - 1 : state.currentIndex - 1;
  preloadAdjacent(i);
  showImage(i);
}

function nextImage() {
  if (!state.images.length) return;
  const i = state.currentIndex >= state.images.length - 1 ? 0 : state.currentIndex + 1;
  preloadAdjacent(i);
  showImage(i);
}

const _preloadCache = new Map();
const PRELOAD_RADIUS = 2;  // fotos a cada lado que se mantienen en RAM
function preloadAdjacent(index) {
  if (!state.images.length) return;
  for (let offset = -PRELOAD_RADIUS; offset <= PRELOAD_RADIUS; offset++) {
    if (offset === 0) continue;
    const i = (index + offset + state.images.length) % state.images.length;
    const path = state.images[i]?.path;
    if (!path || _preloadCache.has(path)) continue;
    const img = new Image();
    img.decoding = 'async';       // decodifica en hilo secundario
    img.fetchpriority = offset === -1 || offset === 1 ? 'high' : 'low';
    img.src = convertFileSrc(path);
    _preloadCache.set(path, img);
  }
  // Purgar entradas fuera de la ventana deslizante (mantener ≤ 12)
  if (_preloadCache.size > 12) {
    const keys = Array.from(_preloadCache.keys());
    const activeSet = new Set(
      [-PRELOAD_RADIUS, -1, 0, 1, PRELOAD_RADIUS].map(o =>
        state.images[(index + o + state.images.length) % state.images.length]?.path
      ).filter(Boolean)
    );
    for (const k of keys) {
      if (!activeSet.has(k)) {
        _preloadCache.delete(k);
        if (_preloadCache.size <= 8) break;
      }
    }
  }
}

function renderThumbnails() {
  _thumbRendered = true;
  const list = $('thumbnailList');
  const getSrc = (path) => {
    const cached = state.thumbCache[path];
    return cached ? convertFileSrc(cached) : convertFileSrc(path);
  };
  list.innerHTML = state.images.map((img, i) =>
    `<div class="thumb-item${i === state.currentIndex ? ' active' : ''}" data-index="${i}">
      <img src="${getSrc(img.path)}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23252540%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 font-size=%2230%22 fill=%22%238888aa%22>✦</text></svg>'">
      <span>${img.name}</span>
    </div>`
  ).join('');
}

function updateThumbnailSelection() {
  if (!_thumbRendered) return;
  const items = $$$('.thumb-item');
  let activeEl = null;
  for (let i = 0; i < items.length; i++) {
    const match = i === state.currentIndex;
    items[i].classList.toggle('active', match);
    if (match) activeEl = items[i];
  }
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

function toggleSidebar() {
  $('sidebar').classList.toggle('closed');
  const closed = $('sidebar').classList.contains('closed');
  $('toggleSidebar').querySelector('i').className = closed ? 'ph ph-caret-double-right' : 'ph ph-caret-double-left';
  $('toggleSidebarBtn').classList.toggle('active', !closed);
}

async function toggleFullscreen() {
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen();
    document.documentElement.classList.add('is-fullscreen');
  } else {
    await document.exitFullscreen();
    document.documentElement.classList.remove('is-fullscreen');
  }
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) document.documentElement.classList.remove('is-fullscreen');
});

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('star-theme', state.theme);
  applyTheme();
}

function toggleSearch() {
  const p = $('searchPanel');
  if (p.style.display === 'none') {
    p.style.display = 'flex';
    $('searchInput').focus();
  } else {
    p.style.display = 'none';
  }
}

async function doSearch() {
  const q = $('searchInput').value.trim().toLowerCase();
  if (!q) { $('searchResults').innerHTML = '<div class="search-empty">Escribe para buscar...</div>'; return; }
  try {
    const recent = await invoke('get_recent_paths');
    const root = recent.paths && recent.paths[0];
    if (!root) {
      $('searchResults').innerHTML = '<div class="search-empty">Abrí una carpeta primero</div>';
      return;
    }
    const results = await invoke('search_images', { path: root });
    const dirs = new Set(results.map(f => f.path.includes('/') ? f.path.substring(0, f.path.lastIndexOf('/')) : ''));
    for (const d of dirs) { if (d) invoke('add_folder_scope', { path: d }).catch(() => {}); }
    const filtered = results.filter(f => f.name.toLowerCase().includes(q)).slice(0, 100);
    const container = $('searchResults');
    if (!filtered.length) {
      container.innerHTML = '<div class="search-empty">Sin resultados</div>';
      return;
    }
    container.innerHTML = filtered.map(f =>
      `<div class="search-result-item" data-path="${f.path}">
        <img src="${convertFileSrc(f.path)}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23252540%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 font-size=%2230%22 fill=%22%238888aa%22>✦</text></svg>'">
        <span>${f.name}</span>
      </div>`
    ).join('');
    container.querySelectorAll('.search-result-item').forEach(el => {
      el.onclick = async () => { await loadFromFile(el.dataset.path); toggleSearch(); };
    });
  } catch (e) { console.error(e); }
}

async function loadRecent() {
  try {
    const r = await invoke('get_recent_paths');
    state.recent = r.paths || [];
    const list = $('recentList');
    const area = $('recentArea');
    if (state.recent.length > 0 && list && area) {
      area.style.display = 'flex';
      list.innerHTML = state.recent.slice(0, 4).map(p => {
        const name = p.split('/').filter(Boolean).pop() || p;
        return `<div class="recent-item" data-path="${p}">
          <i class="ph ph-folder"></i>
          <span>${name}</span>
        </div>`;
      }).join('');
      list.querySelectorAll('.recent-item').forEach(el => {
        el.onclick = () => loadFromDir(el.dataset.path);
      });
    }
  } catch {}
}

function onKey(e) {
  if (e.target === $('renameInput')) return;
  if (e.key === 'ArrowLeft' && !e.ctrlKey) { e.preventDefault(); prevImage(); }
  else if (e.key === 'ArrowRight' && !e.ctrlKey) { e.preventDefault(); nextImage(); }
  else if (e.key === 'Escape') {
    if ($('aboutModal').style.display !== 'none') { toggleAbout(); return; }
    if ($('contextMenu').style.display !== 'none') { hideCtxMenu(); return; }
    $('searchPanel').style.display = 'none';
  }
  else if (e.key === 's' && !e.ctrlKey) { e.preventDefault(); toggleSlideshow(); }
  else if (e.key === 'f' && !e.ctrlKey) { e.preventDefault(); toggleFullscreen(); }
  else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomChange(1); }
  else if (e.key === '-') { e.preventDefault(); zoomChange(-1); }
  else if (e.key === '0') { e.preventDefault(); fitToWindow(); }
  else if (e.key === 'o' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openImage(); }
  else if ((e.key === 'b' && (e.ctrlKey || e.metaKey)) || e.key === '\\') { e.preventDefault(); toggleSidebar(); }
  else if (e.key === 'g' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); toggleGallery(); }
  else if (e.key === 'i' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); toggleInfoBar(); }
  else if (e.key === '/' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); toggleShortcuts(); }
  else if (e.key === 'Delete' && state.mode !== 'empty') { e.preventDefault(); deleteCurrentImage(); }
  else if (e.key === 'F5') { e.preventDefault(); refreshDir(); }
  else if (e.key === 'Escape' && _galleryOpen) { toggleGallery(); }
}

function onContextMenu(e) {
  e.preventDefault();
  const m = $('contextMenu');
  m.style.display = 'flex';
  m.style.left = Math.min(e.clientX, window.innerWidth - 190) + 'px';
  m.style.top = Math.min(e.clientY, window.innerHeight - 180) + 'px';
}

function hideCtxMenu() { $('contextMenu').style.display = 'none'; }

async function copyCurrentPath() {
  const img = state.images[state.currentIndex];
  if (img) {
    try { await navigator.clipboard.writeText(img.path); toast('Ruta copiada'); } catch {}
  }
}

async function onDrop(e) {
  e.preventDefault();
  $('dropOverlay').classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files);
  const img = files.find(i => /\.(png|jpg|jpeg|gif|bmp|webp|ico|tiff|tif|svg|avif)$/i.test(i.name));
  if (img && img.path) await loadFromFile(img.path);
}
