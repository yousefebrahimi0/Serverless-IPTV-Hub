export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // ==========================================
      // 1. CONFIGURATION
      // ==========================================
      const LOGIN_PASSWORD = env.LOGIN_PASSWORD || "Admin@123";
      const COOKIE_SECRET  = env.COOKIE_SECRET  || "s3t-th1s-1n-env-v4rs";
      const AUTH_COOKIE_NAME    = "iptv_auth_token";
      const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
      const DEFAULT_M3U_URL     = "https://raw.githubusercontent.com/yousefebrahimi0/Serverless-IPTV-Hub/main/active%2030k%20list%20iptv.m3u";
      const FAVICON_URL         = "https://raw.githubusercontent.com/yousefebrahimi0/Serverless-IPTV-Hub/main/favicon.svg";

      // ==========================================
      // 2. AUTH HELPERS
      // ==========================================
      async function generateToken(password, salt) {
        const data = new TextEncoder().encode(password + salt);
        const hash = await crypto.subtle.digest("SHA-256", data);
        return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
      }

      // FIX: timing-safe comparison to prevent timing attacks
      async function safeCompare(a, b) {
        const enc = new TextEncoder();
        const aBytes = enc.encode(a);
        const bBytes = enc.encode(b);
        if (aBytes.length !== bBytes.length) return false;
        try {
          return await crypto.subtle.timingSafeEqual(aBytes, bBytes);
        } catch {
          // timingSafeEqual not available in all runtimes – fall back
          let diff = 0;
          for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
          return diff === 0;
        }
      }

      async function isAuthenticated(req) {
        const cookieHeader = req.headers.get("Cookie") || "";
        const cookies = Object.fromEntries(
          cookieHeader.split(";").map(c => {
            const parts = c.trim().split("=");
            return [decodeURIComponent(parts[0] || ''), decodeURIComponent(parts.slice(1).join("=") || '')];
          })
        );
        const token = cookies[AUTH_COOKIE_NAME];
        if (!token) return false;
        const expectedToken = await generateToken(LOGIN_PASSWORD, COOKIE_SECRET);
        return safeCompare(token, expectedToken);
      }

      const action    = url.searchParams.get('action');
      const targetUrl = url.searchParams.get('url');
      const corsHeaders = {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };

      if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

      // ==========================================
      // 3. LOGIN / LOGOUT
      // ==========================================
      if (action === 'logout') {
        return new Response(null, {
          status: 302,
          headers: {
            'Location': url.pathname,
            // FIX: added Secure flag
            'Set-Cookie': `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
          }
        });
      }

      if (request.method === 'POST' && action === 'login') {
        const formData = await request.formData();
        const password = formData.get('password') || '';
        if (password === LOGIN_PASSWORD) {
          const token = await generateToken(LOGIN_PASSWORD, COOKIE_SECRET);
          return new Response(JSON.stringify({ status: 'success' }), {
            headers: {
              'Content-Type': 'application/json',
              // FIX: added Secure flag
              'Set-Cookie': `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${AUTH_COOKIE_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`,
            }
          });
        } else {
          return new Response(JSON.stringify({ status: 'error', message: 'Incorrect password' }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      const authenticated = await isAuthenticated(request);
      if (!authenticated) {
        return new Response(getLoginHTML(FAVICON_URL), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      }

      // ==========================================
      // 4. KV: GET / SAVE M3U SOURCES
      // ==========================================
      if (action === 'get-sources') {
        let sources = [];
        if (env.IPTV_KV) {
          try {
            // FIX: use KV cacheTtl to avoid redundant reads
            const raw = await env.IPTV_KV.get('m3u_sources', { cacheTtl: 60 });
            if (raw) sources = JSON.parse(raw);
          } catch(e) { console.error("KV Read Error", e); }
        }
        if (sources.length === 0) sources = [{ id: 'default', name: 'Default', url: DEFAULT_M3U_URL }];
        return new Response(JSON.stringify(sources), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (request.method === 'POST' && action === 'save-sources') {
        if (!env.IPTV_KV) {
          return new Response(JSON.stringify({ status: 'error', message: 'KV not configured in Cloudflare Dashboard' }), {
            status: 500, headers: { 'Content-Type': 'application/json' }
          });
        }
        const body = await request.json();
        await env.IPTV_KV.put('m3u_sources', JSON.stringify(body.sources));
        return new Response(JSON.stringify({ status: 'success' }), { headers: { 'Content-Type': 'application/json' } });
      }

      // ==========================================
      // 5. VIDEO & M3U8 STREAM PROXY
      // FIX: validate URL protocol to prevent SSRF
      // ==========================================
      if (action === 'proxy' && targetUrl) {
        try {
          const parsed = new URL(targetUrl);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            return new Response("Forbidden: invalid protocol", { status: 403, headers: corsHeaders });
          }
          const response = await fetch(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });
          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('mpegurl') || targetUrl.includes('.m3u8')) {
            let text = await response.text();
            const baseUrl = new URL('.', targetUrl).href;
            const rewritten = text.split('\n').map(line => {
              line = line.trim();
              if (!line || line.startsWith('#')) return line;
              let absoluteUri = line.startsWith('http') ? line : new URL(line, baseUrl).href;
              return `${url.origin}${url.pathname}?action=proxy&url=${encodeURIComponent(absoluteUri)}`;
            }).join('\n');
            return new Response(rewritten, { headers: { ...corsHeaders, 'Content-Type': 'application/vnd.apple.mpegurl' } });
          }
          return new Response(response.body, { headers: { ...corsHeaders, 'Content-Type': contentType } });
        } catch (e) {
          return new Response("Proxy Error: " + e.message, { status: 500, headers: corsHeaders });
        }
      }

      // ==========================================
      // 6. LOGO PROXY
      // FIX: validate URL protocol to prevent SSRF
      // ==========================================
      if (action === 'logo' && targetUrl) {
        try {
          const parsed = new URL(targetUrl);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            return new Response(null, { status: 403 });
          }
          const response = await fetch(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          return new Response(response.body, {
            headers: { ...corsHeaders, 'Content-Type': response.headers.get('content-type') || 'image/png', 'Cache-Control': 'max-age=2592000, public' }
          });
        } catch (e) {
          return new Response(null, { status: 404 });
        }
      }



      // ==========================================
      // 8. CHANNELS
      // FIX: concurrency-limited fetch (max 5 at once)
      // ==========================================
      if (action === 'channels') {
        let sources = [];
        if (env.IPTV_KV) {
          try {
            const raw = await env.IPTV_KV.get('m3u_sources', { cacheTtl: 60 });
            if (raw) sources = JSON.parse(raw);
          } catch(e) { console.error("KV Read Error", e); }
        }
        if (sources.length === 0) sources = [{ id: 'default', name: 'Default', url: DEFAULT_M3U_URL }];

        const activeSources = sources.filter(src => src.enabled !== false);

        // Concurrency-limited fetcher
        async function fetchSource(src) {
          let text = '';
          if (src.url.includes('action=serve-m3u&id=')) {
            try {
              const urlObj = new URL(src.url);
              const id = urlObj.searchParams.get('id');
              if (env.IPTV_KV && id) {
                text = await env.IPTV_KV.get('m3u_file_' + id) || "";
              }
            } catch(e) { console.error("Internal KV Error", e); }
          } else {
            // FIX: validate protocol before fetching external source
            try {
              const parsed = new URL(src.url);
              if (!['http:', 'https:'].includes(parsed.protocol)) return { text: '', sourceName: src.name };
            } catch { return { text: '', sourceName: src.name }; }
            const r = await fetch(src.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            text = await r.text();
          }
          return { text, sourceName: src.name };
        }

        // Run with max 5 concurrent fetches
        const CONCURRENCY = 5;
        const results = [];
        for (let i = 0; i < activeSources.length; i += CONCURRENCY) {
          const batch = activeSources.slice(i, i + CONCURRENCY);
          const batchResults = await Promise.allSettled(batch.map(fetchSource));
          results.push(...batchResults);
        }

        let allChannels = [];
        for (const result of results) {
          if (result.status === 'fulfilled') {
            allChannels = allChannels.concat(parseM3U(result.value.text, result.value.sourceName));
          }
        }
        return new Response(JSON.stringify(allChannels), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // ==========================================
      // 9. SERVE HTML PLAYER
      // ==========================================
      return new Response(getHTML(FAVICON_URL), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });

    } catch (criticalError) {
      return new Response(`CRITICAL WORKER ERROR: ${criticalError.message}\n\nStack: ${criticalError.stack}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  }
};

// ==========================================
// HELPERS
// ==========================================

// FIX: use URL as ID directly (hashed) to avoid simpleHash collisions
function stableChannelId(url) {
  // Simple but collision-resistant: base36 of a djb2-like 32-bit hash
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = (Math.imul(33, h) ^ url.charCodeAt(i)) >>> 0;
  return 'ch_' + h.toString(36);
}

function parseM3U(m3uText, sourceName) {
  const lines = m3uText.split('\n');
  const channels = [];
  let currentChannel = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const nameParts = line.split(',');
      const name = nameParts[nameParts.length - 1].trim();
      let logo = ''; const logoMatch = line.match(/tvg-logo="(.*?)"/); if (logoMatch) logo = logoMatch[1];
      let group = 'Uncategorized'; const groupMatch = line.match(/group-title="(.*?)"/); if (groupMatch) group = groupMatch[1].trim();
      const prefixedGroup = sourceName ? `${sourceName} > ${group}` : group;
      let hasEpg = false; const epgMatch = line.match(/tvg-id="(.*?)"/); if (epgMatch && epgMatch[1].trim() !== '') hasEpg = true;
      const nameUpper = name.toUpperCase();
      const isHd = [' HD', '-HD', 'FHD', '4K', '1080', '720'].some(q => nameUpper.includes(q));
      currentChannel = { name, logo, group: prefixedGroup, is_hd: isHd, has_epg: hasEpg, source: sourceName, url: '', id: '' };
    } else if (line.startsWith('http') && currentChannel) {
      currentChannel.url = line;
      // FIX: use collision-resistant hash instead of simpleHash
      currentChannel.id = stableChannelId(line);
      channels.push(currentChannel);
      currentChannel = null;
    }
  }
  return channels;
}

// ==========================================
// LOGIN HTML
// ==========================================
function getLoginHTML(faviconUrl) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login - MOE IPTV</title>
<meta name="robots" content="nofollow, noindex" />
<link rel="icon" type="image/svg+xml" href="${faviconUrl}">
<script src="https://cdn.tailwindcss.com"><\/script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
<style>
body { font-family: 'Inter', sans-serif; background-color: #12131C; color: white; }
.btn-loader { width: 18px; height: 18px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; animation: spin .7s linear infinite; margin: auto; }
@keyframes spin { to { transform: rotate(360deg); } }
.snackbar { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%) translateY(100px); background: #272733; color: #fff; padding: 14px 18px; border-radius: 12px; opacity: 0; transition: 0.3s ease; z-index: 99999; }
.snackbar.show { opacity: 1; transform: translateX(-50%) translateY(0); }
input:-webkit-autofill, input:-webkit-autofill:hover, input:-webkit-autofill:focus, input:-webkit-autofill:active {
transition: background-color 5000s ease-in-out 0s !important;
-webkit-text-fill-color: #ffffff !important;
caret-color: #ffffff !important;
}
input { border: none !important; box-shadow: none !important; outline: none !important; }
.mascot-eye { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
#iptv-mascot.is-hiding #eye-left { width: 10px; height: 2px; x: 36px; y: 46px; rx: 1px; fill: #FFB09E; }
#iptv-mascot.is-hiding #eye-right { width: 10px; height: 2px; x: 54px; y: 46px; rx: 1px; fill: #FFB09E; }
@keyframes headShake {
0% { transform: translateX(0); } 20% { transform: translateX(-8px) rotate(-4deg); }
40% { transform: translateX(8px) rotate(4deg); } 60% { transform: translateX(-8px) rotate(-4deg); }
80% { transform: translateX(8px) rotate(4deg); } 100% { transform: translateX(0); }
}
.mascot-shake { animation: headShake 0.4s cubic-bezier(.36,.07,.19,.97) both; }
</style>
</head>
<body class="min-h-screen flex items-center justify-center p-8">
<div class="bg-[#1C1D26] border border-[#2A2B36] p-10 rounded-xl shadow-2xl w-full max-w-md">
<div class="flex flex-col items-center mb-8 text-center">
<svg id="iptv-mascot" viewBox="0 0 100 100" class="w-24 h-24 drop-shadow-2xl mb-3">
<defs><linearGradient id="tv-grad" x1="0%" y1="0%" x2="100%" y2="100%">
<stop offset="0%" stop-color="#FF7A55" /><stop offset="100%" stop-color="#E03115" />
</linearGradient></defs>
<line x1="38" y1="28" x2="25" y2="12" stroke="#FF7A55" stroke-width="4" stroke-linecap="round" />
<circle cx="25" cy="12" r="3" fill="#E03115" />
<line x1="62" y1="28" x2="75" y2="12" stroke="#E03115" stroke-width="4" stroke-linecap="round" />
<circle cx="75" cy="12" r="3" fill="#FF7A55" />
<line x1="35" y1="65" x2="28" y2="82" stroke="#9B2C2C" stroke-width="5" stroke-linecap="round" />
<line x1="65" y1="65" x2="72" y2="82" stroke="#9B2C2C" stroke-width="5" stroke-linecap="round" />
<rect x="15" y="28" width="70" height="46" rx="8" fill="url(#tv-grad)" />
<rect x="21" y="34" width="58" height="34" rx="4" fill="#12131C" />
<rect id="eye-left" x="38" y="44" width="6" height="6" rx="3" fill="#FFFFFF" class="mascot-eye" />
<rect id="eye-right" x="56" y="44" width="6" height="6" rx="3" fill="#FFFFFF" class="mascot-eye" />
</svg>
<h1 class="text-2xl font-semibold tracking-tight">MOE IPTV</h1>
<p class="text-sm text-gray-400 mt-2">Enter your password to access</p>
</div>
<form id="loginForm" class="space-y-5">
<div class="relative flex items-center">
<span class="material-icons absolute left-4 text-gray-400" style="font-size: 20px;">vpn_key</span>
<input type="password" id="password" name="password" placeholder="Password"
class="w-full bg-[#272733] rounded-xl pl-12 pr-12 py-3.5 text-white text-sm font-mono tracking-widest" required autofocus>
<button type="button" onclick="togglePass()" class="absolute right-4 text-gray-400 hover:text-white focus:outline-none transition-colors flex items-center justify-center">
<span class="material-icons" id="passwordVisibilityIcon" style="font-size: 20px;">visibility_off</span>
</button>
</div>
<button type="submit" id="loginBtn" class="w-full bg-white text-black hover:bg-gray-200 transition-all font-medium py-3.5 rounded-xl shadow-sm flex items-center justify-center gap-2">
<span id="btnText">Watch Now</span>
</button>
</form>
</div>
<div class="snackbar" id="snackbar"></div>
<script>
const passwordInput = document.getElementById("password");
const mascot = document.getElementById("iptv-mascot");
passwordInput.addEventListener("input", () => {
mascot.classList.toggle("is-hiding", passwordInput.value.length > 0);
});
document.getElementById("loginForm").addEventListener("submit", async function(e) {
e.preventDefault();
const btnText = document.getElementById("btnText");
const orig = btnText.innerHTML;
btnText.innerHTML = '<div class="btn-loader" style="border-top-color:#000;"></div>';
try {
const fd = new FormData(); fd.append('password', passwordInput.value);
const data = await fetch("?action=login", { method: "POST", body: fd }).then(r => r.json());
if (data.status === "success") { window.location.reload(); }
else {
showSnackbar(data.message); btnText.innerHTML = orig;
mascot.classList.remove("mascot-shake");
setTimeout(() => mascot.classList.add("mascot-shake"), 10);
}
} catch(e) { showSnackbar("Connection error"); btnText.innerHTML = orig; }
});
function showSnackbar(msg) {
const s = document.getElementById("snackbar"); s.innerText = msg; s.classList.add("show");
clearTimeout(s.hideTimer); s.hideTimer = setTimeout(() => s.classList.remove("show"), 3000);
}
function togglePass() {
const i = document.getElementById("password"), ic = document.getElementById("passwordVisibilityIcon");
i.type = i.type === "password" ? "text" : "password";
ic.innerText = i.type === "password" ? "visibility_off" : "visibility";
}
<\/script>
</body>
</html>`;
}



// ==========================================
// MAIN PLAYER HTML
// ==========================================
function getHTML(faviconUrl) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>MOE IPTV Player</title>
<meta name="robots" content="nofollow, noindex" />
<link rel="icon" type="image/svg+xml" href="${faviconUrl}">
<script src="https://cdn.tailwindcss.com"><\/script>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"><\/script>
<script src="https://cdn.plyr.io/3.7.8/plyr.js"><\/script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css">
<script>
tailwind.config = {
theme: {
extend: {
colors: {
tv: { bg: '#16161E', panel: '#1A1B26', card: '#242530', cardhover: '#2A2B38', active: '#2D2E3D', muted: '#8F93A2' }
},
fontFamily: { sans: ['Inter', 'sans-serif'] }
}
}
}
<\/script>
<style>
::-webkit-scrollbar { display: none; }
* { -ms-overflow-style: none; scrollbar-width: none; }

#category-list,
#channel-list,
#sources-list,
#mob-pane-fav,
#mob-pane-home > div.overflow-y-auto,
#mob-pane-channels > div.overflow-y-auto {
  scrollbar-width: thin;
  scrollbar-color: #3A3B4A transparent;
}
#category-list::-webkit-scrollbar,
#channel-list::-webkit-scrollbar,
#sources-list::-webkit-scrollbar,
#mob-pane-fav::-webkit-scrollbar,
#mob-pane-home > div.overflow-y-auto::-webkit-scrollbar,
#mob-pane-channels > div.overflow-y-auto::-webkit-scrollbar {
  display: block;
  width: 6px;
}
#category-list::-webkit-scrollbar-track,
#channel-list::-webkit-scrollbar-track,
#sources-list::-webkit-scrollbar-track,
#mob-pane-fav::-webkit-scrollbar-track,
#mob-pane-home > div.overflow-y-auto::-webkit-scrollbar-track,
#mob-pane-channels > div.overflow-y-auto::-webkit-scrollbar-track {
  background: transparent;
}
#category-list::-webkit-scrollbar-thumb,
#channel-list::-webkit-scrollbar-thumb,
#sources-list::-webkit-scrollbar-thumb,
#mob-pane-fav::-webkit-scrollbar-thumb,
#mob-pane-home > div.overflow-y-auto::-webkit-scrollbar-thumb,
#mob-pane-channels > div.overflow-y-auto::-webkit-scrollbar-thumb {
  background-color: #3A3B4A;
  border-radius: 10px;
}
#category-list::-webkit-scrollbar-thumb:hover,
#channel-list::-webkit-scrollbar-thumb:hover,
#sources-list::-webkit-scrollbar-thumb:hover,
#mob-pane-fav::-webkit-scrollbar-thumb:hover,
#mob-pane-home > div.overflow-y-auto::-webkit-scrollbar-thumb:hover,
#mob-pane-channels > div.overflow-y-auto::-webkit-scrollbar-thumb:hover {
  background-color: #4A4B5C;
}

body { font-family: "Inter", sans-serif; }
.loader { border: 3px solid rgba(255,255,255,0.1); border-top-color: #fff; border-radius: 50%; width: 24px; height: 24px; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.nav-btn { transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1); }
.nav-btn.is-active {
background: linear-gradient(145deg, rgba(255,255,255,0.15), rgba(255,255,255,0.02));
box-shadow: inset 0 1px 1px rgba(255,255,255,0.4), 0 8px 16px rgba(0,0,0,0.4);
color: #fff; transform: scale(1.1);
}
.category-row { position: relative; opacity: 0.4; transition: opacity 0.3s ease; }
.category-row:hover { opacity: 0.7; }
.category-row.is-active { opacity: 1; }
.category-row .cat-avatar { transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); z-index: 10; }
.category-row.is-active .cat-avatar { transform: scale(1.45) translateX(-5px); }
.category-row .cat-text-container { transition: transform 0.3s ease; }
.category-row.is-active .cat-text-container { transform: translateX(6px); }
.channel-card { position: relative; transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); z-index: 1; }
.channel-card.is-active {
background: linear-gradient(135deg, #363748 0%, #242530 100%);
transform: scale(1.04); z-index: 20;
}
.channel-card.is-active::before {
content: ""; position: absolute; left: 0; top: 50%; transform: translateY(-50%);
height: 60%; width: 4px; background-color: #fff;
border-top-right-radius: 4px; border-bottom-right-radius: 4px;
box-shadow: 0 0 12px rgba(255,255,255,0.6);
}
#sidebar { width: 340px; transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
#sidebar.collapsed { width: 80px; }
#category-panel { opacity: 1; transition: opacity 0.2s ease-in-out; pointer-events: auto; }
#sidebar.collapsed #category-panel { opacity: 0; pointer-events: none; }
#collapse-icon { transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
#sidebar.collapsed #collapse-icon { transform: rotate(180deg); }
#settings-modal { display: none; }
#settings-modal.open { display: flex; }

/* FIX: stream error overlay */
#stream-error-overlay {
  display: none; 
  position: absolute; 
  inset: 0; 
  z-index: 9999999 !important;
  align-items: center; 
  justify-content: center; 
  flex-direction: column;
  background: rgba(0,0,0,0.75); 
  gap: 12px;
}
#stream-error-overlay.visible { display: flex; }
#stream-error-overlay .err-icon { font-size: 48px; color: #EF4444; }
#stream-error-overlay .err-msg  { color: #fff; font-size: 15px; font-weight: 500; }
#stream-error-overlay .err-sub  { color: #9CA3AF; font-size: 12px; }
#stream-error-overlay .err-retry {
  margin-top: 8px; padding: 10px 24px; background: #2D5BE3; color: #fff;
  border: none; border-radius: 99px; font-size: 13px; font-weight: 600;
  cursor: pointer; transition: background 0.2s;
}
#stream-error-overlay .err-retry:hover { background: #4F77F5; }

/* Custom adjustments for Plyr styles */
.plyr {
  width: 100% !important;
  height: 100% !important;
  position: absolute !important;
  top: 0; left: 0;
  z-index: 0;
  --plyr-color-main: #2D5BE3;
}
.plyr__video-wrapper {
  height: 100% !important;
}
.plyr video {
  object-fit: contain !important;
  height: 100% !important;
}

/* ══════════════════════════════════════════
   MOBILE  (≤ 767px)
══════════════════════════════════════════ */
@media (max-width: 767px) {
    #desktop-layout { display: none !important; }
    body { display: block; height: 100dvh; overflow: hidden; background: #000; }

    #mobile-video-wrap { position: fixed; top: 0; left: 0; right: 0; bottom: 58px; background: #000; z-index: 0; }
    #mobile-video-wrap video, #mobile-video-wrap .plyr { width: 100% !important; height: 100% !important; }
    #now-playing-container { z-index: 5; }

    #mobile-sheet {
        position: fixed; bottom: 0; left: 0; right: 0;
        height: 58px; background: #16161E; border-radius: 0;
        z-index: 30; display: flex; flex-direction: column; overflow: hidden;
        transition: height 0.25s ease-out, border-radius 0.25s ease-out;
    }
    #mobile-sheet.is-open {
        height: 70dvh; background: #1A1B26; border-top-left-radius: 22px; border-top-right-radius: 22px;
        border-top: none; box-shadow: 0 -12px 48px rgba(0,0,0,0.85);
        transition: height 0.38s cubic-bezier(0.34, 1.45, 0.64, 1), border-radius 0.38s, background-color 0.2s;
    }

    #mobile-tab-bar {
        order: 2; flex-shrink: 0; height: 58px; background: #16161E;
        border-top: 1px solid #2A2B36; display: flex; align-items: center; padding: 0 4px; z-index: 2;
    }

    #mobile-pane-wrap {
        order: 1; flex: 1; overflow: hidden; display: flex; flex-direction: column;
        opacity: 0; pointer-events: none; transition: opacity 0.15s;
    }
    #mobile-sheet.is-open #mobile-pane-wrap { opacity: 1; pointer-events: auto; }

    #mobile-pane { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
    .mob-pane-section { display: none; height: 100%; flex: 1; min-height: 0; }
    .mob-pane-section.active { display: block; }

    #mob-pane-tv-wrapper { overflow: hidden; padding: 0; }
    #tv-slider { display: flex; width: 200%; height: 100%; transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); align-items: stretch; }

    #mob-pane-home { width: 50%; height: 100%; display: flex; flex-direction: column; padding: 0 12px; box-sizing: border-box; }
    #mob-pane-channels { width: 50%; height: 100%; display: flex; flex-direction: column; padding: 0 12px; box-sizing: border-box; }
    #mob-pane-fav { height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 10px 12px 16px; }

    .mob-tab {
        flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 2px; padding: 6px 0; border-radius: 10px; color: #8F93A2;
        font-size: 9px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
        cursor: pointer; transition: color 0.2s, background 0.2s; border: none; background: transparent;
    }
    .mob-tab .material-icons { font-size: 21px; }
    .mob-tab.is-active { color: #fff; background: rgba(255,255,255,0.08); }
    .mob-tab.logout-tab { flex: 0 0 42px; }

    .category-row { padding: 10px 8px; border-radius: 12px; }
    .category-row.is-active .cat-avatar { transform: scale(1.3) translateX(-3px); }
    .channel-card.is-active { transform: scale(1.02); }

    #mob-back-btn {
        display: none; position: fixed; bottom: 68px; left: 50%; transform: translateX(-50%);
        background: #2D5BE3; color: #fff; border: none; border-radius: 99px; padding: 10px 22px;
        font-size: 13px; font-weight: 600; cursor: pointer; z-index: 40; align-items: center; gap: 6px;
        box-shadow: 0 4px 20px rgba(45,91,227,0.55); white-space: nowrap;
    }
    #mob-back-btn.visible { display: flex; }
}

/* ══════════════════════════════════════════
   TABLET  (768px – 1023px)
══════════════════════════════════════════ */
@media (min-width: 768px) and (max-width: 1023px) {
    #sidebar { position: absolute; left: 0; top: 0; bottom: 0; z-index: 50; }
    #sidebar:not(.collapsed) { box-shadow: 4px 0 24px rgba(0,0,0,0.4); }
    #desktop-channel-panel { margin-left: 80px; width: 280px; padding-left: 14px; padding-right: 14px; }
}

/* ══════════════════════════════════════════
   DESKTOP  (≥ 1024px)
══════════════════════════════════════════ */
@media (min-width: 1024px) {
    #mobile-video-wrap { display: none !important; }
    #mobile-sheet      { display: none !important; }
    #mob-back-btn      { display: none !important; }
}

/* ══════════════════════════════════════════
   iOS SAFARI FULLSCREEN FALLBACK FIX
══════════════════════════════════════════ */
.plyr.plyr--fullscreen-fallback {
    position: fixed !important;
    inset: 0 !important;
    width: 100vw !important;
    height: 100dvh !important;
    z-index: 999999 !important;
    background-color: #000 !important;
    margin: 0 !important;
    border-radius: 0 !important;
}

.plyr.plyr--fullscreen-fallback video {
    height: 100% !important;
    object-fit: contain !important;
}

/* ══════════════════════════════════════════
   FULLSCREEN STACKING CONTEXT FIX
══════════════════════════════════════════ */
body.is-fullscreen #mobile-sheet {
    display: none !important;
}

body.is-fullscreen #mobile-video-wrap {
    bottom: 0 !important;
    z-index: 999999 !important;
}
</style>
</head>

<body class="bg-[#16161E] text-white overflow-hidden selection:bg-gray-700">

<!-- FIX: unsaved-changes guard modal -->
<div id="unsaved-modal" style="display:none;position:fixed;inset:0;z-index:200;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);">
  <div class="bg-[#1C1D26] border border-[#2A2B36] rounded-2xl shadow-2xl p-8 w-full max-w-sm mx-4 text-center">
    <span class="material-icons text-yellow-400 mb-3" style="font-size:40px;">warning</span>
    <h3 class="text-lg font-bold mb-2">Unsaved Changes</h3>
    <p class="text-sm text-gray-400 mb-6">You have unsaved source changes. Close anyway and lose them?</p>
    <div class="flex gap-3">
      <button onclick="confirmDiscardSettings()" class="flex-1 bg-red-600 hover:bg-red-500 text-white font-medium py-3 rounded-xl transition text-sm">Discard</button>
      <button onclick="cancelDiscardSettings()" class="flex-1 bg-[#272733] hover:bg-gray-600 text-white font-medium py-3 rounded-xl transition text-sm">Keep Editing</button>
    </div>
  </div>
</div>

<div id="settings-modal" class="fixed inset-0 z-[100] hidden items-center justify-center bg-black/70 backdrop-blur-sm p-4">
    <div class="bg-[#1C1D26] border border-[#2A2B36] rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[85vh]">
        
        <div class="flex items-center justify-between p-6 border-b border-[#2A2B36] shrink-0">
            <div>
                <h2 class="text-lg font-bold">M3U Sources</h2>
                <p class="text-xs text-gray-500 mt-0.5">Manage your playlists</p>
            </div>
            <div class="flex items-center gap-3">
                <button onclick="addBlankSource()" class="h-8 px-3 rounded-full bg-[#2D5BE3] hover:bg-blue-500 flex items-center justify-center text-white text-xs font-medium transition-colors gap-1 shadow-sm">
                    <span class="material-icons" style="font-size: 16px;">add</span> Add
                </button>
                <button onclick="tryCloseSettings()" class="w-8 h-8 rounded-full bg-[#272733] hover:bg-gray-600 flex items-center justify-center text-gray-400 hover:text-white transition-colors">
                    <span class="material-icons" style="font-size: 18px;">close</span>
                </button>
            </div>
        </div>

        <div id="sources-list" class="flex-1 overflow-y-auto p-6 space-y-4">
            <div class="flex justify-center py-6"><div class="loader"></div></div>
        </div>

        <div class="p-6 border-t border-[#2A2B36] shrink-0">
            <button id="save-sources-btn" onclick="saveSources()" class="w-full bg-[#2D5BE3] hover:bg-blue-600 transition-colors font-medium py-3.5 rounded-xl text-sm flex items-center justify-center gap-2 shadow-sm">
                <span class="material-icons" style="font-size: 18px;">save</span>
                <span id="save-btn-text">Save & Reload Channels</span>
            </button>
        </div>
    </div>
</div>

<div id="desktop-layout" class="h-screen flex">
<div id="sidebar" class="flex h-full shrink-0 bg-tv-bg z-20 overflow-hidden relative">
<div class="w-20 shrink-0 flex flex-col items-center py-10 gap-6 z-30 bg-tv-bg">
<button id="collapse-btn" class="w-10 h-10 rounded-full bg-[#272733] hover:bg-gray-600 flex items-center justify-center text-gray-400 hover:text-white transition-colors mb-6">
<span id="collapse-icon" class="material-icons" style="font-size: 20px;">chevron_left</span>
</button>
<button id="nav-home" class="nav-btn is-active w-12 h-12 rounded-full flex items-center justify-center text-gray-400 hover:text-white" title="Live TV">
<span class="material-icons">live_tv</span>
</button>
<button id="nav-fav" class="nav-btn w-12 h-12 rounded-full flex items-center justify-center text-gray-400 hover:text-white" title="Favorites">
<span class="material-icons">star</span>
</button>
<button id="nav-settings" class="nav-btn w-12 h-12 rounded-full flex items-center justify-center text-gray-400 hover:text-white" title="M3U Sources">
<span class="material-icons">settings</span>
</button>
<a href="?action=logout" class="nav-btn mt-auto w-12 h-12 rounded-full flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-500/10" title="Logout">
<span class="material-icons">logout</span>
</a>
</div>
<div id="category-panel" class="w-[270px] min-w-[270px] shrink-0 flex flex-col py-8 px-4 relative z-10 border-r border-[#2A2B36]/40">
<div class="mb-4 px-2">
    <div class="flex items-center justify-between mb-2">
        <h2 id="category-header" class="text-lg font-bold tracking-tight text-white">Categories</h2>
        <span id="cat-total-badge" class="text-[10px] font-semibold text-gray-400 bg-[#242530] px-2 py-0.5 rounded-full border border-[#2A2B36]">0</span>
    </div>
    <div class="relative">
        <span class="material-icons absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" style="font-size: 15px;">filter_list</span>
        <input type="text" id="cat-filter-input" placeholder="Filter categories..."
            class="peer w-full bg-[#1C1D26] border border-[#2A2B36] rounded-lg pl-8 pr-7 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors">
        <button onclick="clearSearch('cat-filter-input')" class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white opacity-0 pointer-events-none peer-[:not(:placeholder-shown)]:opacity-100 peer-[:not(:placeholder-shown)]:pointer-events-auto transition-opacity duration-200 flex items-center justify-center focus:outline-none">
            <span class="material-icons" style="font-size: 14px;">close</span>
        </button>
    </div>
</div>
<div id="category-list" class="flex-1 overflow-y-auto space-y-2 pr-1 pb-4 pt-1 px-1">
<div class="flex justify-center mt-10"><div class="loader"></div></div>
</div>
</div>
</div>

<div id="desktop-channel-panel" class="w-[380px] shrink-0 bg-tv-panel flex flex-col py-8 px-5 z-10 relative border-r border-[#2A2B36]/50">
<div class="mb-4 space-y-2.5">
    <div class="relative">
        <span class="material-icons absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" style="font-size: 18px;">search</span>
        <input type="text" id="search-bar" placeholder="Search 30k channels..."
            class="peer w-full bg-[#16161E] border border-[#2A2B38] rounded-xl pl-10 pr-10 py-2.5 text-sm text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 transition-all shadow-sm">
        <button onclick="clearSearch('search-bar')" class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white opacity-0 pointer-events-none peer-[:not(:placeholder-shown)]:opacity-100 peer-[:not(:placeholder-shown)]:pointer-events-auto transition-opacity duration-200 flex items-center justify-center focus:outline-none">
            <span class="material-icons" style="font-size: 16px;">close</span>
        </button>
    </div>
    <div class="flex items-center gap-1.5 p-1 bg-[#12131C] rounded-lg border border-[#2A2B36]">
        <button id="scope-all-btn" onclick="setSearchScope('all')" class="flex-1 py-1 px-2.5 rounded-md text-[11px] font-semibold transition-all flex items-center justify-center gap-1 bg-[#2D5BE3] text-white shadow-sm">
            <span class="material-icons" style="font-size: 13px;">public</span> All Channels
        </button>
        <button id="scope-cat-btn" onclick="setSearchScope('category')" class="flex-1 py-1 px-2.5 rounded-md text-[11px] font-semibold transition-all flex items-center justify-center gap-1 bg-transparent text-gray-400 hover:text-white">
            <span class="material-icons" style="font-size: 13px;">folder</span> In Category
        </button>
    </div>
</div>
<div class="flex items-center justify-between mb-3 px-1">
    <h3 id="channel-header-title" class="text-sm font-bold text-gray-200 truncate max-w-[210px]">All Channels</h3>
    <span id="total-channels-count" class="text-[11px] font-semibold text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2.5 py-0.5 rounded-full shrink-0">Loading ...</span>
</div>
<div id="channel-list" class="flex-1 overflow-y-auto flex flex-col gap-2.5 pr-1 pt-1 pb-4">
<div class="text-sm text-gray-500 mt-4 px-2">Loading channels...</div>
</div>
</div>

<div id="desktop-video-wrap" class="flex-1 relative bg-black z-0">
<video id="video-player" class="absolute inset-0 w-full h-full object-contain z-0" playsinline controls autoplay></video>
<!-- FIX: stream error overlay -->
<div id="stream-error-overlay">
  <span class="material-icons err-icon">signal_wifi_off</span>
  <span class="err-msg">Stream unavailable</span>
  <span class="err-sub" id="err-sub-msg">Retrying…</span>
  <button class="err-retry" onclick="retryCurrentStream()">Retry Now</button>
</div>
<div id="now-playing-container" class="absolute inset-0 z-10 flex flex-col justify-end opacity-0 transition-opacity duration-1000 pointer-events-none">
<div class="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/90 via-black/50 to-transparent z-0"></div>
<div class="relative z-10 p-6 pb-12">
<div class="flex items-center gap-3 mb-2 drop-shadow">
<p class="text-gray-400 text-sm font-semibold tracking-wider uppercase">Now Playing</p>
<span class="text-red-500 text-[10px] font-bold tracking-widest flex items-center gap-1.5 bg-red-500/10 px-2 py-0.5 rounded border border-red-500/20 shadow-sm">
<span class="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shadow-[0_0_6px_rgba(239,68,68,0.8)]"></span> LIVE
</span>
</div>
<h1 id="np-title" class="text-4xl font-bold mb-3 text-white tracking-tight drop-shadow-lg">Select a channel</h1>
<p class="text-gray-300 text-sm leading-relaxed max-w-2xl drop-shadow-md">Enjoy premium live television. Select a channel from the list on the left to begin streaming immediately.</p>
</div>
</div>
</div>
</div>

<!-- MOBILE LAYOUT -->
<div id="mobile-video-wrap">
    <!-- video element moved here by JS on mobile -->
</div>

<div id="mobile-sheet">
    <div id="mobile-pane-wrap">
        <div id="mobile-pane">
            <div class="mob-pane-section active" id="mob-pane-tv-wrapper">
                <div id="tv-slider">
                    <div id="mob-pane-home">
                        <div class="shrink-0 pt-3 pb-3 bg-[#1A1B26]">
                            <div class="relative">
    <span class="material-icons absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" style="font-size: 18px;">search</span>
    <input type="text" id="mob-search-input" placeholder="Search in all channels ..." autocomplete="off"
        class="peer w-full bg-[#242530] border border-transparent rounded-lg pl-10 pr-10 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-600 transition-colors">
    <button onclick="clearSearch('mob-search-input')" class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white opacity-0 pointer-events-none peer-[:not(:placeholder-shown)]:opacity-100 peer-[:not(:placeholder-shown)]:pointer-events-auto transition-opacity duration-200 flex items-center justify-center focus:outline-none">
        <span class="material-icons" style="font-size: 16px;">close</span>
    </button>
</div>
                        </div>

                        <div class="flex-1 overflow-y-auto min-h-0 pb-4" style="-webkit-overflow-scrolling: touch;">
                            <div id="mob-category-list">
                                <div class="flex justify-center mt-10"><div class="loader"></div></div>
                            </div>
                            <div id="mob-search-list" style="display: none;" class="flex-col gap-2"></div>
                        </div>
                    </div>
                    <div id="mob-pane-channels">
                        <div class="shrink-0 pt-3 pb-3 bg-[#1A1B26]">
                            <div class="relative">
    <span class="material-icons absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" style="font-size: 18px;">search</span>
    <input type="text" id="mob-channel-search-input" placeholder="Search in category ..." autocomplete="off"
        class="peer w-full bg-[#242530] border border-transparent rounded-lg pl-10 pr-10 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-600 transition-colors">
    <button onclick="clearSearch('mob-channel-search-input')" class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white opacity-0 pointer-events-none peer-[:not(:placeholder-shown)]:opacity-100 peer-[:not(:placeholder-shown)]:pointer-events-auto transition-opacity duration-200 flex items-center justify-center focus:outline-none">
        <span class="material-icons" style="font-size: 16px;">close</span>
    </button>
</div>
                        </div>

                        <div class="flex-1 overflow-y-auto min-h-0 pb-4" style="-webkit-overflow-scrolling: touch;">
                            <div id="mob-channel-list" class="flex flex-col gap-2"></div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="mob-pane-section" id="mob-pane-fav">
                <div id="mob-fav-list" class="flex flex-col gap-2"></div>
            </div>
        </div>
    </div>
    <div id="mobile-tab-bar">
        <button class="mob-tab is-active" id="mob-tab-home"     onclick="mobTab('home')">
            <span class="material-icons">live_tv</span><span>Live TV</span>
        </button>
        <button class="mob-tab" id="mob-tab-fav"                onclick="mobTab('fav')">
            <span class="material-icons">star</span><span>Favorites</span>
        </button>
        <button class="mob-tab" id="mob-tab-settings"           onclick="openSettings()">
            <span class="material-icons">settings</span><span>Sources</span>
        </button>
        <a href="?action=logout" class="mob-tab logout-tab">
            <span class="material-icons">logout</span>
        </a>
    </div>
</div>

<button id="mob-back-btn" onclick="mobBackToCategories()">
    <span class="material-icons" style="font-size:18px;">arrow_back</span>
    Categories
</button>

<script>
let player;
let hls;
let currentStreamUrl = null; // FIX: track current URL for retry

const isMobile = () => window.innerWidth < 768;
const getFavorites = () => JSON.parse(localStorage.getItem('iptv_favorites')) || [];
const saveFavorites = (f) => localStorage.setItem('iptv_favorites', JSON.stringify(f));

// FIX: destroy player before moving video element to avoid broken Plyr references
function safeDestroyPlayer() {
    if (player) { try { player.destroy(); } catch(e) {} player = null; }
}

function initializePlyr(options = {}) {
    safeDestroyPlayer();
    const freshVideo = document.getElementById('video-player');
    player = new Plyr(freshVideo, Object.assign({
        controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'settings', 'pip', 'fullscreen'],
        settings: ['quality', 'speed'],
        keyboard: { focused: true, global: true },
        i18n: { qualityLabel: { 0: 'Auto' } },
        fullscreen: { enabled: true, fallback: true, iosNative: false }
    }, options));
    player.on('enterfullscreen', () => document.body.classList.add('is-fullscreen'));
    player.on('exitfullscreen', () => document.body.classList.remove('is-fullscreen'));
}

let currentLayoutIsMobile = null; // Track the current layout state

function placeVideoElement() {
    const isCurrentlyMobile = isMobile();

    // ONLY destroy and move the player if we actually switched between Mobile and Desktop layouts.
    // If it's just a normal resize (like going fullscreen), do nothing and exit early.
    if (currentLayoutIsMobile === isCurrentlyMobile) {
        return; 
    }
    
    currentLayoutIsMobile = isCurrentlyMobile;

    // Destroy player before moving the video element
    safeDestroyPlayer();
    
    const vid        = document.getElementById('video-player');
    const nowPlaying = document.getElementById('now-playing-container');
    const errOverlay = document.getElementById('stream-error-overlay');
    
    if (isCurrentlyMobile) {
        const wrap = document.getElementById('mobile-video-wrap');
        if (!wrap.contains(vid))        wrap.appendChild(vid);
        if (!wrap.contains(nowPlaying)) wrap.appendChild(nowPlaying);
        if (errOverlay && !wrap.contains(errOverlay)) wrap.appendChild(errOverlay);
    } else {
        const wrap = document.getElementById('desktop-video-wrap');
        if (wrap && !wrap.contains(vid)) {
            wrap.insertBefore(vid, wrap.firstChild);
            wrap.insertBefore(nowPlaying, wrap.children[1] || null);
            if (errOverlay) wrap.insertBefore(errOverlay, wrap.children[2] || null);
        }
    }
    
    if (currentStreamUrl) playStream(currentStreamUrl);
    else initializePlyr();
}

placeVideoElement();
window.addEventListener('resize', placeVideoElement);

const categoryListEl  = document.getElementById('category-list');
const channelListEl   = document.getElementById('channel-list');
const categoryHeader  = document.getElementById('category-header');
const channelHeaderTitle = document.getElementById('channel-header-title');
const searchInput     = document.getElementById('search-bar');
const catFilterInput  = document.getElementById('cat-filter-input');
const nowPlayingContainer = document.getElementById('now-playing-container');
const npTitle         = document.getElementById('np-title');
const navHome         = document.getElementById('nav-home');
const navFav          = document.getElementById('nav-fav');
const navSettings     = document.getElementById('nav-settings');
const sidebar         = document.getElementById('sidebar');
const collapseBtn     = document.getElementById('collapse-btn');
const settingsModal   = document.getElementById('settings-modal');
const errorOverlay    = document.getElementById('stream-error-overlay');
const errSubMsg       = document.getElementById('err-sub-msg');

let globalChannelsData = [];
let categories = {};
let activeCategoryBtn  = null;
let activeChannelBtn   = null;

let searchScope = 'all';
let currentFilteredChannels = [];
let renderedCount = 0;
const PAGE_SIZE = 80;
let searchDebounceTimeout = null;

const CHANNEL_CACHE_MAX = 500;
const channelNodeCache  = {};
let channelCacheOrder   = [];

function addToCache(id, node) {
    if (channelNodeCache[id]) return;
    if (channelCacheOrder.length >= CHANNEL_CACHE_MAX) {
        const oldest = channelCacheOrder.shift();
        delete channelNodeCache[oldest];
    }
    channelNodeCache[id] = node;
    channelCacheOrder.push(id);
}

if (localStorage.getItem('iptv_sidebar_collapsed') === 'true') sidebar.classList.add('collapsed');

collapseBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    localStorage.setItem('iptv_sidebar_collapsed', sidebar.classList.contains('collapsed'));
});

loadChannels();

function loadChannels() {
    categoryListEl.innerHTML = '<div class="flex justify-center mt-10"><div class="loader"></div></div>';
    channelListEl.innerHTML  = '<div class="text-sm text-gray-500 mt-4 px-2">Loading channels...</div>';
    document.getElementById('total-channels-count').innerText = 'Loading ...';
    const mobCatList = document.getElementById('mob-category-list');
    if (mobCatList) mobCatList.innerHTML = '<div class="flex justify-center mt-10"><div class="loader"></div></div>';
    fetch('?action=channels')
        .then(r => r.json())
        .then(channels => {
            globalChannelsData = channels;
            Object.keys(channelNodeCache).forEach(k => delete channelNodeCache[k]);
            channelCacheOrder.length = 0;
            processData();
        });
}

function processData() {
    categories = {};
    globalChannelsData.forEach(ch => {
        const g = ch.group || 'Uncategorized';
        if (!categories[g]) categories[g] = [];
        categories[g].push(ch);
    });
    const catCount = Object.keys(categories).length;
    const catBadge = document.getElementById('cat-total-badge');
    if (catBadge) catBadge.innerText = catCount + ' groups';

    renderCategories();
    if (typeof renderMobileCategories === 'function') renderMobileCategories();
    
    const allBtn = categoryListEl.querySelector('button');
    if (allBtn) allBtn.click();
}

const COLORS = ['bg-blue-500','bg-red-500','bg-green-500','bg-yellow-500','bg-purple-500','bg-pink-500','bg-indigo-500'];

function renderCategories() {
    categoryListEl.innerHTML = '';
    const filterQuery = catFilterInput ? catFilterInput.value.toLowerCase().trim() : '';

    if (!filterQuery || "all channels".includes(filterQuery)) {
        const allBtn = document.createElement('button');
        allBtn.className = "category-row w-full text-left p-2.5 flex items-center gap-3.5 focus:outline-none cursor-pointer rounded-xl transition-all";
        allBtn.dataset.group = '__ALL__';
        allBtn.innerHTML = \`
        <div class="cat-avatar w-8 h-8 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white text-xs font-bold shrink-0 shadow-sm">
            <span class="material-icons" style="font-size: 16px;">public</span>
        </div>
        <div class="cat-text-container flex flex-col overflow-hidden">
            <span class="text-xs font-semibold text-white truncate">All Channels</span>
            <span class="text-[10px] text-gray-400 mt-0.5">\${{globalChannelsData.length} Channels</span>
        </div>
        \`;
        allBtn.onclick = () => {
            if (activeCategoryBtn) activeCategoryBtn.classList.remove('is-active');
            allBtn.classList.add('is-active');
            activeCategoryBtn = allBtn;
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('is-active'));
            navHome.classList.add('is-active');
            channelHeaderTitle.innerText = "All Channels";
            if (searchInput) searchInput.value = '';
            renderChannels(globalChannelsData);
        };
        categoryListEl.appendChild(allBtn);
    }

    Object.keys(categories).forEach(groupName => {
        const groupChannels = categories[groupName];
        if (!groupChannels.length) return;
        if (filterQuery && !groupName.toLowerCase().includes(filterQuery)) return;

        const colorClass = COLORS[groupName.length % COLORS.length];
        const initial = groupName.charAt(0).toUpperCase();
        const displayGroupName = groupName.replace(' > ', '<span class="material-icons align-middle text-gray-400" style="font-size: 14px; margin: -2px 2px 0 2px;">chevron_right</span>');

        const btn = document.createElement('button');
        btn.className = "category-row w-full text-left p-2.5 flex items-center gap-3.5 focus:outline-none cursor-pointer rounded-xl transition-all";
        btn.dataset.group = groupName;
        btn.innerHTML = \`
        <div class="cat-avatar w-8 h-8 rounded-full \${{colorClass} flex items-center justify-center text-white text-xs font-bold shrink-0 shadow-inner">\${{initial}</div>
        <div class="cat-text-container flex flex-col overflow-hidden">
            <span class="text-xs font-medium text-white truncate">\${{displayGroupName}</span>
            <span class="text-[10px] text-gray-400 mt-0.5">\${{groupChannels.length} Channels</span>
        </div>
        \`;

        btn.onclick = () => {
            if (activeCategoryBtn) activeCategoryBtn.classList.remove('is-active');
            btn.classList.add('is-active');
            activeCategoryBtn = btn;
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('is-active'));
            navHome.classList.add('is-active');
            channelHeaderTitle.innerText = groupName.replace(/^.*?>\s*/, '');
            if (searchInput) searchInput.value = '';
            renderChannels(groupChannels);
            if (window.innerWidth >= 768 && window.innerWidth <= 1023) {
                sidebar.classList.add('collapsed');
                localStorage.setItem('iptv_sidebar_collapsed', 'true');
            }
        };
        categoryListEl.appendChild(btn);
    });
}

if (catFilterInput) {
    catFilterInput.addEventListener('input', () => renderCategories());
}

    // Re-run search if there’s an active query
    if (searchInput && searchInput.value.trim()) {
        searchInput.dispatchEvent(new Event('input'));
    }
}

function renderFavorites() {
    if (activeCategoryBtn) activeCategoryBtn.classList.remove('is-active');
    activeCategoryBtn = null;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('is-active'));
    navFav.classList.add('is-active');
    channelHeaderTitle.innerText = "Favorites";
    if (searchInput) searchInput.value = '';
    const favChannels = globalChannelsData.filter(ch => getFavorites().includes(ch.id));
    renderChannels(favChannels);
    if (window.innerWidth >= 768 && window.innerWidth <= 1023) {
        sidebar.classList.add('collapsed');
        localStorage.setItem('iptv_sidebar_collapsed', 'true');
    }
}

function renderChannels(channelsArray, append = false) {
    if (!append) {
        currentFilteredChannels = channelsArray;
        renderedCount = 0;
        channelListEl.innerHTML = '';
        document.getElementById('total-channels-count').innerText = \`\${{currentFilteredChannels.length} Channels\`;
    }

    if (!currentFilteredChannels.length) {
        channelListEl.innerHTML = '<div class="text-sm text-gray-500 p-6 text-center">No channels found.</div>';
        return;
    }

    const slice = currentFilteredChannels.slice(renderedCount, renderedCount + PAGE_SIZE);
    if (!slice.length) return;

    const fragment = document.createDocumentFragment();
    slice.forEach(ch => {
        let btn;
        if (channelNodeCache[ch.id]) {
            btn = channelNodeCache[ch.id];
            if (activeChannelBtn && activeChannelBtn.dataset.id === ch.id) { btn.classList.add('is-active'); activeChannelBtn = btn; }
            else btn.classList.remove('is-active');
            const starEl = btn.querySelector('.star-btn');
            const isFav = getFavorites().includes(ch.id);
            starEl.classList.toggle('text-[#E87A31]', isFav);
            starEl.classList.toggle('text-gray-600', !isFav);
            starEl.innerHTML = \`<span class="material-icons" style="font-size:18px;">\${{isFav ? 'star' : 'star_border'}</span>\`;
        } else {
            btn = buildDesktopCard(ch);
            addToCache(ch.id, btn);
        }
        fragment.appendChild(btn);
    });

    channelListEl.appendChild(fragment);
    renderedCount += slice.length;
}

channelListEl.addEventListener('scroll', () => {
    if (channelListEl.scrollTop + channelListEl.clientHeight >= channelListEl.scrollHeight - 200) {
        if (renderedCount < currentFilteredChannels.length) {
            renderChannels(currentFilteredChannels, true);
        }
    }
});

function buildDesktopCard(ch) {
    const btn = document.createElement('button');
    btn.className = "channel-card w-full text-left bg-tv-card hover:bg-tv-cardhover rounded-xl p-3 flex items-center gap-3.5 focus:outline-none cursor-pointer shadow-sm border border-[#2A2B36]/30";
    if (activeChannelBtn && activeChannelBtn.dataset.id === ch.id) { btn.classList.add('is-active'); }
    btn.dataset.id = ch.id;

    const safeLogoUrl = ch.logo ? '?action=logo&url=' + encodeURIComponent(ch.logo) : '';
    const safeName    = escHtml(ch.name);
    const initial     = escHtml(ch.name.charAt(0));
    const logoHtml = ch.logo
        ? \`<img src="\${{safeLogoUrl}" loading="lazy" class="w-full h-full object-contain" alt="\${{safeName}" onerror="this.outerHTML='<span class=&quot;text-xs font-bold text-gray-400&quot;>\${{initial}</span>'">\`
        : \`<span class="text-xs font-bold text-gray-400">\${{initial}</span>\`;

    const isFav = getFavorites().includes(ch.id);
    const starColor = isFav ? "text-[#E87A31]" : "text-gray-600 hover:text-[#E87A31]";
    const starIcon  = isFav ? "star" : "star_border";

    let badgesHtml = '';
    if (ch.is_hd) badgesHtml += '<span class="text-[8px] font-bold bg-white text-black px-1 rounded-sm shadow-sm">HD</span>';
    if (ch.has_epg) badgesHtml += '<span class="text-[8px] font-bold bg-gray-600 text-white px-1 rounded-sm shadow-sm">EPG</span>';
    
    let catTag = '';
    if (ch.group) {
        const cleanGroup = ch.group.replace(/^.*?>\s*/, '');
        catTag = \`<span class="text-[8px] font-medium bg-[#1C1D26] text-gray-400 border border-[#2A2B38] px-1.5 py-0.5 rounded truncate max-w-[110px]" title="\${{escHtml(ch.group)}">\${{escHtml(cleanGroup)}</span>\`;
    }

    btn.innerHTML = \`
    <div class="w-12 h-12 bg-[#1C1D26] border border-[#2D2E3D] rounded-lg flex items-center justify-center shrink-0 overflow-hidden shadow-inner">\${{logoHtml}</div>
    <div class="flex-1 flex flex-col overflow-hidden py-0.5">
        <span class="text-xs font-semibold text-white truncate">\${{safeName}</span>
        <div class="flex items-center gap-1 mt-1.5 flex-wrap">\${{badgesHtml}\${{catTag}</div>
    </div>
    <div class="star-btn p-1.5 shrink-0 \${{starColor} transition-colors" data-id="\${{ch.id}">
        <span class="material-icons" style="font-size: 18px;">\${{starIcon}</span>
    </div>
    \`;

    let hideBannerTimeout;
    btn.onclick = (e) => {
        if (e.target.closest('.star-btn')) return;
        if (activeChannelBtn) activeChannelBtn.classList.remove('is-active');
        btn.classList.add('is-active'); activeChannelBtn = btn;
        npTitle.innerText = ch.name;
        nowPlayingContainer.classList.remove('opacity-0');
        clearTimeout(hideBannerTimeout);
        hideBannerTimeout = setTimeout(() => nowPlayingContainer.classList.add('opacity-0'), 4000);
        playStream(\`?action=proxy&url=\${{encodeURIComponent(ch.url)}\`);
    };

    const starEl = btn.querySelector('.star-btn');
    starEl.onclick = (e) => {
        e.stopPropagation();
        toggleFavorite(ch.id, starEl, () => {
            if (navFav.classList.contains('is-active')) {
                btn.remove();
                document.getElementById('total-channels-count').innerText = \`\${{getFavorites().length} Channels\`;
            }
        });
    };
    return btn;
}

navFav.addEventListener('click', renderFavorites);
navHome.addEventListener('click', () => {
    if (activeCategoryBtn) activeCategoryBtn.click();
    else { const fb = categoryListEl.querySelector('button'); if (fb) fb.click(); }
});

function applySearch() {
    const query = (searchInput && searchInput.value ? searchInput.value : '').toLowerCase().trim();
    if (!query) {
        if (navFav.classList.contains('is-active')) { renderFavorites(); }
        else if (activeCategoryBtn) { activeCategoryBtn.click(); }
        else { renderChannels(globalChannelsData); }
        return;
    }

    let pool = globalChannelsData;
    if (searchScope === 'category' && activeCategoryBtn && activeCategoryBtn.dataset.group && activeCategoryBtn.dataset.group !== '__ALL__') {
        const g = activeCategoryBtn.dataset.group;
        pool = categories[g] || [];
    }

    const filtered = pool.filter(ch => ch.name.toLowerCase().includes(query));
    if (categoryHeader) categoryHeader.innerText = 'Search Results';
    channelHeaderTitle.innerText = searchScope === 'category' ? 'In Category' : 'All Channels';
    document.getElementById('total-channels-count').innerText = filtered.length + ' Channels found';
    renderChannels(filtered);
}

searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimeout);
    searchDebounceTimeout = setTimeout(applySearch, 120);
});

function toggleFavorite(channelId, starEl, onRemoveCallback) {
    let favs = getFavorites();
    if (favs.includes(channelId)) {
        favs = favs.filter(id => id !== channelId);
        saveFavorites(favs);
        starEl.classList.remove('text-[#E87A31]');
        starEl.classList.add('text-gray-600');
        starEl.innerHTML = '<span class="material-icons" style="font-size:18px;">star_border</span>';
        if (onRemoveCallback) onRemoveCallback();
    } else {
        favs.push(channelId);
        saveFavorites(favs);
        starEl.classList.remove('text-gray-600');
        starEl.classList.add('text-[#E87A31]');
        starEl.innerHTML = '<span class="material-icons" style="font-size:18px;">star</span>';
    }
}

// ==========================================
// STREAM ERROR OVERLAY
// ==========================================
function showStreamError(msg, retrying) {
    if (!errorOverlay) return;
    errSubMsg.innerText = retrying ? 'Retrying in 3s…' : (msg || '');
    errorOverlay.classList.add('visible');
}
function hideStreamError() {
    if (!errorOverlay) return;
    errorOverlay.classList.remove('visible');
}
function retryCurrentStream() {
    if (currentStreamUrl) playStream(currentStreamUrl);
}

// ==========================================
// MOBILE SHEET LOGIC
// ==========================================
let currentMobTab = 'home';
let sheetOpen = false;
let mobShowChannels = false;

function updateMobBackBtn() {
    const btn = document.getElementById('mob-back-btn');
    if (sheetOpen && currentMobTab === 'home' && mobShowChannels) {
        btn.classList.add('visible');
    } else {
        btn.classList.remove('visible');
    }
}

function mobTab(tab) {
    const sheet = document.getElementById('mobile-sheet');
    if (tab === currentMobTab && sheetOpen) {
        sheet.classList.remove('is-open');
        sheetOpen = false;
        updateMobBackBtn();
        return;
    }
    sheet.classList.add('is-open');
    sheetOpen = true;
    currentMobTab = tab;
    document.querySelectorAll('.mob-tab').forEach(b => b.classList.remove('is-active'));
    const activeBtn = document.getElementById('mob-tab-' + tab);
    if (activeBtn) activeBtn.classList.add('is-active');
    document.querySelectorAll('.mob-pane-section').forEach(p => p.classList.remove('active'));
    if (tab === 'home') {
        document.getElementById('mob-pane-tv-wrapper').classList.add('active');
        if (!mobShowChannels) {
            document.getElementById('tv-slider').style.transform = 'translateX(0)';
            document.getElementById('mob-back-btn').classList.remove('visible');
        }
    } else if (tab === 'fav') {
        renderMobileFavorites();
        document.getElementById('mob-pane-fav').classList.add('active');
    }
    updateMobBackBtn();
}

document.getElementById('mobile-video-wrap').addEventListener('click', () => {
    document.getElementById('mobile-sheet').classList.remove('is-open');
    sheetOpen = false;
    updateMobBackBtn();
});

['mob-channel-list', 'mob-fav-list', 'mob-search-list'].forEach(id => {
    const el = document.getElementById(id);
    if(el) {
        el.addEventListener('click', e => {
            if (!e.target.closest('.mob-star-btn') && e.target.closest('.channel-card')) {
                document.getElementById('mobile-sheet').classList.remove('is-open');
                sheetOpen = false;
                updateMobBackBtn();
            }
        });
    }
});

function mobBackToCategories() {
    mobShowChannels = false;
    document.getElementById('tv-slider').style.transform = 'translateX(0)';
    document.getElementById('mobile-pane').scrollTop = 0;
    // FIX: also reset the category channel search
    const chInput = document.getElementById('mob-channel-search-input');
    if (chInput) { chInput.value = ''; chInput.dispatchEvent(new Event('input')); }
    updateMobBackBtn();
}

function renderMobileCategories() {
    const el = document.getElementById('mob-category-list');
    if (!el) return;
    el.innerHTML = '';
    Object.keys(categories).forEach(groupName => {
        const groupChannels = categories[groupName];
        if (!groupChannels.length) return;
        const colorClass = COLORS[groupName.length % COLORS.length];
        const initial = groupName.charAt(0).toUpperCase();
        const displayGroupName = groupName.replace(' > ', '<span class="material-icons align-middle text-gray-400" style="font-size:14px;margin:-2px 2px 0 2px;">chevron_right</span>');
        const btn = document.createElement('button');
        btn.className = "category-row w-full text-left p-3 flex items-center gap-4 focus:outline-none cursor-pointer rounded-xl";
        btn.innerHTML = \`
        <div class="cat-avatar w-8 h-8 rounded-full \${colorClass} flex items-center justify-center text-white text-xs font-bold shrink-0">\${initial}</div>
        <div class="cat-text-container flex flex-col overflow-hidden">
            <span class="text-sm font-medium text-white truncate">\${displayGroupName}</span>
            <span class="text-[11px] text-gray-500 mt-0.5">\${groupChannels.length} ch</span>
        </div>
        <span class="material-icons text-gray-600 ml-auto" style="font-size:18px;">chevron_right</span>\`;
        btn.onclick = () => {
            renderMobileChannels(groupChannels);
            document.getElementById('tv-slider').style.transform = 'translateX(-50%)';
            mobShowChannels = true;
            const chInput = document.getElementById('mob-channel-search-input');
            if(chInput) chInput.value = '';
            document.getElementById('mobile-pane').scrollTop = 0;
            updateMobBackBtn();
        };
        el.appendChild(btn);
    });
}

function renderMobileChannels(arr) {
    const el = document.getElementById('mob-channel-list');
    if(!el) return;
    el.innerHTML = '';
    if (!arr.length) { el.innerHTML = '<div class="text-sm text-gray-500 p-4 text-center">No channels found.</div>'; return; }
    arr.forEach(ch => el.appendChild(buildMobileCard(ch)));
}

function renderMobileFavorites() {
    const favChannels = globalChannelsData.filter(ch => getFavorites().includes(ch.id));
    const el = document.getElementById('mob-fav-list');
    if(!el) return;
    el.innerHTML = '';
    if (!favChannels.length) { el.innerHTML = '<div class="text-sm text-gray-500 p-4 text-center">No favorites yet. Tap ★ on any channel.</div>'; return; }
    favChannels.forEach(ch => el.appendChild(buildMobileCard(ch)));
}

// FIX: use escHtml in mobile card onerror too
function buildMobileCard(ch) {
    const btn = document.createElement('button');
    btn.className = "channel-card w-full text-left bg-[#242530] rounded-xl p-3 flex items-center gap-3 focus:outline-none cursor-pointer";
    btn.dataset.id = ch.id;
    const safeLogoUrl = ch.logo ? '?action=logo&url=' + encodeURIComponent(ch.logo) : '';
    const safeName = escHtml(ch.name);
    const initial  = escHtml(ch.name.charAt(0));
    const logoHtml = ch.logo
        ? \`<img src="\${safeLogoUrl}" loading="lazy" class="w-full h-full object-contain" alt="\${safeName}" onerror="this.outerHTML='<span class=&quot;text-xs font-bold&quot;>\${initial}</span>'">\`
        : \`<span class="text-xs font-bold text-gray-400">\${initial}</span>\`;
    const isFav = getFavorites().includes(ch.id);
    const starIcon  = isFav ? "star" : "star_border";
    const starColor = isFav ? "text-[#E87A31]" : "text-gray-600";
    let badgesHtml = '';
    if (ch.is_hd) badgesHtml += '<span class="text-[8px] font-bold bg-white text-black px-1 rounded-sm">HD</span>';
    btn.innerHTML = \`
    <div class="w-11 h-11 bg-[#1C1D26] border border-[#2D2E3D] rounded flex items-center justify-center shrink-0 overflow-hidden">\${logoHtml}</div>
    <div class="flex-1 flex flex-col overflow-hidden">
        <span class="text-sm font-semibold text-white truncate">\${safeName}</span>
        <div class="flex gap-1 mt-1">\${badgesHtml}</div>
    </div>
    <div class="mob-star-btn shrink-0 \${starColor} p-2" data-id="\${ch.id}">
        <span class="material-icons" style="font-size:18px;">\${starIcon}</span>
    </div>\`;
    btn.onclick = e => {
        if (e.target.closest('.mob-star-btn')) return;
        npTitle.innerText = ch.name;
        nowPlayingContainer.classList.remove('opacity-0');
        setTimeout(() => nowPlayingContainer.classList.add('opacity-0'), 4000);
        playStream(\`?action=proxy&url=\${encodeURIComponent(ch.url)}\`);
    };
    const starEl = btn.querySelector('.mob-star-btn');
    starEl.onclick = e => {
        e.stopPropagation();
        toggleFavorite(ch.id, starEl, () => {
            if (currentMobTab === 'fav') {
                btn.remove();
                if (document.getElementById('mob-fav-list').children.length === 0) { renderMobileFavorites(); }
            }
        });
    };
    return btn;
}

const mobSearchInput = document.getElementById('mob-search-input');
if(mobSearchInput) {
    mobSearchInput.addEventListener('input', e => {
        const q  = e.target.value.toLowerCase().trim();
        const searchList = document.getElementById('mob-search-list');
        const catList    = document.getElementById('mob-category-list');
        searchList.innerHTML = '';
        // FIX: always explicitly reset both display states
        if (!q) {
            catList.style.display    = 'block';
            searchList.style.display = 'none';
            return;
        }
        catList.style.display    = 'none';
        searchList.style.display = 'flex';
        const filtered = globalChannelsData.filter(ch => ch.name.toLowerCase().includes(q));
        if (filtered.length === 0) {
            searchList.innerHTML = '<div class="text-sm text-gray-500 p-4 text-center">No channels found.</div>';
        } else {
            filtered.forEach(ch => searchList.appendChild(buildMobileCard(ch)));
        }
    });
}

const mobChannelSearchInput = document.getElementById('mob-channel-search-input');
if (mobChannelSearchInput) {
    mobChannelSearchInput.addEventListener('input', e => {
        const q = e.target.value.toLowerCase().trim();
        const channelCards = document.querySelectorAll('#mob-channel-list .channel-card');
        channelCards.forEach(card => {
            const channelNameEl = card.querySelector('.font-semibold');
            if (channelNameEl) {
                card.style.display = channelNameEl.innerText.toLowerCase().includes(q) ? 'flex' : 'none';
            }
        });
    });
}

// ==========================================
// STREAM PLAYER
// ==========================================
function playStream(url) {
    currentStreamUrl = url;
    hideStreamError();

    safeDestroyPlayer();
    if (hls) { hls.destroy(); hls = null; }

    const nativeVideo = document.getElementById('video-player');

    if (Hls.isSupported()) {
        let initialEstimate = 120000;
        let maxBufferLength = 120;
        let syncDuration    = 15;

        if (navigator.connection) {
            const conn = navigator.connection;
            if (conn.effectiveType === '2g' || conn.effectiveType === '3g' || conn.saveData || (conn.downlink && conn.downlink < 0.8)) {
                initialEstimate = 70000;
                maxBufferLength = 180;
                syncDuration    = 20;
            }
        }

        hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            progressive: true,
            backBufferLength: 90,
            maxBufferLength: maxBufferLength,
            maxMaxBufferLength: 300,
            maxBufferSize: 120 * 1024 * 1024,
            liveSyncDurationCount: syncDuration,
            liveMaxLatencyDurationCount: syncDuration + 8,
            abrEwmaDefaultEstimate: initialEstimate,
            abrBandwidthFactor: 0.5,
            abrBandwidthUpFactor: 0.3,
            fragLoadingTimeOut: 35000,
            manifestLoadingTimeOut: 35000,
            levelLoadingTimeOut: 35000,
            fragLoadingMaxRetry: 20,
            manifestLoadingMaxRetry: 20,
            levelLoadingMaxRetry: 20,
            fragLoadingRetryDelay: 2000,
            manifestLoadingRetryDelay: 2000,
            levelLoadingRetryDelay: 2000
        });

        hls.loadSource(url);
        hls.attachMedia(nativeVideo);

        // FIX: show visible error overlay on fatal HLS errors
        hls.on(Hls.Events.ERROR, function (event, data) {
            if (data.fatal) {
                switch (data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        showStreamError('Network error', true);
                        setTimeout(() => { hideStreamError(); hls.startLoad(); }, 3000);
                        break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                        showStreamError('Media error', true);
                        setTimeout(() => { hideStreamError(); hls.recoverMediaError(); }, 3000);
                        break;
                    default:
                        showStreamError('Stream unavailable', true);
                        setTimeout(() => { hideStreamError(); playStream(url); }, 5000);
                        break;
                }
            }
        });

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            hideStreamError();
            const availableQualities = hls.levels.map(l => l.height).filter(h => h);
            let uniqueQualities = [...new Set(availableQualities)].sort((a, b) => b - a);

            let isWeakConnection = false;
            let maxCappedHeight  = 360;

            if (navigator.connection) {
                const conn = navigator.connection;
                if (conn.effectiveType === '2g' || conn.effectiveType === '3g' || conn.saveData || (conn.downlink && conn.downlink < 0.8)) {
                    isWeakConnection = true;
                    maxCappedHeight  = 240;
                }
            }

            const plyrOptions = {};
            if (uniqueQualities.length > 0) {
                if (isWeakConnection || maxCappedHeight === 240) {
                    const cappedLevels = hls.levels.filter(l => l.height && l.height <= maxCappedHeight);
                    if (cappedLevels.length > 0) {
                        const maxLevelHeight = Math.max(...cappedLevels.map(l => l.height));
                        const maxLevelIndex  = hls.levels.findIndex(l => l.height === maxLevelHeight);
                        hls.maxSupportedLevel = maxLevelIndex;
                        uniqueQualities = uniqueQualities.filter(q => q <= maxCappedHeight);
                    }
                }
                uniqueQualities.unshift(0);
                plyrOptions.quality = {
                    default: 0,
                    options: uniqueQualities,
                    forced: true,
                    onChange: (quality) => {
                        if (quality === 0) { hls.currentLevel = -1; }
                        else {
                            const levelIndex = hls.levels.findIndex(l => l.height === quality);
                            if (levelIndex !== -1) hls.currentLevel = levelIndex;
                        }
                    }
                };
            }

            hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
                const span = document.querySelector(".plyr__menu__container [data-plyr='quality'][value='0'] span");
                if (span) {
                    if (hls.autoLevelEnabled && hls.levels[data.level]) {
                        const height = hls.levels[data.level].height;
                        span.innerHTML = height ? "Auto (" + height + "p)" : "Auto";
                    } else {
                        span.innerHTML = "Auto";
                    }
                }
            });

            let stallTimer;
            nativeVideo.addEventListener('waiting', () => {
                clearTimeout(stallTimer);
                stallTimer = setTimeout(() => {
                    if (hls && hls.levels && hls.levels.length > 0) {
                        const lowestLevelIndex = hls.levels.reduce((minIdx, lvl, idx, arr) =>
                            (lvl.bandwidth < arr[minIdx].bandwidth) ? idx : minIdx, 0);
                        if (hls.currentLevel !== lowestLevelIndex) hls.currentLevel = lowestLevelIndex;
                    }
                }, 3000);
            });

            nativeVideo.addEventListener('playing', () => { clearTimeout(stallTimer); });

            const freshVideo = document.getElementById('video-player');
            player = new Plyr(freshVideo, {
                controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'settings', 'pip', 'fullscreen'],
                settings: ['quality', 'speed'],
                keyboard: { focused: true, global: true },
                i18n: { qualityLabel: { 0: 'Auto' } },
                fullscreen: { enabled: true, fallback: true, iosNative: false },
                ...plyrOptions
            });
            player.on('enterfullscreen', () => document.body.classList.add('is-fullscreen'));
            player.on('exitfullscreen', () => document.body.classList.remove('is-fullscreen'));
            player.play().catch(() => {});
        });

    } else if (nativeVideo.canPlayType('application/vnd.apple.mpegurl')) {
        nativeVideo.src = url; 
        
        nativeVideo.onerror = () => showStreamError('Stream unavailable', false);

        player = new Plyr(nativeVideo, {
            controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'settings', 'pip', 'fullscreen'],
            settings: ['quality', 'speed'],
            keyboard: { focused: true, global: true },
            i18n: { qualityLabel: { 0: 'Auto' } },
            fullscreen: { enabled: true, fallback: true, iosNative: false }
        });
        player.on('enterfullscreen', () => document.body.classList.add('is-fullscreen'));
        player.on('exitfullscreen', () => document.body.classList.remove('is-fullscreen'));
        player.play().catch(() => {});
    }
}

// ==========================================
// SETTINGS MENU
// ==========================================
let sourcesData      = [];
let sourcesOriginal  = ''; // FIX: snapshot to detect unsaved changes
let previousNav      = null;

navSettings.addEventListener('click', openSettings);

function openSettings() {
    previousNav = navFav.classList.contains('is-active') ? navFav : navHome;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('is-active'));
    navSettings.classList.add('is-active');
    settingsModal.classList.add('open');
    loadSources();
}

// FIX: check for unsaved changes before closing
function tryCloseSettings() {
    const currentSnapshot = JSON.stringify(sourcesData);
    if (currentSnapshot !== sourcesOriginal) {
        document.getElementById('unsaved-modal').style.display = 'flex';
    } else {
        closeSettings();
    }
}

function confirmDiscardSettings() {
    document.getElementById('unsaved-modal').style.display = 'none';
    closeSettings();
}

function cancelDiscardSettings() {
    document.getElementById('unsaved-modal').style.display = 'none';
}

function closeSettings() {
    settingsModal.classList.remove('open');
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('is-active'));
    if (previousNav === navFav) { navFav.classList.add('is-active'); }
    else { navHome.classList.add('is-active'); }
}

// FIX: clicking the backdrop also triggers the unsaved-changes guard
settingsModal.addEventListener('click', e => { if (e.target === settingsModal) tryCloseSettings(); });

async function loadSources() {
    document.getElementById('sources-list').innerHTML = '<div class="flex justify-center py-6"><div class="loader"></div></div>';
    const res = await fetch('?action=get-sources');
    sourcesData = await res.json();
    sourcesOriginal = JSON.stringify(sourcesData); // FIX: snapshot after load
    renderSources();
}

function renderSources() {
    const list = document.getElementById('sources-list');
    if (!sourcesData.length) {
        list.innerHTML = '<p class="text-sm text-gray-500 text-center py-4">No sources yet. Add one below.</p>';
        return;
    }
    list.innerHTML = '';
    sourcesData.forEach((src, idx) => {
        const isEnabled = src.enabled !== false;
        const count = globalChannelsData.filter(ch => ch.source === src.name).length;

        const item = document.createElement('div');
        item.className = \`source-item flex flex-col gap-3 p-4 bg-[#242530] border border-[#2A2B36] rounded-xl relative shadow-sm transition-all duration-300 \${!isEnabled ? 'opacity-50 grayscale-[30%]' : ''}\`;

        let statusBadge = '';
        if (!isEnabled) {
            statusBadge = \`<span class="text-[11px] text-gray-400 bg-gray-500/10 border border-gray-500/20 px-2 py-0.5 rounded shadow-sm font-bold">DISABLED</span>\`;
        } else if (src.isNew) {
            statusBadge = \`<span class="text-[10px] text-orange-400 bg-orange-500/10 border border-orange-500/20 px-2 py-0.5 rounded shadow-sm font-bold uppercase tracking-wider">Save to Load</span>\`;
        } else {
            statusBadge = \`<span class="text-[11px] text-[#2D5BE3] bg-[#2D5BE3]/10 border border-[#2D5BE3]/20 px-2 py-0.5 rounded shadow-sm font-bold">\${count}</span>\`;
        }

        item.innerHTML = \`
        <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-full \${isEnabled ? 'bg-[#2D5BE3]' : 'bg-gray-600'} flex items-center justify-center text-white text-sm font-bold shrink-0 shadow-inner transition-colors">\${idx + 1}</div>
            <div class="flex-1 min-w-0">
                <input class="src-name w-full bg-[#1C1D26] rounded-lg px-3 py-2 text-sm text-white font-medium border border-transparent focus:border-blue-500 focus:outline-none transition-colors"
                    value="\${escHtml(src.name)}" placeholder="Source name" data-idx="\${idx}" \${!isEnabled ? 'readonly' : ''}>
            </div>

            <label class="relative inline-flex items-center cursor-pointer shrink-0" title="Enable/Disable Source">
                <input type="checkbox" class="sr-only peer" \${isEnabled ? 'checked' : ''} onchange="toggleSource(\${idx}, this.checked)">
                <div class="w-11 h-6 bg-[#1C1D26] border border-[#2A2B36] rounded-full peer
                    transition-colors duration-300 ease-in-out
                    peer-checked:bg-[#2D5BE3] peer-checked:border-[#2D5BE3]
                    after:content-[''] after:absolute after:top-[2px] after:left-[2px]
                    after:bg-gray-400 peer-checked:after:bg-white after:rounded-full
                    after:h-5 after:w-5 after:transition-all after:duration-300 after:ease-in-out
                    peer-checked:after:translate-x-5">
                </div>
            </label>

            <button onclick="removeSource(\${idx})" class="w-9 h-9 rounded-full bg-red-500/10 hover:bg-red-500/20 flex items-center justify-center text-red-400 transition-colors shrink-0 ml-1" title="Delete Source">
                <span class="material-icons" style="font-size:18px;">delete</span>
            </button>
        </div>
        <div class="flex flex-col gap-2">
            <textarea class="src-url w-full bg-[#1C1D26] rounded-lg px-3 py-2.5 text-[11px] text-gray-400 font-mono border border-transparent focus:border-blue-500 focus:outline-none transition-colors resize-none overflow-hidden"
                rows="2" placeholder="M3U URL" data-idx="\${idx}" \${!isEnabled ? 'readonly' : ''}>\${escHtml(src.url)}</textarea>

            <div class="flex items-center justify-between px-1 mt-1">
                <span class="text-[10px] text-gray-500 uppercase tracking-wider font-semibold flex items-center gap-1">
                    <span class="material-icons text-gray-500" style="font-size: 14px;">format_list_bulleted</span>
                    Channels \${isEnabled ? (src.isNew ? 'Pending' : 'Loaded') : 'Status'}
                </span>
                \${statusBadge}
            </div>
        </div>
        \`;

        item.querySelector('.src-name').addEventListener('input', e => { sourcesData[idx].name = e.target.value; });
        item.querySelector('.src-url').addEventListener('input',  e => { sourcesData[idx].url  = e.target.value; });
        list.appendChild(item);
    });
}

function addBlankSource() {
    sourcesData.push({ 
        id: 'src_' + Date.now(), 
        name: '', 
        url: '', 
        enabled: true, 
        isNew: true 
    });
    
    renderSources();

    setTimeout(() => {
        const list = document.getElementById('sources-list');
        
        list.scrollTop = list.scrollHeight;
        
        const inputs = list.querySelectorAll('.src-name');
        if (inputs.length > 0) {
            inputs[inputs.length - 1].focus();
        }
    }, 50);
}

function removeSource(idx) {
    sourcesData.splice(idx, 1);
    renderSources();
}

async function saveSources() {
    for (const src of sourcesData) {
        if (!src.name.trim() || !src.url.trim()) { alert('All sources must have a name and URL.'); return; }
    }
    const dataToSave = sourcesData.map(src => {
        const cleanSrc = { ...src };
        delete cleanSrc.isNew;
        return cleanSrc;
    });

    const btn  = document.getElementById('save-sources-btn');
    const text = document.getElementById('save-btn-text');
    btn.disabled = true; text.innerText = 'Saving...';
    try {
        const res = await fetch('?action=save-sources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sources: dataToSave })
        });
        const data = await res.json();
        if (data.status === 'success') {
            sourcesOriginal = JSON.stringify(sourcesData); // FIX: update snapshot after save
            text.innerText = 'Saved! Reloading channels...';
            Object.keys(channelNodeCache).forEach(k => delete channelNodeCache[k]);
            channelCacheOrder.length = 0;
            setTimeout(() => {
                closeSettings();
                loadChannels();
                btn.disabled = false; text.innerText = 'Save & Reload Channels';
            }, 800);
        } else {
            alert('Save failed: ' + (data.message || 'Unknown error'));
            btn.disabled = false; text.innerText = 'Save & Reload Channels';
        }
    } catch(e) {
        alert('Network error while saving.');
        btn.disabled = false; text.innerText = 'Save & Reload Channels';
    }
}

function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function clearSearch(inputId) {
    const inputEl = document.getElementById(inputId);
    if (inputEl) {
        inputEl.value = '';
        inputEl.dispatchEvent(new Event('input'));
        inputEl.focus();
    }
}

function toggleSource(idx, isChecked) {
    sourcesData[idx].enabled = isChecked;

    const list = document.getElementById('sources-list');
    const item = list.children[idx];
    if (!item) return;

    if (isChecked) {
        item.classList.remove('opacity-50', 'grayscale-[30%]');
    } else {
        item.classList.add('opacity-50', 'grayscale-[30%]');
    }

    const numberCircle = item.querySelector('.w-9.h-9.text-white');
    if (numberCircle) {
        if (isChecked) {
            numberCircle.classList.remove('bg-gray-600');
            numberCircle.classList.add('bg-[#2D5BE3]');
        } else {
            numberCircle.classList.remove('bg-[#2D5BE3]');
            numberCircle.classList.add('bg-gray-600');
        }
    }

    const nameInput   = item.querySelector('.src-name');
    const urlTextarea = item.querySelector('.src-url');
    if (nameInput)   nameInput.readOnly   = !isChecked;
    if (urlTextarea) urlTextarea.readOnly = !isChecked;

    const badgeContainer = item.querySelector('.flex.items-center.justify-between.px-1.mt-1');
    const count  = globalChannelsData.filter(ch => ch.source === sourcesData[idx].name).length;
    const isNew  = sourcesData[idx].isNew;

    if (badgeContainer) {
        if (isChecked) {
            if (isNew) {
                badgeContainer.innerHTML =
                    '<span class="text-[10px] text-gray-500 uppercase tracking-wider font-semibold flex items-center gap-1">' +
                        '<span class="material-icons text-gray-500" style="font-size: 14px;">format_list_bulleted</span>' +
                        'Channels Pending' +
                    '</span>' +
                    '<span class="text-[10px] text-orange-400 bg-orange-500/10 border border-orange-500/20 px-2 py-0.5 rounded shadow-sm font-bold uppercase tracking-wider">Save to Load</span>';
            } else {
                badgeContainer.innerHTML =
                    '<span class="text-[10px] text-gray-500 uppercase tracking-wider font-semibold flex items-center gap-1">' +
                        '<span class="material-icons text-gray-500" style="font-size: 14px;">format_list_bulleted</span>' +
                        'Channels Loaded' +
                    '</span>' +
                    '<span class="text-[11px] text-[#2D5BE3] bg-[#2D5BE3]/10 border border-[#2D5BE3]/20 px-2 py-0.5 rounded shadow-sm font-bold">' + count + '</span>';
            }
        } else {
            badgeContainer.innerHTML =
                '<span class="text-[10px] text-gray-500 uppercase tracking-wider font-semibold flex items-center gap-1">' +
                    '<span class="material-icons text-gray-500" style="font-size: 14px;">format_list_bulleted</span>' +
                    'Channels Status' +
                '</span>' +
                '<span class="text-[11px] text-gray-400 bg-gray-500/10 border border-gray-500/20 px-2 py-0.5 rounded shadow-sm font-bold">DISABLED</span>';
        }
    }
}
<\/script>
</body>
</html>`;
}
