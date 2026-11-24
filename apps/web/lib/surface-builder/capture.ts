/**
 * Captures a prototype the way a person sees it: rendered, one view and tab at
 * a time, with a screenshot and the rendered markup of each.
 *
 * Many prototypes draw their screens with JavaScript, so their source holds no
 * tabs, tables or labels to read. The capture runs the prototype in a sandboxed
 * frame (scripts on, no shared origin, so it cannot reach the app or the
 * user's session), clicks through its navigation, and sends each state back by
 * message. Browser only.
 */

export interface CapturedView {
  /** The navigation path that reached this state, e.g. "Assign targets > Pacing" (joined with a guillemet). */
  label: string;
  /** The rendered body markup, with scripts, styles and drawing paths removed. */
  html: string;
  /** The visible text, for a quick read. */
  text: string;
  /** A JPEG screenshot as base64 (no data: prefix), when the frame could draw one. */
  image?: string;
}

export interface CaptureOptions {
  maxViews?: number;
  /** Width and height the prototype is laid out at. */
  width?: number;
  height?: number;
  /** Called as each view is captured, for progress. */
  onView?: (label: string, count: number) => void;
  timeoutMs?: number;
}

const MAX_VIEW_HTML = 60_000;
const MAX_VIEW_TEXT = 8_000;

/**
 * The script that runs inside the frame. It neutralises dialogs and links,
 * finds navigation (tabs and view switches), clicks through it two levels deep
 * and posts each state back. It never clicks anything that reads as a change
 * (delete, reset, save, export and the like).
 */
function driverSource(nonce: string, options: Required<Pick<CaptureOptions, 'maxViews'>>): string {
  return `(() => {
  const NONCE = ${JSON.stringify(nonce)};
  const MAX_VIEWS = ${options.maxViews};
  const MAX_HTML = ${MAX_VIEW_HTML};
  const MAX_TEXT = ${MAX_VIEW_TEXT};
  window.alert = () => {}; window.confirm = () => false; window.prompt = () => null; window.open = () => null; window.print = () => {};
  document.addEventListener('click', (event) => {
    const link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (link && !(link.getAttribute('href') || '').startsWith('#')) event.preventDefault();
  }, true);
  document.addEventListener('submit', (event) => event.preventDefault(), true);

  const RISKY = /\\b(delete|remove|reset|clear|undo|save|submit|commit|export|download|copy|print|sign ?out|log ?out|send|approve|apply|book|upload|import|add|new|create|edit)\\b/i;
  const ACTIVE = /(^|[\\s_-])(active|on|selected|current|is-active|is-selected)($|[\\s_-])/i;
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 250))));
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  // A tab often holds a name, a count and a subtitle; its label is the first
  // piece of text with a letter in it, so "Strategy 9 Category > ..." reads as "Strategy".
  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.replace(/\\s+/g, ' ').trim().slice(0, 48);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent.replace(/\\s+/g, ' ').trim();
      if (/[A-Za-z]/.test(text)) return text.slice(0, 48);
    }
    return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 48);
  };
  const keyOf = (label) => label.replace(/[\\d,.%$()]+/g, '').replace(/\\s+/g, ' ').trim().toLowerCase();

  // Navigation: tabs, and groups of sibling buttons where one is marked as the
  // current one (aria-pressed, aria-selected or an active class), near the top
  // of the page or labelled as a view.
  function navigation() {
    const out = [];
    const seen = new Set();
    const add = (el) => {
      if (!visible(el) || el.closest('[role=dialog],dialog,.modal')) return;
      const label = labelOf(el);
      const key = keyOf(label);
      if (!label || !key || label.length > 40 || RISKY.test(label) || seen.has(key)) return;
      seen.add(key);
      out.push({ key, label });
    };
    document.querySelectorAll('[role=tab]').forEach(add);
    const groups = new Set();
    document.querySelectorAll('button,[role=button],a').forEach((el) => {
      const marked = el.hasAttribute('aria-pressed') || el.hasAttribute('aria-selected') || ACTIVE.test(el.className || '');
      if (marked && el.parentElement) groups.add(el.parentElement);
    });
    groups.forEach((group) => {
      const items = [...group.children].filter((el) => el.matches('button,[role=button],a'));
      if (items.length < 2 || items.length > 12) return;
      // Only switches that move between screens: in the header or navigation, or labelled as a view.
      // A toggle that changes a setting (a basis, a unit) is left alone.
      const inChrome = Boolean(group.closest('header,nav,[role=navigation],[role=tablist]'));
      const named = /view|tab|mode|lens|section|page/i.test(group.getAttribute('aria-label') || group.className || '');
      if (inChrome || named) items.forEach(add);
    });
    return out;
  }

  function find(key) {
    const all = [...document.querySelectorAll('[role=tab],button,[role=button],a')];
    return all.find((el) => visible(el) && keyOf(labelOf(el)) === key) || null;
  }

  function cleaned() {
    const body = document.body.cloneNode(true);
    body.querySelectorAll('script,style,noscript,template,iframe').forEach((el) => el.remove());
    body.querySelectorAll('svg').forEach((svg) => {
      const texts = [...svg.querySelectorAll('text,title')].map((t) => t.textContent.trim()).filter(Boolean).slice(0, 40);
      svg.innerHTML = texts.map((t) => '<text>' + t.replace(/</g, '&lt;') + '</text>').join('');
    });
    body.querySelectorAll('*').forEach((el) => { el.removeAttribute('style'); });
    body.querySelectorAll('input,select,textarea').forEach((el) => {
      if (el.value !== undefined && el.value !== '') el.setAttribute('value', String(el.value).slice(0, 60));
    });
    return body.innerHTML.replace(/\\s{2,}/g, ' ').slice(0, MAX_HTML);
  }

  async function shot() {
    try {
      if (!window.htmlToImage) return undefined;
      const url = await window.htmlToImage.toJpeg(document.documentElement, {
        width: window.innerWidth, height: window.innerHeight, pixelRatio: 1, quality: 0.72,
        skipFonts: true, backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
      });
      return url.split(',')[1];
    } catch (error) {
      return undefined;
    }
  }

  async function run() {
    const views = [];
    const take = async (label) => {
      if (views.length >= MAX_VIEWS) return;
      await settle();
      views.push({ label, html: cleaned(), text: (document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, MAX_TEXT), image: await shot() });
      parent.postMessage({ type: 'sb-capture-progress', nonce: NONCE, label, count: views.length }, '*');
    };
    try {
      await take('Initial view');
      const top = navigation();
      const done = new Set(top.map((item) => item.key));
      for (const item of top) {
        if (views.length >= MAX_VIEWS) break;
        const el = find(item.key);
        if (!el) continue;
        el.click();
        await take(item.label);
        // Navigation that appeared under this one: its tabs.
        for (const sub of navigation().filter((s) => !done.has(s.key))) {
          if (views.length >= MAX_VIEWS) break;
          const subEl = find(sub.key);
          if (!subEl) continue;
          subEl.click();
          await take(item.label + ' \\u203a ' + sub.label);
          done.add(sub.key);
        }
      }
    } catch (error) {
      parent.postMessage({ type: 'sb-capture-note', nonce: NONCE, note: String(error && error.message || error).slice(0, 200) }, '*');
    }
    parent.postMessage({ type: 'sb-capture-done', nonce: NONCE, views }, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source === parent && event.data && event.data.type === 'sb-capture-start' && event.data.nonce === NONCE) setTimeout(run, 600);
  });
})();`;
}

