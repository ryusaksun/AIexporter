// options.js - Settings page logic

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('settings-form');
  const tokenInput = document.getElementById('github-token');
  const ownerInput = document.getElementById('github-owner');
  const imageRepoInput = document.getElementById('image-repo');
  const imageBranchInput = document.getElementById('image-branch');
  const toggleTokenBtn = document.getElementById('toggle-token');
  const verifyTokenBtn = document.getElementById('verify-token');
  const statusEl = document.getElementById('status');
  const connectionStatus = document.getElementById('connection-status');
  const connectionText = document.getElementById('connection-text');

  // Load saved settings
  const localData = await chrome.storage.local.get({ github_token: '' });
  const syncData = await chrome.storage.sync.get({
    github_owner: '',
    image_repo: '',
    image_branch: 'main',
    cdn_type: 'jsdelivr',
  });

  tokenInput.value = localData.github_token;
  ownerInput.value = syncData.github_owner;
  imageRepoInput.value = syncData.image_repo;
  imageBranchInput.value = syncData.image_branch;

  const cdnRadio = document.querySelector(`input[name="cdn-type"][value="${syncData.cdn_type}"]`);
  if (cdnRadio) cdnRadio.checked = true;

  // Show connection status if configured
  if (localData.github_token && syncData.github_owner) {
    connectionStatus.classList.remove('hidden');
    connectionText.textContent = `已连接: ${syncData.github_owner}`;
  }

  // Toggle token visibility
  toggleTokenBtn.addEventListener('click', () => {
    if (tokenInput.type === 'password') {
      tokenInput.type = 'text';
      toggleTokenBtn.textContent = '隐藏';
    } else {
      tokenInput.type = 'password';
      toggleTokenBtn.textContent = '显示';
    }
  });

  // Verify token
  verifyTokenBtn.addEventListener('click', async () => {
    const token = tokenInput.value.trim();
    if (!token) {
      showStatus('error', '请输入 Token');
      return;
    }

    verifyTokenBtn.disabled = true;
    verifyTokenBtn.textContent = '验证中...';

    try {
      const result = await chrome.runtime.sendMessage({
        action: 'verifyToken',
        token,
      });

      if (result.success) {
        ownerInput.value = result.username;
        showStatus('success', `Token 验证成功! 用户: ${result.username}`);
        connectionStatus.classList.remove('hidden');
        connectionText.textContent = `已连接: ${result.username}`;
      } else {
        throw new Error(result.error);
      }
    } catch (err) {
      showStatus('error', `验证失败: ${err.message}`);
    } finally {
      verifyTokenBtn.disabled = false;
      verifyTokenBtn.textContent = '验证';
    }
  });

  // Save settings
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const token = tokenInput.value.trim();
    const owner = ownerInput.value.trim();
    const repo = imageRepoInput.value.trim();
    const branch = imageBranchInput.value.trim() || 'main';
    const cdnType = document.querySelector('input[name="cdn-type"]:checked').value;

    if (!token || !owner || !repo) {
      showStatus('error', '请填写所有必填项');
      return;
    }

    // Save token to local storage (not synced)
    await chrome.storage.local.set({ github_token: token });

    // Save other settings to sync storage
    await chrome.storage.sync.set({
      github_owner: owner,
      image_repo: repo,
      image_branch: branch,
      cdn_type: cdnType,
    });

    showStatus('success', '设置已保存');
    connectionStatus.classList.remove('hidden');
    connectionText.textContent = `已连接: ${owner}`;
  });

  function showStatus(type, message) {
    statusEl.className = `status ${type}`;
    statusEl.textContent = message;
    statusEl.classList.remove('hidden');
    setTimeout(() => statusEl.classList.add('hidden'), 4000);
  }
});
