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

  // Extract project ID from current URL
  function getProjectIdFromURL() {
    const match = window.location.pathname.match(/\/project\/([a-f0-9-]+)/);
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

  // Fetch conversations belonging to a specific project
  async function fetchProjectConversations(orgId, projectId) {
    // Try multiple possible API endpoints
    const endpoints = [
      `https://claude.ai/api/organizations/${orgId}/projects/${projectId}/chat_conversations`,
      `https://claude.ai/api/organizations/${orgId}/projects/${projectId}/conversations`,
      `https://claude.ai/api/organizations/${orgId}/projects/${projectId}/docs`,
      `https://claude.ai/api/organizations/${orgId}/chat_conversations?project_uuid=${projectId}`,
    ];

    for (const url of endpoints) {
      try {
        const resp = await fetch(url, {
          credentials: 'include',
          headers: { 'Accept': 'application/json' },
        });

        if (!resp.ok) {
          console.log(`[AIexporter] ${url} -> ${resp.status}`);
          continue;
        }

        const data = await resp.json();
        console.log(`[AIexporter] ${url} -> keys:`, Array.isArray(data) ? `array[${data.length}]` : Object.keys(data));

        // Array of conversations
        if (Array.isArray(data) && data.length > 0 && data[0].uuid) {
          return data;
        }

        // Object with conversation list
        if (data.chat_conversations) return data.chat_conversations;
        if (data.conversations) return data.conversations;

        // Paginated response
        if (data.data && Array.isArray(data.data)) return data.data;
        if (data.results && Array.isArray(data.results)) return data.results;
      } catch (err) {
        console.log(`[AIexporter] ${url} -> error:`, err.message);
        continue;
      }
    }

    // Fallback: fetch all conversations and filter by project_uuid
    console.log('[AIexporter] Trying fallback: fetch all conversations and filter by project_uuid');
    const allConversations = await fetchConversationList(orgId);

    // Try multiple possible field names for project association
    const filtered = allConversations.filter((c) => {
      if (c.project_uuid === projectId) return true;
      if (c.project?.uuid === projectId) return true;
      if (c.project_id === projectId) return true;
      return false;
    });

    console.log(`[AIexporter] Fallback: ${allConversations.length} total, ${filtered.length} matched project`);

    // If filtering found nothing, dump first conversation's keys for debugging
    if (filtered.length === 0 && allConversations.length > 0) {
      const sample = allConversations[0];
      console.log('[AIexporter] Sample conversation keys:', Object.keys(sample));
      console.log('[AIexporter] Sample project-related fields:', {
        project_uuid: sample.project_uuid,
        project: sample.project,
        project_id: sample.project_id,
      });
    }

    return filtered;
  }

  // Fetch project metadata (name, description)
  async function fetchProjectInfo(orgId, projectId) {
    try {
      const resp = await fetch(
        `https://claude.ai/api/organizations/${orgId}/projects/${projectId}`,
        {
          credentials: 'include',
          headers: { 'Accept': 'application/json' },
        }
      );
      if (!resp.ok) return null;
      return resp.json();
    } catch {
      return null;
    }
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

  // Get the best available URL from an attachment object
  // Claude API may use different field names across versions
  function getAttachmentUrl(att, orgId) {
    // Try common URL field names (prefer higher quality)
    if (att.file_url) return att.file_url;
    if (att.url) return att.url;
    if (att.preview_url) return att.preview_url;
    if (att.thumbnail_url) return att.thumbnail_url;
    if (att.content_url) return att.content_url;

    // Try asset fields (Claude uses preview_asset/thumbnail_asset as objects with .url)
    if (att.preview_asset?.url) return att.preview_asset.url;
    if (att.thumbnail_asset?.url) return att.thumbnail_asset.url;

    // Construct URL from file_uuid or uuid or id
    const fileId = att.file_uuid || att.uuid || att.id;
    if (fileId && orgId) {
      return `https://claude.ai/api/organizations/${orgId}/files/${fileId}/content`;
    }

    return null;
  }

  // Get MIME type from attachment, trying multiple field names
  function getAttachmentMimeType(att) {
    return att.file_type || att.media_type || att.content_type || att.mime_type || '';
  }

  // Check if an attachment is an image
  function isImageAttachment(att) {
    const mime = getAttachmentMimeType(att);
    if (mime && mime.startsWith('image/')) return true;

    // Check file_kind field (Claude API uses this)
    const kind = att.file_kind || '';
    if (kind === 'image' || kind.startsWith('image')) return true;

    // Fallback: check file name extension
    const name = att.file_name || att.filename || att.name || '';
    if (/\.(png|jpg|jpeg|gif|webp|svg|bmp|tiff|heic)$/i.test(name)) return true;

    return false;
  }

  // Download an image URL as base64 (using page's cookies)
  async function downloadImageAsBase64(imageUrl) {
    try {
      // Handle relative URLs
      if (imageUrl.startsWith('/')) {
        imageUrl = `https://claude.ai${imageUrl}`;
      }

      const resp = await fetch(imageUrl, { credentials: 'include' });
      if (!resp.ok) {
        console.warn(`[AIexporter] Image download failed: ${resp.status} for ${imageUrl}`);
        return null;
      }

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
    } catch (err) {
      console.warn(`[AIexporter] Image download error:`, err);
      return null;
    }
  }

  // Extract all images from messages and download them
  async function extractAndDownloadImages(messages, sendProgress, orgId) {
    const images = [];
    let index = 0;

    for (const msg of messages) {
      // 1. User attachments (array of file objects)
      if (msg.attachments && Array.isArray(msg.attachments)) {
        for (const att of msg.attachments) {
          if (!isImageAttachment(att)) continue;

          const fileName = att.file_name || att.filename || att.name || `image-${index}`;
          const imageInfo = {
            id: `att-${msg.uuid}-${fileName}`,
            messageUuid: msg.uuid,
            type: 'attachment',
            fileName,
            mimeType: getAttachmentMimeType(att) || 'image/png',
            base64: null,
          };

          const imageUrl = getAttachmentUrl(att, orgId);
          if (imageUrl) {
            sendProgress({ stage: 'downloading', current: index + 1, fileName });
            const result = await downloadImageAsBase64(imageUrl);
            if (result) {
              imageInfo.base64 = result.base64;
              imageInfo.mimeType = result.mimeType || imageInfo.mimeType;
            }
          }

          images.push(imageInfo);
          index++;
        }
      }

      // 2. Files array (alternative to attachments in some API versions)
      if (msg.files && Array.isArray(msg.files)) {
        for (const file of msg.files) {
          if (!isImageAttachment(file)) continue;

          const fileName = file.file_name || file.filename || file.name || `file-${index}`;
          const imageInfo = {
            id: `file-${msg.uuid}-${fileName}`,
            messageUuid: msg.uuid,
            type: 'attachment',
            fileName,
            mimeType: getAttachmentMimeType(file) || 'image/png',
            base64: null,
          };

          const imageUrl = getAttachmentUrl(file, orgId);
          if (imageUrl) {
            sendProgress({ stage: 'downloading', current: index + 1, fileName });
            const result = await downloadImageAsBase64(imageUrl);
            if (result) {
              imageInfo.base64 = result.base64;
              imageInfo.mimeType = result.mimeType || imageInfo.mimeType;
            }
          }

          images.push(imageInfo);
          index++;
        }
      }

      // 3. Image content blocks (in both user and assistant messages)
      if (msg.content && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          // Direct image content block: { type: "image", source: { ... } }
          if (block.type === 'image') {
            const imageInfo = {
              id: `img-${msg.uuid}-${index}`,
              messageUuid: msg.uuid,
              type: 'content_image',
              fileName: `image-${index}.png`,
              mimeType: block.media_type || block.source?.media_type || 'image/png',
              base64: null,
            };

            // Image might have base64 data inline
            if (block.source?.type === 'base64' && block.source?.data) {
              imageInfo.base64 = block.source.data;
              imageInfo.mimeType = block.source.media_type || 'image/png';
            } else if (block.source?.type === 'url' && block.source?.url) {
              sendProgress({ stage: 'downloading', current: index + 1, fileName: imageInfo.fileName });
              const result = await downloadImageAsBase64(block.source.url);
              if (result) {
                imageInfo.base64 = result.base64;
                imageInfo.mimeType = result.mimeType;
              }
            } else if (block.url) {
              sendProgress({ stage: 'downloading', current: index + 1, fileName: imageInfo.fileName });
              const result = await downloadImageAsBase64(block.url);
              if (result) {
                imageInfo.base64 = result.base64;
                imageInfo.mimeType = result.mimeType;
              }
            }

            images.push(imageInfo);
            index++;
          }

          // AI-generated images via tool_use (artifacts)
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

    if (request.action === 'getProjectConversations') {
      handleGetProjectConversations()
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    // Debug: dump raw API response for a conversation
    if (request.action === 'debugConversation') {
      handleDebugConversation()
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
      }, orgId);
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

  // Debug: fetch raw conversation data and log structure
  async function handleDebugConversation() {
    const orgId = await getOrganizationId();
    const convId = getConversationIdFromURL();

    if (!convId) {
      throw new Error('No conversation found in current URL');
    }

    const data = await fetchConversation(orgId, convId);
    const messages = getCurrentBranchMessages(data);

    // Extract structure info for each message (without huge content)
    const debugInfo = messages.map((msg) => {
      const info = {
        uuid: msg.uuid,
        sender: msg.sender,
        hasText: !!msg.text,
        textPreview: msg.text ? msg.text.substring(0, 80) : null,
        contentTypes: [],
        attachments: [],
        files: [],
        allKeys: Object.keys(msg),
      };

      if (msg.content && Array.isArray(msg.content)) {
        info.contentTypes = msg.content.map((b) => {
          const blockInfo = { type: b.type };
          if (b.type === 'image') {
            blockInfo.source_type = b.source?.type;
            blockInfo.has_data = !!b.source?.data;
            blockInfo.media_type = b.source?.media_type || b.media_type;
            blockInfo.url = b.url || b.source?.url;
          }
          return blockInfo;
        });
      }

      if (msg.attachments && Array.isArray(msg.attachments)) {
        info.attachments = msg.attachments.map((att) => ({
          keys: Object.keys(att),
          file_name: att.file_name || att.filename || att.name,
          file_type: att.file_type || att.media_type || att.content_type || att.mime_type,
          has_file_url: !!att.file_url,
          has_url: !!att.url,
          has_preview_url: !!att.preview_url,
          has_content_url: !!att.content_url,
          has_id: !!att.id,
          id: att.id,
        }));
      }

      if (msg.files && Array.isArray(msg.files)) {
        info.files = msg.files.map((f) => {
          // Dump ALL field values (except large binary data)
          const dump = {};
          for (const key of Object.keys(f)) {
            const val = f[key];
            if (typeof val === 'string' && val.length > 500) {
              dump[key] = val.substring(0, 200) + '...[truncated]';
            } else {
              dump[key] = val;
            }
          }
          return dump;
        });
      }

      // Also check files_v2
      if (msg.files_v2 && Array.isArray(msg.files_v2) && msg.files_v2.length > 0) {
        info.files_v2 = msg.files_v2.map((f) => {
          const dump = {};
          for (const key of Object.keys(f)) {
            const val = f[key];
            if (typeof val === 'string' && val.length > 500) {
              dump[key] = val.substring(0, 200) + '...[truncated]';
            } else {
              dump[key] = val;
            }
          }
          return dump;
        });
      }

      return info;
    });

    // Log to console for debugging
    console.log('[AIexporter] Raw conversation data keys:', Object.keys(data));
    console.log('[AIexporter] Message count:', messages.length);
    console.log('[AIexporter] Message debug info:', JSON.stringify(debugInfo, null, 2));

    return debugInfo;
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

  // Get conversations for a specific project
  async function handleGetProjectConversations() {
    const orgId = await getOrganizationId();
    const projectId = getProjectIdFromURL();

    if (!projectId) {
      throw new Error('No project found in current URL');
    }

    // Get project info for the name
    const projectInfo = await fetchProjectInfo(orgId, projectId);
    const conversations = await fetchProjectConversations(orgId, projectId);

    return {
      project: {
        uuid: projectId,
        name: projectInfo?.name || 'Unknown Project',
        description: projectInfo?.description || '',
      },
      conversations: conversations.map((conv) => ({
        uuid: conv.uuid,
        name: conv.name || 'Untitled',
        created_at: conv.created_at,
        updated_at: conv.updated_at,
      })),
    };
  }
})();
