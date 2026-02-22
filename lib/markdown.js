// lib/markdown.js - Convert conversation data to Markdown

const MarkdownConverter = {
  // Main entry: convert conversation data + messages to Markdown string
  convert(conversation, messages, options = {}) {
    const {
      includeThinking = false,
      includeTimestamp = true,
      imageUrlMap = {}, // { imageId: cdnUrl }
    } = options;

    const lines = [];

    // Document header
    const title = conversation.name || 'Untitled Conversation';
    lines.push(`# ${title}`);
    lines.push('');
    lines.push(`> Exported from Claude.ai on ${this.formatDate(new Date().toISOString())}`);
    if (conversation.created_at) {
      lines.push(`> Conversation created: ${this.formatDate(conversation.created_at)}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');

    // Messages
    for (const msg of messages) {
      const isHuman = msg.sender === 'human';
      const roleLabel = isHuman ? '**User**' : '**Claude**';

      // Message header
      if (includeTimestamp && msg.created_at) {
        lines.push(`## ${roleLabel} <sub>${this.formatDate(msg.created_at)}</sub>`);
      } else {
        lines.push(`## ${roleLabel}`);
      }
      lines.push('');

      // Message content
      if (msg.content && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          const rendered = this.renderContentBlock(block, msg, { includeThinking, imageUrlMap });
          if (rendered) {
            lines.push(rendered);
            lines.push('');
          }
        }
      } else if (msg.text) {
        lines.push(msg.text);
        lines.push('');
      }

      // User attachment images
      if (isHuman && msg.attachments && msg.attachments.length > 0) {
        for (const att of msg.attachments) {
          const mime = att.file_type || att.media_type || att.content_type || att.mime_type || '';
          const fileName = att.file_name || att.filename || att.name || 'image';
          if (mime.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(fileName)) {
            const key = `att-${msg.uuid}-${fileName}`;
            const url = imageUrlMap[key] || att.file_url || att.url || att.preview_url || '';
            lines.push(`![${fileName}](${url})`);
            lines.push('');
          }
        }
      }

      // User files (alternative to attachments in Claude API)
      if (isHuman && msg.files && msg.files.length > 0) {
        for (const file of msg.files) {
          const kind = file.file_kind || '';
          const mime = file.file_type || file.media_type || file.content_type || '';
          const fileName = file.file_name || file.filename || file.name || 'image';
          if (kind === 'image' || mime.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(fileName)) {
            const key = `file-${msg.uuid}-${fileName}`;
            const url = imageUrlMap[key] || '';
            lines.push(`![${fileName}](${url})`);
            lines.push('');
          }
        }
      }

      lines.push('---');
      lines.push('');
    }

    return lines.join('\n');
  },

  // Render a single content block
  renderContentBlock(block, msg, options) {
    if (!block) return null;

    switch (block.type) {
      case 'text':
        return this.processText(block.text);

      case 'thinking':
        if (!options.includeThinking) return null;
        return [
          '<details>',
          '<summary>Thinking...</summary>',
          '',
          block.thinking || '',
          '',
          '</details>',
        ].join('\n');

      case 'image':
        return this.renderImageBlock(block, msg, options);

      case 'tool_use':
        if (!options.includeThinking) return null;
        return this.renderToolUse(block, options);

      case 'tool_result':
        return null;

      default:
        return null;
    }
  },

  // Render image content block
  renderImageBlock(block, msg, options) {
    // Try to find CDN URL from imageUrlMap
    const possibleKeys = [
      `img-${msg.uuid}-`,  // prefix match
    ];

    // Search for matching key
    let cdnUrl = null;
    for (const key of Object.keys(options.imageUrlMap)) {
      if (key.startsWith(`img-${msg.uuid}-`) || key.startsWith(`att-${msg.uuid}-`)) {
        cdnUrl = options.imageUrlMap[key];
        break;
      }
    }

    const url = cdnUrl || block.url || block.source?.url || '';
    return `![image](${url})`;
  },

  // Render tool_use blocks (artifacts, code, etc.)
  renderToolUse(block, options) {
    if (!block.display_content && !block.input) return null;

    const dc = block.display_content;
    if (dc) {
      if (dc.type === 'code_block' || dc.type === 'code') {
        const lang = dc.language || '';
        const title = dc.filename || block.input?.title || '';
        const code = dc.code || dc.content || '';
        const header = title ? `**${title}**\n\n` : '';
        return `${header}\`\`\`${lang}\n${code}\n\`\`\``;
      }

      if (dc.type === 'image') {
        const key = `gen-${block.uuid || ''}-${dc.url || ''}`;
        const url = options.imageUrlMap[key] || dc.url || '';
        return `![artifact image](${url})`;
      }

      if (dc.type === 'text' || dc.type === 'markdown') {
        return dc.content || dc.text || '';
      }

      if (dc.type === 'html') {
        const title = block.input?.title || 'HTML Artifact';
        return `**${title}**\n\n\`\`\`html\n${dc.content || ''}\n\`\`\``;
      }
    }

    // Fallback: if there's input with content
    if (block.input) {
      const title = block.input.title || '';
      const content = block.input.content || '';
      if (content) {
        const lang = block.input.language || '';
        const header = title ? `**${title}**\n\n` : '';
        return `${header}\`\`\`${lang}\n${content}\n\`\`\``;
      }
    }

    return null;
  },

  // Process text content
  processText(text) {
    if (!text) return '';
    // Remove <antArtifact> tags (content is rendered separately from tool_use blocks)
    return text.replace(/<antArtifact[\s\S]*?<\/antArtifact>/g, '').trim();
  },

  // Format ISO date string to readable format
  formatDate(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hour = String(d.getHours()).padStart(2, '0');
    const minute = String(d.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${minute}`;
  },
};

// Export for use in Service Worker (module) and content script
if (typeof globalThis !== 'undefined') {
  globalThis.MarkdownConverter = MarkdownConverter;
}
