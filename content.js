/**
 * アマゾン注文エクスポーター - Content Script
 * v3 - ページ遷移対応版
 */

(function() {
  'use strict';

  const BASE_URL = 'https://www.amazon.co.jp';
  const STORAGE_KEY = 'amazon_order_exporter_state';

  // ========== ユーティリティ ==========
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const cleanText = (text) => {
    return text ? text.trim().replace(/\s+/g, ' ') : '';
  };

  const escapeCSV = (str) => {
    if (!str) return '';
    if (str.includes(',') || str.includes('\n') || str.includes('"')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  const toFullUrl = (path) => {
    if (!path) return '';
    if (path.startsWith('http')) return path;
    return BASE_URL + path;
  };

  // ========== 状態管理 ==========
  const saveState = (state) => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  };

  const loadState = () => {
    try {
      const data = sessionStorage.getItem(STORAGE_KEY);
      return data ? JSON.parse(data) : null;
    } catch (e) {
      console.error('状態の読み込みエラー:', e);
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
  };

  const clearState = () => {
    sessionStorage.removeItem(STORAGE_KEY);
  };

  // ========== 進捗報告 ==========
  const reportProgress = (current, total, message) => {
    chrome.runtime.sendMessage({
      action: 'progress',
      current,
      total,
      message
    }).catch(() => {});
    console.log(`📊 進捗: ${current}/${total} ${message || ''}`);
  };

  const reportComplete = (orderCount) => {
    chrome.runtime.sendMessage({
      action: 'complete',
      orderCount
    }).catch(() => {});
    console.log(`✅ エクスポート完了: ${orderCount}件`);
  };

  const reportError = (message) => {
    chrome.runtime.sendMessage({
      action: 'error',
      message
    }).catch(() => {});
    console.error(`❌ エラー: ${message}`);
    alert(`【アマゾン注文エクスポーター】\n\n❌ エラー: ${message}`);
  };

  // ========== 領収書リンク取得 ==========
  const parseHTML = (html) => {
    const parser = new DOMParser();
    return parser.parseFromString(html, 'text/html');
  };

  const fetchInvoiceLinks = async (orderId, popoverUrl) => {
    try {
      const url = popoverUrl.startsWith('http') ? popoverUrl : BASE_URL + popoverUrl;
      const response = await fetch(url, { credentials: 'include' });
      const html = await response.text();
      const doc = parseHTML(html);

      const links = {
        printSummary: '',
        invoice: '',
        invoiceRequest: ''
      };

      const linkElements = doc.querySelectorAll('a');

      linkElements.forEach(a => {
        const text = cleanText(a.textContent);
        const href = a.getAttribute('href');
        if (!href) return;

        const fullUrl = href.startsWith('http') ? href : BASE_URL + href;

        if (text.includes('印刷可能な注文概要')) {
          links.printSummary = fullUrl;
        } else if (text.includes('明細書') || text.includes('適格請求書')) {
          links.invoice = fullUrl;
        } else if (text.includes('請求書のリクエスト')) {
          links.invoiceRequest = fullUrl;
        }
      });

      return links;
    } catch (e) {
      console.warn(`⚠️ 領収書リンク取得失敗 (${orderId}):`, e.message);
      return { printSummary: '', invoice: '', invoiceRequest: '' };
    }
  };

  // ========== 注文カードから情報抽出 ==========
  const extractOrderData = async (card, year, fetchInvoice) => {
    const orderIdEl = card.querySelector('.yohtmlc-order-id span[dir="ltr"]');
    const orderId = orderIdEl ? cleanText(orderIdEl.textContent) : '';

    if (!orderId) return null;

    const orderDateEl = card.querySelector('.a-column.a-span3 .a-color-secondary.aok-break-word');
    const orderDate = orderDateEl ? cleanText(orderDateEl.textContent) : '';

    const totalEl = card.querySelector('.a-column.a-span2 .a-color-secondary.aok-break-word');
    const total = totalEl ? cleanText(totalEl.textContent) : '';

    const recipientEl = card.querySelector('.yohtmlc-recipient .a-popover-trigger');
    const recipient = recipientEl ? cleanText(recipientEl.textContent) : '';

    const orderDetailsLinkEl = card.querySelector('a[href*="order-details"]');
    const orderDetailsLink = orderDetailsLinkEl ? toFullUrl(orderDetailsLinkEl.getAttribute('href')) : '';

    const deliveryStatusEl = card.querySelector('.delivery-box__primary-text');
    const deliveryStatus = deliveryStatusEl ? cleanText(deliveryStatusEl.textContent) : '';

    // 領収書ポップオーバーURL取得（2つのパターンに対応）
    let invoicePopoverUrl = '';

    // パターン1: 2026年以降の新しい構造（span[data-a-popover]）
    const invoicePopoverEl = card.querySelector('span[data-a-popover] a[href*="/your-orders/invoice/popover"]');
    if (invoicePopoverEl) {
      const parentSpan = invoicePopoverEl.closest('span[data-a-popover]');
      if (parentSpan) {
        try {
          const popoverData = JSON.parse(parentSpan.getAttribute('data-a-popover'));
          invoicePopoverUrl = popoverData.url || '';
        } catch (e) {}
      }
    }

    // パターン2: 2017年等の古い構造（直接aタグ）
    if (!invoicePopoverUrl) {
      const invoiceLinkEl = card.querySelector('a[href*="/your-orders/invoice/popover"]');
      if (invoiceLinkEl) {
        invoicePopoverUrl = invoiceLinkEl.getAttribute('href') || '';
      }
    }

    // 商品情報
    const productTitles = card.querySelectorAll('.yohtmlc-product-title a');
    const products = [];
    const seenAsins = new Set();

    productTitles.forEach(titleEl => {
      const productName = cleanText(titleEl.textContent);
      const productLink = toFullUrl(titleEl.getAttribute('href'));

      if (!productName) return;

      const asinMatch = productLink.match(/\/dp\/([A-Za-z0-9]+)/);
      const asin = asinMatch ? asinMatch[1] : productLink;

      if (seenAsins.has(asin)) return;
      seenAsins.add(asin);

      const itemContainer = titleEl.closest('.a-fixed-left-grid') ||
                            titleEl.closest('.item-box') ||
                            titleEl.closest('li');

      let productImage = '';
      let buyAgainLink = '';
      let viewProductLink = '';

      if (itemContainer) {
        const imgEl = itemContainer.querySelector('.product-image img, img');
        productImage = imgEl ? imgEl.getAttribute('src') : '';

        const buyAgainEl = itemContainer.querySelector('a[href*="buyagain"]');
        buyAgainLink = buyAgainEl ? toFullUrl(buyAgainEl.getAttribute('href')) : '';

        const viewProductEl = itemContainer.querySelector('a[href*="/your-orders/pop"]');
        viewProductLink = viewProductEl ? toFullUrl(viewProductEl.getAttribute('href')) : '';
      }

      products.push({
        productName,
        productLink,
        productImage,
        buyAgainLink,
        viewProductLink
      });
    });

    // 注文レベルのリンク
    const problemLinkEl = card.querySelector('a[href*="/hz/pwo"]');
    const problemLink = problemLinkEl ? toFullUrl(problemLinkEl.getAttribute('href')) : '';

    const returnLinkEl = card.querySelector('a[href*="returns/cart"]');
    const returnLink = returnLinkEl ? toFullUrl(returnLinkEl.getAttribute('href')) : '';

    const sellerFeedbackEl = card.querySelector('a[href*="feedback"]');
    const sellerFeedbackLink = sellerFeedbackEl ? toFullUrl(sellerFeedbackEl.getAttribute('href')) : '';

    const reviewLinkEl = card.querySelector('a[href*="review-your-purchases"]');
    const reviewLink = reviewLinkEl ? toFullUrl(reviewLinkEl.getAttribute('href')) : '';

    // 領収書リンク取得
    let invoiceLinks = { printSummary: '', invoice: '', invoiceRequest: '' };
    if (fetchInvoice && invoicePopoverUrl) {
      await sleep(300);  // レート制限対策
      invoiceLinks = await fetchInvoiceLinks(orderId, invoicePopoverUrl);
    }

    return {
      year,
      orderId,
      orderDate,
      total,
      recipient,
      deliveryStatus,
      orderDetailsLink,
      invoiceLinks,
      problemLink,
      returnLink,
      sellerFeedbackLink,
      reviewLink,
      products
    };
  };

  // ========== ページから注文を抽出 ==========
  const extractOrdersFromCurrentPage = async (year, fetchInvoice) => {
    const orders = [];
    const orderCards = document.querySelectorAll('.order-card');

    console.log(`🔍 .order-card 要素数: ${orderCards.length}`);

    for (const card of orderCards) {
      try {
        const orderData = await extractOrderData(card, year, fetchInvoice);
        if (orderData) {
          orders.push(orderData);
        }
      } catch (e) {
        console.error('注文の解析エラー:', e);
      }
    }

    return orders;
  };

  // 総注文数を取得
  const getTotalOrders = () => {
    const label = document.querySelector('.num-orders');
    if (label) {
      const match = label.textContent.match(/(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    }
    return 0;
  };

  // 現在のページ番号を取得
  const getCurrentStartIndex = () => {
    const url = new URL(window.location.href);
    return parseInt(url.searchParams.get('startIndex') || '0', 10);
  };

  // 現在のページの年フィルターを取得
  const getCurrentYearFromUrl = () => {
    const url = new URL(window.location.href);
    const timeFilter = url.searchParams.get('timeFilter') || '';
    const match = timeFilter.match(/year-(\d+)/);
    return match ? match[1] : null;
  };

  // ========== CSV生成（注文単位） ==========
  const generateCSVByOrder = (orders) => {
    const SEPARATOR = ' / ';

    const headers = [
      'Amazon 年',
      'Amazon 注文番号',
      'Amazon 注文日',
      'Amazon 合計金額',
      'Amazon お届け先',
      'Amazon 配送状況',
      'Amazon 商品数',
      'Amazon 商品名',
      'Amazon 商品リンク',
      'Amazon 商品画像URL',
      'Amazon 注文詳細リンク',
      'Amazon 印刷可能な注文概要',
      'Amazon 明細書／適格請求書',
      'Amazon 請求書のリクエスト',
      'Amazon 注文に関する問題',
      'Amazon 返品・交換',
      'Amazon 出品者を評価',
      'Amazon 商品レビュー'
    ];

    const rows = orders.map(order => {
      const productNames = order.products.map(p => p.productName).join(SEPARATOR) || '（商品名取得不可）';
      const productLinks = order.products.map(p => p.productLink).join(SEPARATOR);
      const productImages = order.products.map(p => p.productImage).filter(Boolean).join(SEPARATOR);

      return [
        order.year,
        escapeCSV(order.orderId),
        escapeCSV(order.orderDate),
        escapeCSV(order.total),
        escapeCSV(order.recipient),
        escapeCSV(order.deliveryStatus),
        order.products.length,
        escapeCSV(productNames),
        escapeCSV(productLinks),
        escapeCSV(productImages),
        escapeCSV(order.orderDetailsLink),
        escapeCSV(order.invoiceLinks.printSummary),
        escapeCSV(order.invoiceLinks.invoice),
        escapeCSV(order.invoiceLinks.invoiceRequest),
        escapeCSV(order.problemLink),
        escapeCSV(order.returnLink),
        escapeCSV(order.sellerFeedbackLink),
        escapeCSV(order.reviewLink)
      ];
    });

    return { headers, rows };
  };

  // ========== CSV生成（商品単位） ==========
  const generateCSVByProduct = (orders) => {
    const headers = [
      'Amazon 年',
      'Amazon 注文番号',
      'Amazon 注文日',
      'Amazon 合計金額',
      'Amazon お届け先',
      'Amazon 配送状況',
      'Amazon 商品名',
      'Amazon 商品リンク',
      'Amazon 商品画像URL',
      'Amazon 注文詳細リンク',
      'Amazon 印刷可能な注文概要',
      'Amazon 明細書／適格請求書',
      'Amazon 請求書のリクエスト',
      'Amazon 再度購入リンク',
      'Amazon 商品を表示リンク',
      'Amazon 注文に関する問題',
      'Amazon 返品・交換',
      'Amazon 出品者を評価',
      'Amazon 商品レビュー'
    ];

    const rows = [];

    orders.forEach(order => {
      if (order.products.length > 0) {
        order.products.forEach(product => {
          rows.push([
            order.year,
            escapeCSV(order.orderId),
            escapeCSV(order.orderDate),
            escapeCSV(order.total),
            escapeCSV(order.recipient),
            escapeCSV(order.deliveryStatus),
            escapeCSV(product.productName),
            escapeCSV(product.productLink),
            escapeCSV(product.productImage),
            escapeCSV(order.orderDetailsLink),
            escapeCSV(order.invoiceLinks.printSummary),
            escapeCSV(order.invoiceLinks.invoice),
            escapeCSV(order.invoiceLinks.invoiceRequest),
            escapeCSV(product.buyAgainLink),
            escapeCSV(product.viewProductLink),
            escapeCSV(order.problemLink),
            escapeCSV(order.returnLink),
            escapeCSV(order.sellerFeedbackLink),
            escapeCSV(order.reviewLink)
          ]);
        });
      } else {
        rows.push([
          order.year,
          escapeCSV(order.orderId),
          escapeCSV(order.orderDate),
          escapeCSV(order.total),
          escapeCSV(order.recipient),
          escapeCSV(order.deliveryStatus),
          '（商品名取得不可）',
          '', '',
          escapeCSV(order.orderDetailsLink),
          escapeCSV(order.invoiceLinks.printSummary),
          escapeCSV(order.invoiceLinks.invoice),
          escapeCSV(order.invoiceLinks.invoiceRequest),
          '', '',
          escapeCSV(order.problemLink),
          escapeCSV(order.returnLink),
          escapeCSV(order.sellerFeedbackLink),
          escapeCSV(order.reviewLink)
        ]);
      }
    });

    return { headers, rows };
  };

  // ========== CSVダウンロード ==========
  const downloadCSV = (headers, rows, filename) => {
    const BOM = '\uFEFF';
    const csvContent = BOM + [
      headers.join(','),
      ...rows.map(row => row.join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  // ========== メインエクスポート処理 ==========
  const runExport = async (settings) => {
    const { year, exportMode, fetchInvoice = false } = settings;
    const perPage = 10;

    console.log(`🚀 エクスポート開始: ${year}年, モード: ${exportMode}, 領収書: ${fetchInvoice}`);

    // 現在のページが選択した年のページか確認
    const currentYear = getCurrentYearFromUrl();
    if (currentYear !== String(year)) {
      console.log(`📍 年が異なるためリダイレクト: 現在=${currentYear}, 選択=${year}`);

      // 状態を保存してリダイレクト
      saveState({
        year,
        exportMode,
        fetchInvoice,
        totalOrders: 0,
        totalPages: 0,
        collectedOrders: [],
        processedPages: []
      });

      const targetUrl = `${BASE_URL}/your-orders/orders?timeFilter=year-${year}&startIndex=0`;
      window.location.href = targetUrl;
      return;
    }

    const totalOrders = getTotalOrders();

    if (totalOrders === 0) {
      reportError(`${year}年の注文がありません`);
      clearState();
      return;
    }

    console.log(`📊 ${year}年の注文数: ${totalOrders}件`);

    const totalPages = Math.ceil(totalOrders / perPage);
    const currentStartIndex = getCurrentStartIndex();
    const currentPage = Math.floor(currentStartIndex / perPage);

    // 状態を読み込み
    let state = loadState();

    // 状態からfetchInvoice設定を取得（継続時用）
    const shouldFetchInvoice = state?.fetchInvoice ?? fetchInvoice;

    if (!state || state.year !== year || state.exportMode !== exportMode) {
      // 新しいエクスポート開始
      state = {
        year,
        exportMode,
        fetchInvoice: shouldFetchInvoice,
        totalOrders,
        totalPages,
        collectedOrders: [],
        processedPages: []
      };
    } else {
      // 継続時は最新のtotalOrdersを更新
      state.totalOrders = totalOrders;
      state.totalPages = totalPages;
    }

    // 現在のページの注文を抽出
    reportProgress(state.collectedOrders.length, totalOrders, '注文を読み取り中...');
    const currentPageOrders = await extractOrdersFromCurrentPage(year, shouldFetchInvoice);
    console.log(`📦 現在のページ: ${currentPageOrders.length}件取得`);

    // 現在のページの注文を追加（重複チェック）
    const existingIds = new Set(state.collectedOrders.map(o => o.orderId));
    currentPageOrders.forEach(order => {
      if (!existingIds.has(order.orderId)) {
        state.collectedOrders.push(order);
      }
    });

    if (!state.processedPages.includes(currentPage)) {
      state.processedPages.push(currentPage);
    }

    const processedCount = state.collectedOrders.length;
    reportProgress(processedCount, totalOrders);

    // すべてのページを処理したか確認
    if (state.processedPages.length >= totalPages) {
      // 完了 - CSVをダウンロード
      let csvData;
      let filename;

      if (exportMode === 'by-order') {
        csvData = generateCSVByOrder(state.collectedOrders);
        filename = `amazon_orders_by_order_${year}.csv`;
      } else {
        csvData = generateCSVByProduct(state.collectedOrders);
        filename = `amazon_orders_by_product_${year}.csv`;
      }

      downloadCSV(csvData.headers, csvData.rows, filename);
      reportComplete(state.collectedOrders.length);
      clearState();

    } else {
      // 次のページへ移動
      saveState(state);

      // 未処理のページを探す
      let nextPage = -1;
      for (let i = 0; i < totalPages; i++) {
        if (!state.processedPages.includes(i)) {
          nextPage = i;
          break;
        }
      }

      if (nextPage >= 0) {
        const nextStartIndex = nextPage * perPage;
        const nextUrl = `${BASE_URL}/your-orders/orders?timeFilter=year-${year}&startIndex=${nextStartIndex}`;

        console.log(`📄 次のページへ移動: ${nextPage + 1}/${totalPages}`);
        reportProgress(processedCount, totalOrders, `ページ ${state.processedPages.length}/${totalPages} 完了。次のページへ移動...`);

        await sleep(1500);
        window.location.href = nextUrl;
      }
    }
  };

  // ========== ページ読み込み時の自動継続 ==========
  const checkAndContinue = async () => {
    const state = loadState();

    if (state && state.collectedOrders) {
      console.log(`📂 エクスポート継続中... (${state.collectedOrders.length}件収集済)`);

      // 少し待ってから継続
      await sleep(2000);

      await runExport({
        year: state.year,
        exportMode: state.exportMode,
        fetchInvoice: state.fetchInvoice
      });
    }
  };

  // ========== メッセージ受信 ==========
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startExport') {
      // 新規エクスポート開始時は状態をクリア
      clearState();
      runExport(message.settings);
      sendResponse({ status: 'started' });
    } else if (message.action === 'cancelExport') {
      clearState();
      sendResponse({ status: 'cancelled' });
    } else if (message.action === 'getStatus') {
      const state = loadState();
      sendResponse({
        isRunning: !!state,
        collectedCount: state ? state.collectedOrders.length : 0
      });
    }
    return true;
  });

  // ページ読み込み完了後に自動継続チェック
  if (document.readyState === 'complete') {
    checkAndContinue();
  } else {
    window.addEventListener('load', checkAndContinue);
  }

  console.log('📦 アマゾン注文エクスポーター: Content script loaded');

})();
