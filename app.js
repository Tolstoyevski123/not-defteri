// Notlar gizli bir GitHub reposunda (DATA_REPO) tek bir notes.json dosyasında tutulur.
const DATA_OWNER = 'Tolstoyevski123';
const DATA_REPO = 'not-defteri-veri';
const DATA_FILE = 'notes.json';
const CFG_KEY = 'notdefteri.cfg';
const REFRESH_MS = 30000;

const $ = (id) => document.getElementById(id);

let cfg = readCfg();
const state = { notes: [], filter: 'Hepsi', query: '', editing: null, loading: false };

// ---------- Ayarlar ----------
function readCfg() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY)) || null; } catch { return null; }
}
function writeCfg(c) {
  cfg = c;
  try {
    if (c) localStorage.setItem(CFG_KEY, JSON.stringify(c));
    else localStorage.removeItem(CFG_KEY);
  } catch { /* depolama kapalıysa oturum boyunca bellekte kalır */ }
}

// ---------- GitHub API ----------
class AuthError extends Error {}

function api(path, opts = {}, token = cfg.token) {
  const { headers, ...rest } = opts;
  return fetch(`https://api.github.com/repos/${DATA_OWNER}/${DATA_REPO}/${path}`, {
    cache: 'no-store',
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...headers,
    },
  });
}

function decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}
function encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function fetchNotes(token) {
  const res = await api(`contents/${DATA_FILE}`, {}, token);
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new AuthError('Anahtar geçersiz ya da not reposuna erişim yok.');
  }
  if (!res.ok) throw new Error(`GitHub hatası (${res.status})`);
  const file = await res.json();
  let b64 = file.content;
  if (!b64) {
    // 1 MB üstü dosyalarda içerik blob API'sinden alınır
    const blob = await api(`git/blobs/${file.sha}`, {}, token);
    b64 = (await blob.json()).content;
  }
  return { notes: JSON.parse(decode(b64) || '[]'), sha: file.sha };
}

// Güncel dosyayı çekip değişikliği uygular; aynı anda başka biri kaydettiyse yeniden dener.
async function commit(message, mutate) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { notes, sha } = await fetchNotes();
    const next = mutate(notes);
    const res = await api(`contents/${DATA_FILE}`, {
      method: 'PUT',
      body: JSON.stringify({ message, sha, content: encode(JSON.stringify(next, null, 2)) }),
    });
    if (res.ok) {
      state.notes = next;
      return;
    }
    if (res.status === 409 || res.status === 422) continue;
    if (res.status === 401 || res.status === 403) throw new AuthError('Yazma izni yok. Anahtarı kontrol et.');
    throw new Error(`Kaydedilemedi (${res.status})`);
  }
  throw new Error('Çakışma oluştu, lütfen tekrar dene.');
}

// ---------- Medya (ses, fotoğraf, video) ----------
// Dosyalar veri reposunda media/<notId>/<ekId>.<uzantı> olarak saklanır.
const MAX_MB = 25;
const mediaCache = new Map(); // path -> object URL

function kindOf(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'audio';
}
function extOf(mime, name) {
  const fromName = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (/^[a-z0-9]{2,5}$/.test(fromName)) return fromName;
  const sub = (mime.split('/')[1] || 'bin').split(';')[0];
  return { jpeg: 'jpg', quicktime: 'mov', mpeg: 'mp3', 'x-m4a': 'm4a' }[sub] || sub;
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.slice(r.result.indexOf(',') + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function uploadMedia(path, blob) {
  const content = await blobToBase64(blob);
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await api(`contents/${path}`, {
      method: 'PUT',
      body: JSON.stringify({ message: `${cfg.name}: medya eklendi`, content }),
    });
    if (res.ok) return;
    if (res.status === 409) continue;
    if (res.status === 401 || res.status === 403) throw new AuthError('Yazma izni yok. Anahtarı kontrol et.');
    throw new Error(`Dosya yüklenemedi (${res.status})`);
  }
  throw new Error('Dosya yüklenemedi, tekrar dene.');
}

// Silme başarısız olursa not yine de güncellenmiş sayılır; dosya repoda kalır.
async function deleteMedia(list) {
  for (const a of list) {
    try {
      const res = await api(`contents/${a.path}`);
      if (!res.ok) continue;
      const { sha } = await res.json();
      await api(`contents/${a.path}`, {
        method: 'DELETE',
        body: JSON.stringify({ message: `${cfg.name}: medya silindi`, sha }),
      });
    } catch { /* yok say */ }
  }
}

async function mediaUrl(a) {
  if (mediaCache.has(a.path)) return mediaCache.get(a.path);
  // GitHub'ın verdiği kısa ömürlü indirme linki API'den çok daha hızlı; olmazsa API'den indir.
  let res;
  try {
    const meta = await api(`contents/${a.path}`);
    const { download_url: link } = meta.ok ? await meta.json() : {};
    if (link) res = await fetch(link);
  } catch { /* API'ye düş */ }
  if (!res?.ok) res = await api(`contents/${a.path}`, { headers: { Accept: 'application/vnd.github.raw' } });
  if (!res.ok) throw new Error(`Dosya açılamadı (${res.status})`);
  const url = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: a.mime }));
  mediaCache.set(a.path, url);
  return url;
}

