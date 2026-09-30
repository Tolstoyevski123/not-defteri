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
  return fetch(`https://api.github.com/repos/${DATA_OWNER}/${DATA_REPO}/${path}`, {
    ...opts,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
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
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
}
function handleError(err) {
  if (err instanceof AuthError) {
    writeCfg(null);
    showSetup(err.message);
  } else {
    toast(err.message || 'Bir hata oluştu');
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
    const p = document.createElement('p');
    p.textContent = n.content;
    const meta = document.createElement('div');
    meta.className = 'note-meta';
    const d = document.createElement('span');
    d.className = 'muted small';
    d.textContent = fmtDate(n.updatedAt);
    meta.append(chip(n.author), d);
    card.append(h, p, meta);
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
  $('editor').showModal();
  if (!note) $('editor-title').focus();
}

async function saveNote() {
  const title = $('editor-title').value.trim();
  const content = $('editor-content').value.trim();
  if (!title && !content) { toast('Boş not kaydedilemez'); return; }
  const now = new Date().toISOString();
  const editing = state.editing;
  const btn = $('save-btn');
  btn.disabled = true;
  btn.textContent = 'Kaydediliyor...';
  try {
    if (editing) {
      await commit(`${cfg.name}: "${title || 'Başlıksız'}" düzenlendi`, (notes) =>
        notes.map((n) => (n.id === editing.id ? { ...n, title, content, updatedAt: now } : n)));
    } else {
      const note = { id: crypto.randomUUID(), author: cfg.name, title, content, createdAt: now, updatedAt: now };
      await commit(`${cfg.name}: "${title || 'Başlıksız'}" eklendi`, (notes) => [...notes, note]);
    }
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
