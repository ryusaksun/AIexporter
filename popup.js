// popup.js - Popup window logic

document.addEventListener('DOMContentLoaded', async () => {
  // DOM elements
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');
  const currentInfo = document.getElementById('current-info');
  const exportBtn = document.getElementById('export-btn');
  const batchExportBtn = document.getElementById('batch-export-btn');
  const loadListBtn = document.getElementById('load-list-btn');
  const selectAllBtn = document.getElementById('select-all-btn');
  const deselectAllBtn = document.getElementById('deselect-all-btn');
  const searchInput = document.getElementById('search-input');
  const conversationList = document.getElementById('conversation-list');
  const selectedCountEl = document.getElementById('selected-count');
  const progressSection = document.getElementById('progress-section');
  const progressBar = document.getElementById('progress-bar');
  const progressText = document.getElementById('progress-text');
  const statusMessage = document.getElementById('status-message');
  const openOptions = document.getElementById('open-options');

  let currentTabId = null;
  let conversations = [];

  // Tab switching
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tabContents.forEach((tc) => tc.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // Check if on claude.ai
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;

  if (!tab?.url?.includes('claude.ai')) {
    currentInfo.innerHTML = '<span class="info-label" style="color:#991b1b">请先打开 claude.ai 页面</span>';
    exportBtn.disabled = true;
    loadListBtn.disabled = true;
    return;
  }

  const isOnChat = tab.url.includes('claude.ai/chat/');

  if (isOnChat) {
    currentInfo.innerHTML = '<span class="info-label">当前对话已就绪</span>';
    exportBtn.disabled = false;
  } else {
    currentInfo.innerHTML = '<span class="info-label">请打开一个对话页面以导出当前对话</span>';
    exportBtn.disabled = true;
  }

  // Listen for progress updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'progressUpdate') {
      showProgress(msg);
    }
  });

  // Export current conversation
  exportBtn.addEventListener('click', async () => {
    if (!currentTabId) return;

    exportBtn.disabled = true;
    exportBtn.textContent = '导出中...';
    hideStatus();
    showProgressSection();

    const options = getExportOptions();

    try {
      const result = await chrome.runtime.sendMessage({
        action: 'startExport',
        tabId: currentTabId,
        options,
      });

      if (result.success) {
        showStatus(
          'success',
          `导出成功! ${result.messageCount} 条消息` +
            (result.imageCount > 0 ? `, ${result.imageCount} 张图片已上传` : '')
        );
      } else {
        throw new Error(result.error);
      }
    } catch (err) {
      showStatus('error', `导出失败: ${err.message}`);
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = '导出 Markdown';
      hideProgressSection();
    }
  });

  // Load conversation list
  loadListBtn.addEventListener('click', async () => {
    if (!currentTabId) return;

    loadListBtn.disabled = true;
    loadListBtn.textContent = '加载中...';
    conversationList.innerHTML = '<p class="placeholder">正在加载...</p>';

    try {
      const result = await chrome.runtime.sendMessage({
        action: 'getConversationList',
        tabId: currentTabId,
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      conversations = result.data;
      renderConversationList(conversations);
    } catch (err) {
      conversationList.innerHTML = `<p class="placeholder" style="color:#991b1b">加载失败: ${err.message}</p>`;
    } finally {
      loadListBtn.disabled = false;
      loadListBtn.textContent = '加载对话列表';
    }
  });

  // Search filter
  searchInput.addEventListener('input', () => {
    const query = searchInput.value.toLowerCase().trim();
    if (!query) {
      renderConversationList(conversations);
      return;
    }
    const filtered = conversations.filter(
      (c) => c.name && c.name.toLowerCase().includes(query)
    );
    renderConversationList(filtered);
  });

  // Select/deselect all
  selectAllBtn.addEventListener('click', () => {
    conversationList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = true;
    });
    updateSelectedCount();
  });

  deselectAllBtn.addEventListener('click', () => {
    conversationList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = false;
    });
    updateSelectedCount();
  });

  // Batch export
  batchExportBtn.addEventListener('click', async () => {
    const selected = getSelectedConversationIds();
    if (selected.length === 0) return;

    batchExportBtn.disabled = true;
    batchExportBtn.textContent = '导出中...';
    hideStatus();
    showProgressSection();

    const options = getBatchExportOptions();
    // Don't show saveAs dialog for each file in batch mode
    options.saveAs = false;

    try {
      const result = await chrome.runtime.sendMessage({
        action: 'startBatchExport',
        tabId: currentTabId,
        conversationIds: selected,
        options,
      });

      if (result.success) {
        showStatus(
          'success',
          `批量导出完成: ${result.succeeded}/${result.total} 成功` +
            (result.failed > 0 ? `, ${result.failed} 失败` : '')
        );
      } else {
        throw new Error(result.error);
      }
    } catch (err) {
      showStatus('error', `批量导出失败: ${err.message}`);
    } finally {
      batchExportBtn.disabled = false;
      updateBatchButtonText();
      hideProgressSection();
    }
  });

  // Open options page
  openOptions.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // --- Helper functions ---

  function getExportOptions() {
    return {
      includeThinking: document.getElementById('opt-thinking').checked,
      includeTimestamp: document.getElementById('opt-timestamp').checked,
      imageMode: document.querySelector('input[name="image-mode"]:checked').value,
    };
  }

  function getBatchExportOptions() {
    return {
      includeThinking: document.getElementById('batch-opt-thinking').checked,
      includeTimestamp: document.getElementById('batch-opt-timestamp').checked,
      imageMode: document.querySelector('input[name="batch-image-mode"]:checked').value,
    };
  }

  function renderConversationList(convs) {
    if (convs.length === 0) {
      conversationList.innerHTML = '<p class="placeholder">没有找到对话</p>';
      batchExportBtn.disabled = true;
      return;
    }

    conversationList.innerHTML = convs
      .map((conv) => {
        const date = conv.updated_at
          ? formatDate(conv.updated_at)
          : conv.created_at
            ? formatDate(conv.created_at)
            : '';
        const name = escapeHtml(conv.name || 'Untitled');
        return `
          <div class="conv-item" data-id="${conv.uuid}">
            <input type="checkbox" value="${conv.uuid}">
            <div class="conv-item-info">
              <div class="conv-item-name" title="${name}">${name}</div>
              <div class="conv-item-date">${date}</div>
            </div>
          </div>
        `;
      })
      .join('');

    // Click on item toggles checkbox
    conversationList.querySelectorAll('.conv-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        const cb = item.querySelector('input[type="checkbox"]');
        cb.checked = !cb.checked;
        updateSelectedCount();
      });
    });

    conversationList
      .querySelectorAll('input[type="checkbox"]')
      .forEach((cb) => cb.addEventListener('change', updateSelectedCount));
  }

  function getSelectedConversationIds() {
    const ids = [];
    conversationList.querySelectorAll('input[type="checkbox"]:checked').forEach((cb) => {
      ids.push(cb.value);
    });
    return ids;
  }

  function updateSelectedCount() {
    const count = getSelectedConversationIds().length;
    selectedCountEl.textContent = count;
    batchExportBtn.disabled = count === 0;
    updateBatchButtonText();
  }

  function updateBatchButtonText() {
    const count = getSelectedConversationIds().length;
    batchExportBtn.innerHTML = `批量导出 (<span id="selected-count">${count}</span> 个)`;
  }

  function showProgress(data) {
    showProgressSection();
    if (data.stage === 'batch') {
      progressBar.style.width = `${(data.current / data.total) * 100}%`;
      progressText.textContent = `正在处理第 ${data.current}/${data.total} 个对话...`;
    } else if (data.stage === 'downloading') {
      progressText.textContent = `下载图片: ${data.fileName || ''}`;
    } else if (data.stage === 'uploading') {
      progressBar.style.width = `${(data.current / data.total) * 100}%`;
      progressText.textContent = `上传图片 ${data.current}/${data.total}: ${data.fileName || ''}`;
    }
  }

  function showProgressSection() {
    progressSection.classList.remove('hidden');
  }

  function hideProgressSection() {
    progressSection.classList.add('hidden');
    progressBar.style.width = '0%';
  }

  function showStatus(type, message) {
    statusMessage.className = `status-message ${type}`;
    statusMessage.textContent = message;
    statusMessage.classList.remove('hidden');
  }

  function hideStatus() {
    statusMessage.classList.add('hidden');
  }

  function formatDate(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hour = String(d.getHours()).padStart(2, '0');
    const minute = String(d.getMinutes()).padStart(2, '0');
    return `${month}-${day} ${hour}:${minute}`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
});
