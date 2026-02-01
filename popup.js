/**
 * アマゾン注文エクスポーター - Popup Script
 */

document.addEventListener('DOMContentLoaded', async () => {
  // DOM要素
  const elements = {
    errorMessage: document.getElementById('error-message'),
    settingsForm: document.getElementById('settings-form'),
    yearSelect: document.getElementById('year-select'),
    exportModeRadios: document.querySelectorAll('input[name="export-mode"]'),
    fetchInvoiceCheckbox: document.getElementById('fetch-invoice'),
    exportBtn: document.getElementById('export-btn'),
    progressSection: document.getElementById('progress-section'),
    progressText: document.getElementById('progress-text'),
    progressPercent: document.getElementById('progress-percent'),
    progressFill: document.getElementById('progress-fill'),
    cancelBtn: document.getElementById('cancel-btn'),
    completeSection: document.getElementById('complete-section'),
    completeText: document.getElementById('complete-text'),
    restartBtn: document.getElementById('restart-btn')
  };

  let currentTabId = null;
  let isExporting = false;

  // 年セレクトボックスを動的に生成
  const initYearSelect = () => {
    const currentYear = new Date().getFullYear();
    const startYear = 2008; // Amazonの最古年
    const select = elements.yearSelect;
    
    // 現在年 から 2008年まで降順で生成
    for (let year = currentYear; year >= startYear; year--) {
      const option = document.createElement('option');
      option.value = year;
      option.textContent = `${year}年`;
      
      // 現在年をデフォルト選択
      if (year === currentYear) {
        option.selected = true;
      }
      
      select.appendChild(option);
    }
  };

  // 現在のタブを確認
  const checkCurrentTab = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab || !tab.url) {
        showError();
        return null;
      }
      
      // Amazonの注文履歴ページかどうかチェック
      const isAmazonOrderPage = 
        tab.url.includes('amazon.co.jp/your-orders') || 
        tab.url.includes('amazon.co.jp/gp/css/order-history');
      
      if (!isAmazonOrderPage) {
        showError();
        return null;
      }
      
      return tab;
    } catch (e) {
      console.error('タブ確認エラー:', e);
      showError();
      return null;
    }
  };

  // エラー表示
  const showError = () => {
    elements.errorMessage.classList.remove('hidden');
    elements.settingsForm.classList.add('hidden');
  };

  // 設定フォーム表示
  const showSettings = () => {
    elements.errorMessage.classList.add('hidden');
    elements.settingsForm.classList.remove('hidden');
    elements.progressSection.classList.add('hidden');
    elements.completeSection.classList.add('hidden');
    elements.exportBtn.disabled = false;
    isExporting = false;
  };

  // 進捗表示
  const showProgress = () => {
    elements.settingsForm.classList.add('hidden');
    elements.progressSection.classList.remove('hidden');
    elements.completeSection.classList.add('hidden');
  };

  // 完了表示
  const showComplete = (orderCount) => {
    elements.progressSection.classList.add('hidden');
    elements.completeSection.classList.remove('hidden');
    elements.completeText.textContent = `${orderCount}件のエクスポート完了！`;
  };

  // 進捗更新
  const updateProgress = (current, total, message) => {
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    elements.progressText.textContent = message || `${current} / ${total} 件`;
    elements.progressPercent.textContent = `${percent}%`;
    elements.progressFill.style.width = `${percent}%`;
  };

  // 設定を取得
  const getSettings = () => {
    const exportMode = document.querySelector('input[name="export-mode"]:checked').value;
    const year = parseInt(elements.yearSelect.value, 10);
    const fetchInvoice = elements.fetchInvoiceCheckbox.checked;

    return { exportMode, year, fetchInvoice };
  };

  // エクスポート開始
  const startExport = async () => {
    if (isExporting) return;

    const tab = await checkCurrentTab();
    if (!tab) return;

    currentTabId = tab.id;
    isExporting = true;

    const settings = getSettings();
    
    showProgress();
    updateProgress(0, 0, '準備中...');

    try {
      // content script にメッセージ送信
      await chrome.tabs.sendMessage(currentTabId, {
        action: 'startExport',
        settings
      });
    } catch (e) {
      console.error('メッセージ送信エラー:', e);
      
      // content script が読み込まれていない場合、注入を試みる
      try {
        await chrome.scripting.executeScript({
          target: { tabId: currentTabId },
          files: ['content.js']
        });
        
        // 少し待ってから再送信
        await new Promise(resolve => setTimeout(resolve, 500));
        
        await chrome.tabs.sendMessage(currentTabId, {
          action: 'startExport',
          settings
        });
      } catch (e2) {
        console.error('スクリプト注入エラー:', e2);
        alert('エラーが発生しました。ページを更新してから再試行してください。');
        showSettings();
      }
    }
  };

  // キャンセル
  const cancelExport = async () => {
    if (!currentTabId) return;

    try {
      await chrome.tabs.sendMessage(currentTabId, { action: 'cancelExport' });
    } catch (e) {
      console.error('キャンセル送信エラー:', e);
    }

    showSettings();
  };

  // メッセージ受信（content script からの進捗報告）
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'progress') {
      updateProgress(message.current, message.total, message.message);
    } else if (message.action === 'complete') {
      showComplete(message.orderCount);
      isExporting = false;
    } else if (message.action === 'error') {
      alert(`エラー: ${message.message}`);
      showSettings();
    }
  });

  // イベントリスナー
  elements.exportBtn.addEventListener('click', startExport);
  elements.cancelBtn.addEventListener('click', cancelExport);
  elements.restartBtn.addEventListener('click', showSettings);

  // 初期化
  initYearSelect();
  
  const tab = await checkCurrentTab();
  if (tab) {
    currentTabId = tab.id;
    
    // 処理中かどうか確認
    try {
      const response = await chrome.tabs.sendMessage(currentTabId, { action: 'getStatus' });
      if (response && response.isRunning) {
        showProgress();
        updateProgress(0, 0, '処理中...');
      } else {
        showSettings();
      }
    } catch (e) {
      // content scriptがまだ読み込まれていない場合
      showSettings();
    }
  }
});
