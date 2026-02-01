/**
 * アマゾン注文エクスポーター - Content Script
 * v2（商品単位）とv3（注文単位）を統合
 */

(function() {
  'use strict';

  const BASE_URL = 'https://www.amazon.co.jp';
  let isCancelled = false;
  let isRunning = false;  // 処理中フラグ

  // ========== ユーティリティ ==========
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const parseHTML = (html) => {
    const parser = new DOMParser();
    return parser.parseFromString(html, 'text/html');
  };

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

  // 進捗報告（ポップアップが閉じていても処理継続）
  const reportProgress = (current, total, message) => {
    chrome.runtime.sendMessage({
      action: 'progress',
      current,
      total,
      message
    }).catch(() => {
      // ポップアップが閉じている場合は無視
    });
    console.log(`📊 進捗: ${current}/${total} ${message || ''}`);
  };

  // 完了報告
  const reportComplete = (orderCount) => {
    chrome.runtime.sendMessage({
      action: 'complete',
      orderCount
    }).catch(() => {
      // ポップアップが閉じている場合は無視
    });
    console.log(`✅ エクスポート完了: ${orderCount}件`);
  };

  // エラー報告
  const reportError = (message) => {
    chrome.runtime.sendMessage({
      action: 'error',
      message
    }).catch(() => {
      // ポップアップが閉じている場合は無視
    });
    console.error(`❌ エラー: ${message}`);
    alert(`【アマゾン注文エクスポーター】\n\n❌ エラー: ${message}`);
  };

  // ========== 領収書リンク取得 ==========
  const fetchInvoiceLinks = async (orderId, popoverUrl) => {
    try {
      const url = toFullUrl(popoverUrl);
      const response = await fetch(url, { credentials: 'include' });
      const html = await response.text();
      const doc = parseHTML(html);
      
      const links = {
        printSummary: '',
        invoice: '',
        invoiceRequest: ''
      };

      const linkElements = doc.querySelectorAll('.invoice-list a, ul a');
      
      linkElements.forEach(a => {
        const text = cleanText(a.textContent);
        const href = a.getAttribute('href');
        
        if (text.includes('印刷可能な注文概要')) {
          links.printSummary = toFullUrl(href);
        } else if (text.includes('明細書') || text.includes('適格請求書')) {
          links.invoice = toFullUrl(href);
        } else if (text.includes('請求書のリクエスト')) {
          links.invoiceRequest = toFullUrl(href);
        }
      });

      return links;
    } catch (e) {
      console.warn(`⚠️ 領収書リンク取得失敗 (${orderId}):`, e.message);
      return { printSummary: '', invoice: '', invoiceRequest: '' };
    }
  };

  // ========== 注文カードから情報抽出 ==========
  const extractOrderData = async (card, year, settings) => {
    // ----- 注文ヘッダー情報 -----
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

    const invoicePopoverEl = card.querySelector('.yohtmlc-order-level-connections span[data-a-popover]');
    let invoicePopoverUrl = '';
    if (invoicePopoverEl) {
      try {
        const popoverData = JSON.parse(invoicePopoverEl.getAttribute('data-a-popover'));
        invoicePopoverUrl = popoverData.url || '';
      } catch (e) {}
    }

    const deliveryStatusEl = card.querySelector('.delivery-box__primary-text');
    const deliveryStatus = deliveryStatusEl ? cleanText(deliveryStatusEl.textContent) : '';

    // ----- 商品情報（複数対応・重複排除） -----
    const productTitles = card.querySelectorAll('.yohtmlc-product-title a');
    
    const products = [];
    const seenAsins = new Set();

    productTitles.forEach(titleEl => {
      const productName = cleanText(titleEl.textContent);
      const productLink = toFullUrl(titleEl.getAttribute('href'));
      
      if (!productName) return;
      
      const asinMatch = productLink.match(/\/dp\/([A-Z0-9]+)/);
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

    // ----- 領収書リンク取得 -----
    let invoiceLinks = { printSummary: '', invoice: '', invoiceRequest: '' };
    
    if (settings.fetchInvoice && invoicePopoverUrl) {
      await sleep(500);
      invoiceLinks = await fetchInvoiceLinks(orderId, invoicePopoverUrl);
    }

    // ----- 注文レベルのボタンリンク -----
    const problemLinkEl = card.querySelector('a[href*="/hz/pwo"]');
    const problemLink = problemLinkEl ? toFullUrl(problemLinkEl.getAttribute('href')) : '';

    const returnLinkEl = card.querySelector('a[href*="returns/cart"]');
    const returnLink = returnLinkEl ? toFullUrl(returnLinkEl.getAttribute('href')) : '';

    const sellerFeedbackEl = card.querySelector('a[href*="feedback"]');
    const sellerFeedbackLink = sellerFeedbackEl ? toFullUrl(sellerFeedbackEl.getAttribute('href')) : '';

    const reviewLinkEl = card.querySelector('a[href*="review-your-purchases"]');
    const reviewLink = reviewLinkEl ? toFullUrl(reviewLinkEl.getAttribute('href')) : '';

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
  const extractOrdersFromPage = async (doc, year, settings) => {
    const orders = [];
    const orderCards = doc.querySelectorAll('.order-card');

    for (const card of orderCards) {
      if (isCancelled) break;

      try {
        const orderData = await extractOrderData(card, year, settings);
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
  const getTotalOrders = (doc) => {
    const label = doc.querySelector('.num-orders');
    if (label) {
      const match = label.textContent.match(/(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    }
    return 0;
  };

  // ページを取得
  const fetchPage = async (year, startIndex) => {
    const url = `${BASE_URL}/your-orders/orders?timeFilter=year-${year}&startIndex=${startIndex}`;
    const response = await fetch(url, { credentials: 'include' });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return await response.text();
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
    // すでに処理中なら無視
    if (isRunning) {
      console.log('⚠️ すでにエクスポート処理中です');
      alert('【アマゾン注文エクスポーター】\n\n⚠️ すでにエクスポート処理中です\n\nしばらくお待ちください');
      return;
    }
    
    isRunning = true;
    isCancelled = false;
    const { year, exportMode, fetchInvoice } = settings;
    const perPage = 10;
    const delayMs = 1500;

    console.log(`🚀 エクスポート開始: ${year}年, モード: ${exportMode}`);

    try {
      // 最初のページを取得
      reportProgress(0, 0, `${year}年の注文を確認中...`);
      
      const firstPageHtml = await fetchPage(year, 0);
      const firstPageDoc = parseHTML(firstPageHtml);
      
      const totalOrders = getTotalOrders(firstPageDoc);
      
      if (totalOrders === 0) {
        reportError(`${year}年の注文がありません`);
        return;
      }

      console.log(`📊 ${year}年の注文数: ${totalOrders}件`);
      
      const allOrders = [];
      let processedCount = 0;

      // 最初のページ
      const firstPageOrders = await extractOrdersFromPage(firstPageDoc, year, { fetchInvoice });
      allOrders.push(...firstPageOrders);
      processedCount += firstPageOrders.length;
      reportProgress(processedCount, totalOrders);

      // 残りのページ
      const totalPages = Math.ceil(totalOrders / perPage);

      for (let page = 1; page < totalPages; page++) {
        if (isCancelled) {
          console.log('⏹️ キャンセルされました');
          return;
        }

        await sleep(delayMs);
        
        const startIndex = page * perPage;
        const html = await fetchPage(year, startIndex);
        const doc = parseHTML(html);
        
        const orders = await extractOrdersFromPage(doc, year, { fetchInvoice });
        allOrders.push(...orders);
        
        processedCount += orders.length;
        reportProgress(processedCount, totalOrders);
      }

      if (isCancelled) return;

      // CSV生成
      let csvData;
      let filename;

      if (exportMode === 'by-order') {
        csvData = generateCSVByOrder(allOrders);
        filename = `amazon_orders_by_order_${year}.csv`;
      } else {
        csvData = generateCSVByProduct(allOrders);
        filename = `amazon_orders_by_product_${year}.csv`;
      }

      downloadCSV(csvData.headers, csvData.rows, filename);
      
      reportComplete(allOrders.length);

    } catch (e) {
      console.error('❌ エクスポートエラー:', e);
      reportError(e.message);
    } finally {
      isRunning = false;
    }
  };

  // ========== メッセージ受信 ==========
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startExport') {
      runExport(message.settings);
      sendResponse({ status: 'started' });
    } else if (message.action === 'cancelExport') {
      isCancelled = true;
      isRunning = false;
      sendResponse({ status: 'cancelled' });
    } else if (message.action === 'getStatus') {
      sendResponse({ isRunning });
    }
    return true;
  });

  console.log('📦 アマゾン注文エクスポーター: Content script loaded');

})();
