// ==UserScript==
// @name         DeepSeek → Claude (Dark) Complete Skin
// @namespace    claude-ds-dark
// @version      18.8.0
// @description  Covers chat.deepseek.com with a full-screen, opaque, DARK
//               Claude.ai interface.  DeepSeek's React app keeps running
//               underneath (handling auth / SSE / PoW / sessions); we bridge
//               input + output between our Claude UI and the hidden DeepSeek
//               DOM.  Model selector maps Opus/Sonnet/Haiku + Effort + Thinking.
// @author       Anthropic-inspired
// @match        https://chat.deepseek.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  CONFIG + MODEL MAPPING                                         ║
  // ╚══════════════════════════════════════════════════════════════════╝

  const C = {
    MODELS: {
      opus:   { label:'Opus 4.8',   desc:'Most capable for ambitious work',   model:'deepseek-reasoner', dsExpert:true,  thinking:true },
      sonnet: { label:'Sonnet 4.6', desc:'Most efficient for everyday tasks', model:'deepseek-chat',     dsExpert:false, thinking:true },
      haiku:  { label:'Haiku 4.5',  desc:'Fastest for quick answers',         model:'deepseek-chat',     dsExpert:false, thinking:false },
    },
    EFFORTS: ['Low', 'Medium', 'High', 'Extra', 'Max'],
    DEFAULT_TIER:   'opus',
    DEFAULT_EFFORT: 'High',
    KEY_T: 'clds_tier_v7',
    KEY_E: 'clds_effort_v7',
    KEY_TH:'clds_think_v7',
    API_RE: /\/(api\/v0\/chat\/completion|api\/v0\/chat|chat\/completion)/i,
  };

  let tier   = (GM_getValue(C.KEY_T) && C.MODELS[GM_getValue(C.KEY_T)]) ? GM_getValue(C.KEY_T) : C.DEFAULT_TIER;
  let effort = GM_getValue(C.KEY_E) || C.DEFAULT_EFFORT;
  let thinking = GM_getValue(C.KEY_TH);
  if (thinking == null) thinking = C.MODELS[tier].thinking;
  let webSearch = GM_getValue('clds_websearch_v7'); if (webSearch == null) webSearch = false;
  let reTitle = () => {};   // assigned in main(); lets applyTempClass re-title on toggle

  const cfg = () => C.MODELS[tier];
  function saveAll() { GM_setValue(C.KEY_T, tier); GM_setValue(C.KEY_E, effort); GM_setValue(C.KEY_TH, thinking); GM_setValue('clds_websearch_v7', webSearch); }

  // Per-model system prompts (Opus / Sonnet / Haiku) — wrapped as a role
  // directive so the model adopts it as its identity, not a user question.
  let sysPrompts = (() => {
    try { const v = JSON.parse(GM_getValue('clds_sysprompts_v8') || '{}');
      // migrate single legacy prompt to all tiers
      const legacy = GM_getValue('clds_sysprompt_v7');
      return { opus: v.opus||legacy||'', sonnet: v.sonnet||legacy||'', haiku: v.haiku||legacy||'' };
    } catch(_) { return { opus:'', sonnet:'', haiku:'' }; }
  })();
  let sysEditTier = tier;                       // which tier the panel is editing
  const curSys = () => (sysPrompts[tier] || '').trim();
  function saveSys() { GM_setValue('clds_sysprompts_v8', JSON.stringify(sysPrompts)); }

  const ROLE_MARK = '【当前用户消息】';
  function buildOutgoing(msg) {
    const sp = curSys(); const eh = effortHint();
    const dirs = [];
    if (sp) dirs.push(
      '【角色设定·全程严格遵守】\n' + sp + '\n' +
      '（以上是你的固定身份与行为设定。请在 <think> 中先代入该角色，全程保持人设与风格；' +
      '这不是用户的提问，不要把本设定当作需要回答的消息，也不要复述它；' +
      '请直接以该角色身份回应下面的用户消息，不要跑题。）');
    if (eh) dirs.push('【回答要求】' + eh);
    // Always reply in the same language as the user's message (fixes wrong-language replies)
    dirs.push('【语言要求】请务必使用与下面这条用户消息完全相同的语言来回复。');
    return dirs.join('\n\n') + '\n\n' + ROLE_MARK + '\n' + msg;
  }

  // Temporary-chat tracking key (persisted so a reload can clean up)
  const TEMP_KEY = 'clds_temp_session_v7';
  function authToken() { try { return JSON.parse(localStorage.getItem('userToken')||'{}').value || ''; } catch(_) { return ''; } }
  function currentSessionId() { const m = location.pathname.match(/\/chat\/s\/([0-9a-f-]+)/i); return m ? m[1] : null; }
  function dsApi(path, body) {
    return _f('/api/v0/' + path, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+authToken() },
      body: JSON.stringify(body),
    });
  }
  function deleteSession(sid) { if (!sid) return Promise.resolve(); return dsApi('chat_session/delete', { chat_session_id: sid }).catch(()=>{}); }
  function pinSession(sid, pinned) { return dsApi('chat_session/update_pinned', { chat_session_id: sid, pinned: !!pinned }).catch(()=>{}); }
  function renameSession(sid, title) { return dsApi('chat_session/update_title', { chat_session_id: sid, title: title }).catch(()=>{}); }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  FETCH / XHR INTERCEPTION                                       ║
  // ╚══════════════════════════════════════════════════════════════════╝

  function rewrite(txt) {
    let o; try { o = JSON.parse(txt); } catch (_) { return txt; }
    const c = cfg(); o.model = c.model;
    if (wantThink()) o.thinking = { type: 'enabled' }; else delete o.thinking;
    return JSON.stringify(o);
  }
  const _f = window.fetch;
  window.fetch = function (u, o = {}) {
    const url = typeof u === 'string' ? u : (u && u.url || '');
    if (C.API_RE.test(url) && o.body) o.body = rewrite(o.body);
    return _f.call(this, u, o);
  };
  const _xo = XMLHttpRequest.prototype.open, _xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__u = u; return _xo.call(this, m, u, ...r); };
  XMLHttpRequest.prototype.send = function (b) { if (b && C.API_RE.test(this.__u || '')) b = rewrite(b); return _xs.call(this, b); };

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  DARK CLAUDE DESIGN TOKENS                                      ║
  // ╚══════════════════════════════════════════════════════════════════╝

  // Exact Claude dark-mode tokens (measured live from claude.ai)
  const D = {
    bg:       '#1F1F1E',   // bg-100  — main canvas + sidebar
    bgSide:   '#1F1F1E',   // sidebar = same as canvas (Claude separates via border only)
    bgInput:  '#2C2C2A',   // bg-000  — elevated: input, cards, menus
    bgHover:  '#2C2C2A',   // hover overlay on canvas
    bgActive: '#353533',   // pressed / selected
    bgMenu:   '#2C2C2A',   // dropdown surface
    bgMenuHv: '#353533',
    txt:      '#F8F8F6',   // text-100 primary
    txt2:     '#C3C2B7',   // text-200/300 secondary (greeting, labels)
    txt3:     '#97958C',   // text-400/500 muted
    txt4:     '#6F6E69',   // very muted
    brand:    '#D97757',   // accent-brand clay
    brandH:   '#C6613F',   // brand-000 hover
    blue:     '#7AA7F0',   // checkmark accent (dark)
    border:   'rgba(255,255,255,.08)',
    border2:  'rgba(255,255,255,.14)',
    sans:     "'Anthropic Sans',system-ui,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
    serif:    "'Anthropic Serif',Georgia,'Times New Roman','PingFang SC','Microsoft YaHei',serif",
    mono:     "'Anthropic Mono','SF Mono','Fira Code',ui-monospace,monospace",
    icon:     "'Anthropicons-Variable'",
    shLg:     '0 12px 32px rgba(0,0,0,.45), 0 2px 8px rgba(0,0,0,.30)',
    ease:     'cubic-bezier(.165,.84,.44,1)',
  };

  // Anthropicons glyph codepoints (exact, measured from claude.ai)
  const G = {
    search:'\uE0D3', toggle:'\uE0DD', newchat:'\uE001', chats:'\uE039',
    projects:'\uE0C9', code:'\uE048', customize:'\uE100', kebab:'\uE062',
    copy:'\uE056', copied:'\uE03B', retry:'\uE0CE', edit:'\uE064',
  };
  const ic = (g) => `<span class="cl-ai" aria-hidden="true">${g}</span>`;

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  SVG ICONS (match image 2)                                      ║
  // ╚══════════════════════════════════════════════════════════════════╝

  const I = {
    sparkle: (sz,clr) => `<svg width="${sz}" height="${sz}" viewBox="0 0 100 100" fill="${clr}"><path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z"/></svg>`,
    plus:     '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    chats:    '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 4h9a2 2 0 012 2v5a2 2 0 01-2 2H8l-4 3V6a2 2 0 010-2z" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/></svg>',
    download: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 3v9M6.5 8.5L10 12l3.5-3.5M4 15h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevron:  '<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M2.5 4l3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevronR: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3.5l3.5 3.5L5 10.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check:    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8l3.5 3.5L13 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    arrow:    '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 14V4M5 8l4-4 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    ghost:    '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M10 2C14.4183 2 18 5.58172 18 10V17.333C18 17.6404 17.7899 17.9087 17.4912 17.9814C17.1925 18.0539 16.8824 17.9125 16.7412 17.6396C16.4654 17.1046 16.2278 16.6907 15.9443 16.4053C15.6891 16.1486 15.4011 16.0001 14.9775 16C14.3 16.0002 13.5743 16.4876 13.1016 17.5947C12.9967 17.8403 12.7553 18 12.4883 18C12.2214 17.9998 11.9798 17.8402 11.875 17.5947C11.4021 16.4874 10.6776 16 10 16C9.32238 16 8.59794 16.4874 8.125 17.5947C8.02021 17.8402 7.77857 17.9998 7.51172 18C7.24472 18 7.0033 17.8403 6.89844 17.5947C6.42567 16.4876 5.70001 16.0002 5.02246 16C4.59894 16.0001 4.31088 16.1486 4.05566 16.4053C3.7722 16.6907 3.53456 17.1046 3.25879 17.6396C3.11763 17.9125 2.80745 18.0539 2.50879 17.9814C2.21014 17.9087 2 17.6404 2 17.333V10C2 5.58172 5.58172 2 10 2ZM7 8.66699C6.44772 8.66699 6 9.11471 6 9.66699C6.00021 10.2191 6.44785 10.667 7 10.667C7.55215 10.667 7.99979 10.2191 8 9.66699C8 9.11471 7.55228 8.66699 7 8.66699ZM13 8.66699C12.4477 8.66699 12 9.11471 12 9.66699C12.0002 10.2191 12.4478 10.667 13 10.667C13.5522 10.667 13.9998 10.2191 14 9.66699C14 9.11471 13.5523 8.66699 13 8.66699Z"/></svg>',
    codeP:    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5 5.5L2.5 8 5 10.5M11 5.5L13.5 8 11 10.5M9 4l-2 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    writeP:   '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M11 2.5l2.5 2.5L6 12.5 3 13l.5-3L11 2.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none"/></svg>',
    learnP:   '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2L1.5 5.5 8 9l6.5-3.5L8 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none"/><path d="M4 7v3.5c0 .8 1.8 1.5 4 1.5s4-.7 4-1.5V7" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
    info:     '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" stroke-width="1.2"/><path d="M6.5 5.8v3M6.5 4.2v.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    gear:     '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="2.6" stroke="currentColor" stroke-width="1.5"/><path d="M10 2.2v2M10 15.8v2M17.8 10h-2M4.2 10h-2M15.5 4.5l-1.4 1.4M5.9 14.1l-1.4 1.4M15.5 15.5l-1.4-1.4M5.9 5.9L4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    help:     '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M7.8 7.6a2.2 2.2 0 114 1.3c-.7.6-1.3.9-1.3 1.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/><circle cx="10" cy="14" r=".9" fill="currentColor"/></svg>',
    logout:   '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M8 4H5a1 1 0 00-1 1v10a1 1 0 001 1h3M13 13l3-3-3-3M16 10H8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    fileIcon: '<svg width="16" height="16" viewBox="0 0 18 18" fill="none"><path d="M10 2H5a1.5 1.5 0 00-1.5 1.5v11A1.5 1.5 0 005 16h8a1.5 1.5 0 001.5-1.5V6.5L10 2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M10 2v4.5H14.5" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    close:    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  };

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  DOM HELPER                                                     ║
  // ╚══════════════════════════════════════════════════════════════════╝

  function E(tag, a = {}, kids = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(a)) {
      if (v == null) continue;
      if (k === 'cls') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else e.setAttribute(k, v);
    }
    kids.forEach(c => { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }

  // Read the DeepSeek display name with fallbacks; empty string if unknown
  // (greeting then omits the name instead of hard-coding one).
  const userName = () => {
    try {
      const cands = [
        document.querySelector('#root ._9d8da05'),
        document.querySelector('#root [class*="_2afd28d"] [class*="_9d8da05"]'),
        document.querySelector('#root [data-testid="user-menu-button"]'),
      ];
      for (const el of cands) {
        const t = (el && el.textContent || '').trim();
        if (t && t.length < 40) return t.replace(/\s*(Free plan|Pro|Max plan).*$/i, '').trim();
      }
    } catch(_) {}
    return '';
  };
  // Full-day greeting variants (matches Claude's time-based phrasing)
  const greetLine = () => {
    if (typeof tempActive === 'function' && tempActive()) return "You're incognito";
    const n = userName(); const h = new Date().getHours();
    if (h < 5)       return n ? `It's late-night ${n}` : `It's late-night`;
    if (h < 12)      return n ? `Good morning, ${n}`   : 'Good morning';
    if (h < 17)      return n ? `Good afternoon, ${n}` : 'Good afternoon';
    if (h < 22)      return n ? `Good evening, ${n}`   : 'Good evening';
    return n ? `It's late-night ${n}` : `It's late-night`;
  };

  // Theme: manual override ('light'|'dark') wins; else follow DeepSeek / system
  function applyThemeClass() {
    const app = document.querySelector('.cl-app'); if (!app) return;
    const pref = GM_getValue('clds_theme');
    let light;
    if (pref === 'light') light = true;
    else if (pref === 'dark') light = false;
    else {
      const b = document.body, a = b.getAttribute('data-ds-dark-theme');
      const isDark = a === 'dark'
        || (a !== 'light' && (b.classList.contains('dark') ||
            (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches)));
      light = !isDark;
    }
    app.classList.toggle('cl-light', !!light);
    // ALSO mark <body>: our menus/panels (model selector, effort submenu, chats
    // search, account popover, +menu) are appended to document.body — NOT inside
    // .cl-app — so `.cl-light .cl-menu` only matches when body carries cl-light.
    document.body.classList.toggle('cl-light', !!light);
    // AND push the theme down to DeepSeek's OWN body class. DeepSeek scopes its
    // code-block / KaTeX / search-result colours to `body.light` / `body.dark`,
    // NOT to our .cl-app — so when the skin theme differs from DeepSeek's (e.g.
    // a manual dark skin while DeepSeek follows a light system), cloned code
    // blocks render light-on-light (a bright box inside the dark UI). Syncing the
    // underlying theme keeps every mirrored fragment consistent. #root is hidden,
    // so DeepSeek's own repaint is invisible. Guarded writes ⇒ no observer loop.
    // The LEVER (verified live) is the body attribute `data-ds-dark-theme`:
    // present+"dark" ⇒ dark code surface, absent ⇒ light. The body class is NOT
    // what code/KaTeX colours key off — only this attribute is — so we set the
    // attribute (and mirror the class for any component that reads it).
    const b = document.body;
    if (light) {
      if (b.hasAttribute('data-ds-dark-theme')) b.removeAttribute('data-ds-dark-theme');
      if (!b.classList.contains('light')) { b.classList.remove('dark'); b.classList.add('light'); }
    } else {
      if (b.getAttribute('data-ds-dark-theme') !== 'dark') b.setAttribute('data-ds-dark-theme', 'dark');
      if (!b.classList.contains('dark')) { b.classList.remove('light'); b.classList.add('dark'); }
    }
  }
  // Re-tag already-mirrored code blocks to the new skin theme (token/syntax
  // colours follow the per-block `md-code-block-light/-dark` modifier, which is
  // only refreshed while streaming — so a manual theme toggle on a STATIC
  // conversation would otherwise leave stale token colours until the next turn).
  function retagMirroredCode() {
    if (!msgsEl) return;
    const light = !!document.querySelector('.cl-app')?.classList.contains('cl-light');
    msgsEl.querySelectorAll('.md-code-block').forEach(blk => {
      blk.classList.toggle('md-code-block-light', light);
      blk.classList.toggle('md-code-block-dark', !light);
    });
  }
  function setTheme(t) { try { GM_setValue('clds_theme', t); } catch(_) {} applyThemeClass(); retagMirroredCode(); }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  CSS                                                            ║
  // ╚══════════════════════════════════════════════════════════════════╝

  GM_addStyle(`
    /* ===== Real Anthropic fonts (from claude.ai asset CDN) ===== */
    @font-face{font-family:'Anthropic Sans';src:url(https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/cc27851ad-CFxw3nG7.woff2) format("woff2");font-weight:300 800;font-style:normal;font-display:swap;font-feature-settings:"dlig" 0}
    @font-face{font-family:'Anthropic Sans';src:url(https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/c9d3a3a49-BI1hrwN4.woff2) format("woff2");font-weight:300 800;font-style:italic;font-display:swap}
    @font-face{font-family:'Anthropic Serif';src:url(https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/c66fc489e-C-BHYa_K.woff2) format("woff2");font-weight:300 800;font-style:normal;font-display:swap}
    @font-face{font-family:'Anthropic Serif';src:url(https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/cc410af59-DH94ugQz.woff2) format("woff2");font-weight:300 800;font-style:italic;font-display:swap}
    @font-face{font-family:'Anthropic Mono';src:url(https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/c5dbe0935-B88FVziN.woff2) format("woff2");font-weight:400;font-style:normal;font-display:swap}
    @font-face{font-family:'Anthropicons-Variable';src:url(https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/c0f671921-DICoRAgs.woff2) format("woff2-variations");font-weight:400 700;font-display:block}
    .cl-ai{font-family:'Anthropicons-Variable' !important;font-weight:500;font-style:normal;line-height:1;display:inline-flex;align-items:center;justify-content:center;speak:none;-webkit-font-smoothing:antialiased}

    /* Hide DeepSeek completely (keep it functional underneath) */
    #root { position: fixed !important; inset: 0 !important; opacity: 0 !important;
            pointer-events: none !important; z-index: 0 !important; }

    html, body { margin:0 !important; padding:0 !important; background:${D.bg} !important;
                 overflow:hidden !important; }

    /* ===== Full-screen Claude overlay ===== */
    .cl-app {
      position: fixed; inset: 0; z-index: 2147483600;
      background: ${D.bg}; color: ${D.txt};
      font-family: ${D.sans}; display: flex; overflow: hidden;
      -webkit-font-smoothing: antialiased;
    }

    /* ===== Sidebar ===== */
    /* ===== Sidebar — expanded 288px (matches claude.ai) ===== */
    .cl-sb {
      width: 288px; flex-shrink: 0; height: 100%;
      background: ${D.bgSide}; border-right: 0.5px solid ${D.border};
      display: flex; flex-direction: column;
      padding: 8px 8px 12px;
    }
    .cl-sb--collapsed { width: 56px; align-items:center; }
    .cl-sb--collapsed .cl-lbl, .cl-sb--collapsed .cl-sec, .cl-sb--collapsed .cl-hist,
    .cl-sb--collapsed .cl-logo-wm, .cl-sb--collapsed .cl-user-meta { display:none !important; }
    /* collapsed: stack top icons vertically (no longer cramped), center nav rows */
    .cl-sb--collapsed .cl-sbtop { flex-direction:column; gap:2px; padding:6px 0 8px; }
    .cl-sb--collapsed .cl-nav { width:100%; align-items:center; }
    .cl-sb--collapsed .cl-row { justify-content:center; padding:0; width:38px; gap:0; }
    .cl-sb--collapsed .cl-user { justify-content:center; }

    /* Top bar: logo + search + collapse */
    .cl-sbtop { display:flex; align-items:center; gap:4px; padding:6px 4px 10px; }
    .cl-logo-wm { color:${D.txt}; display:flex; align-items:center; flex:1; padding-left:6px; }
    .cl-logo-wm svg { height:20px; width:auto; }
    .cl-sbtop-sp { flex:1; }

    /* Generic icon button (search, collapse, kebab) */
    .cl-ib {
      width:30px; height:30px; display:flex; align-items:center; justify-content:center;
      border:none; background:transparent; border-radius:7px; cursor:pointer;
      color:${D.txt3}; transition: all 90ms ${D.ease}; flex-shrink:0;
    }
    .cl-ib:hover { background:${D.bgHover}; color:${D.txt}; }
    .cl-ib:active { transform: scale(.92); }
    .cl-ib .cl-ai { font-size:18px; }

    /* Nav rows (New chat, Chats, Projects, Code, Customize) */
    .cl-nav { display:flex; flex-direction:column; gap:1px; }
    .cl-row {
      display:flex; align-items:center; gap:12px; height:34px; padding:0 10px;
      border-radius:9px; cursor:pointer; color:${D.txt2}; border:none; background:transparent;
      font-family:${D.sans}; font-size:14px; font-weight:400; width:100%; text-align:left;
      transition: background 90ms ${D.ease}, color 90ms ${D.ease}; white-space:nowrap;
    }
    .cl-row:hover { background:${D.bgHover}; color:${D.txt}; }
    .cl-row:active { transform: scale(.99); }
    .cl-row .cl-ai { font-size:18px; color:${D.txt2}; width:20px; flex-shrink:0; }
    .cl-row:hover .cl-ai { color:${D.txt}; }
    .cl-row--accent .cl-ai { color:${D.brand}; }
    .cl-lbl { overflow:hidden; text-overflow:ellipsis; }

    /* Section header (Recents) */
    .cl-sec { font-size:12px; font-weight:500; color:${D.txt4}; padding:14px 12px 6px; }

    /* Recents / history list */
    .cl-hist { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:1px; min-height:0; }
    .cl-hi {
      display:flex; align-items:center; gap:8px; height:32px; padding:0 10px; border-radius:8px;
      cursor:pointer; color:${D.txt2}; font-size:14px; transition:background 90ms ${D.ease}; position:relative;
    }
    .cl-hi:hover { background:${D.bgHover}; color:${D.txt}; }
    .cl-hi-t { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cl-hi-k { opacity:0; flex-shrink:0; }
    .cl-hi:hover .cl-hi-k { opacity:1; }
    .cl-hi-k .cl-ai { font-size:16px; }

    /* Bottom user button */
    .cl-user {
      display:flex; align-items:center; gap:10px; padding:8px 8px; margin-top:6px;
      border-radius:10px; cursor:pointer; border:none; background:transparent; width:100%;
      transition:background 90ms ${D.ease};
    }
    .cl-user:hover { background:${D.bgHover}; }
    .cl-av {
      width:30px; height:30px; border-radius:50%; flex-shrink:0;
      display:flex; align-items:center; justify-content:center;
      background:${D.brand}; color:#fff; font-size:13px; font-weight:600; border:none;
    }
    .cl-user-meta { display:flex; flex-direction:column; align-items:flex-start; line-height:1.2; min-width:0; }
    .cl-user-name { font-size:14px; color:${D.txt}; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:170px; }
    .cl-user-plan { font-size:12px; color:${D.txt4}; }

    /* Tooltip */
    .cl-tip {
      position: fixed; z-index: 2147483647; pointer-events: none;
      background: #1A1A18; color: #F5F4EE; padding: 6px 10px; border-radius: 7px;
      font-size: 12px; font-weight: 500; white-space: nowrap;
      display: flex; align-items: center; gap: 7px;
      box-shadow: 0 4px 14px rgba(0,0,0,.4);
    }
    .cl-tipk { color: rgba(255,255,255,.4); font-size: 11px; }

    /* ===== Main ===== */
    .cl-main { flex:1; height:100%; display:flex; flex-direction:column; position:relative; min-width:0; }
    .cl-tr { position:absolute; top:16px; right:20px; z-index:5; }
    .cl-ghost {
      width:38px; height:38px; display:flex; align-items:center; justify-content:center;
      border:none; background:transparent; border-radius:9px; cursor:pointer;
      color:${D.txt3}; transition: all 90ms ${D.ease};
    }
    .cl-ghost:hover { background:${D.bgHover}; color:${D.txt}; }

    .cl-scroll { flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; display:flex; flex-direction:column;
                 align-items:center; }
    .cl-welcome { width:100%; max-width:740px; margin:auto; padding:0 24px;
                  display:flex; flex-direction:column; align-items:center; }
    /* Bottom dock — input pinned at viewport bottom during a conversation */
    .cl-dock { flex-shrink:0; display:none; flex-direction:column; align-items:center;
               width:100%; padding:0 24px; background:${D.bg}; position:relative; }
    .cl-dock::before { content:''; position:absolute; left:0; right:0; top:-28px; height:28px;
                       pointer-events:none; background:linear-gradient(transparent, ${D.bg}); }
    .cl-app--chatting .cl-dock { display:flex; }
    .cl-app--chatting .cl-welcome { display:none; }

    /* Greeting */
    .cl-greet {
      display:flex; align-items:center; gap:16px; margin-bottom:36px;
      animation: cl-fade 500ms ${D.ease} both;
    }
    .cl-greet-spk { flex-shrink:0; display:flex; color:${D.brand}; }
    .cl-greet-spk svg { width:32px; height:32px; }
    .cl-greet-txt {
      font-family:${D.serif}; font-weight:330; font-size:40px;
      color:${D.txt2}; margin:0; letter-spacing:normal; line-height:1.1;
    }

    /* ===== Input ===== */
    .cl-inwrap { width:100%; max-width:740px; animation: cl-fade 500ms ${D.ease} 80ms both; }
    .cl-input {
      background:${D.bgInput}; border:1px solid ${D.border}; border-radius:16px;
      box-shadow: 0 2px 10px rgba(0,0,0,.18);
      transition: border-color 150ms ${D.ease}, box-shadow 150ms ${D.ease};
    }
    .cl-input:focus-within { border-color:${D.border2}; box-shadow: 0 4px 16px rgba(0,0,0,.26); }
    .cl-ta {
      width:100%; box-sizing:border-box; min-height:56px; max-height:340px;
      padding:18px 20px 4px; border:none; outline:none; resize:none;
      background:transparent; color:${D.txt}; font-family:${D.sans};
      font-size:16px; line-height:1.5;
      user-select:text; -webkit-user-select:text;
    }
    .cl-ta::placeholder { color:${D.txt4}; }
    .cl-irow { display:flex; align-items:center; gap:8px; padding:8px 12px 12px; box-sizing:border-box; }
    .cl-row-sp { flex:1; }
    .cl-plus {
      width:34px; height:34px; display:flex; align-items:center; justify-content:center;
      border:none; background:transparent; border-radius:50%; cursor:pointer;
      color:${D.txt3}; transition:all 90ms ${D.ease};
    }
    .cl-plus:hover { background:${D.bgHover}; color:${D.txt}; }
    .cl-send {
      width:34px; height:34px; display:flex; align-items:center; justify-content:center;
      border:none; background:${D.brand}; border-radius:9px; cursor:pointer;
      color:#fff; transition:all 90ms ${D.ease};
    }
    .cl-send:hover { background:${D.brandH}; }
    .cl-send:active { transform: scale(.93); }
    .cl-send:disabled { background:${D.bgActive}; color:${D.txt4}; cursor:default; }

    /* Model selector button */
    .cl-msb {
      display:inline-flex; align-items:center; gap:6px; padding:6px 11px;
      border:none; background:transparent; border-radius:8px; cursor:pointer;
      font-family:${D.sans}; font-size:14px; color:${D.txt2}; transition:all 90ms ${D.ease};
    }
    .cl-msb:hover { background:${D.bgHover}; color:${D.txt}; }
    .cl-msb-eff { color:${D.txt3}; font-size:13px; }
    .cl-msb-cv { display:flex; color:${D.txt3}; }

    /* Suggestion pills under input */
    .cl-sugg { display:flex; gap:10px; margin-top:20px; flex-wrap:wrap; justify-content:center; }
    .cl-pill {
      display:inline-flex; align-items:center; gap:7px; padding:8px 15px;
      border:1px solid ${D.border}; background:${D.bgInput}; border-radius:10px;
      color:${D.txt2}; font-size:14px; cursor:pointer; transition:all 90ms ${D.ease};
    }
    .cl-pill:hover { background:${D.bgHover}; color:${D.txt}; border-color:${D.border2}; }
    .cl-pill svg { color:${D.txt3}; }

    /* Our popups are appended to <body>, which DeepSeek styles with its own text
       color (purple in light mode!). Pin an explicit color so nothing inherits it. */
    .cl-menu, .cl-sub, .cl-himenu, .cl-ap, .cl-plusmenu, .cl-rec, .cl-cp, .cl-sp, .cl-tip,
    .cl-incog { color:${D.txt}; }
    .cl-light .cl-menu, .cl-light .cl-sub, .cl-light .cl-himenu, .cl-light .cl-ap,
    .cl-light .cl-plusmenu, .cl-light .cl-rec, .cl-light .cl-cp, .cl-light .cl-sp { color:#1A1A18; }

    /* ===== Model dropdown menu ===== */
    .cl-menu {
      position:fixed; z-index:2147483646; background:${D.bgMenu};
      border:1px solid ${D.border}; border-radius:14px; box-shadow:${D.shLg};
      padding:6px; min-width:300px;
      opacity:0; transform:translateY(6px) scale(.98); pointer-events:none;
      transition:all 150ms ${D.ease};
    }
    .cl-menu--open { opacity:1; transform:translateY(0) scale(1); pointer-events:auto; }
    .cl-mi {
      display:flex; align-items:center; gap:10px; padding:9px 12px; border-radius:9px;
      cursor:pointer; transition:background 80ms ${D.ease};
    }
    .cl-mi:hover { background:${D.bgMenuHv}; }
    .cl-mi-l { flex:1; min-width:0; }
    .cl-mi-n { font-size:14px; font-weight:500; color:${D.txt}; line-height:1.3; }
    .cl-mi-d { font-size:12.5px; color:${D.txt3}; line-height:1.3; margin-top:1px; }
    .cl-mi-ck { color:${D.blue}; display:flex; flex-shrink:0; }
    .cl-mi-rt { color:${D.txt3}; display:flex; flex-shrink:0; align-items:center; gap:6px; font-size:13px; }
    .cl-mi-g { font-size:16px; color:${D.txt3}; width:18px; }

    /* History item kebab context menu (Rename / Pin / Delete) */
    .cl-himenu {
      position:fixed; z-index:2147483646; min-width:160px;
      background:${D.bgMenu}; border:1px solid ${D.border}; border-radius:12px;
      box-shadow:${D.shLg}; padding:6px;
      opacity:0; transform:translateY(-4px) scale(.98); transition:all 120ms ${D.ease};
    }
    .cl-himenu.cl-himenu--open { opacity:1; transform:translateY(0) scale(1); }
    .cl-div { height:1px; background:${D.border}; margin:6px 4px; }

    /* Effort submenu */
    .cl-sub {
      position:fixed; z-index:2147483646; background:${D.bgMenu};
      border:1px solid ${D.border}; border-radius:14px; box-shadow:${D.shLg};
      padding:6px; min-width:300px;
      opacity:0; transform:translateY(6px) scale(.98); pointer-events:none;
      transition:all 150ms ${D.ease};
    }
    .cl-sub--open { opacity:1; transform:translateY(0) scale(1); pointer-events:auto; }
    .cl-sub-hd { font-size:12.5px; color:${D.txt3}; padding:8px 12px 10px; line-height:1.4; }
    .cl-er { display:flex; align-items:center; padding:9px 12px; border-radius:9px; cursor:pointer;
             transition:background 80ms ${D.ease}; font-size:14px; color:${D.txt}; gap:8px; }
    .cl-er:hover { background:${D.bgMenuHv}; }
    .cl-er-l { flex:1; display:flex; align-items:center; gap:8px; }
    .cl-er-tag { font-size:12px; color:${D.txt3}; }
    .cl-er-ck { color:${D.blue}; display:flex; }
    .cl-th { display:flex; align-items:center; padding:10px 12px; gap:10px; }
    .cl-th-l { flex:1; }
    .cl-th-n { font-size:14px; color:${D.txt}; }
    .cl-th-d { font-size:12.5px; color:${D.txt3}; margin-top:1px; }
    .cl-tog {
      width:38px; height:22px; border-radius:11px; background:${D.bgActive}; cursor:pointer;
      position:relative; transition:background 150ms ${D.ease}; flex-shrink:0; border:none;
    }
    .cl-tog--on { background:${D.brand}; }
    .cl-tog::after {
      content:''; position:absolute; top:2px; left:2px; width:18px; height:18px;
      border-radius:50%; background:#fff; transition:transform 150ms ${D.ease};
    }
    .cl-tog--on::after { transform: translateX(16px); }

    /* ===== Messages ===== */
    .cl-msgs { width:100%; max-width:740px; padding:32px 24px 0; display:flex; flex-direction:column; gap:24px; }
    .cl-msg { display:flex; flex-direction:column; }
    .cl-msg--u { align-items:flex-end; }
    .cl-msg--a { align-items:flex-start; }
    .cl-bub { max-width:90%; font-size:16px; line-height:1.65; word-wrap:break-word; }
    .cl-bub--u { background:${D.bgInput}; padding:12px 18px; border-radius:16px 16px 6px 16px; color:${D.txt}; white-space:pre-wrap; }
    /* File attachment card shown above a user message (matches claude.ai) */
    .cl-ufiles { display:flex; flex-direction:column; gap:8px; align-items:flex-end; margin-bottom:8px; }
    .cl-ufile { display:inline-flex; align-items:center; gap:12px; max-width:320px;
                padding:12px 16px; border-radius:14px; background:${D.bgInput};
                border:1px solid ${D.border}; }
    .cl-ufile-ic { flex-shrink:0; width:34px; height:40px; display:flex; align-items:center; justify-content:center;
                   border-radius:7px; background:#5C6BC0; color:#fff; }
    .cl-ufile-ic svg { width:20px; height:20px; }
    .cl-ufile-meta { min-width:0; }
    .cl-ufile-n { font-size:14px; font-weight:600; color:${D.txt}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .cl-ufile-s { font-size:12.5px; color:${D.txt3}; margin-top:2px; }
    .cl-light .cl-ufile { background:#FFFFFF; border-color:rgba(0,0,0,.1); }
    .cl-light .cl-ufile-n { color:#1A1A18; }
    .cl-light .cl-ufile-s { color:#8A8980; }
    .cl-bub--a { color:${D.txt}; white-space:normal; width:100%; }
    /* Markdown spacing inside assistant bubble */
    .cl-bub--a > :first-child { margin-top:0; }
    .cl-bub--a > :last-child { margin-bottom:0; }
    .cl-bub--a p { margin:0 0 12px; }
    .cl-bub--a ul, .cl-bub--a ol { margin:0 0 12px; padding-left:22px; }
    .cl-bub--a li { margin:3px 0; }
    .cl-bub--a h1,.cl-bub--a h2,.cl-bub--a h3 { margin:16px 0 8px; line-height:1.3; }

    /* Thinking block — collapsible, muted (Claude style) */
    /* Thinking — elegant, borderless (matches Claude) */
    .cl-think { width:100%; margin:0 0 14px; }
    .cl-think-hd { display:inline-flex; align-items:center; gap:6px; cursor:pointer;
                   color:${D.txt3}; font-size:14px; user-select:none; padding:2px 0; }
    .cl-think-hd:hover { color:${D.txt2}; }
    .cl-think-ic { display:flex; transition:transform 150ms ${D.ease}; transform:rotate(0deg); opacity:.7; }
    .cl-think--open .cl-think-ic { transform:rotate(180deg); }
    .cl-think-body { display:none; margin-top:10px; padding-left:16px;
                     border-left:1px solid ${D.border2};
                     font-family:${D.sans}; font-size:14.5px; line-height:1.72; }
    /* Force a readable muted color — DeepSeek's copied markup carries dark inline/class colors */
    .cl-think-body, .cl-think-body * { color:${D.txt3} !important; }
    /* Neutralize DeepSeek's nested search/think UI (white toggle boxes, borders, pills) */
    .cl-think-body * { background:transparent !important; border-color:transparent !important; box-shadow:none !important; }
    .cl-think-body img { width:15px !important; height:15px !important; border-radius:3px; vertical-align:middle; margin:0 2px; }
    .cl-think-body strong, .cl-think-body b { color:${D.txt2} !important; font-weight:600; }
    .cl-think-body .katex, .cl-think-body .katex * { color:${D.txt2} !important; }
    .cl-think--open .cl-think-body { display:block; }
    /* Mirrored web-search steps ("Found N web pages" / "Read N pages" + sources):
       size DeepSeek's icons + favicons down and render the source list as quiet,
       Claude-like rows (so it reads as one clean process, not nested DeepSeek UI). */
    .cl-think-body > * { margin:0 0 12px; }
    .cl-think-body > :last-child { margin-bottom:0; }
    .cl-think-body svg { width:14px !important; height:14px !important; opacity:.6; vertical-align:middle; flex-shrink:0; }
    .cl-think-body img.site_logo_img { width:14px !important; height:14px !important; }
    .cl-think-body a { color:${D.txt3} !important; text-decoration:none !important; }
    .cl-think-body a:hover { color:${D.txt2} !important; text-decoration:underline !important; }
    /* "Read N pages" source rows: one per line, truncated, with a hover hint */
    .cl-think-body a[class] { display:block; margin:4px 0; padding-left:2px;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }

    /* Search-process block (DeepSeek "Read N web pages" → Claude "Searched the web") */
    .cl-search { width:100%; margin:0 0 14px; }
    .cl-search-hd { display:inline-flex; align-items:center; gap:6px; cursor:pointer;
                    color:${D.txt3}; font-size:14px; user-select:none; padding:2px 0; }
    .cl-search-hd:hover { color:${D.txt2}; }
    .cl-search-ic { display:flex; transition:transform 150ms ${D.ease}; opacity:.7; }
    .cl-search--open .cl-search-ic { transform:rotate(180deg); }
    .cl-search-body { display:none; margin-top:10px; padding-left:16px;
                      border-left:1px solid ${D.border2};
                      font-family:${D.sans}; font-size:14px; line-height:1.65; }
    .cl-search--open .cl-search-body { display:block; }
    .cl-search-body, .cl-search-body * { color:${D.txt3} !important; }
    .cl-search-body img { width:16px; height:16px; border-radius:3px; vertical-align:middle; margin:0 3px; }
    .cl-search-body a { text-decoration:none !important; }
    .cl-light .cl-search-hd { color:#8A8980; }
    .cl-light .cl-search-body, .cl-light .cl-search-body * { color:#6E6D66 !important; }
    .cl-light .cl-search-body { border-left-color:rgba(0,0,0,.14); }

    .cl-think-body > p { margin:0 0 10px; }
    .cl-think-body > :first-child { margin-top:0; }
    .cl-think-body > :last-child { margin-bottom:0; }
    /* strip DeepSeek's stray leading status bullet / empty nodes */
    .cl-think-body ul, .cl-think-body ol { list-style:none; padding-left:0; margin:0 0 10px; }
    .cl-think-body li { margin:0 0 6px; }
    .cl-think-body :empty { display:none; }

    /* Message action toolbar — icon-only squares (exactly like Claude: muted → primary on hover) */
    .cl-acts { display:flex; align-items:center; gap:2px; margin-top:4px;
               opacity:0; transition:opacity 120ms ${D.ease}; }
    .cl-msg--a:hover .cl-acts, .cl-msg--u:hover .cl-acts, .cl-acts.cl-acts--keep { opacity:1; }
    .cl-msg--u .cl-acts { align-self:flex-end; }
    .cl-act { display:inline-flex; align-items:center; justify-content:center;
              width:30px; height:30px; padding:0; border:none; background:transparent;
              border-radius:8px; color:${D.txt4}; cursor:pointer;
              transition:background 90ms ${D.ease}, color 90ms ${D.ease}; }
    .cl-act:hover { background:${D.bgHover}; color:${D.txt}; }
    .cl-act .cl-ai { font-size:17px; }
    .cl-act.cl-act--ok { color:${D.brand}; }

    /* Claude end-mark — small sparkle under the LATEST reply only (matches claude.ai) */
    .cl-endmark { display:none; margin-top:18px; color:${D.brand}; opacity:.9; }
    .cl-endmark svg { width:22px; height:22px; }
    .cl-msgs > .cl-msg--a:last-child .cl-endmark { display:block; }

    /* Branch / version switcher (matches Claude: ‹ N/M › before the action icons) */
    .cl-ver { display:inline-flex; align-items:center; gap:1px; margin-right:4px; }
    .cl-ver-b { display:inline-flex; align-items:center; justify-content:center;
                width:22px; height:26px; border:none; background:transparent; color:${D.txt4};
                cursor:pointer; border-radius:6px; transition:all 90ms ${D.ease}; }
    .cl-ver-b:hover { background:${D.bgHover}; color:${D.txt}; }
    .cl-ver-b[disabled] { opacity:.35; cursor:default; }
    .cl-ver-t { font-size:12px; color:${D.txt3}; min-width:30px; text-align:center;
                font-variant-numeric:tabular-nums; }

    /* Inline message editor (Claude image-44: textarea + branch notice + Cancel/Save) */
    .cl-edit { width:100%; max-width:740px; align-self:center; margin:2px 0 4px; }
    .cl-edit-ta { width:100%; box-sizing:border-box; min-height:52px; max-height:360px;
                  padding:14px 16px; border:1px solid ${D.blue}; border-radius:14px;
                  background:${D.bgInput}; color:${D.txt}; font-family:${D.sans};
                  font-size:16px; line-height:1.55; resize:none; outline:none; }
    .cl-edit-bar { display:flex; align-items:center; gap:12px; margin-top:10px; }
    .cl-edit-note { flex:1; display:flex; align-items:flex-start; gap:8px;
                    color:${D.txt3}; font-size:12.5px; line-height:1.45; }
    .cl-edit-note svg { flex-shrink:0; margin-top:2px; color:${D.txt4}; }
    .cl-edit-btn { height:36px; padding:0 16px; border-radius:9px; border:none; cursor:pointer;
                   background:${D.bgActive}; color:${D.txt}; font-family:${D.sans};
                   font-size:14px; font-weight:500; transition:all 90ms ${D.ease}; }
    .cl-edit-btn:hover { background:${D.bgMenuHv}; }
    .cl-edit-btn--save { background:${D.brand}; color:#1A0F0A; }
    .cl-edit-btn--save:hover { background:${D.brandH}; }

    /* ===== Markdown tables (Claude-style: airy, header rule, row separators) ===== */
    .cl-bub table { border-collapse:collapse; width:auto; max-width:100%; margin:6px 0 16px;
                    font-size:14.5px; line-height:1.55; display:table; }
    .cl-bub thead th { text-align:left; font-weight:600; color:${D.txt};
                       padding:8px 18px 8px 0; border-bottom:1px solid ${D.border2};
                       vertical-align:bottom; white-space:nowrap; }
    .cl-bub tbody td { padding:11px 18px 11px 0; color:${D.txt2}; vertical-align:top;
                       border-bottom:1px solid ${D.border}; }
    .cl-bub tbody tr:last-child td { border-bottom:none; }
    .cl-bub th:last-child, .cl-bub td:last-child { padding-right:0; }
    /* the table's horizontal-scroll wrapper DeepSeek emits */
    .cl-bub .ds-scroll-area, .cl-bub [class*="scroll-area"] { overflow-x:auto; max-width:100%; }

    /* Conversation mode — generous bottom gap so the last line never tucks under the docked input */
    .cl-app--chatting .cl-msgs { padding-bottom:40px; }
    /* Floating-input disclaimer (Claude footer line under the docked input) */
    .cl-disc { text-align:center; font-size:12px; color:${D.txt4}; padding:8px 0 12px; width:100%; }
    .cl-bub pre { background:#1C1C1A; border:1px solid ${D.border}; border-radius:10px;
                  padding:14px 16px; overflow-x:auto; font-family:${D.mono}; font-size:13.5px; }
    .cl-bub code { font-family:${D.mono}; font-size:.92em; }
    .cl-bub :not(pre) > code { background:#1C1C1A; padding:2px 6px; border-radius:5px; }
    /* DeepSeek fenced code blocks: let their (skin-matched) md-code-block theme own
       the bg + Prism token colors; we just round + space them and neutralise our
       generic <pre> styling so it can't repaint the background. */
    .cl-bub .md-code-block { border-radius:10px; overflow:hidden; margin:8px 0 16px; }
    .cl-bub .md-code-block pre { background:transparent !important; border:none !important;
                                 margin:0 !important; border-radius:0 !important; padding:12px 16px; }
    /* KaTeX: let display math breathe + scroll horizontally instead of clipping */
    .cl-bub .katex-display, .cl-think-body .katex-display {
      overflow-x:auto; overflow-y:hidden; padding:6px 2px; margin:4px 0 14px; }
    .cl-bub .katex, .cl-think-body .katex { font-size:1.02em; }
    /* Links — Claude's quiet blue, underlined; NO purple visited highlight */
    .cl-bub a, .cl-bub a:visited, .cl-bub a:active {
      color:${D.blue} !important; text-decoration:underline; text-decoration-thickness:1px;
      text-underline-offset:2px; text-decoration-color:rgba(122,167,240,.45); }
    .cl-bub a:hover { text-decoration-color:${D.blue}; }
    /* DeepSeek search citations → Claude-style source chips showing the site name */
    .cl-bub a.cl-cite, .cl-bub a.cl-cite:visited, .cl-bub a.cl-cite:active {
      all:unset; box-sizing:border-box; display:inline-flex; align-items:center;
      height:18px; max-width:200px; margin:0 3px; padding:0 7px; vertical-align:text-bottom;
      border-radius:9999px; border:.5px solid ${D.border2}; background:${D.bgInput};
      color:${D.txt3} !important; font-size:11px; font-weight:400; line-height:1;
      cursor:pointer; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
      text-decoration:none !important; transition:background 90ms ${D.ease}, color 90ms ${D.ease}; }
    .cl-bub a.cl-cite:hover { background:${D.bgActive}; color:${D.txt} !important; }
    .cl-cite-in { display:inline !important; position:static !important; opacity:1 !important;
                  margin:0 !important; transform:none !important; }

    /* Scrollbar + selection */
    ::-webkit-scrollbar { width:8px; height:8px; }
    ::-webkit-scrollbar-track { background:transparent; }
    ::-webkit-scrollbar-thumb { background:${D.border2}; border-radius:4px; }
    ::-webkit-scrollbar-thumb:hover { background:${D.txt4}; }
    .cl-app ::selection { background:rgba(122,167,240,.25); }

    /* ===== Chats history panel ===== */
    .cl-cp {
      position:fixed; left:288px; top:0; bottom:0; width:300px; z-index:2147483640;
      background:${D.bgSide}; border-right:1px solid ${D.border};
      display:flex; flex-direction:column; padding:14px 10px;
      transform:translateX(-12px); opacity:0; pointer-events:none;
      transition:transform 200ms ${D.ease}, opacity 200ms ${D.ease};
      box-shadow:8px 0 28px rgba(0,0,0,.30);
    }
    .cl-cp--open { transform:translateX(0); opacity:1; pointer-events:auto; }
    .cl-cp-hd { display:flex; align-items:center; justify-content:space-between; padding:4px 8px 12px; }
    .cl-cp-h { font-size:16px; font-weight:600; color:${D.txt}; }
    .cl-cp-x { border:none; background:transparent; color:${D.txt3}; cursor:pointer; font-size:14px;
               width:28px; height:28px; border-radius:7px; transition:all 90ms ${D.ease}; }
    .cl-cp-x:hover { background:${D.bgHover}; color:${D.txt}; }
    .cl-cp-search {
      margin:0 4px 10px; padding:9px 12px; border-radius:9px; border:1px solid ${D.border};
      background:${D.bgInput}; color:${D.txt}; font-family:${D.sans}; font-size:13.5px; outline:none;
    }
    .cl-cp-search::placeholder { color:${D.txt4}; }
    .cl-cp-search:focus { border-color:${D.border2}; }
    .cl-cp-list { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:1px; }
    .cl-cp-item {
      display:flex; align-items:center; gap:9px; padding:9px 10px; border-radius:8px;
      cursor:pointer; color:${D.txt2}; transition:all 80ms ${D.ease};
    }
    .cl-cp-item:hover { background:${D.bgHover}; color:${D.txt}; }
    .cl-cp-ico { display:flex; color:${D.txt4}; flex-shrink:0; }
    .cl-cp-ico svg { width:16px; height:16px; }
    .cl-cp-ttl { font-size:13.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .cl-cp-empty { color:${D.txt4}; font-size:13.5px; padding:16px 10px; text-align:center; }

    /* ===== Chats / recents — full-page view (matches claude.ai /recents) ===== */
    .cl-rec {
      position:fixed; inset:0; z-index:2147483641; background:${D.bg};
      display:flex; flex-direction:column; align-items:center; overflow-y:auto;
      padding:60px 24px 48px; opacity:0; pointer-events:none;
      transition:opacity 160ms ${D.ease};
    }
    .cl-rec--open { opacity:1; pointer-events:auto; }
    .cl-rec-col { width:100%; max-width:768px; }
    .cl-rec-h { font-family:${D.serif}; font-weight:400; font-size:30px; color:${D.txt};
                margin:0 0 22px; letter-spacing:normal; }
    .cl-rec-search { display:flex; align-items:center; gap:10px; height:46px; padding:0 14px;
      border-radius:11px; background:${D.bgInput}; border:1px solid ${D.border};
      transition:border-color 120ms ${D.ease}; }
    .cl-rec-search:focus-within { border-color:${D.border2}; }
    .cl-rec-mag { display:flex; color:${D.txt3}; flex-shrink:0; }
    .cl-rec-search input { flex:1; min-width:0; border:none; outline:none; background:transparent;
      color:${D.txt}; font-family:${D.sans}; font-size:15px; }
    .cl-rec-search input::placeholder { color:${D.txt4}; }
    .cl-rec-cnt { font-size:12.5px; color:${D.txt4}; padding:18px 2px 4px; font-weight:500; }
    .cl-rec-list { display:flex; flex-direction:column; }
    .cl-rec-item { display:flex; align-items:center; gap:12px; padding:13px 10px; border-radius:9px;
      cursor:pointer; color:${D.txt}; border-bottom:1px solid ${D.border};
      transition:background 80ms ${D.ease}; }
    .cl-rec-item:hover { background:${D.bgHover}; }
    .cl-rec-ico { display:flex; color:${D.txt3}; flex-shrink:0; }
    .cl-rec-ico svg { width:17px; height:17px; }
    .cl-rec-ttl { flex:1; min-width:0; font-size:14.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cl-rec-empty { color:${D.txt4}; font-size:14px; padding:24px 2px; }
    .cl-rec-close { position:fixed; top:16px; right:20px; width:36px; height:36px; z-index:2;
      display:flex; align-items:center; justify-content:center; border:none; background:transparent;
      color:${D.txt3}; border-radius:9px; cursor:pointer; transition:all 90ms ${D.ease}; }
    .cl-rec-close:hover { background:${D.bgHover}; color:${D.txt}; }
    .cl-light .cl-rec { background:#F8F8F6; }
    .cl-light .cl-rec-h { color:#1A1A18; }
    .cl-light .cl-rec-search { background:#FFFFFF; border-color:rgba(0,0,0,.1); box-shadow:0 1px 4px rgba(0,0,0,.04); }
    .cl-light .cl-rec-search input { color:#1A1A18; }
    .cl-light .cl-rec-search input::placeholder, .cl-light .cl-rec-mag { color:#8A8980; }
    .cl-light .cl-rec-item { color:#1A1A18; border-bottom-color:rgba(0,0,0,.07); }
    .cl-light .cl-rec-item:hover { background:#EFEEE9; }
    .cl-light .cl-rec-ico, .cl-light .cl-rec-cnt { color:#8A8980; }
    .cl-light .cl-rec-close { color:#8A8980; }
    .cl-light .cl-rec-close:hover { background:#EFEEE9; color:#1A1A18; }

    /* ===== Account popover ===== */
    .cl-ap {
      position:fixed; z-index:2147483646; min-width:240px;
      background:${D.bgMenu}; border:1px solid ${D.border}; border-radius:14px;
      box-shadow:${D.shLg}; padding:8px;
      opacity:0; transform:translateY(6px) scale(.98); pointer-events:none;
      transition:all 150ms ${D.ease};
    }
    .cl-ap--open { opacity:1; transform:translateY(0) scale(1); pointer-events:auto; }
    .cl-ap-hd { display:flex; align-items:center; gap:10px; padding:8px 10px 10px; }
    .cl-ap-av { width:34px; height:34px; border-radius:50%; object-fit:cover; flex-shrink:0; }
    .cl-ap-av--ph { display:flex; align-items:center; justify-content:center;
                    background:radial-gradient(circle at 35% 30%,#F4C6B8,#E8A890); }
    .cl-ap-name { font-size:14px; font-weight:600; color:${D.txt};
                  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .cl-ap-row { display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:8px;
                 cursor:pointer; color:${D.txt2}; font-size:14px; transition:all 80ms ${D.ease}; }
    .cl-ap-row:hover { background:${D.bgMenuHv}; color:${D.txt}; }
    .cl-ap-ico { display:flex; color:${D.txt3}; }
    .cl-ap-ico svg { width:18px; height:18px; }

    /* Fix avatar truncation: give the bottom group breathing room */
    .cl-sb { padding-bottom:16px; box-sizing:border-box; overflow:visible; }
    .cl-sb .cl-sbg:last-child { padding-bottom:4px; }
    .cl-av { flex-shrink:0; }

    /* Lift DeepSeek's real modals (Settings / Download / Help) ABOVE our
       overlay so they are visible + interactive. They render at body level. */
    .ds-modal, .ds-modal-focus-lock, .ds-modal-mask, .ds-modal-wrapper,
    [class*="ds-modal"] {
      z-index: 2147483645 !important;
    }
    /* While a DeepSeek modal is open, also lift its nested popups (theme /
       language dropdowns render in .ds-floating-container at z-index 0). */
    body.cl-modal .ds-floating-container,
    body.cl-modal .ds-floating-position-wrapper {
      z-index: 2147483646 !important;
    }

    /* Ghost button — active (temporary chat) state */
    .cl-ghost--on { background:rgba(255,255,255,.10) !important; color:${D.txt} !important; }

    /* ===== Incognito / temporary chat — matches claude.ai exactly ===== */
    /* A dark top bar (ghost + "Incognito chat" + ✕) with the app inset below it
       as a rounded panel on a near-black backdrop. */
    /* Top bar sits ON the dark frame (transparent bg); light text/icons. 50px tall
       to match claude.ai's inset-[50px_8px_8px_8px] incognito frame. */
    /* Bar is always mounted; fades in/out with the frame (opacity, not display,
       so the enter/exit transition is smooth in both directions). */
    .cl-incog {
      position:fixed; top:0; left:0; right:0; height:50px; z-index:2147483647;
      display:flex; align-items:center; gap:8px; padding:0 12px 0 18px;
      background:transparent; color:#EDECE6; font-family:${D.sans}; font-size:14px;
      opacity:0; pointer-events:none; transition:opacity 320ms ${D.ease};
    }
    body.cl-temp .cl-incog { opacity:1; pointer-events:auto; }
    .cl-incog-g { display:flex; color:#EDECE6; }
    .cl-incog-g svg { width:20px; height:20px; }
    .cl-incog-t { font-weight:400; letter-spacing:.01em; }
    .cl-incog-x {
      margin-left:auto; width:30px; height:30px; border:none; cursor:pointer;
      background:transparent; color:#EDECE6; border-radius:7px;
      display:flex; align-items:center; justify-content:center; transition:all 90ms ${D.ease};
    }
    .cl-incog-x:hover { background:rgba(255,255,255,.12); color:#fff; }
    /* Near-black frame (overrides the !important base bg) — app inset 8px on the
       sides/bottom + 50px under the bar, rounded, exactly like claude.ai. The app
       animates its inset + radius so entering/leaving incognito glides in/out. */
    html, body { transition:background-color 320ms ${D.ease}; }
    .cl-app { transition:top 320ms ${D.ease}, left 320ms ${D.ease}, right 320ms ${D.ease},
              bottom 320ms ${D.ease}, border-radius 320ms ${D.ease}; }
    body.cl-temp { background:#0D0D0C !important; }
    body.cl-temp .cl-app {
      top:50px !important; left:8px !important; right:8px !important; bottom:8px !important;
      border-radius:16px !important; overflow:hidden;
    }
    /* In incognito the top bar already provides ghost + exit, so hide the
       redundant floating ghost (and with it the stray hover tooltip). */
    body.cl-temp .cl-tr { display:none !important; }
    /* Hide only the VeePN extension's promo lock-screen card (it can overlap our
       skin). Scoped to the exact element so the user's real VPN controls stay. */
    veepn-lock-screen { display:none !important; }
    /* claude.ai incognito is a clean, minimal screen: NO sidebar, NO suggestion
       pills — just the centered greeting + input + privacy notice. */
    body.cl-temp .cl-sb { display:none !important; }
    body.cl-temp .cl-sugg { display:none !important; }
    /* Privacy notice shown under the input on the incognito welcome screen */
    body.cl-temp .cl-welcome .cl-incog-note { display:block; margin-top:22px; }
    /* Incognito data notice under the input (replaces the normal disclaimer) */
    .cl-incog-note { display:none; }
    body.cl-temp .cl-disc { display:none; }
    body.cl-temp .cl-incog-note {
      display:block; text-align:center; font-size:12px; color:${D.txt4};
      padding:8px 0 12px; width:100%; max-width:740px; line-height:1.5;
    }
    body.cl-temp .cl-incog-note a { color:${D.txt3}; text-decoration:underline; }
    .cl-light.cl-app .cl-incog-note, .cl-light .cl-incog-note { color:#8A8980; }

    /* ===== System prompt panel (reuses chats-panel slide-in) ===== */
    .cl-sp {
      position:fixed; left:288px; top:0; bottom:0; width:340px; z-index:2147483640;
      background:${D.bgSide}; border-right:1px solid ${D.border};
      display:flex; flex-direction:column; padding:14px 14px;
      transform:translateX(-12px); opacity:0; pointer-events:none;
      transition:transform 200ms ${D.ease}, opacity 200ms ${D.ease};
      box-shadow:8px 0 28px rgba(0,0,0,.30);
    }
    .cl-sp.cl-cp--open { transform:translateX(0); opacity:1; pointer-events:auto; }
    .cl-sp-hint { font-size:12.5px; color:${D.txt3}; line-height:1.5; padding:0 4px 12px; }
    .cl-sp-tabs { display:flex; gap:4px; padding:0 4px 10px; }
    .cl-sp-tab { flex:1; padding:7px 0; border:1px solid ${D.border}; border-radius:8px;
                 background:transparent; color:${D.txt3}; font-family:${D.sans}; font-size:13px;
                 cursor:pointer; transition:all 90ms ${D.ease}; }
    .cl-sp-tab:hover { background:${D.bgHover}; color:${D.txt2}; }
    .cl-sp-tab--on { background:${D.bgActive}; color:${D.txt}; border-color:${D.border2}; font-weight:600; }
    /* + composer menu */
    .cl-plusmenu { position:fixed; z-index:2147483646; min-width:240px;
      background:${D.bgMenu}; border:1px solid ${D.border}; border-radius:14px; box-shadow:${D.shLg};
      padding:6px; opacity:0; transform:translateY(6px) scale(.98); transition:all 130ms ${D.ease}; }
    .cl-plusmenu.cl-pm--open { opacity:1; transform:translateY(0) scale(1); }
    /* Attachment chips above the textarea */
    .cl-chips { display:flex; flex-wrap:wrap; gap:8px; padding:12px 14px 0; }
    .cl-chip { display:flex; align-items:center; gap:8px; max-width:240px;
      background:${D.bg}; border:1px solid ${D.border}; border-radius:10px; padding:8px 10px; }
    .cl-chip-i { color:${D.brand}; display:flex; flex-shrink:0; }
    .cl-chip-t { font-size:13px; color:${D.txt}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cl-chip-x { margin-left:auto; color:${D.txt3}; cursor:pointer; border:none; background:transparent; font-size:14px; }
    .cl-chip-x:hover { color:${D.txt}; }
    .cl-sp-ta {
      flex:1; min-height:200px; resize:none; border-radius:12px; border:1px solid ${D.border};
      background:${D.bgInput}; color:${D.txt}; font-family:${D.sans}; font-size:14px;
      line-height:1.55; padding:14px; outline:none; box-sizing:border-box;
    }
    .cl-sp-ta:focus { border-color:${D.border2}; }
    .cl-sp-ta::placeholder { color:${D.txt4}; }
    .cl-sp-row { display:flex; gap:10px; justify-content:flex-end; padding:12px 2px 2px; }
    .cl-sp-save, .cl-sp-clear {
      padding:8px 18px; border-radius:9px; border:none; cursor:pointer; font-size:14px;
      font-family:${D.sans}; transition:all 90ms ${D.ease};
    }
    .cl-sp-save { background:${D.brand}; color:#fff; }
    .cl-sp-save:hover { background:${D.brandH}; }
    .cl-sp-clear { background:transparent; color:${D.txt2}; }
    .cl-sp-clear:hover { background:${D.bgHover}; color:${D.txt}; }

    @keyframes cl-fade { from{opacity:0;transform:translateY(8px);} to{opacity:1;transform:translateY(0);} }
  `);

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  TOOLTIP                                                        ║
  // ╚══════════════════════════════════════════════════════════════════╝

  let tipEl = null;
  function showTip(anchor, label, key) {
    hideTip();
    tipEl = E('div', { cls:'cl-tip' }, [ E('span',{text:label}), key?E('span',{cls:'cl-tipk',text:key}):null ]);
    document.body.appendChild(tipEl);
    const a = anchor.getBoundingClientRect(), t = tipEl.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight, gap = 10;
    // Prefer right of the anchor; flip to the LEFT when it would overflow the
    // viewport (e.g. the top-right ghost button) so the tip never spills off-screen.
    let left = a.right + gap;
    if (left + t.width > vw - 8) {
      left = a.left - gap - t.width;
      if (left < 8) {   // no room either side → drop below, centered + clamped
        left = Math.min(Math.max(8, a.left + a.width/2 - t.width/2), vw - t.width - 8);
        tipEl.style.left = left + 'px';
        tipEl.style.top  = Math.min(a.bottom + gap, vh - t.height - 8) + 'px';
        return;
      }
    }
    let top = a.top + a.height/2 - t.height/2;
    top = Math.min(Math.max(8, top), vh - t.height - 8);
    tipEl.style.left = left + 'px';
    tipEl.style.top  = top + 'px';
  }
  function hideTip() { if (tipEl) { tipEl.remove(); tipEl = null; } }

  function ibtn(icon, label, key, onClick, extraCls) {
    const b = E('button', { cls:'cl-ib'+(extraCls?' '+extraCls:''), html:icon, onclick:onClick||(()=>{}) });
    b.addEventListener('mouseenter', () => showTip(b, label, key));
    b.addEventListener('mouseleave', hideTip);
    return b;
  }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  BRIDGE TO HIDDEN DEEPSEEK                                      ║
  // ╚══════════════════════════════════════════════════════════════════╝

  function dsTextarea() {
    return document.querySelector('#root textarea[name="search"]')
      || document.querySelector('#root [contenteditable="true"]')
      || document.querySelector('#root textarea')
      || document.querySelector('textarea[name="search"]')
      || document.querySelector('textarea');
  }
  function dsSendBtn() {
    // The composer's send control is DeepSeek's PRIMARY action button — match the
    // stable `ds-button--primary` design-system class first (verified live), so a
    // per-deploy hashed-class change can't silently break sending. Hashed class +
    // aria + last-button kept only as progressively-weaker fallbacks.
    return document.querySelector('#root .ds-button--primary')
      || document.querySelector('#root ._52c986b')
      || document.querySelector('#root [aria-label*="send" i], #root [aria-label*="发送"]')
      || [...document.querySelectorAll('#root [role="button"]')].pop();
  }

  // Effort now has a real effect: High/Extra/Max enable DeepThink, and
  // Low/Extra/Max prepend a reasoning-intensity instruction to the message.
  const HIGH_EFFORT = (e) => e === 'High' || e === 'Extra' || e === 'Max';
  // High effort auto-enables DeepThink ONLY on thinking-capable tiers — Haiku is
  // documented as "no thinking, fast", and the default effort is High, so without
  // this gate Haiku always ran with DeepThink on.
  function wantThink() { return !!thinking || (HIGH_EFFORT(effort) && !!cfg().thinking); }
  function effortHint() {
    if (effort === 'Low')    return '请简洁、直接地回答，不要冗长展开。';
    if (effort === 'Extra')  return '请更深入、更全面、多角度地分析后再回答。';
    if (effort === 'Max')    return '请进行尽可能深入、详尽、严谨的多步推理，覆盖边界情况与反例后再给出回答。';
    return '';
  }
  // Find DeepSeek toggle buttons by their label (robust to ordering)
  function dsToggle(re) { return [...document.querySelectorAll('#root .ds-toggle-button')].find(t => re.test(t.textContent || '')); }
  function setToggle(re, on) { const t = dsToggle(re); if (t && (t.getAttribute('aria-pressed') === 'true') !== !!on) t.click(); }

  function applyDSModel() {
    const exp = document.querySelector('#root [data-model-type="expert"]');
    const def = document.querySelector('#root [data-model-type="default"]');
    const target = cfg().dsExpert ? exp : def;
    if (target && target.getAttribute('aria-checked') !== 'true') target.click();
    setToggle(/DeepThink|深度思考/i, wantThink());      // Thinking + High-effort → DeepThink
    setToggle(/Search|智能搜索|搜索/i, !!webSearch);     // Web search toggle
  }

  function sendMessage(_retry) {
    const ta = document.getElementById('cl-ta');
    if (!ta) return;
    const typed = (ta.value || '').trim();
    if (!typed) return;

    try { applyDSModel(); } catch (_) {}

    // Prepend the (invisible) role + effort directives to the user message
    const text = buildOutgoing(typed);

    const ds = dsTextarea();
    if (!ds) {
      // DeepSeek not ready yet — retry a few times before giving up
      if ((_retry || 0) < 8) { setTimeout(() => sendMessage((_retry || 0) + 1), 250); return; }
      console.warn('[Claude→DS] textarea not found after retries'); return;
    }

    try {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ds, text);
      ds.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_) { ds.value = text; ds.dispatchEvent(new Event('input', { bubbles: true })); }

    resetMirror();               // force fresh mirror of the new turn
    setTimeout(() => {
      const sb = dsSendBtn();
      if (sb && sb.getAttribute('aria-disabled') !== 'true') sb.click();
      else ds.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true }));
    }, 90);

    ta.value = '';
    ta.style.height = 'auto';
    const sb = document.getElementById('cl-send'); if (sb) sb.disabled = true;
    hideGreeting();
  }

  function dsNewChat() {
    // Reliable, popup-free: navigate to root (DeepSeek opens a fresh chat).
    showGreeting(); clearMessages();
    if (location.pathname !== '/') location.href = 'https://chat.deepseek.com/';
  }

  // Robustly locate DeepSeek's paperclip/attach control (fallbacks, not just hashed class)
  function dsAttachBtn() {
    // The attach button shares a container with DeepSeek's hidden file <input>
    // and carries the STABLE design-system class `ds-button` — so find it by that
    // association rather than the per-deploy hashed class (.f02f0e25 varies by
    // build/region, which is why upload broke on the user's Windows Chrome build).
    const fi = document.querySelector('#root input[type="file"], input[type="file"]');
    if (fi) {
      const box = fi.parentElement;
      const b = (box && box.querySelector('[role="button"],button,.ds-button'))
             || fi.closest('div')?.querySelector('[role="button"],button,.ds-button');
      if (b) return b;
    }
    return document.querySelector('#root .f02f0e25')
      || document.querySelector('#root [aria-label*="upload" i], #root [aria-label*="attach" i], #root [aria-label*="文件"], #root [aria-label*="上传"]');
  }
  function dsAttach() {
    // Click DeepSeek's attach BUTTON (it opens the OS dialog reliably). The hidden
    // <input> is lazily mounted/removed, so clicking it directly is unreliable.
    const btn = dsAttachBtn();
    if (btn) { btn.click(); return; }
    const fi = document.querySelector('#root input[type="file"], input[type="file"]');
    if (fi) fi.click();
  }

  // ---- + composer menu (Add files / Web search) ----
  let plusMenu = null;
  function closePlusMenu(){ if(plusMenu){ plusMenu.remove(); plusMenu=null; document.removeEventListener('mousedown', plusOutside, true);} }
  function plusOutside(e){ if(plusMenu && !plusMenu.contains(e.target) && !e.target.closest('.cl-plus')) closePlusMenu(); }
  function openPlusMenu(anchor){
    if (plusMenu) { closePlusMenu(); return; }
    const row = (label, glyph, right, onClick) => E('div',{cls:'cl-mi', onclick:(e)=>{e.stopPropagation(); onClick();}},[
      E('span',{cls:'cl-ai cl-mi-g',html:glyph}),
      E('div',{cls:'cl-mi-l'},[ E('div',{cls:'cl-mi-n',text:label}) ]),
      right ? E('div',{cls:'cl-mi-ck',html:I.check}) : null,
    ]);
    plusMenu = E('div',{cls:'cl-plusmenu'},[
      row('Add files or photos', G.newchat, false, ()=>{ closePlusMenu(); dsAttach(); }),
      E('div',{cls:'cl-div'}),
      row('Web search', G.projects, webSearch, ()=>{ webSearch=!webSearch; saveAll(); applyDSModel(); closePlusMenu(); }),
    ]);
    document.body.appendChild(plusMenu);
    const r = anchor.getBoundingClientRect();
    plusMenu.style.left = r.left+'px';
    plusMenu.style.bottom = (window.innerHeight - r.top + 8)+'px';
    requestAnimationFrame(()=>plusMenu.classList.add('cl-pm--open'));
    setTimeout(()=>document.addEventListener('mousedown', plusOutside, true), 0);
  }

  // ---- Attachment chip mirroring (visual feedback for uploads) ----
  function startAttachMirror() {
    // Capture files chosen via DeepSeek's hidden <input> and show Claude-style chips.
    // DeepSeek mounts the attachment card asynchronously → fire a few quick retries.
    document.addEventListener('change', (e) => {
      const t = e.target;
      if (t && t.tagName === 'INPUT' && t.type === 'file' && t.closest('#root')) {
        [0, 80, 250, 600, 1200].forEach(d => setTimeout(renderChips, d));
      }
    }, true);
    setInterval(renderChips, 1200);   // also covers paste / drag-drop into DeepSeek
  }
  // Click a DeepSeek attachment card's own remove control (the last svg = the ✕).
  function removeAttachCard(card) {
    const svgs = card.querySelectorAll('svg');
    const xSvg = svgs[svgs.length - 1];
    const target = xSvg && (xSvg.closest('[role="button"],button') || xSvg.parentElement);
    if (target) ['pointerdown','mousedown','pointerup','mouseup','click']
      .forEach(t => target.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window })));
  }
  function renderChips() {
    const box = document.getElementById('cl-chips');
    if (!box) return;
    // ONE chip per real DeepSeek attachment card. `.ds-animated-size-item` is the
    // stable design-system wrapper for each uploaded file (verified live) — no more
    // scanning all of #root (which matched promo text + nested status nodes).
    const cards = [...document.querySelectorAll('#root .ds-animated-size-item')]
      .filter(c => { const t = (c.textContent || '').trim(); return t && t.length < 160 && c.querySelector('svg'); });
    if (!cards.length) { box.style.display = 'none'; box.innerHTML = ''; box.dataset.k = ''; return; }
    const items = cards.map(card => {
      const nameEl = card.querySelector('.f3a54b52');
      let name = (nameEl ? nameEl.textContent : card.textContent).trim();
      name = name.replace(/(Parsing failed|No text.*|解析失败|\d+(?:\.\d+)?\s?(?:KB|MB|GB|B)\b).*$/i, '').trim() || 'file';
      return { card, name: name.slice(0, 60) };
    });
    const key = items.map(i => i.name).join('|') + '#' + items.length;
    if (box.dataset.k === key) { box.style.display = 'flex'; return; }
    box.dataset.k = key;
    box.innerHTML = '';
    items.forEach(({ card, name }) => {
      const x = E('button', { cls:'cl-chip-x', text:'✕', onclick:(e) => {
        e.stopPropagation();
        removeAttachCard(card);
        box.dataset.k = ''; setTimeout(renderChips, 150);
      }});
      box.appendChild(E('div', { cls:'cl-chip' }, [
        E('span', { cls:'cl-chip-i', html: I.fileIcon }),
        E('span', { cls:'cl-chip-t', text: name }),
        x,
      ]));
    });
    box.style.display = 'flex';
  }

  // Read real DeepSeek chat sessions from the hidden sidebar
  function readDSSessions() {
    const out = [];
    const links = document.querySelectorAll('#root a[href*="/chat/s/"], #root a._546d736');
    links.forEach(a => {
      const title = (a.querySelector('.c08e6e93') || a).textContent.trim();
      if (title) out.push({ title, href: a.getAttribute('href'), el: a });
    });
    return out;
  }

  // Open a chat session robustly across browsers. Try SPA navigation via the live
  // sidebar link (smooth, no reload); if the URL hasn't changed shortly after
  // (observed on Windows Chrome, where the synthetic link click doesn't trigger
  // DeepSeek's router), fall back to a hard navigation to the session URL.
  function openChatSession(s) {
    if (!s) return;
    resetMirror(); hideGreeting();
    const want = (String(s.href || '').match(/\/chat\/s\/([0-9a-f-]+)/i) || [])[1];
    try { s.el && s.el.click(); } catch (_) {}
    if (want) setTimeout(() => {
      if (currentSessionId() !== want) {
        try { location.href = new URL(s.href, location.origin).href; } catch (_) {}
      }
    }, 380);
  }

  // Read DeepSeek user info (name + avatar)
  function readDSUser() {
    const name = (document.querySelector('#root ._9d8da05')?.textContent || '').trim();
    const avatar = document.querySelector('#root img.fdf01f38, #root ._2afd28d img')?.src || '';
    return { name: name || 'Account', avatar };
  }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  CHATS HISTORY PANEL                                             ║
  // ╚══════════════════════════════════════════════════════════════════╝

  let chatsPanel = null, chatsOpen = false;

  function toggleChats() { chatsOpen ? closeChats() : openChats(); }

  // Full-page Chats view (matches claude.ai's /recents): centered "Chats"
  // heading + "Search chats..." box + a clean conversation list.
  function openChats() {
    if (chatsOpen) return; chatsOpen = true;
    const sessions = readDSSessions();

    const cnt = E('div', { cls:'cl-rec-cnt' });
    const list = E('div', { cls:'cl-rec-list' });
    const render = (q) => {
      q = (q || '').toLowerCase().trim();
      const items = sessions.filter(s => !q || s.title.toLowerCase().includes(q));
      list.innerHTML = '';
      if (!items.length) { list.appendChild(E('div', { cls:'cl-rec-empty', text: q ? 'No matching chats.' : 'No conversations yet.' })); cnt.textContent=''; return; }
      cnt.textContent = items.length + (items.length === 1 ? ' chat' : ' chats');
      items.forEach(s => list.appendChild(E('div', { cls:'cl-rec-item',
        onclick(){ closeChats(); openChatSession(s); } },
        [ E('span',{cls:'cl-rec-ico',html:I.chats}), E('span',{cls:'cl-rec-ttl',text:s.title}) ])));
    };

    const search = E('input', { type:'text', placeholder:'Search chats...', 'aria-label':'Search your chats',
      oninput(){ render(this.value); } });

    chatsPanel = E('div', { cls:'cl-rec' }, [
      E('button', { cls:'cl-rec-close', html:I.close, title:'Close', onclick:closeChats }),
      E('div', { cls:'cl-rec-col' }, [
        E('h1', { cls:'cl-rec-h', text:'Chats' }),
        E('div', { cls:'cl-rec-search' }, [ E('span',{cls:'cl-rec-mag',html:I.search||'<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="9" cy="9" r="6" stroke="currentColor" stroke-width="1.6"/><path d="M14 14l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'}), search ]),
        cnt, list,
      ]),
    ]);
    render('');
    document.body.appendChild(chatsPanel);
    requestAnimationFrame(() => { chatsPanel.classList.add('cl-rec--open'); search.focus(); });
    document.addEventListener('keydown', chatsKey, true);
  }
  function chatsKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeChats(); } }
  function closeChats() {
    if (!chatsOpen) return; chatsOpen = false;
    document.removeEventListener('keydown', chatsKey, true);
    if (chatsPanel) { chatsPanel.classList.remove('cl-rec--open'); const p=chatsPanel; chatsPanel=null; setTimeout(()=>p.remove(),200); }
  }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  ACCOUNT POPOVER                                                 ║
  // ╚══════════════════════════════════════════════════════════════════╝

  let acctPop = null, acctOpen = false;

  function toggleAccount(anchor) { acctOpen ? closeAccount() : openAccount(anchor); }

  function openAccount(anchor) {
    if (acctOpen) return; acctOpen = true;
    const u = readDSUser();
    const avatar = u.avatar
      ? E('img', { cls:'cl-ap-av', src:u.avatar })
      : E('div', { cls:'cl-ap-av cl-ap-av--ph', html: I.sparkle(18,'#fff') });

    const row = (label, icon, onClick) => E('div', { cls:'cl-ap-row', onclick(){ closeAccount(); onClick&&onClick(); } },
      [ E('span',{cls:'cl-ap-ico',html:icon}), E('span',{text:label}) ]);

    const isLight = document.querySelector('.cl-app')?.classList.contains('cl-light');
    acctPop = E('div', { cls:'cl-ap' }, [
      E('div', { cls:'cl-ap-hd' }, [ avatar, E('div',{cls:'cl-ap-name',text:u.name||'You'}) ]),
      E('div', { cls:'cl-div' }),
      row(isLight ? 'Dark mode' : 'Light mode', I.gear, () => setTheme(isLight ? 'dark' : 'light')),
      E('div', { cls:'cl-div' }),
      row('Download mobile App', I.download, () => triggerDSMenu(/Download|下载/i)),
      row('Settings',           I.gear,     () => triggerDSMenu(/Settings|设置/i)),
      row('Help & Feedback',    I.help,     () => triggerDSMenu(/Help|帮助|反馈/i)),
      E('div', { cls:'cl-div' }),
      row('Log out',            I.logout,   dsLogout),
    ]);
    document.body.appendChild(acctPop);
    requestAnimationFrame(() => {
      const a = anchor.getBoundingClientRect(), pr = acctPop.getBoundingClientRect();
      acctPop.style.left = (a.right + 10) + 'px';
      acctPop.style.bottom = (window.innerHeight - a.bottom) + 'px';
      requestAnimationFrame(() => acctPop.classList.add('cl-ap--open'));
    });
    setTimeout(() => document.addEventListener('mousedown', outsideAcct, true), 0);
  }
  function outsideAcct(e) { if (acctPop && !acctPop.contains(e.target) && !e.target.closest('.cl-av')) closeAccount(); }
  function closeAccount() {
    if (!acctOpen) return; acctOpen = false;
    document.removeEventListener('mousedown', outsideAcct, true);
    if (acctPop) { acctPop.classList.remove('cl-ap--open'); const p=acctPop; acctPop=null; setTimeout(()=>p.remove(),150); }
  }

  // Open DeepSeek's hidden profile menu, then click the matching option.
  // The resulting DeepSeek modal renders at body level; CSS (.ds-modal) lifts
  // it above our overlay so it is visible + interactive.
  function triggerDSMenu(rx) {
    const prof = document.querySelector('#root ._2afd28d');
    if (!prof) return;
    document.body.classList.add('cl-modal');   // lift DeepSeek's popups above our overlay now
    document.body.click();                      // ensure any stale menu is closed
    setTimeout(() => {
      prof.click();                             // open the profile dropdown
      setTimeout(() => {
        const opt = [...document.querySelectorAll('.ds-dropdown-menu-option')]
          .find(o => rx.test(o.textContent || ''));
        if (opt) opt.click();
        else document.body.click();
      }, 160);
    }, 60);
  }

  function dsLogout() {
    // Robust logout: clear the auth token and redirect → DeepSeek shows sign-in.
    try { localStorage.removeItem('userToken'); } catch(_) {}
    location.href = 'https://chat.deepseek.com/sign_in';
  }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  MESSAGE MIRRORING                                              ║
  // ╚══════════════════════════════════════════════════════════════════╝

  let msgsEl = null;
  let histEl = null;   // inline Recents list in the sidebar
  let rendered = [];   // per-row state: {role, wrap, bub, thinkBlock, thinkBody, ansLen, thinkLen, userLen}
  let lastHistKey = '';

  // Populate the sidebar Recents list from DeepSeek's real sessions
  const sidFromHref = (href) => (String(href||'').match(/\/chat\/s\/([0-9a-f-]+)/i)||[])[1] || null;

  function refreshHistory() {
    try {
      if (!histEl) return;
      const sessions = readDSSessions();
      const key = sessions.length + ':' + (sessions[0] ? sessions[0].title : '');
      if (key === lastHistKey) return;        // unchanged — skip rebuild
      lastHistKey = key;
      histEl.innerHTML = '';
      sessions.slice(0, 60).forEach(s => {
        const sid = sidFromHref(s.href);
        const kebab = E('span', { cls:'cl-hi-k', html: ic(G.kebab) });
        const item = E('div', { cls:'cl-hi', title:s.title }, [
          E('span', { cls:'cl-hi-t', text:s.title }), kebab,
        ]);
        item.addEventListener('click', () => openChatSession(s));
        kebab.addEventListener('click', (e) => { e.stopPropagation(); openHiMenu(kebab, sid, s.title); });
        histEl.appendChild(item);
      });
    } catch (err) { console.warn('[Claude→DS] refreshHistory error', err); }
  }

  // Rename / Pin / Delete context menu for a history item
  let hiMenu = null;
  function closeHiMenu(){ if(hiMenu){ hiMenu.remove(); hiMenu=null; document.removeEventListener('mousedown', hiOutside, true);} }
  function hiOutside(e){ if(hiMenu && !hiMenu.contains(e.target)) closeHiMenu(); }
  function openHiMenu(anchor, sid, title) {
    closeHiMenu();
    if (!sid) return;
    const row = (label, glyph, fn) => E('div', { cls:'cl-mi', onclick:(e)=>{ e.stopPropagation(); closeHiMenu(); fn(); } },
      [ E('span',{cls:'cl-ai cl-mi-g',html:glyph}), E('span',{cls:'cl-mi-n',text:label}) ]);
    hiMenu = E('div', { cls:'cl-himenu' }, [
      row('Rename', G.customize, async () => {
        const nv = prompt('Rename chat', title); if (nv && nv.trim()) { await renameSession(sid, nv.trim()); lastHistKey=''; setTimeout(refreshHistory, 400); }
      }),
      row('Pin', G.chats, async () => { await pinSession(sid, true); lastHistKey=''; setTimeout(refreshHistory, 400); }),
      row('Delete', G.kebab, async () => {
        if (confirm('Delete this chat?')) { await deleteSession(sid); lastHistKey=''; setTimeout(refreshHistory, 400);
          if (currentSessionId()===sid) dsNewChat(); }
      }),
    ]);
    document.body.appendChild(hiMenu);
    const r = anchor.getBoundingClientRect();
    hiMenu.style.left = (r.right + 4) + 'px';
    hiMenu.style.top = r.top + 'px';
    requestAnimationFrame(()=>hiMenu.classList.add('cl-himenu--open'));
    setTimeout(()=>document.addEventListener('mousedown', hiOutside, true), 0);
  }

  function resetMirror() { rendered = []; if (msgsEl) msgsEl.innerHTML = ''; }
  function clearMessages() { resetMirror(); if (msgsEl) msgsEl.style.display='none'; setChatting(false); }

  // Clean a displayed user message: drop the invisible system-prompt prefix
  // and DeepSeek's trailing regenerate counter ("2 / 2").
  function stripSys(text) {
    let t = text.replace(/\s*\d+\s*\/\s*\d+\s*$/, '');
    // New role-wrapped format: show only what follows the user-message marker
    const mi = t.lastIndexOf(ROLE_MARK);
    if (mi !== -1) return t.slice(mi + ROLE_MARK.length).replace(/^\s+/, '');
    // Legacy fallback: plain prefixed system prompt
    const sp = curSys();
    if (sp && t.startsWith(sp)) t = t.slice(sp.length).replace(/^\s+/, '');
    return t;
  }

  // User-row text WITHOUT attachment-card text. The file cards
  // (.ds-animated-size-item) live inside the same row, so a plain
  // row.textContent would leak "name.pdf 12.3KB…" into the mirrored bubble
  // and the inline editor; the cards are mirrored separately by syncUserFiles.
  function userRowText(row) {
    if (!row.querySelector('.ds-animated-size-item')) return stripSys(row.textContent.trim());
    const clone = row.cloneNode(true);
    clone.querySelectorAll('.ds-animated-size-item').forEach(n => n.remove());
    return stripSys(clone.textContent.trim());
  }

  // Strip DeepSeek's inline color/font styles so our theme applies — but NEVER
  // touch KaTeX subtrees: KaTeX positions every sub/superscript with inline
  // height/margin/top values; removing them collapses all math onto one line.
  const cleanStyles = (el) => el.querySelectorAll('[style]').forEach(x => {
    if (x.closest('.katex, .katex-display, .katex-html, .katex-mathml, mjx-container, .MathJax')) return;
    if (x.closest('.ds-markdown-cite') || x.classList.contains('ds-markdown-cite')) return; // rebuilt below
    x.removeAttribute('style');
  });

  // DeepSeek inline citations are <a href=URL><span.ds-markdown-cite>(hidden "-")(abs number)</span></a>.
  // Rebuild each into a clean Claude-style chip showing the SOURCE SITE NAME (from the href),
  // not a bare number — matches claude.ai's source pills.
  function decorateCitations(container) {
    container.querySelectorAll('.ds-markdown-cite').forEach(cite => {
      if (cite.dataset.clDone) return;
      const a = cite.closest('a[href]');
      let name = '';
      if (a) {
        try { name = new URL(a.href).hostname.replace(/^www\./, ''); } catch (_) {}
        a.classList.add('cl-cite'); a.removeAttribute('style'); a.title = a.href;
      }
      const num = (cite.textContent.match(/\d+/) || [''])[0];
      cite.className = 'cl-cite-in';
      cite.removeAttribute('style');
      cite.textContent = name || ('#' + num) || '•';
      cite.dataset.clDone = '1';
    });
  }

  // DeepSeek code blocks carry a theme class (md-code-block-light) + Prism token
  // colors that follow DEEPSEEK's theme — under our skin they invert (light skin →
  // white code on light bg; dark skin → black code on dark bg). Re-tag each cloned
  // block to match OUR skin so bg + tokens stay readable, and wire its cloned
  // (otherwise dead) Copy / Download controls.
  function fixCodeBlocks(container) {
    const light = !!document.querySelector('.cl-app')?.classList.contains('cl-light');
    container.querySelectorAll('.md-code-block').forEach(block => {
      // Set BOTH modifiers explicitly: the bg/text come from body[data-ds-dark-theme]
      // (synced in applyThemeClass), but the syntax-TOKEN palette follows this
      // per-block modifier — so a dark skin needs `md-code-block-dark`, not just the
      // absence of `-light`, or keywords render in the light (purple) palette.
      block.classList.toggle('md-code-block-light', light);
      block.classList.toggle('md-code-block-dark', !light);
      if (block.dataset.clWired) return;
      block.dataset.clWired = '1';
      const banner = block.querySelector('.md-code-block-banner-wrap') || block.firstElementChild;
      if (!banner) return;
      banner.style.cursor = 'pointer';
      banner.addEventListener('click', (e) => {
        const el = e.target.closest('div,span,button') || e.target;
        const t = ((el.textContent) || '').trim().toLowerCase();
        if (t.length > 16) return;                       // clicked padding / lang label
        const pre = block.querySelector('pre');
        const text = (pre ? pre.innerText : block.innerText) || '';
        if (/download|下载/.test(t)) {
          const lang = (block.querySelector('[class*="infostring"]')?.textContent || 'txt').trim().slice(0, 8) || 'txt';
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([text], { type:'text/plain' }));
          a.download = 'code.' + lang; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        } else if (/copy|复制/.test(t)) {
          navigator.clipboard.writeText(text).catch(() => {});
        }
      }, true);
    });
  }

  // Icon-only action button (matches Claude's muted→primary square buttons)
  function mkActBtn(label, glyph, handler) {
    const b = E('button', { cls:'cl-act', title:label, 'aria-label':label, html: ic(glyph) });
    b.addEventListener('click', (e) => { e.stopPropagation(); handler(); });
    return b;
  }
  // Copy a mirrored bubble's text, with the brief check-mark confirmation Claude shows
  function copyBubble(bub, btn) {
    const txt = (bub.innerText || '').trim();
    navigator.clipboard.writeText(txt).then(() => {
      const g = btn.querySelector('.cl-ai');
      if (g) { g.textContent = G.copied; btn.classList.add('cl-act--ok');
               setTimeout(() => { g.textContent = G.copy; btn.classList.remove('cl-act--ok'); }, 1200); }
    }).catch(()=>{});
  }

  // Branch/version switcher widget (‹ N/M ›). Hidden until the row has versions.
  function mkVerSwitcher(st) {
    const chL = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M8.5 3L5 7l3.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const chR = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5.5 3L9 7l-3.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const prev = E('button', { cls:'cl-ver-b', title:'Previous', html: chL });
    const lbl  = E('span', { cls:'cl-ver-t' });
    const next = E('button', { cls:'cl-ver-b', title:'Next', html: chR });
    prev.addEventListener('click', e => { e.stopPropagation(); dsBranch(st.srcRow, -1); });
    next.addEventListener('click', e => { e.stopPropagation(); dsBranch(st.srcRow, +1); });
    const box = E('div', { cls:'cl-ver', style:{ display:'none' } }, [ prev, lbl, next ]);
    st.verEl = box; st.verLbl = lbl; st.verPrev = prev; st.verNext = next;
    return box;
  }
  // Mirror file attachments from a sent user message into Claude-style cards.
  // DeepSeek renders each attachment as a `.ds-animated-size-item` card with the
  // filename in a leaf node + a size string — same component as the composer.
  function syncUserFiles(st, row) {
    if (!st.filesEl) return;
    const cards = [...row.querySelectorAll('.ds-animated-size-item')]
      .filter(c => { const t = (c.textContent || '').trim(); return t && t.length < 160; });
    const files = cards.map(c => {
      let name = (c.querySelector('.f3a54b52') || c).textContent.trim();
      name = name.replace(/(Parsing failed|No text.*|解析失败).*$/i, '').trim();
      const sizeM = (c.textContent || '').match(/(\d+(?:\.\d+)?)\s?(KB|MB|GB|B)\b/i);
      name = name.replace(/\s*\d+(?:\.\d+)?\s?(?:KB|MB|GB|B)\b.*$/i, '').trim() || 'file';
      const ext = (name.match(/\.(\w{1,6})$/) || [, ''])[1].toUpperCase();
      return { name, size: sizeM ? (sizeM[1] + sizeM[2].toUpperCase()) : '', ext };
    });
    const key = files.map(f => f.name + f.size).join('|');
    if (key === st.filesKey) return;
    st.filesKey = key;
    st.filesEl.innerHTML = '';
    if (!files.length) { st.filesEl.style.display = 'none'; return; }
    files.forEach(f => {
      st.filesEl.appendChild(E('div', { cls:'cl-ufile' }, [
        E('div', { cls:'cl-ufile-ic', html: I.fileIcon }),
        E('div', { cls:'cl-ufile-meta' }, [
          E('div', { cls:'cl-ufile-n', text: f.name }),
          E('div', { cls:'cl-ufile-s', text: [f.ext, f.size].filter(Boolean).join(' ') }),
        ]),
      ]));
    });
    st.filesEl.style.display = 'flex';
  }

  // Reflect DeepSeek's version state (N / M) into the switcher widget.
  function syncVer(st) {
    if (!st.verEl) return;
    const vi = dsVerInfo(st.srcRow);
    if (!vi || vi.total <= 1) { st.verEl.style.display = 'none'; return; }
    st.verEl.style.display = 'inline-flex';
    st.verLbl.textContent = vi.cur + ' / ' + vi.total;
    st.verPrev.disabled = vi.cur <= 1;
    st.verNext.disabled = vi.cur >= vi.total;
  }

  // Inline message editor (matches Claude image 44): bubble → textarea + branch
  // notice + Cancel / Save. Save drives DeepSeek's real edit (creates a branch).
  function openInlineEdit(st) {
    if (st.editing) return; st.editing = true;
    const original = userRowText(st.srcRow);
    st.bub.style.display = 'none';
    const ta = E('textarea', { cls:'cl-edit-ta' });
    ta.value = original;
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { close(false); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); close(true); }   // Enter = Save
    });
    const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    const notice = E('div', { cls:'cl-edit-note', html:
      I.info + '<span>Editing this message will create a new conversation branch. You can switch between branches using the arrow buttons.</span>' });
    const cancel = E('button', { cls:'cl-edit-btn', text:'Cancel' });
    const save   = E('button', { cls:'cl-edit-btn cl-edit-btn--save', text:'Save' });
    const bar = E('div', { cls:'cl-edit-bar' }, [ notice, cancel, save ]);
    const box = E('div', { cls:'cl-edit' }, [ ta, bar ]);
    st.wrap.insertBefore(box, st.bub.nextSibling);
    function close(commit) {
      const val = ta.value.trim();
      box.remove(); st.bub.style.display = ''; st.editing = false;
      if (commit && val && val !== original) dsEditCommit(st.srcRow, val);
    }
    cancel.addEventListener('click', () => close(false));
    save.addEventListener('click', () => close(true));
    requestAnimationFrame(() => { fit(); ta.focus(); ta.setSelectionRange(val0(), val0()); });
    function val0(){ return ta.value.length; }
    ta.addEventListener('input', fit);
  }

  // ── Web-search / reasoning "process" mirror ───────────────────────────────
  // DeepSeek packs the WHOLE thought process — multiple reasoning paragraphs
  // INTERLEAVED with "Found N web pages" / "Read N pages" search-step blocks —
  // into one pre-answer wrapper, where each reasoning chunk is its OWN
  // .ds-think-content. A single querySelector('.ds-think-content') therefore
  // captures only the FIRST chunk and silently drops every later paragraph and
  // search step. We mirror EVERY pre-answer sibling instead (deploy-proof:
  // positional, never a hashed class).
  function dsProcParts(row) {
    const ans = row.querySelector('.ds-markdown.ds-assistant-message-main-content');
    let msg = ans ? ans.parentElement : null;
    if (!msg) { const tc = row.querySelector('.ds-think-content'); msg = tc ? (tc.closest('.ds-message') || row) : null; }
    if (!msg) return null;
    const parts = [];
    for (const c of msg.children) {
      if (c === ans || (c.classList && c.classList.contains('ds-assistant-message-main-content'))) break;
      if (!(c.textContent || '').trim()) continue;           // skip empty spacers
      parts.push(c);
    }
    return parts.length ? parts : null;
  }
  // Web-search present (vs. pure chain-of-thought)?
  function dsHasSearch(parts) {
    return parts.some(p => /(web pages?|Found\s+\d+|Read\s+\d+\s*(pages?|web)|搜索|网页|阅读了|已阅读)/i.test(p.textContent || ''));
  }
  // Clone the process into clean HTML for our collapsible — dropping DeepSeek's
  // own "Thought for N seconds" toggle (our header already labels the block) and
  // its now-dead collapse chevrons. Keeps all reasoning + every search step.
  function buildProcHTML(parts) {
    const tmp = document.createElement('div');
    parts.forEach(p => tmp.appendChild(p.cloneNode(true)));
    [...tmp.children].forEach(wrap => {
      [...wrap.children].forEach(c => {
        const t = (c.textContent || '').trim();
        if (t.length < 28 && /^(Thought for\b|思考(用时|了)?|Thinking\b|已深度思考)/i.test(t)) c.remove();
      });
    });
    return tmp.innerHTML;
  }

  // Build the DOM node for one row (called only when the row set changes)
  function renderRow(row) {
    const answer = row.querySelector('.ds-markdown.ds-assistant-message-main-content');
    const think  = row.querySelector('.ds-think-content');
    const anyMd  = row.querySelector('.ds-markdown');
    const isAst  = !!(answer || think || anyMd);

    if (!isAst) {
      const wrap = E('div', { cls:'cl-msg cl-msg--u' });
      const filesEl = E('div', { cls:'cl-ufiles', style:{ display:'none' } });
      const bub  = E('div', { cls:'cl-bub cl-bub--u' });
      wrap.appendChild(filesEl);
      wrap.appendChild(bub);
      // User-message actions (icon-only, matching Claude): ‹N/M› · Retry · Edit · Copy.
      const st = { role:'user', wrap, bub, filesEl, filesKey:'', srcRow:row, userLen:-1, verEl:null, verLbl:null };
      const ver   = mkVerSwitcher(st);
      const uRetry = mkActBtn('Retry', G.retry, () => dsRetryUser(st.srcRow));
      const uEdit  = mkActBtn('Edit',  G.edit,  () => openInlineEdit(st));
      const uCopy  = mkActBtn('Copy',  G.copy,  () => copyBubble(st.bub, uCopy));
      wrap.appendChild(E('div', { cls:'cl-acts' }, [ ver, uRetry, uEdit, uCopy ]));
      msgsEl.appendChild(wrap);
      updateRow(row, st);
      return st;
    }

    const wrap = E('div', { cls:'cl-msg cl-msg--a' });
    // Process block (reasoning + web-search steps). Always built but hidden until
    // updateRow detects an actual thought/search process for this row — so a
    // late-appearing <think> still gets mirrored without a full re-render.
    const thinkBody = E('div', { cls:'cl-think-body' });
    const thinkHead = E('div', { cls:'cl-think-hd' }, [
      E('span', { cls:'cl-think-ic', html: I.chevron }),
      E('span', { cls:'cl-think-lbl', text:'Thinking…' }),
    ]);
    const thinkBlock = E('div', { cls:'cl-think cl-think--open', style:{ display:'none' } }, [ thinkHead, thinkBody ]);
    thinkHead.addEventListener('click', () => thinkBlock.classList.toggle('cl-think--open'));
    wrap.appendChild(thinkBlock);
    const bub = E('div', { cls:'cl-bub cl-bub--a' });
    wrap.appendChild(bub);

    const st = { role:'ast', wrap, bub, thinkBlock, thinkBody, srcRow:row, ansLen:-1, thinkLen:-1, verEl:null, verLbl:null };
    // Action toolbar — icon-only: ‹N/M› · Copy · Retry(regenerate)
    const ver     = mkVerSwitcher(st);
    const copyBtn = mkActBtn('Copy', G.copy, () => copyBubble(st.bub, copyBtn));
    const retryBtn = mkActBtn('Retry', G.retry, () => dsRegenerate(st.srcRow));
    wrap.appendChild(E('div', { cls:'cl-acts' }, [ ver, copyBtn, retryBtn ]));
    // Claude end-mark sparkle — CSS shows it only under the last assistant reply
    wrap.appendChild(E('div', { cls:'cl-endmark', html: I.sparkle(22, D.brand) }));

    msgsEl.appendChild(wrap);
    updateRow(row, st);
    return st;
  }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  DEEPSEEK MESSAGE-TOOLBAR BRIDGE                                ║
  // ║  Selectors verified live against DeepSeek (no hashed classes):   ║
  // ║   • action buttons = [role=button].ds-button--icon in the row,   ║
  // ║     minus the version arrows → [0]=copy, [1]=regenerate (assist) ║
  // ║     / edit (user).                                               ║
  // ║   • version arrows = element siblings of the "N / M" text div.   ║
  // ║   • edit → click edit → textarea.ds-textarea__textarea → Send.   ║
  // ╚══════════════════════════════════════════════════════════════════╝

  function dsHover(row) {
    ['pointerover','pointerenter','mouseover','mouseenter','mousemove']
      .forEach(t => row.dispatchEvent(new MouseEvent(t, { bubbles:true, view:window })));
  }
  function dsClick(el) {
    if (!el) return false;
    ['pointerdown','mousedown','pointerup','mouseup','click']
      .forEach(t => el.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window })));
    return true;
  }
  // the "N / M" version-switcher text div within a DeepSeek row (childless leaf)
  function dsVerDiv(row) {
    return [...row.querySelectorAll('div')].find(d =>
      d.children.length === 0 && /^\s*\d+\s*\/\s*\d+\s*$/.test(d.textContent));
  }
  function dsVerInfo(row) {
    const v = dsVerDiv(row); if (!v) return null;
    const m = v.textContent.match(/(\d+)\s*\/\s*(\d+)/); if (!m) return null;
    const prev = v.previousElementSibling, next = v.nextElementSibling;
    return { cur:+m[1], total:+m[2],
             prev: prev && prev.matches('[role="button"]') ? prev : null,
             next: next && next.matches('[role="button"]') ? next : null };
  }
  // The message's FOOTER action toolbar [copy, regenerate/edit, …]. Critically we
  // must exclude buttons that live INSIDE the thinking/search blocks (a search
  // answer has many .ds-button--icon there) — so for assistant rows we keep only
  // buttons positioned AFTER the answer markdown, and always drop the version arrows.
  function dsActionButtons(row) {
    const answer = row.querySelector('.ds-markdown.ds-assistant-message-main-content');
    // Match by [role=button] — this DeepSeek build labels footer buttons
    // `ds-button--iconLabelTertiary` (older builds used `ds-button--icon`, so the
    // old class selector matched NOTHING here → Retry/Edit silently no-op'd).
    let all = [...row.querySelectorAll('[role="button"]')];
    if (answer) {
      // Footer toolbar only: AFTER the answer markdown AND NOT inside it.
      // compareDocumentPosition() flags descendants as FOLLOWING too, so without
      // the !contains() guard the code block's own Copy/Download buttons leak in
      // and shift indices (which is why Retry was hitting the code "Download").
      // Verified order → [Copy, Regenerate, Like, Dislike, Share].
      all = all.filter(b => !answer.contains(b) &&
        (answer.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
    }
    const vi = dsVerInfo(row);
    if (vi) all = all.filter(b => b !== vi.prev && b !== vi.next);
    return all;
  }

  // Find DeepSeek's search-process collapsible within an assistant row (the
  // "Read N web pages" block that sits beside the answer markdown). Content-based,
  // so it survives class renames.
  function dsSearchBlock(row) {
    const title = [...row.querySelectorAll('span,div')].find(e =>
      e.children.length === 0 && e.textContent.length < 40 &&
      /(Read\s+\d+\s+web|web pages?|Searched|搜索了|阅读了\s*\d+|已搜索)/i.test(e.textContent) &&
      !e.closest('.ds-markdown'));
    if (!title) return null;
    let c = title;
    while (c.parentElement && c.parentElement !== row &&
           !c.parentElement.querySelector('.ds-markdown.ds-assistant-message-main-content')) {
      c = c.parentElement;
    }
    return c;
  }

  // Regenerate the answer in a DeepSeek assistant row (action button [1]).
  // DeepSeek mounts regenerate/like/dislike only after the row is hovered, so we
  // hover repeatedly and poll until the full toolbar (≥2 actions) appears.
  function dsRegenerate(astRow) {
    if (!astRow) return;
    try { astRow.scrollIntoView({ block:'center' }); } catch (_) {}   // help DeepSeek mount its toolbar
    let tries = 0;
    const go = () => {
      dsHover(astRow);
      const acts = dsActionButtons(astRow);
      if (acts.length >= 2) { dsClick(acts[1]); return; }   // [0]=copy, [1]=regenerate
      if (tries++ < 14) setTimeout(go, 70);
    };
    go();
  }
  // Retry from a USER row → regenerate the following assistant answer.
  function dsRetryUser(userRow) {
    let p = userRow && userRow.nextElementSibling;
    while (p && !p.querySelector('.ds-markdown.ds-assistant-message-main-content')) p = p.nextElementSibling;
    if (p) dsRegenerate(p);
  }
  // Switch answer/prompt branch (dir = -1 prev, +1 next).
  function dsBranch(row, dir) {
    const vi = dsVerInfo(row); if (!vi) return;
    dsClick(dir < 0 ? vi.prev : vi.next);
  }
  // Commit an edited user prompt → DeepSeek edit flow (creates a new branch).
  function dsEditCommit(userRow, newText) {
    if (!userRow) return;
    const wrapped = buildOutgoing(newText);
    try { userRow.scrollIntoView({ block:'center' }); } catch (_) {}
    let etries = 0;
    const openEdit = () => {
      dsHover(userRow);
      const acts = dsActionButtons(userRow);
      const editBtn = acts[1];                   // [0]=copy, [1]=edit
      if (!editBtn) { if (etries++ < 12) setTimeout(openEdit, 70); return; }
      dsClick(editBtn);
      let tries = 0;
      const tick = () => {
        // DeepSeek's edit box only — scope to #root + the edit class so we never
        // grab our own overlay textarea (.cl-ta), which lives outside #root.
        const ta = ([...document.querySelectorAll('#root textarea.ds-textarea__textarea')]
                    .filter(t => t.offsetParent !== null).pop())
                || ([...document.querySelectorAll('#root textarea')]
                    .filter(t => t.offsetParent !== null && !t.classList.contains('cl-ta')).pop());
        if (ta) {
          try {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, wrapped);
          } catch (_) { ta.value = wrapped; }
          ta.dispatchEvent(new Event('input', { bubbles:true }));
          resetMirror();
          setTimeout(() => {
            const send = [...document.querySelectorAll('#root [role="button"],#root button,#root .ds-button')]
              .find(b => b.offsetParent !== null && /^(send|发送|save|保存)$/i.test((b.textContent||'').trim()));
            dsClick(send);
          }, 70);
        } else if (tries++ < 25) setTimeout(tick, 50);
      };
      setTimeout(tick, 90);
    };
    openEdit();
  }

  // Incrementally update one row's dynamic content (cheap — only on change)
  function updateRow(row, st) {
    if (!st) return;
    st.srcRow = row;   // keep the DeepSeek row ref fresh — virtual list recycles nodes
    if (st.role === 'user') {
      const len = row.textContent.length;
      if (len !== st.userLen && !st.editing) { st.bub.textContent = userRowText(row); st.userLen = len; }
      syncUserFiles(st, row);
      syncVer(st);
      return;
    }
    const answer = row.querySelector('.ds-markdown.ds-assistant-message-main-content');
    const think  = row.querySelector('.ds-think-content');
    const anyMd  = row.querySelector('.ds-markdown');

    // Thinking / Search block — ONE Claude-style collapsible mirroring DeepSeek's
    // FULL pre-answer process: every reasoning paragraph + every "Found N web
    // pages" / "Read N pages" step, in order (not just the first chunk).
    const parts = dsProcParts(row);
    if (parts && st.thinkBody) {
      st.thinkBlock.style.display = '';
      const html = parts.map(p => p.innerHTML).join('');     // cheap change key
      if (html.length !== st.thinkLen) {
        st.thinkBody.innerHTML = buildProcHTML(parts); cleanStyles(st.thinkBody); decorateCitations(st.thinkBody); st.thinkLen = html.length;
      }
      const lbl = st.thinkBlock.querySelector('.cl-think-lbl');
      if (lbl) lbl.textContent = dsHasSearch(parts) ? 'Searched the web' : (answer ? 'Thought process' : 'Thinking…');
      // auto-collapse once the answer starts streaming
      if (answer && !st.collapsedOnce) { st.thinkBlock.classList.remove('cl-think--open'); st.collapsedOnce = true; }
    } else if (st.thinkBlock) {
      st.thinkBlock.style.display = 'none';
    }

    // Answer bubble
    const ansSrc = answer || (think ? null : anyMd);
    if (ansSrc) {
      const len = ansSrc.innerHTML.length;
      if (len !== st.ansLen) { st.bub.innerHTML = ansSrc.innerHTML; cleanStyles(st.bub); decorateCitations(st.bub); fixCodeBlocks(st.bub); st.ansLen = len; }
      st.bub.style.display = '';
    } else {
      st.bub.style.display = 'none';   // pure-thinking phase, no answer yet
    }
    syncVer(st);
  }

  // Smart mirror: rebuild only when the row count changes, otherwise patch in place
  function mirror() {
    if (!msgsEl) return;
    const vis = document.querySelector('#root .ds-virtual-list-visible-items');
    if (!vis) return;
    const rows = [...vis.children].filter(c => c.textContent.trim().length);
    if (!rows.length) return;

    hideGreeting(); setChatting(true); msgsEl.style.display = 'flex';

    const sc = document.querySelector('.cl-scroll');
    const nearBottom = sc && (sc.scrollHeight - sc.scrollTop - sc.clientHeight) < 180;

    if (rows.length !== rendered.length) {
      // Capture geometry so a prepend of earlier messages doesn't jump the view
      const prevH = sc ? sc.scrollHeight : 0, prevTop = sc ? sc.scrollTop : 0;
      msgsEl.innerHTML = ''; rendered = rows.map(r => renderRow(r));
      if (sc && !nearBottom) {
        // keep the same content under the viewport after older rows were added on top
        sc.scrollTop = prevTop + (sc.scrollHeight - prevH);
      }
    } else {
      rows.forEach((r, i) => updateRow(r, rendered[i]));
    }

    // Auto-scroll only if the user is already near the bottom (don't fight scroll-up)
    if (sc && nearBottom) sc.scrollTop = sc.scrollHeight;
  }

  // rAF-throttled trigger so streaming updates are smooth, not chunky
  let mirrorQueued = false;
  function scheduleMirror() {
    if (mirrorQueued) return; mirrorQueued = true;
    requestAnimationFrame(() => { mirrorQueued = false; mirror(); });
  }

  // React to DeepSeek's live DOM mutations (every streamed token) instead of polling
  function startMirrorObserver() {
    const root = document.getElementById('root');
    if (!root) return;
    new MutationObserver(scheduleMirror)
      .observe(root, { childList:true, subtree:true, characterData:true });
  }

  // Find DeepSeek's real scroll container (the element the virtual list scrolls in).
  function dsScrollEl() {
    const vis = document.querySelector('#root .ds-virtual-list-visible-items');
    let el = vis ? vis.parentElement : null;
    while (el && el !== document.body) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) return el;
      el = el.parentElement;
    }
    // fallback: common DeepSeek scroll wrapper
    return document.querySelector('#root .ds-scroll-area, #root [class*="scroll"]') || null;
  }

  // When the user scrolls near the top of OUR overlay, drive DeepSeek's hidden
  // scroll container upward so its virtual list fetches/renders earlier messages
  // (DeepSeek lazy-loads older history on scroll). Our mirror then picks them up.
  let lastTopLoad = 0;
  function maybeLoadEarlier(sc) {
    if (sc.scrollTop > 140) return;
    const now = Date.now();
    if (now - lastTopLoad < 350) return;      // throttle the nudges
    lastTopLoad = now;
    const ds = dsScrollEl();
    if (!ds) return;
    if (ds.scrollTop <= 0) return;             // already at the very top — nothing earlier
    // Nudge DeepSeek up; it will mount earlier rows and (if needed) fetch older history.
    ds.scrollTop = Math.max(0, ds.scrollTop - ds.clientHeight);
    ds.dispatchEvent(new Event('scroll', { bubbles:true }));
    scheduleMirror();
  }
  function startScrollLoader() {
    const sc = document.querySelector('.cl-scroll');
    if (!sc) return;
    sc.addEventListener('scroll', () => maybeLoadEarlier(sc), { passive:true });
  }

  // Toggle conversation layout: input docks to bottom, pills + greeting hidden
  function setChatting(on) {
    const app = document.querySelector('.cl-app');
    if (app) app.classList.toggle('cl-app--chatting', !!on);
    // Placeholder follows the screen, like claude.ai: welcome vs. conversation
    const ta0 = document.getElementById('cl-ta');
    if (ta0) ta0.placeholder = on ? 'Reply to Claude…' : 'How can I help you today?';
    // Move the input between the centered welcome and the bottom dock
    const inwrap = document.querySelector('.cl-inwrap');
    const dock = document.getElementById('cl-dock');
    const welcome = document.querySelector('.cl-welcome');
    const pills = welcome && welcome.querySelector('.cl-sugg');
    const disc = dock && dock.querySelector('.cl-disc');
    if (!inwrap || !dock || !welcome) return;
    if (on) {
      if (inwrap.parentElement !== dock) dock.insertBefore(inwrap, disc || null);
    } else {
      if (inwrap.parentElement !== welcome) welcome.insertBefore(inwrap, pills || null);
    }
  }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  GREETING SHOW/HIDE                                             ║
  // ╚══════════════════════════════════════════════════════════════════╝

  let greetEl = null;
  function hideGreeting() { if (greetEl) greetEl.style.display = 'none'; }
  function showGreeting() { if (greetEl) greetEl.style.display = 'flex'; }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  MODEL SELECTOR MENU (+ Effort submenu + Thinking)              ║
  // ╚══════════════════════════════════════════════════════════════════╝

  let menuEl = null, subEl = null, menuOpen = false, msbRef = null;

  function refreshMsb() {
    if (!msbRef) return;
    msbRef.querySelector('.cl-msb-l').textContent = cfg().label;
    msbRef.querySelector('.cl-msb-eff').textContent = effort;
  }

  function buildMenu() {
    const items = ['opus','sonnet','haiku'].map(t => {
      const m = C.MODELS[t];
      return E('div', { cls:'cl-mi', onclick:(e)=>{e.stopPropagation(); tier=t; thinking=C.MODELS[t].thinking; saveAll(); applyDSModel(); refreshMsb(); closeMenu();} }, [
        E('div',{cls:'cl-mi-l'},[ E('div',{cls:'cl-mi-n',text:m.label}), E('div',{cls:'cl-mi-d',text:m.desc}) ]),
        t===tier ? E('div',{cls:'cl-mi-ck',html:I.check}) : null,
      ]);
    });

    const effortRow = E('div', { cls:'cl-mi',
      onmouseenter:()=>{ cancelCloseSub(); openSub(); },
      onmouseleave:scheduleCloseSub,
      onclick:(e)=>{e.stopPropagation(); cancelCloseSub(); openSub();} }, [
      E('div',{cls:'cl-mi-l'},[ E('div',{cls:'cl-mi-n',text:'Effort'}) ]),
      E('div',{cls:'cl-mi-rt'},[ E('span',{text:effort}), E('span',{html:I.chevronR}) ]),
    ]);

    return E('div', { cls:'cl-menu' }, [
      ...items, E('div',{cls:'cl-div'}), effortRow,
    ]);
  }

  function buildSub() {
    const rows = C.EFFORTS.map(ef => E('div',{cls:'cl-er', onclick:(e)=>{e.stopPropagation(); effort=ef; saveAll(); applyDSModel(); refreshMsb(); buildSubRefresh();}},[
      E('div',{cls:'cl-er-l'},[ E('span',{text:ef}),
        ef==='High'?E('span',{cls:'cl-er-tag',text:'Default'}):null,
        ef==='Max'?E('span',{cls:'cl-er-tag',html:I.info}):null ]),
      ef===effort ? E('div',{cls:'cl-er-ck',html:I.check}) : null,
    ]));
    const thRow = E('div',{cls:'cl-th'},[
      E('div',{cls:'cl-th-l'},[ E('div',{cls:'cl-th-n',text:'Thinking'}), E('div',{cls:'cl-th-d',text:'Can think for more complex tasks'}) ]),
      E('button',{cls:'cl-tog'+(thinking?' cl-tog--on':''), onclick:(e)=>{e.stopPropagation(); thinking=!thinking; saveAll(); applyDSModel(); e.currentTarget.classList.toggle('cl-tog--on',thinking);}}),
    ]);
    return E('div',{cls:'cl-sub'},[
      E('div',{cls:'cl-sub-hd',text:'Higher effort means more thorough responses, but takes longer and uses your limits faster.'}),
      ...rows, E('div',{cls:'cl-div'}), thRow,
    ]);
  }
  function buildSubRefresh() {
    if (!subEl) return;
    const open = subEl.classList.contains('cl-sub--open');
    const newSub = buildSub();
    newSub.addEventListener('mouseenter', cancelCloseSub);
    newSub.addEventListener('mouseleave', scheduleCloseSub);
    subEl.replaceWith(newSub); subEl = newSub;
    if (open) { subEl.classList.add('cl-sub--open'); positionSub(); }
  }

  function openMenu() {
    if (menuOpen) return; menuOpen = true;
    menuEl = buildMenu(); document.body.appendChild(menuEl);
    requestAnimationFrame(() => {
      const r = msbRef.getBoundingClientRect();
      const mr = menuEl.getBoundingClientRect();
      menuEl.style.left = Math.max(8, r.left) + 'px';
      menuEl.style.top  = (r.top - mr.height - 8) + 'px';
      requestAnimationFrame(() => menuEl.classList.add('cl-menu--open'));
    });
    setTimeout(() => document.addEventListener('click', closeMenu, { once:true }), 0);
  }
  function positionSub() {
    if (!subEl || !menuEl) return;
    const effortRow = [...menuEl.querySelectorAll('.cl-mi')].find(x => x.textContent.includes('Effort'));
    const r = (effortRow || menuEl).getBoundingClientRect();
    const mr = menuEl.getBoundingClientRect();
    const sr = subEl.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    // Prefer opening to the right of the menu; flip to the left if it would clip.
    let left = mr.right + 6;
    if (left + sr.width > vw - 8) left = mr.left - sr.width - 6;
    if (left < 8) left = 8;
    let top = r.top - sr.height / 2;
    top = Math.min(Math.max(8, top), vh - sr.height - 8);
    subEl.style.left = left + 'px';
    subEl.style.top  = top + 'px';
  }
  let subTimer = null;
  function cancelCloseSub() { if (subTimer) { clearTimeout(subTimer); subTimer = null; } }
  function scheduleCloseSub() { cancelCloseSub(); subTimer = setTimeout(closeSub, 220); }
  function closeSub() { cancelCloseSub(); if (subEl) { subEl.classList.remove('cl-sub--open'); const s=subEl; subEl=null; setTimeout(()=>s.remove(),150); } }
  function openSub() {
    if (subEl) return;
    subEl = buildSub(); document.body.appendChild(subEl);
    subEl.addEventListener('mouseenter', cancelCloseSub);
    subEl.addEventListener('mouseleave', scheduleCloseSub);
    requestAnimationFrame(() => { positionSub(); requestAnimationFrame(() => subEl.classList.add('cl-sub--open')); });
  }
  function closeMenu() {
    if (!menuOpen) return; menuOpen = false;
    if (subEl) { subEl.remove(); subEl = null; }
    if (menuEl) { menuEl.classList.remove('cl-menu--open'); const m=menuEl; menuEl=null; setTimeout(()=>m.remove(),150); }
  }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  BUILD APP                                                      ║
  // ╚══════════════════════════════════════════════════════════════════╝

  function buildApp() {
    // --- Sidebar (expanded 288px, matches claude.ai) ---
    const WM = `<svg viewBox="30 0 82 24" height="20" fill="currentColor" role="img" aria-label="Claude"><path d="M39.504 21.2643C37.688 21.2643 36.06 20.9003 34.62 20.1723C33.18 19.4443 32.048 18.4163 31.224 17.0883C30.408 15.7603 30 14.2243 30 12.4803C30 10.6563 30.412 9.03233 31.236 7.60833C32.06 6.17633 33.196 5.06833 34.644 4.28433C36.1 3.49233 37.74 3.09633 39.564 3.09633C40.692 3.09633 41.82 3.22033 42.948 3.46833C44.084 3.71633 45.072 4.09633 45.912 4.60833V8.56833H44.832C44.536 7.16833 43.96 6.12433 43.104 5.43633C42.256 4.74833 41.076 4.40433 39.564 4.40433C38.164 4.40433 36.996 4.73233 36.06 5.38833C35.132 6.03633 34.444 6.93633 33.996 8.08833C33.548 9.24033 33.324 10.5643 33.324 12.0603C33.324 13.5483 33.576 14.8883 34.08 16.0803C34.584 17.2723 35.328 18.2163 36.312 18.9123C37.296 19.6003 38.476 19.9443 39.852 19.9443C40.796 19.9443 41.608 19.7483 42.288 19.3563C42.968 18.9643 43.54 18.4363 44.004 17.7723C44.468 17.1003 44.908 16.2803 45.324 15.3123H46.464L45.684 19.6803C44.892 20.2003 43.936 20.5963 42.816 20.8683C41.704 21.1323 40.6 21.2643 39.504 21.2643ZM47.964 21.0003V19.9563C48.356 19.9003 48.668 19.8403 48.9 19.7763C49.14 19.7043 49.332 19.5883 49.476 19.4283C49.628 19.2683 49.704 19.0443 49.704 18.7563V5.83233L47.964 5.08833V4.28433L51.612 2.73633H52.56V18.7563C52.56 19.0523 52.632 19.2803 52.776 19.4403C52.928 19.6003 53.12 19.7123 53.352 19.7763C53.592 19.8403 53.912 19.9003 54.312 19.9563V21.0003H47.964ZM59.028 21.2643C58.38 21.2643 57.792 21.1363 57.264 20.8803C56.736 20.6243 56.32 20.2563 56.016 19.7763C55.712 19.2963 55.56 18.7363 55.56 18.0963C55.56 17.1203 55.86 16.3443 56.46 15.7683C57.068 15.1843 57.916 14.7403 59.004 14.4363L63.24 13.2363V11.7123C63.24 10.8883 63.048 10.2523 62.664 9.80433C62.288 9.34833 61.708 9.12033 60.924 9.12033C60.228 9.12033 59.704 9.33233 59.352 9.75633C59.008 10.1723 58.836 10.7483 58.836 11.4843V12.6123H56.988C56.764 12.4683 56.588 12.2763 56.46 12.0363C56.34 11.7883 56.28 11.5163 56.28 11.2203C56.28 10.5563 56.516 9.98833 56.988 9.51633C57.46 9.03633 58.06 8.67633 58.788 8.43633C59.516 8.19633 60.256 8.07633 61.008 8.07633C62.592 8.07633 63.836 8.44033 64.74 9.16833C65.644 9.89633 66.096 11.0003 66.096 12.4803V18.5403C66.096 18.8603 66.168 19.1043 66.312 19.2723C66.456 19.4403 66.644 19.5603 66.876 19.6323C67.116 19.6963 67.44 19.7563 67.848 19.8123V20.8563C67.536 20.9683 67.208 21.0563 66.864 21.1203C66.528 21.1843 66.204 21.2163 65.892 21.2163C65.148 21.2163 64.548 21.0483 64.092 20.7123C63.644 20.3683 63.372 19.8643 63.276 19.2003C62.716 19.8643 62.08 20.3763 61.368 20.7363C60.664 21.0883 59.884 21.2643 59.028 21.2643ZM60.444 19.3443C60.948 19.3443 61.44 19.2283 61.92 18.9963C62.408 18.7563 62.848 18.4403 63.24 18.0483V14.3403L60.168 15.2523C59.592 15.4283 59.152 15.7003 58.848 16.0683C58.544 16.4363 58.392 16.9003 58.392 17.4603C58.392 17.8203 58.48 18.1443 58.656 18.4323C58.832 18.7203 59.076 18.9443 59.388 19.1043C59.7 19.2643 60.052 19.3443 60.444 19.3443ZM73.608 21.2643C72.32 21.2643 71.356 20.9283 70.716 20.2563C70.084 19.5843 69.768 18.6363 69.768 17.4123V10.9083L68.016 10.2603L68.112 9.45633L71.664 8.07633H72.624V16.9323C72.624 17.6923 72.812 18.2563 73.188 18.6243C73.564 18.9923 74.14 19.1763 74.916 19.1763C75.428 19.1763 75.964 19.0603 76.524 18.8283C77.084 18.5883 77.6 18.2803 78.072 17.9043V10.9083L76.32 10.2603V9.45633L79.98 8.07633H80.928V17.8323C80.928 18.1523 81 18.4003 81.144 18.5763C81.288 18.7443 81.476 18.8643 81.708 18.9363C81.948 19.0083 82.272 19.0723 82.68 19.1283V20.1603L79.02 21.1803H78.072V19.0803C77.44 19.7363 76.728 20.2643 75.936 20.6643C75.144 21.0643 74.368 21.2643 73.608 21.2643ZM89.328 21.2643C88.264 21.2643 87.312 21.0083 86.472 20.4963C85.632 19.9763 84.976 19.2683 84.504 18.3723C84.032 17.4763 83.796 16.4843 83.796 15.3963C83.796 13.9643 84.08 12.6963 84.648 11.5923C85.224 10.4883 86.032 9.62833 87.072 9.01233C88.112 8.38833 89.32 8.07633 90.696 8.07633C91.12 8.07633 91.556 8.12433 92.004 8.22033C92.46 8.30833 92.896 8.43633 93.312 8.60433V5.82033L91.56 5.08833V4.28433L95.22 2.73633H96.168V17.8323C96.168 18.1523 96.24 18.4003 96.384 18.5763C96.536 18.7443 96.728 18.8643 96.96 18.9363C97.2 19.0083 97.52 19.0723 97.92 19.1283V20.1603L94.26 21.1803H93.312V19.5843C92.752 20.1123 92.132 20.5243 91.452 20.8203C90.78 21.1163 90.072 21.2643 89.328 21.2643ZM90.504 19.3323C90.976 19.3323 91.456 19.2363 91.944 19.0443C92.432 18.8523 92.888 18.5883 93.312 18.2523V10.3563C92.584 9.76433 91.776 9.46833 90.888 9.46833C89.992 9.46833 89.236 9.69633 88.62 10.1523C88.004 10.6083 87.54 11.2283 87.228 12.0123C86.924 12.7883 86.772 13.6563 86.772 14.6163C86.772 15.5283 86.908 16.3403 87.18 17.0523C87.452 17.7563 87.868 18.3123 88.428 18.7203C88.988 19.1283 89.68 19.3323 90.504 19.3323ZM105.252 21.2643C104.068 21.2643 103.004 20.9883 102.06 20.4363C101.116 19.8843 100.376 19.1163 99.84 18.1323C99.304 17.1483 99.036 16.0443 99.036 14.8203C99.036 13.5563 99.308 12.4123 99.852 11.3883C100.404 10.3563 101.156 9.54833 102.108 8.96433C103.068 8.37233 104.136 8.07633 105.312 8.07633C106.216 8.07633 107.048 8.26433 107.808 8.64033C108.568 9.01633 109.2 9.54433 109.704 10.2243C110.216 10.9043 110.552 11.6883 110.712 12.5763L101.928 15.2883C102.168 16.4003 102.644 17.2763 103.356 17.9163C104.076 18.5563 104.968 18.8763 106.032 18.8763C106.92 18.8763 107.716 18.6523 108.42 18.2043C109.124 17.7483 109.748 17.0603 110.292 16.1403L111.228 16.4403C111.012 17.4003 110.62 18.2443 110.052 18.9723C109.484 19.7003 108.784 20.2643 107.952 20.6643C107.128 21.0643 106.228 21.2643 105.252 21.2643ZM107.628 12.2043C107.516 11.6523 107.324 11.1683 107.052 10.7523C106.788 10.3283 106.46 10.0003 106.068 9.76833C105.676 9.53633 105.244 9.42033 104.772 9.42033C104.18 9.42033 103.656 9.60033 103.2 9.96033C102.752 10.3123 102.4 10.8163 102.144 11.4723C101.896 12.1203 101.772 12.8723 101.772 13.7283C101.772 13.8803 101.776 13.9963 101.784 14.0763L107.628 12.2043Z"/></svg>`;

    const navRow = (glyph, label, onClick, accent) => E('button',
      { cls:'cl-row'+(accent?' cl-row--accent':''), onclick:onClick||(()=>{}) },
      [ E('span',{cls:'cl-ai',html:glyph}), E('span',{cls:'cl-lbl',text:label}) ]);

    const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || '');
    const searchBtn = ibtn(ic(G.search), 'Search chats', isMac ? '⌘ K' : 'Ctrl K', toggleChats);
    searchBtn.setAttribute('aria-label', 'Search chats');
    const collapseBtn = ibtn(ic(G.toggle), 'Toggle sidebar', '',
      () => document.querySelector('.cl-sb').classList.toggle('cl-sb--collapsed'));
    collapseBtn.setAttribute('aria-label', 'Toggle sidebar');

    const userBtn = E('button', { cls:'cl-user' }, [
      E('span', { cls:'cl-av', text:(userName()[0] || 'U').toUpperCase() }),
      E('span', { cls:'cl-user-meta' }, [
        E('span', { cls:'cl-user-name', text:userName() }),
        E('span', { cls:'cl-user-plan', text:'Free plan' }),
      ]),
    ]);
    userBtn.addEventListener('click', () => toggleAccount(userBtn));

    histEl = E('div', { cls:'cl-hist' });

    const sidebar = E('nav', { cls:'cl-sb' }, [
      E('div', { cls:'cl-sbtop' }, [
        E('div', { cls:'cl-logo-wm', html: WM }),
        searchBtn,
        collapseBtn,
      ]),
      E('div', { cls:'cl-nav' }, [
        navRow(G.newchat,   'New chat',  dsNewChat, true),
        navRow(G.chats,     'Chats',     toggleChats),
        navRow(G.code,      'Code',      () => fillPrompt('Help me write code for ')),
        (() => { const r = navRow(G.customize, 'System prompt', toggleSysPrompt); r.id = 'cl-sysrow'; return r; })(),
      ]),
      E('div', { cls:'cl-sec', text:'Recents' }),
      histEl,
      userBtn,
    ]);

    // Greeting
    greetEl = E('div', { cls:'cl-greet' }, [
      E('div', { cls:'cl-greet-spk', html: I.sparkle(32, D.brand) }),
      E('h1', { cls:'cl-greet-txt', text: greetLine() }),
    ]);

    // Model selector button
    msbRef = E('button', { cls:'cl-msb', onclick:(e)=>{e.stopPropagation(); menuOpen?closeMenu():openMenu();} }, [
      E('span', { cls:'cl-msb-l', text: cfg().label }),
      E('span', { cls:'cl-msb-eff', text: effort }),
      E('span', { cls:'cl-msb-cv', html: I.chevron }),
    ]);

    // Textarea — stopPropagation so DeepSeek's global keyboard shortcuts can't
    // hijack copy/paste/select; Enter sends, Shift+Enter newline.
    const ta = E('textarea', { id:'cl-ta', cls:'cl-ta', placeholder:'How can I help you today?', rows:1,
      oninput(){ this.style.height='auto'; this.style.height=Math.min(this.scrollHeight,340)+'px';
                 const sb=document.getElementById('cl-send'); if(sb) sb.disabled=!this.value.trim(); },
      onkeydown(e){ e.stopPropagation(); if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMessage(); } },
      onkeyup(e){ e.stopPropagation(); },
      onkeypress(e){ e.stopPropagation(); },
      onpaste(e){ e.stopPropagation(); },
      oncopy(e){ e.stopPropagation(); },
      oncut(e){ e.stopPropagation(); },
    });
    const sendBtn = E('button', { id:'cl-send', cls:'cl-send', html:I.arrow, 'aria-label':'Send message', onclick:sendMessage });
    sendBtn.disabled = true;   // claude.ai dims the send button until there's input
    const plusBtn = E('button', { cls:'cl-plus', html:I.plus, onclick:(e)=>{ e.stopPropagation(); openPlusMenu(plusBtn); } });
    const chips = E('div', { cls:'cl-chips', id:'cl-chips', style:{display:'none'} });

    const inputBox = E('div', { cls:'cl-input' }, [
      chips,
      ta,
      E('div', { cls:'cl-irow' }, [ plusBtn, E('div',{cls:'cl-row-sp'}), msbRef, sendBtn ]),
    ]);

    // Suggestion pills
    const pills = E('div', { cls:'cl-sugg' }, [
      E('button',{cls:'cl-pill', onclick:()=>fillPrompt('Help me write code for ')},[ E('span',{html:I.codeP}), 'Code' ]),
      E('button',{cls:'cl-pill', onclick:()=>fillPrompt('Help me write ')},[ E('span',{html:I.writeP}), 'Write' ]),
      E('button',{cls:'cl-pill', onclick:()=>fillPrompt('Help me learn about ')},[ E('span',{html:I.learnP}), 'Learn' ]),
    ]);

    // Input wrapper (moved between welcome-center and bottom-dock by setChatting)
    const inwrap = E('div', { cls:'cl-inwrap' }, [ inputBox ]);
    const disc = E('div', { cls:'cl-disc', text:'Claude can make mistakes. Please double-check responses.' });

    // Messages area (scrolls)
    msgsEl = E('div', { cls:'cl-msgs', style:{display:'none'} });

    // Incognito data notice (matches claude.ai's incognito copy). Shown under the
    // input both on the welcome screen and in the bottom dock while incognito is on.
    const INCOG_NOTE = 'Incognito chats aren’t saved, added to memory, or used to train models. ' +
      '<a href="https://www.anthropic.com/legal/privacy" target="_blank">Learn more</a> about how your data is used.';
    const incogNoteW = E('div', { cls:'cl-incog-note', html: INCOG_NOTE });

    // Welcome (centered) — holds greeting + input + pills (+ incognito notice) on a fresh chat
    const welcome = E('div', { cls:'cl-welcome' }, [ greetEl, inwrap, pills, incogNoteW ]);
    const scroll = E('div', { cls:'cl-scroll' }, [ msgsEl, welcome ]);

    const incogNote = E('div', { cls:'cl-incog-note', html: INCOG_NOTE });
    // Bottom dock — input pins here during a conversation (outside the scroll)
    const dock = E('div', { cls:'cl-dock', id:'cl-dock' }, [ disc, incogNote ]);

    // Incognito top bar (ghost + "Incognito chat" + ✕ to exit) — matches claude.ai
    const incogBar = E('div', { cls:'cl-incog' }, [
      E('span', { cls:'cl-incog-g', html: I.ghost }),
      E('span', { cls:'cl-incog-t', text:'Incognito chat' }),
      E('button', { cls:'cl-incog-x', html: I.close || '✕', title:'Close incognito chat',
        onclick: () => { if (tempActive()) toggleTemporary(); } }),
    ]);
    document.body.appendChild(incogBar);

    const ghostBtn = E('button', { cls:'cl-ghost', html:I.ghost, onclick:toggleTemporary });
    ghostBtn.id = 'cl-ghost';
    ghostBtn.addEventListener('mouseenter', () => showTip(ghostBtn, tempActive() ? 'End temporary chat' : 'Temporary chat', ''));
    ghostBtn.addEventListener('mouseleave', hideTip);
    const topR = E('div', { cls:'cl-tr' }, [ ghostBtn ]);
    const main = E('div', { cls:'cl-main' }, [ topR, scroll, dock ]);

    return E('div', { cls:'cl-app' }, [ sidebar, main ]);
  }

  function fillPrompt(t) {
    const ta = document.getElementById('cl-ta');
    if (!ta) return;
    ta.value = t;
    ta.dispatchEvent(new Event('input', { bubbles: true }));   // triggers auto-resize
    ta.focus();
    try { ta.setSelectionRange(t.length, t.length); } catch(_) {}  // cursor at end
  }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  TEMPORARY CHAT (ghost button)                                  ║
  // ╚══════════════════════════════════════════════════════════════════╝
  // A temporary chat is auto-deleted on reload or when toggled off.

  function tempActive() { return GM_getValue(TEMP_KEY + '_on') === true; }

  // Sync temp-mode visuals: body.cl-temp drives the incognito top-bar + framed app
  // (matches claude.ai). Also flips the greeting to "You're incognito".
  function applyTempClass() {
    const on = tempActive();
    document.body.classList.toggle('cl-temp', on);
    const g = document.getElementById('cl-ghost');
    if (g) g.classList.toggle('cl-ghost--on', on);
    const gt = document.querySelector('.cl-greet-txt');
    if (gt) gt.textContent = on ? "You're incognito" : greetLine();
    reTitle();   // flip the tab title to/from "New chat - Claude"
  }

  // Robust DeepSeek "new chat" finder for SPA (no hard reload) — matches by
  // aria-label / title / text (zh + en), never a hashed class.
  const NEWCHAT_RE = /(新对话|开启新对话|新建对话|new chat|new conversation)/i;
  function dsNewChatSPA() {
    showGreeting(); clearMessages();
    const cands = [...document.querySelectorAll('#root [aria-label],#root [title],#root button,#root [role="button"]')];
    for (const el of cands) {
      const lbl = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
      if (NEWCHAT_RE.test(lbl)) {
        (el.closest('button,[role="button"]') || el)
          .dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true, view:window }));
        return true;
      }
    }
    return false;
  }

  function toggleTemporary() {
    if (tempActive()) {
      // Exit incognito → delete the temp session, drop the bar/frame, fresh chat
      const sid = GM_getValue(TEMP_KEY) || currentSessionId();
      deleteSession(sid);
      GM_setValue(TEMP_KEY, '');
      GM_setValue(TEMP_KEY + '_on', false);
      applyTempClass();
      if (!dsNewChatSPA()) dsNewChat();
    } else {
      // Enter incognito → fresh chat + bar/frame. The temp session id is captured
      // once the first message creates it (see watchTempSession).
      GM_setValue(TEMP_KEY + '_on', true);
      GM_setValue(TEMP_KEY, '');
      applyTempClass();
      if (!dsNewChatSPA()) dsNewChat();
    }
  }

  // Record the session id as soon as a temporary chat creates one
  function watchTempSession() {
    setInterval(() => {
      if (!tempActive()) return;
      const sid = currentSessionId();
      if (sid && GM_getValue(TEMP_KEY) !== sid) GM_setValue(TEMP_KEY, sid);
    }, 800);
  }

  // On load: if a temporary session was left behind, delete it
  function cleanupTempOnLoad() {
    const sid = GM_getValue(TEMP_KEY);
    if (sid) { deleteSession(sid); GM_setValue(TEMP_KEY, ''); }
    GM_setValue(TEMP_KEY + '_on', false);
  }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  SYSTEM PROMPT PANEL                                            ║
  // ╚══════════════════════════════════════════════════════════════════╝

  let sysPanel = null, sysOpen = false;
  function toggleSysPrompt() { sysOpen ? closeSys() : openSys(); }
  function openSys() {
    if (sysOpen) return; sysOpen = true;
    sysEditTier = tier;
    const ta = E('textarea', { cls:'cl-sp-ta',
      placeholder:'Paste a role / system prompt for this model. It is wrapped as a persona directive and invisibly prepended to every message you send.',
      text: sysPrompts[sysEditTier] || '' });

    // Per-model tabs (Opus / Sonnet / Haiku)
    const tabs = ['opus','sonnet','haiku'].map(t => {
      const tab = E('button', { cls:'cl-sp-tab'+(t===sysEditTier?' cl-sp-tab--on':''), text: C.MODELS[t].label });
      tab.addEventListener('click', () => {
        sysPrompts[sysEditTier] = ta.value;          // save current before switching
        sysEditTier = t;
        ta.value = sysPrompts[t] || '';
        sysPanel.querySelectorAll('.cl-sp-tab').forEach(x => x.classList.remove('cl-sp-tab--on'));
        tab.classList.add('cl-sp-tab--on');
      });
      return tab;
    });

    const save = E('button', { cls:'cl-sp-save', text:'Save', onclick(){ sysPrompts[sysEditTier] = ta.value; saveSys(); closeSys(); } });
    const clear = E('button', { cls:'cl-sp-clear', text:'Clear', onclick(){ ta.value=''; } });
    sysPanel = E('div', { cls:'cl-sp' }, [
      E('div', { cls:'cl-cp-hd' }, [ E('span',{cls:'cl-cp-h',text:'System prompt'}), E('button',{cls:'cl-cp-x',html:'✕',onclick:closeSys}) ]),
      E('div', { cls:'cl-sp-hint', text:'A separate role prompt per model. Wrapped as a persona directive and prepended to each message (DeepSeek has no editable system role).' }),
      E('div', { cls:'cl-sp-tabs' }, tabs),
      ta,
      E('div', { cls:'cl-sp-row' }, [ clear, save ]),
    ]);
    document.body.appendChild(sysPanel);
    requestAnimationFrame(() => sysPanel.classList.add('cl-cp--open'));
    setTimeout(() => document.addEventListener('mousedown', outsideSys, true), 0);
  }
  // Ignore mousedown on the "System prompt" nav row itself — otherwise the
  // mousedown closed the panel and the row's click reopened it, so the row
  // could only ever open the panel, never toggle it shut.
  function outsideSys(e){ if (sysPanel && !sysPanel.contains(e.target) && !e.target.closest('#cl-sysrow')) closeSys(); }
  function closeSys() {
    if (!sysOpen) return; sysOpen = false;
    document.removeEventListener('mousedown', outsideSys, true);
    if (sysPanel) { sysPanel.classList.remove('cl-cp--open'); const p=sysPanel; sysPanel=null; setTimeout(()=>p.remove(),200); }
  }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  INIT                                                           ║
  // ╚══════════════════════════════════════════════════════════════════╝

  function waitBody() {
    return new Promise(r => {
      if (document.body) return r();
      const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); r(); } });
      mo.observe(document.documentElement, { childList:true, subtree:true });
    });
  }

  async function main() {
    await waitBody();

    // Title: reflect the CONVERSATION title (strip DeepSeek branding) like claude.ai,
    // e.g. "Minimax… - DeepSeek" → "Minimax… - Claude"; landing page → "Claude".
    function fixTitle() {
      // Incognito: claude.ai keeps the tab as "New chat - Claude" the whole time
      // (incognito chats are never titled/saved). Force it regardless of DeepSeek.
      if (tempActive()) { if (document.title !== 'New chat - Claude') document.title = 'New chat - Claude'; return; }
      const raw = document.title || '';
      if (/ - Claude$/.test(raw) && raw.trim() !== '- Claude' && raw.trim() !== 'New chat - Claude') return; // already ours
      const m = raw.match(/^(.*?)\s*[-–]\s*DeepSeek\b/);
      const want = (m && m[1].trim()) ? m[1].trim() + ' - Claude' : 'New chat - Claude';
      if (document.title !== want) document.title = want;
    }
    reTitle = fixTitle;
    fixTitle();
    new MutationObserver(fixTitle)
      .observe(document.querySelector('title') || document.head, { childList:true, subtree:true, characterData:true });

    // Favicon: the Claude clay sparkle (same mark as the in-app logo) on a
    // transparent background — matches claude.ai's tab icon. Remove DeepSeek's
    // icons + re-assert if DeepSeek re-adds them.
    const FAV = 'data:image/svg+xml,' + encodeURIComponent(
      I.sparkle(50, '#D97757').replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '));
    function setFavicon() {
      [...document.querySelectorAll('link[rel~="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"]')]
        .forEach(l => { if (l.dataset.cl !== '1') l.remove(); });
      let fav = document.querySelector('link[data-cl="1"]');
      if (!fav) { fav = document.createElement('link'); fav.rel = 'icon'; fav.type = 'image/svg+xml'; fav.dataset.cl = '1'; document.head.appendChild(fav); }
      if (fav.href !== FAV) fav.href = FAV;
    }
    setFavicon();
    let favQueued = false;
    new MutationObserver(() => { if (favQueued) return; favQueued = true; setTimeout(() => { favQueued = false; setFavicon(); }, 400); })
      .observe(document.head, { childList:true });

    const app = buildApp();
    document.body.appendChild(app);

    // Keyboard shortcuts — capture phase, so the composer's stopPropagation
    // can't swallow them (matches claude.ai): ⌘/Ctrl+K → search chats,
    // ⌘/Ctrl+Shift+O → new chat, Esc → dismiss any open popup/panel.
    document.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault(); toggleChats(); return;
      }
      if (mod && e.shiftKey && !e.altKey && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault(); dsNewChat(); return;
      }
      if (e.key === 'Escape') { closeMenu(); closePlusMenu(); closeHiMenu(); closeAccount(); closeSys(); }
    }, true);

    // ---- Light-mode overrides (skin follows DeepSeek's Settings → theme) ----
    GM_addStyle(`
      .cl-app.cl-light { background:#F8F8F6; color:#1A1A18; }
      .cl-light .cl-sb { background:#F8F8F6; border-right-color:rgba(0,0,0,.08); }
      .cl-light .cl-dock { background:#F8F8F6; }
      .cl-light .cl-dock::before { background:linear-gradient(transparent,#F8F8F6); }
      .cl-light .cl-row, .cl-light .cl-hi, .cl-light .cl-hi-t { color:#3A3A38; }
      .cl-light .cl-row:hover, .cl-light .cl-hi:hover, .cl-light .cl-ib:hover,
      .cl-light .cl-user:hover, .cl-light .cl-msb:hover { background:#EFEEE9; }
      .cl-light .cl-row .cl-ai, .cl-light .cl-ib { color:#6E6D66; }
      .cl-light .cl-row:hover .cl-ai { color:#1A1A18; }
      .cl-light .cl-row--accent .cl-ai { color:${D.brand}; }
      .cl-light .cl-greet-txt { color:#3A3A38; }
      .cl-light .cl-lbl, .cl-light .cl-user-name { color:#1A1A18; }
      .cl-light .cl-sec, .cl-light .cl-user-plan, .cl-light .cl-disc, .cl-light .cl-cp-empty { color:#8A8980; }
      .cl-light .cl-input { background:#FFFFFF; border-color:rgba(0,0,0,.1); box-shadow:0 2px 12px rgba(0,0,0,.06); }
      .cl-light .cl-ta { color:#1A1A18; }
      .cl-light .cl-ta::placeholder, .cl-light .cl-plus, .cl-light .cl-msb { color:#6E6D66; }
      .cl-light .cl-bub--a { color:#1A1A18; }
      .cl-light .cl-bub--u { background:#EFEEE9; color:#1A1A18; }
      .cl-light .cl-think-hd { color:#8A8980; }
      .cl-light .cl-think-body { color:#6E6D66; border-left-color:rgba(0,0,0,.14); }
      .cl-light .cl-menu, .cl-light .cl-sub, .cl-light .cl-himenu, .cl-light .cl-ap,
      .cl-light .cl-cp, .cl-light .cl-sp { background:#FFFFFF; border-color:rgba(0,0,0,.1); }
      .cl-light .cl-mi:hover, .cl-light .cl-er:hover { background:#F0EFEA; }
      .cl-light .cl-mi-n, .cl-light .cl-er, .cl-light .cl-cp-h, .cl-light .cl-ap-name,
      .cl-light .cl-th-n { color:#1A1A18; }
      .cl-light .cl-mi-d, .cl-light .cl-mi-rt, .cl-light .cl-er-tag, .cl-light .cl-mi-g,
      .cl-light .cl-th-d, .cl-light .cl-sub-hd { color:#8A8980; }
      .cl-light .cl-er-ck, .cl-light .cl-mi-ck { color:${D.brand}; }
      .cl-light .cl-tog { background:#D9D8D2; }
      .cl-light .cl-tog--on { background:${D.brand}; }
      .cl-light .cl-ap-ico, .cl-light .cl-ap-row { color:#6E6D66; }
      .cl-light .cl-ap-row:hover { background:#F0EFEA; color:#1A1A18; }
      .cl-light .cl-himenu .cl-ap-row:hover, .cl-light .cl-div { background:rgba(0,0,0,.08); }
      .cl-light .cl-bub pre, .cl-light .cl-bub :not(pre)>code { background:#F4F3EE; border-color:rgba(0,0,0,.08); }
      .cl-light .cl-cp-search, .cl-light .cl-sp-ta { background:#FFFFFF; color:#1A1A18; border-color:rgba(0,0,0,.12); }
      /* Suggestion pills (Code / Write / Learn) — were dark on light */
      .cl-light .cl-pill { background:#FFFFFF; border-color:rgba(0,0,0,.1); color:#3A3A38; box-shadow:0 1px 4px rgba(0,0,0,.05); }
      .cl-light .cl-pill:hover { background:#F4F3EE; }
      /* Model selector button + effort label */
      .cl-light .cl-msb { color:#3A3A38; }
      .cl-light .cl-msb-l { color:#1A1A18; }
      .cl-light .cl-msb-eff, .cl-light .cl-msb-cv { color:#8A8980; }
      /* Plus / attach / web-search toggles + their hover. NOTE: the send button
         keeps its brand hover (the old grey override made the white arrow
         invisible), and the Thinking toggle only greys when OFF (the old rule
         wiped its brand color on hover while ON). */
      .cl-light .cl-plus:hover,
      .cl-light .cl-tog:not(.cl-tog--on):hover, .cl-light .cl-act:hover, .cl-light .cl-ver-b:hover { background:#EFEEE9; }
      .cl-light .cl-send:disabled { background:#E6E5DF; color:#B3B2A9; }
      .cl-light .cl-act { color:#8A8980; }
      .cl-light .cl-act:hover { color:#1A1A18; }
      .cl-light .cl-ver-b { color:#8A8980; }
      .cl-light .cl-ver-t { color:#6E6D66; }
      /* Plus menu (Add files / Web search) container — was missing the light bg */
      .cl-light .cl-plusmenu { background:#FFFFFF; border-color:rgba(0,0,0,.1); }
      .cl-light .cl-plusmenu .cl-mi-n { color:#1A1A18; }
      .cl-light .cl-plusmenu .cl-mi-g { color:#6E6D66; }
      /* Markdown tables — dark text/rules on light */
      .cl-light .cl-bub thead th { color:#1A1A18; border-bottom-color:rgba(0,0,0,.18); }
      .cl-light .cl-bub tbody td { color:#3A3A38; border-bottom-color:rgba(0,0,0,.08); }
      /* Citation chips */
      .cl-light .cl-bub a.cl-cite, .cl-light .cl-bub a.cl-cite:visited {
        background:#F0EFEA; border-color:rgba(0,0,0,.12); color:#6E6D66 !important; }
      .cl-light .cl-bub a.cl-cite:hover { background:#E6E5DF; color:#1A1A18 !important; }
      /* Inline editor */
      .cl-light .cl-edit-ta { background:#FFFFFF; color:#1A1A18; }
      .cl-light .cl-edit-note { color:#8A8980; }
      .cl-light .cl-edit-btn { background:#EFEEE9; color:#1A1A18; }
      .cl-light .cl-edit-btn:hover { background:#E6E5DF; }
      .cl-light .cl-edit-btn--save { background:${D.brand}; color:#fff; }
      /* Attachment chips */
      .cl-light .cl-chip { background:#F4F3EE; border-color:rgba(0,0,0,.1); }
      .cl-light .cl-chip-t { color:#1A1A18; }
      .cl-light .cl-chip-x { color:#8A8980; }
      /* Claude wordmark top-left — was white (invisible) on the cream sidebar */
      .cl-light .cl-logo-wm { color:#1A1A18; }
      /* Chats search panel — list items were dark text on light */
      .cl-light .cl-cp-item, .cl-light .cl-cp-ttl { color:#3A3A38; }
      .cl-light .cl-cp-item:hover { background:#F0EFEA; color:#1A1A18; }
      .cl-light .cl-cp-ico { color:#8A8980; }
      .cl-light .cl-cp-x { color:#8A8980; }
      .cl-light .cl-cp-x:hover { background:#EFEEE9; color:#1A1A18; }
    `);

    // Apply theme (manual override > DeepSeek's class/attr > system), and keep in sync
    applyThemeClass();
    new MutationObserver(applyThemeClass).observe(document.body, { attributes:true, attributeFilter:['class','data-ds-dark-theme'] });
    try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyThemeClass); } catch(_) {}

    // Apply model selection to hidden DeepSeek once it's ready
    let tries = 0;
    const wait = setInterval(() => {
      if (document.querySelector('#root [data-model-type], #root textarea') || ++tries > 40) {
        clearInterval(wait);
        applyDSModel();
        // update greeting + user name + avatar initial now that DeepSeek loaded
        const nm = userName();
        const gt = document.querySelector('.cl-greet-txt');
        if (gt) gt.textContent = greetLine();
        const un = document.querySelector('.cl-user-name'); if (un) un.textContent = nm || 'You';
        const av = document.querySelector('.cl-user .cl-av'); if (av) av.textContent = (nm[0] || 'U').toUpperCase();
        refreshHistory();
      }
    }, 300);

    // Mirror DeepSeek messages — real-time via MutationObserver (smooth streaming),
    // plus a slow safety tick in case a mutation is missed.
    startMirrorObserver();
    startScrollLoader();
    scheduleMirror();
    setInterval(scheduleMirror, 1500);
    // Keep the sidebar Recents list in sync
    setInterval(refreshHistory, 2000);
    // Mirror upload attachment chips for visual feedback
    startAttachMirror();
    // Keep the greeting in step with the time of day (morning/afternoon/evening)
    setInterval(() => {
      const gt = document.querySelector('.cl-greet-txt');
      if (gt) { const want = greetLine(); if (gt.textContent !== want) gt.textContent = want; }
    }, 60000);

    // While a DeepSeek modal/popup (Settings/Download/Help + their nested theme/
    // language dropdowns) is open, lift it above our overlay so it's clickable.
    new MutationObserver(() => {
      const modal = document.querySelector('.ds-modal, [class*="ds-modal-content"]');
      const popup = [...document.querySelectorAll('.ds-floating-position-wrapper')]
        .some(w => w.childElementCount > 0 && w.offsetParent !== null);
      document.body.classList.toggle('cl-modal', !!(modal || popup));
    }).observe(document.body, { childList:true, subtree:true });

    // Temporary-chat: clean up any leftover temp session, then watch for new ids
    cleanupTempOnLoad();
    watchTempSession();

    console.log('%c[Claude→DS]%c v18.8.0 ready.', 'color:#D97757;font-weight:700', '');
  }

  main();
})();
