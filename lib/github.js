// lib/github.js - GitHub image hosting API
// Ported from EssayPublisher's GitHubService.swift

const GitHubService = {
  BASE_URL: 'https://api.github.com',

  // Read config from chrome.storage
  async getConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ github_token: '' }, (localData) => {
        chrome.storage.sync.get(
          {
            github_owner: '',
            image_repo: '',
            image_branch: 'main',
            cdn_type: 'jsdelivr',
            image_path: 'images',
          },
          (syncData) => {
            resolve({ ...syncData, github_token: localData.github_token });
          }
        );
      });
    });
  },

  // Upload image to GitHub repository
  // Ported from: GitHubService.uploadImage(imageData:fileName:)
  async uploadImage(base64Data, fileName) {
    const config = await this.getConfig();

    if (!config.github_token) throw new Error('GitHub token not configured');
    if (!config.github_owner) throw new Error('GitHub owner not configured');
    if (!config.image_repo) throw new Error('Image repository not configured');

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const filePath = `${config.image_path}/${year}/${month}/${fileName}`;

    const body = {
      message: `Upload image: ${fileName}`,
      content: base64Data,
      branch: config.image_branch,
    };

    const resp = await fetch(
      `${this.BASE_URL}/repos/${config.github_owner}/${config.image_repo}/contents/${filePath}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `token ${config.github_token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`GitHub API error ${resp.status}: ${err.message || 'Unknown error'}`);
    }

    const result = await resp.json();
    const cdnUrl = this.generateCDNUrl(config, filePath);

    return {
      success: true,
      path: filePath,
      url: cdnUrl,
      sha: result.content.sha,
    };
  },

  // Generate CDN URL for uploaded image
  // Ported from: AppConfig.generateImageCDNUrl(path:)
  generateCDNUrl(config, path) {
    const { github_owner, image_repo, image_branch, cdn_type } = config;

    switch (cdn_type) {
      case 'jsdelivr':
        return `https://cdn.jsdelivr.net/gh/${github_owner}/${image_repo}@${image_branch}/${path}`;
      case 'statically':
        return `https://cdn.statically.io/gh/${github_owner}/${image_repo}/${image_branch}/${path}`;
      default: // 'raw'
        return `https://raw.githubusercontent.com/${github_owner}/${image_repo}/${image_branch}/${path}`;
    }
  },

  // Generate unique file name
  // Ported from: ImageService.generateFileName(ext:)
  generateFileName(ext = 'png') {
    const ts = Date.now();
    const rnd = Math.floor(Math.random() * 9000) + 1000;
    return `img-${ts}-${rnd}.${ext}`;
  },

  // Verify GitHub token
  // Ported from: GitHubService.verifyToken(_:)
  async verifyToken(token) {
    const resp = await fetch(`${this.BASE_URL}/user`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!resp.ok) throw new Error(`Token verification failed: ${resp.status}`);

    const user = await resp.json();
    return user.login;
  },

  // Check if configuration is complete
  async isConfigured() {
    const config = await this.getConfig();
    return !!(config.github_token && config.github_owner && config.image_repo);
  },
};

if (typeof globalThis !== 'undefined') {
  globalThis.GitHubService = GitHubService;
}
