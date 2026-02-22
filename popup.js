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
  const progressSection = document.getElementById('progress-section');
  const progressBar = document.getElementById('progress-bar');
  const progressText = document.getElementById('progress-text');
  const statusMessage = document.getElementById('status-message');
  const openOptions = document.getElementById('open-options');
  // Project elements
  const projectInfo = document.getElementById('project-info');
  const projectConvList = document.getElementById('project-conversation-list');
  const projectExportBtn = document.getElementById('project-export-btn');

  let currentTabId = null;
  let conversations = [];
  let projectConversationIds = []; // all conversation IDs in current project
  const selectedIds = new Set(); // persist selection across search/re-render
  let exporting = false; // guard against late progress messages

  // Tab switching
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tabContents.forEach((tc) => tc.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // Helper: switch to a specific tab programmatically
  function switchToTab(tabName) {
    tabs.forEach((t) => t.classList.remove('active'));
    tabContents.forEach((tc) => tc.classList.remove('active'));
    const targetTab = document.querySelector(`.tab[data-tab="${tabName}"]`);
    if (targetTab) targetTab.classList.add('active');
    const targetContent = document.getElementById(`tab-${tabName}`);
    if (targetContent) targetContent.classList.add('active');
  }

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
  const isOnProject = /claude\.ai\/project\/[a-f0-9-]+/.test(tab.url);

  if (isOnChat) {
    currentInfo.innerHTML = '<span class="info-label">当前对话已就绪</span>';
    exportBtn.disabled = false;
  } else {
    currentInfo.innerHTML = '<span class="info-label">请打开一个对话页面以导出当前对话</span>';
    exportBtn.disabled = true;
  }

  // If on a project page, auto-switch to Project tab and load conversations
  if (isOnProject) {
    switchToTab('project');
    loadProjectConversations();
  } else {
    projectInfo.innerHTML = '<span class="info-label">请打开一个 Project 页面以使用此功能</span>';
  }

  // Listen for progress updates (only while exporting)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'progressUpdate' && exporting) {
      showProgress(msg);
    }
  });

  // Export current conversation
  exportBtn.addEventListener('click', async () => {
    if (!currentTabId) return;

    exportBtn.disabled = true;
    exportBtn.textContent = '导出中...';
    exporting = true;
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
      exporting = false;
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

  // Select/deselect all (operates on currently visible items)
  selectAllBtn.addEventListener('click', () => {
    conversationList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = true;
      selectedIds.add(cb.value);
    });
    updateSelectedCount();
  });

  deselectAllBtn.addEventListener('click', () => {
    conversationList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = false;
      selectedIds.delete(cb.value);
    });
    updateSelectedCount();
  });

  // Batch export
  batchExportBtn.addEventListener('click', async () => {
    const selected = getSelectedConversationIds();
    if (selected.length === 0) return;

    batchExportBtn.disabled = true;
    batchExportBtn.textContent = '导出中...';
    exporting = true;
    hideStatus();
    showProgressSection();

    const options = getBatchExportOptions();
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
      exporting = false;
      batchExportBtn.disabled = false;
      updateSelectedCount();
      hideProgressSection();
    }
  });

  // --- Project export ---

  async function loadProjectConversations() {
    projectInfo.innerHTML = '<span class="info-label">正在加载 Project 对话...</span>';
    projectConvList.innerHTML = '<p class="placeholder">加载中...</p>';
    projectExportBtn.disabled = true;

    try {
      // Ensure content script is ready (it may not be injected yet on project pages)
      await ensureContentScript(currentTabId);

      const result = await chrome.tabs.sendMessage(currentTabId, {
        action: 'getProjectConversations',
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      const { project, conversations: convs } = result.data;
      projectConversationIds = convs.map((c) => c.uuid);

      projectInfo.innerHTML = `<span class="info-label"><strong>${escapeHtml(project.name)}</strong> — ${convs.length} 个对话</span>`;

      if (convs.length === 0) {
        projectConvList.innerHTML = '<p class="placeholder">该 Project 下没有对话</p>';
        return;
      }

      projectConvList.innerHTML = convs
        .map((conv) => {
          const date = conv.updated_at
            ? formatDate(conv.updated_at)
            : conv.created_at
              ? formatDate(conv.created_at)
              : '';
          const name = escapeHtml(conv.name || 'Untitled');
          return `
            <div class="conv-item">
              <div class="conv-item-info">
                <div class="conv-item-name" title="${name}">${name}</div>
                <div class="conv-item-date">${date}</div>
              </div>
            </div>
          `;
        })
        .join('');

      projectExportBtn.disabled = false;
      projectExportBtn.textContent = `一键导出 Project 所有对话 (${convs.length} 个)`;
    } catch (err) {
      projectInfo.innerHTML = `<span class="info-label" style="color:#991b1b">加载失败: ${err.message}</span>`;
      projectConvList.innerHTML = '';
    }
  }

  projectExportBtn.addEventListener('click', async () => {
    if (projectConversationIds.length === 0) return;

    projectExportBtn.disabled = true;
    projectExportBtn.textContent = '导出中...';
    exporting = true;
    hideStatus();
    showProgressSection();

    const options = getProjectExportOptions();
    options.saveAs = false;

    try {
      const result = await chrome.runtime.sendMessage({
        action: 'startBatchExport',
        tabId: currentTabId,
        conversationIds: projectConversationIds,
        options,
      });

      if (result.success) {
        showStatus(
          'success',
          `Project 导出完成: ${result.succeeded}/${result.total} 成功` +
            (result.failed > 0 ? `, ${result.failed} 失败` : '')
        );
      } else {
        throw new Error(result.error);
      }
    } catch (err) {
      showStatus('error', `Project 导出失败: ${err.message}`);
    } finally {
      exporting = false;
      projectExportBtn.disabled = false;
      projectExportBtn.textContent = `一键导出 Project 所有对话 (${projectConversationIds.length} 个)`;
      hideProgressSection();
    }
  });

  // Open options page
  openOptions.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Debug button
  const debugBtn = document.getElementById('debug-btn');
  if (debugBtn) {
    debugBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!currentTabId) {
        showStatus('error', '请先打开 claude.ai 页面');
        return;
      }

      debugBtn.textContent = '获取中...';
      try {
        // Use debugConversation for chat pages, or getProjectConversations for project pages
        const action = isOnChat ? 'debugConversation' : 'getProjectConversations';
        const result = await chrome.tabs.sendMessage(currentTabId, { action });

        if (result.success) {
          const json = JSON.stringify(result.data, null, 2);
          const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
          await chrome.downloads.download({
            url: dataUrl,
            filename: 'aiexporter-debug.json',
            saveAs: false,
          });
          showStatus('success', '调试数据已下载为 aiexporter-debug.json');
        } else {
          throw new Error(result.error);
        }
      } catch (err) {
        showStatus('error', `调试失败: ${err.message}`);
      } finally {
        debugBtn.textContent = '调试: 查看 API 数据';
      }
    });
  }

  // --- Helper functions ---

  // Ensure content script is injected and responsive
  async function ensureContentScript(tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    } catch {
      // Content script not ready, inject it manually
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
      });
      // Wait a moment for it to initialize
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  function getExportOptions() {
    return {
      includeThinking: document.getElementById('opt-thinking').checked,
      includeArtifacts: document.getElementById('opt-artifacts').checked,
      includeTimestamp: document.getElementById('opt-timestamp').checked,
      imageMode: document.querySelector('input[name="image-mode"]:checked').value,
    };
  }

  function getBatchExportOptions() {
    return {
      includeThinking: document.getElementById('batch-opt-thinking').checked,
      includeArtifacts: document.getElementById('batch-opt-artifacts').checked,
      includeTimestamp: document.getElementById('batch-opt-timestamp').checked,
      imageMode: document.querySelector('input[name="batch-image-mode"]:checked').value,
    };
  }

  function getProjectExportOptions() {
    return {
      includeThinking: document.getElementById('project-opt-thinking').checked,
      includeArtifacts: document.getElementById('project-opt-artifacts').checked,
      includeTimestamp: document.getElementById('project-opt-timestamp').checked,
      imageMode: document.querySelector('input[name="project-image-mode"]:checked').value,
    };
  }

  function renderConversationList(convs) {
    if (convs.length === 0) {
      conversationList.innerHTML = '<p class="placeholder">没有找到对话</p>';
      updateSelectedCount();
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
        const checked = selectedIds.has(conv.uuid) ? 'checked' : '';
        return `
          <div class="conv-item" data-id="${conv.uuid}">
            <input type="checkbox" value="${conv.uuid}" ${checked}>
            <div class="conv-item-info">
              <div class="conv-item-name" title="${name}">${name}</div>
              <div class="conv-item-date">${date}</div>
            </div>
          </div>
        `;
      })
      .join('');

    conversationList.querySelectorAll('.conv-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        const cb = item.querySelector('input[type="checkbox"]');
        cb.checked = !cb.checked;
        toggleSelection(cb.value, cb.checked);
      });
    });

    conversationList
      .querySelectorAll('input[type="checkbox"]')
      .forEach((cb) => cb.addEventListener('change', () => toggleSelection(cb.value, cb.checked)));
  }

  function toggleSelection(id, checked) {
    if (checked) {
      selectedIds.add(id);
    } else {
      selectedIds.delete(id);
    }
    updateSelectedCount();
  }

  function getSelectedConversationIds() {
    return Array.from(selectedIds);
  }

  function updateSelectedCount() {
    const count = selectedIds.size;
    batchExportBtn.disabled = count === 0;
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
