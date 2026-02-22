// background.js - Service Worker
// Coordinates export flow: receives data from content script, uploads images, generates markdown, triggers download

importScripts('lib/github.js', 'lib/image.js', 'lib/markdown.js');

// Message handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'startExport':
      handleSingleExport(request.tabId, request.options)
        .then((result) => sendResponse({ success: true, ...result }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'startBatchExport':
      handleBatchExport(request.tabId, request.conversationIds, request.options)
        .then((result) => sendResponse({ success: true, ...result }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'getConversationList':
      // Forward to content script
      chrome.tabs.sendMessage(request.tabId, { action: 'getConversationList' }, (resp) => {
        sendResponse(resp);
      });
      return true;

    case 'verifyToken':
      GitHubService.verifyToken(request.token)
        .then((username) => sendResponse({ success: true, username }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'progress':
      // Forward progress from content script to popup
      broadcastProgress(request);
      return false;
  }
});

// Export current conversation
async function handleSingleExport(tabId, options) {
  // Ask content script to fetch data and images
  const response = await sendToContentScript(tabId, {
    action: 'exportConversation',
    options,
  });

  if (!response.success) {
    throw new Error(response.error);
  }

  return await processAndDownload(response.data, options);
}

// Batch export multiple conversations
async function handleBatchExport(tabId, conversationIds, options) {
  const results = [];
  const total = conversationIds.length;

  for (let i = 0; i < total; i++) {
    const convId = conversationIds[i];

    broadcastProgress({
      stage: 'batch',
      current: i + 1,
      total,
      conversationId: convId,
    });

    try {
      const response = await sendToContentScript(tabId, {
        action: 'exportSpecificConversation',
        conversationId: convId,
        options,
      });

      if (!response.success) {
        results.push({ conversationId: convId, success: false, error: response.error });
        continue;
      }

      const result = await processAndDownload(response.data, options);
      results.push({ conversationId: convId, success: true, ...result });
    } catch (err) {
      results.push({ conversationId: convId, success: false, error: err.message });
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  return { total, succeeded, failed: total - succeeded, results };
}

// Process conversation data: upload images + generate markdown + download
async function processAndDownload(data, options) {
  const { conversation, messages, images } = data;
  const imageUrlMap = {};

  // Upload images to GitHub if configured
  if (options.imageMode === 'github' && images.length > 0) {
    const isConfigured = await GitHubService.isConfigured();
    if (!isConfigured) {
      throw new Error('GitHub image hosting not configured. Please set up in extension options.');
    }

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (!img.base64) continue;

      broadcastProgress({
        stage: 'uploading',
        current: i + 1,
        total: images.length,
        fileName: img.fileName,
      });

      try {
        const ext = ImageUtils.getExtension(img.mimeType || 'image/png');
        const fileName = GitHubService.generateFileName(ext);
        const result = await GitHubService.uploadImage(img.base64, fileName);
        imageUrlMap[img.id] = result.url;
      } catch (err) {
        console.warn(`Failed to upload image ${img.fileName}:`, err);
        // Continue with remaining images
      }
    }
  }

  // Generate Markdown
  const markdown = MarkdownConverter.convert(conversation, messages, {
    includeThinking: options.includeThinking ?? false,
    includeArtifacts: options.includeArtifacts ?? true,
    includeTimestamp: options.includeTimestamp ?? true,
    imageUrlMap,
  });

  // Trigger download
  const fileName = sanitizeFileName(conversation.name || 'claude-conversation') + '.md';
  const dataUrl = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(markdown);

  await chrome.downloads.download({
    url: dataUrl,
    filename: fileName,
    saveAs: options.saveAs !== false,
  });

  return {
    fileName,
    messageCount: messages.length,
    imageCount: Object.keys(imageUrlMap).length,
    totalImages: images.length,
  };
}

// Send message to content script and wait for response
function sendToContentScript(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// Broadcast progress to all extension pages (popup)
function broadcastProgress(progress) {
  chrome.runtime.sendMessage({ action: 'progressUpdate', ...progress }).catch(() => {});
}

// Sanitize filename for download
function sanitizeFileName(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 100);
}
