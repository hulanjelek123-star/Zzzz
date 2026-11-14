'use strict';

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HLS_PROXY_TTL_MS = 36 * 60 * 60 * 1000;
const HLS_PROXY_SECRET = process.env.HLS_PROXY_SECRET || crypto.randomBytes(32).toString('hex');
const HLS_TLS_AGENT = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const TYPE = 'hentai';
const UA = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const CATALOG_TTL = Number(process.env.CACHE_CATALOG_SECONDS || 600) * 1000;
const DETAIL_TTL = Number(process.env.CACHE_DETAIL_SECONDS || 1800) * 1000;
const STREAM_TTL = Number(process.env.CACHE_STREAM_SECONDS || 180) * 1000;
const FRESH_STREAM_TTL = Number(process.env.CACHE_STREAM_SECONDS || 25) * 1000;
const PAGE_SIZE = 20;
const PAGE_LIMIT = 100;
const MINOR_TERMS = /\b(loli(?:con)?|shota(?:con)?|underage|child porn|young girl|young boy)\b/i;
const HENTAIGASM_TAGS = ['3D','Anal','Blowjob','Bondage','Boobjob','Cheating','Creampie','Demon','Exclusive','Exhibition','Fantasy','Footjob','Futanari','Gangbang','Harem','Incest','Maid','Masturbation','Monster','Motion Anime','Nurse','Preview','Rape','School','Season','Series','Sex Toy','Swimsuit','Tentacle','Uncensored','Vanilla','Virgin','X-Ray','Yuri'];
const GENRES = HENTAIGASM_TAGS;
const PROVIDER_GENRES = {
  hentaigasm: HENTAIGASM_TAGS,
  hentaimama: ['Ahegao','Anal','Brainwashed','Creampie','Dark Skin','DeepThroat','Domination','Femdom','Harem','Horny Slut','Humiliation','Internal Cumshot','Large Breasts','Mind Break','Pregnant','Rape','Squirting','X-Ray','3D','Uncensored'],
};

const http = axios.create({
  timeout: Number(process.env.HTTP_TIMEOUT_MS || 15000),
  maxRedirects: 5,
  headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  validateStatus: status => status >= 200 && status < 400,
});

const cache = new Map();
async function cached(key, ttl, fn) {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.value;
  const value = await fn();
  cache.set(key, { value, expires: Date.now() + ttl });
  if (cache.size > 1500) {
    for (const [k, v] of cache) if (v.expires <= Date.now()) cache.delete(k);
    while (cache.size > 1500) cache.delete(cache.keys().next().value);
  }
  return value;
}

const clean = v => String(v || '').replace(/\s+/g, ' ').trim();
const stripHtml = v => clean(String(v || '').replace(/<[^>]*>/g, ' '));
const slugify = v => clean(v).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const encodeKey = v => Buffer.from(String(v), 'utf8').toString('base64url');
const decodeKey = v => Buffer.from(String(v), 'base64url').toString('utf8');

function canonicalHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}
function sameProviderHost(url, base) {
  try {
    const a = new URL(url);
    const b = new URL(base);
    return canonicalHost(a.hostname) === canonicalHost(b.hostname);
  } catch { return false; }
}
function absUrl(value, base) {
  try {
    if (!value) return '';
    const u = new URL(String(value).replace(/&amp;/g, '&'), base);
    return ['http:', 'https:'].includes(u.protocol) ? u.href : '';
  } catch { return ''; }
}
function canonicalContentUrl(providerId, value, base) {
  const resolved = absUrl(value, base);
  if (!resolved) return '';
  try {
    const u = new URL(resolved);
    u.hash = '';
    // Normalize www/non-www aliases into a single catalog ID per provider.
    if (base && providerId !== 'hentaigasm') {
      try { const b = new URL(base); if (canonicalHost(u.hostname) === canonicalHost(b.hostname)) u.hostname = b.hostname; } catch {}
    }
    if (providerId === 'hentaimama') u.search = '';
    u.pathname = u.pathname.replace(/\/{2,}/g, '/');
    if (!/\.[a-z0-9]{2,5}$/i.test(u.pathname) && u.pathname !== '/') u.pathname = `${u.pathname.replace(/\/+$/, '')}/`;
    return u.href;
  } catch { return resolved; }
}
function normalizedTextKey(value) {
  return clean(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function titleFromUrl(value, providerId) {
  try {
    const u = new URL(value);
    let parts = u.pathname.split('/').filter(Boolean);
    let slug = parts[parts.length - 1] || '';
    slug = slug.replace(/\.(?:html?|php)$/i, '');
    if (providerId === 'hentaimama') slug = slug.replace(/-episode-?\d+.*$/i, '');
    slug = decodeURIComponent(slug).replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
    return slug ? slug.replace(/\b\w/g, c => c.toUpperCase()) : '';
  } catch { return ''; }
}
function cleanVideoTitle(value) {
  return clean(value)
    .replace(/^(?:HD\s*)?\d{1,2}:\d{2}(?::\d{2})?\s*/i, '')
    .replace(/\b\d+(?:[.,]\d+)?\s*[kKmM]?\s*views?\b/gi, '')
    .replace(/\b\d{1,3}%(?=\s|$)/g, '')
    .replace(/^[\s|·•–—-]+|[\s|·•–—-]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function titleFromEpisodeUrl(value) {
  try {
    const u = new URL(value);
    let slug = u.pathname.split('/').filter(Boolean).pop() || '';
    slug = slug.replace(/\.(?:html?|php)$/i, '');
    try { slug = decodeURIComponent(slug); } catch {}
    return clean(slug.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ')).replace(/\b\w/g, c => c.toUpperCase());
  } catch { return ''; }
}

function blocked(item) {
  return MINOR_TERMS.test([item.name, item.description, ...(item.genres || [])].join(' '));
}
function isNoise(url) {
  return /\.(?:jpe?g|png|gif|webp|svg|css|js|ico|woff2?)(?:[?#]|$)|wp-json|wp-content|gravatar|schema\.org/i.test(url || '');
}
async function getHtml(url, referer, timeout = undefined) {
  const requestTimeout = Number(timeout || process.env.HTTP_TIMEOUT_MS || 15000);
  return cached(`html:${url}|ref:${referer || ''}|timeout:${requestTimeout}`, CATALOG_TTL, async () => {
    const response = await http.get(url, { headers: referer ? { Referer: referer } : {}, responseType: 'text', timeout: requestTimeout });
    return String(response.data || '');
  });
}
async function getHtmlFresh(url, referer, extraHeaders = {}, timeout = undefined) {
  const headers = { ...extraHeaders };
  if (referer) headers.Referer = referer;
  const response = await http.get(url, { headers, responseType: 'text', timeout: Number(timeout || process.env.HTTP_TIMEOUT_MS || 15000) });
  return String(response.data || '');
}
function metaText($, selectors) {
  for (const selector of selectors) {
    const n = $(selector).first();
    const value = clean(n.attr('content') || n.text());
    if (value) return value;
  }
  return '';
}
function cardPoster($, $card, $a, base) {
  const isMama = canonicalHost(new URL(base).hostname) === 'hentaimama.io';
  const candidates = [];
  const images = $card.find('img').toArray();
  if (!$card.find('img').length) images.push(...$a.find('img').toArray());
  for (const image of images.slice(0, 4)) {
    const $img = $(image);
    if (isMama) {
      const responsive = [];
      for (const key of ['data-srcset', 'srcset', 'data-lazy-srcset']) {
        const value = $img.attr(key);
        if (!value) continue;
        for (const part of value.split(',')) {
          const bits = clean(part).split(/\s+/);
          const url = bits[0];
          const descriptor = bits[1] || '';
          const width = descriptor.endsWith('w') ? Number.parseInt(descriptor, 10) :
            descriptor.endsWith('x') ? Number.parseFloat(descriptor) * 400 : 0;
          if (url) responsive.push({ url, width });
        }
      }
      responsive.sort((a, b) => {
        const rank = item => item.width >= 280 && item.width <= 720 ? 0 : item.width > 720 ? 1 : 2;
        const aRank = rank(a), bRank = rank(b);
        if (aRank !== bRank) return aRank - bRank;
        if (aRank === 0) return Math.abs(a.width - 480) - Math.abs(b.width - 480);
        return aRank === 1 ? a.width - b.width : b.width - a.width;
      });
      candidates.push(...responsive.map(item => item.url));
    }
    for (const key of [
      'data-src', 'data-lazy-src', 'data-original', 'data-original-src', 'data-lazy',
      'data-image', 'data-cfsrc', 'data-thumb', 'data-poster', 'data-cover',
      'data-orig-file', 'data-lazyload', 'data-src-url', 'data-bg', 'data-background',
      'poster', 'src',
    ]) {
      const value = $img.attr(key);
      if (value) candidates.push(value);
    }
    if (!isMama) {
      for (const key of ['data-srcset', 'data-lazy-srcset', 'srcset']) {
        const value = $img.attr(key);
        if (value) candidates.push(...value.split(',').map(part => clean(part).split(/\s+/)[0]).filter(Boolean));
      }
    }
  }
  const mediaNodes = [$card, $a, ...$card.find('[data-bg],[data-background],[data-image],[data-thumb],[data-poster],[data-src]').toArray().map(el => $(el))];
  for (const $node of mediaNodes) {
    for (const key of ['data-poster', 'data-thumb', 'data-image', 'data-background', 'data-bg', 'data-src']) {
      const value = $node.attr(key);
      if (value) candidates.push(value);
    }
    const style = $node.attr('style') || '';
    const match = style.match(/background(?:-image)?\s*:\s*[^;]*?url\(["']?([^"')]+)["']?\)/i);
    if (match) candidates.push(match[1]);
  }
  $card.find('source[srcset], source[src], video[poster]').each((_, el) => {
    const $source = $(el);
    for (const key of ['data-src', 'src', 'poster']) {
      const value = $source.attr(key);
      if (value) candidates.push(value);
    }
    if ($source.attr('srcset')) candidates.push(...$source.attr('srcset').split(',').map(part => clean(part).split(/\s+/)[0]).filter(Boolean));
  });
  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = absUrl(candidate, base);
    if (!resolved || seen.has(resolved) || /^data:/i.test(resolved) || /(?:placeholder|spacer|blank|loading|transparent|pixel|no[-_]?image|no[-_]?thumbnail|default[-_]?image|avatar|logo)(?:[-_.][^/?#]*)?\.(?:gif|png|jpe?g|webp)(?:[?#]|$)/i.test(resolved)) continue;
    seen.add(resolved);
    return resolved;
  }
  return '';
}
function parseStructuredCards($, base) {
  const out = [];
  const seen = new Set();
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try { data = JSON.parse($(el).contents().text() || $(el).text()); } catch { return; }
    const walk = value => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(walk); return; }
      const type = Array.isArray(value['@type']) ? value['@type'].join(' ') : String(value['@type'] || '');
      if (/VideoObject|Movie|TVEpisode|CreativeWork/i.test(type)) {
        const rawUrl = value.url || value['@id'] || value.embedUrl;
        const key = absUrl(typeof rawUrl === 'object' ? (rawUrl.url || rawUrl['@id']) : rawUrl, base);
        const imageValue = Array.isArray(value.image) ? value.image[0] : (value.image || value.thumbnailUrl || value.thumbnail || value.poster);
        const poster = absUrl(typeof imageValue === 'object' ? (imageValue.url || imageValue.contentUrl || imageValue['@id']) : imageValue, base);
        const name = clean(value.name || value.headline);
        const item = { key, name, poster, genres: Array.isArray(value.genre) ? value.genre.map(clean) : value.genre ? [clean(value.genre)] : [], description: clean(value.description) };
        if (key && name && poster && !seen.has(key) && !blocked(item) && !isNoise(key)) {
          try {
            if (sameProviderHost(key, base)) {
              seen.add(key); out.push(item);
            }
          } catch {}
        }
      }
      for (const [key, child] of Object.entries(value)) if (key !== '@context') walk(child);
    };
    walk(data);
  });
  return out;
}

function parseCards(html, base) {
  const $ = cheerio.load(html);
  const out = parseStructuredCards($, base);
  const seen = new Set(out.map(item => item.key));
  const selectors = ['article a[href]', '.video-item a[href]', '.video-card a[href]', '[class*="video-card"] a[href]', '[class*="video-item"] a[href]', '.movie-item a[href]', '[class*="movie-item"] a[href]', '.video a[href]', '.item a[href]', '.thumb a[href]', '.thumb-block a[href]', '.post a[href]', '.result-item a[href]', '.animposx a[href]', '.bs a[href]', '.entry a[href]', '.grid-item a[href]', '.movie a[href]', 'li a[href]', 'a[href]'];
  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const $a = $(el);
      const href = absUrl($a.attr('href'), base);
      if (!href || seen.has(href) || isNoise(href)) return;
      let parsed;
      try { parsed = new URL(href); } catch { return; }
      if (!sameProviderHost(href, base)) return;
      if (/\/(?:page|genre|genres|category|tag|author|search|login|register|contact|about)(?:\/|$)/i.test(parsed.pathname)) return;
      const $closest = $a.closest('article,.video-item,.video-card,[class*=\"video-card\"],[class*=\"video-item\"],.movie-item,[class*=\"movie-item\"],.video,.item,.thumb,.thumb-block,.post,.result-item,.animposx,.bs,.entry,.grid-item,.movie,li');
      const $tight = tightCard($, $a, base);
      const hasMedia = $node => Boolean($node && $node.length && $node.find('img,source[src],video[poster],[data-poster],[data-thumb],[data-bg],[style*=\"background-image\"]').length);
      const $card = hasMedia($tight) ? $tight : (hasMedia($closest) ? $closest : ($tight.length ? $tight : $a));
      let poster = cardPoster($, $card, $a, base);
      if (!poster && $closest.length && $closest[0] !== $card[0]) poster = cardPoster($, $closest, $a, base);
      if (!poster) return;
      const name = clean($card.find('.title,.tt,.entry-title,.video-title,.name,h2,h3,h4,[class*=\"title\"]').first().text()) || clean($a.attr('title')) || clean($a.attr('aria-label')) || clean($a.find('img').first().attr('alt')) || clean($a.text()) || clean($card.find('a[title],a[aria-label]').first().attr('title') || $card.find('a[aria-label]').first().attr('aria-label'));
      if (!name || name.length < 2 || /^(watch|play|view|more|next|previous)$/i.test(name)) return;
      const genres = $card.find('.genre a,.genres a,.sgeneros a,a[rel="tag"],.tags a,a[href*="/genre/"],a[href*="/tag/"]').map((__, tag) => clean($(tag).text())).get().filter(Boolean).slice(0, 16);
      const description = clean($card.find('.description,.excerpt,.summary').first().text());
      const item = { key: href, name, poster, genres, description };
      if (blocked(item)) return;
      seen.add(href);
      out.push(item);
    });
    if (out.length >= PAGE_LIMIT) break;
  }
  return out;
}
function pagePath(base, path, page) {
  const root = base.replace(/\/$/, '');
  const p = path || '/';
  if (page <= 1) return `${root}${p.startsWith('/') ? p : `/${p}`}`;
  const route = `${root}${p.startsWith('/') ? p : `/${p}`}`;
  if (/\.html?$/i.test(route)) return route.replace(/\.html?$/i, '') + `-${page}.html`;
  return `${route}${p.endsWith('/') ? '' : '/'}page/${page}/`;
}
function genreSlug(config, genre) {
  const raw = clean(genre).toLowerCase();
  const aliases = {
    'big breasts': 'large-breasts', 'dark skin': 'dark-skin', 'monster': 'monsters',
    'deep throat': 'deepthroat', 'internal cumshot': 'internal-cumshot',
    'netorare': 'ntr', 'office lady': 'office-ladies', 'school': 'school-girls',
    'tentacle': 'tentacles', 'threesome': 'three-some', 'virgin': 'virgins',
    'succubus': 'succubus', 'maid': 'maid', 'sci-fi': 'sci-fi',
  };
  return config.id === 'hentaimama' ? (aliases[raw] || slugify(genre)) : slugify(genre);
}

function candidatePagesEnhanced(config, { search, genre, page = 1 }) {
  const base = config.base.replace(/\/$/, '');
  const n = Math.max(1, Number(page) || 1);
  const q = encodeURIComponent(clean(search));
  const g = genreSlug(config, genre);



  if (search) {
    return [...new Set([
      `${base}/?s=${q}${n > 1 ? `&paged=${n}` : ''}`,
      `${base}/?search=${q}${n > 1 ? `&page=${n}` : ''}`,
      `${base}/search/${q.replace(/%20/g, '+')}/${n > 1 ? `page/${n}/` : ''}`,
      ...(config.searchPaths || []).map(path => `${base}${path.replace('{q}', q).replace('{page}', n)}`),
    ])];
  }
  if (genre) {
    // HentaiMama's 3D archive is /genre/3d/, not /3d/. Uncensored is a top-level archive.
    const paths = config.id === 'hentaimama' && g === 'uncensored'
      ? ['/uncensored/']
      : (config.genrePaths || ['/genre/{g}/', '/tag/{g}/', '/category/{g}/']);
    return [...new Set(paths.flatMap(path => {
      const route = `${base}${path.replace('{g}', g)}`;
      if (n === 1) return [route];
      if (/\.html?$/i.test(route)) return [route.replace(/\.html?$/i, '') + `-${n}.html`, `${route}?page=${n}`];
      return [pagePath(base, path.replace('{g}', g), n), `${route}?page=${n}`, `${route}?paged=${n}`];
    }))];
  }
  return [...new Set((config.listPaths || ['/']).flatMap(path => {
    const route = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    if (n === 1) return [route];
    if (/\.html?$/i.test(route)) return [route.replace(/\.html?$/i, '') + `-${n}.html`, `${route}?page=${n}`, `${route}?paged=${n}`];
    return [pagePath(base, path, n), `${route}?page=${n}`, `${route}?paged=${n}`];
  }))];
}
function candidatePagesLegacy(config, { search, genre, page }) {
  const base = config.base.replace(/\/$/, '');
  if (search) {
    const q = encodeURIComponent(search);
    return [...new Set([
      `${base}/?s=${q}${page > 1 ? `&paged=${page}` : ''}`,
      `${base}/?search=${q}${page > 1 ? `&page=${page}` : ''}`,
      `${base}/search/${q.replace(/%20/g, '+')}/${page > 1 ? `page/${page}/` : ''}`,
      ...(config.searchPaths || []).map(path => `${base}${path.replace('{q}', q).replace('{page}', page)}`),
    ])];
  }
  if (genre) {
    const g = slugify(genre);
    return [...new Set((config.genrePaths || ['/genre/{g}/', '/tag/{g}/', '/category/{g}/']).flatMap(path => {
      const route = `${base}${path.replace('{g}', g)}`;
      return page > 1 ? [pagePath(base, path.replace('{g}', g), page), `${route}${route.includes('?') ? '&' : '?'}page=${page}`, `${route}${route.includes('?') ? '&' : '?'}paged=${page}`] : [route];
    }))];
  }
  return [...new Set((config.listPaths || ['/']).flatMap(path => {
    const route = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    if (page <= 1) return [route];
    const queryPath = `${route}${route.includes('?') ? '&' : '?'}page=${page}`;
    const pagedPath = `${route}${route.includes('?') ? '&' : '?'}paged=${page}`;
    return [pagePath(base, path, page), queryPath, pagedPath];
  }))];
}
function candidatePages(config, args) {
  if (config.id === 'hentaigasm') return candidatePagesLegacy(config, args);
  return candidatePagesEnhanced(config, args);
}

function tightCard($, $a, base) {
  const itemLinks = 'a[href]';
  let node = $a.parent();
  for (let depth = 0; depth < 6 && node.length; depth++, node = node.parent()) {
    const hasPoster = node.find('img[src],img[data-src],img[data-original],img[data-lazy-src],img[data-lazy-srcset],img[data-srcset],img[srcset],[data-poster],[data-thumb],[data-bg],[style*="background-image"]').length > 0;
    const count = node.find(itemLinks).length;
    const classes = `${node.attr('class') || ''} ${node.attr('id') || ''}`;
    const looksLikeItem = /(?:^|[\s_-])(?:video-item|video-card|video-thumb|thumb-block|thumb|movie-item|item|post|entry|bs|bsx|card)(?:$|[\s_-])/i.test(classes) || node.is('article,li');
    if (hasPoster && count > 0 && count <= 3 && (looksLikeItem || depth >= 1)) return node;
  }
  return $a.parent().length ? $a.parent() : $a;
}
function parseHentaiMamaGenreCards(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  const seenKeys = new Set();
  const seenTitles = new Set();
  $('a[href]').each((_, el) => {
    const $a = $(el);
    const raw = absUrl($a.attr('href'), base);
    if (!raw || !sameProviderHost(raw, base)) return;
    let parsed;
    try { parsed = new URL(raw); } catch { return; }
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    if (path === '/' || /^\/(?:episodes?|genre|genres|tag|category|recent-episodes|list|uncensored|login|register|wp-admin|wp-content|wp-json)(?:\/|$)/i.test(path)) return;
    const key = canonicalContentUrl('hentaimama', raw, base);
    if (!key || seenKeys.has(key)) return;
    const $card = $a.closest('article,.bs,.bsx,.item,.video-item,.video-card,.thumb,.thumb-block,.post,[class*="item"],[class*="series"],li');
    const $tight = tightCard($, $a, base);
    const hasMedia = $node => Boolean($node && $node.length && $node.find('img,source[src],video[poster],[data-poster],[data-thumb],[data-bg],[style*="background-image"]').length);
    const $box = hasMedia($tight) ? $tight : (hasMedia($card) ? $card : ($tight.length ? $tight : $a));
    let poster = cardPoster($, $box, $a, base);
    if (!poster && $card.length && $card[0] !== $box[0]) poster = cardPoster($, $card, $a, base);
    if (!poster) return;
    const candidates = [
      clean($box.find('.tt,.title,.entry-title,.name,h2,h3,h4,[class*="title"]').first().text()),
      clean($a.attr('title') || $a.attr('aria-label')),
      clean($a.find('img').first().attr('alt')),
      clean($a.text()),
      titleFromUrl(key, 'hentaimama'),
    ];
    let name = candidates.find(v => v && v.length > 2 && !/^(image|thumbnail|watch|play|view)$/i.test(v)) || '';
    name = clean(name.replace(/\s+(?:episode|ep)\s*#?\d+.*$/i, ''));
    const titleKey = normalizedTextKey(name);
    const posterKey = String(poster).split('?')[0].replace(/^https?:\/\/(?:www\.)?/i, '').toLowerCase();
    const dedupe = `${titleKey}|${posterKey}`;
    if (!name || blocked({ name }) || seenTitles.has(dedupe)) return;
    seenKeys.add(key); seenTitles.add(dedupe);
    out.push({ key, name, poster, genres: [...new Set($box.find('.genre a,.genres a,.tags a,a[rel="tag"]').map((__, tag) => clean($(tag).text())).get().filter(Boolean))].slice(0, 16), description: clean($box.find('.description,.excerpt,.summary').first().text()) });
    if (out.length >= PAGE_LIMIT) return false;
  });
  return out;
}
function parseHentaiMamaRecentEpisodeCards(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a[href*="/episodes/"]').each((_, el) => {
    const $a = $(el);
    const raw = absUrl($a.attr('href'), base);
    if (!raw || !sameProviderHost(raw, base)) return;
    let parsed; try { parsed = new URL(raw); } catch { return; }
    if (!/^\/episodes\/[^/]+\/?$/i.test(parsed.pathname)) return;
    const key = canonicalContentUrl('hentaimama', raw, base);
    if (!key || seen.has(key)) return;
    const $card = $a.closest('article,.bs,.bsx,.item,.video-item,.video-card,.thumb,.thumb-block,.post,[class*="item"],li');
    const $tight = tightCard($, $a, base);
    const hasMedia = $node => Boolean($node && $node.length && $node.find('img,source[src],video[poster],[data-poster],[data-thumb],[data-bg],[style*="background-image"]').length);
    const $box = hasMedia($tight) ? $tight : (hasMedia($card) ? $card : ($tight.length ? $tight : $a));
    let poster = cardPoster($, $box, $a, base);
    if (!poster && $card.length && $card[0] !== $box[0]) poster = cardPoster($, $card, $a, base);
    if (!poster) return;
    const urlTitle = titleFromEpisodeUrl(key);
    const candidates = [
      clean($a.attr('title') || $a.attr('aria-label')),
      clean($a.text()),
      clean($box.find('img').first().attr('alt')),
      clean($box.find('.episode-title,.tt,.title,.entry-title,.name,h2,h3,h4,[class*="title"]').first().text()),
      urlTitle,
    ].map(cleanVideoTitle).filter(v => v && v.length > 2 && !/^(image|thumbnail|watch|play|view)$/i.test(v));
    const name = candidates.find(v => /\b(?:episode|ep)\s*#?\d+\b/i.test(v)) || urlTitle || candidates[0] || '';
    if (!name || blocked({ name })) return;
    seen.add(key);
    out.push({ key, name, poster, genres: [], description: clean($box.find('.description,.excerpt,.summary').first().text()) });
    if (out.length >= PAGE_LIMIT) return false;
  });
  return out;
}

function parseProviderCards(config, html, base) {
  if (config.id === 'hentaigasm') return parseCards(html, base);
  if (config.id === 'hentaimama') {
    const path = new URL(base).pathname;
    if (/\/genre\//i.test(path) || /^\/uncensored\/?$/i.test(path)) {
      const specialised = parseHentaiMamaGenreCards(html, base);
      const generic = parseCards(html, base).map(item => ({ ...item, key: canonicalContentUrl(config.id, item.key, base) || item.key }));
      const merged = new Map();
      for (const item of [...specialised, ...generic]) if (item.key && item.poster && !merged.has(item.key)) {
        merged.set(item.key, { ...item, poster: proxyHentaiMamaPoster(item.poster, base) });
      }
      return [...merged.values()];
    }
    if (/\/recent-episodes(?:\/|$)/i.test(path)) {
      const specialised = parseHentaiMamaRecentEpisodeCards(html, base);
      const generic = parseCards(html, base).map(item => ({ ...item, key: canonicalContentUrl(config.id, item.key, base) || item.key }));
      const merged = new Map();
      for (const item of [...specialised, ...generic]) if (item.key && item.poster && !merged.has(item.key)) {
        merged.set(item.key, { ...item, poster: proxyHentaiMamaPoster(item.poster, base) });
      }
      return [...merged.values()];
    }
  }
  return parseCards(html, base).map(item => ({
    ...item,
    key: canonicalContentUrl(config.id, item.key, base) || item.key,
    ...(config.id === 'hentaimama' && item.poster ? { poster: proxyHentaiMamaPoster(item.poster, base) } : {}),
  }));
}

function catalogPageFingerprint(items) {
  return (items || []).map(item => `${normalizedTextKey(item.name)}|${String(item.poster || '').split('?')[0].replace(/^https?:\/\/(?:www\.)?/i, '').toLowerCase()}`).sort().join('\n');
}
function discoverPaginationUrls(html, base, targetPage, providerId) {
  const $ = cheerio.load(html);
  const candidates = [];
  const target = String(targetPage);
  $('a[href], link[rel="next"]').each((_, el) => {
    const $a = $(el);
    const raw = absUrl($a.attr('href'), base);
    if (!raw || !sameProviderHost(raw, base) || raw.split('#')[0] === String(base).split('#')[0]) return;
    let url;
    try { url = new URL(raw); } catch { return; }
    const text = clean($a.text());
    const aria = clean($a.attr('aria-label') || $a.attr('title') || '');
    const isNumericTarget = text === target || new RegExp(`^page\\s*${target}$`, 'i').test(aria) || new RegExp(`^${target}\\s*(?:of|/)\\s*\\d+$`, 'i').test(text);
    const isNextLink = /^(?:next|next page|›|»|→)$/i.test(text) || /next/i.test(aria) || String($a.attr('rel') || '').toLowerCase() === 'next';
    if (!isNumericTarget && !(isNextLink && targetPage === 2)) return;
    const path = url.pathname.toLowerCase();
    if (providerId === 'hentaimama' && /\/episodes\//i.test(path)) return;
    if (/\/(?:login|register|sign-up|wp-admin|wp-json)\//i.test(path)) return;
    const parents = $a.parents().toArray().slice(0, 5).map(node => `${node.attribs?.class || ''} ${node.attribs?.id || ''}`).join(' ');
    const score = (isNumericTarget ? 10 : 0) + (/pagination|pager|page-nav|pages-list|nav-links/i.test(`${parents} ${$a.attr('class') || ''}`) ? 5 : 0);
    candidates.push({ url: url.href, score });
  });
  const seen = new Set();
  return candidates.sort((a, b) => b.score - a.score).map(x => x.url).filter(url => !seen.has(url) && seen.add(url));
}
async function fetchCatalog(config, args) {
  let lastError;
  let reachedPage = false;
  const tried = [];
  let firstPageFingerprint = '';
  if ((Number(args.page) || 1) > 1) {
    const firstPageUrl = candidatePages(config, { ...args, page: 1 })[0];
    try { firstPageFingerprint = catalogPageFingerprint(parseProviderCards(config, await getHtml(firstPageUrl, config.base, config.timeout), firstPageUrl)); } catch { /* First page may have become unavailable. */ }
  }
  const seenOnPage = new Set();
  let candidates = candidatePages(config, args);
  const requestedPage = Math.max(1, Number(args.page) || 1);
  if (requestedPage > 1) {
    const firstPageCandidates = candidatePages(config, { ...args, page: 1 });
    for (const firstUrl of firstPageCandidates.slice(0, 3)) {
      try {
        const firstHtml = await getHtml(firstUrl, config.base, config.timeout);
        const discovered = discoverPaginationUrls(firstHtml, firstUrl, requestedPage, config.id);
        if (discovered.length) {
          candidates = [...discovered, ...candidates].filter((url, index, all) => all.indexOf(url) === index);
          break;
        }
      } catch { /* Fall back to the provider-specific route candidates. */ }
    }
  }
  for (const url of candidates) {
    tried.push(url);
    try {
      const html = await getHtml(url, config.base, config.timeout);
      reachedPage = true;
      const parsed = parseProviderCards(config, html, url);
      const items = [];
      for (const item of parsed) {
        const key = canonicalContentUrl(config.id, item.key, url) || item.key;
        const dedupeKey = config.id === 'hentaimama'
          ? `${normalizedTextKey(item.name)}|${String(item.poster || '').split('?')[0].toLowerCase()}`
          : key;
        if (!key || seenOnPage.has(dedupeKey)) continue;
        seenOnPage.add(dedupeKey);
        items.push({ ...item, key });
      }
      // Some sites silently serve page 1 for an invalid page URL. Do not return the same page again.
      if ((Number(args.page) || 1) > 1 && items.length && firstPageFingerprint && catalogPageFingerprint(items) === firstPageFingerprint) continue;
      if (items.length) return items;
    } catch (e) {
      lastError = e;
      // A 404 for one guessed route is normal; continue through the known candidates.
    }
  }
  if (!reachedPage && lastError) throw lastError;
  if (!reachedPage) console.warn(`[${config.name}] no candidate page could be fetched: ${tried.join(' | ')}`);
  else console.warn(`[${config.name}] pages fetched but parser found 0 eligible cards for page ${Math.max(1, Number(args.page) || 1)}${args.genre ? `, genre ${args.genre}` : ''}${args.search ? ', search request' : ''}`);
  return [];
}

async function pageMeta(url, config) {
  const html = await getHtml(url, config.base, config.timeout);
  const $ = cheerio.load(html);
  const hentaimamaTitle = config.id === 'hentaimama' ? clean($('input[name="title"]').first().attr('value')) : '';
  const name = hentaimamaTitle || metaText($, ['meta[property="og:title"]', 'meta[name="twitter:title"]', 'h1', 'title']) || titleFromUrl(url, config.id);
  const metaPoster = metaText($, ['meta[property="og:image"]', 'meta[name="twitter:image"]']);
  const poster = absUrl(metaPoster || (config.id === 'hentaimama' ? $('div.imagen img').first().attr('src') : ''), url);
  const description = metaText($, ['meta[property="og:description"]', 'meta[name="description"]']) || clean($('.entry-content p,.content p,.description p,.wp-content p,.summary').first().text());
  const genres = [...new Set($('.sgeneros a,.genres a,.genre a,a[rel="tag"],.tags a,[class*="genre"] a,a[href*="/genre/"],a[href*="/tag/"]').map((_, el) => clean($(el).text())).get().filter(x => x && x.length < 40))].slice(0, 20);
  const episodes = [];
  const seen = new Set();
  const hentaimamaEpisodePage = config.id === 'hentaimama' && /\/episodes\//i.test(new URL(url).pathname);
  const episodeSelector = config.id === 'hentaimama'
    ? 'a[href*="/episodes/"]'
    : '.episodes a[href],#episodes a[href],.episodios a[href],.episode-list a[href],.playlist a[href],.eplist a[href],[class*="episode-list"] a[href]';
  if (!hentaimamaEpisodePage) $(episodeSelector).each((_, el) => {
    const $a = $(el); const key = config.id === 'hentaigasm' ? absUrl($a.attr('href'), url) : canonicalContentUrl(config.id, $a.attr('href'), url); const title = clean($a.text() || $a.attr('title'));
    const currentKey = config.id === 'hentaigasm' ? url : canonicalContentUrl(config.id, url, url);
    if (!key || key === currentKey || seen.has(key) || !title || isNoise(key)) return;
    if (config.id === 'hentaimama' && !/\/episodes\//i.test(new URL(key).pathname)) return;
    seen.add(key); episodes.push({ key, title });
  });
  return { name: name || config.name, poster, background: poster, description, genres, episodes };
}
function normalizePlayerText(value) {
  return String(value || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&').replace(/\\u003d/gi, '=')
    .replace(/\\u003a/gi, ':').replace(/\\u002f/gi, '/')
    .replace(/\\x3a/gi, ':').replace(/\\x2f/gi, '/')
    .replace(/&amp;/gi, '&').replace(/&#038;/g, '&').replace(/&quot;/g, '"');
}

const MEDIA_URL_RE = /\.(?:m3u8|mp4|m4v|mpd|webm)(?:[?#]|$)/i;
function expandEncodedPlayerText(value) {
  let source = normalizePlayerText(value)
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#0?39;/gi, "'")
    .replace(/&#x2f;/gi, '/').replace(/&#x3a;/gi, ':');
  try { source += '\n' + decodeURIComponent(source.replace(/\+/g, '%20')); } catch { /* Most source text isn't URL-encoded. */ }
  const decoded = [];
  const base64Candidates = source.match(/(?:["'`])([A-Za-z0-9+/_=-]{40,})(?:["'`])/g) || [];
  for (const wrapped of base64Candidates.slice(0, 150)) {
    const token = wrapped.slice(1, -1);
    if (token.length % 4 === 1) continue;
    try {
      const candidate = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (/https?:|m3u8|\.mp4|<iframe|jwplayer|source\s*[:=]|video_url/i.test(candidate) && /[\x20-\x7e]{12}/.test(candidate)) decoded.push(candidate);
    } catch { /* Ignore non-base64 strings. */ }
  }
  return source + (decoded.length ? '\n' + decoded.join('\n') : '');
}
function extractMediaLegacy(html, base = '') {
  const source = normalizePlayerText(html);
  const urls = new Set();
  const add = raw => {
    if (!raw) return;
    let candidate = String(raw).trim().replace(/[),;]+$/, '').replace(/["'\\]+$/, '');
    candidate = candidate.replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&');
    const absolute = absUrl(candidate, base || 'https://invalid.local/');
    if (absolute && MEDIA_URL_RE.test(absolute) && !isNoise(absolute)) urls.add(absolute);
  };
  const absolutePattern = /https?:\\?\/\\?\/[^\s"'<>\\)]+?\.(?:m3u8|mp4|m4v|mpd|webm)(?:\?[^\s"'<>\\)]*)?/gi;
  for (const match of source.matchAll(absolutePattern)) add(match[0]);
  const configPattern = /(?:file|src|url|hls|mp4|video_url|stream_url|playlist|source)\s*["']?\s*[:=]\s*["']([^"']+)["']/gi;
  for (const match of source.matchAll(configPattern)) add(match[1]);
  if (base) {
    const $ = cheerio.load(source);
    $('video, video source, source, [data-file], [data-hls], [data-mp4]').each((_, el) => {
      const node = $(el);
      for (const key of ['src', 'data-src', 'data-file', 'data-hls', 'data-mp4']) {
        const value = node.attr(key);
        if (value && MEDIA_URL_RE.test(value)) add(value);
      }
    });
  }
  return [...urls];
}
function candidateStreamsLegacy(html, base) {
  const $ = cheerio.load(normalizePlayerText(html));
  const media = new Set(extractMediaLegacy(html, base));
  const embeds = new Set();
  const addEmbed = raw => {
    const src = absUrl(normalizePlayerText(raw), base);
    if (!src || isNoise(src) || /\.(?:jpe?g|png|gif|webp|svg)(?:[?#]|$)/i.test(src)) return;
    try { const parsed = new URL(src); if (parsed.protocol === 'http:' || parsed.protocol === 'https:') embeds.add(src); } catch {}
  };
  const rawEmbedText = normalizePlayerText(html).replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'");
  for (const match of rawEmbedText.matchAll(/<iframe\b[^>]*\b(?:src|data-src)\s*=\s*["']([^"']+)["']/gi)) addEmbed(match[1]);
  for (const match of rawEmbedText.matchAll(/(?:embed(?:_url)?|player(?:_url)?|iframe_url)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi)) addEmbed(match[1]);
  $('video source, video, source, [data-file], [data-hls], [data-mp4]').each((_, el) => {
    const node = $(el);
    for (const key of ['src', 'data-src', 'data-file', 'data-hls', 'data-mp4']) { const src = absUrl(node.attr(key), base); if (src && MEDIA_URL_RE.test(src)) media.add(src); }
  });
  $('iframe[src], iframe[data-src], [data-embed], [data-player], [data-video]').each((_, el) => {
    const node = $(el);
    for (const key of ['src', 'data-src', 'data-embed', 'data-player', 'data-video']) {
      const src = absUrl(node.attr(key), base);
      if (!src || isNoise(src) || /^(?:about:|javascript:|data:)/i.test(src)) continue;
      try { const parsed = new URL(src); if (sameProviderHost(src, base) && /\/(?:category|genre|tag|search|login|register)\//i.test(parsed.pathname)) continue; } catch { continue; }
      if (MEDIA_URL_RE.test(src)) media.add(src); else embeds.add(src);
    }
  });
  return { media: [...media], embeds: [...embeds] };
}

function extractMedia(html, base = '') {
  const source = expandEncodedPlayerText(html);
  const urls = new Set();
  const add = (raw) => {
    if (!raw) return;
    let candidate = String(raw).trim().replace(/[),;]+$/, '').replace(/["'\\]+$/, '');
    candidate = candidate.replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&');
    const absolute = absUrl(candidate, base || 'https://invalid.local/');
    if (absolute && MEDIA_URL_RE.test(absolute) && !isNoise(absolute)) urls.add(absolute);
  };

  // Plain and JSON-escaped absolute URLs.
  const absolutePattern = /https?:\\?\/\\?\/[^\s"'<>\\)]+?\.(?:m3u8|mp4|m4v|mpd|webm)(?:\?[^\s"'<>\\)]*)?/gi;
  for (const match of source.matchAll(absolutePattern)) add(match[0]);

  // Common player config forms: file, src, url, hls, and source lists.
  const configPattern = /(?:file|src|url|hls|mp4|video_url|stream_url|playlist|source)\s*["']?\s*[:=]\s*["']([^"']+)["']/gi;
  for (const match of source.matchAll(configPattern)) add(match[1]);

  // HTML video tags and source tags, including relative links.
  if (base) {
    const $ = cheerio.load(source);
    $('video, video source, source, [data-file], [data-hls], [data-mp4]').each((_, el) => {
      const node = $(el);
      for (const key of ['src', 'data-src', 'data-file', 'data-hls', 'data-mp4']) {
        const value = node.attr(key);
        if (value && MEDIA_URL_RE.test(value)) add(value);
      }
    });
  }
  return [...urls];
}

function candidateStreams(html, base) {
  const expandedText = expandEncodedPlayerText(html);
  const $ = cheerio.load(expandedText);
  const media = new Set(extractMedia(expandedText, base));
  const embeds = new Set();
  const addEmbed = raw => {
    const src = absUrl(normalizePlayerText(raw), base);
    if (!src || isNoise(src) || /\.(?:jpe?g|png|gif|webp|svg)(?:[?#]|$)/i.test(src)) return;
    try {
      const parsed = new URL(src);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') embeds.add(src);
    } catch {}
  };
  // Some sites expose their player iframe only inside a textarea/input value or escaped embed-code string.
  const rawEmbedText = expandedText.replace(/&quot;/gi, '"').replace(/\\\"/g, '"');
  for (const match of rawEmbedText.matchAll(/<iframe\b[^>]*\b(?:src|data-src)\s*=\s*["']([^"']+)["']/gi)) addEmbed(match[1]);
  for (const match of rawEmbedText.matchAll(/(?:embed(?:_url)?|player(?:_url)?|iframe_url)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi)) addEmbed(match[1]);
  $('video source, video, source, [data-file], [data-hls], [data-mp4]').each((_, el) => {
    const node = $(el);
    for (const key of ['src', 'data-src', 'data-file', 'data-hls', 'data-mp4']) {
      const src = absUrl(node.attr(key), base);
      if (src && MEDIA_URL_RE.test(src)) media.add(src);
    }
  });

  // Player iframes are often one or two levels away from the actual manifest.
  $('iframe[src], iframe[data-src], [data-embed], [data-player], [data-video]').each((_, el) => {
    const node = $(el);
    for (const key of ['src', 'data-src', 'data-embed', 'data-player', 'data-video']) {
      const src = absUrl(node.attr(key), base);
      if (!src || isNoise(src) || isAdOrTracker(src) || /^(?:about:|javascript:|data:)/i.test(src)) continue;
      try {
        const parsed = new URL(src);
        if (sameProviderHost(src, base) && /\/(?:category|genre|tag|search|login|register)\//i.test(parsed.pathname)) continue;
      } catch { continue; }
      if (MEDIA_URL_RE.test(src)) media.add(src);
      else embeds.add(src);
    }
  });
  return { media: [...media], embeds: [...embeds] };
}

function qualityFromLabel(value, allowBareNumber = false) {
  const text = String(value || '');
  const dimension = text.match(/(?:^|[^0-9])\d{3,5}\s*[x×]\s*(2160|1440|1080|720|576|540|480|360|240)(?:$|[^0-9])/i);
  if (dimension) return `${dimension[1]}p`;
  const match = text.match(/(?:^|[^0-9])(2160|1440|1080|720|576|540|480|360|240)\s*p\b/i);
  if (match) return `${match[1]}p`;
  if (allowBareNumber) {
    const bare = text.trim().match(/^(2160|1440|1080|720|576|540|480|360|240)$/);
    if (bare) return `${bare[1]}p`;
  }
  return '';
}
function sourceAssignments(source) {
  const assignments = [];
  const pattern = /(?:[\"'`])?([A-Za-z_$][\w$]*)[\"'`]?\s*[:=]\s*([\"'`])([^\"'`]+)\2/g;
  for (const match of String(source || '').matchAll(pattern)) assignments.push({ key: match[1], value: match[3], index: match.index });
  return assignments;
}
function detectExplicitQuality(url, source = '') {
  try {
    const parsed = new URL(url);
    const pathQuality = qualityFromLabel(parsed.pathname);
    if (pathQuality) return pathQuality;
    for (const [key, value] of parsed.searchParams) {
      if (/(?:quality|resolution|\bres\b)/i.test(key)) {
        const quality = qualityFromLabel(value, true);
        if (quality) return quality;
      }
    }
  } catch { /* The URL is validated by streamObject; source metadata can still be checked. */ }

  let sourceText = '';
  try { sourceText = typeof source === 'string' ? source : JSON.stringify(source ?? ''); }
  catch { sourceText = String(source || ''); }
  const normalized = sourceText
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&');
  const assignments = sourceAssignments(normalized);
  const matching = assignments.find(entry => {
    const raw = entry.value.replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
    try { return new URL(raw, url).href === new URL(url).href; } catch { return raw === url; }
  });
  if (!matching) return '';

  const siblingNames = [
    `${matching.key}_text`, `${matching.key}_quality`, `${matching.key}_label`,
    `${matching.key.replace(/_url$/i, '')}_quality`, `${matching.key.replace(/_url$/i, '')}_label`,
  ];
  for (const name of siblingNames) {
    const entry = assignments.find(item => item.key.toLowerCase() === name.toLowerCase());
    if (entry) {
      const quality = qualityFromLabel(entry.value, true);
      if (quality) return quality;
    }
  }

  // For generic player configs such as {file: URL, label: '1080p'}, read only
  // explicit quality metadata belonging to the same containing object.
  const start = normalized.lastIndexOf('{', matching.index);
  const end = normalized.indexOf('}', matching.index);
  if (start >= 0 && end > matching.index && end - start <= 12000) {
    const objectText = normalized.slice(start, end + 1);
    for (const item of sourceAssignments(objectText)) {
      if (/^(?:quality|resolution|label|title|name)$/i.test(item.key)) {
        const quality = qualityFromLabel(item.value, true);
        if (quality) return quality;
      }
    }
  }
  return '';
}

function posterShapeFor(item, selectedGenre = '') {
  if (item?.providerId === 'hentaimama') return clean(selectedGenre) && !/^all genres?$/i.test(clean(selectedGenre)) ? 'poster' : 'landscape';
  if (item?.providerId === 'hentaigasm') return 'landscape';
  return 'landscape';
}

// A master HLS playlist can list real variant playlists at explicit resolutions.
// Convert those listed variants to separate Stremio stream choices; never guess URLs.
function parseHlsVariantPlaylist(playlist, baseUrl) {
  const lines = String(playlist || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.some(line => line === '#EXTM3U')) return [];
  const variants = [];
  const seenQualities = new Set();
  const seenUrls = new Set();
  let pendingQuality = '';
  for (const line of lines) {
    if (/^#EXT-X-STREAM-INF:/i.test(line)) {
      pendingQuality = qualityFromLabel(line);
      continue;
    }
    if (!pendingQuality || line.startsWith('#')) continue;
    try {
      const url = new URL(line, baseUrl).href;
      if (!/^https?:$/.test(new URL(url).protocol) || seenQualities.has(pendingQuality) || seenUrls.has(url)) {
        pendingQuality = '';
        continue;
      }
      variants.push({ quality: pendingQuality, url });
      seenQualities.add(pendingQuality);
      seenUrls.add(url);
    } catch { /* Skip malformed variant entries instead of creating links. */ }
    pendingQuality = '';
  }
  return variants.sort((a, b) => Number(b.quality.replace('p', '')) - Number(a.quality.replace('p', '')));
}

async function expandHlsQualityStreams(streams) {
  const sourceStreams = Array.isArray(streams) ? streams : [];
  const expanded = new Map();
  let checked = 0;
  await Promise.all(sourceStreams.map(async (stream, index) => {
    expanded.set(index, [stream]);
    if (!stream?.url || !/\.m3u8(?:[?#]|$)/i.test(stream.url) || qualityFromLabel(stream.title) || checked >= 4) return;
    checked++;
    try {
      const requestHeaders = stream.behaviorHints?.proxyHeaders?.request || { 'User-Agent': UA };
      const response = await http.get(stream.url, { responseType: 'text', headers: requestHeaders });
      const finalUrl = response.request?.res?.responseUrl || response.request?.responseURL || stream.url;
      const variants = parseHlsVariantPlaylist(String(response.data || ''), finalUrl);
      // Keep the original master unless at least two different, explicitly labelled variants exist.
      if (variants.length < 2) return;
      expanded.set(index, variants.map(variant => {
        let filename = '';
        try { filename = decodeURIComponent(new URL(variant.url).pathname.split('/').pop() || ''); } catch {}
        return {
          ...stream,
          title: `${variant.quality} · HLS`,
          url: variant.url,
          behaviorHints: {
            ...(stream.behaviorHints || {}),
            notWebReady: true,
            ...(filename ? { filename } : {}),
          },
        };
      }));
    } catch { /* Keep the original valid master URL if variant lookup fails. */ }
  }));
  return [...expanded.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, group]) => group).slice(0, 20);
}

function isAdOrTracker(url) {
  try {
    const u = new URL(url);
    return /(?:doubleclick|googlesyndication|google-analytics|googletagmanager|trackwilltrk|xhubtraffic|zlink|yandex|popads|adservice|exoclick|trafficjunky|adsterra|onclickads|juicyads|push-notification)/i.test(u.hostname)
      || /\/(?:ads?|advert|banner|tracking|analytics|promo)(?:\/|\.|$)/i.test(u.pathname);
  } catch { return true; }
}
function scorePlayerUrl(url) {
  try {
    const u = new URL(url);
    let score = 0;
    if (/\.(?:m3u8|mp4|m4v|mpd|webm)(?:[?#]|$)/i.test(url)) score += 100;
    if (/\/(?:embed|player|video|watch|stream|iframe|jwplayer)(?:\/|$)/i.test(u.pathname)) score += 20;
    if (/(?:player|embed|stream|video)/i.test(`${u.hostname}${u.pathname}`)) score += 8;
    if (isAdOrTracker(url)) score -= 1000;
    return score;
  } catch { return -1000; }
}
function isHentaiMamaMp4(url) {
  return /\.mp4(?:[?#]|$)/i.test(String(url || ''));
}
function isHlsUrl(url) {
  const value = String(url || '');
  try {
    const parsed = new URL(value);
    return /\.m3u8$/i.test(parsed.pathname) || /\.m3u8(?:[?#&]|$)/i.test(parsed.search);
  } catch { return /\.m3u8(?:[?#&]|$)/i.test(value); }
}
function isSafeProxyTarget(raw) {
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    const ipVersion = net.isIP(host);
    if (ipVersion === 4) {
      const parts = host.split('.').map(Number);
      if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || parts[0] >= 224 ||
          (parts[0] === 169 && parts[1] === 254) ||
          (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
          (parts[0] === 192 && parts[1] === 168)) return false;
    }
    if (ipVersion === 6 && (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:'))) return false;
    return true;
  } catch { return false; }
}
function getAddonBaseUrl() {
  const direct = process.env.ADDON_BASE_URL || process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL || process.env.APP_URL || process.env.ADDON_URL || process.env.HOST_URL || process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_STATIC_URL;
  if (direct) return String(direct).replace(/\/$/, '');
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.REPLIT_DEV_DOMAIN || process.env.KOYEB_PUBLIC_DOMAIN || process.env.VERCEL_URL;
  if (domain) return `https://${String(domain).replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  if (process.env.REPLIT_DOMAINS) return `https://${String(process.env.REPLIT_DOMAINS).split(',')[0].trim()}`;
  if (process.env.FLY_APP_NAME) return `https://${process.env.FLY_APP_NAME}.fly.dev`;
  if (process.env.NODE_ENV !== 'production') return `http://127.0.0.1:${PORT}`;
  return '';
}
function signHlsToken(token) {
  return crypto.createHmac('sha256', HLS_PROXY_SECRET).update(token).digest('base64url');
}
function createHlsProxyUrl(upstreamUrl, referer, forcePlaylist = false) {
  if (!isSafeProxyTarget(upstreamUrl)) return '';
  const base = getAddonBaseUrl();
  if (!base) return '';
  const token = Buffer.from(JSON.stringify({
    k: 'hls',
    u: upstreamUrl,
    r: referer || upstreamUrl,
    p: Boolean(forcePlaylist || isHlsUrl(upstreamUrl)),
    e: Date.now() + HLS_PROXY_TTL_MS,
  })).toString('base64url');
  return `${base}/hls/${token}/${signHlsToken(token)}`;
}
function createHentaiMamaImageProxyUrl(upstreamUrl, referer) {
  if (!isSafeProxyTarget(upstreamUrl)) return '';
  const base = getAddonBaseUrl();
  if (!base) return '';
  const token = Buffer.from(JSON.stringify({
    k: 'image',
    u: upstreamUrl,
    r: referer || 'https://hentaimama.io/',
    e: Date.now() + 7 * 24 * 60 * 60 * 1000,
  })).toString('base64url');
  return `${base}/image/${token}/${signHlsToken(token)}`;
}
function verifyProxyToken(token, signature, kind) {
  try {
    const expected = Buffer.from(signHlsToken(token));
    const supplied = Buffer.from(String(signature || ''));
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
    const payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!payload || payload.k !== kind || typeof payload.u !== 'string' || !isSafeProxyTarget(payload.u) || Number(payload.e) < Date.now()) return null;
    return payload;
  } catch { return null; }
}
function verifyHlsProxyToken(token, signature) {
  return verifyProxyToken(token, signature, 'hls');
}
function proxyHentaiMamaPoster(url, referer) {
  return createHentaiMamaImageProxyUrl(url, referer) || url;
}
function proxyPlaylistUri(uri, playlistUrl, referer, forcePlaylist = false) {
  const raw = String(uri || '').trim();
  if (!raw || /^(?:data:|skd:|urn:)/i.test(raw)) return raw;
  try {
    const absolute = new URL(raw, playlistUrl).href;
    return createHlsProxyUrl(absolute, referer, forcePlaylist) || absolute;
  } catch { return raw; }
}
function rewriteHlsPlaylist(playlist, playlistUrl, referer) {
  let expectVariantPlaylist = false;
  return String(playlist || '').split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      const variantAttributeLine = /#EXT-X-(?:I-FRAME-)?STREAM-INF/i.test(trimmed) || /#EXT-X-MEDIA:/i.test(trimmed);
      const rewritten = line.replace(/\bURI=(?:"([^"]+)"|'([^']+)'|([^,\s]+))/gi, (match, doubleQuoted, singleQuoted, unquoted) => {
        const uri = doubleQuoted || singleQuoted || unquoted || '';
        const forcePlaylist = variantAttributeLine;
        const proxied = proxyPlaylistUri(uri, playlistUrl, referer, forcePlaylist);
        return `URI="${proxied.replace(/"/g, '%22')}"`;
      });
      if (/#EXT-X-STREAM-INF/i.test(trimmed)) expectVariantPlaylist = true;
      return rewritten;
    }
    const rewritten = proxyPlaylistUri(trimmed, playlistUrl, referer, expectVariantPlaylist);
    expectVariantPlaylist = false;
    return rewritten;
  }).join('\n');
}
async function sniffHentaiMamaMediaType(url, referer) {
  if (!isHentaiMamaMp4(url)) {
    if (isHlsUrl(url)) return 'HLS';
    if (/\.mpd(?:[?#]|$)/i.test(String(url || ''))) return 'DASH';
    if (/\.webm(?:[?#]|$)/i.test(String(url || ''))) return 'WEBM';
    return '';
  }
  try {
    const response = await http.get(url, {
      responseType: 'stream',
      timeout: 7000,
      httpsAgent: HLS_TLS_AGENT,
      headers: { Referer: referer || url, Range: 'bytes=0-2047', Accept: '*/*' },
      validateStatus: status => status >= 200 && status < 500,
    });
    const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
    if (/mpegurl|x-mpegurl|vnd\.apple\.mpegurl/.test(contentType)) {
      response.data?.destroy?.();
      return 'HLS';
    }
    const firstChunk = await new Promise(resolve => {
      const stream = response.data;
      if (!stream || typeof stream.once !== 'function') return resolve(Buffer.alloc(0));
      let settled = false;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(Buffer.from(value || [])); };
      const timer = setTimeout(() => finish(Buffer.alloc(0)), 2200);
      stream.once('data', finish);
      stream.once('end', () => finish(Buffer.alloc(0)));
      stream.once('error', () => finish(Buffer.alloc(0)));
    });
    response.data?.destroy?.();
    const prefix = firstChunk.toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (prefix.startsWith('#EXTM3U')) return 'HLS';
    if (/video\/mp4|application\/mp4/.test(contentType) || firstChunk.subarray(4, 8).toString('ascii') === 'ftyp') return 'MP4';
    return 'UNKNOWN'; // Do not label an unverified .mp4-looking URL as MP4.
  } catch { return 'UNKNOWN'; }
}
async function makeHentaiMamaStream(url, referer, source = '') {
  const detectedType = await sniffHentaiMamaMediaType(url, referer);
  const stream = streamObject('HentaiMama', url, referer, false, source, detectedType || undefined);
  if (detectedType === 'HLS') stream.behaviorHints.filename = 'playlist.m3u8';
  const proxyUrl = createHlsProxyUrl(url, referer, detectedType === 'HLS');
  if (proxyUrl) {
    stream.url = proxyUrl;
    delete stream.behaviorHints.proxyHeaders;
  }
  return stream;
}

async function hentaiMamaImageProxyHandler(req, res) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Origin, Accept, Content-Type',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  if (req.method === 'OPTIONS') return res.status(204).end();
  const payload = verifyProxyToken(req.params.token, req.params.signature, 'image');
  if (!payload) return res.status(403).send('Invalid or expired image proxy token');
  try {
    const upstream = await http.get(payload.u, {
      responseType: 'arraybuffer',
      timeout: Number(process.env.IMAGE_PROXY_TIMEOUT_MS || 12000),
      maxContentLength: 12 * 1024 * 1024,
      httpsAgent: HLS_TLS_AGENT,
      headers: { Referer: payload.r || 'https://hentaimama.io/', Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
      validateStatus: status => status >= 200 && status < 400,
    });
    const contentType = String(upstream.headers?.['content-type'] || '').split(';')[0].toLowerCase();
    if (!contentType.startsWith('image/')) return res.status(502).send('Image source did not return an image');
    res.status(upstream.status);
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    for (const key of ['content-length', 'last-modified', 'etag']) {
      const value = upstream.headers?.[key];
      if (value) res.set(key, value);
    }
    if (req.method === 'HEAD') return res.end();
    return res.send(Buffer.from(upstream.data));
  } catch (error) {
    console.warn(`[HentaiMama image proxy] ${error.code || error.response?.status || error.message}`);
    return res.status(502).send('Image proxy failed');
  }
}

async function hlsProxyHandler(req, res) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Origin, Accept, Content-Type',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  if (req.method === 'OPTIONS') return res.status(204).end();
  const payload = verifyHlsProxyToken(req.params.token, req.params.signature);
  if (!payload) return res.status(403).send('Invalid or expired HLS proxy token');
  try {
    const sourceReferer = payload.r || payload.u;
    let sourceOrigin;
    try { sourceOrigin = new URL(sourceReferer).origin; } catch {}
    const headers = {
      'User-Agent': UA,
      Referer: sourceReferer,
      ...(sourceOrigin ? { Origin: sourceOrigin } : {}),
      Accept: '*/*',
      ...(req.headers.range ? { Range: req.headers.range } : {}),
    };
    let upstream;
    try {
      upstream = await http.get(payload.u, {
        responseType: 'stream',
        timeout: 30000,
        httpsAgent: HLS_TLS_AGENT,
        headers,
        validateStatus: status => status >= 200 && status < 500,
      });
    } catch (error) {
      const status = error.response?.status || 502;
      return res.status(status).send('Upstream media request failed');
    }
    const contentType = String(upstream.headers?.['content-type'] || '').toLowerCase();
    const playlist = payload.p || isHlsUrl(payload.u) || /mpegurl|x-mpegurl|vnd\.apple\.mpegurl/.test(contentType);
    if (playlist) {
      const chunks = [];
      let size = 0;
      for await (const chunk of upstream.data) {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) throw new Error('HLS playlist exceeded 5 MB');
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
      if (!body.trimStart().startsWith('#EXTM3U')) {
        return res.status(upstream.status >= 400 ? upstream.status : 502).send('Source did not return a valid HLS playlist');
      }
      const output = rewriteHlsPlaylist(body, payload.u, payload.r || payload.u);
      res.status(upstream.status);
      res.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.set('Cache-Control', 'private, max-age=10');
      return req.method === 'HEAD' ? res.end() : res.send(output);
    }
    res.status(upstream.status);
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const value = upstream.headers?.[key];
      if (value) res.set(key, value);
    }
    if (req.method === 'HEAD') {
      upstream.data?.destroy?.();
      return res.end();
    }
    req.on('close', () => upstream.data?.destroy?.());
    upstream.data.on('error', () => { if (!res.headersSent) res.status(502); res.destroy(); });
    return upstream.data.pipe(res);
  } catch (error) {
    console.warn(`[HLS proxy] ${error.code || error.message}`);
    if (!res.headersSent) return res.status(502).send('HLS proxy failed');
    return res.destroy();
  }
}

function streamObject(providerName, url, referer, preserveHentaigasm = false, source = '', typeOverride = '') {
  const parsed = new URL(url);
  const ext = parsed.pathname.toLowerCase();
  const type = typeOverride || (isHlsUrl(url) ? 'HLS' : ext.endsWith('.mpd') ? 'DASH' : ext.endsWith('.webm') ? 'WEBM' : 'MP4');
  const quality = detectExplicitQuality(url, source);
  let filename = ext.split('/').pop() || `stream.${type.toLowerCase()}`;
  try { filename = decodeURIComponent(filename); } catch { /* Preserve the raw filename if the URL contains invalid escapes. */ }
  return {
    name: providerName,
    title: quality ? `${quality} · ${type}` : type,
    url,
    behaviorHints: {
      notWebReady: true,
      filename,
      proxyHeaders: { request: preserveHentaigasm
        ? { Referer: referer, 'User-Agent': UA }
        : { Referer: referer, Origin: (() => { try { return new URL(referer).origin; } catch { return undefined; } })(), 'User-Agent': UA } },
    },
  };
}

async function resolveStreams(providerName, pageUrl, providerId = '') {
  const streams = [];
  const streamUrls = new Set();
  const visited = new Set();
  const queue = [{ url: pageUrl, referer: pageUrl, depth: 0, html: null }];
  const defaultDepth = providerId === 'hentaigasm' ? 3 : 5;
  const defaultPageLimit = providerId === 'hentaigasm' ? 18 : 24;
  const maxDepth = Number(process.env.EMBED_DEPTH || defaultDepth);
  const maxPages = Number(process.env.EMBED_PAGE_LIMIT || defaultPageLimit);

  while (queue.length && visited.size < maxPages) {
    const current = queue.shift();
    if (!current?.url || visited.has(current.url) || current.depth > maxDepth) continue;
    visited.add(current.url);
    try {
      const html = current.html ?? (providerId === 'hentaigasm'
        ? await getHtml(current.url, current.referer)
        : await getHtmlFresh(current.url, current.referer));
      const found = providerId === 'hentaigasm'
        ? candidateStreamsLegacy(html, current.url)
        : candidateStreams(html, current.url);
      const mediaCandidates = found.media.map(url => ({ url, quality: detectExplicitQuality(url, html) }));
      for (const candidate of mediaCandidates) {
        const mediaUrl = candidate.url;
        if ((providerId !== 'hentaigasm' && isAdOrTracker(mediaUrl)) || streamUrls.has(mediaUrl)) continue;
        streamUrls.add(mediaUrl);
        try { streams.push(streamObject(providerName, mediaUrl, current.url, providerId === 'hentaigasm', html)); }
        catch { /* Ignore malformed player URLs. */ }
      }
      const embedUrls = providerId === 'hentaigasm' ? found.embeds : [...found.embeds].sort((a, b) => scorePlayerUrl(b) - scorePlayerUrl(a));
      for (const embedUrl of embedUrls) {
        if ((providerId !== 'hentaigasm' && isAdOrTracker(embedUrl)) || visited.has(embedUrl) || queue.some(item => item.url === embedUrl)) continue;
        if (current.depth < maxDepth) queue.push({ url: embedUrl, referer: current.url, depth: current.depth + 1, html: null });
      }
    } catch (e) {
      console.warn(`[${providerName}] player fetch failed (${current.url}): ${e.code || e.response?.status || e.message}`);
    }
  }

  console.log(`[${providerName}] stream resolver: ${streams.filter(s => s.url).length} direct, ${visited.size} pages checked`);
  return streams;
}

function extractJsObject(source, variableName = 'data') {
  const re = new RegExp(`(?:(?:var|let|const)\\s+|window\\.)${variableName}\\s*=\\s*`, 'm');
  const m = re.exec(String(source || ''));
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 0, quote = '', escaped = false, objectStart = -1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') { if (depth === 0) objectStart = i; depth++; }
    if (ch === '}') {
      depth--;
      if (depth === 0 && objectStart >= 0) {
        const raw = source.slice(objectStart, i + 1);
        try { return JSON.parse(raw); } catch { /* Normalize ordinary JS object syntax below. */ }
        try {
          const jsonish = raw
            .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
            .replace(/'/g, '"')
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/\bundefined\b/g, 'null');
          return JSON.parse(jsonish);
        } catch { return null; }
      }
    }
  }
  return null;
}
function flattenPayloadTexts(value, out = [], depth = 0) {
  if (depth > 6 || value == null) return out;
  if (typeof value === 'string') {
    out.push(value);
    // AJAX endpoints sometimes double-encode a JSON payload.
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { flattenPayloadTexts(JSON.parse(trimmed), out, depth + 1); } catch { /* It may be HTML rather than JSON. */ }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) flattenPayloadTexts(item, out, depth + 1);
  } else if (typeof value === 'object') {
    for (const item of Object.values(value)) flattenPayloadTexts(item, out, depth + 1);
  }
  return out;
}
function extractPlayerFrames(value, base) {
  const frames = new Set();
  for (const textValue of flattenPayloadTexts(value)) {
    const source = normalizePlayerText(textValue)
      .replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'")
      .replace(/\\"/g, '"');
    const matches = [
      ...[...source.matchAll(/<(?:iframe|frame)\b[^>]*\b(?:src|data-src)\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]),
      ...[...source.matchAll(/(?:iframe_url|player_url|embed_url)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi)].map(m => m[1]),
    ];
    for (const candidate of matches) {
      const url = absUrl(candidate, base);
      if (url && !isNoise(url) && !isAdOrTracker(url)) frames.add(url);
    }
  }
  return [...frames];
}
function extractPlayerFrame(value, base) {
  return extractPlayerFrames(value, base)[0] || '';
}
function extractPlayerMedia(value, base) {
  const texts = flattenPayloadTexts(value);
  const urls = new Set();
  for (const textValue of texts) {
    const expanded = expandEncodedPlayerText(textValue);
    for (const url of extractMedia(expanded, base)) {
      if (!isAdOrTracker(url)) urls.add(url);
    }
    // Some JWPlayer configs use a JS object, single quotes, or escaped JSON.
    const normalized = normalizePlayerText(expanded).replace(/\\"/g, '"').replace(/&quot;/gi, '"');
    for (const match of normalized.matchAll(/(?:["']?(?:file|src|hls|video_url|stream_url)["']?)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi)) {
      const url = absUrl(match[1], base);
      if (url && MEDIA_URL_RE.test(url) && !isNoise(url) && !isAdOrTracker(url)) urls.add(url);
    }
  }
  return [...urls];
}
function extractHentaiMamaAjaxCandidates(html) {
  const scripts = [...String(html || '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const sources = scripts.length ? scripts : [String(html || '')];
  const found = [];
  const seen = new Set();
  for (const script of sources) {
    const actions = [...script.matchAll(/(?:["']action["']\s*:\s*|\baction\s*[:=]\s*)["']([^"']+)["']/gi)];
    const ids = [...script.matchAll(/(?:["']a["']\s*:\s*|\ba\s*[:=]\s*)["']?(\d+)["']?/gi)];
    for (const action of actions) {
      // Pair the action with the nearest numeric `a` parameter in the same script.
      const id = ids.map(m => ({ value: m[1], distance: Math.abs(m.index - action.index) }))
        .filter(m => m.distance <= 500).sort((a, b) => a.distance - b.distance)[0];
      if (!id) continue;
      const candidate = { action: action[1], a: id.value };
      const key = `${candidate.action}|${candidate.a}`;
      if (!seen.has(key)) { seen.add(key); found.push(candidate); }
    }
  }
  // Older templates provide the request body as `var data = {...}`.
  const data = extractJsObject(String(html || ''), 'data');
  if (data && typeof data === 'object' && data.action && (data.a != null || data.id != null)) {
    const candidate = { action: String(data.action), a: String(data.a ?? data.id) };
    const key = `${candidate.action}|${candidate.a}`;
    if (!seen.has(key)) found.push(candidate);
  }
  return found.slice(0, 5);
}
function parsePayload(value) {
  if (typeof value !== 'string') return value;
  let payload = value.trim();
  for (let i = 0; i < 2; i++) {
    try { payload = JSON.parse(payload); } catch { break; }
    if (typeof payload !== 'string') break;
  }
  return payload;
}
async function resolveHentaiMamaStreams(episodeUrl) {
  const base = 'https://hentaimama.io';
  const streams = [];
  const seen = new Set();
  const addSources = async (value, referer) => {
    const urls = extractPlayerMedia(value, referer)
      .filter(url => !seen.has(url))
      .slice(0, Math.max(0, 8 - streams.length));
    urls.forEach(url => seen.add(url));
    const resolved = await Promise.all(urls.map(async url => {
      try { return await makeHentaiMamaStream(url, referer, value); }
      catch (error) {
        console.warn(`[HentaiMama] source rejected (${url}): ${error.code || error.message}`);
        return null;
      }
    }));
    streams.push(...resolved.filter(Boolean));
  };
  const addPlayerFrames = async (frames, referer, cookies = '') => {
    for (const frameUrl of frames.slice(0, 6)) {
      try {
        const response = await http.get(frameUrl, {
          responseType: 'text',
          headers: { Referer: referer, ...(cookies ? { Cookie: cookies } : {}) },
        });
        const playerHtml = String(response.data || '');
        await addSources(playerHtml, frameUrl);
        if (!streams.length) {
          const nested = await resolveStreams('HentaiMama', frameUrl, 'hentaimama');
          for (const candidate of nested) {
            if (seen.has(candidate.url)) continue;
            seen.add(candidate.url);
            streams.push(await makeHentaiMamaStream(candidate.url, frameUrl, playerHtml));
            if (streams.length >= 8) break;
          }
        }
        if (streams.length >= 8) break;
      } catch (e) {
        console.warn(`[HentaiMama] player mirror failed (${frameUrl}): ${e.code || e.response?.status || e.message}`);
      }
    }
  };

  try {
    const pageResponse = await http.get(episodeUrl, { responseType: 'text' });
    const pageHtml = String(pageResponse.data || '');
    const cookies = (pageResponse.headers?.['set-cookie'] || []).map(v => String(v).split(';')[0]).filter(Boolean).join('; ');

    await addSources(pageHtml, episodeUrl);
    if (streams.length) return streams.slice(0, 8);

    const ajaxCandidates = extractHentaiMamaAjaxCandidates(pageHtml);
    for (const candidate of ajaxCandidates) {
      try {
        const postBody = new URLSearchParams({ action: candidate.action, a: candidate.a }).toString();
        const ajaxResponse = await http.post(`${base}/wp-admin/admin-ajax.php`, postBody, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Referer: episodeUrl,
            Origin: base,
            ...(cookies ? { Cookie: cookies } : {}),
            'X-Requested-With': 'XMLHttpRequest',
          },
        });
        const payload = parsePayload(ajaxResponse.data);
        await addSources(payload, episodeUrl);
        if (streams.length) return streams.slice(0, 8);
        const frames = extractPlayerFrames(payload, base);
        if (frames.length) await addPlayerFrames(frames, episodeUrl, cookies);
        if (streams.length) return streams.slice(0, 8);
      } catch (e) {
        console.warn(`[HentaiMama] AJAX candidate ${candidate.action}/${candidate.a} failed: ${e.code || e.response?.status || e.message}`);
      }
    }

    const pageFrames = extractPlayerFrames(pageHtml, episodeUrl);
    if (pageFrames.length) await addPlayerFrames(pageFrames, episodeUrl, cookies);
    if (streams.length) return streams.slice(0, 8);

    const nested = await resolveStreams('HentaiMama', episodeUrl, 'hentaimama');
    for (const candidate of nested) {
      if (seen.has(candidate.url)) continue;
      seen.add(candidate.url);
      streams.push(await makeHentaiMamaStream(candidate.url, episodeUrl, pageHtml));
      if (streams.length >= 8) break;
    }
  } catch (e) {
    console.warn(`[HentaiMama] stream extraction failed (${episodeUrl}): ${e.code || e.response?.status || e.message}`);
  }
  return streams.slice(0, 8);
}
function htmlProvider(config) {
  return {
    ...config,
    async catalog(args) {
      if (config.id !== 'hentaimama') return fetchCatalog(config, args);
      const queryKey = `hentaimama|page:${Math.max(1, Number(args.page) || 1)}|genre:${clean(args.genre).toLowerCase()}|search:${clean(args.search).toLowerCase()}`;
      return cached(`parsed-catalog:${queryKey}`, CATALOG_TTL, () => fetchCatalog(config, args));
    },
    async meta(key) {
      const data = await pageMeta(key, config);
      if (config.id === 'hentaimama' && data.poster) data.poster = proxyHentaiMamaPoster(data.poster, key);
      if (!data.poster) {
        const cards = parseCards(await getHtml(key, config.base, config.timeout), key);
        if (cards[0]) data.poster = config.id === 'hentaimama' ? proxyHentaiMamaPoster(cards[0].poster, key) : cards[0].poster;
      }
      return data;
    },
    async streams(key) {
      if (config.id === 'hentaimama') return resolveHentaiMamaStreams(key);
      return resolveStreams(config.name, key, config.id);
    },
  };
}

const hentaimama = htmlProvider({ id: 'hentaimama', name: 'HentaiMama', base: process.env.HENTAIMAMA_BASE || 'https://hentaimama.io', listPaths: ['/recent-episodes/', '/'], genrePaths: ['/genre/{g}/'] });
const hentaigasm = htmlProvider({ id: 'hentaigasm', name: 'Hentaigasm', base: process.env.HENTAIGASM_BASE || 'https://hentaigasm.com', listPaths: ['/'], genrePaths: ['/genre/{g}/', '/tag/{g}/', '/category/{g}/'] });
const PROVIDERS = { hentaimama, hentaigasm };
const makeExtra = genres => [
  { name: 'search', isRequired: false },
  { name: 'genre', isRequired: false, options: genres, optionsLimit: 1 },
  { name: 'skip', isRequired: false },
];
const catalogs = Object.values(PROVIDERS).map(provider => ({
  type: TYPE,
  id: `hn-${provider.id}`,
  name: provider.name,
  extra: makeExtra(PROVIDER_GENRES[provider.id] || GENRES),
}));
const manifest = {
  id: 'community.hentai.hub',
  version: '2.6.4',
  name: 'Hentai',
  description: 'HentaiMama and Hentaigasm catalogs. Adults 18+ only.',
  resources: ['catalog', 'meta', 'stream'],
  types: [TYPE],
  idPrefixes: ['hn:'],
  catalogs,
  behaviorHints: { adult: true, configurable: false },
};
const builder = new addonBuilder(manifest);
const makeId = (providerId, key) => `hn:${providerId}:${encodeKey(key)}`;
function parseId(id) {
  const parts = String(id || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'hn') return null;
  try { return { providerId: parts[1], key: decodeKey(parts[2]) }; } catch { return null; }
}
function selectedProviders(id) {
  const name = String(id || '').replace(/^hn-/, '');
  return PROVIDERS[name] ? [PROVIDERS[name]] : [];
}

async function collectProviderCatalog(provider, { search = '', genre = '', target = PAGE_SIZE, maxPages } = {}) {
  const desired = Math.max(1, Number(target) || PAGE_SIZE);
  const pageCap = Math.min(3000, Math.max(1, Number(maxPages) || Math.ceil(desired / 8) + 2));
  const list = [];
  const seenKeys = new Set();
  const seenPages = new Set();
  for (let page = 1; page <= pageCap; page++) {
    let pageItems;
    try {
      pageItems = await provider.catalog({ search, genre, page });
    } catch (e) {
      console.error(`[${provider.name}] catalog failed at ${provider.catalogUrl || provider.base || 'unknown URL'} (source page ${page}): ${e.code || e.response?.status || e.message}`);
      break;
    }
    if (!pageItems || !pageItems.length) break;
    const fingerprint = catalogPageFingerprint(pageItems);
    if (seenPages.has(fingerprint)) break;
    seenPages.add(fingerprint);
    let newItems = 0;
    for (const item of pageItems) {
      const key = String(item.key || '');
      if (!key || !item.name || !item.poster || blocked(item)) continue;
      let duplicateKey = key;
      if (provider.id === 'hentaimama') {
        let posterKey = String(item.poster).split('?')[0].split('#')[0].toLowerCase();
        try {
          const posterUrl = new URL(posterKey);
          posterUrl.hostname = canonicalHost(posterUrl.hostname);
          posterKey = posterUrl.href;
        } catch {}
        duplicateKey = `${normalizedTextKey(item.name)}|${posterKey}`;
      }
      if (seenKeys.has(duplicateKey)) continue;
      seenKeys.add(duplicateKey);
      list.push({ ...item, providerId: provider.id });
      newItems++;
    }
    if (list.length >= desired || newItems === 0) break;
  }
  return list;
}
function interleaveCatalogLists(providerLists) {
  const combined = [];
  for (let i = 0; providerLists.some(list => i < list.length); i++) {
    for (const list of providerLists) if (list[i]) combined.push(list[i]);
  }
  return combined;
}

builder.defineCatalogHandler(async ({ id, extra = {} }) => {
  const selected = selectedProviders(id);
  if (!selected.length) return { metas: [], cacheMaxAge: 300 };
  const search = clean(extra.search);
  const genre = clean(extra.genre);
  const skip = Math.max(0, Number(extra.skip) || 0);

  // Fetch enough source pages to cover Stremio pagination, then apply skip.
  const targetPerProvider = Math.ceil((skip + PAGE_SIZE) / selected.length);
  const maxSourcePages = Math.min(3000, Math.max(2, Math.ceil(targetPerProvider / 8) + 2));
  const providerLists = await Promise.all(selected.map(provider => collectProviderCatalog(provider, {
    search, genre, target: targetPerProvider, maxPages: maxSourcePages,
  })));
  const combined = interleaveCatalogLists(providerLists);
  const metas = combined.slice(skip, skip + PAGE_SIZE).map(item => ({
    id: makeId(item.providerId, item.key),
    type: TYPE,
    name: item.name,
    poster: item.poster,
    posterShape: posterShapeFor(item, genre),
    ...(item.description ? { description: item.description } : {}),
    ...(item.genres?.length ? { genres: item.genres } : {}),
  }));
  return { metas, cacheMaxAge: Math.floor(CATALOG_TTL / 1000) };
});

builder.defineMetaHandler(async ({ id }) => {
  const parsed = parseId(id); if (!parsed) return { meta: null };
  const provider = PROVIDERS[parsed.providerId]; if (!provider) return { meta: null };
  try {
    const data = await provider.meta(parsed.key);
    if (!data || data.blocked || blocked(data)) return { meta: null };
    const episodes = Array.isArray(data.episodes) && data.episodes.length ? data.episodes : [{ key: parsed.key, title: data.name }];
    const seen = new Set();
    const videos = episodes.filter(ep => ep.key && !seen.has(ep.key) && seen.add(ep.key)).map((ep, index) => ({ id: makeId(parsed.providerId, ep.key), title: clean(ep.title) || `Part ${index + 1}`, season: 1, episode: index + 1, released: new Date(Date.UTC(2000, 0, 1 + index)).toISOString() }));
    return { meta: { id, type: TYPE, name: clean(data.name) || 'Untitled', ...(data.poster ? { poster: data.poster } : {}), ...(data.background || data.poster ? { background: data.background || data.poster } : {}), ...(data.description ? { description: data.description } : {}), ...(data.genres?.length ? { genres: data.genres } : {}), videos }, cacheMaxAge: Math.floor(DETAIL_TTL / 1000) };
  } catch (e) { console.error(`[${provider.name}] metadata failed: ${e.code || e.response?.status || e.message}`); return { meta: null, cacheMaxAge: 60 }; }
});

builder.defineStreamHandler(async ({ id }) => {
  const parsed = parseId(id); if (!parsed) return { streams: [] };
  const provider = PROVIDERS[parsed.providerId]; if (!provider) return { streams: [] };
  try {
    const ttl = parsed.providerId === 'hentaigasm' ? STREAM_TTL : FRESH_STREAM_TTL;
    const streams = await cached(`streams:${parsed.providerId}:${parsed.key}`, ttl, async () => {
      const resolved = await provider.streams(parsed.key);
      return parsed.providerId === 'hentaimama'
        ? (resolved || [])
        : expandHlsQualityStreams(resolved || []);
    });
    return { streams: (streams || []).slice(0, 20), cacheMaxAge: Math.floor(ttl / 1000) };
  } catch (e) { console.error(`[${provider.name}] streams failed: ${e.code || e.response?.status || e.message}`); return { streams: [], cacheMaxAge: 60 }; }
});

if (require.main === module) {
  const app = express();
  app.disable('x-powered-by');
  app.options('/hls/:token/:signature', hlsProxyHandler);
  app.get('/hls/:token/:signature', hlsProxyHandler);
  app.head('/hls/:token/:signature', hlsProxyHandler);
  app.options('/image/:token/:signature', hentaiMamaImageProxyHandler);
  app.get('/image/:token/:signature', hentaiMamaImageProxyHandler);
  app.head('/image/:token/:signature', hentaiMamaImageProxyHandler);
  app.use(getRouter(builder.getInterface()));
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Hentai v2.6.4 listening on port ${PORT}`);
    console.log(`Manifest: ${getAddonBaseUrl() || `http://127.0.0.1:${PORT}`}/manifest.json`);
    if (process.env.NODE_ENV === 'production' && !getAddonBaseUrl()) {
      console.warn('[HLS proxy] Set ADDON_BASE_URL to the public HTTPS address of this addon host.');
    }
  });
}

module.exports = {
  TYPE,
  manifest,
  PROVIDERS,
  PROVIDER_GENRES,
  HENTAIGASM_TAGS,
  posterShapeFor,
  isHentaiMamaMp4,
  isHlsUrl,
  createHlsProxyUrl,
  createHentaiMamaImageProxyUrl,
  verifyHlsProxyToken,
  verifyProxyToken,
  rewriteHlsPlaylist,
  selectedProviders,
  candidatePages,
  fetchCatalog,
  parseCards,
  parseHentaiMamaGenreCards,
  parseHentaiMamaRecentEpisodeCards,
  parseProviderCards,
  collectProviderCatalog,
  canonicalContentUrl,
  blocked,
  resolveHentaiMamaStreams,
  resolveStreams,
  hlsProxyHandler,
  hentaiMamaImageProxyHandler,
};
