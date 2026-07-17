const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { execSync, execFile } = require('child_process');
const os    = require('os');

const PORT = process.env.PORT || 4001;
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_FILE = path.join(__dirname, 'index.html');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── GitHub-backed durable storage for lingq.json ──────────────────────────────
// Keeps the local file as the fast primary copy, and mirrors every save to a
// private GitHub repo so data survives redeploys / wiped containers.
const GH_TOKEN  = process.env.GITHUB_TOKEN     || '';
const GH_REPO   = process.env.GITHUB_REPO      || '';        // "owner/repo"
const GH_BRANCH = process.env.GITHUB_BRANCH    || 'main';
const GH_FILE   = process.env.GITHUB_DATA_FILE || 'lingq.json';
let   ghSha     = null;                                        // cached sha of remote file

function githubConfigured() { return !!(GH_TOKEN && GH_REPO); }

// Minimal GitHub API request via built-in https. Never throws; resolves { status, body }.
function ghApi(method, apiPath, bodyObj) {
  return new Promise((resolve) => {
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = {
      'Authorization': 'Bearer ' + GH_TOKEN,
      'User-Agent': 'reader-app',
      'Accept': 'application/vnd.github+json'
    };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const reqG = https.request({ hostname: 'api.github.com', path: apiPath, method, headers }, resp => {
      let data = '';
      resp.on('data', d => data += d);
      resp.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch {}
        resolve({ status: resp.statusCode, body: parsed });
      });
    });
    reqG.on('error', (e) => resolve({ status: 0, body: { message: e.message } }));
    if (payload) reqG.write(payload);
    reqG.end();
  });
}

async function ghGetFile() {
  if (!githubConfigured()) return null;
  const p = `/repos/${GH_REPO}/contents/${GH_FILE}?ref=${encodeURIComponent(GH_BRANCH)}`;
  const r = await ghApi('GET', p);
  if (r.status === 200 && r.body && r.body.content) {
    return { sha: r.body.sha, content: Buffer.from(r.body.content, 'base64').toString('utf8') };
  }
  if (r.status === 404) return { sha: null, content: null };  // repo reachable, file not there yet
  console.error('[GitHub] GET failed status=' + r.status + ' ' + (r.body && r.body.message));
  return null;                                                 // repo unreachable / auth error
}

async function ghPutFile(jsonString, attempt = 0) {
  if (!githubConfigured()) return false;
  const body = {
    message: 'Update lingq.json — ' + new Date().toISOString(),
    content: Buffer.from(jsonString, 'utf8').toString('base64'),
    branch: GH_BRANCH
  };
  if (ghSha) body.sha = ghSha;
  const r = await ghApi('PUT', `/repos/${GH_REPO}/contents/${GH_FILE}`, body);
  if ((r.status === 200 || r.status === 201) && r.body && r.body.content) {
    ghSha = r.body.content.sha;
    return true;
  }
  if (r.status === 409 && attempt < 1) {          // sha out of date → refetch and retry once
    const cur = await ghGetFile();
    if (cur) ghSha = cur.sha;
    return ghPutFile(jsonString, attempt + 1);
  }
  console.error('[GitHub] PUT failed status=' + r.status + ' ' + (r.body && r.body.message));
  return false;
}

// Fire-and-forget backup with a few retries. Never blocks the save response.
function pushToGitHub(jsonString, tries = 0) {
  if (!githubConfigured()) return;
  ghPutFile(jsonString).then(ok => {
    if (ok) { console.log('[GitHub] lingq.json backed up ✓'); return; }
    if (tries < 3) {
      const delay = 3000 * (tries + 1);
      console.error('[GitHub] backup failed — retrying in ' + delay + 'ms');
      setTimeout(() => pushToGitHub(jsonString, tries + 1), delay);
    } else {
      console.error('[GitHub] BACKUP FAILED after retries — data is saved locally only. Check GITHUB_TOKEN / GITHUB_REPO.');
    }
  });
}

// On startup: restore local lingq.json from GitHub if it's missing, and prime the sha.
async function initGitHubStorage() {
  if (!githubConfigured()) {
    console.warn('[GitHub] storage NOT configured (GITHUB_TOKEN / GITHUB_REPO missing) — data will NOT be backed up online.');
    return;
  }
  const localFp = path.join(DATA_DIR, 'lingq.json');
  let localValid = false;
  try { JSON.parse(fs.readFileSync(localFp, 'utf8')); localValid = true; } catch {}
  const remote = await ghGetFile();
  if (!remote) { console.error('[GitHub] could not reach repo on startup — serving local data only.'); return; }
  if (remote.content !== null) {
    ghSha = remote.sha;
    if (!localValid) {
      fs.writeFileSync(localFp, remote.content, 'utf8');
      console.log('[GitHub] restored lingq.json from repo (' + remote.content.length + ' bytes).');
    } else {
      console.log('[GitHub] connected — local data present, remote sha primed.');
    }
  } else if (localValid) {
    const ok = await ghPutFile(fs.readFileSync(localFp, 'utf8'));   // seed empty repo from local
    console.log('[GitHub] seeded repo with local lingq.json: ' + (ok ? 'ok' : 'FAILED'));
  }
}

