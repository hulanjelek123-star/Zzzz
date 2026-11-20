'use strict';

// Node ports of the current yt-dlp Chaturbate, Stripchat and XVideos
// extraction flows. This keeps the addon self-contained (no Python binary).

function buildAdultProviders(deps) {
  const {
    http, cached, absUrl, normalizedTextKey, matchesCatalogSearch, streamObject,
    getHtmlFresh, candidateStreams, parseCards, cardPoster, blocked, cheerio,
    clean, PAGE_LIMIT, LIVE_PAGE_SIZE = 60, XVideos_BASE = 'https://www.xvideos.com',
  } = deps;
  const firstValue = (...values) => values.find(v => v !== undefined && v !== null && String(v).trim() !== '') ?? '';
  const safeUrl = (value, base) => absUrl(String(value || '').replace(/\\\//g, '/').replace(/&amp;/g, '&'), base);

  function classifyChaturbateGender(room) {
    const value = clean(firstValue(room?.gender, room?.gender_code, room?.room_gender, room?.gender_type)).toLowerCase();
    if (['f', 'female', 'woman'].includes(value)) return 'solo';
    if (['c', 'couple', 'couples', 'malefemale', 'male_female'].includes(value)) return 'couples';
    return '';
  }
  function classifyStripchatGender(model) {
    const value = clean(firstValue(model?.gender, model?.genderType, model?.modelType)).toLowerCase().replace(/[ _-]/g, '');
    if (['female', 'woman', 'girl'].includes(value)) return 'solo';
    if (['malefemale', 'couple', 'couples', 'mf'].includes(value)) return 'couples';
    return '';
  }
  function chaturbateRoomList(data) {
    for (const list of [data?.rooms, data?.data?.rooms, data?.items]) if (Array.isArray(list)) return list;
    return [];
  }
  function stripchatModelList(data) {
    for (const list of [data?.models, data?.data?.models, data?.items, data?.data?.items, data?.result?.models]) if (Array.isArray(list)) return list;
    return [];
  }
  function chaturbateRoomToItem(room) {
    const username = clean(firstValue(room?.username, room?.room_slug, room?.slug, room?.name));
    if (!username) return null;
    const url = `https://chaturbate.com/${encodeURIComponent(username)}/`;
    const poster = safeUrl(firstValue(room?.image_url, room?.image_url_medium, room?.image_url_small, room?.room_image, room?.thumbnail), url)
      || `https://roomimg.stream.highwebmedia.com/ri/${encodeURIComponent(username)}.jpg`;
    return {
      key: url,
      name: clean(firstValue(room?.display_name, room?.displayName, room?.nickname, username)),
      poster,
      description: clean(firstValue(room?.room_subject, room?.subject, room?.current_show)),
      genres: ['Live', 'Chaturbate'],
      providerGender: classifyChaturbateGender(room),
    };
  }
  function stripchatModelToItem(model) {
    const username = clean(firstValue(model?.username, model?.name, model?.slug));
    if (!username) return null;
    const url = `https://stripchat.com/${encodeURIComponent(username)}`;
    const poster = safeUrl(firstValue(model?.previewUrlThumbSmall, model?.previewUrl, model?.snapshotUrl, model?.image, model?.avatarUrl), url)
      || (model?.snapshotTimestamp && model?.id ? `https://img.doppiocdn.com/thumbs/${encodeURIComponent(model.snapshotTimestamp)}/${encodeURIComponent(model.id)}` : '');
    if (!poster) return null;
    return {
      key: url,
      name: clean(firstValue(model?.displayName, model?.username, model?.name)),
      poster,
      description: clean(firstValue(model?.topic, model?.roomSubject, model?.description)),
      genres: ['Live', 'Stripchat'],
      providerGender: classifyStripchatGender(model),
      live: model?.isLive === true || model?.isOnline === true,
      status: clean(model?.status || model?.broadcastStatus).toLowerCase(),
    };
  }

  async function fetchChaturbateCatalog(provider, { search = '', page = 1 } = {}) {
    const gender = provider.group === 'solo' ? 'f' : 'c';
    const offset = (Math.max(1, Number(page) || 1) - 1) * LIVE_PAGE_SIZE;
    const url = `https://chaturbate.com/api/ts/roomlist/room-list/?enable_recommendations=true&genders=${gender}&limit=${LIVE_PAGE_SIZE}&offset=${offset}`;
    const response = await http.get(url, { headers: {
      Accept: 'application/json, text/plain, */*', Referer: 'https://chaturbate.com/', 'X-Requested-With': 'XMLHttpRequest',
    } });
    const query = normalizedTextKey(search);
    return chaturbateRoomList(response.data).map(chaturbateRoomToItem)
      .filter(item => item && item.providerGender === provider.group && (!query || matchesCatalogSearch(item, search)))
      .map(({ providerGender, ...item }) => item);
  }

  async function fetchStripchatCatalog(provider, { search = '', page = 1 } = {}) {
    const offset = (Math.max(1, Number(page) || 1) - 1) * LIVE_PAGE_SIZE;
    const primaryTag = provider.group === 'couples' ? 'couples' : 'girls';
    const params = new URLSearchParams({ limit: String(LIVE_PAGE_SIZE), offset: String(offset), primaryTag, sortBy: 'stripRanking' });
    if (search) params.set('query', clean(search));
    const url = search
      ? `https://stripchat.com/api/front/v4/models/search/group/username?${new URLSearchParams({ query: clean(search), primaryTag, limit: String(LIVE_PAGE_SIZE) }).toString()}`
      : `https://stripchat.com/api/front/models?${params.toString()}`;
    const response = await http.get(url, { headers: {
      Accept: 'application/json, text/plain, */*', Referer: 'https://stripchat.com/', Origin: 'https://stripchat.com',
    } });
    const query = normalizedTextKey(search);
    return stripchatModelList(response.data).map(stripchatModelToItem)
      .filter(item => item && item.live && item.providerGender === provider.group
        && (!item.status || ['public', 'online', 'live'].includes(item.status))
        && (!query || matchesCatalogSearch(item, search)))
      .map(({ providerGender, live, status, ...item }) => item);
  }

  function extractBalancedJson(source, marker) {
    const text = String(source || '');
    const match = marker.exec(text);
    if (!match) return null;
    let start = match.index + match[0].length;
    while (start < text.length && /\s/.test(text[start])) start++;
    if (text[start] !== '{') return null;
    let depth = 0, quote = '', escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
    return null;
  }
  const atPath = (obj, path) => path.reduce((value, key) => value && typeof value === 'object' ? value[key] : undefined, obj);
  function stripchatHlsHosts(state) {
    const hosts = [];
    const paths = [
      ['configV3', 'static', 'features', 'hlsFallback', 'fallbackDomains'],
      ['config', 'data', 'features', 'hlsFallback', 'fallbackDomains'],
      ['configV3', 'static', 'featuresV2', 'hlsFallback', 'fallbackDomains'],
      ['config', 'data', 'featuresV2', 'hlsFallback', 'fallbackDomains'],
    ];
    for (const path of paths) {
      const found = atPath(state, path);
      if (Array.isArray(found)) hosts.push(...found);
    }
    for (const path of [
      ['configV3', 'static', 'features', 'hlsFallback', 'hlsStreamHost'],
      ['config', 'data', 'features', 'hlsFallback', 'hlsStreamHost'],
    ]) hosts.push(atPath(state, path));
    return [...new Set(hosts.map(v => clean(typeof v === 'string' ? v : v?.host || v?.hostname)).filter(Boolean))];
  }

  async function resolveChaturbateStreams(pageUrl) {
    const parsed = new URL(pageUrl);
    const slug = parsed.pathname.split('/').filter(Boolean)[0];
    if (!slug) return [];
    const headers = {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest', Origin: parsed.origin, Referer: `${parsed.origin}/${slug}/`,
    };
    let hlsUrl = '', roomStatus = '';
    try {
      const response = await http.post(`${parsed.origin}/get_edge_hls_url_ajax/`, new URLSearchParams({ room_slug: slug }).toString(), { headers });
      hlsUrl = safeUrl(response.data?.url, pageUrl);
      roomStatus = clean(response.data?.room_status).toLowerCase();
    } catch (error) {
      console.warn(`[Chaturbate] HLS API failed (${slug}): ${error.code || error.response?.status || error.message}`);
    }
    if (!hlsUrl && ['private', 'hidden', 'password protected', 'away', 'offline'].includes(roomStatus)) return [];
    if (!hlsUrl) {
      try {
        const html = await getHtmlFresh(`${parsed.origin}/${slug}/`, pageUrl, { Referer: `${parsed.origin}/` });
        const dossierMatch = html.match(/initialRoomDossier\s*=\s*(["'])([\s\S]*?)\1/);
        if (dossierMatch) {
          let dossierText = dossierMatch[2];
          try { dossierText = JSON.parse(`"${dossierText}"`); } catch {}
          try { hlsUrl = safeUrl(JSON.parse(dossierText)?.hls_source, pageUrl); } catch {}
        }
        if (!hlsUrl) {
          for (const match of html.matchAll(/https?:\\?\/\\?\/[^"'\\\s<>]+?\.m3u8[^"'\\\s<>]*/gi)) {
            hlsUrl = safeUrl(match[0], pageUrl);
            if (hlsUrl) break;
          }
        }
      } catch (error) {
        console.warn(`[Chaturbate] HTML fallback failed (${slug}): ${error.code || error.response?.status || error.message}`);
      }
    }
    if (!hlsUrl) return [];
    const variants = [...new Set([hlsUrl, hlsUrl.replace('_fast', '')])];
    return variants.map(url => {
      const stream = streamObject('Chaturbate', url, `${parsed.origin}/${slug}/`, false, '');
      stream.title = `${url.includes('_fast') ? 'Fast' : 'Standard'} · HLS`;
      return stream;
    });
  }

  async function resolveStripchatStreams(pageUrl) {
    const responseHtml = await getHtmlFresh(pageUrl, 'https://stripchat.com/', { Referer: 'https://stripchat.com/' });
    const state = extractBalancedJson(responseHtml, /<script\b[^>]*>\s*window\.__PRELOADED_STATE__\s*=\s*/i);
    if (!state) return [];
    const cam = state.viewCam || {};
    if (cam.show && typeof cam.show === 'object') return [];
    if (cam.model?.isLive !== true) return [];
    const modelId = firstValue(cam.model.id, cam.model.modelId);
    if (!modelId) return [];
    for (const host of stripchatHlsHosts(state)) {
      const hostname = host.replace(/^https?:\/\//i, '').replace(/\/$/, '');
      const hlsHost = hostname.startsWith('edge-hls.') ? hostname : `edge-hls.${hostname}`;
      const url = `https://${hlsHost}/hls/${encodeURIComponent(modelId)}/master/${encodeURIComponent(modelId)}_auto.m3u8`;
      try { return [streamObject('Stripchat', url, pageUrl, false, '')]; } catch {}
    }
    console.warn(`[Stripchat] no public HLS host found for ${new URL(pageUrl).pathname}`);
    return [];
  }

  function parseXVideosCards(html, base) {
    const $ = cheerio.load(html);
    const out = [], seen = new Set();
    $('.thumb-block, .thumb').each((_, element) => {
      const $root = $(element);
      const $card = $root.closest('.thumb-block').length ? $root.closest('.thumb-block') : $root;
      const links = $card.find('a[href*="/video"]').toArray();
      let selected = null;
      for (const link of links) {
        const href = safeUrl($(link).attr('href'), base);
        if (href && /\/video\.?[0-9a-z]+/i.test(new URL(href).pathname)) { selected = $(link); break; }
      }
      if (!selected) return;
      const key = safeUrl(selected.attr('href'), base);
      if (!key || seen.has(key)) return;
      const poster = cardPoster($, $card, selected, base);
      const name = clean($card.find('.title, .thumb-under p, .video-title').first().text())
        || clean(selected.attr('title')) || clean(selected.find('img').first().attr('alt'));
      if (!poster || !name || blocked({ name })) return;
      seen.add(key);
      out.push({ key, name, poster, genres: ['XVideos'], description: clean($card.find('.duration').first().text()) });
    });
    if (out.length) return out;
    return parseCards(html, base).filter(item => {
      try { return /\/video\.?[0-9a-z]+/i.test(new URL(item.key).pathname); } catch { return false; }
    }).slice(0, PAGE_LIMIT);
  }

  async function fetchXVideosCatalog({ search = '', page = 1 } = {}) {
    const q = clean(search);
    const route = q
      ? `/?k=${encodeURIComponent(q)}${Number(page) > 1 ? `&p=${Math.max(1, Number(page) || 1)}` : ''}`
      : (Number(page) > 1 ? `/new/${Math.max(1, Number(page) || 1)}/` : '/new/');
    const url = `${XVideos_BASE.replace(/\/$/, '')}${route}`;
    return parseXVideosCards(await getHtmlFresh(url, XVideos_BASE), url);
  }

  async function resolveXVideosStreams(pageUrl) {
    const html = await getHtmlFresh(pageUrl, XVideos_BASE);
    const streams = [], seen = new Set();
    const add = (raw, label = '') => {
      const url = safeUrl(raw, pageUrl);
      if (!url || seen.has(url)) return;
      let parsed;
      try { parsed = new URL(url); } catch { return; }
      if (!/\.(?:mp4|flv|m3u8)(?:$|[?#])/i.test(parsed.pathname + parsed.search)) return;
      seen.add(url);
      try {
        const stream = streamObject('XVideos', url, pageUrl, false, html);
        if (label) stream.title = `${label} · ${parsed.pathname.toLowerCase().endsWith('.m3u8') ? 'HLS' : 'MP4'}`;
        streams.push(stream);
      } catch {}
    };

    // Same discovery logic as yt-dlp's current XVideosIE.
    const flvMatch = html.match(/flv_url=(.+?)&/i);
    if (flvMatch) {
      let flvUrl = flvMatch[1];
      try { flvUrl = decodeURIComponent(flvUrl); } catch {}
      add(flvUrl, 'Legacy');
    }
    for (const match of html.matchAll(/setVideo([^(]+)\(\s*(["'])(https?:\/\/.*?)\2\s*\)/gi)) {
      const kind = clean(match[1]).toLowerCase();
      if (kind === 'hls') add(match[3], 'Adaptive');
      else if (kind === 'urlhigh') add(match[3], 'High');
      else if (kind === 'urllow') add(match[3], 'Low');
    }
    if (!streams.length) {
      const found = candidateStreams(html, pageUrl);
      for (const url of found.media) add(url, '');
    }
    return streams;
  }

  function liveProvider(config) {
    return {
      ...config,
      async catalog(args) {
        const key = `${config.id}|page:${Math.max(1, Number(args.page) || 1)}|search:${clean(args.search).toLowerCase()}`;
        return cached(`live-catalog:${key}`, 45000, () => config.site === 'chaturbate'
          ? fetchChaturbateCatalog(config, args) : fetchStripchatCatalog(config, args));
      },
      async meta(key) {
        const slug = (() => { try { return new URL(key).pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; } })();
        let poster = config.site === 'chaturbate' ? `https://roomimg.stream.highwebmedia.com/ri/${encodeURIComponent(slug)}.jpg` : '';
        let description = `${config.name} public live room`;
        if (config.site === 'stripchat') {
          try {
            const html = await getHtmlFresh(key, 'https://stripchat.com/', { Referer: 'https://stripchat.com/' });
            const $ = cheerio.load(html);
            poster = clean($('meta[property="og:image"]').first().attr('content')) || poster;
            description = clean($('meta[property="og:description"]').first().attr('content')) || description;
          } catch {}
        }
        return { name: slug, ...(poster ? { poster } : {}), description, genres: ['Live'], episodes: [{ key, title: 'Live' }] };
      },
      streams: key => config.site === 'chaturbate' ? resolveChaturbateStreams(key) : resolveStripchatStreams(key),
    };
  }

  const chaturbateSolo = liveProvider({ id: 'chaturbate-solo', name: 'Chaturbate', catalogName: 'Chaturbate · Solo Girl', site: 'chaturbate', group: 'solo' });
  const chaturbateCouples = liveProvider({ id: 'chaturbate-couples', name: 'Chaturbate', catalogName: 'Chaturbate · Couples', site: 'chaturbate', group: 'couples' });
  const stripchatSolo = liveProvider({ id: 'stripchat-solo', name: 'Stripchat', catalogName: 'Stripchat · Solo Girl', site: 'stripchat', group: 'solo' });
  const stripchatCouples = liveProvider({ id: 'stripchat-couples', name: 'Stripchat', catalogName: 'Stripchat · Couples', site: 'stripchat', group: 'couples' });
  const xvideos = {
    id: 'xvideos', name: 'XVideos', catalogName: 'XVideos', base: XVideos_BASE,
    async catalog(args) {
      const key = `xvideos|page:${Math.max(1, Number(args.page) || 1)}|search:${clean(args.search).toLowerCase()}`;
      return cached(`parsed-catalog:${key}`, 600000, () => fetchXVideosCatalog(args));
    },
    async meta(key) {
      const html = await getHtmlFresh(key, XVideos_BASE);
      const $ = cheerio.load(html);
      const meta = selectors => {
        for (const selector of selectors) {
          const node = $(selector).first();
          const value = clean(node.attr('content') || node.text());
          if (value) return value;
        }
        return '';
      };
      return {
        name: meta(['meta[property="og:title"]', 'h1', 'title']) || (() => { try { return new URL(key).pathname.split('/').filter(Boolean).pop(); } catch { return 'XVideos'; } })(),
        poster: meta(['meta[property="og:image"]', 'meta[name="twitter:image"]']),
        description: meta(['meta[property="og:description"]']),
        genres: ['XVideos'], episodes: [{ key, title: 'Video' }],
      };
    },
    streams: resolveXVideosStreams,
  };

  return {
    providers: { chaturbateSolo, chaturbateCouples, stripchatSolo, stripchatCouples, xvideos },
    helpers: {
      classifyChaturbateGender, classifyStripchatGender, chaturbateRoomList, stripchatModelList,
      extractBalancedJson, parseXVideosCards, fetchXVideosCatalog,
      resolveChaturbateStreams, resolveStripchatStreams, resolveXVideosStreams,
    },
  };
}

module.exports = { buildAdultProviders };