/** The prototype with the capture library and driver placed before its own scripts. */
export function captureDocument(html: string, nonce: string, library: string, maxViews: number): string {
  const inject = `<script>${library.replace(/<\/script/gi, '<\\/script')}</script><script>${driverSource(nonce, { maxViews })}</script>`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (tag) => `${tag}${inject}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (tag) => `${tag}<head>${inject}</head>`);
  return `${inject}${html}`;
}

let libraryCache: Promise<string> | null = null;

/** The screenshot library's source, served by the app so the frame can run it inline. */
function captureLibrary(): Promise<string> {
  if (!libraryCache) {
    libraryCache = fetch('/api/surface-builder/capture-lib')
      .then((res) => (res.ok ? res.text() : ''))
      .catch(() => '');
  }
  return libraryCache;
}

/**
 * Run the capture in the given frame and resolve with every state it reached.
 * The frame must be laid out on screen (it can be scaled down), or the browser
 * may pause it.
 */
export async function captureViews(frame: HTMLIFrameElement, html: string, options: CaptureOptions = {}): Promise<{ views: CapturedView[]; notes: string[] }> {
  const maxViews = Math.min(Math.max(options.maxViews ?? 20, 1), 24);
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const library = await captureLibrary();
  const notes: string[] = library ? [] : ['The screenshot library could not be loaded; views were captured as markup only.'];

  return new Promise((resolve) => {
    let finished = false;
    const finish = (views: CapturedView[]) => {
      if (finished) return;
      finished = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve({ views, notes });
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const data = event.data as { type?: string; nonce?: string; label?: string; count?: number; note?: string; views?: CapturedView[] };
      if (!data || data.nonce !== nonce) return;
      if (data.type === 'sb-capture-progress') {
        options.onView?.(data.label || '', data.count || 0);
      } else if (data.type === 'sb-capture-note' && data.note) {
        notes.push(`The capture stopped early: ${data.note}`);
      } else if (data.type === 'sb-capture-done') {
        finish(sanitize(data.views));
      }
    };
    const timer = setTimeout(() => {
      notes.push('The capture timed out; the views reached so far were not returned.');
      finish([]);
    }, options.timeoutMs ?? 90_000);
    window.addEventListener('message', onMessage);
    frame.onload = () => frame.contentWindow?.postMessage({ type: 'sb-capture-start', nonce }, '*');
    frame.srcdoc = captureDocument(html, nonce, library, maxViews);
  });
}

/** Keep only well-formed views; the frame runs untrusted code, so its reply is checked. */
function sanitize(raw: unknown): CapturedView[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 24).map((item) => {
    const row = (item || {}) as Record<string, unknown>;
    const image = typeof row.image === 'string' && /^[A-Za-z0-9+/=]+$/.test(row.image.slice(0, 200)) && row.image.length < 2_000_000 ? row.image : undefined;
    return {
      label: typeof row.label === 'string' ? row.label.slice(0, 120) : 'View',
      html: typeof row.html === 'string' ? row.html.slice(0, MAX_VIEW_HTML) : '',
      text: typeof row.text === 'string' ? row.text.slice(0, MAX_VIEW_TEXT) : '',
      image,
    };
  }).filter((view) => view.html || view.text);
}