// ── DeepL translation helper ─────────────────────────────────────────────────
function getConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')); }
  catch { return {}; }
}

// DeepL language code map (our lowercase → DeepL uppercase)
const DEEPL_LANG = { en: 'EN', fr: 'FR', de: 'DE', es: 'ES', ko: 'KO', ja: 'JA', id: 'ID', it: 'IT', pt: 'PT', nl: 'NL', pl: 'PL', ru: 'RU', zh: 'ZH' };

function deeplRequest(texts, sourceLang, targetLang) {
  const config = getConfig();
  const apiKey = process.env.DEEPL_API_KEY || config.deeplApiKey || '';
  if (!apiKey) return Promise.resolve(null);
  const isFree = apiKey.endsWith(':fx');
  const host = isFree ? 'api-free.deepl.com' : 'api.deepl.com';
  const sl = DEEPL_LANG[sourceLang] || sourceLang.toUpperCase();
  const tl = DEEPL_LANG[targetLang] || targetLang.toUpperCase();
  const payload = JSON.stringify({ text: texts, source_lang: sl, target_lang: tl });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: host, path: '/v2/translate', method: 'POST',
      headers: { 'Authorization': 'DeepL-Auth-Key ' + apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, resp => {
      let body = '';
      resp.on('data', d => body += d);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.translations) resolve(parsed.translations.map(t => t.text));
          else resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}

function readJSON(file) {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return [];
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    // If main file is corrupt, try backup
    const bak = fp + '.bak';
    if (fs.existsSync(bak)) {
      console.warn('[DATA] Main file ' + file + ' corrupt, restoring from backup');
      try {
        const data = JSON.parse(fs.readFileSync(bak, 'utf8'));
        fs.copyFileSync(bak, fp); // restore backup as main
        return data;
      } catch { }
    }
    console.error('[DATA] Both ' + file + ' and backup are corrupt!');
    return [];
  }
}

function writeJSON(file, data) {
  const fp = path.join(DATA_DIR, file);
  const tmp = fp + '.tmp';
  const bak = fp + '.bak';
  const json = JSON.stringify(data, null, 2);

  // 1. Write to temp file first
  fs.writeFileSync(tmp, json, 'utf8');

  // 2. Verify temp file is valid JSON and matches expected length
  const written = fs.readFileSync(tmp, 'utf8');
  if (written.length !== json.length) {
    console.error('[DATA] Write verification failed for ' + file + ': expected ' + json.length + ' chars, got ' + written.length);
    try { fs.unlinkSync(tmp); } catch {}
    return;
  }
  try { JSON.parse(written); } catch (e) {
    console.error('[DATA] Write verification failed for ' + file + ': invalid JSON after write');
    try { fs.unlinkSync(tmp); } catch {}
    return;
  }

  // 3. Backup current file (only if it's valid)
  if (fs.existsSync(fp)) {
    try {
      JSON.parse(fs.readFileSync(fp, 'utf8'));
      fs.copyFileSync(fp, bak);
    } catch {
      // Current file already corrupt, don't overwrite backup with it
    }
  }

  // 4. Atomic rename: tmp → main
  fs.renameSync(tmp, fp);

  // 5. Mirror the main data file to GitHub (durable backup; runs in background)
  if (file === 'lingq.json') {
    try { pushToGitHub(json); } catch (e) { console.error('[GitHub] push error: ' + e.message); }
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  });
}

