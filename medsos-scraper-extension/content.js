(() => {
  const STORAGE_RESULTS = "social_scraper_results";
  const STORAGE_STATUS = "social_scraper_status";
  const LEGACY_RESULTS = "igs_results";
  const LEGACY_STATUS = "igs_status";

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
    platform: "",
    seen: new Set(),
    results: [],
    addedCount: 0,
    options: {}
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SCS_START" || message?.type === "IGS_START") {
      start(message.payload || {});
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === "SCS_STOP" || message?.type === "IGS_STOP") {
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

    const stored = await chrome.storage.local.get([STORAGE_RESULTS, LEGACY_RESULTS]);
    const existing = Array.isArray(stored[STORAGE_RESULTS])
      ? stored[STORAGE_RESULTS]
      : Array.isArray(stored[LEGACY_RESULTS])
        ? stored[LEGACY_RESULTS]
        : [];

    run = {
      active: true,
      platform,
      seen: new Set(existing.map((item) => item.url).filter(Boolean)),
      results: existing,
      addedCount: 0,
      options: {
        untilDate: options.untilDate || "",
        maxPosts: clamp(Number(options.maxPosts || 100), 1, 1000),
        delayMs: clamp(Number(options.delayMs || 1400), 600, 5000)
      }
    };

    await setStatus(
      "running",
      "Mulai scraping",
      `Membaca daftar post dari halaman ${PLATFORM_CONFIG[platform].label}.`
    );
    scrapeLoop().catch(async (error) => {
      run.active = false;
      await setStatus("idle", "Terjadi masalah", error.message || "Scraper berhenti.");
    });
  }

  async function stop(title = "Berhenti", message = "Scraper berhenti.") {
    run.active = false;
    await setStatus("idle", title, message);
  }

  async function scrapeLoop() {
    const cutoff = parseCutoff(run.options.untilDate);
    let staleScrolls = 0;

    while (run.active && run.addedCount < run.options.maxPosts) {
      const links = collectPostLinks(run.platform);
      const nextIndex = links.findIndex((link) => !run.seen.has(getPostElementUrl(run.platform, link)));
      const nextLink = nextIndex >= 0 ? links[nextIndex] : null;

      if (!nextLink) {
        const moved = await scrollForMorePosts();
        staleScrolls = moved ? 0 : staleScrolls + 1;

        if (staleScrolls >= 4) {
          await stop("Selesai", "Tidak ada post baru yang terlihat setelah scroll.");
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
      if (postData) {
        if (isOlderThanCutoff(cutoff, postData)) {
          if (postData.isPinned || postData.isTopGridCandidate) {
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
            `Post ${formatDateForStatus(postData.postedAt)} lebih lama dari tanggal batas, jadi tidak disimpan.`
          );
          return;
        }

        run.results.push(postData);
        run.addedCount += 1;
        await chrome.storage.local.set({ [STORAGE_RESULTS]: run.results });
      }

      await sleep(run.options.delayMs);
    }

    await stop("Selesai", `Mengambil ${run.addedCount} post baru.`);
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

  function formatDateForStatus(value) {
    if (!value) return "tanpa tanggal";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
  }

  function collectPostLinks(platform) {
    if (platform === "facebook") {
      return collectFacebookPostLinks();
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

  function collectFacebookPostLinks() {
    const unique = new Map();
    const rootCandidates = [
      ...document.querySelectorAll('[role="article"], article, div[data-pagelet^="FeedUnit"]'),
      ...[...document.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-testid="post_message"]')]
        .map((node) => node.closest('[role="article"], article, div[data-pagelet^="FeedUnit"]') || climbToTextBlock(node, 8))
        .filter(Boolean)
    ];
    const postRoots = [...new Set(rootCandidates)]
      .filter(isLikelyFacebookPostRoot);

    postRoots.forEach((root, index) => {
      const link = findBestFacebookPostLink(root);
      const href = link
        ? cleanPostUrl("facebook", link.href)
        : makeSyntheticFacebookPostUrl(root, index);
      const postId = getPostId("facebook", href);
      if (!href || !postId) return;

      root.__scsPostHref = href;
      unique.set(href, root);
    });

    return [...unique.values()];
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

    const data = extractVisiblePostData(postUrl, {
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

  function extractVisiblePostData(fallbackUrl, linkContext = {}) {
    if (run.platform === "tiktok") {
      return extractTikTokVisiblePostData(fallbackUrl, linkContext);
    }

    if (run.platform === "facebook") {
      return extractFacebookVisiblePostData(fallbackUrl, linkContext);
    }

    return extractInstagramVisiblePostData(fallbackUrl, linkContext);
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
    link.scrollIntoView({ block: "center", inline: "center" });
    await sleep(450);
    expandCaptionText(getFacebookPostCardRoot(link) || document);
    await sleep(250);
    return extractFacebookCardData(link, postUrl, linkContext);
  }

  function extractFacebookVisiblePostData(fallbackUrl, linkContext = {}) {
    const url = cleanPostUrl("facebook", isFacebookPostUrl(location.href) ? location.href : fallbackUrl);
    const postId = getPostId("facebook", url);
    const root = getFacebookPostRoot(postId) || document;
    const text = normalizeText(root.innerText || root.textContent || "");
    const reactionInfo = extractFacebookReactionCount(root, text);
    const commentInfo = extractFacebookCommentCount(root, text);
    const shareInfo = extractFacebookCountByLabel(root, text, ["shares", "share", "dibagikan", "bagikan"]);
    const mediaInfo = detectFacebookMediaInfo(root, url);

    return {
      platform: "facebook",
      url,
      shortcode: postId,
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
      postedAt: extractFacebookDate(root),
      isPinned: Boolean(linkContext.isPinned),
      isTopGridCandidate: isProfilePage("facebook") && linkContext.gridIndex >= 0 && linkContext.gridIndex < 3,
      gridIndex: linkContext.gridIndex ?? null,
      rawLikeText: reactionInfo.raw,
      rawCommentText: commentInfo.raw,
      rawShareText: shareInfo.raw,
      rawSavedText: "",
      scrapedAt: new Date().toISOString()
    };
  }

  function extractFacebookCardData(link, postUrl, linkContext = {}) {
    const root = getFacebookPostCardRoot(link);
    const text = normalizeText(root.innerText || root.textContent || "");
    const reactionInfo = extractFacebookReactionCount(root, text);
    const commentInfo = extractFacebookCommentCount(root, text);
    const shareInfo = extractFacebookCountByLabel(root, text, ["shares", "share", "dibagikan", "bagikan"]);
    const mediaInfo = detectFacebookMediaInfo(root, postUrl);

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
      postedAt: extractFacebookDate(root),
      isPinned: Boolean(linkContext.isPinned),
      isTopGridCandidate: isProfilePage("facebook") && linkContext.gridIndex >= 0 && linkContext.gridIndex < 3,
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

    const articles = [...document.querySelectorAll('[role="article"], article, div[data-pagelet^="FeedUnit"]')];
    if (postId) {
      const matchingArticle = articles.find((article) => {
        return [...article.querySelectorAll("a[href]")].some((link) => getPostId("facebook", link.href) === postId);
      });
      if (matchingArticle) return matchingArticle;
    }

    return articles.find((article) => extractFacebookDate(article) || extractFacebookCaption(article))
      || document.querySelector("main")
      || document.body
      || null;
  }

  function getFacebookPostCardRoot(link) {
    if (link.matches?.('[role="article"], article, div[data-pagelet^="FeedUnit"]')) return link;

    return link.closest('[role="article"], article, div[data-pagelet^="FeedUnit"]')
      || climbToTextBlock(link, 8)
      || link;
  }

  function isLikelyFacebookPostRoot(root) {
    const rect = root.getBoundingClientRect();
    if (rect.width < 320 || rect.height < 120) return false;

    const text = normalizeText(root.innerText || root.textContent || "");
    if (text.length < 25) return false;

    const hasPostAction = /\b(like|comment|share|suka|komentar|bagikan)\b/i.test(text);
    const hasDate = Boolean(extractFacebookDate(root));
    const hasCaption = Boolean(extractFacebookCaption(root));
    const hasMedia = root.querySelectorAll?.("img, video").length > 0;

    return (hasDate || hasCaption) && (hasPostAction || hasMedia);
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
    let score = 0;

    if (/\/posts\/|\/permalink\/|permalink\.php|story_fbid=/i.test(href)) score += 120;
    if (extractFacebookDateToken(text)) score += 110;
    if (/\/videos\/|\/watch\/|\/reel\//i.test(href) || /[?&]v=/i.test(href)) score += 70;
    if (/\/photo\/|photo\.php/i.test(href)) score -= 45;
    if (/\b(like|comment|share|suka|komentar|bagikan|lihat semua foto|see all photos)\b/i.test(text)) score -= 60;

    const root = link.closest('[role="article"], article, div[data-pagelet^="FeedUnit"]');
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

  function extractFacebookCaption(root) {
    const directSelectors = [
      '[data-ad-preview="message"]',
      '[data-ad-comet-preview="message"]',
      '[data-testid="post_message"]',
      '[data-testid="post_message"] span'
    ];
    const direct = collectTextsFromSelectors(directSelectors, root)
      .map(cleanFacebookCaptionLine)
      .find(isPossibleFacebookCaption);
    if (direct) return direct;

    return extractFacebookCaptionFromText(root.innerText || root.textContent || "");
  }

  function extractFacebookCaptionFromText(text) {
    const lines = splitCleanLines(text)
      .map(cleanFacebookCaptionLine)
      .filter(Boolean);
    const dateIndex = lines.findIndex((line) => Boolean(extractFacebookDateToken(line)));
    const startIndex = dateIndex >= 0 ? dateIndex + 1 : 0;

    for (let index = startIndex; index < lines.length; index += 1) {
      if (isPossibleFacebookCaption(lines[index])) return lines[index];
    }

    return lines.find(isPossibleFacebookCaption) || "";
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
    if (/^all reactions?:/i.test(text)) return false;
    if (/^sponsored|bersponsor$/i.test(text)) return false;
    return true;
  }

  function extractFacebookDate(root) {
    const candidates = [];
    collectTextsFromSelectors([
      "abbr",
      "a[aria-label]",
      "span[aria-label]",
      'a[href*="/posts/"]',
      'a[href*="story_fbid="]',
      'a[href*="permalink.php"]'
    ], root).forEach((text) => candidates.push(text));

    splitCleanLines(root.innerText || root.textContent || "").forEach((line) => candidates.push(line));

    for (const candidate of candidates) {
      const token = extractFacebookDateToken(candidate);
      const parsed = parseFacebookDate(token || candidate);
      if (parsed) return parsed;
    }

    return "";
  }

  function extractFacebookDateToken(text) {
    const normalized = normalizeText(text);
    const absoluteNumeric = normalized.match(/\b(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]20\d{2})\b/);
    if (absoluteNumeric?.[0]) return absoluteNumeric[0];

    const monthNamePattern = "(jan(?:uary|uari)?|feb(?:ruary|ruari)?|mar(?:ch|et)?|apr(?:il)?|mei|may|jun(?:e|i)?|jul(?:y|i)?|aug(?:ust)?|agu(?:stus)?|sep(?:t|tember)?|okt(?:ober)?|oct(?:ober)?|nov(?:ember)?|des(?:ember)?|dec(?:ember)?)";
    const dayMonth = normalized.match(new RegExp(`\\b\\d{1,2}\\s+${monthNamePattern}(?:\\s+20\\d{2})?\\b`, "i"));
    if (dayMonth?.[0]) return dayMonth[0];

    const monthDay = normalized.match(new RegExp(`\\b${monthNamePattern}\\s+\\d{1,2}(?:,?\\s+20\\d{2})?\\b`, "i"));
    if (monthDay?.[0]) return monthDay[0];

    const relative = normalized.match(/\b(\d+)\s*(m|min|minute|minutes|menit|h|hr|hour|hours|jam|d|day|days|hari|w|week|weeks|minggu|mo|month|months|bulan|y|yr|year|years|tahun)\s*(ago|lalu)?\b/i);
    if (relative?.[0]) return relative[0];

    if (/\b(yesterday|kemarin|just now|baru saja)\b/i.test(normalized)) return normalized;
    return "";
  }

  function parseFacebookDate(value) {
    if (!value) return "";
    const text = normalizeText(value).replace(/\bat\b|\bpukul\b/gi, " ");

    const numericToken = text.match(/\b(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]20\d{2}|\d{1,2}[./-]\d{1,2})\b/);
    if (numericToken?.[0]) {
      const numeric = normalizeTikTokDate(numericToken[0]);
      if (numeric) return numeric;
    }

    const relative = text.match(/\b(\d+)\s*(m|min|minute|minutes|menit|h|hr|hour|hours|jam|d|day|days|hari|w|week|weeks|minggu|mo|month|months|bulan|y|yr|year|years|tahun)\s*(ago|lalu)?\b/i);
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

    const named = parseNamedMonthDate(text);
    if (named) return named;

    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }

  function parseNamedMonthDate(text) {
    const monthNamePattern = "(jan(?:uary|uari)?|feb(?:ruary|ruari)?|mar(?:ch|et)?|apr(?:il)?|mei|may|jun(?:e|i)?|jul(?:y|i)?|aug(?:ust)?|agu(?:stus)?|sep(?:t|tember)?|okt(?:ober)?|oct(?:ober)?|nov(?:ember)?|des(?:ember)?|dec(?:ember)?)";
    const dayMonth = text.match(new RegExp(`\\b(\\d{1,2})\\s+${monthNamePattern}(?:\\s+(20\\d{2}))?\\b`, "i"));
    if (dayMonth) return buildInferredNamedDate(dayMonth[1], dayMonth[2], dayMonth[3]);

    const monthDay = text.match(new RegExp(`\\b${monthNamePattern}\\s+(\\d{1,2})(?:,?\\s+(20\\d{2}))?\\b`, "i"));
    if (monthDay) return buildInferredNamedDate(monthDay[2], monthDay[1], monthDay[3]);

    return "";
  }

  function buildInferredNamedDate(day, monthName, year) {
    const month = getMonthNumber(monthName);
    if (!month) return "";

    if (year) return buildIsoDate(year, month, day);
    return buildInferredMonthDayIso(month, day);
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
    const labels = collectTextsFromSelectors([
      '[aria-label*="reaction" i]',
      '[aria-label*="like" i]',
      '[aria-label*="suka" i]',
      '[aria-label*="reaksi" i]'
    ], root).join(" ");
    const patterns = [
      /([\d.,]+\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)\s+(?:reactions?|likes?|suka|reaksi)\b/i,
      /(?:reactions?|likes?|suka|reaksi)\D{0,20}([\d.,]+\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)/i
    ];
    const fromLabels = extractCountByPatterns(labels, patterns);
    if (fromLabels.value !== null) return fromLabels;

    const fromLines = extractFacebookReactionCountFromLines(text);
    if (fromLines.value !== null) return fromLines;

    return extractCountByPatterns(text, patterns);
  }

  function extractFacebookCountByLabel(root, text, labels) {
    const ariaText = collectTextsFromSelectors(labels.flatMap((label) => [
      `[aria-label*="${label}" i]`,
      `a[href*="${label}" i]`
    ]), root).join(" ");
    const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const patterns = [
      new RegExp(`([\\d.,]+\\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)\\s+(?:${labelPattern})\\b`, "i"),
      new RegExp(`(?:${labelPattern})\\D{0,20}([\\d.,]+\\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)`, "i")
    ];
    const fromLines = splitCleanLines(text)
      .map((line) => extractCountByPatterns(line, patterns))
      .find((result) => result.value !== null);
    if (fromLines) return fromLines;

    const fromAria = extractCountByPatterns(ariaText, patterns);
    if (fromAria.value !== null) return fromAria;

    return extractCountByPatterns(text, patterns);
  }

  function extractFacebookCommentCount(root, text) {
    const maxReasonableCommentCount = 100000;
    const labels = ["comments", "comment", "komentar", "tanggapan"];
    const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const primaryPatterns = [
      new RegExp(`([\\d.,]+\\s*(?:k|m|b|rb|ribu|jt|juta|million|thousand|billion)?)\\s+(?:${labelPattern})\\b`, "i"),
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

    const ariaText = collectTextsFromSelectors([
      '[aria-label*="comment" i]',
      '[aria-label*="komentar" i]',
      '[aria-label*="tanggapan" i]',
      'a[href*="comment" i]',
      'a[href*="comment_id" i]'
    ], root)
      .filter((value) => !/^(comment|komentari|write a comment|tulis komentar|add a comment|tambahkan komentar)$/i.test(normalizeText(value)))
      .join(" ");
    const primaryAria = extractCountByPatterns(ariaText, primaryPatterns);
    if (isReasonableFacebookCommentCount(primaryAria, maxReasonableCommentCount)) return primaryAria;

    const secondaryLine = lines
      .map((line) => extractCountByPatterns(line, secondaryPatterns))
      .find((result) => isReasonableFacebookCommentCount(result, maxReasonableCommentCount));
    if (secondaryLine) return secondaryLine;

    const secondaryAria = extractCountByPatterns(ariaText, secondaryPatterns);
    if (isReasonableFacebookCommentCount(secondaryAria, maxReasonableCommentCount)) return secondaryAria;

    return { value: null, raw: "" };
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

    for (let index = metricIndex - 1; index >= Math.max(0, metricIndex - 4); index -= 1) {
      const line = normalizeText(lines[index]);
      if (/^[\d.,]+\s*(k|m|b|rb|ribu|jt|juta|million|thousand|billion)?$/i.test(line)) {
        return {
          value: parseHumanNumber(line),
          raw: line
        };
      }
    }

    return { value: null, raw: "" };
  }

  function detectFacebookMediaInfo(root, postUrl) {
    const media = collectVisibleMedia(root);
    const imageCount = media.filter((item) => item.kind === "image").length;
    const videoCount = /\/(?:videos|watch|reel)\//.test(postUrl) || /[?&]v=/.test(postUrl)
      ? Math.max(1, media.filter((item) => item.kind === "video").length)
      : media.filter((item) => item.kind === "video").length;
    const mediaCount = Math.max(1, imageCount + videoCount);

    if (videoCount > 0) {
      return {
        contentType: mediaCount > 1 ? "carousel_video" : "video",
        contentTypeLabel: mediaCount > 1 ? "Carousel video" : "Video",
        mediaCount,
        imageCount,
        videoCount
      };
    }

    return {
      contentType: imageCount > 1 ? "carousel_image" : "image",
      contentTypeLabel: imageCount > 1 ? "Carousel gambar" : "Gambar",
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
      if (!/^(more|lainnya|selengkapnya|see more)$/.test(text) && !/^(more|lainnya|selengkapnya|see more)$/.test(label)) {
        return false;
      }

      node.click?.();
      return true;
    });
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
    const date = new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00`);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }

  function buildInferredMonthDayIso(month, day) {
    const now = new Date();
    let year = now.getFullYear();
    let date = new Date(year, Number(month) - 1, Number(day), 0, 0, 0);

    if (date.getTime() - now.getTime() > 86400000) {
      year -= 1;
      date = new Date(year, Number(month) - 1, Number(day), 0, 0, 0);
    }

    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
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

  async function scrollForMorePosts() {
    const beforeY = window.scrollY;
    const beforeHeight = document.documentElement.scrollHeight;
    await setStatus("running", "Mencari post berikutnya", "Scroll halaman untuk memuat post yang lebih lama.");
    window.scrollBy({ top: Math.round(window.innerHeight * 1.35), behavior: "smooth" });
    await sleep(Math.max(run.options.delayMs, 1300));
    return window.scrollY !== beforeY || document.documentElement.scrollHeight !== beforeHeight;
  }

  function parseCutoff(value) {
    if (!value) return null;
    const date = new Date(`${value}T00:00:00`);
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
      },
      [LEGACY_STATUS]: {
        state,
        title,
        message,
        updatedAt: new Date().toISOString()
      }
    });
  }
})();