// Düzenleyicideki ekler: mevcutlar {path,...}, yeniler {blob, url,...}
let draft = [];
let recorder = null;
let discardRecording = false;

function addBlob(blob, name = '') {
  if (blob.size > MAX_MB * 1024 * 1024) {
    toast(`Dosya çok büyük (en fazla ${MAX_MB} MB)`);
    return;
  }
  const mime = blob.type || 'application/octet-stream';
  draft.push({ id: crypto.randomUUID(), kind: kindOf(mime), mime, name, size: blob.size, blob, url: URL.createObjectURL(blob) });
  renderAttachments();
}

// Telefon fotoğrafları küçültülüp JPEG'e çevrilir (HEIC dahil); yükleme hızlanır, her tarayıcıda açılır.
const MAX_IMG_PX = 2048;
async function compressImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMG_PX / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.85));
    if (blob) return new File([blob], 'foto.jpg', { type: 'image/jpeg' });
  } catch { /* çözülemeyen formatta orijinal dosya kullanılır */ }
  return new File([file], file.name || 'foto', { type: file.type || 'image/jpeg' });
}

function renderAttachments() {
  const box = $('attachments');
  box.replaceChildren();
  const editable = !$('editor').classList.contains('readonly');
  for (const a of draft) {
    const item = document.createElement('div');
    item.className = 'att';
    const el = document.createElement(a.kind === 'image' ? 'img' : a.kind);
    if (a.kind !== 'image') {
      el.controls = true;
      el.preload = 'metadata';
      el.playsInline = true;
    }
    item.append(el);
    if (a.url) {
      el.src = a.url;
    } else {
      item.classList.add('loading');
      mediaUrl(a)
        .then((url) => { a.url = url; el.src = url; })
        .catch(() => item.classList.add('failed'))
        .finally(() => item.classList.remove('loading'));
    }
    if (editable) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'att-remove';
      x.textContent = '✕';
      x.title = 'Kaldır';
      x.onclick = () => {
        if (a.blob) URL.revokeObjectURL(a.url);
        draft = draft.filter((d) => d !== a);
        renderAttachments();
      };
      item.append(x);
    }
    box.append(item);
  }
}