function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Filename',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = url.pathname;

  // Serve frontend
  if (route === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(PUBLIC_FILE, 'utf8'));
  }

  // ── Full-text translation proxy (paragraph by paragraph) ──
  if (route === '/api/translate-full' && req.method === 'POST') {
    const body = await parseBody(req);
    const { text, from, to } = body;
    const paragraphs = text.split('\n\n');
    const nonEmpty = paragraphs.map(p => p.trim()).filter(p => p);

    // Try DeepL first — send all paragraphs in one request
    const deeplResults = await deeplRequest(nonEmpty, from, to);
    if (deeplResults && deeplResults.length === nonEmpty.length) {
      let idx = 0;
      const translated = paragraphs.map(p => p.trim() ? (deeplResults[idx++] || p.trim()) : '');
      return send(res, 200, { translated: translated.join('\n\n'), engine: 'deepl' });
    }

    // Fallback: MyMemory paragraph by paragraph
    const translated = [];
    let limitHit = false;
    for (const para of paragraphs) {
      if (!para.trim()) { translated.push(''); continue; }
      if (limitHit) { translated.push(para.trim()); continue; }
      const apiUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(para.trim())}&langpair=${encodeURIComponent(from + '|' + to)}&de=reader@commandcentre.app`;
      await new Promise(resolve => {
        https.get(apiUrl, apiRes => {
          let chunk = '';
          apiRes.on('data', d => chunk += d);
          apiRes.on('end', () => {
            try {
              const parsed = JSON.parse(chunk);
              const t = parsed.responseData?.translatedText || '';
              if (!t || /MYMEMORY WARNING|you used all available free/i.test(t)) {
                limitHit = true;
                translated.push(para.trim());
              } else {
                translated.push(t);
              }
            } catch { translated.push(para.trim()); }
            resolve();
          });
        }).on('error', () => { translated.push(para.trim()); resolve(); });
      });
    }
    return send(res, 200, { translated: translated.join('\n\n'), limitHit, engine: 'mymemory' });
  }

  // ── POS lookup proxy ──
  if (route === '/api/pos' && req.method === 'GET') {
    const word = url.searchParams.get('word') || '';
    const lang = url.searchParams.get('lang') || 'en';
    if (!word.trim()) return send(res, 200, { pos: 'unknown' });
    const apiUrl = `https://api.dictionaryapi.dev/api/v2/entries/${encodeURIComponent(lang)}/${encodeURIComponent(word.trim().toLowerCase())}`;
    https.get(apiUrl, apiRes => {
      let body = '';
      apiRes.on('data', chunk => body += chunk);
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (Array.isArray(parsed) && parsed[0] && parsed[0].meanings && parsed[0].meanings[0]) {
            send(res, 200, { pos: parsed[0].meanings[0].partOfSpeech || 'unknown' });
          } else {
            send(res, 200, { pos: 'unknown' });
          }
        } catch {
          send(res, 200, { pos: 'unknown' });
        }
      });
    }).on('error', () => send(res, 200, { pos: 'unknown' }));
    return;
  }

  // ── Translation proxy — single word/phrase ──
  if (route === '/api/translate' && req.method === 'GET') {
    const q    = url.searchParams.get('q')    || '';
    const lang = url.searchParams.get('lang') || 'fr';
    const to   = url.searchParams.get('to')   || 'en';
    const from = url.searchParams.get('from') || lang;
    if (!q.trim()) return send(res, 200, { translation: '(unavailable)' });

    // Try DeepL first
    const deeplRes = await deeplRequest([q.trim()], from, to);
    if (deeplRes && deeplRes[0]) {
      return send(res, 200, { translation: deeplRes[0] });
    }

    // Fallback: MyMemory
    const apiUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${encodeURIComponent(from + '|' + to)}&de=reader@commandcentre.app`;
    https.get(apiUrl, apiRes => {
      let body = '';
      apiRes.on('data', chunk => body += chunk);
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const t = parsed.responseData?.translatedText || '';
          const translation = (t && !/MYMEMORY WARNING|you used all available free/i.test(t))
            ? t : '(unavailable)';
          send(res, 200, { translation });
        } catch {
          send(res, 200, { translation: '(unavailable)' });
        }
      });
    }).on('error', () => send(res, 200, { translation: '(unavailable)' }));
    return;
  }

  // ── URL content extraction (YouTube transcripts + web articles) ──
  if (route === '/api/fetch-url' && req.method === 'POST') {
    const body = await parseBody(req);
    const targetUrl = (body.url || '').trim();
    if (!targetUrl) return send(res, 400, { error: 'No URL provided' });

    // Security: only allow http/https schemes
    let parsedUrl;
    try { parsedUrl = new URL(targetUrl); }
    catch { return send(res, 400, { error: 'Invalid URL' }); }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return send(res, 400, { error: 'Only http and https URLs are allowed' });
    }

    // Security: block private/internal IPs and localhost
    const { dns } = require('dns');
    const { promisify } = require('util');
    const dnsLookup = promisify(require('dns').lookup);

    function isPrivateIP(ip) {
      if (!ip) return true;
      if (ip === '::1') return true;
      const v4 = ip.replace(/^::ffff:/, '');
      const parts = v4.split('.').map(Number);
      if (parts.length === 4) {
        if (parts[0] === 127) return true;
        if (parts[0] === 10) return true;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
        if (parts[0] === 192 && parts[1] === 168) return true;
        if (parts[0] === 0) return true;
        if (parts[0] === 169 && parts[1] === 254) return true;
      }
      return false;
    }

    // Resolve hostname and check before fetching
    try {
      const hostname = parsedUrl.hostname;
      if (['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(hostname)) {
        return send(res, 400, { error: 'Requests to localhost are not allowed' });
      }
      const { address } = await dnsLookup(hostname);
      if (isPrivateIP(address)) {
        return send(res, 400, { error: 'Requests to private/internal network addresses are not allowed' });
      }
    } catch (e) {
      return send(res, 200, { error: 'Could not resolve hostname: ' + e.message });
    }

    const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
    const MAX_REDIRECTS = 5;

    function fetchPage(pageUrl, redirectCount) {
      if (redirectCount === undefined) redirectCount = 0;
      if (redirectCount > MAX_REDIRECTS) return Promise.reject(new Error('Too many redirects'));
      return new Promise((resolve, reject) => {
        const proto = pageUrl.startsWith('https') ? https : http;
        proto.get(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' }, timeout: 45000 }, resp => {
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            const redir = resp.headers.location.startsWith('http') ? resp.headers.location : new URL(resp.headers.location, pageUrl).href;
            return fetchPage(redir, redirectCount + 1).then(resolve).catch(reject);
          }
          let data = '';
          let size = 0;
          resp.on('data', d => {
            size += d.length;
            if (size > MAX_RESPONSE_SIZE) { resp.destroy(); return reject(new Error('Response too large (max 5 MB)')); }
            data += d;
          });
          resp.on('end', () => resolve(data));
        }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Request timed out')); });
      });
    }

    function stripHtml(html) {
      return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#\d+;/g, ' ').replace(/&\w+;/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n/g, '\n\n')
        .trim();
    }

    function decodeXmlEntities(s) {
      return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&#\d+;/g, '');
    }

    try {
      const isYouTube = /youtube\.com\/watch|youtu\.be\//.test(targetUrl);

      function parseXmlCaptions(raw) {
        const parts = [];
        const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
        let m;
        while ((m = re.exec(raw)) !== null) {
          const decoded = decodeXmlEntities(m[1]).replace(/\n/g, ' ').trim();
          if (decoded) parts.push(decoded);
        }
        return parts;
      }

      function parseJson3Captions(raw) {
        try {
          const j = JSON.parse(raw);
          const parts = [];
          for (const ev of (j.events || [])) {
            if (!ev.segs) continue;
            const line = ev.segs.map(s => (s.utf8 || '').replace(/\n/g, ' ')).join('').trim();
            if (line) parts.push(line);
          }
          return parts;
        } catch { return []; }
      }

      function textToParagraphs(parts) {
        const paragraphs = [];
        for (let i = 0; i < parts.length; i += 5) {
          paragraphs.push(parts.slice(i, i + 5).join(' '));
        }
        return paragraphs.join('\n\n');
      }

      const isWindows = process.platform === 'win32';
      const HOME_DIR = os.homedir();
      const TOOLS_DIR = path.join(__dirname, 'tools');
      const YTDLP_PATH = isWindows ? path.join(TOOLS_DIR, 'yt-dlp.exe') : path.join(TOOLS_DIR, 'yt-dlp');

      if (!fs.existsSync(TOOLS_DIR)) fs.mkdirSync(TOOLS_DIR, { recursive: true });

      function downloadYtdlp() {
        if (fs.existsSync(YTDLP_PATH)) return Promise.resolve(true);
        const url = isWindows
          ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
          : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
        return new Promise((resolve) => {
          const file = fs.createWriteStream(YTDLP_PATH);
          const doGet = (getUrl) => {
            https.get(getUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, resp => {
              if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
                return doGet(resp.headers.location);
              }
              resp.pipe(file);
              file.on('finish', () => {
                file.close();
                if (!isWindows) try { fs.chmodSync(YTDLP_PATH, 0o755); } catch {}
                resolve(true);
              });
            }).on('error', () => { try { fs.unlinkSync(YTDLP_PATH); } catch {} resolve(false); });
          };
          doGet(url);
        });
      }

      function run(cmd, extra) {
        const opts = Object.assign({ stdio: 'pipe', cwd: HOME_DIR }, extra);
        return execSync(cmd, opts);
      }

      if (isYouTube) {
        let title = 'YouTube Video';
        let textParts = [];
        let detectedLang = 'en';
        const debug = [];

        // Strategy 1: scrape captionTracks from page HTML
        try {
          debug.push('S1: fetching page...');
          const html = await fetchPage(targetUrl);
          debug.push('S1: page fetched, length=' + html.length);
          const titleMatch = html.match(/<title>([^<]*)<\/title>/);
          if (titleMatch) title = titleMatch[1].replace(' - YouTube', '').trim();

          const captionMatch = html.match(/"captionTracks":\s*(\[[\s\S]*?\])/);
          if (captionMatch) {
            let captionTracks = [];
            try { captionTracks = JSON.parse(captionMatch[1]); } catch {}
            debug.push('S1: found ' + captionTracks.length + ' caption tracks');

            const manualTracks = captionTracks.filter(t => t.kind !== 'asr');
            const asrTracks = captionTracks.filter(t => t.kind === 'asr');
            const orderedTracks = [...manualTracks, ...asrTracks];

            for (const track of orderedTracks) {
              if (textParts.length > 0) break;
              detectedLang = (track.languageCode || 'en').split('-')[0];
              const baseUrl = track.baseUrl;

              try {
                const sep = baseUrl.includes('?') ? '&' : '?';
                const json3Raw = await fetchPage(baseUrl + sep + 'fmt=json3');
                debug.push('S1: json3 response length=' + json3Raw.length);
                textParts = parseJson3Captions(json3Raw);
                debug.push('S1: json3 parsed ' + textParts.length + ' parts');
              } catch (e) { debug.push('S1: json3 error: ' + e.message.slice(0, 80)); }

              if (textParts.length === 0) {
                try {
                  const xmlRaw = await fetchPage(baseUrl);
                  textParts = parseXmlCaptions(xmlRaw);
                  debug.push('S1: xml parsed ' + textParts.length + ' parts');
                } catch (e) { debug.push('S1: xml error: ' + e.message.slice(0, 80)); }
              }

              if (textParts.length === 0) {
                try {
                  const sep = baseUrl.includes('?') ? '&' : '?';
                  textParts = parseXmlCaptions(await fetchPage(baseUrl + sep + 'fmt=srv1'));
                  debug.push('S1: srv1 parsed ' + textParts.length + ' parts');
                } catch (e) { debug.push('S1: srv1 error: ' + e.message.slice(0, 80)); }
              }
            }
          } else {
            debug.push('S1: no captionTracks found in page HTML');
          }
        } catch (e) { debug.push('S1: page fetch failed: ' + e.message.slice(0, 100)); }

        if (textParts.length > 0) {
          return send(res, 200, { title, text: textToParagraphs(textParts), language: detectedLang, sourceUrl: targetUrl });
        }

        // Strategy 2: use bundled yt-dlp
        debug.push('S2: downloading yt-dlp...');
        const ytdlpReady = await downloadYtdlp();
        debug.push('S2: yt-dlp ready=' + ytdlpReady + ', exists=' + fs.existsSync(YTDLP_PATH) + ', path=' + YTDLP_PATH);
        const Q = '"';

        if (ytdlpReady && fs.existsSync(YTDLP_PATH)) {
          try {
            const ver = run(Q + YTDLP_PATH + Q + ' --version', { timeout: 10000 }).toString().trim();
            debug.push('S2: yt-dlp version=' + ver);
          } catch (e) { debug.push('S2: yt-dlp version check failed: ' + e.message.slice(0, 100)); }

          try {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-'));
            const outTpl = path.join(tmpDir, 'subs');
            debug.push('S2: tmpDir=' + tmpDir);

            let origLang = 'en';
            try {
              const infoJson = run(Q + YTDLP_PATH + Q + ' --skip-download --dump-json ' + Q + targetUrl + Q, { timeout: 30000 }).toString();
              const info = JSON.parse(infoJson);
              if (info.language) origLang = info.language.split('-')[0].toLowerCase();
              if (info.title && title === 'YouTube Video') title = info.title;
              debug.push('S2: origLang=' + origLang + ', title=' + title);
            } catch (e) { debug.push('S2: metadata fetch failed: ' + e.message.slice(0, 80)); }

            const langPriority = [...new Set([origLang, 'en', '.*'])];

            for (const subFlag of ['--write-auto-sub', '--write-sub']) {
              for (const langCode of langPriority) {
                if (fs.readdirSync(tmpDir).some(f => f.endsWith('.srt') || f.endsWith('.vtt') || f.endsWith('.json3'))) break;
                try {
                  const cmd = Q + YTDLP_PATH + Q + ' --skip-download ' + subFlag + ' --sub-langs "' + langCode + '" --sub-format json3 --convert-subs srt -o ' + Q + outTpl + Q + ' ' + Q + targetUrl + Q;
                  run(cmd, { timeout: 60000 });
                  debug.push('S2: ' + subFlag + ' lang=' + langCode + ' succeeded');
                } catch (e) { debug.push('S2: ' + subFlag + ' lang=' + langCode + ' failed: ' + e.message.slice(0, 80)); }
              }
            }

            const allFiles = fs.readdirSync(tmpDir);
            debug.push('S2: files in tmpDir: ' + JSON.stringify(allFiles));
            function pickBestSubFile(files) {
              const exts = ['.srt', '.vtt', '.json3'];
              for (const lang of [origLang, 'en']) {
                for (const ext of exts) {
                  const f = files.find(f => f.includes('.' + lang + ext) || f.includes('.' + lang + '-'));
                  if (f) return f;
                }
              }
              for (const ext of exts) {
                const f = files.find(f => f.endsWith(ext));
                if (f) return f;
              }
              return null;
            }
            const subFile = pickBestSubFile(allFiles);

            if (subFile) {
              const subContent = fs.readFileSync(path.join(tmpDir, subFile), 'utf8');
              const langMatch2 = subFile.match(/\.([a-zA-Z]{2,3}(?:-[a-zA-Z]{2,4})?)\.[^.]+$/);
              if (langMatch2) detectedLang = langMatch2[1].split('-')[0].toLowerCase();
              debug.push('S2: subFile=' + subFile + ', detectedLang=' + detectedLang);

              let lines = [];
              if (subFile.endsWith('.json3')) {
                lines = parseJson3Captions(subContent);
              } else {
                const raw = subContent.split('\n')
                  .filter(l => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l))
                  .map(l => l.replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim())
                  .filter(l => l.length > 0);
                for (const line of raw) {
                  if (lines.length === 0 || lines[lines.length - 1] !== line) lines.push(line);
                }
              }

              debug.push('S2: parsed lines=' + lines.length);
              if (lines.length > 0) {
                try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
                if (title === 'YouTube Video') {
                  try { title = run(Q + YTDLP_PATH + Q + ' --get-title ' + Q + targetUrl + Q, { timeout: 15000 }).toString().trim() || title; } catch {}
                }
                return send(res, 200, { title, text: textToParagraphs(lines), language: detectedLang, sourceUrl: targetUrl });
              }
            }
            try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
          } catch (e) { debug.push('S2: outer error: ' + e.message.slice(0, 100)); }

          // Strategy 3: yt-dlp json3 without conversion
          try {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl2-'));
            const outTpl = path.join(tmpDir, 'subs');

            try {
              run(
                Q + YTDLP_PATH + Q + ' --skip-download --write-auto-sub --sub-langs ".*" --sub-format json3 -o ' + Q + outTpl + Q + ' ' + Q + targetUrl + Q,
                { timeout: 60000 }
              );
              debug.push('S3: json3-only succeeded');
            } catch (e) { debug.push('S3: json3-only failed: ' + e.message.slice(0, 100)); }

            const allFiles = fs.readdirSync(tmpDir);
            debug.push('S3: files: ' + JSON.stringify(allFiles));
            const json3Files = allFiles.filter(f => f.endsWith('.json3'));

            if (json3Files.length > 0) {
              const raw = fs.readFileSync(path.join(tmpDir, json3Files[0]), 'utf8');
              const parts = parseJson3Captions(raw);
              debug.push('S3: json3 parts=' + parts.length);
              if (parts.length > 0) {
                try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
                const langMatch3 = json3Files[0].match(/\.([a-z]{2,3})\.[^.]+$/);
                if (langMatch3) detectedLang = langMatch3[1].split('-')[0];
                if (title === 'YouTube Video') {
                  try { title = run(Q + YTDLP_PATH + Q + ' --get-title ' + Q + targetUrl + Q, { timeout: 15000 }).toString().trim() || title; } catch {}
                }
                return send(res, 200, { title, text: textToParagraphs(parts), language: detectedLang, sourceUrl: targetUrl });
              }
            }
            try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
          } catch (e) { debug.push('S3: outer error: ' + e.message.slice(0, 100)); }
        }

        return send(res, 200, { error: 'Could not extract text from this YouTube video. Debug trace: ' + debug.join(' | ') });

      } else {
        // ── Web article extraction ──
        const html = await fetchPage(targetUrl);

        const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
        let title = titleMatch ? stripHtml(titleMatch[1]).trim() : 'Web Article';

        let content = '';

        const articleMatch = html.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
        if (articleMatch) {
          content = stripHtml(articleMatch[1]);
        }

        if (!content || content.length < 100) {
          const mainMatch = html.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);
          if (mainMatch) content = stripHtml(mainMatch[1]);
        }

        if (!content || content.length < 100) {
          const patterns = [
            /class="[^"]*(?:article|post|entry|content|story)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section)>/i,
            /id="[^"]*(?:article|post|entry|content|story)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section)>/i,
          ];
          for (const pat of patterns) {
            const m = html.match(pat);
            if (m && stripHtml(m[1]).length > 100) { content = stripHtml(m[1]); break; }
          }
        }

        if (!content || content.length < 100) {
          const bodyMatch = html.match(/<body[\s\S]*?>([\s\S]*?)<\/body>/i);
          content = bodyMatch ? stripHtml(bodyMatch[1]) : stripHtml(html);
        }

        const langMatch = html.match(/<html[^>]*\slang="([^"]+)"/i);
        const detectedLang = langMatch ? langMatch[1].split('-')[0] : null;

        const lines = content.split('\n').filter(l => l.trim().length > 20 || l.trim() === '');
        content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

        if (content.length < 50) return send(res, 200, { error: 'Could not extract meaningful text from this page' });

        return send(res, 200, { title, text: content, language: detectedLang });
      }
    } catch (e) {
      return send(res, 200, { error: 'Failed to fetch URL: ' + e.message });
    }
  }

  // ── Generate story using Ollama (local Gemma) ──
  if (route === '/api/generate-story' && req.method === 'POST') {
    const body = await parseBody(req);
    const { words, languages, targetCount, wordRange, difficulty, cefrLevel } = body;
    const hasWords = words && Array.isArray(words) && words.length > 0 && targetCount > 0;
    const config = getConfig();
    const ollamaHost = config.ollamaHost || '127.0.0.1';
    const ollamaPort = config.ollamaPort || 11434;
    const ollamaModel = config.ollamaModel || 'gemma4:e2b';
    const storyWordRange = wordRange || '150-250';
    const storyDifficulty = difficulty || 'B1 (moderate vocabulary, compound sentences, mixed tenses, everyday and some abstract topics)';
    const cefr = cefrLevel || 'B1';
    const useCount = targetCount || (words ? words.length : 0);
    console.log('[Story] Ollama ' + ollamaHost + ':' + ollamaPort + ' model=' + ollamaModel + ' length=' + storyWordRange + ' CEFR=' + cefr + ' words=' + useCount);

    let prompt;
    if (hasWords) {
      prompt = `Write a story (${storyWordRange} words) in English that naturally incorporates foreign words/phrases from the list below. You are given a pool of ${words.length} words but you should pick the ${useCount} that work best together in a cohesive story — prioritise words that are thematically related or can naturally appear in the same scene.\n\nCEFR level: ${cefr}. Language difficulty: ${storyDifficulty}. Match the English prose to this CEFR level — sentence complexity, vocabulary range, and grammar should all reflect ${cefr} level.\n\nFor each foreign word you use, make its meaning clear from context (e.g. use it where the meaning is obvious, or briefly include the translation in parentheses). The story should be engaging, have a plot, and flow naturally — not just a list of sentences.\n\nWord pool:\n${words.join(', ')}\n\nIMPORTANT: Write the story in English, weaving in the foreign words naturally. Use approximately ${useCount} words from the pool. Output ONLY the story text, no title, no introduction, no comments.`;
    } else {
      prompt = `Write a story (${storyWordRange} words) in English.\n\nCEFR level: ${cefr}. Language difficulty: ${storyDifficulty}. The story must be written at CEFR ${cefr} level — sentence complexity, vocabulary range, and grammar should all reflect ${cefr} level.\n\nThe story should be engaging, have a clear plot, interesting characters, and flow naturally. Choose an interesting everyday topic or scenario.\n\nIMPORTANT: Output ONLY the story text, no title, no introduction, no comments.`;
    }

    try {
      const payload = JSON.stringify({
        model: ollamaModel,
        prompt: prompt,
        stream: false,
        options: { temperature: 0.9 }
      });
      const story = await new Promise((resolve, reject) => {
        const apiReq = http.request({
          hostname: ollamaHost,
          port: ollamaPort,
          path: '/api/generate',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          timeout: 300000
        }, apiRes => {
          let data = '';
          apiRes.on('data', d => data += d);
          apiRes.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) {
                reject(new Error(parsed.error));
                return;
              }
              const text = parsed.response;
              if (!text) reject(new Error('No text in Ollama response. Is the model pulled? Run: ollama pull ' + ollamaModel));
              else resolve(text.trim());
            } catch (e) { reject(e); }
          });
        });
        apiReq.on('timeout', () => { apiReq.destroy(); reject(new Error('Ollama request timed out (5 min). The model may still be loading — try again.')); });
        apiReq.on('error', (e) => {
          if (e.code === 'ECONNREFUSED') reject(new Error('Cannot connect to Ollama at ' + ollamaHost + ':' + ollamaPort + '. Is Ollama running? Start it with: ollama serve'));
          else reject(e);
        });
        apiReq.write(payload);
        apiReq.end();
      });

      // If languages requested, translate via DeepL (backward compat)
      const translations = {};
      for (const lang of (languages || [])) {
        const result = await deeplRequest([story], 'en', lang.code);
        if (result && result[0]) {
          translations[lang.code] = result[0];
        }
      }

      return send(res, 200, { story, translations });
    } catch (e) {
      return send(res, 500, { error: 'Story generation failed: ' + e.message });
    }
  }

  // ── LingQ data endpoint ──
  if (route === '/api/lingq') {
    if (req.method === 'GET') return send(res, 200, readJSON('lingq.json'));
    if (req.method === 'POST') {
      const body = await parseBody(req);
      writeJSON('lingq.json', body);
      return send(res, 200, { ok: true });
    }
  }

  // ── Export backup (downloads lingq.json with timestamp filename) ──
  if (route === '/api/export') {
    const data = readJSON('lingq.json');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="reader-backup-${ts}.json"`,
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(JSON.stringify(data, null, 2));
  }

  // ── Import backup (merges or replaces lingq.json) ──
  if (route === '/api/import' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      // Validate it has the expected shape
      if (!body || typeof body !== 'object') return send(res, 400, { error: 'Invalid data' });
      // Back up current data first
      const fp = path.join(DATA_DIR, 'lingq.json');
      if (fs.existsSync(fp)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        try { fs.copyFileSync(fp, path.join(DATA_DIR, `lingq-pre-import-${ts}.json`)); } catch {}
      }
      writeJSON('lingq.json', body);
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 400, { error: 'Invalid JSON' });
    }
  }

  // ── Serve audio files ──
  if (route.startsWith('/api/audio/') && req.method === 'GET') {
    const filename = decodeURIComponent(route.replace('/api/audio/', ''));
    if (filename.includes('..') || filename.includes('/')) return send(res, 400, { error: 'Invalid filename' });
    const audioDir = path.join(DATA_DIR, 'audio');
    const fp = path.join(audioDir, filename);
    if (!fs.existsSync(fp)) return send(res, 404, { error: 'Audio not found' });
    const ext = path.extname(filename).toLowerCase();
    const mime = ext === '.mp3' ? 'audio/mpeg' : ext === '.wav' ? 'audio/wav' : 'application/octet-stream';
    const stat = fs.statSync(fp);
    // Support range requests for seeking
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mime,
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(fp, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(fp).pipe(res);
    }
    return;
  }

  // ── Upload audio + transcribe via OpenAI Whisper ──
  if (route === '/api/upload-audio' && req.method === 'POST') {
    const audioDir = path.join(DATA_DIR, 'audio');
    if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

    const MAX_SIZE = 100 * 1024 * 1024; // 100MB
    const WHISPER_LIMIT = 25 * 1024 * 1024; // 25MB per OpenAI request
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    const origFilename = req.headers['x-filename'] || 'audio.mp3';

    if (contentLength > MAX_SIZE) return send(res, 413, { error: 'File too large (max 100MB)' });

    // Read raw body
    const chunks = [];
    let totalSize = 0;
    req.on('data', chunk => {
      totalSize += chunk.length;
      if (totalSize <= MAX_SIZE) chunks.push(chunk);
    });

    await new Promise(r => req.on('end', r));
    if (totalSize > MAX_SIZE) return send(res, 413, { error: 'File too large (max 100MB)' });

    const buffer = Buffer.concat(chunks);
    const ext = path.extname(origFilename).toLowerCase() || '.mp3';
    const safeBase = 'audio-' + Date.now();
    const savedName = safeBase + ext;
    const savedPath = path.join(audioDir, savedName);
    fs.writeFileSync(savedPath, buffer);
    console.log('[Audio] Saved ' + savedName + ' (' + (buffer.length / 1024 / 1024).toFixed(1) + 'MB)');

    // Get OpenAI API key
    const config = getConfig();
    const openaiKey = config.openaiApiKey || '';
    if (!openaiKey) {
      return send(res, 400, { error: 'No OpenAI API key configured. Add "openaiApiKey" to data/config.json' });
    }

    try {
      let transcript;
      if (buffer.length <= WHISPER_LIMIT) {
        // Single request
        console.log('[Audio] Transcribing (single request)...');
        transcript = await whisperTranscribe(savedPath, openaiKey);
      } else {
        // Split into chunks using ffmpeg
        console.log('[Audio] File > 25MB, splitting into chunks...');
        const chunkPaths = await splitAudioChunks(savedPath, audioDir, safeBase, ext);
        console.log('[Audio] Split into ' + chunkPaths.length + ' chunks, transcribing each...');
        const parts = [];
        for (let i = 0; i < chunkPaths.length; i++) {
          console.log('[Audio] Transcribing chunk ' + (i + 1) + '/' + chunkPaths.length);
          const part = await whisperTranscribe(chunkPaths[i], openaiKey);
          parts.push(part);
          // Clean up chunk file
          try { fs.unlinkSync(chunkPaths[i]); } catch {}
        }
        transcript = parts.join('\n\n');
      }

      return send(res, 200, { text: transcript, audioFile: savedName, filename: origFilename });
    } catch (e) {
      console.error('[Audio] Transcription error:', e.message);
      return send(res, 500, { error: 'Transcription failed: ' + e.message });
    }
  }

  send(res, 404, { error: 'Not found' });
});

