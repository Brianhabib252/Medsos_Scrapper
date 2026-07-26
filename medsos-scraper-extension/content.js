(() => {
  const STORAGE_RESULTS = "social_scraper_results";
  const STORAGE_STATUS = "social_scraper_status";
  const FACEBOOK_POST_ROOT_SELECTOR = [
    '[role="article"]',
    "article",
    'div[data-pagelet^="FeedUnit"]',
    "main div[aria-posinset]",
    '[role="main"] div[aria-posinset]'
  ].join(", ");
  const FACEBOOK_POST_MEDIA_LINK_SELECTOR = [
    'a[href*="/photo/"][href*="fbid="]',
    'a[href*="photo.php"][href*="fbid="]',
    'a[href*="/videos/"]',
    'a[href*="/watch/"]',
    'a[href*="/reel/"]'
  ].join(", ");

  const PLATFORM_CONFIG = {
    instagram: {
      label: "Instagram",
      postLinkSelector: 'a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]'
    },
    tiktok: {
      label: "TikTok",
      postLinkSelector: 'a[href*="/video/"], a[href*="/photo/"]'
    },
    facebook: {
      label: "Facebook",
      postLinkSelector: [
        'a[href*="/posts/"]',
        'a[href*="/permalink/"]',
        'a[href*="permalink.php"]',
        'a[href*="story_fbid="]',
        'a[href*="/photo/"][href*="fbid="]',
        'a[href*="photo.php"][href*="fbid="]',
        'a[href*="/videos/"]',
        'a[href*="/watch/"]',
        'a[href*="/reel/"]'
      ].join(", ")
    }
  };

  let run = {
    active: false,
    sessionId: 0,
    platform: "",
    seen: new Set(),
    results: [],
    addedCount: 0,
    options: {}
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SCS_START") {
      start(message.payload || {});
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === "SCS_STOP") {
      stop("Dihentikan", "Proses dihentikan oleh user.");
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });

  async function start(options) {
    if (run.active) {
      await setStatus("running", "Masih berjalan", "Proses sebelumnya masih berjalan.");
      return;
    }

    const platform = resolvePlatform(options.platform);
    if (!platform) {
      await setStatus("idle", "Platform tidak didukung", "Buka halaman Instagram, TikTok, atau Facebook terlebih dahulu.");
      return;
    }

    const sessionId = run.sessionId + 1;
    run = {
      ...run,
      active: true,
      sessionId,
      platform
    };

    const stored = await chrome.storage.local.get([STORAGE_RESULTS]);
    if (!isRunActive(sessionId)) return;

    const existing = Array.isArray(stored[STORAGE_RESULTS]) ? stored[STORAGE_RESULTS] : [];

    run = {
      active: true,
      sessionId,
      platform,
      seen: new Set(existing.map((item) => item.url).filter(Boolean)),
      results: existing,
      addedCount: 0,
      options: {
        startDate: options.startDate || "",
        untilDate: options.untilDate || "",
        maxPosts: clamp(Number(options.maxPosts || 300), 1, 1000),
        delayMs: clamp(Number(options.delayMs || 1400), 600, 5000)
      }
    };

    await setStatus(
      "running",
      "Mulai scraping",
      `Membaca daftar post dari halaman ${PLATFORM_CONFIG[platform].label}.`
    );
    scrapeLoop(sessionId).catch(async (error) => {
      if (!isRunActive(sessionId)) return;
      run.active = false;
      await setStatus("idle", "Terjadi masalah", error.message || "Scraper berhenti.");
    });
  }

  function isRunActive(sessionId) {
    return run.active && run.sessionId === sessionId;
  }

  async function stop(title = "Berhenti", message = "Scraper berhenti.", sessionId = null) {
    if (sessionId !== null && run.sessionId !== sessionId) return;
    run.active = false;
    await setStatus("idle", title, message);
  }

  async function appendPostResult(postData, sessionId) {
    if (!isRunActive(sessionId) || run.addedCount >= run.options.maxPosts) {
      return false;
    }

    run.results.push(postData);
    run.addedCount += 1;
    await chrome.storage.local.set({ [STORAGE_RESULTS]: run.results });
    return true;
  }

  async function finishRun(sessionId) {
    if (!isRunActive(sessionId)) return;

    if (run.addedCount >= run.options.maxPosts) {
      await stop(
        "Mencapai batas post",
        `Berhasil mengambil maksimal ${run.options.maxPosts} post baru.`,
        sessionId
      );
      return;
    }

    await stop("Selesai", `Mengambil ${run.addedCount} post baru.`, sessionId);
  }

  async function scrapeLoop(sessionId) {
    const startDate = parseStartDate(run.options.startDate);
    const cutoff = parseCutoff(run.options.untilDate);
    if (run.platform === "facebook") {
      await scrapeFacebookFeedLoop(startDate, cutoff, sessionId);
      return;
    }

    let staleScrolls = 0;

    while (isRunActive(sessionId) && run.addedCount < run.options.maxPosts) {
      const links = collectPostLinks(run.platform);
      const nextIndex = links.findIndex((link) => !run.seen.has(getPostElementUrl(run.platform, link)));
      const nextLink = nextIndex >= 0 ? links[nextIndex] : null;

      if (!nextLink) {
        const moved = await scrollForMorePosts();
        staleScrolls = moved ? 0 : staleScrolls + 1;

        if (staleScrolls >= 4) {
          await stop("Selesai", "Tidak ada post baru yang terlihat setelah scroll.", sessionId);
          return;
        }
        continue;
      }

      const postUrl = getPostElementUrl(run.platform, nextLink);
      const linkContext = {
        gridIndex: nextIndex,
        isPinned: isLikelyPinnedPostLink(nextLink, nextIndex, run.platform)
      };

      run.seen.add(postUrl);
      await setStatus(
        "running",
        "Membaca post",
        `Mengambil data ke-${run.addedCount + 1}: ${getPostId(run.platform, postUrl) || postUrl}`
      );

      const postData = await scrapePostFromLink(nextLink, postUrl, linkContext);
      if (!isRunActive(sessionId)) return;

      if (postData) {
        if (isNewerThanStartDate(startDate, postData)) {
          await setStatus(
            "running",
            "Lewati post terbaru",
            `Post ${formatDateForStatus(postData.postedAt)} lebih baru dari tanggal mulai, jadi belum disimpan.`
          );
          await sleep(run.options.delayMs);
          continue;
        }

        if (isOlderThanCutoff(cutoff, postData)) {
          if (shouldSkipOldPostWithoutStopping(postData)) {
            await setStatus(
              "running",
              "Lewati post lama",
              `Post ${formatDateForStatus(postData.postedAt)} lebih lama dari batas dan dilewati agar post biasa tetap diproses.`
            );
            await sleep(run.options.delayMs);
            continue;
          }

          await stop(
            "Mencapai tanggal batas",
            `Post ${formatDateForStatus(postData.postedAt)} lebih lama dari tanggal batas, jadi tidak disimpan.`,
            sessionId
          );
          return;
        }

        if (!await appendPostResult(postData, sessionId)) break;
      }

      await sleep(run.options.delayMs);
    }

    await finishRun(sessionId);
  }

  async function scrapeFacebookFeedLoop(startDate, cutoff, sessionId) {
    let staleScrolls = 0;

    while (isRunActive(sessionId) && run.addedCount < run.options.maxPosts) {
      const articles = collectFacebookFeedArticles();

      for (let index = 0; index < articles.length && isRunActive(sessionId) && run.addedCount < run.options.maxPosts; index += 1) {
        const article = articles[index];
        const postUrl = getPostElementUrl("facebook", article);
        if (!postUrl || run.seen.has(postUrl)) continue;

        run.seen.add(postUrl);

        const linkContext = {
          gridIndex: index,
          isPinned: isLikelyPinnedPostLink(article, index, "facebook")
        };

        await setStatus(
          "running",
          "Membaca post Facebook",
          `Mengambil data ke-${run.addedCount + 1}: ${getPostId("facebook", postUrl) || postUrl}`
        );

        const postData = await scrapeFacebookPostFromLink(article, postUrl, linkContext);
        if (!isRunActive(sessionId)) return;

        if (!postData) {
          await sleep(run.options.delayMs);
          continue;
        }

        if (isNewerThanStartDate(startDate, postData)) {
          await setStatus(
            "running",
            "Lewati post terbaru",
            `Post ${formatDateForStatus(postData.postedAt)} lebih baru dari tanggal mulai, jadi belum disimpan.`
          );
          await sleep(run.options.delayMs);
          continue;
        }

        if (isOlderThanCutoff(cutoff, postData)) {
          if (shouldSkipOldPostWithoutStopping(postData)) {
            await setStatus(
              "running",
              "Lewati post lama",
              `Post ${formatDateForStatus(postData.postedAt)} lebih lama dari batas dan dilewati agar post biasa tetap diproses.`
            );
            await sleep(run.options.delayMs);
            continue;
          }

          await stop(
            "Mencapai tanggal batas",
            `Post ${formatDateForStatus(postData.postedAt)} lebih lama dari tanggal batas, jadi tidak disimpan.`,
            sessionId
          );
          return;
        }

        if (!await appendPostResult(postData, sessionId)) break;
        await sleep(run.options.delayMs);
      }

      if (!isRunActive(sessionId) || run.addedCount >= run.options.maxPosts) {
        break;
      }

      const lastArticle = articles.at(-1) || null;
      const moved = await scrollForMorePosts(lastArticle);
      staleScrolls = moved ? 0 : staleScrolls + 1;

      if (staleScrolls >= 4) {
        await stop("Selesai", "Tidak ada post Facebook baru yang terlihat setelah beberapa kali scroll.", sessionId);
        return;
      }
    }

    await finishRun(sessionId);
  }

  function resolvePlatform(requestedPlatform) {
    if (requestedPlatform && PLATFORM_CONFIG[requestedPlatform]) return requestedPlatform;
    if (location.hostname.includes("instagram.com")) return "instagram";
    if (location.hostname.includes("tiktok.com")) return "tiktok";
    if (location.hostname.includes("facebook.com")) return "facebook";
    return "";
  }

  function isOlderThanCutoff(cutoff, postData) {
    if (!cutoff || !postData?.postedAt) return false;

    const postedDate = new Date(postData.postedAt);
    return !Number.isNaN(postedDate.getTime()) && postedDate < cutoff;
  }

  function isNewerThanStartDate(startDate, postData) {
    if (!startDate || !postData?.postedAt) return false;

    const postedDate = new Date(postData.postedAt);
    return !Number.isNaN(postedDate.getTime()) && postedDate > startDate;
  }

  function shouldSkipOldPostWithoutStopping(postData) {
    if (!postData) return false;
    if (postData.isPinned) return true;
    if (postData.platform === "facebook") return false;
    return Boolean(postData.isTopGridCandidate);
  }

  function formatDateForStatus(value) {
    if (!value) return "tanpa tanggal";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
  }

  function collectPostLinks(platform) {
    if (platform === "facebook") {
      return collectFacebookFeedArticles();
    }

    if (platform === "tiktok" && isProfilePage("tiktok")) {
      return collectTikTokProfileLinks();
    }

    const config = PLATFORM_CONFIG[platform];
    const unique = new Map();
    document.querySelectorAll(config.postLinkSelector).forEach((link) => {
      const href = cleanPostUrl(platform, link.href);
      if (!href || !getPostId(platform, href)) return;
      unique.set(href, link);
    });
    return [...unique.values()];
  }

  function collectTikTokProfileLinks() {
    const unique = new Map();
    const roots = [...document.querySelectorAll('[data-e2e="user-post-item"]')];

    roots.forEach((root) => {
      if (isTikTokRecommendationCard(root)) return;

      const link = [...root.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]')]
        .find((candidate) => isTikTokProfilePostLink(candidate));
      if (!link) return;

      const href = cleanPostUrl("tiktok", link.href);
      if (!href || !getPostId("tiktok", href)) return;
      unique.set(href, link);
    });

    if (unique.size > 0) {
      return [...unique.values()];
    }

    document.querySelectorAll(PLATFORM_CONFIG.tiktok.postLinkSelector).forEach((link) => {
      if (!isTikTokProfilePostLink(link)) return;

      const href = cleanPostUrl("tiktok", link.href);
      if (!href || !getPostId("tiktok", href)) return;
      unique.set(href, link);
    });

    return [...unique.values()];
  }

  function isTikTokProfilePostLink(link) {
    if (!link?.href) return false;

    const href = cleanPostUrl("tiktok", link.href);
    const profileHandle = getTikTokProfileHandle();
    if (!href || !profileHandle) return false;

    const path = getPathname(href);
    if (!new RegExp(`^/${escapeRegex(profileHandle)}/(?:video|photo)/[^/]+$`, "i").test(path)) {
      return false;
    }

    const root = link.closest('[data-e2e="user-post-item"]') || getPostCardRoot(link);
    if (isTikTokRecommendationCard(root)) return false;

    return isElementVisiblyRenderable(link);
  }

  function isTikTokRecommendationCard(root) {
    if (!root) return false;
    if (root.closest?.('[data-e2e*="recommend" i]')) return true;

    let node = root;
    for (let depth = 0; node && depth < 4; depth += 1) {
      const text = normalizeText(node.innerText || node.textContent || "").toLowerCase();
      if (/\b(you may like|recommended|for you|mungkin anda suka|untuk anda|disarankan untuk anda)\b/i.test(text)) {
        return true;
      }
      node = node.parentElement;
    }

    return false;
  }

  function getTikTokProfileHandle() {
    const match = location.pathname.match(/^\/(@[^/]+)\/?$/i);
    return match?.[1] || "";
  }

  function collectFacebookFeedArticles() {
    const unique = new Map();
    const articleRoots = [...document.querySelectorAll(FACEBOOK_POST_ROOT_SELECTOR)];
    const contextualRoots = [...document.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-testid="post_message"]')]
      .map((node) => node.closest(FACEBOOK_POST_ROOT_SELECTOR) || normalizeFacebookPostRoot(findFacebookPostRootFromNode(node)))
      .filter(Boolean);
    const mediaRoots = [...document.querySelectorAll(FACEBOOK_POST_MEDIA_LINK_SELECTOR)]
      .filter((link) => link.closest('[role="main"], main'))
      .map((link) => findFacebookMediaPostRoot(link))
      .filter(Boolean);
    const postRoots = [...new Set([...articleRoots, ...contextualRoots, ...mediaRoots])]
      .filter(isLikelyFacebookPostRoot)
      .filter(isVisibleFacebookFeedRoot)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

    postRoots.forEach((root, index) => {
      const link = findBestFacebookPostLink(root);
      const href = link
        ? cleanPostUrl("facebook", link.href)
        : makeSyntheticFacebookPostUrl(root, index);
      const postId = getPostId("facebook", href);
      if (!href || !postId) return;

      root.__scsPostHref = href;
      const existing = unique.get(href);
      if (!existing || scoreFacebookExtractionRootQuality(root) >= scoreFacebookExtractionRootQuality(existing)) {
        unique.set(href, root);
      }
    });

    return [...unique.values()];
  }

  function scoreFacebookExtractionRootQuality(root) {
    if (!root) return -Infinity;

    let score = 0;
    const headerBand = getFacebookHeaderBand(root);
    const authorNode = findFacebookAuthorNode(root, headerBand);
    const rawDateText = extractFacebookRawDateText(root);
    const caption = extractFacebookCaption(root);
    const bestLink = findBestFacebookPostLink(root);
    const text = normalizeText(root.innerText || root.textContent || "");

    if (authorNode) score += 160;
    if (rawDateText) score += 260;
    if (caption) score += 120;
    if (bestLink) score += 60;
    if (/\b(like|comment|share|suka|komentar|bagikan)\b/i.test(text)) score += 40;
    if (root.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-testid="post_message"]')) score += 40;

    return score;
  }

  function resolveFacebookStablePostRoot(linkOrRoot, fallbackRoot = null) {
    const candidates = [
      getFacebookPostCardRoot(linkOrRoot),
      fallbackRoot
    ]
      .filter(Boolean)
      .map((root) => normalizeFacebookPostRoot(root))
      .filter(Boolean)
      .filter((root, index, array) => array.indexOf(root) === index);

    return candidates.sort((a, b) => scoreFacebookExtractionRootQuality(b) - scoreFacebookExtractionRootQuality(a))[0] || null;
  }

  function dispatchFacebookHoverEvents(node) {
    if (!node?.dispatchEvent) return;

    const rect = node.getBoundingClientRect?.();
    const clientX = rect ? rect.left + Math.min(rect.width / 2, 16) : 0;
    const clientY = rect ? rect.top + Math.min(rect.height / 2, 16) : 0;
    ["mouseenter", "mouseover", "mousemove"].forEach((eventName) => {
      try {
        node.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX,
          clientY
        }));
      } catch {
        // Ignore event dispatch failures on experimental Facebook nodes.
      }
    });
  }

  function collectFacebookHeaderProbeTargets(root) {
    if (!root) return [];

    const headerBand = getFacebookHeaderBand(root);
    const authorNode = findFacebookAuthorNode(root, headerBand);
    const authorHref = cleanPostUrl("facebook", authorNode?.href || authorNode?.closest?.("a[href]")?.href || "");
    const messageContainer = getFacebookMessageContainer(root);
    const candidates = [
      ...collectFacebookHeaderDateCandidates(root),
      ...collectFacebookAuthorAdjacentNodes(authorNode, root).map((node) => ({ node, score: 0 }))
    ]
      .map((item) => item?.node || item)
      .filter(Boolean)
      .concat([...root.querySelectorAll('span, div, abbr, time, a[href], [aria-labelledby], [aria-label], [title], [data-tooltip-content], [data-utime]')]
        .filter((node) => isNodeInsideFacebookHeaderBand(node, headerBand)));

    return candidates
      .filter((node, index, array) => array.indexOf(node) === index)
      .filter((node) => {
        if (node === authorNode) return false;
        if (messageContainer?.contains(node) && node !== messageContainer) return false;
        if (node.querySelector?.("img, video")) return false;

        const rect = node.getBoundingClientRect?.();
        if (!rect || rect.width > 260 || rect.height > 44) return false;

        const href = cleanPostUrl("facebook", node.href || node.closest?.("a[href]")?.href || "");
        if (authorHref && href && getComparableFacebookUrl(href) === getComparableFacebookUrl(authorHref)) return false;
        return true;
      })
      .map((node) => {
        const rect = node.getBoundingClientRect?.();
        const authorRect = authorNode?.getBoundingClientRect?.();
        const text = collectFacebookDirectDateText(node, authorNode) || normalizeText(node.innerText || node.textContent || "");
        const token = extractFacebookDateToken(text);
        const href = cleanPostUrl("facebook", node.href || "");
        let score = 0;

        if (token) score += 260;
        if (node.hasAttribute?.("aria-labelledby") || node.hasAttribute?.("aria-describedby")) score += 120;
        if (node.tagName?.toLowerCase() !== "a") score += 40;
        if (href && /\/posts\/|\/permalink\/|permalink\.php|story_fbid=|\/videos\/|\/watch\/|\/reel\/|\/photo\//i.test(href)) score += 70;
        if (rect && authorRect) {
          score -= Math.min(120, Math.abs(rect.top - authorRect.bottom) * 2);
          score -= Math.min(80, Math.abs(rect.left - authorRect.left));
        }

        return { node, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((item) => item.node);
  }

  function getFacebookHeaderInteractionTarget(root) {
    return collectFacebookHeaderProbeTargets(root)[0]
      || findFacebookTimestampLink(root)
      || findBestFacebookPostLink(root)
      || null;
  }

  function getFacebookHeaderAnchor(root) {
    if (!root) return null;

    const headerBand = getFacebookHeaderBand(root);
    return getFacebookHeaderInteractionTarget(root)
      || findFacebookAuthorNode(root, headerBand)
      || root;
  }

  function scrollFacebookHeaderIntoView(root) {
    const target = getFacebookHeaderAnchor(root);
    if (!target?.scrollIntoView) return;

    target.scrollIntoView({ block: "start", inline: "nearest" });
    try {
      window.scrollBy({ top: -120, left: 0, behavior: "auto" });
    } catch {
      window.scrollBy(0, -120);
    }
  }

  async function primeFacebookPostHeader(root) {
    if (!root) return;

    const target = getFacebookHeaderInteractionTarget(root);
    if (!target) return;

    scrollFacebookHeaderIntoView(root);
    try {
      target.focus?.({ preventScroll: true });
    } catch {
      // Some Facebook nodes do not support focus options.
    }
    dispatchFacebookHoverEvents(target);
    await sleep(220);
  }

  async function stabilizeFacebookPostDate(linkOrRoot) {
    let bestRoot = resolveFacebookStablePostRoot(linkOrRoot) || getFacebookPostCardRoot(linkOrRoot);
    if (extractFacebookRawDateText(bestRoot)) return bestRoot;

    // Facebook often hydrates the header timestamp link after the card is visible.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await primeFacebookPostHeader(bestRoot);
      await sleep(attempt === 0 ? 420 : 260);

      const resolvedRoot = resolveFacebookStablePostRoot(linkOrRoot, bestRoot) || bestRoot;
      if (scoreFacebookExtractionRootQuality(resolvedRoot) >= scoreFacebookExtractionRootQuality(bestRoot)) {
        bestRoot = resolvedRoot;
      }

      if (extractFacebookRawDateText(bestRoot)) {
        return bestRoot;
      }
    }

    return bestRoot;
  }

  function getPostElementUrl(platform, element) {
    if (platform === "facebook") {
      return cleanPostUrl("facebook", element.__scsPostHref || findBestFacebookPostLink(element)?.href || element.href || makeSyntheticFacebookPostUrl(element, 0));
    }

    return cleanPostUrl(platform, element.href);
  }

  function isLikelyPinnedPostLink(link, index, platform) {
    const label = collectNearbyLabels(link).toLowerCase();
    if (/(^|\s)(pinned|pin post|pinned post|disematkan|sematan|sematkan)(\s|$)/i.test(label)) {
      return true;
    }

    if (platform === "facebook") {
      return false;
    }

    return isProfilePage(platform) && index >= 0 && index < 3;
  }

  function collectNearbyLabels(link) {
    const parts = [];
    let node = link;

    for (let depth = 0; node && depth < 6; depth += 1) {
      if (node.getAttribute) {
        parts.push(node.getAttribute("aria-label") || "");
        parts.push(node.getAttribute("title") || "");
      }

      node.querySelectorAll?.("[aria-label], title").forEach((child) => {
        parts.push(child.getAttribute?.("aria-label") || "");
        parts.push(child.getAttribute?.("title") || "");
        parts.push(child.textContent || "");
      });

      node = node.parentElement;
    }

    return normalizeText(parts.join(" "));
  }

  function isProfilePage(platform) {
    const path = location.pathname.replace(/^\/+|\/+$/g, "");
    if (!path) return false;

    if (platform === "tiktok") {
      return /^@[^/]+$/.test(path);
    }

    if (platform === "facebook") {
      return !/^(watch|reel|reels|groups|events|marketplace|gaming|stories|photo|permalink.php)(\/|$)/.test(path);
    }

    return !/^(p|reel|tv|stories|explore|direct|accounts|about|developer|legal)(\/|$)/.test(path);
  }

  async function scrapePostFromLink(link, postUrl, linkContext = {}) {
    if (run.platform === "tiktok") {
      return scrapeTikTokPostFromLink(link, postUrl, linkContext);
    }

    if (run.platform === "facebook") {
      return scrapeFacebookPostFromLink(link, postUrl, linkContext);
    }

    const beforeUrl = location.href;
    link.scrollIntoView({ block: "center", inline: "center" });
    await sleep(450);
    link.click();

    await waitFor(() => location.href !== beforeUrl || getPostRoot(run.platform), 12000);
    await sleep(run.platform === "tiktok" ? 1300 : 900);

    expandCaptionText(getPostRoot(run.platform) || document);
    await sleep(250);

    const data = extractInstagramVisiblePostData(postUrl, {
      ...linkContext,
      previewType: detectPreviewType(link, postUrl, run.platform)
    });
    await closePost(beforeUrl, run.platform);
    return data;
  }

  async function scrapeTikTokPostFromLink(link, postUrl, linkContext = {}) {
    const beforeUrl = location.href;
    const cardData = extractTikTokCardData(link, postUrl, linkContext);

    link.scrollIntoView({ block: "center", inline: "center" });
    await sleep(450);
    link.click();

    const opened = await waitFor(() => {
      return isTikTokPostUrl(location.href) || Boolean(getTikTokDetailRoot());
    }, 15000);

    if (!opened) {
      await setStatus(
        "running",
        "Detail TikTok tidak terbuka",
        "Data dasar diambil dari kartu post yang terlihat, lalu lanjut ke post berikutnya."
      );
      return cardData;
    }

    await sleep(1700);
    expandCaptionText(getTikTokDetailRoot() || getTikTokPostRoot() || document);
    await sleep(250);

    const detailData = extractTikTokVisiblePostData(postUrl, {
      ...linkContext,
      previewType: detectPreviewType(link, postUrl, run.platform)
    });

    await closePost(beforeUrl, run.platform);
    return mergeTikTokPostData(cardData, detailData);
  }

  function extractInstagramVisiblePostData(fallbackUrl, linkContext = {}) {
    const article = getInstagramPostArticle() || document;
    const time = article.querySelector("time[datetime]") || document.querySelector("time[datetime]");
    const postedAt = time?.getAttribute("datetime") || "";
    const fullText = normalizeText(article.innerText || "");
    const likeInfo = extractInstagramLikeCount(fullText);
    const commentInfo = extractInstagramCommentCount(fullText);
    const url = cleanUrl(location.href.includes("/p/") || location.href.includes("/reel/") ? location.href : fallbackUrl);
    const mediaInfo = detectInstagramMediaInfo(article, url, linkContext.previewType);

    return {
      platform: "instagram",
      url,
      shortcode: getPostId("instagram", url),
      caption: extractInstagramCaption(article),
      contentType: mediaInfo.contentType,
      contentTypeLabel: mediaInfo.contentTypeLabel,
      mediaCount: mediaInfo.mediaCount,
      imageCount: mediaInfo.imageCount,
      videoCount: mediaInfo.videoCount,
      likeCount: likeInfo.value,
      commentCount: commentInfo.value,
      postedAt,
      isPinned: Boolean(linkContext.isPinned),
      isTopGridCandidate: isProfilePage("instagram") && linkContext.gridIndex >= 0 && linkContext.gridIndex < 3,
      gridIndex: linkContext.gridIndex ?? null,
      rawLikeText: likeInfo.raw,
      rawCommentText: commentInfo.raw,
      scrapedAt: new Date().toISOString()
    };
  }

  function extractTikTokVisiblePostData(fallbackUrl, linkContext = {}) {
    const url = cleanUrl(/\/(?:video|photo)\//.test(location.href) ? location.href : fallbackUrl);
    const postId = getPostId("tiktok", url);
    const root = getTikTokPostRoot() || document;
    const textRoot = getTikTokReadableRoot() || root;
    const pageState = findTikTokItemData(postId);
    const stateStats = pageState?.stats || pageState?.statsV2 || pageState?.statistics || pageState?.itemStruct?.stats || {};
    const caption = normalizeText(
      getTikTokStateCaption(pageState)
      || extractTikTokCaption(textRoot)
      || parseCaptionFromMeta("tiktok")
    );
    const statePostedAt = normalizeTikTokDate(
      getTikTokStateDate(pageState)
    );
    const visiblePostedAt = extractTikTokVisibleDate(textRoot);
    const postedAt = visiblePostedAt || statePostedAt;
    const likeInfo = pickMetric(
      stateStats.diggCount,
      stateStats.likeCount,
      pageState?.diggCount,
      textFromSelectors([
        '[data-e2e="browse-like-count"]',
        '[data-e2e="like-count"]',
        '[data-e2e*="like"][data-e2e*="count"]',
        'strong[title*="like" i]'
      ]),
      extractTikTokCountByLabel(textRoot.innerText || "", ["likes", "suka"])
    );
    const commentInfo = pickMetric(
      stateStats.commentCount,
      pageState?.commentCount,
      textFromSelectors([
        '[data-e2e="browse-comment-count"]',
        '[data-e2e="comment-count"]',
        '[data-e2e*="comment"][data-e2e*="count"]',
        'strong[title*="comment" i]'
      ]),
      extractTikTokCountByLabel(textRoot.innerText || "", ["comments", "komentar"])
    );
    const shareInfo = pickMetric(
      stateStats.shareCount,
      pageState?.shareCount,
      textFromSelectors([
        '[data-e2e="browse-share-count"]',
        '[data-e2e="share-count"]',
        '[data-e2e*="share"][data-e2e*="count"]'
      ])
    );
    const savedInfo = pickMetric(
      stateStats.collectCount,
      stateStats.favoriteCount,
      pageState?.collectCount,
      textFromSelectors([
        '[data-e2e="undefined-count"]',
        '[data-e2e="favorite-count"]',
        '[data-e2e*="collect"][data-e2e*="count"]',
        '[data-e2e*="favorite"][data-e2e*="count"]'
      ])
    );
    const mediaInfo = detectTikTokMediaInfo(root, url, pageState);

    return {
      platform: "tiktok",
      url,
      shortcode: postId,
      caption,
      contentType: mediaInfo.contentType,
      contentTypeLabel: mediaInfo.contentTypeLabel,
      mediaCount: mediaInfo.mediaCount,
      imageCount: mediaInfo.imageCount,
      videoCount: mediaInfo.videoCount,
      likeCount: likeInfo.value,
      commentCount: commentInfo.value,
      shareCount: shareInfo.value,
      savedCount: savedInfo.value,
      postedAt,
      isPinned: Boolean(linkContext.isPinned),
      isTopGridCandidate: isProfilePage("tiktok") && linkContext.gridIndex >= 0 && linkContext.gridIndex < 3,
      gridIndex: linkContext.gridIndex ?? null,
      rawLikeText: likeInfo.raw,
      rawCommentText: commentInfo.raw,
      rawShareText: shareInfo.raw,
      rawSavedText: savedInfo.raw,
      scrapedAt: new Date().toISOString()
    };
  }

  function extractTikTokCardData(link, postUrl, linkContext = {}) {
    const root = getPostCardRoot(link);
    const text = normalizeText(root.innerText || root.textContent || "");
    const imageAlt = normalizeText(root.querySelector("img[alt]")?.getAttribute("alt") || "");
    const title = normalizeText(link.getAttribute("title") || link.getAttribute("aria-label") || "");
    const caption = [title, imageAlt]
      .find((value) => value && !isTikTokMetricText(value) && !/^Watch .* video$/i.test(value))
      || extractTikTokCaption(root)
      || "";
    const mediaInfo = detectTikTokMediaInfo(root, postUrl, null);

    return {
      platform: "tiktok",
      url: postUrl,
      shortcode: getPostId("tiktok", postUrl),
      caption,
      contentType: mediaInfo.contentType,
      contentTypeLabel: mediaInfo.contentTypeLabel,
      mediaCount: mediaInfo.mediaCount,
      imageCount: mediaInfo.imageCount,
      videoCount: mediaInfo.videoCount,
      likeCount: null,
      commentCount: null,
      shareCount: null,
      savedCount: null,
      postedAt: "",
      isPinned: Boolean(linkContext.isPinned),
      isTopGridCandidate: isProfilePage("tiktok") && linkContext.gridIndex >= 0 && linkContext.gridIndex < 3,
      gridIndex: linkContext.gridIndex ?? null,
      rawLikeText: "",
      rawCommentText: "",
      rawShareText: "",
      rawSavedText: "",
      scrapedAt: new Date().toISOString()
    };
  }

  function mergeTikTokPostData(cardData, detailData) {
    if (!detailData) return cardData;

    return {
      ...cardData,
      ...detailData,
      caption: detailData.caption || cardData.caption,
      contentType: detailData.contentType || cardData.contentType,
      contentTypeLabel: detailData.contentTypeLabel || cardData.contentTypeLabel,
      mediaCount: detailData.mediaCount || cardData.mediaCount,
      imageCount: detailData.imageCount || cardData.imageCount,
      videoCount: detailData.videoCount || cardData.videoCount,
      likeCount: detailData.likeCount ?? cardData.likeCount,
      commentCount: detailData.commentCount ?? cardData.commentCount,
      shareCount: detailData.shareCount ?? cardData.shareCount,
      savedCount: detailData.savedCount ?? cardData.savedCount,
      postedAt: detailData.postedAt || cardData.postedAt,
      rawLikeText: detailData.rawLikeText || cardData.rawLikeText,
      rawCommentText: detailData.rawCommentText || cardData.rawCommentText,
      rawShareText: detailData.rawShareText || cardData.rawShareText,
      rawSavedText: detailData.rawSavedText || cardData.rawSavedText
    };
  }

  async function scrapeFacebookPostFromLink(link, postUrl, linkContext = {}) {
    let root = resolveFacebookStablePostRoot(link) || getFacebookPostCardRoot(link);
    scrollFacebookHeaderIntoView(root);
    await sleep(450);
    root = resolveFacebookStablePostRoot(link, root) || root;
    root = await stabilizeFacebookPostDate(root);
    const preservedRawDateText = extractFacebookRawDateText(root);
    const preservedPostedAt = extractFacebookDate(root);
    await expandFacebookCaptionText(root || document);
    return extractFacebookCardData(root, postUrl, linkContext, {
      rawDateText: preservedRawDateText,
      postedAt: preservedPostedAt
    });
  }

  function extractFacebookCardData(linkOrRoot, postUrl, linkContext = {}, preserved = {}) {
    const root = getFacebookPostCardRoot(linkOrRoot);
    const metricText = extractFacebookMetricText(root);
    const reactionInfo = extractFacebookReactionCount(root, metricText);
    const commentInfo = extractFacebookCommentCount(root, metricText);
    const shareInfo = extractFacebookCountByLabel(root, metricText, ["shares", "share", "dibagikan", "bagikan"]);
    const mediaInfo = detectFacebookMediaInfo(root, postUrl);
    const rawDateText = preserved.rawDateText || extractFacebookRawDateText(root);
    const postedAt = preserved.postedAt || extractFacebookDate(root);

    return {
      platform: "facebook",
      url: postUrl,
      shortcode: getPostId("facebook", postUrl),
      caption: extractFacebookCaption(root),
      contentType: mediaInfo.contentType,
      contentTypeLabel: mediaInfo.contentTypeLabel,
      mediaCount: mediaInfo.mediaCount,
      imageCount: mediaInfo.imageCount,
      videoCount: mediaInfo.videoCount,
      likeCount: reactionInfo.value,
      commentCount: commentInfo.value,
      shareCount: shareInfo.value,
      savedCount: null,
      postedAt,
      rawDateText,
      isPinned: Boolean(linkContext.isPinned),
      isTopGridCandidate: false,
      gridIndex: linkContext.gridIndex ?? null,
      rawLikeText: reactionInfo.raw,
      rawCommentText: commentInfo.raw,
      rawShareText: shareInfo.raw,
      rawSavedText: "",
      scrapedAt: new Date().toISOString()
    };
  }

  function mergeFacebookPostData(cardData, detailData) {
    if (!detailData) return cardData;

    return {
      ...cardData,
      ...detailData,
      caption: detailData.caption || cardData.caption,
      contentType: detailData.contentType || cardData.contentType,
      contentTypeLabel: detailData.contentTypeLabel || cardData.contentTypeLabel,
      mediaCount: detailData.mediaCount || cardData.mediaCount,
      imageCount: detailData.imageCount || cardData.imageCount,
      videoCount: detailData.videoCount || cardData.videoCount,
      likeCount: detailData.likeCount ?? cardData.likeCount,
      commentCount: detailData.commentCount ?? cardData.commentCount,
      shareCount: detailData.shareCount ?? cardData.shareCount,
      postedAt: detailData.postedAt || cardData.postedAt,
      rawDateText: detailData.rawDateText || cardData.rawDateText,
      rawLikeText: detailData.rawLikeText || cardData.rawLikeText,
      rawCommentText: detailData.rawCommentText || cardData.rawCommentText,
      rawShareText: detailData.rawShareText || cardData.rawShareText
    };
  }

  function getPostRoot(platform) {
    if (platform === "tiktok") return getTikTokPostRoot();
    if (platform === "facebook") return getFacebookPostRoot();
    return getInstagramPostArticle();
  }

  function getInstagramPostArticle() {
    const dialogArticle = document.querySelector('div[role="dialog"] article');
    if (dialogArticle) return dialogArticle;

    const articles = [...document.querySelectorAll("article")];
    return articles.find((article) => article.querySelector("time[datetime]")) || articles[0] || null;
  }

  function getTikTokPostRoot() {
    const detailRoot = document.querySelector('[data-e2e="browse-video"], [data-e2e="video-detail"]')
      || document.querySelector('div[role="dialog"] video')?.closest('div[role="dialog"]');
    if (detailRoot) return detailRoot;

    if (isTikTokPostUrl(location.href)) {
      return document.querySelector("main") || document.body || null;
    }

    return document.querySelector('[data-e2e="user-post-item"]')
      || document.querySelector("main")
      || document.body
      || null;
  }

  function getTikTokDetailRoot() {
    return document.querySelector('[data-e2e="browse-video"], [data-e2e="video-detail"]')
      || document.querySelector('div[role="dialog"] video')?.closest('div[role="dialog"]')
      || (isTikTokPostUrl(location.href) ? document.querySelector("main") : null);
  }

  function getTikTokReadableRoot() {
    if (isTikTokPostUrl(location.href)) {
      return document.querySelector("main") || document.body || null;
    }

    const activePostId = getPostId("tiktok", location.href);
    const activeLink = activePostId
      ? document.querySelector(`a[href*="/video/${activePostId}"], a[href*="/photo/${activePostId}"]`)
      : null;
    const activeLinkPanel = activeLink?.closest("aside, section, article, main, div");
    if (activeLinkPanel && normalizeText(activeLinkPanel.innerText || activeLinkPanel.textContent || "")) {
      return activeLinkPanel;
    }

    const captionNode = document.querySelector([
      '[data-e2e="browse-video-desc"]',
      '[data-e2e="video-desc"]',
      '[data-e2e="new-desc-span"]'
    ].join(", "));
    const captionPanel = captionNode?.closest("aside, section, article, main, div");
    if (captionPanel && normalizeText(captionPanel.innerText || captionPanel.textContent || "")) {
      return captionPanel;
    }

    return document.querySelector("main") || document.body || null;
  }

  function getFacebookDialogRoot() {
    return document.querySelector('div[role="dialog"] [role="article"]')
      || document.querySelector('div[role="dialog"] article')
      || document.querySelector('div[role="dialog"]');
  }

  function getFacebookPostRoot(postId = "") {
    const dialogRoot = getFacebookDialogRoot();
    if (dialogRoot) return dialogRoot;

    const articles = [...document.querySelectorAll(FACEBOOK_POST_ROOT_SELECTOR)];
    if (postId) {
      const matchingArticle = articles.find((article) => {
        return [...article.querySelectorAll("a[href]")].some((link) => getPostId("facebook", link.href) === postId);
      });
      if (matchingArticle) return normalizeFacebookPostRoot(matchingArticle);
    }

    return normalizeFacebookPostRoot(articles.find((article) => extractFacebookDate(article) || extractFacebookCaption(article)))
      || document.querySelector("main")
      || document.body
      || null;
  }

  function getFacebookPostCardRoot(link) {
    if (link.__scsPostHref || link.__scsFacebookPostRoot) return link;
    if (link.matches?.(FACEBOOK_POST_ROOT_SELECTOR)) return link;

    return normalizeFacebookPostRoot(
      link.closest(FACEBOOK_POST_ROOT_SELECTOR)
      || findFacebookPostRootFromNode(link)
      || link
    );
  }

  function isLikelyFacebookPostRoot(root) {
    const rect = root.getBoundingClientRect();
    if (rect.width < 320 || rect.height < 120) return false;

    const text = normalizeText(root.innerText || root.textContent || "");
    if (text.length < 25) return false;

    const hasPostAction = hasFacebookPostActionSet(root)
      || /\b(like|comment|share|suka|komentar|bagikan)\b/i.test(text);
    const hasDate = Boolean(extractFacebookDate(root));
    const hasCaption = Boolean(extractFacebookCaption(root));
    const hasMedia = collectVisibleMedia(root).length > 0;
    const hasPostLink = Boolean(findBestFacebookPostLink(root));

    if (hasDate || hasCaption) {
      return hasPostAction || hasMedia;
    }

    return hasPostLink && hasMedia && hasFacebookPostActionSet(root);
  }

  function isVisibleFacebookFeedRoot(root) {
    const rect = root.getBoundingClientRect?.();
    if (!rect) return false;
    if (rect.width < 320 || rect.height < 120) return false;

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    return rect.bottom >= -150 && rect.top <= viewportHeight + 250;
  }

  function findBestFacebookPostLink(root) {
    const links = [...root.querySelectorAll("a[href]")]
      .filter((link) => getPostId("facebook", cleanPostUrl("facebook", link.href)));

    if (!links.length) return null;

    return links
      .map((link) => ({ link, score: scoreFacebookPostLink(link) }))
      .sort((a, b) => b.score - a.score)[0]?.link || null;
  }

  function scoreFacebookPostLink(link) {
    const href = link.href || "";
    const text = normalizeText(`${link.innerText || link.textContent || ""} ${link.getAttribute("aria-label") || ""} ${link.getAttribute("title") || ""}`);
    const token = extractFacebookDateToken(text);
    let score = 0;

    if (/\/posts\/|\/permalink\/|permalink\.php|story_fbid=/i.test(href)) score += 120;
    if (token && isStrongFacebookDateCandidateText(text, token)) score += 110;
    if (/\/videos\/|\/watch\/|\/reel\//i.test(href) || /[?&]v=/i.test(href)) score += 70;
    if (/\/photo\/|photo\.php/i.test(href)) score -= 45;
    if (/\b(like|comment|share|suka|komentar|bagikan|lihat semua foto|see all photos)\b/i.test(text)) score -= 60;
    if (text.length > 96) score -= 180;
    if (text.length > 48 && !token) score -= 90;
    if (/\b(?:website|facebook|twitter|youtube|tiktok|selengkapnya|tampilkan lebih sedikit)\b/i.test(text)) score -= 120;

    const root = link.closest(FACEBOOK_POST_ROOT_SELECTOR);
    if (root && root.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"]')) score += 20;

    return score;
  }

  function climbToTextBlock(node, maxDepth) {
    let current = node;
    for (let depth = 0; current?.parentElement && depth < maxDepth; depth += 1) {
      const parent = current.parentElement;
      const text = normalizeText(parent.innerText || parent.textContent || "");
      if (text.length > 80 && parent.querySelectorAll?.("a[href]").length >= 1) return parent;
      current = parent;
    }
    return current;
  }

  function findFacebookPostRootFromNode(node, maxDepth = 16) {
    let current = node;
    let best = null;
    let bestScore = -Infinity;

    for (let depth = 0; current && depth < maxDepth; depth += 1) {
      const score = scoreFacebookPostRootCandidate(current, node, depth);
      if (score > bestScore) {
        bestScore = score;
        best = current;
      }

      current = current.parentElement;
    }

    return best;
  }

  function findFacebookMediaPostRoot(link, maxDepth = 18) {
    let current = link;
    const maxHeight = Math.max(4800, (window.innerHeight || 0) * 8);

    for (let depth = 0; current && depth < maxDepth; depth += 1) {
      const rect = current.getBoundingClientRect?.();
      if (!rect || rect.width < 320 || rect.height < 140 || rect.height > maxHeight) {
        current = current.parentElement;
        continue;
      }

      const linkCount = current.querySelectorAll?.("a[href]").length || 0;
      if (linkCount > 60) {
        current = current.parentElement;
        continue;
      }

      const hasMedia = collectVisibleMedia(current).length > 0;
      const headerBand = getFacebookHeaderBand(current);
      const authorNode = findFacebookAuthorNode(current, headerBand);

      if (hasFacebookPostActionSet(current) && hasMedia && authorNode) {
        current.__scsFacebookPostRoot = true;
        return current;
      }

      current = current.parentElement;
    }

    return null;
  }

  function collectFacebookPostActionText(root) {
    if (!root?.querySelectorAll) return "";

    return normalizeText([...root.querySelectorAll('button, [role="button"]')]
      .map((node) => [
        node.getAttribute?.("aria-label") || "",
        node.getAttribute?.("title") || "",
        node.innerText || node.textContent || ""
      ].join(" "))
      .join(" "));
  }

  function hasFacebookPostActionSet(root) {
    const actionText = collectFacebookPostActionText(root);
    if (!actionText) return false;

    const hasLike = /\b(like|suka|beri reaksi)\b/i.test(actionText);
    const hasComment = /\b(comment|komentar|beri komentar)\b/i.test(actionText);
    const hasShare = /\b(share|bagikan|kirim ini ke teman|posting di profil)\b/i.test(actionText);
    return hasLike && hasComment && hasShare;
  }

  function getFacebookProfileSlug() {
    try {
      const path = new URL(window.location.href).pathname
        .replace(/^\/+|\/+$/g, "")
        .split("/")[0];
      if (/^profile\.php$/i.test(path)) return "";
      return normalizeText(path || "");
    } catch (_) {
      return "";
    }
  }

  function isLikelyFacebookPageAuthorName(text) {
    const normalized = normalizeText(text).toLowerCase();
    const slug = getFacebookProfileSlug().toLowerCase();
    if (!normalized || !slug) return false;
    if (normalized === slug) return true;
    return normalized.replace(/\s+/g, "").includes(slug.replace(/\s+/g, ""));
  }

  function normalizeFacebookPostRoot(root, maxDepth = 12) {
    if (root?.__scsPostHref || root?.__scsFacebookPostRoot) return root;
    if (!root?.parentElement) return root;
    return findFacebookPostRootFromNode(root, maxDepth) || root;
  }

  function scoreFacebookPostRootCandidate(candidate, sourceNode, depth) {
    if (!candidate?.querySelectorAll) return -Infinity;

    const rect = candidate.getBoundingClientRect?.();
    if (!rect || rect.width < 320 || rect.height < 140) return -Infinity;

    const text = normalizeText(candidate.innerText || candidate.textContent || "");
    if (text.length < 25) return -Infinity;

    const linkCount = candidate.querySelectorAll("a[href]").length;
    const mediaCount = candidate.querySelectorAll("img, video").length;
    const hasCaption = Boolean(candidate.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-testid="post_message"]'));
    const actionText = collectFacebookPostActionText(candidate);
    const hasPostAction = hasFacebookPostActionSet(candidate)
      || /\b(like|comment|share|suka|komentar|bagikan)\b/i.test(text);
    const hasShareAction = /\b(share|bagikan|kirim ini ke teman|posting di profil)\b/i.test(`${text} ${actionText}`);
    const hasReplyAction = /\b(reply|balas)\b/i.test(text);
    const hasEditedCommentText = /\b(diedit|edited)\b/i.test(text);
    const hasTimestampishLink = hasFacebookTimestampishLink(candidate);
    const sourceContained = candidate.contains(sourceNode);
    const isStructuredRoot = candidate.matches?.(FACEBOOK_POST_ROOT_SELECTOR);
    const headerBand = getFacebookHeaderBand(candidate);
    const authorNode = findFacebookAuthorNode(candidate, headerBand);
    const authorText = normalizeText(authorNode?.innerText || authorNode?.textContent || "");
    const profileSlug = getFacebookProfileSlug();
    const matchesPageAuthor = isLikelyFacebookPageAuthorName(authorText);
    const overLarge = rect.height > window.innerHeight * 2.8 || linkCount > 80;

    let score = 0;
    if (!sourceContained) score -= 500;
    if (isStructuredRoot) score += 110;
    if (authorNode) score += 90;
    if (matchesPageAuthor) score += 180;
    if (authorNode && profileSlug && !matchesPageAuthor) score -= 120;
    if (hasCaption) score += 100;
    if (mediaCount > 0) score += 50;
    if (hasPostAction) score += 90;
    if (hasShareAction) score += 80;
    if (hasTimestampishLink) score += 140;
    if (linkCount >= 3) score += 20;
    if (rect.height >= 220) score += 20;
    if (rect.height >= 380) score += 25;
    if (rect.height >= 520) score += 20;
    if (hasReplyAction && !hasShareAction) score -= 220;
    if (hasEditedCommentText && !hasShareAction) score -= 90;
    if (overLarge) score -= 180;
    score -= depth * 6;

    return score;
  }

  function hasFacebookTimestampishLink(root) {
    const rootRect = root.getBoundingClientRect?.();
    if (!rootRect) return false;

    const bandBottom = rootRect.top + Math.max(120, Math.min(220, rootRect.height * 0.24));
    return [...root.querySelectorAll('a[href][role="link"], a[href]')].some((link) => {
      const rect = link.getBoundingClientRect?.();
      if (!rect || rect.top < rootRect.top - 6 || rect.bottom > bandBottom + 24) return false;
      if (link.querySelector("img, video")) return false;

      const href = cleanPostUrl("facebook", link.href || "");
      const text = normalizeText(`${link.innerText || link.textContent || ""} ${link.getAttribute("aria-label") || ""} ${link.getAttribute("title") || ""}`);
      if (!getPostId("facebook", href)) return false;
      return Boolean(extractFacebookDateToken(text) || parseFacebookDate(text));
    });
  }

  function extractFacebookCaption(root) {
    const captionContainer = findFacebookCaptionContainer(root);
    if (captionContainer) {
      const caption = normalizeText(captionContainer.innerText || captionContainer.textContent || "");
      if (isPossibleFacebookCaption(caption)) return caption;
    }
    return "";
  }

  function findFacebookCaptionContainer(root) {
    return collectFacebookCaptionCandidates(root)[0]?.node || null;
  }

  function cleanFacebookCaptionLine(line) {
    return normalizeText(line)
      .replace(/\b(See more|Lihat selengkapnya|See translation|Lihat terjemahan|Translate|Terjemahkan)\b/gi, "")
      .trim();
  }

  function isPossibleFacebookCaption(text) {
    if (!text || text.length < 2) return false;
    if (extractFacebookDateToken(text) === text) return false;
    if (/^(like|comment|share|suka|komentar|bagikan|follow|ikuti|send message|kirim pesan)$/i.test(text)) return false;
    if (/^\d+([.,]\d+)?\s*(k|m|rb|ribu|jt|juta)?$/i.test(text)) return false;
    if (/^\d+\s*(comments?|komentar|shares?|dibagikan)$/i.test(text)) return false;
    if (/^(most relevant|semua komentar|most relevant is selected|relevan|relevant)$/i.test(text)) return false;
    if (/^all reactions?:/i.test(text)) return false;
    if (/^sponsored|bersponsor$/i.test(text)) return false;
    return true;
  }

  function extractFacebookDate(root) {
    const rawDateText = extractFacebookRawDateText(root);
    if (rawDateText) {
      const token = extractFacebookDateToken(rawDateText);
      const parsed = parseFacebookDate(rawDateText) || (token ? parseFacebookDate(token) : "");
      if (parsed) return parsed;
    }

    return "";
  }

  function extractReliableFacebookLinkDateText(root) {
    const postLink = findBestFacebookPostLink(root);
    if (!postLink) return "";

    const labels = [
      normalizeText(postLink.getAttribute?.("aria-label") || ""),
      normalizeText(postLink.querySelector?.("[aria-label]")?.getAttribute?.("aria-label") || ""),
      collectFacebookAriaReferenceText(postLink),
      normalizeText(postLink.getAttribute?.("title") || "")
    ].filter(Boolean);

    for (const label of labels) {
      if (/\b(suka|komentar|bagikan|like|comment|share|beri komentar|beri reaksi)\b/i.test(label)) continue;
      if (/\b(?:website|facebook|twitter|youtube|tiktok|selengkapnya|tampilkan lebih sedikit)\b/i.test(label)) continue;

      const token = extractFacebookDateToken(label);
      if (!token || !isStrongFacebookDateCandidateText(label, token)) continue;
      if (label.length > Math.max(token.length + 24, 48)) continue;

      return normalizeFacebookHeaderDateText(label);
    }

    return "";
  }

  function extractFacebookRawDateText(root) {
    const headerCandidate = collectFacebookHeaderDateCandidates(root)[0];
    if (headerCandidate?.text) return headerCandidate.text;

    const linkDateText = extractReliableFacebookLinkDateText(root);
    if (linkDateText) return linkDateText;

    return "";
  }

  function findFacebookTimestampLink(root) {
    return collectFacebookHeaderDateCandidates(root).find((item) => item.kind === "link")?.node || null;
  }

  function scoreFacebookTimestampLink(link, root, authorNode = null) {
    const combined = collectFacebookHeaderDateText(link, authorNode);
    const token = extractFacebookDateToken(combined);
    const href = cleanPostUrl("facebook", link.href || "");
    const hasDateEvidence = Boolean(token);
    const authorHref = cleanPostUrl("facebook", authorNode?.href || authorNode?.closest?.("a[href]")?.href || "");
    const sameProfileAsAuthor = Boolean(authorHref && getComparableFacebookUrl(href) === getComparableFacebookUrl(authorHref));
    let score = 0;

    if (!href || !hasDateEvidence) return 0;
    if (!isStrongFacebookDateCandidateText(combined, token)) return 0;
    if (sameProfileAsAuthor && !isAbsoluteFacebookDateToken(token) && !/\/posts\/|\/permalink\/|permalink\.php|story_fbid=|\/videos\/|\/watch\/|\/reel\/|\/photo\//i.test(link.href || "")) return 0;
    if (/\/posts\/|\/permalink\/|permalink\.php|story_fbid=|\/videos\/|\/watch\/|\/reel\//i.test(href)) score += 90;
    if (token) score += 150;
    if (/^(just now|baru saja|\d+\s*(m|min|menit|h|jam|d|hari|w|minggu|mo|bulan|y|tahun))$/i.test(combined)) score += 60;
    if (/^(like|comment|share|suka|komentar|bagikan)$/i.test(combined)) score -= 120;
    if (/\/photo\/|photo\.php/i.test(href)) score -= 220;
    if (/\/media\/set/i.test(href)) score -= 220;
    if (/tampilkan lebih sedikit|lihat selengkapnya|website\s*:|twitter\s*:|youtube\s*:|tiktok\s*:/i.test(combined)) score -= 260;

    const rootRect = root?.getBoundingClientRect?.();
    const linkRect = link.getBoundingClientRect?.();
    if (rootRect && linkRect && rootRect.height > 0) {
      const verticalRatio = (linkRect.top - rootRect.top) / Math.max(rootRect.height, 1);
      if (verticalRatio <= 0.2) score += 120;
      else if (verticalRatio <= 0.28) score += 40;
      else score -= 220;
    }

    if (authorNode?.compareDocumentPosition) {
      const relation = authorNode.compareDocumentPosition(link);
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) score += 90;
      if (relation & Node.DOCUMENT_POSITION_PRECEDING) score -= 140;
    }

    return score;
  }

  function getFacebookHeaderBand(root) {
    const rect = root.getBoundingClientRect();
    const messageContainer = getFacebookMessageContainer(root);
    const messageRect = messageContainer?.getBoundingClientRect?.() || null;
    const mediaRect = root.querySelector("img, video")?.getBoundingClientRect?.() || null;
    const actionRect = findFacebookActionBarRoot(root)?.getBoundingClientRect?.() || null;

    const boundaryCandidates = [
      messageRect?.top ? messageRect.top - 14 : null,
      mediaRect?.top ? mediaRect.top - 14 : null,
      actionRect?.top ? actionRect.top - 18 : null
    ]
      .filter((value) => Number.isFinite(value))
      .filter((value) => value > rect.top + 40);

    const defaultBottom = rect.top + Math.max(170, Math.min(360, rect.height * 0.4));
    const derivedBottom = boundaryCandidates.length ? Math.min(...boundaryCandidates) : defaultBottom;

    return {
      top: rect.top,
      bottom: Math.max(rect.top + 96, Math.min(defaultBottom, derivedBottom))
    };
  }

  function isNodeInsideFacebookHeaderBand(node, band) {
    const rect = node.getBoundingClientRect?.();
    if (!rect || !band) return false;
    return rect.top >= band.top - 10 && rect.bottom <= band.bottom + 28;
  }

  function getFacebookMessageContainer(root) {
    return root.querySelector(
      '[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-testid="post_message"]'
    );
  }

  function findFacebookActionBarRoot(root) {
    return [...root.querySelectorAll('div, section, footer')]
      .find((node) => {
        const text = normalizeText(node.innerText || node.textContent || "");
        if (!text) return false;
        if (!/\b(suka|komentar|bagikan|like|comment|share)\b/i.test(text)) return false;
        const rect = node.getBoundingClientRect?.();
        return Boolean(rect && rect.height >= 24 && rect.width >= 180);
      }) || null;
  }

  function findFacebookAuthorNode(root, headerBand) {
    const selectors = [
      'h2 a[role="link"]',
      'h3 a[role="link"]',
      'strong a[role="link"]',
      'a[role="link"] strong',
      'a[role="link"] span',
      'a[role="link"]'
    ];
    const candidates = [...root.querySelectorAll(selectors.join(", "))]
      .filter((node) => {
        if (!isNodeInsideFacebookHeaderBand(node, headerBand)) return false;
        const text = normalizeText(node.innerText || node.textContent || "");
        if (!text || text.length < 2) return false;
        if (extractFacebookDateToken(text)) return false;
        if (/^(like|comment|share|suka|komentar|bagikan|follow|ikuti)$/i.test(text)) return false;
        return !node.querySelector("img, video");
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

    return candidates[0] || null;
  }

  function collectFacebookDirectDateText(node, authorNode = null) {
    const authorText = normalizeText(authorNode?.innerText || authorNode?.textContent || "");
    const exactSources = [
      collectFacebookTopRowLeafText(node),
      collectFacebookAriaReferenceText(node),
      collectFacebookCollapsedLeafText(node),
      normalizeText(node.getAttribute?.("aria-label") || ""),
      normalizeText(node.getAttribute?.("aria-description") || ""),
      normalizeText(node.getAttribute?.("title") || ""),
      normalizeText(node.getAttribute?.("data-tooltip-content") || ""),
      normalizeText(node.getAttribute?.("datetime") || ""),
      normalizeText(node.getAttribute?.("data-utime") || ""),
      normalizeText(node.innerText || node.textContent || "")
    ];

    const normalizedSources = [...new Set(exactSources
      .map((value) => sanitizeFacebookHeaderDateText(value, authorText))
      .filter(Boolean))];

    for (const source of normalizedSources) {
      if (isStrongFacebookDateCandidateText(source)) return source;
    }

    return normalizedSources.find((source) => !isFragmentedFacebookHeaderText(source)) || "";
  }

  function collectFacebookTopRowLeafText(node) {
    const topRowText = normalizeFacebookHeaderDateText(collectFacebookTopRowLeafRawText(node));

    const token = extractFacebookDateToken(topRowText);
    if (token && isStrongFacebookDateCandidateText(topRowText, token)) {
      return topRowText;
    }

    return "";
  }

  function collectFacebookTopRowLeafRawText(node) {
    if (!node?.querySelectorAll) return "";

    const leafNodes = [...node.querySelectorAll("span, a, abbr, time, div")]
      .filter((child) => child.children.length === 0)
      .map((child) => {
        const rect = child.getBoundingClientRect?.();
        if (!rect || rect.height <= 0 || rect.width <= 0) return null;

        return {
          rawText: String(child.textContent || "").replace(/\u00a0/g, " "),
          top: rect.top,
          left: rect.left
        };
      })
      .filter((item) => item && item.rawText.length);

    if (!leafNodes.length) return "";

    const topRowTop = Math.min(...leafNodes.map((item) => item.top));
    return leafNodes
      .filter((item) => Math.abs(item.top - topRowTop) <= 2)
      .sort((a, b) => a.left - b.left)
      .map((item) => item.rawText)
      .join("");
  }

  function collectFacebookTopRowMetricText(node) {
    const rawTopRow = collectFacebookTopRowLeafRawText(node);
    if (!rawTopRow) return "";

    const compact = normalizeText(rawTopRow).replace(/\s+/g, "");
    if (/^\d+(?:[.,]\d+)?(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?$/i.test(compact)) {
      return compact;
    }

    const normalized = normalizeText(rawTopRow);
    const matchedNumber = normalized.match(/\b\d+(?:[.,]\d+)?\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?\b/i);
    return matchedNumber?.[0] ? normalizeText(matchedNumber[0]) : "";
  }

  function collectFacebookCollapsedLeafText(node) {
    if (!node?.querySelectorAll) return "";

    const topRowText = collectFacebookTopRowLeafText(node);
    if (topRowText) return topRowText;

    const leafTexts = [...node.querySelectorAll("span, a, abbr, time, div")]
      .filter((child) => child.children.length === 0)
      .map((child) => child.textContent || "")
      .map((text) => String(text).replace(/\s+/g, " ").trim())
      .filter(Boolean);

    if (!leafTexts.length) return "";

    const mostlySingleChar = leafTexts.filter((text) => text.length === 1).length >= Math.max(4, Math.floor(leafTexts.length * 0.5));
    if (!mostlySingleChar) return "";

    return normalizeFacebookHeaderDateText(leafTexts.join(""));
  }

  function collectFacebookAuthorAdjacentNodes(authorNode, root) {
    if (!authorNode || !root) return [];

    const candidates = [];
    const seen = new Set();
    let current = authorNode;

    for (let depth = 0; current && current !== root && depth < 5; depth += 1) {
      const parent = current.parentElement;
      if (!parent) break;

      if (!seen.has(parent)) {
        seen.add(parent);
        candidates.push(parent);
      }

      let sibling = current.nextElementSibling;
      while (sibling) {
        if (!seen.has(sibling)) {
          seen.add(sibling);
          candidates.push(sibling);
        }
        sibling = sibling.nextElementSibling;
      }

      current = parent;
    }

    return candidates;
  }

  function collectFacebookAuthorAdjacentDateCandidates(root, authorNode = null) {
    if (!authorNode) return [];

    return collectFacebookAuthorAdjacentNodes(authorNode, root)
      .flatMap((container) => {
        const nodes = [container];
        nodes.push(...container.querySelectorAll?.('a[href], span, div, abbr, time, [aria-labelledby], [aria-label], [title], [data-tooltip-content], [data-utime]') || []);
        return nodes;
      })
      .filter((node, index, array) => node && array.indexOf(node) === index)
      .map((node) => {
        const text = collectFacebookDirectDateText(node, authorNode);
        const token = extractFacebookDateToken(text);
        if (!token || !isStrongFacebookDateCandidateText(text, token)) return null;

        const nodeRect = node.getBoundingClientRect?.();
        const authorRect = authorNode.getBoundingClientRect?.();
        const verticalGap = nodeRect && authorRect ? Math.abs(nodeRect.top - authorRect.bottom) : 0;
        const horizontalGap = nodeRect && authorRect ? Math.abs(nodeRect.left - authorRect.left) : 0;
        let score = 0;

        score += 420;
        score -= Math.min(160, verticalGap * 2);
        score -= Math.min(120, horizontalGap);
        if (node.tagName?.toLowerCase() === "a") score += 40;
        if (isAbsoluteFacebookDateToken(token)) score += 30;

        return {
          node,
          kind: node.tagName?.toLowerCase() === "a" ? "link" : "text",
          text,
          score
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
  }

  function collectFacebookAuthorAriaLabelledDateCandidates(root, authorNode = null) {
    if (!authorNode) return [];

    const messageContainer = getFacebookMessageContainer(root);
    return [...root.querySelectorAll('[aria-labelledby], [aria-describedby]')]
      .filter((node) => {
        if (messageContainer?.contains(node) && node !== messageContainer) return false;
        if (node.querySelector?.("img, video")) return false;
        if (!isNodeJustBelowFacebookAuthor(node, authorNode, root)) return false;

        const rect = node.getBoundingClientRect?.();
        if (!rect || rect.width > 220 || rect.height > 32) return false;
        return true;
      })
      .map((node) => {
        const text = collectFacebookDirectDateText(node, authorNode) || collectFacebookAriaReferenceText(node);
        const token = extractFacebookDateToken(text);
        const nodeRect = node.getBoundingClientRect?.();
        const authorRect = authorNode.getBoundingClientRect?.();
        const verticalGap = nodeRect && authorRect ? Math.max(0, nodeRect.top - authorRect.bottom) : 0;
        const horizontalGap = nodeRect && authorRect ? Math.abs(nodeRect.left - authorRect.left) : 0;
        let score = 0;

        if (!token || !isStrongFacebookDateCandidateText(text, token)) return null;

        score += 560;
        score -= Math.min(120, verticalGap * 4);
        score -= Math.min(100, horizontalGap);
        if (node.hasAttribute?.("aria-labelledby")) score += 80;
        if (node.hasAttribute?.("aria-describedby")) score += 40;
        if (isAbsoluteFacebookDateToken(token)) score += 30;

        return {
          node,
          kind: "text",
          text,
          score
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
  }

  function isNodeJustBelowFacebookAuthor(node, authorNode, root = null) {
    const nodeRect = node?.getBoundingClientRect?.();
    const authorRect = authorNode?.getBoundingClientRect?.();
    const rootRect = root?.getBoundingClientRect?.();
    if (!nodeRect || !authorRect) return false;
    if (node === authorNode) return false;
    if (node.contains?.(authorNode) || authorNode.contains?.(node)) return false;

    const relation = authorNode.compareDocumentPosition?.(node) || 0;
    if (!(relation & Node.DOCUMENT_POSITION_FOLLOWING)) return false;

    const maxBottom = Math.min(rootRect?.bottom ?? Number.POSITIVE_INFINITY, authorRect.bottom + 120);
    const verticalGap = nodeRect.top - authorRect.bottom;
    const horizontalGap = Math.abs(nodeRect.left - authorRect.left);

    if (verticalGap < -10 || nodeRect.bottom > maxBottom + 16) return false;
    if (horizontalGap > 220) return false;
    if (nodeRect.width > 260) return false;

    return true;
  }

  function collectFacebookAuthorContextDateCandidates(root, authorNode = null) {
    if (!authorNode) return [];

    const messageContainer = getFacebookMessageContainer(root);
    return [...root.querySelectorAll('a[href], span, div, abbr, time, [aria-labelledby], [aria-label], [title], [data-tooltip-content], [data-utime]')]
      .filter((node) => {
        if (messageContainer?.contains(node)) return false;
        if (node.querySelector?.("img, video")) return false;
        return isNodeJustBelowFacebookAuthor(node, authorNode, root);
      })
      .map((node) => {
        const text = collectFacebookDirectDateText(node, authorNode);
        const token = extractFacebookDateToken(text);
        const rect = node.getBoundingClientRect?.();
        const authorRect = authorNode.getBoundingClientRect?.();
        const verticalGap = rect && authorRect ? Math.max(0, rect.top - authorRect.bottom) : 0;
        const horizontalGap = rect && authorRect ? Math.abs(rect.left - authorRect.left) : 0;
        let score = 0;

        if (!token || !isStrongFacebookDateCandidateText(text, token)) return null;

        score += 340;
        score -= Math.min(120, verticalGap * 3);
        score -= Math.min(120, horizontalGap);
        if (node.tagName?.toLowerCase() === "a") score += 30;
        if (isAbsoluteFacebookDateToken(token)) score += 20;

        return {
          node,
          kind: node.tagName?.toLowerCase() === "a" ? "link" : "text",
          text,
          score
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
  }

  function collectFacebookAriaReferenceText(node) {
    const doc = node?.ownerDocument;
    if (!doc?.getElementById) return "";

    const referenceIds = normalizeText([
      node.getAttribute?.("aria-labelledby") || "",
      node.getAttribute?.("aria-describedby") || ""
    ].join(" "))
      .split(/\s+/)
      .filter(Boolean);

    if (!referenceIds.length) return "";

    const texts = referenceIds
      .map((id) => doc.getElementById(id))
      .filter(Boolean)
      .map((target) => normalizeText([
        target.innerText || target.textContent || "",
        target.getAttribute?.("aria-label") || "",
        target.getAttribute?.("aria-description") || "",
        target.getAttribute?.("title") || ""
      ].join(" ")))
      .filter(Boolean);

    return normalizeText(texts.join(" "));
  }

  function sanitizeFacebookHeaderDateText(text, authorText = "") {
    if (!text) return "";
    const sanitized = authorText
      ? text.replace(new RegExp(authorText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ")
      : text;
    return normalizeFacebookHeaderDateText(sanitized);
  }

  function isFragmentedFacebookHeaderText(text) {
    const normalized = normalizeText(text);
    if (!normalized) return false;

    const tokens = normalized.split(/\s+/).filter(Boolean);
    if (tokens.length < 8) return false;

    const singleLetters = tokens.filter((token) => /^[a-z]$/i.test(token)).length;
    const singleDigits = tokens.filter((token) => /^\d$/.test(token)).length;
    const longTokens = tokens.filter((token) => token.length >= 3).length;
    const fragmentedRatio = (singleLetters + singleDigits) / Math.max(tokens.length, 1);

    return (singleLetters >= 5 && singleLetters / Math.max(tokens.length, 1) >= 0.35)
      || (fragmentedRatio >= 0.7 && longTokens <= 2);
  }

  function isAbsoluteFacebookDateToken(token) {
    if (!token) return false;
    return /\b(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]20\d{2})\b/i.test(token)
      || /\b\d{1,2}\s+(?:jan(?:uary|uari)?|feb(?:ruary|ruari)?|mar(?:ch|et)?|apr(?:il)?|mei|may|jun(?:e|i)?|jul(?:y|i)?|aug(?:ust)?|agu(?:stus)?|sep(?:t|tember)?|okt(?:ober)?|oct(?:ober)?|nov(?:ember)?|des(?:ember)?|dec(?:ember)?)(?:\s+20\d{2})?\b/i.test(token)
      || /\b(?:jan(?:uary|uari)?|feb(?:ruary|ruari)?|mar(?:ch|et)?|apr(?:il)?|mei|may|jun(?:e|i)?|jul(?:y|i)?|aug(?:ust)?|agu(?:stus)?|sep(?:t|tember)?|okt(?:ober)?|oct(?:ober)?|nov(?:ember)?|des(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,?\s+20\d{2})?\b/i.test(token);
  }

  function isRelativeFacebookDateToken(token) {
    if (!token) return false;
    return /^\d+\s*(?:minutes?|minute|menit|hours?|hour|hari|days?|day|weeks?|week|minggu|months?|month|bulan|years?|year|tahun|min|hr|jam|mo|yr)\b(?:\s*(?:ago|lalu))?$/i.test(token)
      || /^\d+\s*[mhdwy]$/i.test(token)
      || /^(?:yesterday|kemarin|just now|baru saja)$/i.test(token);
  }

  function hasCompactFacebookDateContext(text, token) {
    const normalized = normalizeFacebookHeaderDateText(normalizeText(text));
    if (!normalized || !token) return false;

    const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const remainder = normalizeText(normalized
      .replace(new RegExp(escapedToken, "i"), " ")
      .replace(/\b(?:pada|at|pukul|ago|lalu|edited|edit|diedit|updated|diupdate)\b/gi, " ")
      .replace(/\b(?:senin|selasa|rabu|kamis|jumat|sabtu|minggu|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, " ")
      .replace(/\b\d{1,2}[:.]\d{2}(?:\s*(?:am|pm))?\b/gi, " ")
      .replace(/[|·,:()\-]/g, " "));

    if (!remainder) return true;

    const words = remainder.split(/\s+/).filter(Boolean);
    return words.length <= 1 && words.every((word) => /^[0-9apm.]+$/i.test(word));
  }

  function isStrongFacebookDateCandidateText(text, token = extractFacebookDateToken(text)) {
    const normalized = normalizeFacebookHeaderDateText(normalizeText(text));
    if (!normalized || !token || isFragmentedFacebookHeaderText(normalized)) return false;
    if (isAbsoluteFacebookDateToken(token)) {
      if (normalized.length > Math.max(token.length + 24, 42)) return false;
      return hasCompactFacebookDateContext(normalized, token);
    }

    if (isRelativeFacebookDateToken(token)) {
      return normalized === token
        || normalized === `${token} ago`
        || normalized === `${token} lalu`
        || normalized.length <= token.length + 4;
    }

    return false;
  }

  function getComparableFacebookUrl(url) {
    if (!url) return "";
    try {
      const parsed = new URL(url, window.location.href);
      return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
    } catch (_) {
      return "";
    }
  }

  function collectFacebookHeaderDateText(node, authorNode = null) {
    const directText = collectFacebookDirectDateText(node, authorNode);
    if (isStrongFacebookDateCandidateText(directText)) return directText;

    const authorText = normalizeText(authorNode?.innerText || authorNode?.textContent || "");
    const parentText = normalizeText(node.parentElement?.innerText || node.parentElement?.textContent || "");
    const localParentText = parentText.length <= 80 ? parentText : "";
    const sources = [...new Set([
      directText,
      localParentText
    ]
      .map((value) => sanitizeFacebookHeaderDateText(value, authorText))
      .filter(Boolean))];

    const best = sources
      .map((text) => ({
        text,
        strong: isStrongFacebookDateCandidateText(text),
        absolute: isAbsoluteFacebookDateToken(extractFacebookDateToken(text)),
        short: text.length <= 40
      }))
      .filter((item) => !isFragmentedFacebookHeaderText(item.text))
      .sort((a, b) => {
        if (a.strong !== b.strong) return a.strong ? -1 : 1;
        if (a.absolute !== b.absolute) return a.absolute ? -1 : 1;
        if (a.short !== b.short) return a.short ? -1 : 1;
        return a.text.length - b.text.length;
      })[0];

    return best?.text || "";
  }

  function collectFacebookHeaderDateCandidates(root) {
    const headerBand = getFacebookHeaderBand(root);
    const authorNode = findFacebookAuthorNode(root, headerBand);
    const messageContainer = getFacebookMessageContainer(root);
    const ariaLabelledCandidates = collectFacebookAuthorAriaLabelledDateCandidates(root, authorNode);
    const adjacentCandidates = collectFacebookAuthorAdjacentDateCandidates(root, authorNode);
    const directCandidates = collectFacebookAuthorContextDateCandidates(root, authorNode);
    const nodes = [...root.querySelectorAll('a[href], span, div, abbr, time, [aria-labelledby], [aria-label], [title], [data-tooltip-content], [data-utime]')]
      .filter((node) => {
        if (!isNodeInsideFacebookHeaderBand(node, headerBand)) return false;
        if (messageContainer?.contains(node) && node !== messageContainer) return false;
        if (node.querySelector?.("img, video")) return false;
        return true;
      });

    const headerCandidates = nodes
      .map((node) => {
        const text = collectFacebookHeaderDateText(node, authorNode);
        return {
          node,
          kind: node.tagName?.toLowerCase() === "a" ? "link" : "text",
          text,
          score: node.tagName?.toLowerCase() === "a"
            ? scoreFacebookTimestampLink(node, root, authorNode)
            : scoreFacebookHeaderTextNode(node, text, root, authorNode)
        };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    const seen = new Set();
    return [...ariaLabelledCandidates, ...adjacentCandidates, ...directCandidates, ...headerCandidates]
      .filter((item) => {
        if (!item?.node || seen.has(item.node)) return false;
        seen.add(item.node);
        return true;
      })
      .sort((a, b) => b.score - a.score);
  }

  function scoreFacebookHeaderTextNode(node, combined, root, authorNode = null) {
    if (!combined) return 0;
    const token = extractFacebookDateToken(combined);
    if (!token) return 0;
    if (!isStrongFacebookDateCandidateText(combined, token)) return 0;
    if (/tampilkan lebih sedikit|lihat selengkapnya|website\s*:|twitter\s*:|youtube\s*:|tiktok\s*:/i.test(combined)) return 0;
    if (combined.length > 80) return 0;

    let score = 120;
    const rootRect = root?.getBoundingClientRect?.();
    const rect = node.getBoundingClientRect?.();
    if (rootRect && rect && rootRect.height > 0) {
      const verticalRatio = (rect.top - rootRect.top) / Math.max(rootRect.height, 1);
      if (verticalRatio <= 0.2) score += 80;
      else if (verticalRatio > 0.28) score -= 200;
    }

    if (authorNode?.compareDocumentPosition) {
      const relation = authorNode.compareDocumentPosition(node);
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) score += 70;
      if (relation & Node.DOCUMENT_POSITION_PRECEDING) score -= 120;
    }

    return score;
  }

  function collectFacebookCaptionCandidates(root, timestampLink = findFacebookTimestampLink(root)) {
    const directContainer = root.querySelector(
      '[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-testid="post_message"]'
    );
    if (directContainer) {
      return [{
        node: directContainer,
        followsTimestamp: Boolean(timestampLink && (timestampLink.compareDocumentPosition(directContainer) & Node.DOCUMENT_POSITION_FOLLOWING)),
        depth: getNodeDepth(directContainer, root),
        textLength: normalizeText(directContainer.innerText || directContainer.textContent || "").length
      }];
    }

    if (!timestampLink) return [];

    return [...root.querySelectorAll('div[dir="auto"], span[dir="auto"]')]
      .filter((node) => {
        if (!node.isConnected) return false;

        const text = cleanFacebookCaptionLine(node.innerText || node.textContent || "");
        if (!isPossibleFacebookCaption(text)) return false;

        const actionScope = node.closest('form, footer, nav');
        if (actionScope) return false;

        return true;
      })
      .map((node) => ({
        node,
        followsTimestamp: Boolean(timestampLink.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING),
        depth: getNodeDepth(node, root),
        textLength: normalizeText(node.innerText || node.textContent || "").length
      }))
      .sort((a, b) => {
        if (a.followsTimestamp !== b.followsTimestamp) return a.followsTimestamp ? -1 : 1;
        if (a.depth !== b.depth) return a.depth - b.depth;
        return b.textLength - a.textLength;
      });
  }

  function extractFacebookDateToken(text) {
    const normalized = normalizeText(text);
    if (!normalized || isFragmentedFacebookHeaderText(normalized)) return "";
    const absoluteNumeric = normalized.match(/\b(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]20\d{2})\b/);
    if (absoluteNumeric?.[0]) return absoluteNumeric[0];

    const monthNamePattern = "(jan(?:uary|uari)?|feb(?:ruary|ruari)?|mar(?:ch|et)?|apr(?:il)?|mei|may|jun(?:e|i)?|jul(?:y|i)?|aug(?:ust)?|agu(?:stus)?|sep(?:t|tember)?|okt(?:ober)?|oct(?:ober)?|nov(?:ember)?|des(?:ember)?|dec(?:ember)?)";
    const dayMonth = normalized.match(new RegExp(`\\b\\d{1,2}\\s+${monthNamePattern}(?:\\s+20\\d{2})?\\b`, "i"));
    if (dayMonth?.[0]) return dayMonth[0];

    const monthDay = normalized.match(new RegExp(`\\b${monthNamePattern}\\s+\\d{1,2}(?:,?\\s+20\\d{2})?\\b`, "i"));
    if (monthDay?.[0]) return monthDay[0];

    const relativeWord = normalized.match(/\b(\d+)\s*(minutes?|minute|menit|hours?|hour|hari|days?|day|weeks?|week|minggu|months?|month|bulan|years?|year|tahun|min|hr|jam|mo|yr|detik|seconds?|second|sec)\b(?:\s*(ago|lalu))?/i);
    if (relativeWord?.[0]) return relativeWord[0];

    if (/^\d+\s*[mhdwy]$/i.test(normalized)) return normalized;

    if (/\b(yesterday|kemarin|just now|baru saja)\b/i.test(normalized)) return normalized;
    return "";
  }

  function normalizeFacebookHeaderDateText(text) {
    let normalized = normalizeText(text);
    normalized = normalized.replace(/\byang lalu\b/gi, "lalu");
    normalized = normalized.replace(/\b([0-9])\s*\.\s*([0-9]{2})\s*h\b/gi, "$1.$2 h");
    normalized = normalized.replace(/\b([0-9])\s*([0-9])\s*h\b/gi, "$1$2h");
    normalized = normalized.replace(/\b([0-9])\s*([0-9])\s*jam\b/gi, "$1$2 jam");
    normalized = normalized.replace(/\b([0-9])\s*minggu\b/gi, "$1 minggu");
    normalized = normalized.replace(/\b([0-9])\s*hari\b/gi, "$1 hari");
    normalized = normalized.replace(/\b([0-9])\s*jam\b/gi, "$1 jam");
    normalized = normalized.replace(/\b([0-9])\s*menit\b/gi, "$1 menit");
    return normalized;
  }

  function parseFacebookDate(value) {
    if (!value) return "";
    const text = normalizeFacebookHeaderDateText(normalizeText(value)
      .replace(/\b(?:senin|selasa|rabu|kamis|jumat|sabtu|minggu|monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s*/gi, "")
      .replace(/\b(?:at|pukul)\b/gi, " "));
    if (!text || isFragmentedFacebookHeaderText(text)) return "";
    const timeMatch = text.match(/\b(\d{1,2})[:.](\d{2})(?:\s*(am|pm))?\b/i);
    const timeInfo = timeMatch
      ? {
          hours: Number(timeMatch[1]),
          minutes: Number(timeMatch[2]),
          meridiem: (timeMatch[3] || "").toLowerCase()
        }
      : null;

    const named = parseNamedMonthDate(text, timeInfo);
    if (named) return named;

    // Facebook commonly renders time as "12.19". Remove it before looking for
    // numeric dates so the time is not interpreted as 19 December.
    const textWithoutTime = timeMatch
      ? normalizeText(`${text.slice(0, timeMatch.index)} ${text.slice((timeMatch.index || 0) + timeMatch[0].length)}`)
      : text;
    const numericToken = textWithoutTime.match(/\b(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]20\d{2}|\d{1,2}[./-]\d{1,2})\b/);
    if (numericToken?.[0]) {
      const numeric = normalizeTikTokDate(numericToken[0]);
      if (numeric) return applyTimeToIso(numeric, timeInfo);
    }

    if (/^\d{10,13}$/.test(text)) {
      const timestampValue = Number(text.length === 10 ? `${text}000` : text);
      const timestampDate = new Date(timestampValue);
      return Number.isNaN(timestampDate.getTime()) ? "" : timestampDate.toISOString();
    }

    const relative = text.match(/^(\d+)\s*(minutes?|minute|menit|hours?|hour|hari|days?|day|weeks?|week|minggu|months?|month|bulan|years?|year|tahun|min|hr|jam|mo|yr|m|h|d|w|y)\b(?:\s*(ago|lalu))?$/i);
    if (relative) {
      const amount = Number(relative[1]);
      const unit = relative[2].toLowerCase();
      const multipliers = {
        m: 60000,
        min: 60000,
        minute: 60000,
        minutes: 60000,
        menit: 60000,
        h: 3600000,
        hr: 3600000,
        hour: 3600000,
        hours: 3600000,
        jam: 3600000,
        d: 86400000,
        day: 86400000,
        days: 86400000,
        hari: 86400000,
        w: 604800000,
        week: 604800000,
        weeks: 604800000,
        minggu: 604800000,
        mo: 2592000000,
        month: 2592000000,
        months: 2592000000,
        bulan: 2592000000,
        y: 31536000000,
        yr: 31536000000,
        year: 31536000000,
        years: 31536000000,
        tahun: 31536000000
      };
      const date = new Date(Date.now() - amount * (multipliers[unit] || 0));
      return Number.isNaN(date.getTime()) ? "" : date.toISOString();
    }

    if (/\b(yesterday|kemarin)\b/i.test(text)) {
      const date = new Date(Date.now() - 86400000);
      return date.toISOString();
    }
    if (/\b(just now|baru saja)\b/i.test(text)) return new Date().toISOString();

    return "";
  }

  function parseNamedMonthDate(text, timeInfo = null) {
    const monthNamePattern = "(jan(?:uary|uari)?|feb(?:ruary|ruari)?|mar(?:ch|et)?|apr(?:il)?|mei|may|jun(?:e|i)?|jul(?:y|i)?|aug(?:ust)?|agu(?:stus)?|sep(?:t|tember)?|okt(?:ober)?|oct(?:ober)?|nov(?:ember)?|des(?:ember)?|dec(?:ember)?)";
    const dayMonth = text.match(new RegExp(`\\b(\\d{1,2})\\s+${monthNamePattern}(?:\\s+(20\\d{2}))?\\b`, "i"));
    if (dayMonth) return buildInferredNamedDate(dayMonth[1], dayMonth[2], dayMonth[3], timeInfo);

    const monthDay = text.match(new RegExp(`\\b${monthNamePattern}\\s+(\\d{1,2})(?:,?\\s+(20\\d{2}))?\\b`, "i"));
    if (monthDay) return buildInferredNamedDate(monthDay[2], monthDay[1], monthDay[3], timeInfo);

    return "";
  }

  function buildInferredNamedDate(day, monthName, year, timeInfo = null) {
    const month = getMonthNumber(monthName);
    if (!month) return "";

    if (year) return buildIsoDateTime(year, month, day, timeInfo);
    return buildInferredMonthDayIso(month, day, timeInfo);
  }

  function getMonthNumber(monthName) {
    const key = normalizeText(monthName).toLowerCase().slice(0, 3);
    return {
      jan: 1,
      feb: 2,
      mar: 3,
      apr: 4,
      mei: 5,
      may: 5,
      jun: 6,
      jul: 7,
      aug: 8,
      agu: 8,
      sep: 9,
      okt: 10,
      oct: 10,
      nov: 11,
      des: 12,
      dec: 12
    }[key] || 0;
  }

  function extractFacebookReactionCount(root, text) {
    const patterns = [
      /([\d.,]+\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)\s+(?:reactions?|likes?|suka|reaksi)\b/i,
      /(?:reactions?|likes?|suka|reaksi)\D{0,20}([\d.,]+\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)/i
    ];
    const metricCandidates = collectFacebookMetricCandidates(root, ["reaction", "reactions", "like", "likes", "suka", "reaksi"], { bottomOnly: true });
    for (const candidate of metricCandidates) {
      const result = extractCountByPatterns(candidate, patterns);
      if (result.value !== null) return result;
    }

    const fromLines = extractFacebookReactionCountFromLines(text || "");
    if (fromLines.value !== null) return fromLines;

    return { value: null, raw: "" };
  }

  function extractFacebookMetricText(root) {
    const metricCandidates = collectFacebookMetricCandidates(
      root,
      ["comment", "comments", "komentar", "tanggapan", "share", "shares", "dibagikan", "bagikan", "reaction", "reactions", "like", "likes", "suka", "reaksi"],
      { bottomOnly: true, includeHref: true }
    );

    return metricCandidates.join("\n");
  }

  function findFacebookActionLineIndex(lines) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = normalizeText(lines[index]).toLowerCase();
      const matches = ["like", "suka", "comment", "komentari", "share", "bagikan"]
        .filter((token) => new RegExp(`(^|\\s)${token}($|\\s)`, "i").test(line))
        .length;
      if (matches >= 2) return index;
    }

    return -1;
  }

  function extractFacebookCountByLabel(root, text, labels) {
    const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const patterns = [
      new RegExp(`([\\d.,]+\\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)\\s+(?:${labelPattern})\\b`, "i"),
      new RegExp(`(?:${labelPattern})\\D{0,20}([\\d.,]+\\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)`, "i")
    ];
    const metricCandidates = collectFacebookMetricCandidates(root, labels, { bottomOnly: true, includeHref: true });
    for (const candidate of metricCandidates) {
      const result = extractCountByPatterns(candidate, patterns);
      if (result.value !== null) return result;
    }

    const fromLines = splitCleanLines(text || "")
      .map((line) => extractCountByPatterns(line, patterns))
      .find((result) => result.value !== null);
    if (fromLines) return fromLines;

    return { value: null, raw: "" };
  }

  function extractFacebookCommentCount(root, text) {
    const maxReasonableCommentCount = 100000;
    const labels = ["comments", "comment", "komentar", "tanggapan"];
    const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const primaryPatterns = [
      new RegExp(`([\\d.,]+\\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)\\s+(?:${labelPattern})\\b`, "i"),
      new RegExp(`([\\d.,]+\\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)\\s+(?:beri|lihat|tampilkan)?\\s*(?:${labelPattern})\\b`, "i"),
      new RegExp(`(?:view|lihat|see|tampilkan)\\s*(?:all|semua)?\\s*([\\d.,]+\\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)\\s+(?:${labelPattern})\\b`, "i")
    ];
    const secondaryPatterns = [
      new RegExp(`(?:${labelPattern})\\D{0,20}([\\d.,]+\\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)`, "i")
    ];
    const lines = splitCleanLines(text);
    const candidates = [];
    const pushCandidate = (result) => {
      if (isReasonableFacebookCommentCount(result, maxReasonableCommentCount)) candidates.push(result);
    };

    lines.forEach((line, index) => {
      pushCandidate(extractCountByPatterns(line, primaryPatterns));

      const currentLine = normalizeText(line);
      const previousLine = normalizeText(lines[index - 1] || "");
      const previousPreviousLine = normalizeText(lines[index - 2] || "");
      const nextLine = normalizeText(lines[index + 1] || "");
      const currentIsCommentLabel = new RegExp(`^(?:${labelPattern})$`, "i").test(currentLine);
      const previousIsNumber = isStandaloneMetricNumber(previousLine);
      const previousPreviousIsNumber = isStandaloneMetricNumber(previousPreviousLine);
      const nextIsAction = /^(like|suka|share|bagikan|comment|komentari)$/i.test(nextLine);

      if (currentIsCommentLabel && previousIsNumber && (previousPreviousIsNumber || nextIsAction)) {
        pushCandidate({
          value: parseHumanNumber(previousLine),
          raw: `${previousLine} ${currentLine}`
        });
      }
    });

    const positiveLine = candidates.find((result) => Number(result.value) > 0);
    if (positiveLine) return positiveLine;
    const zeroLine = candidates.find((result) => Number(result.value) === 0);
    if (zeroLine) return zeroLine;

    const metricCandidates = collectFacebookMetricCandidates(root, labels, { bottomOnly: true, includeHref: true });
    for (const candidate of metricCandidates) {
      const primaryCandidate = extractCountByPatterns(candidate, primaryPatterns);
      if (isReasonableFacebookCommentCount(primaryCandidate, maxReasonableCommentCount)) return primaryCandidate;

      const secondaryCandidate = extractCountByPatterns(candidate, secondaryPatterns);
      if (isReasonableFacebookCommentCount(secondaryCandidate, maxReasonableCommentCount)) return secondaryCandidate;
    }

    const buttonPattern = new RegExp(`([\\d.,]+\\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)\\s+(?:beri|lihat|tampilkan)\\s+(?:${labelPattern})\\b`, "i");
    const metricButtonNode = findFacebookMetricNodeSnapshots(root, labels).find((item) => buttonPattern.test(item.combined));
    if (metricButtonNode) {
      const result = extractCountByPatterns(metricButtonNode.combined, [buttonPattern]);
      if (isReasonableFacebookCommentCount(result, maxReasonableCommentCount)) return result;
    }

    const directNumberCandidate = findFacebookMetricNumberByNode(root, (node, combined) => {
      return /comment|komentar|tanggapan/i.test(combined)
        || /comment|comment_id/i.test(node.getAttribute?.("href") || "");
    });
    if (isReasonableFacebookCommentCount(directNumberCandidate, maxReasonableCommentCount)) return directNumberCandidate;

    return { value: 0, raw: "" };
  }

  function isReasonableFacebookCommentCount(result, maxCount) {
    if (result?.value === null || result?.value === undefined) return false;
    const value = Number(result.value);
    return Number.isFinite(value) && value >= 0 && value < maxCount;
  }

  function isStandaloneMetricNumber(value) {
    return /^[\d.,]+\s*(k|m|b|rb|ribu|jt|juta|million|thousand|billion)?$/i.test(normalizeText(value));
  }

  function extractFacebookReactionCountFromLines(text) {
    const lines = splitCleanLines(text);
    const metricIndex = lines.findIndex((line) => /\b(comments?|komentar|shares?|dibagikan|bagikan)\b/i.test(line));
    if (metricIndex <= 0) return { value: null, raw: "" };

    const fragmentedDigits = [];
    for (let index = metricIndex - 1; index >= Math.max(0, metricIndex - 4); index -= 1) {
      const line = normalizeText(lines[index]);
      if (/^\d$/.test(line)) {
        fragmentedDigits.unshift(line);
        continue;
      }

      if (fragmentedDigits.length >= 2) {
        const merged = fragmentedDigits.join("");
        return {
          value: parseHumanNumber(merged),
          raw: merged
        };
      }

      if (/^[\d.,]+\s*(k|m|b|rb|ribu|jt|juta|million|thousand|billion)?$/i.test(line)) {
        return {
          value: parseHumanNumber(line),
          raw: line
        };
      }

      if (fragmentedDigits.length) break;
    }

    if (fragmentedDigits.length >= 2) {
      const merged = fragmentedDigits.join("");
      return {
        value: parseHumanNumber(merged),
        raw: merged
      };
    }

    return { value: null, raw: "" };
  }

  function collectFacebookMetricCandidates(root, labels, options = {}) {
    return collectFacebookMetricNodeSnapshots(root, labels, options).map((item) => item.combined);
  }

  function findFacebookMetricNodeSnapshots(root, labels, options = {}) {
    return collectFacebookMetricNodeSnapshots(root, labels, options);
  }

  function collectFacebookMetricNodeSnapshots(root, labels, options = {}) {
    const labelRegex = new RegExp(labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
    const rootRect = root.getBoundingClientRect();
    const nodes = [];
    const seen = new Set();

    [...root.querySelectorAll("a, span, div")].forEach((node) => {
      const rect = node.getBoundingClientRect?.();
      if (!rect || rect.width < 10 || rect.height < 10) return;
      if (options.bottomOnly && rootRect.height > 0 && rect.top < rootRect.top + (rootRect.height * 0.35)) return;

      const leafMetricText = collectFacebookTopRowMetricText(node);
      const ownText = normalizeText(leafMetricText || node.innerText || node.textContent || "");
      const aria = normalizeText(node.getAttribute?.("aria-label") || "");
      const title = normalizeText(node.getAttribute?.("title") || "");
      const href = options.includeHref ? normalizeText(node.getAttribute?.("href") || "") : "";
      const combined = normalizeText(`${ownText} ${aria} ${title} ${href}`);
      if (isFacebookMetricNoiseNode(node, ownText, combined)) return;

      [combined].filter(Boolean).forEach((value) => {
        if (!labelRegex.test(value)) return;
        if (seen.has(value)) return;
        seen.add(value);
        nodes.push({
          node,
          combined: value,
          ownText,
          aria,
          title,
          href,
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        });
      });
    });

    return nodes;
  }

  function isFacebookMetricNoiseNode(node, ownText, combined) {
    const normalizedOwnText = normalizeText(ownText).toLowerCase();
    const normalizedCombined = normalizeText(combined).toLowerCase();
    const role = normalizeText(node.getAttribute?.("role") || "").toLowerCase();
    const ariaLabel = normalizeText(node.getAttribute?.("aria-label") || "").toLowerCase();

    if (!normalizedCombined) return true;
    if (/^(tulis komentar|write a comment|add a comment)(\.\.\.)?$/.test(normalizedOwnText)) return true;
    if (/^\d+\s+(tulis komentar|write a comment|add a comment)\b/.test(normalizedCombined)) return true;
    if (/^(like|suka|comment|komentar|komentari|share|bagikan)$/.test(normalizedOwnText)) return true;
    if (role === "button" && /^(like|suka|comment|komentar|komentari|share|bagikan)$/.test(ariaLabel)) return true;
    if (/dibagikan kepada publik|shared with public|public/.test(normalizedCombined) && !/\d/.test(normalizedOwnText)) return true;

    return false;
  }

  function findFacebookMetricNumberByNode(root, predicate) {
    const rootRect = root.getBoundingClientRect();
    const nodes = [...root.querySelectorAll("a, span, div")]
      .filter((node) => {
        const rect = node.getBoundingClientRect?.();
        if (!rect || rect.width < 10 || rect.height < 10) return false;
        if (rootRect.height > 0 && rect.top < rootRect.top + (rootRect.height * 0.35)) return false;

        const ownText = normalizeText(collectFacebookTopRowMetricText(node) || node.innerText || node.textContent || "");
        if (!isStandaloneMetricNumber(ownText)) return false;

        const combined = normalizeText([
          node.getAttribute?.("aria-label") || "",
          node.getAttribute?.("title") || "",
          node.parentElement?.innerText || "",
          node.parentElement?.textContent || ""
        ].join(" "));
        if (isFacebookMetricNoiseNode(node, ownText, combined)) return false;

        return predicate(node, combined);
      })
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return aRect.top - bRect.top;
      });

    const node = nodes[0];
    if (!node) return { value: null, raw: "" };

    const text = normalizeText(collectFacebookTopRowMetricText(node) || node.innerText || node.textContent || "");
    return {
      value: parseHumanNumber(text),
      raw: text
    };
  }


  function detectFacebookMediaInfo(root, postUrl) {
    const media = collectVisibleMedia(root);
    const imageCount = media.filter((item) => item.kind === "image").length;
    const detectedVideoCount = media.filter((item) => item.kind === "video").length;
    const videoCount = /\/(?:videos|watch|reel)\//.test(postUrl) || /[?&]v=/.test(postUrl)
      ? Math.max(1, detectedVideoCount)
      : detectedVideoCount;
    const hasCarousel = videoCount > 0
      ? hasCarouselControls(root) || detectedVideoCount > 1
      : imageCount > 1;
    const mediaCount = videoCount > 0
      ? hasCarousel ? Math.max(2, imageCount + videoCount) : 1
      : Math.max(1, imageCount);

    if (videoCount > 0) {
      return {
        contentType: hasCarousel ? "carousel_video" : "video",
        contentTypeLabel: hasCarousel ? "Carousel video" : "Video",
        mediaCount,
        imageCount: hasCarousel ? imageCount : 0,
        videoCount
      };
    }

    return {
      contentType: hasCarousel ? "carousel_image" : "image",
      contentTypeLabel: hasCarousel ? "Carousel gambar" : "Gambar",
      mediaCount,
      imageCount: Math.max(1, imageCount || mediaCount),
      videoCount: 0
    };
  }

  function getPostCardRoot(link) {
    let node = link;
    for (let depth = 0; node?.parentElement && depth < 6; depth += 1) {
      const parent = node.parentElement;
      if (parent.querySelectorAll?.('a[href*="/video/"], a[href*="/photo/"]').length > 1) {
        return node;
      }
      node = parent;
    }
    return node || link;
  }

  function extractInstagramCaption(article) {
    const username = getUsernameFromArticle(article);
    const directCaption = findDirectCaption(article, username);
    if (directCaption) return directCaption;

    const candidates = [...article.querySelectorAll('h1, ul li, span[dir="auto"], div[dir="auto"]')]
      .map((node) => cleanCaptionText(node, username))
      .filter((text) => isPossibleInstagramCaption(text, username))
      .sort((a, b) => scoreCaption(b, username) - scoreCaption(a, username));

    return candidates[0] || parseCaptionFromMeta("instagram") || "";
  }

  function extractTikTokCaption(root) {
    const selectors = [
      '[data-e2e="browse-video-desc"]',
      '[data-e2e="video-desc"]',
      '[data-e2e="new-desc-span"]',
      '[data-e2e="search-card-video-caption"]',
      '[data-e2e="browse-video-desc"] span',
      '[data-e2e="video-desc"] span',
      'h1[data-e2e]',
      'div[data-e2e*="desc"]'
    ];

    const direct = collectTextsFromSelectors(selectors, root)
      .map((text) => extractTikTokCaptionFromText(text, true))
      .find(Boolean);
    if (direct) return direct;

    const fromRootText = extractTikTokCaptionFromText(root.innerText || root.textContent || "");
    if (fromRootText) return fromRootText;

    const candidates = [...root.querySelectorAll('span, div, h1, h2')]
      .map((node) => normalizeText(node.innerText || node.textContent || ""))
      .map((text) => extractTikTokCaptionFromText(text, true))
      .filter((text) => text.length > 2 && isPossibleTikTokCaption(text))
      .sort((a, b) => scoreCaption(b, "") - scoreCaption(a, ""));

    return candidates[0] || "";
  }

  function extractTikTokCaptionFromText(text, allowAnyCaptionLine = false) {
    const lines = splitCleanLines(text);
    if (!lines.length) return "";

    const afterDateIndex = lines.findIndex((line) => Boolean(extractTikTokDateFromText(line)));
    const afterDateCaption = findFirstTikTokCaptionLine(lines, afterDateIndex >= 0 ? afterDateIndex + 1 : 0);
    if (afterDateCaption) return afterDateCaption;

    const followIndex = lines.findIndex((line) => /^(follow|ikuti|mengikuti|following)$/i.test(line));
    const afterFollowCaption = findFirstTikTokCaptionLine(lines, followIndex >= 0 ? followIndex + 1 : 0);
    if (afterFollowCaption) return afterFollowCaption;

    if ((allowAnyCaptionLine || lines.length === 1) && isPossibleTikTokCaption(lines[0])) {
      return cleanTikTokCaptionLine(lines[0]);
    }

    return "";
  }

  function findFirstTikTokCaptionLine(lines, startIndex) {
    for (let index = Math.max(0, startIndex); index < lines.length; index += 1) {
      const line = cleanTikTokCaptionLine(lines[index]);
      if (isPossibleTikTokCaption(line)) return line;
    }
    return "";
  }

  function cleanTikTokCaptionLine(line) {
    return normalizeText(line)
      .replace(/\b(See translation|Lihat terjemahan|Translate|Terjemahkan)\b/gi, "")
      .trim();
  }

  function expandCaptionText(root) {
    [...root.querySelectorAll("button, [role='button'], span, div")].some((node) => {
      const text = normalizeText(node.textContent || "").toLowerCase();
      const label = normalizeText(node.getAttribute?.("aria-label") || "").toLowerCase();
      if (!/^(more|lainnya|selengkapnya|lihat selengkapnya|see more)$/.test(text) && !/^(more|lainnya|selengkapnya|lihat selengkapnya|see more)$/.test(label)) {
        return false;
      }

      node.click?.();
      return true;
    });
  }

  async function expandFacebookCaptionText(root) {
    const scope = getFacebookMessageContainer(root) || root;
    const selectors = "button, [role='button'], span, div";
    const buttons = [...scope.querySelectorAll(selectors)]
      .filter((node) => {
        const text = normalizeText(node.textContent || "").toLowerCase();
        const label = normalizeText(node.getAttribute?.("aria-label") || "").toLowerCase();
        return /^(lihat selengkapnya|see more|selengkapnya|lainnya|more)$/.test(text)
          || /^(lihat selengkapnya|see more|selengkapnya|lainnya|more)$/.test(label);
      });

    if (!buttons.length) return false;

    const target = buttons.sort((a, b) => getNodeDepth(a, root) - getNodeDepth(b, root))[0];
    target.click?.();
    await sleep(1000);
    return true;
  }

  function getNodeDepth(node, root = document.body) {
    let depth = 0;
    let current = node;

    while (current && current !== root && current.parentElement) {
      depth += 1;
      current = current.parentElement;
    }

    return depth;
  }

  function findDirectCaption(article, username) {
    const selectors = [
      "h1",
      'ul li h1',
      'ul li span[dir="auto"]',
      'article div[role="button"] + div span[dir="auto"]'
    ];

    for (const selector of selectors) {
      const candidates = [...article.querySelectorAll(selector)]
        .map((node) => cleanCaptionText(node, username))
        .filter((text) => isPossibleInstagramCaption(text, username));

      if (candidates.length) {
        return candidates.sort((a, b) => scoreCaption(b, username) - scoreCaption(a, username))[0];
      }
    }

    return "";
  }

  function cleanCaptionText(node, username) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll?.("time, button, svg, [aria-label]").forEach((child) => child.remove());

    let text = normalizeText(clone.innerText || clone.textContent || "");
    text = text.replace(/\b(more|lainnya|selengkapnya)\b$/i, "").trim();

    if (username) {
      const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = text.replace(new RegExp(`^${escaped}\\s+`, "i"), "").trim();
    }

    return text;
  }

  function scoreCaption(text, username) {
    let score = Math.min(text.length, 280);
    if (/#\S+/.test(text)) score += 35;
    if (/@\S+/.test(text)) score += 15;
    if (/[.!?]|\n/.test(text)) score += 10;
    if (username && text.toLowerCase().startsWith(username.toLowerCase())) score -= 80;
    if (/^(view all|lihat semua|liked by|disukai oleh)/i.test(text)) score -= 120;
    return score;
  }

  function parseCaptionFromMeta(platform) {
    const fields = [
      document.querySelector('meta[property="og:title"]')?.getAttribute("content") || "",
      document.querySelector('meta[property="og:description"]')?.getAttribute("content") || "",
      document.querySelector('meta[name="description"]')?.getAttribute("content") || ""
    ];

    for (const content of fields) {
      if (platform === "tiktok") {
        const tiktokCaption = content
          .replace(/\s*\|?\s*TikTok\s*$/i, "")
          .replace(/^Watch .*?'s video\s*$/i, "")
          .trim();
        if (tiktokCaption && !/^Watch .* video$/i.test(tiktokCaption)) return normalizeText(tiktokCaption);
      }

      const quoted = content.match(/"([^"]+)"/);
      if (quoted?.[1]) return normalizeText(quoted[1]);

      const split = content.split(" on Instagram:");
      if (split[1]) return normalizeText(split[1].replace(/^["\s]+|["\s]+$/g, ""));

      const colonSplit = content.match(/:\s*["']?(.+?)["']?$/);
      if (colonSplit?.[1] && !/^\d/.test(colonSplit[1])) return normalizeText(colonSplit[1]);
    }

    return "";
  }

  function getUsernameFromArticle(article) {
    const link = article.querySelector('header a[href^="/"], a[href^="/"][role="link"]');
    return normalizeText(link?.textContent || "").split(" ")[0];
  }

  function isPossibleInstagramCaption(text, username) {
    if (!text || text.length < 2) return false;
    if (username && text === username) return false;
    if (/^(like|likes|suka|reply|balas|view replies|lihat balasan|follow|ikuti)$/i.test(text)) return false;
    if (/^(add a comment|tambahkan komentar|more|lainnya|selengkapnya)$/i.test(text)) return false;
    if (/^(view all|lihat semua|liked by|disukai oleh)/i.test(text)) return false;
    if (/^\d+\s+(w|d|h|m|s|minggu|hari|jam|menit|detik)$/i.test(text)) return false;
    if (/^\d+([.,]\d+)?\s*(likes?|suka|comments?|komentar)$/i.test(text)) return false;
    return true;
  }

  function isTikTokMetricText(text) {
    return /^(like|likes|suka|comment|comments|komentar|share|shares|bagikan|save|saved|favorite|view|views|followers?|following)$/i.test(text)
      || /^[\d.,]+\s*(k|m|b|rb|ribu|jt|juta)?$/i.test(text)
      || text.length > 500;
  }

  function isPossibleTikTokCaption(text) {
    if (!text || text.length < 2) return false;
    if (isTikTokMetricText(text)) return false;
    if (extractTikTokDateFromText(text) === text) return false;
    if (/^(follow|ikuti|mengikuti|following|see translation|lihat terjemahan|translate|terjemahkan)$/i.test(text)) return false;
    if (/^[@\w.-]{2,40}$/.test(text) && !/#|@|\s/.test(text)) return false;
    if (/^.+\s+-\s+.+$/.test(text) && !/[#.!?]|\b(berita|mei|juni|juli|202\d)\b/i.test(text)) return false;
    if (/^(original sound|suara asli|music|musik)\b/i.test(text)) return false;
    return true;
  }

  function detectPreviewType(link, postUrl, platform) {
    if (platform === "tiktok") {
      if (/\/photo\//.test(postUrl)) return "photo";
      return "video";
    }

    if (/\/(?:reel|tv)\//.test(postUrl)) return "video";

    const label = collectNearbyLabels(link).toLowerCase();
    if (/\b(reel|video|play|putar|tonton)\b/i.test(label)) return "video";
    if (/\b(carousel|album|multiple|slide|beberapa|multiple photos|multiple videos)\b/i.test(label)) {
      return "carousel";
    }

    return "image";
  }

  function detectInstagramMediaInfo(article, postUrl, previewType = "image") {
    const media = collectVisibleMedia(article);
    const imageCount = media.filter((item) => item.kind === "image").length;
    const videoCountFromDom = media.filter((item) => item.kind === "video").length;
    const videoCount = /\/(?:reel|tv)\//.test(postUrl) || previewType === "video"
      ? Math.max(1, videoCountFromDom)
      : videoCountFromDom;
    const detectedMediaCount = Math.max(1, imageCount + videoCount);
    const hasCarousel = previewType === "carousel" || hasCarouselControls(article) || (videoCount === 0 && detectedMediaCount > 1);

    if (videoCount > 0 && hasCarousel) {
      return {
        contentType: "carousel_video",
        contentTypeLabel: "Carousel video",
        mediaCount: detectedMediaCount,
        imageCount,
        videoCount
      };
    }

    if (videoCount > 0) {
      return {
        contentType: "video",
        contentTypeLabel: "Video",
        mediaCount: 1,
        imageCount: 0,
        videoCount
      };
    }

    return {
      contentType: hasCarousel ? "carousel_image" : "image",
      contentTypeLabel: hasCarousel ? "Carousel gambar" : "Gambar",
      mediaCount: detectedMediaCount,
      imageCount: Math.max(1, imageCount || detectedMediaCount),
      videoCount: 0
    };
  }

  function detectTikTokMediaInfo(root, postUrl, stateItem) {
    const media = collectVisibleMedia(root);
    const stateImages = Array.isArray(stateItem?.imagePost?.images)
      ? stateItem.imagePost.images.length
      : Array.isArray(stateItem?.images)
        ? stateItem.images.length
        : 0;
    const imageCount = Math.max(stateImages, media.filter((item) => item.kind === "image").length);
    const videoCount = /\/video\//.test(postUrl) ? 1 : media.filter((item) => item.kind === "video").length;

    if (/\/photo\//.test(postUrl) || imageCount > 1) {
      return {
        contentType: "carousel_image",
        contentTypeLabel: "Carousel gambar",
        mediaCount: Math.max(1, imageCount),
        imageCount: Math.max(1, imageCount),
        videoCount: 0
      };
    }

    return {
      contentType: "video",
      contentTypeLabel: "Video",
      mediaCount: 1,
      imageCount: 0,
      videoCount: Math.max(1, videoCount)
    };
  }

  function collectVisibleMedia(root) {
    const seen = new Set();
    const media = [];

    [...root.querySelectorAll("img, video")].forEach((item) => {
      const rect = item.getBoundingClientRect();
      const src = item.currentSrc || item.src || item.poster || "";
      if (rect.width < 120 || rect.height < 120 || /s150x150|profile|avatar/i.test(src)) return;

      const key = `${item.tagName}:${src || rect.width + "x" + rect.height}`;
      if (seen.has(key)) return;

      seen.add(key);
      media.push({ kind: item.tagName.toLowerCase() === "video" ? "video" : "image", src });
    });

    return media;
  }

  function hasCarouselControls(root) {
    const labels = [...root.querySelectorAll("button, [role='button'], [aria-label]")]
      .map((node) => `${node.getAttribute?.("aria-label") || ""} ${node.textContent || ""}`)
      .join(" ")
      .toLowerCase();

    return /\b(next|previous|selanjutnya|berikutnya|sebelumnya)\b/.test(labels);
  }

  function extractInstagramLikeCount(text) {
    const patterns = [
      /([\d.,]+\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)\s+(?:likes?|suka)\b/i,
      /(?:liked by|disukai oleh)\s+.+?\s+(?:and|dan)\s+([\d.,]+\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)\s+(?:others?|lainnya)/i
    ];
    return extractCountByPatterns(text, patterns);
  }

  function extractInstagramCommentCount(text) {
    const patterns = [
      /(?:view all|lihat semua)\s+([\d.,]+\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)\s+(?:comments?|komentar)/i,
      /([\d.,]+\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)\s+(?:comments?|komentar)\b/i
    ];
    return extractCountByPatterns(text, patterns);
  }

  function extractTikTokCountByLabel(text, labels) {
    const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const patterns = [
      new RegExp(`([\\d.,]+\\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)\\s+(?:${labelPattern})\\b`, "i"),
      new RegExp(`(?:${labelPattern})\\s+([\\d.,]+\\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)`, "i")
    ];
    return extractCountByPatterns(normalizeText(text), patterns);
  }

  function extractCountByPatterns(text, patterns) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        return {
          value: parseHumanNumber(match[1]),
          raw: normalizeText(match[0])
        };
      }
    }
    return { value: null, raw: "" };
  }

  function pickMetric(...values) {
    for (const value of values) {
      if (value === null || value === undefined || value === "") continue;
      if (typeof value === "object" && "value" in value) return value;

      const parsed = parseHumanNumber(value);
      if (Number.isFinite(parsed)) {
        return { value: parsed, raw: normalizeText(value) };
      }
    }

    return { value: null, raw: "" };
  }

  function textFromSelectors(selectors, root = document) {
    for (const selector of selectors) {
      try {
        const node = root.querySelector(selector);
        const text = normalizeText(node?.innerText || node?.textContent || node?.getAttribute?.("aria-label") || "");
        if (text) return text;
      } catch {
        continue;
      }
    }
    return "";
  }

  function collectTextsFromSelectors(selectors, root = document) {
    const texts = [];
    const seen = new Set();

    selectors.forEach((selector) => {
      try {
        root.querySelectorAll(selector).forEach((node) => {
          const values = [
            node.innerText,
            node.textContent,
            node.getAttribute?.("aria-label"),
            node.getAttribute?.("title")
          ];

          values.map(normalizeText).filter(Boolean).forEach((text) => {
            if (seen.has(text)) return;
            seen.add(text);
            texts.push(text);
          });
        });
      } catch {
        // Selector support differs across TikTok experiments.
      }
    });

    return texts;
  }

  function splitCleanLines(text) {
    return String(text || "")
      .split(/\r?\n|[•·]/)
      .map(normalizeText)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  function getTikTokStateCaption(item) {
    if (!item || typeof item !== "object") return "";

    const values = [
      item.desc,
      item.description,
      item.caption,
      item.title,
      item.shareMeta?.desc,
      item.shareMeta?.title,
      item.video?.desc,
      item.itemStruct?.desc,
      item.itemStruct?.description,
      item.itemStruct?.caption
    ];

    return values
      .map(normalizeText)
      .map(extractTikTokCaptionFromText)
      .find(Boolean) || values.map(normalizeText).find((text) => isPossibleTikTokCaption(text)) || "";
  }

  function getTikTokStateDate(item) {
    if (!item || typeof item !== "object") return "";

    const values = [
      item.createTime,
      item.createTimeMs,
      item.create_time,
      item.datePublished,
      item.uploadDate,
      item.publishTime,
      item.itemStruct?.createTime,
      item.itemStruct?.create_time,
      item.itemStruct?.datePublished,
      item.itemStruct?.uploadDate
    ];

    return values.find((value) => value !== null && value !== undefined && value !== "") || "";
  }

  function findTikTokItemData(preferredId) {
    const parsedScripts = [...document.querySelectorAll("script")]
      .map((script) => parsePossibleJson(script.textContent || ""))
      .filter(Boolean);

    for (const root of parsedScripts) {
      const item = findTikTokItemInObject(root, preferredId);
      if (item) return item;
    }

    return null;
  }

  function parsePossibleJson(text) {
    const trimmed = text.trim();
    if (!trimmed) return null;

    const jsonCandidates = [trimmed];
    const assignmentMatch = trimmed.match(/=\s*({[\s\S]+});?$/);
    if (assignmentMatch?.[1]) jsonCandidates.push(assignmentMatch[1]);

    for (const candidate of jsonCandidates) {
      try {
        return JSON.parse(candidate);
      } catch {
        continue;
      }
    }

    return null;
  }

  function findTikTokItemInObject(root, preferredId) {
    const queue = [root];
    const seen = new WeakSet();
    let inspected = 0;
    let fallback = null;

    while (queue.length && inspected < 60000) {
      const value = queue.shift();
      if (!value || typeof value !== "object") continue;
      if (seen.has(value)) continue;
      seen.add(value);
      inspected += 1;

      if (isTikTokItemNode(value)) {
        if (preferredId && getTikTokStateItemId(value) === String(preferredId)) {
          return value;
        }
        if (!preferredId) fallback ||= value;
      }

      if (value.ItemModule && typeof value.ItemModule === "object") {
        const item = preferredId ? value.ItemModule[preferredId] : Object.values(value.ItemModule)[0];
        if (item) return item;
      }

      for (const child of Object.values(value)) {
        if (child && typeof child === "object") queue.push(child);
      }
    }

    return fallback;
  }

  function isTikTokItemNode(value) {
    const hasId = getTikTokStateItemId(value);
    const hasText = getTikTokStateCaption(value);
    const hasTime = getTikTokStateDate(value);
    const hasStats = value.stats || value.statsV2 || value.statistics || value.diggCount || value.commentCount || value.shareCount;
    return Boolean(hasId && (hasText || hasTime || hasStats));
  }

  function getTikTokStateItemId(item) {
    if (!item || typeof item !== "object") return "";

    return String(
      item.id
      || item.itemId
      || item.aweme_id
      || item.awemeId
      || item.videoId
      || item.video?.id
      || item.itemStruct?.id
      || item.itemStruct?.itemId
      || item.itemStruct?.aweme_id
      || item.itemStruct?.awemeId
      || ""
    );
  }

  function normalizeTikTokDate(value) {
    if (value === null || value === undefined || value === "") return "";

    if (typeof value === "number" || /^\d+$/.test(String(value))) {
      const number = Number(value);
      const milliseconds = number > 100000000000 ? number : number * 1000;
      const date = new Date(milliseconds);
      return Number.isNaN(date.getTime()) ? "" : date.toISOString();
    }

    const text = normalizeText(value);
    const ymd = text.match(/\b(20\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/);
    if (ymd) return buildIsoDate(ymd[1], ymd[2], ymd[3]);

    const dmy = text.match(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/);
    if (dmy) return buildIsoDate(dmy[3], dmy[2], dmy[1]);

    const monthDay = text.match(/\b(0?[1-9]|1[0-2])[./-](0?[1-9]|[12]\d|3[01])\b/);
    if (monthDay) return buildInferredMonthDayIso(monthDay[1], monthDay[2]);

    const isoDate = new Date(text);
    if (!Number.isNaN(isoDate.getTime())) return isoDate.toISOString();

    return "";
  }

  function extractTikTokVisibleDate(root) {
    const focusedSelectors = [
      '[data-e2e="browser-nickname"]',
      '[data-e2e="video-author-uniqueid"]',
      '[data-e2e="browse-username"]',
      '[data-e2e="video-desc"]',
      '[data-e2e="browse-video-desc"]'
    ];

    const focusedText = focusedSelectors
      .flatMap((selector) => {
        try {
          return [...root.querySelectorAll(selector)].flatMap((node) => [
            node.innerText || node.textContent || "",
            node.parentElement?.innerText || node.parentElement?.textContent || ""
          ]);
        } catch {
          return [];
        }
      })
      .map(extractTikTokDateFromText)
      .find(Boolean);

    if (focusedText) return normalizeTikTokDate(focusedText);

    const lines = String(root.innerText || root.textContent || "")
      .split(/\r?\n/)
      .map(normalizeText)
      .filter(Boolean);
    const lineDate = lines
      .map(extractTikTokDateFromText)
      .find(Boolean);

    return normalizeTikTokDate(lineDate);
  }

  function extractTikTokDateFromText(text) {
    const normalized = normalizeText(text);
    const absolute = normalized.match(/\b20\d{2}[./-]\d{1,2}[./-]\d{1,2}\b/)
      || normalized.match(/\b\d{1,2}[./-]\d{1,2}[./-]20\d{2}\b/);
    if (absolute?.[0]) return absolute[0];

    const monthDay = normalized.match(/\b(0?[1-9]|1[0-2])[./-](0?[1-9]|[12]\d|3[01])\b/);
    if (monthDay?.[0]) return monthDay[0];

    const relative = normalized.match(/\b(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hour|hours|d|day|days|w|week|weeks|detik|menit|jam|hari|minggu)\s*(ago|lalu)?\b/i);
    if (!relative) return "";

    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const multipliers = {
      s: 1000,
      sec: 1000,
      second: 1000,
      seconds: 1000,
      detik: 1000,
      m: 60000,
      min: 60000,
      minute: 60000,
      minutes: 60000,
      menit: 60000,
      h: 3600000,
      hour: 3600000,
      hours: 3600000,
      jam: 3600000,
      d: 86400000,
      day: 86400000,
      days: 86400000,
      hari: 86400000,
      w: 604800000,
      week: 604800000,
      weeks: 604800000,
      minggu: 604800000
    };

    const date = new Date(Date.now() - amount * (multipliers[unit] || 0));
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }

  function buildIsoDate(year, month, day) {
    return buildIsoDateTime(year, month, day, null);
  }

  function buildIsoDateTime(year, month, day, timeInfo = null) {
    const hours = normalizeHours(timeInfo?.hours ?? 0, timeInfo?.meridiem || "");
    const minutes = timeInfo?.minutes ?? 0;
    const date = new Date(
      `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`
    );
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }

  function buildInferredMonthDayIso(month, day, timeInfo = null) {
    const now = new Date();
    let year = now.getFullYear();
    let date = new Date(year, Number(month) - 1, Number(day), normalizeHours(timeInfo?.hours ?? 0, timeInfo?.meridiem || ""), timeInfo?.minutes ?? 0, 0);

    if (date.getTime() - now.getTime() > 86400000) {
      year -= 1;
      date = new Date(year, Number(month) - 1, Number(day), normalizeHours(timeInfo?.hours ?? 0, timeInfo?.meridiem || ""), timeInfo?.minutes ?? 0, 0);
    }

    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }

  function applyTimeToIso(isoString, timeInfo = null) {
    if (!isoString || !timeInfo) return isoString;

    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return isoString;

    date.setHours(normalizeHours(timeInfo.hours ?? 0, timeInfo.meridiem || ""), timeInfo.minutes ?? 0, 0, 0);
    return date.toISOString();
  }

  function normalizeHours(hours, meridiem) {
    const numericHours = Number(hours) || 0;
    if (meridiem === "pm" && numericHours < 12) return numericHours + 12;
    if (meridiem === "am" && numericHours === 12) return 0;
    return numericHours;
  }

  function parseHumanNumber(input) {
    if (input === null || input === undefined || input === "") return null;

    const raw = normalizeText(input).toLowerCase();
    const match = raw.match(/([\d.,]+)\s*(k|m|b|rb|ribu|jt|juta|million|thousand|billion)?/i);
    if (!match) return null;

    const suffix = match[2] || "";
    const number = parseLocaleNumber(match[1], Boolean(suffix));
    const multiplier = {
      k: 1000,
      rb: 1000,
      ribu: 1000,
      thousand: 1000,
      m: 1000000,
      jt: 1000000,
      juta: 1000000,
      million: 1000000,
      b: 1000000000,
      billion: 1000000000
    }[suffix] || 1;

    return Math.round(number * multiplier);
  }

  function parseLocaleNumber(value, hasSuffix) {
    const clean = String(value).replace(/[^\d.,]/g, "");
    if (!clean) return 0;

    if (hasSuffix) {
      return Number(clean.replace(",", ".")) || 0;
    }

    const separators = [...clean.matchAll(/[.,]/g)].map((match) => match.index);
    if (!separators.length) return Number(clean) || 0;

    const lastSeparator = separators.at(-1);
    const decimals = clean.length - lastSeparator - 1;
    const integerPart = clean.slice(0, lastSeparator).replace(/[.,]/g, "");
    const fractionalPart = clean.slice(lastSeparator + 1);

    if (decimals === 3) {
      return Number(clean.replace(/[.,]/g, "")) || 0;
    }

    if (decimals > 3 && /^0+$/.test(fractionalPart)) {
      return Number(integerPart) || 0;
    }

    if (decimals <= 2) {
      return Number(clean.replace(",", ".")) || 0;
    }

    return Number(clean.replace(/[.,]/g, "")) || Number(clean.replace(",", ".")) || 0;
  }

  async function closePost(beforeUrl, platform) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    await sleep(500);

    const closeButton = findButtonByLabel(["close", "tutup"]);
    if (closeButton) {
      closeButton.click();
      await sleep(500);
    }

    if (beforeUrl !== location.href && getPostId(platform, location.href)) {
      history.back();
      await waitFor(() => location.href === beforeUrl || !getPostId(platform, location.href), 8000);
      await sleep(700);
    }
  }

  function findButtonByLabel(labels) {
    const buttons = [...document.querySelectorAll("button, [role='button']")];
    return buttons.find((button) => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.toLowerCase();
      return labels.some((item) => label.includes(item));
    });
  }

  async function scrollForMorePosts(anchor = null) {
    const beforeY = window.scrollY;
    const beforeHeight = document.documentElement.scrollHeight;
    await setStatus("running", "Mencari post berikutnya", "Scroll halaman untuk memuat post yang lebih lama.");

    if (run.platform === "facebook" && anchor?.scrollIntoView) {
      anchor.scrollIntoView({ block: "end", inline: "nearest" });
      await sleep(300);
      window.scrollBy({ top: Math.round(window.innerHeight * 0.9), behavior: "smooth" });
      await sleep(randomBetween(3000, 7000));
    } else {
      window.scrollBy({ top: Math.round(window.innerHeight * 1.35), behavior: "smooth" });
      await sleep(Math.max(run.options.delayMs, 1300));
    }

    return window.scrollY !== beforeY || document.documentElement.scrollHeight !== beforeHeight;
  }

  function parseCutoff(value) {
    if (!value) return null;
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function parseStartDate(value) {
    if (!value) return null;
    const date = new Date(`${value}T23:59:59.999`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function cleanUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      parsed.search = "";
      parsed.hash = "";
      return parsed.href;
    } catch {
      return url || "";
    }
  }

  function cleanPostUrl(platform, url) {
    if (platform === "facebook") return cleanFacebookUrl(url);
    return cleanUrl(url);
  }

  function getPathname(url) {
    try {
      return new URL(url, location.origin).pathname;
    } catch {
      return "";
    }
  }

  function escapeRegex(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function isElementVisiblyRenderable(element) {
    const rect = element?.getBoundingClientRect?.();
    return Boolean(rect && rect.width >= 40 && rect.height >= 40);
  }

  function cleanFacebookUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      const normalized = new URL(`${parsed.origin}${parsed.pathname}`);
      normalized.hash = "";

      ["story_fbid", "id", "fbid", "v", "scs_fb_post"].forEach((key) => {
        const value = parsed.searchParams.get(key);
        if (value) normalized.searchParams.set(key, value);
      });

      return normalized.href;
    } catch {
      return url || "";
    }
  }

  function getPostId(platform, url) {
    if (platform === "facebook") {
      return getFacebookPostId(url);
    }

    const pattern = platform === "tiktok"
      ? /\/(?:video|photo)\/([^/?#]+)/
      : /\/(?:p|reel|tv)\/([^/?#]+)/;
    const match = String(url).match(pattern);
    return match?.[1] || "";
  }

  function getFacebookPostId(url) {
    try {
      const parsed = new URL(url, location.origin);
      const queryId = parsed.searchParams.get("story_fbid")
        || parsed.searchParams.get("fbid")
        || parsed.searchParams.get("v")
        || parsed.searchParams.get("scs_fb_post");
      if (queryId) return queryId;
    } catch {
      // Fall through to path matching.
    }

    const match = String(url).match(/\/(?:posts|permalink|videos|reel|watch|share\/p|share\/r|share\/v)\/([^/?#]+)/i)
      || String(url).match(/\/photo\/[^/?#]*\/?([^/?#]+)?/i);
    return match?.[1] || "";
  }

  function isTikTokPostUrl(url) {
    return /\/(?:video|photo)\/[^/?#]+/.test(String(url || ""));
  }

  function isFacebookPostUrl(url) {
    const text = String(url || "");
    return /\/(?:posts|permalink|videos|reel|watch|share\/p|share\/r|share\/v)\//i.test(text)
      || /[?&](story_fbid|fbid|v|scs_fb_post)=/i.test(text)
      || /\/photo(?:\.php|\/)/i.test(text);
  }

  function makeSyntheticFacebookPostUrl(root, index) {
    const text = normalizeText(root.innerText || root.textContent || "");
    const date = extractFacebookDateToken(text) || "";
    const caption = extractFacebookCaption(root) || "";
    const fingerprint = hashText(`${index}|${date}|${caption}|${text.slice(0, 300)}`);

    try {
      const parsed = new URL(location.href);
      parsed.hash = "";
      parsed.search = "";
      parsed.searchParams.set("scs_fb_post", fingerprint);
      return parsed.href;
    } catch {
      return `${location.origin}${location.pathname}?scs_fb_post=${fingerprint}`;
    }
  }

  function hashText(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function normalizeText(value) {
    return String(value).replace(/\s+/g, " ").trim();
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  }

  function randomBetween(min, max) {
    const lower = Math.min(min, max);
    const upper = Math.max(min, max);
    return Math.round(lower + Math.random() * (upper - lower));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(predicate, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (predicate()) return true;
      await sleep(150);
    }
    return false;
  }

  async function setStatus(state, title, message) {
    await chrome.storage.local.set({
      [STORAGE_STATUS]: {
        state,
        title,
        message,
        updatedAt: new Date().toISOString()
      }
    });
  }
})();
