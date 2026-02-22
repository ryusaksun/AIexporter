// content.js - Content Script running on claude.ai
// Calls Claude's internal API using the user's session cookies

(function () {
  'use strict';

  let cachedOrgId = null;

  // Get organization ID from Claude API
  async function getOrganizationId() {
    if (cachedOrgId) return cachedOrgId;

    const resp = await fetch('https://claude.ai/api/organizations', {
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });

    if (!resp.ok) {
      throw new Error(`Failed to get organization ID: ${resp.status}`);
    }

    const orgs = await resp.json();
    if (!orgs || orgs.length === 0) {
      throw new Error('No organizations found');
    }

    cachedOrgId = orgs[0].uuid;
    return cachedOrgId;
  }

  // Extract conversation ID from current URL
  function getConversationIdFromURL() {
    const match = window.location.pathname.match(/\/chat\/([a-f0-9-]+)/);
    return match ? match[1] : null;
  }

  // Fetch a single conversation's full data
  async function fetchConversation(orgId, conversationId) {
    const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`;

    const resp = await fetch(url, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });

    if (!resp.ok) {
      throw new Error(`Failed to fetch conversation: ${resp.status}`);
    }

    return resp.json();
  }

  // Fetch conversation list for batch export
  async function fetchConversationList(orgId) {
    const conversations = [];
    let cursor = null;
    const limit = 50;

    // Paginate through all conversations
    while (true) {
      let url = `https://claude.ai/api/organizations/${orgId}/chat_conversations?limit=${limit}`;
      if (cursor) {
        url += `&cursor=${cursor}`;
      }

      const resp = await fetch(url, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });

      if (!resp.ok) {
        throw new Error(`Failed to fetch conversation list: ${resp.status}`);
      }

      const data = await resp.json();

      // Handle both array and paginated object responses
      if (Array.isArray(data)) {
        conversations.push(...data);
        break; // No pagination
      } else if (data.conversations || data.chat_conversations) {
        const items = data.conversations || data.chat_conversations;
        conversations.push(...items);
        if (data.has_more && data.cursor) {
          cursor = data.cursor;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    return conversations;
  }

  // Walk from leaf to root to get current branch messages in order
  function getCurrentBranchMessages(data) {
    const messageMap = {};
    for (const msg of data.chat_messages) {
      messageMap[msg.uuid] = msg;
    }

    const messages = [];
    let currentId = data.current_leaf_message_uuid;

    while (currentId && messageMap[currentId]) {
      messages.unshift(messageMap[currentId]);
      currentId = messageMap[currentId].parent_message_uuid;
    }

    return messages;
  }

  // Download an image URL as base64 (using page's cookies)
  async function downloadImageAsBase64(imageUrl) {
    try {
      const resp = await fetch(imageUrl, { credentials: 'include' });
      if (!resp.ok) return null;

      const blob = await resp.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = reader.result.split(',')[1];
          resolve({ base64, mimeType: blob.type });
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  }

  // Extract all images from messages and download them
  async function extractAndDownloadImages(messages, sendProgress) {
    const images = [];
    let index = 0;

    for (const msg of messages) {
      // User attachments
      if (msg.attachments) {
        for (const att of msg.attachments) {
          if (att.file_type && att.file_type.startsWith('image/')) {
            const imageInfo = {
              id: `att-${msg.uuid}-${att.file_name || index}`,
              messageUuid: msg.uuid,
              type: 'attachment',
              fileName: att.file_name || `image-${index}`,
              mimeType: att.file_type,
              base64: null,
            };

            // Download if URL is available
            if (att.file_url) {
              sendProgress({ stage: 'downloading', current: index + 1, fileName: att.file_name });
              const result = await downloadImageAsBase64(att.file_url);
              if (result) {
                imageInfo.base64 = result.base64;
                imageInfo.mimeType = result.mimeType || att.file_type;
              }
            }

            images.push(imageInfo);
            index++;
          }
        }
      }

      // AI-generated images in content blocks
      if (msg.content && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.display_content) {
            if (block.display_content.type === 'image' && block.display_content.url) {
              const imageInfo = {
                id: `gen-${msg.uuid}-${index}`,
                messageUuid: msg.uuid,
                type: 'generated',
                fileName: `generated-${index}.png`,
                mimeType: 'image/png',
                base64: null,
              };

              sendProgress({ stage: 'downloading', current: index + 1, fileName: imageInfo.fileName });
              const result = await downloadImageAsBase64(block.display_content.url);
              if (result) {
                imageInfo.base64 = result.base64;
                imageInfo.mimeType = result.mimeType;
              }

              images.push(imageInfo);
              index++;
            }
          }
        }
      }
    }

    return images;
  }

  // Listen for messages from popup / background
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'exportConversation') {
      handleExportConversation(request.options)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // async
    }

    if (request.action === 'exportSpecificConversation') {
      handleExportSpecificConversation(request.conversationId, request.options)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (request.action === 'getConversationList') {
      handleGetConversationList()
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (request.action === 'ping') {
      sendResponse({ success: true });
      return false;
    }
  });

  // Export the current conversation
  async function handleExportConversation(options) {
    const orgId = await getOrganizationId();
    const convId = getConversationIdFromURL();

    if (!convId) {
      throw new Error('No conversation found in current URL');
    }

    return await exportConversationById(orgId, convId, options);
  }

  // Export a specific conversation by ID
  async function handleExportSpecificConversation(conversationId, options) {
    const orgId = await getOrganizationId();
    return await exportConversationById(orgId, conversationId, options);
  }

  // Core export logic
  async function exportConversationById(orgId, conversationId, options) {
    const data = await fetchConversation(orgId, conversationId);
    const messages = getCurrentBranchMessages(data);

    let images = [];
    if (options.imageMode !== 'skip') {
      images = await extractAndDownloadImages(messages, (progress) => {
        chrome.runtime.sendMessage({ action: 'progress', ...progress }).catch(() => {});
      });
    }

    return {
      conversation: {
        uuid: data.uuid,
        name: data.name,
        created_at: data.created_at,
        updated_at: data.updated_at,
      },
      messages,
      images,
    };
  }

  // Get conversation list for batch export
  async function handleGetConversationList() {
    const orgId = await getOrganizationId();
    const conversations = await fetchConversationList(orgId);

    return conversations.map((conv) => ({
      uuid: conv.uuid,
      name: conv.name || 'Untitled',
      created_at: conv.created_at,
      updated_at: conv.updated_at,
    }));
  }
})();