// ── Whisper API helper ──
function whisperTranscribe(filePath, apiKey) {
  return new Promise((resolve, reject) => {
    const filename = path.basename(filePath);
    const fileData = fs.readFileSync(filePath);
    const boundary = '----WhisperBoundary' + Date.now();

    // Build multipart body
    const parts = [];
    // file field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ));
    parts.push(fileData);
    parts.push(Buffer.from('\r\n'));
    // model field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`
    ));
    // response_format field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\ntext\r\n`
    ));
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length
      },
      timeout: 300000 // 5 min per chunk
    }, resp => {
      let data = '';
      resp.on('data', d => data += d);
      resp.on('end', () => {
        if (resp.statusCode !== 200) {
          try {
            const err = JSON.parse(data);
            reject(new Error(err.error?.message || 'Whisper API error ' + resp.statusCode));
          } catch { reject(new Error('Whisper API error ' + resp.statusCode + ': ' + data.slice(0, 200))); }
        } else {
          resolve(data.trim());
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Whisper API timed out (5 min)')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Split audio into ~20MB chunks using ffmpeg ──
function splitAudioChunks(filePath, outDir, baseName, ext) {
  return new Promise((resolve, reject) => {
    // Get duration first
    execFile('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], (err, stdout) => {
      if (err) return reject(new Error('ffmpeg/ffprobe not found. Install ffmpeg to process audio files > 25MB.'));
      const duration = parseFloat(stdout.trim());
      if (isNaN(duration)) return reject(new Error('Could not determine audio duration'));

      const fileSize = fs.statSync(filePath).size;
      const bytesPerSec = fileSize / duration;
      const targetChunkBytes = 20 * 1024 * 1024; // 20MB per chunk (under 25MB limit)
      const chunkDuration = Math.floor(targetChunkBytes / bytesPerSec);
      const numChunks = Math.ceil(duration / chunkDuration);

      console.log('[Audio] Duration: ' + duration.toFixed(0) + 's, splitting into ' + numChunks + ' chunks of ~' + chunkDuration + 's each');

      const chunkPaths = [];
      let completed = 0;
      let failed = false;

      for (let i = 0; i < numChunks; i++) {
        const startTime = i * chunkDuration;
        const chunkPath = path.join(outDir, baseName + '-chunk' + i + ext);
        chunkPaths.push(chunkPath);

        execFile('ffmpeg', [
          '-y', '-i', filePath,
          '-ss', String(startTime),
          '-t', String(chunkDuration),
          '-acodec', 'copy',
          chunkPath
        ], (err2) => {
          if (failed) return;
          if (err2) { failed = true; return reject(new Error('ffmpeg split failed: ' + err2.message)); }
          completed++;
          if (completed === numChunks) resolve(chunkPaths);
        });
      }
    });
  });
}

initGitHubStorage().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ✦ Reader running at http://localhost:${PORT}\n`);
  });
});