async function toggleRecording() {
  const btn = $('rec-btn');
  if (recorder) { recorder.stop(); return; }
  if (!window.MediaRecorder) { toast('Bu tarayıcı ses kaydını desteklemiyor'); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast('Mikrofon izni verilmedi');
    return;
  }
  const chunks = [];
  const rec = new MediaRecorder(stream);
  recorder = rec;
  discardRecording = false;
  const started = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    btn.textContent = `⏹ Durdur ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const timer = setInterval(tick, 500);
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    btn.classList.remove('recording');
    btn.textContent = '🎤 Ses kaydet';
    if (!discardRecording && chunks.length) {
      addBlob(new Blob(chunks, { type: rec.mimeType || chunks[0].type || 'audio/webm' }), 'ses-kaydi');
    }
  };
  rec.start();
  btn.classList.add('recording');
  tick();
}

function closeEditorCleanup() {
  if (recorder) { discardRecording = true; recorder.stop(); }
  for (const a of draft) if (a.blob) URL.revokeObjectURL(a.url);
  draft = [];
  $('attachments').replaceChildren();
}

// ---------- Yardımcılar ----------
function colorFor(name) {
  let h = 0;
  for (const ch of name.toLocaleLowerCase('tr')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `hsl(${h % 360} 70% 55%)`;
}
function sameName(a, b) {
  return a.trim().toLocaleLowerCase('tr') === b.trim().toLocaleLowerCase('tr');
}
function fmtDate(iso) {
  return new Date(iso).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
}
function chip(name, tag = 'span') {
  const el = document.createElement(tag);
  el.className = 'chip';
  el.textContent = name;
  el.style.setProperty('--c', colorFor(name));
  return el;
}
let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function handleError(err) {
  if (err instanceof AuthError) {
    writeCfg(null);
    showSetup(err.message);
  } else if (err instanceof TypeError) {
    // fetch ağ hatası ("Failed to fetch" / "Load failed")
    toast('Bağlantı hatası: internetini kontrol edip tekrar dene.', 7000);
  } else {
    toast(err.message || 'Bir hata oluştu', 7000);
  }
}

// ---------- Görünüm ----------
function showSetup(error = '') {
  $('main').classList.add('hidden');
  $('setup').classList.remove('hidden');
  $('setup-error').textContent = error;
  $('setup-error').classList.toggle('hidden', !error);
}

function showMain() {
  $('setup').classList.add('hidden');
  $('main').classList.remove('hidden');
  const me = $('me-btn');
  me.textContent = cfg.name;
  me.style.setProperty('--c', colorFor(cfg.name));
  render();
  refresh();
}

function render() {
  // Yazar filtreleri
  const authors = [...new Set(state.notes.map((n) => n.author))];
  if (!authors.some((a) => sameName(a, cfg.name))) authors.unshift(cfg.name);
  if (state.filter !== 'Hepsi' && !authors.includes(state.filter)) state.filter = 'Hepsi';

  const filters = $('filters');
  filters.replaceChildren();
  for (const name of ['Hepsi', ...authors]) {
    const b = chip(name, 'button');
    if (name === 'Hepsi') b.style.setProperty('--c', 'var(--primary)');
    b.classList.toggle('active', state.filter === name);
    b.onclick = () => { state.filter = name; render(); };
    filters.append(b);
  }

  // Not kartları
  const q = state.query.toLocaleLowerCase('tr');
  const list = state.notes
    .filter((n) => state.filter === 'Hepsi' || n.author === state.filter)
    .filter((n) => !q || `${n.title}\n${n.content}`.toLocaleLowerCase('tr').includes(q))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const box = $('notes');
  box.replaceChildren();
  for (const n of list) {
    const card = document.createElement('article');
    card.className = 'note';
    card.style.setProperty('--c', colorFor(n.author));
    const h = document.createElement('h3');
    h.textContent = n.title || 'Başlıksız';
    card.append(h);
    if (n.content) {
      const p = document.createElement('p');
      p.textContent = n.content;
      card.append(p);
    }
    const atts = n.attachments || [];
    if (atts.length) {
      const count = { image: 0, video: 0, audio: 0 };
      for (const a of atts) count[a.kind]++;
      const badges = document.createElement('div');
      badges.className = 'att-badges muted small';
      badges.textContent = [
        count.image && `🖼 ${count.image} fotoğraf`,
        count.video && `🎥 ${count.video} video`,
        count.audio && `🎤 ${count.audio} ses`,
      ].filter(Boolean).join('  ·  ');
      card.append(badges);
    }
    const meta = document.createElement('div');
    meta.className = 'note-meta';
    const d = document.createElement('span');
    d.className = 'muted small';
    d.textContent = fmtDate(n.updatedAt);
    meta.append(chip(n.author), d);
    card.append(meta);
    card.onclick = () => openEditor(n);
    box.append(card);
  }

  $('status').textContent = state.loading && !state.notes.length
    ? 'Yükleniyor...'
    : list.length ? '' : 'Henüz not yok. ＋ ile ilk notu yaz.';
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  $('refresh-btn').classList.add('spin');
  render();
  try {
    state.notes = (await fetchNotes()).notes;
  } catch (err) {
    handleError(err);
  } finally {
    state.loading = false;
    $('refresh-btn').classList.remove('spin');
    if (cfg) render();
  }
}

// ---------- Düzenleyici ----------
function openEditor(note = null) {
  state.editing = note;
  const mine = !note || sameName(note.author, cfg.name);
  const author = note ? note.author : cfg.name;
  const a = $('editor-author');
  a.textContent = author;
  a.style.setProperty('--c', colorFor(author));
  $('editor-date').textContent = note ? `Son düzenleme: ${fmtDate(note.updatedAt)}` : 'Yeni not';
  $('editor-title').value = note ? note.title : '';
  $('editor-content').value = note ? note.content : '';
  $('editor-title').readOnly = $('editor-content').readOnly = !mine;
  $('editor').classList.toggle('readonly', !mine);
  $('delete-btn').classList.toggle('hidden', !note);
  draft = (note?.attachments || []).map((att) => ({ ...att, url: mediaCache.get(att.path) }));
  renderAttachments();
  $('editor').showModal();
  if (!note) $('editor-title').focus();
}

async function saveNote() {
  const title = $('editor-title').value.trim();
  const content = $('editor-content').value.trim();
  if (recorder) { toast('Önce ses kaydını durdur'); return; }
  if (!title && !content && !draft.length) { toast('Boş not kaydedilemez'); return; }
  const now = new Date().toISOString();
  const editing = state.editing;
  const id = editing ? editing.id : crypto.randomUUID();
  const btn = $('save-btn');
  btn.disabled = true;
  btn.textContent = 'Kaydediliyor...';
  try {
    // Önce yeni medya dosyaları yüklenir; hata olursa tekrar denemede yüklenenler atlanır.
    const pending = draft.filter((a) => a.blob);
    for (const [i, a] of pending.entries()) {
      btn.textContent = `Yükleniyor ${i + 1}/${pending.length}...`;
      const path = `media/${id}/${a.id}.${extOf(a.mime, a.name)}`;
      await uploadMedia(path, a.blob);
      mediaCache.set(path, a.url);
      a.path = path;
      delete a.blob;
    }
    btn.textContent = 'Kaydediliyor...';
    const attachments = draft.map(({ id: attId, path, kind, mime, size }) => ({ id: attId, path, kind, mime, size }));
    const removed = (editing?.attachments || []).filter((o) => !attachments.some((a) => a.id === o.id));

    if (editing) {
      await commit(`${cfg.name}: "${title || 'Başlıksız'}" düzenlendi`, (notes) =>
        notes.map((n) => (n.id === id ? { ...n, title, content, attachments, updatedAt: now } : n)));
    } else {
      const note = { id, author: cfg.name, title, content, attachments, createdAt: now, updatedAt: now };
      await commit(`${cfg.name}: "${title || 'Başlıksız'}" eklendi`, (notes) => [...notes, note]);
    }
    deleteMedia(removed);
    $('editor').close();
    toast('Kaydedildi ✓');
    render();
  } catch (err) {
    handleError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Kaydet';
  }
}

async function deleteNote() {
  const note = state.editing;
  if (!note || !confirm('Bu not silinsin mi?')) return;
  try {
    await commit(`${cfg.name}: "${note.title || 'Başlıksız'}" silindi`, (notes) => notes.filter((n) => n.id !== note.id));
    deleteMedia(note.attachments || []);
    $('editor').close();
    toast('Silindi');
    render();
  } catch (err) {
    handleError(err);
  }
}

// ---------- Olaylar ----------
$('setup-form').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('setup-name').value.trim();
  const token = $('setup-token').value.replace(/\s/g, '');
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const { notes } = await fetchNotes(token);
    // Aynı isim farklı yazıldıysa (yusuf / Yusuf) mevcut yazımı kullan
    const existing = notes.find((n) => sameName(n.author, name));
    writeCfg({ name: existing ? existing.author : name, token });
    state.notes = notes;
    showMain();
  } catch (err) {
    showSetup(err.message);
  } finally {
    btn.disabled = false;
  }
};

$('paste-btn').onclick = async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) throw new Error();
    $('setup-token').value = text.replace(/\s/g, '');
  } catch {
    toast('Pano okunamadı. Kutuya basılı tutup "Yapıştır" de.');
    $('setup-token').focus();
  }
};

$('editor-form').onsubmit = (e) => { e.preventDefault(); saveNote(); };
$('cancel-btn').onclick = () => $('editor').close();
$('editor').addEventListener('close', closeEditorCleanup);
$('rec-btn').onclick = toggleRecording;
for (const id of ['photo-input', 'video-input']) {
  $(id).onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) {
      // Bazı galeri uygulamaları dosya türünü boş bırakıyor; girişe göre tür verilir
      const file = id === 'photo-input'
        ? await compressImage(f)
        : new File([f], f.name || 'video.mp4', { type: f.type || 'video/mp4' });
      addBlob(file, file.name);
    }
  };
}
$('delete-btn').onclick = deleteNote;
$('new-btn').onclick = () => openEditor();
$('refresh-btn').onclick = refresh;
$('search').oninput = (e) => { state.query = e.target.value; render(); };

$('me-btn').onclick = () => {
  $('settings-name').value = cfg.name;
  $('settings').showModal();
};
$('settings-form').onsubmit = (e) => {
  e.preventDefault();
  const name = $('settings-name').value.trim();
  if (name) {
    const existing = state.notes.find((n) => sameName(n.author, name));
    writeCfg({ ...cfg, name: existing ? existing.author : name });
  }
  $('settings').close();
  showMain();
};
$('settings-cancel').onclick = () => $('settings').close();
$('logout-btn').onclick = () => {
  if (!confirm('Bu cihazdan çıkış yapılsın mı?')) return;
  writeCfg(null);
  $('settings').close();
  showSetup();
};

setInterval(() => {
  if (cfg && document.visibilityState === 'visible' && !$('editor').open) refresh();
}, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (cfg && document.visibilityState === 'visible') refresh();
});

if (cfg) showMain(); else showSetup();
